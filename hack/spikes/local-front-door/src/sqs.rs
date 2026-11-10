//! SQS's SendMessage, ReceiveMessage and DeleteMessage, with GetQueueUrl to find a queue, as the backend answers them
//! (BE/src/queues/sqs-front-door.ts, sqs-operations.ts, sqs-messages.ts), in SQS's JSON protocol. The queues are
//! kept in memory, as `ff local` would keep a run's: a message hidden for its visibility timeout once received, its
//! receipt handle naming that receive, a long poll woken by a send.

use crate::md5::md5_hex;
use crate::sigv4::{self, Problem, SignedRequest};
use crate::{Key, time, uuid};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::http::{Incoming, Response};

/// The most a request's body holds: a batch of messages of 1 MiB together, in JSON, binary attributes in base64.
const MAX_BODY_BYTES: u64 = 3 * 1024 * 1024;
const CONTENT_TYPE: &str = "application/x-amz-json-1.0";
const TARGET_PREFIX: &str = "AmazonSQS.";
const MAX_MESSAGE_ATTRIBUTES: usize = 10;
/// A queue's settings, SQS's defaults: 30 s hidden once received, 1 MiB at most, no wait, no delay.
const VISIBILITY_TIMEOUT: i64 = 30;
const MAXIMUM_MESSAGE_SIZE: usize = 1_048_576;

#[derive(Debug)]
pub struct SqsError {
    status: u16,
    kind: &'static str,
    message: String,
    query_code: &'static str,
}

fn sqs_error(status: u16, kind: &'static str, message: impl Into<String>) -> SqsError {
    SqsError { status, kind, message: message.into(), query_code: kind }
}

fn invalid_parameter(message: impl Into<String>) -> SqsError {
    sqs_error(400, "InvalidParameterValue", message)
}

fn missing_parameter(name: &str) -> SqsError {
    sqs_error(400, "MissingParameter", format!("The request must contain the parameter {name}."))
}

fn queue_does_not_exist() -> SqsError {
    SqsError {
        query_code: "AWS.SimpleQueueService.NonExistentQueue",
        ..sqs_error(400, "QueueDoesNotExist", "The specified queue does not exist.")
    }
}

fn unsupported(message: impl Into<String>) -> SqsError {
    SqsError {
        query_code: "AWS.SimpleQueueService.UnsupportedOperation",
        ..sqs_error(400, "UnsupportedOperation", message)
    }
}

/// The words AWS's services but S3 refuse a signature with, as the backend's serviceWords says them for SQS.
fn refused(problem: Problem) -> SqsError {
    let incomplete = |message: &str| sqs_error(400, "IncompleteSignature", message);
    let mismatch = |message: &str| sqs_error(403, "SignatureDoesNotMatch", message);
    match problem {
        Problem::Token => {
            sqs_error(403, "InvalidClientTokenId", "The security token included in the request is invalid.")
        }
        Problem::Algorithm => {
            incomplete("The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.")
        }
        Problem::Parts => {
            incomplete("Authorization header requires Credential, SignedHeaders and Signature parameters.")
        }
        Problem::Credential { .. } => {
            incomplete("The Credential is not <access key ID>/<date>/<region>/sqs/aws4_request.")
        }
        Problem::Service { .. } => mismatch("Credential should be scoped to correct service: 'sqs'."),
        Problem::NoDate => {
            incomplete("Authorization header requires existence of either a X-Amz-Date or a Date header.")
        }
        Problem::Date { amz_date } | Problem::OtherDay { amz_date, .. } => {
            incomplete(&format!("The date \"{amz_date}\" is not YYYYMMDDTHHMMSSZ, or not the credential's."))
        }
        Problem::Skewed { amz_date } => {
            mismatch(&format!("Signature expired: {amz_date} is more than 15 minutes from the request's arrival."))
        }
        Problem::Unsigned { .. } => mismatch("'Host' must be a 'SignedHeader' in the AWS Authorization."),
        Problem::Mismatch => mismatch("The request signature we calculated does not match the signature you provided."),
    }
}

/// Whether text holds only the characters SQS allows, as XML 1.0 does. Rust's strings hold no lone surrogate.
fn allowed(text: &str) -> bool {
    text.chars().all(|character| {
        matches!(character, '\t' | '\n' | '\r')
            || (character >= ' ' && character != '\u{FFFE}' && character != '\u{FFFF}')
    })
}

fn check_body(body: Option<&Value>) -> Result<String, SqsError> {
    let body = match body {
        None | Some(Value::Null) => return Err(missing_parameter("MessageBody")),
        Some(Value::String(body)) => body,
        Some(_) => return Err(invalid_parameter("The message body must be a string.")),
    };
    if body.is_empty() {
        return Err(invalid_parameter("The request must contain a non-empty message body."));
    }
    if !allowed(body) {
        return Err(sqs_error(
            400,
            "InvalidMessageContents",
            "Invalid characters found in the message body: the set of allowed characters is #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD | #x10000 to #x10FFFF.",
        ));
    }
    Ok(body.clone())
}

/// A message attribute as SQS takes one: its type, and a string, or binary in base64.
#[derive(Clone)]
struct Attribute {
    data_type: String,
    string: Option<String>,
    binary: Option<String>,
}

fn is_base64(value: &str) -> bool {
    value.len().is_multiple_of(4) && STANDARD.decode(value).is_ok()
}

fn valid_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (1..=256).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !lower.starts_with("aws.")
        && !lower.starts_with("amazon.")
}

fn valid_type(data_type: &str) -> bool {
    let (base, custom) = data_type.split_once('.').map_or((data_type, None), |(base, custom)| (base, Some(custom)));
    matches!(base, "String" | "Number" | "Binary")
        && custom.is_none_or(|custom| !custom.is_empty() && custom.bytes().all(|byte| (b'!'..=b'~').contains(&byte)))
        && data_type.len() <= 256
}

/// A message's attributes, as SQS checks them: ten at most, each name SQS's, its type String, Number or Binary.
fn check_attributes(attributes: Option<&Value>, field: &str) -> Result<Vec<(String, Attribute)>, SqsError> {
    let attributes = match attributes {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(attributes)) => attributes,
        Some(_) => return Err(invalid_parameter(format!("{field} must be a map of attribute names to values."))),
    };
    if attributes.len() > MAX_MESSAGE_ATTRIBUTES {
        return Err(invalid_parameter(format!(
            "Number of message attributes [{}] exceeds the allowed maximum [{MAX_MESSAGE_ATTRIBUTES}].",
            attributes.len()
        )));
    }
    let mut checked = Vec::new();
    for (name, value) in attributes {
        if !valid_name(name) {
            return Err(invalid_parameter(format!(
                "Message attribute name '{name}' is invalid: letters, digits, '_', '-' and '.' only, 256 at most, no '.' first, last or twice, no AWS. or Amazon. prefix."
            )));
        }
        let Some(value) = value.as_object() else {
            return Err(invalid_parameter(format!("The message attribute '{name}' must be a map.")));
        };
        if value.contains_key("StringListValues") || value.contains_key("BinaryListValues") {
            return Err(invalid_parameter(format!(
                "The message attribute '{name}' has a list of values, which SQS reserves and doesn't take."
            )));
        }
        let data_type = value.get("DataType").and_then(Value::as_str).unwrap_or_default();
        if !valid_type(data_type) {
            return Err(invalid_parameter(format!(
                "The type of message attribute '{name}' is invalid: String, Number or Binary, with a custom part if any, 256 characters at most."
            )));
        }
        let attribute = if data_type.starts_with("Binary") {
            let binary =
                value.get("BinaryValue").and_then(Value::as_str).filter(|value| !value.is_empty() && is_base64(value));
            let Some(binary) = binary else {
                return Err(invalid_parameter(format!(
                    "The message attribute '{name}' with type 'Binary' must use field 'Binary'."
                )));
            };
            Attribute { data_type: data_type.into(), string: None, binary: Some(binary.into()) }
        } else {
            let string = value.get("StringValue").and_then(Value::as_str).filter(|value| !value.is_empty());
            let Some(string) = string else {
                return Err(invalid_parameter(format!(
                    "The message attribute '{name}' must contain a non-empty message attribute value."
                )));
            };
            if data_type.starts_with("Number") && !string.trim().parse::<f64>().is_ok_and(f64::is_finite) {
                return Err(invalid_parameter(format!(
                    "Can't cast the value of message (user) attribute '{name}' to a number."
                )));
            }
            if !allowed(string) {
                return Err(sqs_error(
                    400,
                    "InvalidMessageContents",
                    format!("The value of message attribute '{name}' has characters SQS doesn't allow."),
                ));
            }
            Attribute { data_type: data_type.into(), string: Some(string.into()), binary: None }
        };
        checked.push((name.clone(), attribute));
    }
    Ok(checked)
}

/// SQS's MD5 of a message's attributes: each, by name, its name, type and value length-prefixed, a byte for the kind.
fn attributes_md5(attributes: &[(String, Attribute)]) -> Option<String> {
    if attributes.is_empty() {
        return None;
    }
    let mut sorted: Vec<&(String, Attribute)> = attributes.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut bytes = Vec::new();
    let prefixed = |bytes: &mut Vec<u8>, part: &[u8]| {
        bytes.extend_from_slice(&(part.len() as u32).to_be_bytes());
        bytes.extend_from_slice(part);
    };
    for (name, attribute) in sorted {
        prefixed(&mut bytes, name.as_bytes());
        prefixed(&mut bytes, attribute.data_type.as_bytes());
        match &attribute.binary {
            Some(binary) => {
                bytes.push(2);
                prefixed(&mut bytes, &STANDARD.decode(binary).unwrap_or_default());
            }
            None => {
                bytes.push(1);
                prefixed(&mut bytes, attribute.string.as_deref().unwrap_or_default().as_bytes());
            }
        }
    }
    Some(md5_hex(&bytes))
}

fn message_size(body: &str, attributes: &[(String, Attribute)]) -> usize {
    body.len()
        + attributes
            .iter()
            .map(|(name, attribute)| {
                let value = match &attribute.binary {
                    Some(binary) => STANDARD.decode(binary).map(|bytes| bytes.len()).unwrap_or_default(),
                    None => attribute.string.as_deref().unwrap_or_default().len(),
                };
                name.len() + attribute.data_type.len() + value
            })
            .sum::<usize>()
}

fn attributes_json(attributes: &[(String, Attribute)]) -> Value {
    let mut map = Map::new();
    for (name, attribute) in attributes {
        let mut value = Map::new();
        value.insert("DataType".into(), attribute.data_type.clone().into());
        if let Some(string) = &attribute.string {
            value.insert("StringValue".into(), string.clone().into());
        }
        if let Some(binary) = &attribute.binary {
            value.insert("BinaryValue".into(), binary.clone().into());
        }
        map.insert(name.clone(), Value::Object(value));
    }
    Value::Object(map)
}

struct Message {
    row: u64,
    message_id: String,
    body: String,
    attributes: Vec<(String, Attribute)>,
    trace_header: Option<String>,
    sent_at: i64,
    visible_at: i64,
    receive_count: u32,
    first_received_at: Option<i64>,
}

#[derive(Default)]
struct Queues {
    queues: HashMap<String, Vec<Message>>,
    next_row: u64,
}

pub struct Sqs {
    key: Key,
    account: String,
    base: String,
    state: Mutex<Queues>,
    /// Woken by each send, for the long polls.
    sent: Condvar,
}

/// A receive's receipt handle: the message's row, the receive it was given at, and the message's ID.
fn receipt_handle(row: u64, receive_count: u32, message_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{row}:{receive_count}:{message_id}"))
}

fn parse_receipt(handle: &str) -> Option<(u64, u32, String)> {
    if handle.is_empty()
        || handle.len() > 200
        || !handle.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let text = String::from_utf8(URL_SAFE_NO_PAD.decode(handle).ok()?).ok()?;
    let mut parts = text.splitn(3, ':');
    let (row, count, id) = (parts.next()?, parts.next()?, parts.next()?);
    let digits = |part: &str, most: usize| {
        !part.is_empty() && part.len() <= most && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    let uuid = id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    (digits(row, 19) && digits(count, 10) && uuid)
        .then(|| Some((row.parse().ok()?, count.parse().ok()?, id.to_string())))?
}

fn integer(input: &Value, name: &str, min: i64, max: i64, default: i64) -> Result<i64, SqsError> {
    match input.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let number = value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok()));
            match number {
                Some(number) if (min..=max).contains(&number) => Ok(number),
                _ => Err(invalid_parameter(format!(
                    "Value {value} for parameter {name} is invalid. Reason: Must be between {min} and {max}."
                ))),
            }
        }
    }
}

/// Whether a list of names asks for this one: by its name, "All" or ".*", or a prefix ending ".*".
fn asked(names: &[String], name: &str) -> bool {
    names.iter().any(|asked| {
        asked == "All"
            || asked == ".*"
            || asked == name
            || asked.strip_suffix(".*").is_some_and(|prefix| name.starts_with(&format!("{prefix}.")))
    })
}

fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(|name| name.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

impl Sqs {
    pub fn new(key: Key, account: &str, base: &str, queues: &[String]) -> Self {
        let state = Queues { queues: queues.iter().map(|name| (name.clone(), Vec::new())).collect(), next_row: 1 };
        Self {
            key,
            account: account.into(),
            base: base.trim_end_matches('/').into(),
            state: Mutex::new(state),
            sent: Condvar::new(),
        }
    }

    pub fn handle(&self, incoming: &mut Incoming) -> Response {
        let id = uuid();
        let answer = self.answer(incoming);
        let (status, document, query_error) = match answer {
            Ok(document) => (200, document, None),
            Err(error) => (
                error.status,
                json!({ "__type": format!("com.amazonaws.sqs#{}", error.kind), "message": error.message }),
                Some(format!("{};{}", error.query_code, if error.status >= 500 { "Receiver" } else { "Sender" })),
            ),
        };
        let mut response = Response::new(status, CONTENT_TYPE, document.to_string()).with("x-amzn-RequestId", id);
        if let Some(query_error) = query_error {
            response = response.with("x-amzn-query-error", query_error);
        }
        response
    }

    fn answer(&self, incoming: &mut Incoming) -> Result<Value, SqsError> {
        let request = &incoming.request;
        let target = request.header("x-amz-target").unwrap_or_default().to_string();
        let content_type = request.header("content-type").unwrap_or_default();
        if request.method != "POST" || !target.starts_with(TARGET_PREFIX) || !content_type.starts_with(CONTENT_TYPE) {
            return Err(unsupported(
                "FF's SQS endpoint speaks SQS's JSON protocol: POST / with X-Amz-Target AmazonSQS.<operation>, as AWS's SDKs and CLI send it.",
            ));
        }
        let body = incoming
            .read_whole(MAX_BODY_BYTES)
            .map_err(|_| sqs_error(400, "IncompleteRequest", "The client went before its request ended."))?
            .ok_or_else(|| {
                sqs_error(413, "RequestEntityTooLarge", format!("The request is over {MAX_BODY_BYTES} bytes."))
            })?;
        let request = &incoming.request;
        let Some(signature) = sigv4::read_authorization(&request.headers, "sqs").map_err(refused)? else {
            return Err(sqs_error(403, "MissingAuthenticationToken", "Request is missing Authentication Token"));
        };
        if signature.access_key_id != self.key.id {
            return Err(sqs_error(
                403,
                "InvalidClientTokenId",
                "The security token included in the request is invalid.",
            ));
        }
        let signed = SignedRequest {
            method: "POST",
            raw_path: &request.raw_path,
            raw_query: &request.raw_query,
            headers: &request.headers,
        };
        sigv4::check_authorization(&signed, &body, &signature, &self.key.secret, time::now_millis() / 1000, "sqs")
            .map_err(refused)?;
        let input: Value = if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body).map_err(|_| invalid_parameter("The request body is not JSON."))?
        };
        if !input.is_object() {
            return Err(invalid_parameter("The request body must be a JSON object."));
        }
        match &target[TARGET_PREFIX.len()..] {
            "GetQueueUrl" => self.get_queue_url(&input),
            "SendMessage" => self.send_message(&input),
            "ReceiveMessage" => self.receive_message(&input),
            "DeleteMessage" => self.delete_message(&input),
            operation => Err(unsupported(format!("The operation {operation} is not one this spike serves."))),
        }
    }

    fn url_of(&self, name: &str) -> String {
        format!("{}/{}/{name}", self.base, self.account)
    }

    /// The queue a URL names, whatever its host: by its path, /<account>/<name>.
    fn queue_of(&self, input: &Value) -> Result<String, SqsError> {
        let Some(url) = input.get("QueueUrl").and_then(Value::as_str) else {
            return Err(missing_parameter("QueueUrl"));
        };
        let path = url.split_once("://").map_or(url, |(_, rest)| rest.find('/').map_or("", |at| &rest[at..]));
        let path = path.trim_end_matches('/');
        let mut parts = path.trim_start_matches('/').split('/');
        let (Some(account), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(queue_does_not_exist());
        };
        if account != self.account || !self.state.lock().unwrap().queues.contains_key(name) {
            return Err(queue_does_not_exist());
        }
        Ok(name.into())
    }

    fn get_queue_url(&self, input: &Value) -> Result<Value, SqsError> {
        let Some(name) = input.get("QueueName").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
            return Err(missing_parameter("QueueName"));
        };
        if input.get("QueueOwnerAWSAccountId").and_then(Value::as_str).is_some_and(|owner| owner != self.account) {
            return Err(queue_does_not_exist());
        }
        if !self.state.lock().unwrap().queues.contains_key(name) {
            return Err(queue_does_not_exist());
        }
        Ok(json!({ "QueueUrl": self.url_of(name) }))
    }

    fn send_message(&self, input: &Value) -> Result<Value, SqsError> {
        let queue = self.queue_of(input)?;
        let body = check_body(input.get("MessageBody"))?;
        let attributes = check_attributes(input.get("MessageAttributes"), "MessageAttributes")?;
        let system = check_attributes(input.get("MessageSystemAttributes"), "MessageSystemAttributes")?;
        if let Some((name, _)) =
            system.iter().find(|(name, attribute)| name != "AWSTraceHeader" || attribute.data_type != "String")
        {
            return Err(invalid_parameter(format!(
                "Message system attribute name '{name}' is invalid: SQS takes AWSTraceHeader, a String."
            )));
        }
        if message_size(&body, &attributes) > MAXIMUM_MESSAGE_SIZE {
            return Err(invalid_parameter(format!(
                "One or more parameters are invalid. Reason: Message must be shorter than {MAXIMUM_MESSAGE_SIZE} bytes."
            )));
        }
        if input.get("MessageDeduplicationId").is_some() || input.get("MessageGroupId").is_some() {
            return Err(invalid_parameter(
                "The request includes parameters that are not valid for this queue type: FF's queues are standard queues.",
            ));
        }
        let delay = integer(input, "DelaySeconds", 0, 900, 0)?;
        let now = time::now_millis();
        let message_id = uuid();
        let mut answer = json!({ "MessageId": message_id, "MD5OfMessageBody": md5_hex(body.as_bytes()) });
        if let Some(md5) = attributes_md5(&attributes) {
            answer["MD5OfMessageAttributes"] = md5.into();
        }
        if let Some(md5) = attributes_md5(&system) {
            answer["MD5OfMessageSystemAttributes"] = md5.into();
        }
        let trace_header = system.into_iter().next().and_then(|(_, attribute)| attribute.string);
        let mut state = self.state.lock().unwrap();
        let row = state.next_row;
        state.next_row += 1;
        state.queues.get_mut(&queue).unwrap().push(Message {
            row,
            message_id,
            body,
            attributes,
            trace_header,
            sent_at: now,
            visible_at: now + delay * 1000,
            receive_count: 0,
            first_received_at: None,
        });
        drop(state);
        self.sent.notify_all();
        Ok(answer)
    }

    fn receive_message(&self, input: &Value) -> Result<Value, SqsError> {
        let queue = self.queue_of(input)?;
        let max = integer(input, "MaxNumberOfMessages", 1, 10, 1)? as usize;
        let visibility = integer(input, "VisibilityTimeout", 0, 43_200, VISIBILITY_TIMEOUT)?;
        let wait = integer(input, "WaitTimeSeconds", 0, 20, 0)?;
        let mut system_names = names(input.get("AttributeNames"));
        system_names.extend(names(input.get("MessageSystemAttributeNames")));
        let attribute_names = names(input.get("MessageAttributeNames"));
        let deadline = Instant::now() + Duration::from_secs(wait as u64);
        let mut state = self.state.lock().unwrap();
        loop {
            let now = time::now_millis();
            let messages = state.queues.get_mut(&queue).unwrap();
            let mut received = Vec::new();
            for message in messages.iter_mut().filter(|message| message.visible_at <= now).take(max) {
                message.receive_count += 1;
                message.first_received_at.get_or_insert(now);
                message.visible_at = now + visibility * 1000;
                received.push(self.received(message, &system_names, &attribute_names));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if !received.is_empty() || left.is_zero() {
                return Ok(if received.is_empty() { json!({}) } else { json!({ "Messages": received }) });
            }
            // A delayed or hidden message's time may come before a send does: wake at least each second.
            state = self.sent.wait_timeout(state, left.min(Duration::from_secs(1))).unwrap().0;
        }
    }

    /// A message as ReceiveMessage answers it: the attributes asked for, and the MD5 sums of what is answered.
    fn received(&self, message: &Message, system_names: &[String], attribute_names: &[String]) -> Value {
        let mut system = vec![
            ("SenderId", self.key.id.clone()),
            ("SentTimestamp", message.sent_at.to_string()),
            ("ApproximateReceiveCount", message.receive_count.to_string()),
            ("ApproximateFirstReceiveTimestamp", message.first_received_at.unwrap_or_default().to_string()),
        ];
        if let Some(trace) = &message.trace_header {
            system.push(("AWSTraceHeader", trace.clone()));
        }
        let attributes: Map<String, Value> = system
            .into_iter()
            .filter(|(name, _)| asked(system_names, name))
            .map(|(name, value)| (name.into(), value.into()))
            .collect();
        let message_attributes: Vec<(String, Attribute)> =
            message.attributes.iter().filter(|(name, _)| asked(attribute_names, name)).cloned().collect();
        let mut answer = json!({
            "MessageId": message.message_id,
            "ReceiptHandle": receipt_handle(message.row, message.receive_count, &message.message_id),
            "MD5OfBody": md5_hex(message.body.as_bytes()),
            "Body": message.body,
        });
        if !attributes.is_empty() {
            answer["Attributes"] = Value::Object(attributes);
        }
        if let Some(md5) = attributes_md5(&message_attributes) {
            answer["MD5OfMessageAttributes"] = md5.into();
            answer["MessageAttributes"] = attributes_json(&message_attributes);
        }
        answer
    }

    /// Deletes the message a receipt names, only if it is its last receive's: an older one deletes nothing, as SQS's.
    fn delete_message(&self, input: &Value) -> Result<Value, SqsError> {
        let queue = self.queue_of(input)?;
        let handle = match input.get("ReceiptHandle") {
            None | Some(Value::Null) => return Err(missing_parameter("ReceiptHandle")),
            Some(handle) => handle,
        };
        let receipt = handle.as_str().and_then(parse_receipt);
        let Some((row, count, id)) = receipt else {
            let shown = handle.as_str().map_or_else(|| handle.to_string(), String::from);
            return Err(sqs_error(
                400,
                "ReceiptHandleIsInvalid",
                format!("The input receipt handle \"{shown}\" is not a valid receipt handle."),
            ));
        };
        let mut state = self.state.lock().unwrap();
        let messages = state.queues.get_mut(&queue).unwrap();
        messages.retain(|message| !(message.row == row && message.receive_count == count && message.message_id == id));
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attribute(data_type: &str, string: Option<&str>, binary: Option<&[u8]>) -> Attribute {
        Attribute {
            data_type: data_type.into(),
            string: string.map(String::from),
            binary: binary.map(|bytes| STANDARD.encode(bytes)),
        }
    }

    /// A part of SQS's encoding of attributes: its length in 4 bytes, big-endian, then its bytes.
    fn part(bytes: &[u8]) -> Vec<u8> {
        [&(bytes.len() as u32).to_be_bytes()[..], bytes].concat()
    }

    #[test]
    fn the_md5_of_attributes_is_each_ones_name_type_and_value_length_prefixed_by_name() {
        let color = [part(b"color"), part(b"String"), vec![1], part(b"red")].concat();
        assert_eq!(attributes_md5(&[("color".into(), attribute("String", Some("red"), None))]), Some(md5_hex(&color)));
        let picture = [0xff, 0x00, 0x7f];
        let both = [
            part(b"a-picture"),
            part(b"Binary.png"),
            vec![2],
            part(&picture),
            part(b"b-quantity"),
            part(b"Number"),
            vec![1],
            part(b"12"),
        ]
        .concat();
        let attributes = [
            ("b-quantity".into(), attribute("Number", Some("12"), None)),
            ("a-picture".into(), attribute("Binary.png", None, Some(&picture))),
        ];
        assert_eq!(attributes_md5(&attributes), Some(md5_hex(&both)));
        assert_eq!(attributes_md5(&[]), None);
    }

    #[test]
    fn a_receipt_handle_names_the_message_and_its_receive() {
        let handle = receipt_handle(1_234_567_890_123, 3, "6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77");
        assert_eq!(parse_receipt(&handle), Some((1_234_567_890_123, 3, "6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77".into())));
        for handle in ["", "not a handle", &URL_SAFE_NO_PAD.encode("1:2:not-a-uuid"), &"a".repeat(300)] {
            assert_eq!(parse_receipt(handle), None, "{handle}");
        }
    }

    #[test]
    fn checks_a_message_as_sqs_does() {
        assert!(check_body(Some(&json!("سلام 👋\ttab\nline"))).is_ok());
        for refused in [json!(""), json!(42), json!("bell \u{7}"), json!("\u{FFFE}")] {
            assert!(check_body(Some(&refused)).is_err(), "{refused}");
        }
        let eleven: Map<String, Value> =
            (0..11).map(|n| (format!("a{n}"), json!({ "DataType": "String", "StringValue": "x" }))).collect();
        assert!(check_attributes(Some(&Value::Object(eleven)), "MessageAttributes").is_err());
        for name in ["AWS.x", "amazon.x", ".x", "x.", "a..b", "a b"] {
            let attributes = json!({ name: { "DataType": "String", "StringValue": "x" } });
            assert!(check_attributes(Some(&attributes), "MessageAttributes").is_err(), "{name}");
        }
        for value in [
            json!({ "DataType": "Number", "StringValue": "twelve" }),
            json!({ "DataType": "Binary", "BinaryValue": "not base64!" }),
            json!({ "DataType": "String" }),
            json!({ "DataType": "String", "StringListValues": ["a"] }),
        ] {
            assert!(check_attributes(Some(&json!({ "a": value })), "MessageAttributes").is_err(), "{value}");
        }
        assert_eq!(message_size("سلام", &[]), 8);
    }
}
