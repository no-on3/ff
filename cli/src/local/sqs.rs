//! Amazon SQS on the template's queues, as FF answers it (ADR 0010): its operations as the backend has them
//! (`BE/src/queues/sqs-operations.ts`, `sqs-messages.ts`, `sqs-attributes.ts`), what the queues' SQL does
//! (`customer-queues.ts`) done in memory, and its JSON protocol at the front door (`sqs-front-door.ts`): POST / with
//! `X-Amz-Target: AmazonSQS.<operation>`, each error by SQS's two names for it. A signed request is checked against
//! the local key; an unsigned one is taken as the local key's, for `curl`, where FF refuses it (ADR 0017). Its cases
//! are `BE/src/queues/sqs-examples.json`'s, which the backend's tests read too.
//!
//! The queues are the template's, kept while `ff local start` runs. A message waits for its delay, is hidden for its
//! visibility timeout once received, its receipt handle naming that receive alone, and is kept until its retention
//! ends; one received as often as its queue's redrive policy allows goes to the dead-letter queue at the next receive;
//! a long poll ends as soon as a message comes. What only FF has isn't here: the plan's storage and rate, the credit,
//! the audit log, the counts SQS bills, the tags; nor are the queues made, changed or deleted, which the template does.

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Map, Value, json};

use super::http::{Request, Response};
use super::key::Key;
use super::schedule_expression::Millis;
use super::sqs_event;
use crate::md5;
use crate::sigv4::{SignedRequest, Words, check_authorization, read_authorization, words};

/// SQS's JSON protocol: its content type, and the target's prefix before the operation's name.
const CONTENT_TYPE: &str = "application/x-amz-json-1.0";
const TARGET_PREFIX: &str = "AmazonSQS.";
/// The service a request's signature is scoped to.
const SERVICE: &str = "sqs";
/// The most a request's body holds: a batch of messages of 1 MiB together, in JSON, binary attributes in base64.
pub const MAX_BODY_BYTES: usize = 3 * 1024 * 1024;
/// SQS's most attributes on one message, entries in a batch, and bytes a batch's messages hold together.
const MAX_MESSAGE_ATTRIBUTES: usize = 10;
const MAX_BATCH: usize = 10;
const MAX_BATCH_BYTES: usize = 1_048_576;
/// How long a long poll waits for a send before it looks again: delays end and visibility timeouts expire unsent.
const POLL: Duration = Duration::from_secs(1);

/// SQS's operations FF doesn't offer, which answer UnsupportedOperation in FF's words.
const NOT_OFFERED: [&str; 6] = [
    "AddPermission",
    "RemovePermission",
    "ListDeadLetterSourceQueues",
    "StartMessageMoveTask",
    "CancelMessageMoveTask",
    "ListMessageMoveTasks",
];
/// FF's operations on the queues themselves, which the template does here.
const THE_TEMPLATES: [&str; 6] =
    ["CreateQueue", "DeleteQueue", "SetQueueAttributes", "TagQueue", "UntagQueue", "ListQueueTags"];

/// The attributes GetQueueAttributes answers, `All` aside.
const ATTRIBUTE_NAMES: [&str; 13] = [
    "QueueArn",
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
    "ApproximateNumberOfMessagesDelayed",
    "CreatedTimestamp",
    "LastModifiedTimestamp",
    "VisibilityTimeout",
    "MessageRetentionPeriod",
    "DelaySeconds",
    "MaximumMessageSize",
    "ReceiveMessageWaitTimeSeconds",
    "RedrivePolicy",
    "SqsManagedSseEnabled",
];

/// An error as SQS answers it in its JSON protocol: its status, the body's `__type` after `com.amazonaws.sqs#`, its
/// message, and the `x-amzn-query-error` header, `<code>;<Sender|Receiver>`, which the AWS CLI and boto3 read.
#[derive(Debug, PartialEq)]
pub struct SqsError {
    pub status: u16,
    pub kind: &'static str,
    pub message: String,
    query_code: &'static str,
    sender: bool,
}

impl SqsError {
    fn new(status: u16, kind: &'static str, message: impl Into<String>) -> Self {
        SqsError { status, kind, message: message.into(), query_code: kind, sender: true }
    }

    /// The query protocol's code, when it isn't the type's.
    fn coded(self, query_code: &'static str) -> Self {
        SqsError { query_code, ..self }
    }

    /// The answer SQS sends.
    pub fn response(&self) -> Response {
        let document = json!({ "__type": format!("com.amazonaws.sqs#{}", self.kind), "message": self.message });
        let fault = if self.sender { "Sender" } else { "Receiver" };
        Response {
            status: self.status,
            headers: vec![
                ("content-type".into(), CONTENT_TYPE.into()),
                ("x-amzn-query-error".into(), format!("{};{fault}", self.query_code)),
            ],
            body: document.to_string().into_bytes(),
        }
    }
}

fn invalid_parameter(message: impl Into<String>) -> SqsError {
    SqsError::new(400, "InvalidParameterValue", message)
}

fn missing_parameter(name: &str) -> SqsError {
    SqsError::new(400, "MissingParameter", format!("The request must contain the parameter {name}."))
}

fn queue_does_not_exist() -> SqsError {
    SqsError::new(400, "QueueDoesNotExist", "The specified queue does not exist.")
        .coded("AWS.SimpleQueueService.NonExistentQueue")
}

fn unsupported(message: impl Into<String>) -> SqsError {
    SqsError::new(400, "UnsupportedOperation", message).coded("AWS.SimpleQueueService.UnsupportedOperation")
}

fn invalid_contents(message: impl Into<String>) -> SqsError {
    SqsError::new(400, "InvalidMessageContents", message)
}

/// A signature's problem in SQS's words.
fn signature_refusal(words: Words) -> SqsError {
    match words {
        Words::Token => invalid_client_token_id(),
        Words::Incomplete(message) => SqsError::new(400, "IncompleteSignature", message),
        Words::Mismatch(message) => SqsError::new(
            403,
            "SignatureDoesNotMatch",
            message.unwrap_or_else(|| {
                "The request signature we calculated does not match the signature you provided.".to_owned()
            }),
        ),
    }
}

fn invalid_client_token_id() -> SqsError {
    SqsError::new(403, "InvalidClientTokenId", "The security token included in the request is invalid.")
}

/// A value as an error names it: a string as it is, anything else as JSON.
fn shown(value: &Value) -> String {
    value.as_str().map_or_else(|| value.to_string(), str::to_owned)
}

/// Whether text holds only the characters SQS allows in a message, as XML 1.0 does: tab, line feed, carriage return,
/// and from space up, but U+FFFE and U+FFFF. Rust's strings hold no lone surrogate.
fn allowed(text: &str) -> bool {
    text.chars().all(|character| {
        matches!(character, '\t' | '\n' | '\r') || (character >= ' ' && !matches!(character, '\u{FFFE}' | '\u{FFFF}'))
    })
}

/// A message's body, as SQS takes one: text of at least a character, of the characters it allows.
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
        return Err(invalid_contents(
            "Invalid characters found in the message body: the set of allowed characters is #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD | #x10000 to #x10FFFF.",
        ));
    }
    Ok(body.clone())
}

/// A message attribute as SQS takes one: its type, and a string, or binary in base64, as JSON carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct Attribute {
    pub data_type: String,
    pub string: Option<String>,
    pub binary: Option<String>,
}

impl Attribute {
    pub fn string(data_type: &str, value: &str) -> Self {
        Attribute { data_type: data_type.to_owned(), string: Some(value.to_owned()), binary: None }
    }

    /// Its value's bytes, binary decoded.
    fn value_bytes(&self) -> Vec<u8> {
        match &self.binary {
            Some(binary) => STANDARD.decode(binary).unwrap_or_default(),
            None => self.string.clone().unwrap_or_default().into_bytes(),
        }
    }

    fn json(&self) -> Value {
        let mut value = Map::new();
        value.insert("DataType".into(), self.data_type.clone().into());
        if let Some(string) = &self.string {
            value.insert("StringValue".into(), string.clone().into());
        }
        if let Some(binary) = &self.binary {
            value.insert("BinaryValue".into(), binary.clone().into());
        }
        Value::Object(value)
    }
}

/// A message's attributes by name.
pub type Attributes = BTreeMap<String, Attribute>;

fn attributes_json(attributes: &Attributes) -> Value {
    Value::Object(attributes.iter().map(|(name, attribute)| (name.clone(), attribute.json())).collect())
}

fn is_base64(value: &str) -> bool {
    value.len().is_multiple_of(4)
        && value.trim_end_matches('=').bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+/".contains(&byte))
        && value.len() - value.trim_end_matches('=').len() <= 2
}

/// Whether a name is SQS's: letters, digits, `_`, `-` and `.`, 256 at most, no `.` first, last or twice, no `AWS.` or
/// `Amazon.` prefix in any case.
fn is_attribute_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (1..=256).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !lower.starts_with("aws.")
        && !lower.starts_with("amazon.")
}

/// Whether a type is SQS's: String, Number or Binary, with a custom part of printable characters if any.
fn is_attribute_type(data_type: &str) -> bool {
    let (base, custom) = match data_type.split_once('.') {
        Some((base, custom)) => (base, Some(custom)),
        None => (data_type, None),
    };
    matches!(base, "String" | "Number" | "Binary")
        && custom.is_none_or(|custom| !custom.is_empty() && custom.bytes().all(|byte| (b'!'..=b'~').contains(&byte)))
        && data_type.len() <= 256
}

/// Whether text is a number as JavaScript's `Number` reads one, and a finite one: decimal, or 0x, 0o or 0b digits.
fn is_finite_number(text: &str) -> bool {
    let text = text.trim();
    let radix = [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)]
        .into_iter()
        .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)));
    match radix {
        Some((digits, radix)) => !digits.is_empty() && digits.chars().all(|digit| digit.is_digit(radix)),
        None => {
            let decimal = text.trim_start_matches(['+', '-']);
            decimal.chars().next().is_some_and(|first| first.is_ascii_digit() || first == '.')
                && text.parse::<f64>().is_ok_and(f64::is_finite)
        }
    }
}

/// A message's attributes, as SQS takes them: ten at most, each name SQS's, its type String, Number or Binary with a
/// custom part if any, and its value. Lists of values, which SQS reserves, are refused.
fn check_attributes(attributes: Option<&Value>, field: &str) -> Result<Attributes, SqsError> {
    let attributes = match attributes {
        None | Some(Value::Null) => return Ok(Attributes::new()),
        Some(Value::Object(attributes)) => attributes,
        Some(_) => return Err(invalid_parameter(format!("{field} must be a map of attribute names to values."))),
    };
    if attributes.len() > MAX_MESSAGE_ATTRIBUTES {
        return Err(invalid_parameter(format!(
            "Number of message attributes [{}] exceeds the allowed maximum [{MAX_MESSAGE_ATTRIBUTES}].",
            attributes.len()
        )));
    }
    let mut checked = Attributes::new();
    for (name, value) in attributes {
        if !is_attribute_name(name) {
            return Err(invalid_parameter(format!(
                "Message attribute name '{name}' is invalid: letters, digits, '_', '-' and '.' only, 256 at most, no '.' first, last or twice, no AWS. or Amazon. prefix."
            )));
        }
        let empty = Map::new();
        let value = match value {
            Value::Object(value) => value,
            Value::Array(_) => &empty,
            _ => return Err(invalid_parameter(format!("The message attribute '{name}' must be a map."))),
        };
        if value.contains_key("StringListValues") || value.contains_key("BinaryListValues") {
            return Err(invalid_parameter(format!(
                "The message attribute '{name}' has a list of values, which SQS reserves and doesn't take."
            )));
        }
        let Some(data_type) = value.get("DataType").and_then(Value::as_str).filter(|kind| is_attribute_type(kind))
        else {
            return Err(invalid_parameter(format!(
                "The type of message attribute '{name}' is invalid: String, Number or Binary, with a custom part if any, 256 characters at most."
            )));
        };
        let attribute = if data_type.starts_with("Binary") {
            let binary = value.get("BinaryValue").and_then(Value::as_str).filter(|binary| !binary.is_empty());
            let Some(binary) = binary.filter(|binary| is_base64(binary)) else {
                return Err(invalid_parameter(format!(
                    "The message attribute '{name}' with type 'Binary' must use field 'Binary'."
                )));
            };
            Attribute { data_type: data_type.to_owned(), string: None, binary: Some(binary.to_owned()) }
        } else {
            let Some(string) = value.get("StringValue").and_then(Value::as_str).filter(|string| !string.is_empty())
            else {
                return Err(invalid_parameter(format!(
                    "The message attribute '{name}' must contain a non-empty message attribute value."
                )));
            };
            if data_type.starts_with("Number") && !is_finite_number(string) {
                return Err(invalid_parameter(format!(
                    "Can't cast the value of message (user) attribute '{name}' to a number."
                )));
            }
            if !allowed(string) {
                return Err(invalid_contents(format!(
                    "The value of message attribute '{name}' has characters SQS doesn't allow."
                )));
            }
            Attribute::string(data_type, string)
        };
        checked.insert(name.clone(), attribute);
    }
    Ok(checked)
}

/// The system attributes a message may carry, as SQS takes them: AWSTraceHeader alone, a string.
fn check_system_attributes(attributes: Option<&Value>) -> Result<Attributes, SqsError> {
    let checked = check_attributes(attributes, "MessageSystemAttributes")?;
    if let Some((name, _)) =
        checked.iter().find(|(name, attribute)| *name != "AWSTraceHeader" || attribute.data_type != "String")
    {
        return Err(invalid_parameter(format!(
            "Message system attribute name '{name}' is invalid: SQS takes AWSTraceHeader, a String."
        )));
    }
    Ok(checked)
}

/// SQS's MD5 of a message's attributes: each, by name, its name, its type and its value, each length-prefixed, a byte
/// saying which kind of value; none for no attribute.
pub fn attributes_md5(attributes: &Attributes) -> Option<String> {
    if attributes.is_empty() {
        return None;
    }
    let mut bytes = Vec::new();
    let prefixed = |bytes: &mut Vec<u8>, part: &[u8]| {
        bytes.extend_from_slice(&u32::try_from(part.len()).unwrap_or(u32::MAX).to_be_bytes());
        bytes.extend_from_slice(part);
    };
    for (name, attribute) in attributes {
        prefixed(&mut bytes, name.as_bytes());
        prefixed(&mut bytes, attribute.data_type.as_bytes());
        bytes.push(if attribute.binary.is_some() { 2 } else { 1 });
        prefixed(&mut bytes, &attribute.value_bytes());
    }
    Some(md5::hex(&bytes))
}

/// A message's size, as SQS counts it against the queue's maximum: its body and each attribute's name, type and
/// value, in bytes.
pub fn message_size(body: &str, attributes: &Attributes) -> usize {
    let attributes = attributes
        .iter()
        .map(|(name, attribute)| name.len() + attribute.data_type.len() + attribute.value_bytes().len());
    body.len() + attributes.sum::<usize>()
}

/// What a receipt handle names: the message's row, the receive it was given at, and the message's ID.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Receipt {
    row: u64,
    receive_count: u64,
    message_id: String,
}

/// A receive's receipt handle: each receive of a message gives another, and only the last one's deletes it or changes
/// its visibility.
pub(super) fn receipt_handle(row: u64, receive_count: u64, message_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{row}:{receive_count}:{message_id}"))
}

/// base64url as Node.js decodes it, its padding and its last bits as they come.
const LENIENT_URL_SAFE: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// What a receipt handle names; none for a string no receive gave.
fn parse_receipt(handle: &str) -> Option<Receipt> {
    let shaped = (1..=200).contains(&handle.len())
        && handle.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !shaped {
        return None;
    }
    let text = String::from_utf8(LENIENT_URL_SAFE.decode(handle).ok()?).ok()?;
    let mut parts = text.splitn(3, ':');
    let (row, count, id) = (parts.next()?, parts.next()?, parts.next()?);
    let digits =
        |part: &str, most: usize| (1..=most).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit());
    let uuid =
        id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-');
    if !(digits(row, 19) && digits(count, 10) && uuid) {
        return None;
    }
    Some(Receipt { row: row.parse().ok()?, receive_count: count.parse().ok()?, message_id: id.to_owned() })
}

/// A queue's redrive policy: the dead-letter queue its messages go to, and after how many receives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redrive {
    pub dead_letter_target_arn: String,
    pub max_receive_count: u64,
}

/// A queue's settings: SQS's attributes, as the template gives them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueSettings {
    pub visibility_timeout: i64,
    pub retention_seconds: i64,
    pub delay_seconds: i64,
    pub maximum_message_size: usize,
    pub receive_wait_seconds: i64,
    pub redrive: Option<Redrive>,
}

impl Default for QueueSettings {
    /// SQS's defaults.
    fn default() -> Self {
        QueueSettings {
            visibility_timeout: 30,
            retention_seconds: 345_600,
            delay_seconds: 0,
            maximum_message_size: 1_048_576,
            receive_wait_seconds: 0,
            redrive: None,
        }
    }
}

impl QueueSettings {
    /// A queue's settings as a plan gives them, by FF's API's names, SQS's default for each it leaves out.
    pub fn of(attributes: &Value) -> Self {
        let defaults = QueueSettings::default();
        let number = |name: &str, default: i64| attributes.get(name).and_then(Value::as_i64).unwrap_or(default);
        let redrive = attributes.get("redrivePolicy").and_then(|policy| {
            Some(Redrive {
                dead_letter_target_arn: policy.get("deadLetterTargetArn")?.as_str()?.to_owned(),
                max_receive_count: policy.get("maxReceiveCount")?.as_u64()?,
            })
        });
        QueueSettings {
            visibility_timeout: number("visibilityTimeout", defaults.visibility_timeout),
            retention_seconds: number("messageRetentionPeriod", defaults.retention_seconds),
            delay_seconds: number("delaySeconds", defaults.delay_seconds),
            maximum_message_size: attributes
                .get("maximumMessageSize")
                .and_then(Value::as_u64)
                .map_or(defaults.maximum_message_size, |size| usize::try_from(size).unwrap_or(usize::MAX)),
            receive_wait_seconds: number("receiveMessageWaitTimeSeconds", defaults.receive_wait_seconds),
            redrive,
        }
    }
}

/// A message as the queue keeps it.
#[derive(Clone, Debug)]
pub(super) struct Message {
    pub(super) row: u64,
    pub(super) message_id: String,
    pub(super) body: String,
    pub(super) attributes: Attributes,
    pub(super) trace_header: Option<String>,
    pub(super) sender_id: String,
    pub(super) sent_at: Millis,
    pub(super) visible_at: Millis,
    pub(super) expires_at: Millis,
    pub(super) receive_count: u64,
    pub(super) first_received_at: Option<Millis>,
}

impl Message {
    fn receipt_matches(&self, receipt: &Receipt) -> bool {
        self.row == receipt.row && self.receive_count == receipt.receive_count && self.message_id == receipt.message_id
    }
}

/// A message to keep, checked.
pub struct Outgoing {
    pub body: String,
    pub attributes: Attributes,
    pub trace_header: Option<String>,
    pub sender_id: String,
    /// Its delay; none, the queue's.
    pub delay_seconds: Option<i64>,
}

#[derive(Debug)]
struct Queue {
    settings: QueueSettings,
    /// Oldest first, as the queue's rows are.
    messages: Vec<Message>,
}

/// How many of a queue's messages are in each state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    visible: usize,
    not_visible: usize,
    delayed: usize,
}

#[derive(Debug)]
struct State {
    queues: BTreeMap<String, Queue>,
    next_row: u64,
}

impl State {
    fn queue(&mut self, name: &str) -> &mut Queue {
        self.queues.get_mut(name).expect("a queue found before")
    }

    /// The messages kept, each its row the next, visible once its delay ends, kept for the queue's retention.
    fn keep(&mut self, name: &str, messages: Vec<Outgoing>, now: Millis) -> Vec<String> {
        let mut ids = Vec::new();
        for message in messages {
            let row = self.next_row;
            self.next_row += 1;
            let queue = self.queue(name);
            let delay = message.delay_seconds.unwrap_or(queue.settings.delay_seconds);
            let message_id = new_message_id();
            ids.push(message_id.clone());
            queue.messages.push(Message {
                row,
                message_id,
                body: message.body,
                attributes: message.attributes,
                trace_header: message.trace_header,
                sender_id: message.sender_id,
                sent_at: now,
                visible_at: now + delay * 1000,
                expires_at: now + queue.settings.retention_seconds * 1000,
                receive_count: 0,
                first_received_at: None,
            });
        }
        ids
    }

    /// Up to `max` messages that can be received, the oldest first, each hidden for `visibility` and its receive
    /// counted; those received as often as the redrive policy allows moved to the dead-letter queue first, kept there
    /// for its retention from when they were sent. `arns` is what the queues' ARNs begin with.
    fn receive(&mut self, name: &str, max: usize, visibility: i64, now: Millis, arns: &str) -> Vec<Message> {
        self.redrive(name, now, arns);
        let queue = self.queue(name);
        queue.messages.retain(|message| message.expires_at > now);
        let ready = queue.messages.iter_mut().filter(|message| message.visible_at <= now).take(max);
        ready
            .map(|message| {
                message.receive_count += 1;
                message.first_received_at.get_or_insert(now);
                message.visible_at = now + visibility * 1000;
                message.clone()
            })
            .collect()
    }

    /// The messages received as often as the queue's redrive policy allows moved to its dead-letter queue, when it is
    /// another queue here.
    fn redrive(&mut self, name: &str, now: Millis, arns: &str) {
        let Some(policy) = self.queue(name).settings.redrive.clone() else { return };
        let target = policy.dead_letter_target_arn.strip_prefix(arns);
        let Some(dead_letter) = target.filter(|dead_letter| *dead_letter != name) else { return };
        let Some(retention) = self.queues.get(dead_letter).map(|queue| queue.settings.retention_seconds) else {
            return;
        };
        let queue = self.queue(name);
        let (moved, kept): (Vec<Message>, Vec<Message>) = std::mem::take(&mut queue.messages)
            .into_iter()
            .partition(|message| message.visible_at <= now && message.receive_count >= policy.max_receive_count);
        queue.messages = kept;
        let target = self.queue(dead_letter);
        target.messages.extend(moved.into_iter().map(|message| Message {
            receive_count: 0,
            first_received_at: None,
            visible_at: now,
            expires_at: message.sent_at + retention * 1000,
            ..message
        }));
        target.messages.sort_by_key(|message| message.row);
    }

    fn counts(&self, name: &str, now: Millis) -> Counts {
        let live = self.queues[name].messages.iter().filter(|message| message.expires_at > now);
        live.fold(Counts::default(), |counts, message| match (message.visible_at <= now, message.receive_count) {
            (true, _) => Counts { visible: counts.visible + 1, ..counts },
            (false, 0) => Counts { delayed: counts.delayed + 1, ..counts },
            (false, _) => Counts { not_visible: counts.not_visible + 1, ..counts },
        })
    }
}

/// A message's ID: a random UUID, as SQS gives one.
fn new_message_id() -> String {
    super::http::request_id()
}

/// Who calls: the key that signed, and the endpoint reached, which the queues' URLs answered begin with.
pub struct Caller<'a> {
    pub key_id: &'a str,
    pub endpoint: &'a str,
}

/// A whole number parameter in its range, or the default when it isn't given.
fn integer(input: &Value, name: &str, min: i64, max: i64, default: i64) -> Result<i64, SqsError> {
    let value = match input.get(name) {
        None | Some(Value::Null) => return Ok(default),
        Some(value) => value,
    };
    let whole = value.as_i64().or_else(|| value.as_f64().filter(|number| number.fract() == 0.0).map(|n| n as i64));
    match whole {
        Some(number) if (min..=max).contains(&number) => Ok(number),
        _ => Err(invalid_parameter(format!(
            "Value {} for parameter {name} is invalid. Reason: Must be between {min} and {max}.",
            shown(value)
        ))),
    }
}

/// A list parameter's items; none when it isn't a list.
fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Whether a receive asked for an attribute: All, its name, or a prefix ending in `.*`.
fn asked(names: &[Value], name: &str) -> bool {
    names.iter().filter_map(Value::as_str).any(|wanted| {
        wanted == "All"
            || wanted == ".*"
            || wanted == name
            || wanted.strip_suffix('*').is_some_and(|prefix| prefix.ends_with('.') && name.starts_with(prefix))
    })
}

/// A string parameter; none when it isn't one.
fn text<'a>(input: &'a Value, name: &str) -> Option<&'a str> {
    input.get(name).and_then(Value::as_str)
}

/// Whether a request is SQS's: its target names one of SQS's operations, or it is to `/`, which only SQS answers.
pub fn is_sqs(request: &Request) -> bool {
    let path = request.target.split('?').next().unwrap_or_default();
    request.header("x-amz-target").is_some_and(|target| target.starts_with(TARGET_PREFIX)) || path == "/"
}

/// SQS's answer to a request it couldn't read: over what a body holds, or not HTTP.
pub fn unreadable(too_large: bool) -> Response {
    let refused = match too_large {
        true => SqsError::new(413, "RequestEntityTooLarge", format!("The request is over {MAX_BODY_BYTES} bytes.")),
        false => SqsError::new(400, "IncompleteRequest", "The client went before its request ended."),
    };
    refused.response()
}

/// The template's queues, kept in memory while ff local start runs.
pub struct Queues {
    region: String,
    account: String,
    /// When they were made: when the app started, in seconds, as CreatedTimestamp and LastModifiedTimestamp say.
    made_at: i64,
    state: Mutex<State>,
    /// Woken by each message kept, for the long polls.
    news: Condvar,
    clock: Arc<dyn Fn() -> Millis + Send + Sync>,
}

impl Queues {
    /// The queues, each by its name with its settings, empty; `clock` says what time it is, in Unix milliseconds.
    pub fn new(
        region: &str,
        account: &str,
        queues: impl IntoIterator<Item = (String, QueueSettings)>,
        clock: Arc<dyn Fn() -> Millis + Send + Sync>,
    ) -> Self {
        let queues = queues.into_iter().map(|(name, settings)| (name, Queue { settings, messages: Vec::new() }));
        Queues {
            region: region.to_owned(),
            account: account.to_owned(),
            made_at: clock() / 1000,
            state: Mutex::new(State { queues: queues.collect(), next_row: 1 }),
            news: Condvar::new(),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn now(&self) -> Millis {
        (self.clock)()
    }

    /// A queue's ARN, as SQS's: in the region, under the account.
    pub fn arn(&self, name: &str) -> String {
        format!("arn:aws:sqs:{}:{}:{name}", self.region, self.account)
    }

    /// The queue's name an ARN names, when it is one of these.
    pub fn named_by(&self, arn: &str) -> Option<String> {
        let name = arn.strip_prefix(&self.arn(""))?;
        self.lock().queues.contains_key(name).then(|| name.to_owned())
    }

    /// A queue's URL, as SQS's: under the endpoint, the account, then its name.
    fn url_of(&self, name: &str, endpoint: &str) -> String {
        format!("{endpoint}/{}/{name}", self.account)
    }

    /// A message sent by FF itself, as its asynchronous calls send a record or a dead letter: its size the queue's
    /// maximum at most, its delay the queue's; refused saying why.
    pub fn send_as_ff(&self, arn: &str, message: Outgoing) -> Result<(), String> {
        let name = self.named_by(arn).ok_or_else(|| format!("{arn} is no queue here"))?;
        let mut state = self.lock();
        let size = message_size(&message.body, &message.attributes);
        let most = state.queue(&name).settings.maximum_message_size;
        if size > most {
            return Err(format!("it is {size} bytes, over the queue's maximum message size of {most}"));
        }
        state.keep(&name, vec![message], self.now());
        drop(state);
        self.news.notify_all();
        Ok(())
    }

    /// A request at the front door, in SQS's JSON protocol: signed with the local key, or unsigned, as the local
    /// key's; `other_key` is told of a key that isn't it, which no caller learns.
    pub fn answer(&self, request: &Request, key: &Key, endpoint: &str, other_key: impl Fn(&str)) -> Response {
        let answered = self.answered(request, key, endpoint, other_key);
        match answered {
            Ok(document) => Response {
                status: 200,
                headers: vec![("content-type".into(), CONTENT_TYPE.into())],
                body: document.to_string().into_bytes(),
            },
            Err(error) => error.response(),
        }
    }

    fn answered(
        &self,
        request: &Request,
        key: &Key,
        endpoint: &str,
        other_key: impl Fn(&str),
    ) -> Result<Value, SqsError> {
        let target = request.header("x-amz-target").unwrap_or_default();
        let content_type = request.header("content-type").unwrap_or_default();
        if request.method != "POST" || !target.starts_with(TARGET_PREFIX) || !content_type.starts_with(CONTENT_TYPE) {
            return Err(unsupported(
                "FF's SQS endpoint speaks SQS's JSON protocol: POST / with X-Amz-Target AmazonSQS.<operation>, as AWS's SDKs and CLI send it.",
            ));
        }
        if request.body.len() > MAX_BODY_BYTES {
            return Err(SqsError::new(
                413,
                "RequestEntityTooLarge",
                format!("The request is over {MAX_BODY_BYTES} bytes."),
            ));
        }
        let refused = |problem| signature_refusal(words(problem, SERVICE));
        if let Some(signature) = read_authorization(&request.headers, SERVICE).map_err(refused)? {
            if signature.access_key_id != key.id {
                other_key(&signature.access_key_id);
                return Err(invalid_client_token_id());
            }
            let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
            let signed = SignedRequest { method: "POST", raw_path: path, raw_query: query, headers: &request.headers };
            check_authorization(&signed, &request.body, &signature, &key.secret, self.now() / 1000, SERVICE)
                .map_err(refused)?;
        }
        let input: Value = match request.body.is_empty() {
            true => json!({}),
            false => {
                serde_json::from_slice(&request.body).map_err(|_| invalid_parameter("The request body is not JSON."))?
            }
        };
        if !input.is_object() {
            return Err(invalid_parameter("The request body must be a JSON object."));
        }
        self.run(&target[TARGET_PREFIX.len()..], &input, &Caller { key_id: &key.id, endpoint })
    }

    /// The operation's answer, by SQS's name for it.
    pub fn run(&self, operation: &str, input: &Value, caller: &Caller) -> Result<Value, SqsError> {
        if NOT_OFFERED.contains(&operation) {
            return Err(unsupported(format!("FF's queues don't offer {operation}.")));
        }
        if THE_TEMPLATES.contains(&operation) {
            return Err(unsupported(format!(
                "ff local's queues are the template's: {operation} changes them on FF, where the template's AWS::SQS::Queue makes each one with its settings and tags."
            )));
        }
        match operation {
            "GetQueueUrl" => self.get_queue_url(input, caller),
            "ListQueues" => self.list_queues(input, caller),
            "GetQueueAttributes" => {
                let name = self.queue_of(input)?;
                let state = self.lock();
                Ok(json!({ "Attributes": self.attributes_of(&state, &name, list(input.get("AttributeNames")))? }))
            }
            "PurgeQueue" => {
                let name = self.queue_of(input)?;
                self.lock().queue(&name).messages.clear();
                Ok(json!({}))
            }
            "SendMessage" => self.send_message(input, caller),
            "SendMessageBatch" => self.send_message_batch(input, caller),
            "ReceiveMessage" => self.receive_message(input),
            "DeleteMessage" => {
                let name = self.queue_of(input)?;
                self.delete(&name, &receipt(input.get("ReceiptHandle"))?);
                Ok(json!({}))
            }
            "DeleteMessageBatch" => {
                let name = self.queue_of(input)?;
                batch(input, |entry| {
                    self.delete(&name, &receipt(entry.get("ReceiptHandle"))?);
                    Ok(())
                })
            }
            "ChangeMessageVisibility" => {
                let name = self.queue_of(input)?;
                self.change_visibility(&name, input)?;
                Ok(json!({}))
            }
            "ChangeMessageVisibilityBatch" => {
                let name = self.queue_of(input)?;
                batch(input, |entry| self.change_visibility(&name, entry))
            }
            "" => Err(unsupported("The operation (none) is not one of SQS's that FF offers.")),
            operation => Err(unsupported(format!("The operation {operation} is not one of SQS's that FF offers."))),
        }
    }

    /// The account's queue a URL names, whatever its host: by its path, /<account>/<name>; another account's doesn't
    /// exist.
    fn queue_of(&self, input: &Value) -> Result<String, SqsError> {
        let url = text(input, "QueueUrl").ok_or_else(|| missing_parameter("QueueUrl"))?;
        let path = match url.split_once("://") {
            Some((_, rest)) => rest.find('/').map_or("/", |at| &rest[at..]),
            None => url,
        };
        let path = path.split(['?', '#']).next().unwrap_or_default();
        let path = path.strip_suffix('/').unwrap_or(path);
        let mut parts = path.strip_prefix('/').unwrap_or("-").split('/');
        let (Some(account), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(queue_does_not_exist());
        };
        if account != self.account || !self.lock().queues.contains_key(name) {
            return Err(queue_does_not_exist());
        }
        Ok(name.to_owned())
    }

    fn get_queue_url(&self, input: &Value, caller: &Caller) -> Result<Value, SqsError> {
        let name =
            text(input, "QueueName").filter(|name| !name.is_empty()).ok_or_else(|| missing_parameter("QueueName"))?;
        if text(input, "QueueOwnerAWSAccountId").is_some_and(|owner| owner != self.account) {
            return Err(queue_does_not_exist());
        }
        if !self.lock().queues.contains_key(name) {
            return Err(queue_does_not_exist());
        }
        Ok(json!({ "QueueUrl": self.url_of(name, caller.endpoint) }))
    }

    /// The queues by name, those after NextToken, the next one's name, when more are left.
    fn list_queues(&self, input: &Value, caller: &Caller) -> Result<Value, SqsError> {
        let most = usize::try_from(integer(input, "MaxResults", 1, 1000, 1000)?).unwrap_or(1000);
        let prefix = text(input, "QueueNamePrefix").unwrap_or_default();
        let after = text(input, "NextToken");
        let state = self.lock();
        let names: Vec<&String> = state
            .queues
            .keys()
            .filter(|name| name.starts_with(prefix) && after.is_none_or(|after| name.as_str() > after))
            .collect();
        let mut answer = Map::new();
        if !names.is_empty() {
            let urls = names.iter().take(most).map(|name| self.url_of(name, caller.endpoint));
            answer.insert("QueueUrls".into(), urls.collect::<Vec<_>>().into());
        }
        if names.len() > most {
            answer.insert("NextToken".into(), names[most - 1].clone().into());
        }
        Ok(Value::Object(answer))
    }

    /// GetQueueAttributes' answer: the attributes asked for, All or names, every value a string.
    fn attributes_of(&self, state: &State, name: &str, asked: &[Value]) -> Result<Map<String, Value>, SqsError> {
        for wanted in asked {
            if !wanted.as_str().is_some_and(|wanted| wanted == "All" || ATTRIBUTE_NAMES.contains(&wanted)) {
                return Err(SqsError::new(
                    400,
                    "InvalidAttributeName",
                    format!("Unknown Attribute {}.", shown(wanted)),
                ));
            }
        }
        let settings = &state.queues[name].settings;
        let counts = state.counts(name, self.now());
        let mut all = vec![
            ("QueueArn", self.arn(name)),
            ("ApproximateNumberOfMessages", counts.visible.to_string()),
            ("ApproximateNumberOfMessagesNotVisible", counts.not_visible.to_string()),
            ("ApproximateNumberOfMessagesDelayed", counts.delayed.to_string()),
            ("CreatedTimestamp", self.made_at.to_string()),
            ("LastModifiedTimestamp", self.made_at.to_string()),
            ("VisibilityTimeout", settings.visibility_timeout.to_string()),
            ("MessageRetentionPeriod", settings.retention_seconds.to_string()),
            ("DelaySeconds", settings.delay_seconds.to_string()),
            ("MaximumMessageSize", settings.maximum_message_size.to_string()),
            ("ReceiveMessageWaitTimeSeconds", settings.receive_wait_seconds.to_string()),
            ("SqsManagedSseEnabled", "false".to_owned()),
        ];
        if let Some(redrive) = &settings.redrive {
            let policy = format!(
                "{{\"deadLetterTargetArn\":{},\"maxReceiveCount\":{}}}",
                Value::from(redrive.dead_letter_target_arn.as_str()),
                redrive.max_receive_count
            );
            all.push(("RedrivePolicy", policy));
        }
        let every = asked.iter().any(|wanted| wanted == "All");
        let chosen = all.into_iter().filter(|(attribute, _)| every || asked.iter().any(|wanted| wanted == attribute));
        Ok(chosen.map(|(attribute, value)| (attribute.to_owned(), value.into())).collect())
    }

    /// A message to keep, checked as SQS checks one, its size the queue's maximum at most.
    fn outgoing(&self, name: &str, entry: &Value, caller: &Caller) -> Result<Outgoing, SqsError> {
        let body = check_body(entry.get("MessageBody"))?;
        let attributes = check_attributes(entry.get("MessageAttributes"), "MessageAttributes")?;
        let system = check_system_attributes(entry.get("MessageSystemAttributes"))?;
        let settings = self.lock().queues[name].settings.clone();
        if message_size(&body, &attributes) > settings.maximum_message_size {
            return Err(invalid_parameter(format!(
                "One or more parameters are invalid. Reason: Message must be shorter than {} bytes.",
                settings.maximum_message_size
            )));
        }
        if entry.get("MessageDeduplicationId").is_some() || entry.get("MessageGroupId").is_some() {
            return Err(invalid_parameter(
                "The request includes parameters that are not valid for this queue type: FF's queues are standard queues.",
            ));
        }
        let delay = integer(entry, "DelaySeconds", 0, 900, settings.delay_seconds)?;
        Ok(Outgoing {
            body,
            attributes,
            trace_header: system.get("AWSTraceHeader").and_then(|header| header.string.clone()),
            sender_id: caller.key_id.to_owned(),
            delay_seconds: Some(delay),
        })
    }

    /// What SendMessage answers of a message kept: its ID, and the MD5 sums the SDKs check.
    fn sent(message: &Outgoing, message_id: &str) -> Map<String, Value> {
        let mut answer = Map::new();
        answer.insert("MessageId".into(), message_id.into());
        answer.insert("MD5OfMessageBody".into(), md5::hex(message.body.as_bytes()).into());
        if let Some(sum) = attributes_md5(&message.attributes) {
            answer.insert("MD5OfMessageAttributes".into(), sum.into());
        }
        let system: Attributes = message
            .trace_header
            .iter()
            .map(|header| ("AWSTraceHeader".to_owned(), Attribute::string("String", header)))
            .collect();
        if let Some(sum) = attributes_md5(&system) {
            answer.insert("MD5OfMessageSystemAttributes".into(), sum.into());
        }
        answer
    }

    /// Messages kept, a long poll told; each one's ID.
    fn keep(&self, name: &str, messages: Vec<Outgoing>) -> Vec<String> {
        let ids = self.lock().keep(name, messages, self.now());
        self.news.notify_all();
        ids
    }

    fn send_message(&self, input: &Value, caller: &Caller) -> Result<Value, SqsError> {
        let name = self.queue_of(input)?;
        let message = self.outgoing(&name, input, caller)?;
        let answer = Self::sent(&message, "");
        let ids = self.keep(&name, vec![message]);
        Ok(Value::Object(Map::from_iter(answer.into_iter().map(|(field, value)| match field.as_str() {
            "MessageId" => (field, ids[0].clone().into()),
            _ => (field, value),
        }))))
    }

    fn send_message_batch(&self, input: &Value, caller: &Caller) -> Result<Value, SqsError> {
        let name = self.queue_of(input)?;
        let mut kept = Vec::new();
        let mut failed = Vec::new();
        for entry in entries(input)? {
            match self.outgoing(&name, entry, caller) {
                Ok(message) => kept.push((entry["Id"].clone(), message)),
                Err(error) => failed.push(json!({
                    "Id": entry["Id"], "Code": error.kind, "SenderFault": true, "Message": error.message,
                })),
            }
        }
        let bytes: usize = kept.iter().map(|(_, message)| message_size(&message.body, &message.attributes)).sum();
        if bytes > MAX_BATCH_BYTES {
            return Err(SqsError::new(
                400,
                "BatchRequestTooLong",
                format!("Batch requests cannot be longer than {MAX_BATCH_BYTES} bytes. You have sent {bytes} bytes."),
            ));
        }
        let answers: Vec<(Value, Map<String, Value>)> =
            kept.iter().map(|(id, message)| (id.clone(), Self::sent(message, ""))).collect();
        let ids = self.keep(&name, kept.into_iter().map(|(_, message)| message).collect());
        let successful = answers.into_iter().zip(ids).map(|((id, mut answer), message_id)| {
            answer.insert("MessageId".into(), message_id.into());
            let mut entry = Map::from_iter([("Id".to_owned(), id)]);
            entry.extend(answer);
            Value::Object(entry)
        });
        Ok(json!({ "Successful": successful.collect::<Vec<_>>(), "Failed": failed }))
    }

    /// Up to MaxNumberOfMessages messages, each hidden for the visibility timeout; with a wait, a long poll: none now,
    /// it waits for a message, up to the wait, answering as soon as there are some.
    fn receive_message(&self, input: &Value) -> Result<Value, SqsError> {
        let name = self.queue_of(input)?;
        let settings = self.lock().queues[&name].settings.clone();
        let max = usize::try_from(integer(input, "MaxNumberOfMessages", 1, 10, 1)?).unwrap_or(1);
        let visibility = integer(input, "VisibilityTimeout", 0, 43_200, settings.visibility_timeout)?;
        let wait = integer(input, "WaitTimeSeconds", 0, 20, settings.receive_wait_seconds)?;
        let received =
            self.receive_waiting(&name, max, visibility, Duration::from_secs(u64::try_from(wait).unwrap_or(0)));
        let system_names: Vec<Value> =
            [list(input.get("AttributeNames")), list(input.get("MessageSystemAttributeNames"))].concat();
        let attribute_names = list(input.get("MessageAttributeNames"));
        let messages: Vec<Value> =
            received.iter().map(|message| answered_message(message, &system_names, attribute_names)).collect();
        Ok(if messages.is_empty() { json!({}) } else { json!({ "Messages": messages }) })
    }

    /// Up to `max` messages received from the queue, as [`State::receive`] receives them; when there is none, waiting
    /// up to `wait` for one, woken as one is kept.
    fn receive_waiting(&self, name: &str, max: usize, visibility: i64, wait: Duration) -> Vec<Message> {
        let deadline = Instant::now() + wait;
        let mut state = self.lock();
        loop {
            let received = state.receive(name, max, visibility, self.now(), &self.arn(""));
            let left = deadline.saturating_duration_since(Instant::now());
            if !received.is_empty() || left.is_zero() {
                return received;
            }
            state = self.news.wait_timeout(state, left.min(POLL)).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
    }

    /// Up to `max` of the queue's messages, as an event source mapping receives them: hidden for the queue's visibility
    /// timeout, each as its record in SQS's event; when there is none, waiting up to `wait` for one.
    pub fn receive_records(&self, name: &str, max: usize, wait: Duration) -> Vec<Value> {
        let visibility = self.lock().queues[name].settings.visibility_timeout;
        let received = self.receive_waiting(name, max, visibility, wait);
        received.iter().map(|message| sqs_event::record(message, &self.arn(name), &self.region)).collect()
    }

    /// The message a receipt handle names deleted, when it is that receive's: an older handle deletes nothing, as SQS's.
    fn delete(&self, name: &str, receipt: &Receipt) {
        self.lock().queue(name).messages.retain(|message| !message.receipt_matches(receipt));
    }

    /// The messages an event source mapping's call handled, deleted by their records' receipt handles.
    pub fn delete_received<'a>(&self, name: &str, handles: impl IntoIterator<Item = &'a str>) {
        for receipt in handles.into_iter().filter_map(parse_receipt) {
            self.delete(name, &receipt);
        }
    }

    /// A received message's visibility changed, from now, while it is hidden still.
    fn change_visibility(&self, name: &str, input: &Value) -> Result<(), SqsError> {
        let receipt = receipt(input.get("ReceiptHandle"))?;
        if input.get("VisibilityTimeout").is_none() {
            return Err(missing_parameter("VisibilityTimeout"));
        }
        let timeout = integer(input, "VisibilityTimeout", 0, 43_200, 0)?;
        let now = self.now();
        let mut state = self.lock();
        let in_flight = state
            .queue(name)
            .messages
            .iter_mut()
            .find(|message| message.receipt_matches(&receipt) && message.visible_at > now);
        match in_flight {
            Some(message) => {
                message.visible_at = now + timeout * 1000;
                Ok(())
            }
            None => Err(SqsError::new(400, "MessageNotInflight", "The message referred to is not in flight.")
                .coded("AWS.SimpleQueueService.MessageNotInflight")),
        }
    }
}

/// What a receipt handle parameter names.
fn receipt(handle: Option<&Value>) -> Result<Receipt, SqsError> {
    let handle = handle.ok_or_else(|| missing_parameter("ReceiptHandle"))?;
    handle.as_str().and_then(parse_receipt).ok_or_else(|| {
        SqsError::new(
            400,
            "ReceiptHandleIsInvalid",
            format!("The input receipt handle \"{}\" is not a valid receipt handle.", shown(handle)),
        )
    })
}

/// A batch's entries, as SQS checks them: 1 to 10, each with an ID of its own.
fn entries(input: &Value) -> Result<&[Value], SqsError> {
    let entries = list(input.get("Entries"));
    if entries.is_empty() {
        return Err(SqsError::new(400, "EmptyBatchRequest", "The batch request doesn't contain any entries."));
    }
    if entries.len() > MAX_BATCH {
        return Err(SqsError::new(
            400,
            "TooManyEntriesInBatchRequest",
            format!("Maximum number of entries per request are {MAX_BATCH}. You have sent {}.", entries.len()),
        ));
    }
    let mut ids = Vec::new();
    for entry in entries {
        let id = entry.get("Id").and_then(Value::as_str).filter(|id| {
            (1..=80).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        });
        let Some(id) = id else {
            return Err(SqsError::new(
                400,
                "InvalidBatchEntryId",
                "A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.",
            ));
        };
        if ids.contains(&id) {
            return Err(SqsError::new(400, "BatchEntryIdsNotDistinct", format!("Id {id} repeated.")));
        }
        ids.push(id);
    }
    Ok(entries)
}

/// Each entry of a batch, its failure SQS's failed entry rather than the batch's.
fn batch(input: &Value, each: impl Fn(&Value) -> Result<(), SqsError>) -> Result<Value, SqsError> {
    let (mut successful, mut failed) = (Vec::new(), Vec::new());
    for entry in entries(input)? {
        match each(entry) {
            Ok(()) => successful.push(json!({ "Id": entry["Id"] })),
            Err(error) => failed.push(json!({
                "Id": entry["Id"], "Code": error.kind, "SenderFault": error.sender, "Message": error.message,
            })),
        }
    }
    Ok(json!({ "Successful": successful, "Failed": failed }))
}

/// A message as ReceiveMessage answers it: the attributes asked for, and the MD5 sums of what is answered.
fn answered_message(message: &Message, system_names: &[Value], attribute_names: &[Value]) -> Value {
    let mut system = vec![
        ("SenderId", message.sender_id.clone()),
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
        .map(|(name, value)| (name.to_owned(), value.into()))
        .collect();
    let message_attributes: Attributes = message
        .attributes
        .iter()
        .filter(|(name, _)| asked(attribute_names, name))
        .map(|(name, attribute)| (name.clone(), attribute.clone()))
        .collect();
    let mut answer = json!({
        "MessageId": message.message_id,
        "ReceiptHandle": receipt_handle(message.row, message.receive_count, &message.message_id),
        "MD5OfBody": md5::hex(message.body.as_bytes()),
        "Body": message.body,
    });
    if !attributes.is_empty() {
        answer["Attributes"] = Value::Object(attributes);
    }
    if let Some(sum) = attributes_md5(&message_attributes) {
        answer["MD5OfMessageAttributes"] = sum.into();
        answer["MessageAttributes"] = attributes_json(&message_attributes);
    }
    answer
}

#[cfg(test)]
pub mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::UNIX_EPOCH;

    use super::super::schedule_expression::iso;
    use super::*;

    /// The backend's table of SQS's requests and answers, which its L1 reads too.
    pub fn table() -> Value {
        serde_json::from_str(include_str!("../../../BE/src/queues/sqs-examples.json")).unwrap()
    }

    const REGION: &str = "tn-tunis-1";
    const ACCOUNT: &str = "000000000000";
    pub const ENDPOINT: &str = "http://127.0.0.1:3700";
    const KEY_ID: &str = "AKFFLOCALLOCALLOCAL0";
    /// When a case that names no time is asked.
    const NOON: &str = "2026-10-23T12:00:00Z";

    fn millis(text: &str) -> Millis {
        let time = humantime::parse_rfc3339(text).unwrap();
        Millis::try_from(time.duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }

    /// The table's placeholders filled with where the tests run and the key that signs; `{x*N}`, N x's.
    pub fn filled(value: &Value, endpoint: &str, key_id: &str) -> Value {
        match value {
            Value::String(text) => {
                let many = text.strip_prefix("{x*").and_then(|rest| rest.strip_suffix('}'));
                if let Some(count) = many.and_then(|count| count.parse::<usize>().ok()) {
                    return "x".repeat(count).into();
                }
                text.replace("{queueUrl}", "{endpoint}/{account}/orders")
                    .replace("{endpoint}", endpoint)
                    .replace("{account}", ACCOUNT)
                    .replace("{region}", REGION)
                    .replace("{keyId}", key_id)
                    .into()
            }
            Value::Array(items) => items.iter().map(|item| filled(item, endpoint, key_id)).collect(),
            Value::Object(fields) => {
                fields.iter().map(|(name, item)| (name.clone(), filled(item, endpoint, key_id))).collect()
            }
            other => other.clone(),
        }
    }

    /// Each `{messageId}` the ID of the next message kept.
    fn with_ids(value: &Value, ids: &mut impl Iterator<Item = String>) -> Value {
        match value {
            Value::String(text) if text == "{messageId}" => ids.next().unwrap_or_default().into(),
            Value::Array(items) => items.iter().map(|item| with_ids(item, ids)).collect(),
            Value::Object(fields) => fields.iter().map(|(name, item)| (name.clone(), with_ids(item, ids))).collect(),
            other => other.clone(),
        }
    }

    /// A clock the tests set.
    fn clock_at(at: &Arc<AtomicI64>) -> Arc<dyn Fn() -> Millis + Send + Sync> {
        let at = Arc::clone(at);
        Arc::new(move || at.load(Ordering::SeqCst))
    }

    impl Queues {
        /// What a queue holds, as the table writes it.
        fn held(&self, name: &str) -> Vec<Value> {
            let state = self.lock();
            let as_table = |message: &Message| {
                let mut meta = json!({ "senderId": message.sender_id });
                if !message.attributes.is_empty() {
                    meta["messageAttributes"] = attributes_json(&message.attributes);
                }
                let mut held = json!({
                    "id": message.row.to_string(),
                    "messageId": message.message_id,
                    "body": message.body,
                    "meta": meta,
                    "sentAt": iso(message.sent_at),
                    "receiveCount": message.receive_count,
                    "visibleAt": iso(message.visible_at),
                });
                if let Some(first) = message.first_received_at {
                    held["firstReceivedAt"] = iso(first).into();
                }
                held
            };
            state.queues[name].messages.iter().map(as_table).collect()
        }

        /// Messages put in a queue as the table writes them, before a request.
        fn hold(&self, name: &str, holds: &[Value]) {
            let mut state = self.lock();
            let retention = state.queues[name].settings.retention_seconds;
            for held in holds {
                let message = held_message(held, retention);
                state.next_row = state.next_row.max(message.row + 1);
                state.queue(name).messages.push(message);
            }
        }
    }

    /// A message as a table of the backend's writes one held: its row's `id`, `messageId`, `body`, `meta` (its sender,
    /// its attributes, its trace header), when it was sent, received first and is visible, by default when it was
    /// sent, and its receives; kept for `retention` seconds.
    pub(in crate::local) fn held_message(held: &Value, retention: i64) -> Message {
        let sent_at = millis(held["sentAt"].as_str().unwrap());
        let meta = &held["meta"];
        Message {
            row: held["id"].as_str().unwrap().parse().unwrap(),
            message_id: held["messageId"].as_str().unwrap().to_owned(),
            body: held["body"].as_str().unwrap().to_owned(),
            attributes: check_attributes(meta.get("messageAttributes"), "messageAttributes").unwrap(),
            trace_header: meta
                .pointer("/systemAttributes/AWSTraceHeader/StringValue")
                .and_then(Value::as_str)
                .map(str::to_owned),
            sender_id: meta["senderId"].as_str().unwrap_or_default().to_owned(),
            sent_at,
            visible_at: held.get("visibleAt").and_then(Value::as_str).map_or(sent_at, millis),
            expires_at: sent_at + retention * 1000,
            receive_count: held["receiveCount"].as_u64().unwrap(),
            first_received_at: held.get("firstReceivedAt").and_then(Value::as_str).map(millis),
        }
    }

    /// Each case of the table's operations: on `orders`, holding what the case says when it is asked, its answer or
    /// its refusal, what a send kept, none when refused, and what the queue holds after when the case says.
    #[test]
    fn the_operations_answer_the_backends_cases_as_the_backend_does() {
        let table = table();
        let mut cases = 0;
        for (group, examples) in table["operations"].as_object().unwrap() {
            for example in examples.as_array().unwrap() {
                let title = format!("{group}: {}", example["title"].as_str().unwrap());
                let at = Arc::new(AtomicI64::new(millis(example["at"].as_str().unwrap_or(NOON))));
                let queues = Queues::new(
                    REGION,
                    ACCOUNT,
                    [("orders".to_owned(), QueueSettings::of(example.get("queue").unwrap_or(&json!({}))))],
                    clock_at(&at),
                );
                let holds = example.get("holds").and_then(Value::as_array).cloned().unwrap_or_default();
                queues.hold("orders", &holds);
                let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
                let operation = example["operation"].as_str().unwrap();

                let answered = queues.run(operation, &filled(&example["input"], ENDPOINT, KEY_ID), &caller);

                let held_rows: Vec<&str> = holds.iter().filter_map(|held| held["id"].as_str()).collect();
                let kept: Vec<Value> = queues
                    .held("orders")
                    .into_iter()
                    .filter(|message| !held_rows.contains(&message["id"].as_str().unwrap()))
                    .collect();
                match example.get("refused") {
                    Some(refused) => {
                        let error = answered.expect_err(&title);
                        let refused = filled(refused, ENDPOINT, KEY_ID);
                        assert_eq!(
                            (error.status, error.kind, error.message.as_str()),
                            (
                                refused["status"].as_u64().unwrap() as u16,
                                refused["type"].as_str().unwrap(),
                                refused["message"].as_str().unwrap()
                            ),
                            "{title}"
                        );
                    }
                    None => {
                        let mut ids = kept.iter().map(|message| message["messageId"].as_str().unwrap().to_owned());
                        let wanted = with_ids(&filled(&example["answer"], ENDPOINT, KEY_ID), &mut ids);
                        assert_eq!(answered.expect(&title), wanted, "{title}");
                    }
                }
                let wanted_kept = filled(example.get("kept").unwrap_or(&json!([])), ENDPOINT, KEY_ID);
                let kept_as_table: Vec<Value> = kept
                    .iter()
                    .map(|message| {
                        let delay = (millis(message["visibleAt"].as_str().unwrap())
                            - millis(message["sentAt"].as_str().unwrap()))
                            / 1000;
                        let attributes = check_attributes(message["meta"].get("messageAttributes"), "kept").unwrap();
                        json!({
                            "body": message["body"],
                            "meta": message["meta"],
                            "sizeBytes": message_size(message["body"].as_str().unwrap(), &attributes),
                            "delaySeconds": delay,
                        })
                    })
                    .collect();
                assert_eq!(Value::from(kept_as_table), wanted_kept, "{title}: kept");
                if let Some(left) = example.get("left") {
                    assert_eq!(Value::from(queues.held("orders")), *left, "{title}: left");
                }
                cases += 1;
            }
        }
        assert_eq!(cases, 42, "every case of the table");
    }

    /// A queue holding `orders` and its dead-letter queue, `dead`, after two receives.
    fn redriven() -> (Queues, Arc<AtomicI64>) {
        let at = Arc::new(AtomicI64::new(millis(NOON)));
        let redrive =
            Redrive { dead_letter_target_arn: format!("arn:aws:sqs:{REGION}:{ACCOUNT}:dead"), max_receive_count: 2 };
        let orders = QueueSettings { redrive: Some(redrive), ..QueueSettings::default() };
        let dead = QueueSettings { retention_seconds: 60, ..QueueSettings::default() };
        let queues = Queues::new(REGION, ACCOUNT, [("orders".into(), orders), ("dead".into(), dead)], clock_at(&at));
        (queues, at)
    }

    #[test]
    fn a_message_received_as_often_as_the_redrive_policy_allows_goes_to_the_dead_letter_queue_at_the_next_receive() {
        let (queues, at) = redriven();
        let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
        let orders = json!({ "QueueUrl": format!("{ENDPOINT}/{ACCOUNT}/orders") });
        let receive = json!({ "QueueUrl": orders["QueueUrl"], "VisibilityTimeout": 0 });
        let dead = json!({ "QueueUrl": format!("{ENDPOINT}/{ACCOUNT}/dead"), "AttributeNames": ["All"] });
        queues
            .run("SendMessage", &json!({ "QueueUrl": orders["QueueUrl"], "MessageBody": "poison" }), &caller)
            .unwrap();
        let count = |answer: Value| answer["Messages"][0]["Attributes"]["ApproximateReceiveCount"].clone();
        let with_count = json!({ "QueueUrl": orders["QueueUrl"], "VisibilityTimeout": 0, "AttributeNames": ["All"] });

        let first = queues.run("ReceiveMessage", &with_count, &caller).unwrap();
        let second = queues.run("ReceiveMessage", &with_count, &caller).unwrap();
        at.fetch_add(1000, Ordering::SeqCst);
        let third = queues.run("ReceiveMessage", &receive, &caller).unwrap();
        let in_dead = queues.run("ReceiveMessage", &dead, &caller).unwrap();

        assert_eq!((count(first), count(second), third), (json!("1"), json!("2"), json!({})));
        assert_eq!(in_dead["Messages"][0]["Body"], "poison");
        assert_eq!(in_dead["Messages"][0]["Attributes"]["ApproximateReceiveCount"], "1", "counted from none again");
        let sent_at = in_dead["Messages"][0]["Attributes"]["SentTimestamp"].as_str().unwrap();
        assert_eq!(sent_at, millis(NOON).to_string(), "sent when it was sent to orders");
        at.fetch_add(60_000, Ordering::SeqCst);
        let gone = queues.run("ReceiveMessage", &json!({ "QueueUrl": dead["QueueUrl"] }), &caller).unwrap();
        assert_eq!(gone, json!({}), "kept for the dead-letter queue's retention from when it was sent");
        let attributes = queues
            .run(
                "GetQueueAttributes",
                &json!({ "QueueUrl": orders["QueueUrl"], "AttributeNames": ["RedrivePolicy", "QueueArn"] }),
                &caller,
            )
            .unwrap();
        assert_eq!(
            attributes["Attributes"],
            json!({
                "QueueArn": format!("arn:aws:sqs:{REGION}:{ACCOUNT}:orders"),
                "RedrivePolicy": format!(r#"{{"deadLetterTargetArn":"arn:aws:sqs:{REGION}:{ACCOUNT}:dead","maxReceiveCount":2}}"#),
            })
        );
    }

    #[test]
    fn a_message_is_kept_for_its_queues_retention_waits_for_its_delay_and_a_purge_empties_the_queue() {
        let at = Arc::new(AtomicI64::new(millis(NOON)));
        let settings = QueueSettings { retention_seconds: 60, delay_seconds: 10, ..QueueSettings::default() };
        let queues = Queues::new(REGION, ACCOUNT, [("orders".into(), settings)], clock_at(&at));
        let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
        let url = format!("{ENDPOINT}/{ACCOUNT}/orders");
        let counts = |queues: &Queues| {
            let names = ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesDelayed"];
            let answer =
                queues.run("GetQueueAttributes", &json!({ "QueueUrl": url, "AttributeNames": names }), &caller);
            let attributes = answer.unwrap()["Attributes"].clone();
            (attributes[names[0]].as_str().unwrap().to_owned(), attributes[names[1]].as_str().unwrap().to_owned())
        };
        let send = |body: &str| {
            queues.run("SendMessage", &json!({ "QueueUrl": url, "MessageBody": body }), &caller).unwrap();
        };

        send("one");
        let delayed = counts(&queues);
        at.fetch_add(10_000, Ordering::SeqCst);
        let ready = counts(&queues);
        at.fetch_add(50_000, Ordering::SeqCst);
        let expired = counts(&queues);
        send("two");
        at.fetch_add(10_000, Ordering::SeqCst);
        let before_purge = counts(&queues);
        queues.run("PurgeQueue", &json!({ "QueueUrl": url }), &caller).unwrap();

        assert_eq!(
            [delayed, ready, expired],
            [("0".into(), "1".into()), ("1".into(), "0".into()), ("0".into(), "0".into())]
        );
        assert_eq!((before_purge, counts(&queues)), (("1".into(), "0".into()), ("0".into(), "0".into())));
    }

    #[test]
    fn a_long_poll_ends_as_soon_as_a_message_comes_or_after_its_wait() {
        let queues = Arc::new(Queues::new(
            REGION,
            ACCOUNT,
            [("orders".to_owned(), QueueSettings::default())],
            Arc::new(|| super::super::schedules::now_ms(0)),
        ));
        let url = format!("{ENDPOINT}/{ACCOUNT}/orders");
        let receive = |wait: i64| {
            let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
            queues.run("ReceiveMessage", &json!({ "QueueUrl": url, "WaitTimeSeconds": wait }), &caller).unwrap()
        };
        let started = Instant::now();
        let empty = receive(1);
        let waited = started.elapsed();
        let sender = Arc::clone(&queues);
        let to = url.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
            sender.run("SendMessage", &json!({ "QueueUrl": to, "MessageBody": "during the wait" }), &caller).unwrap();
        });
        let started = Instant::now();
        let during = receive(10);

        assert_eq!(empty, json!({}));
        assert!(waited >= Duration::from_millis(950), "answered after its wait, not {waited:?}");
        assert_eq!(during["Messages"][0]["Body"], "during the wait");
        assert!(started.elapsed() < Duration::from_secs(2), "answered when the message came");
    }

    #[test]
    fn what_ff_local_doesnt_offer_is_said_and_ff_sends_to_a_queue_as_its_asynchronous_calls_do() {
        let (queues, _) = redriven();
        let caller = Caller { key_id: KEY_ID, endpoint: ENDPOINT };
        let refused = |operation: &str| queues.run(operation, &json!({ "QueueName": "more" }), &caller).unwrap_err();

        assert_eq!(refused("CreateQueue").kind, "UnsupportedOperation");
        assert!(refused("CreateQueue").message.starts_with("ff local's queues are the template's: CreateQueue"));
        let attributes = Attributes::from([("RequestID".to_owned(), Attribute::string("String", "a-request"))]);
        let dead_letter = |body: &str| Outgoing {
            body: body.into(),
            attributes: attributes.clone(),
            trace_header: None,
            sender_id: "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders".into(),
            delay_seconds: None,
        };
        let arn = format!("arn:aws:sqs:{REGION}:{ACCOUNT}:dead");
        assert_eq!(queues.send_as_ff(&arn, dead_letter("{}")), Ok(()));
        assert_eq!(
            queues.send_as_ff(&format!("arn:aws:sqs:{REGION}:{ACCOUNT}:gone"), dead_letter("{}")),
            Err(format!("arn:aws:sqs:{REGION}:{ACCOUNT}:gone is no queue here"))
        );
        assert_eq!(
            queues.send_as_ff(&arn, dead_letter(&"x".repeat(1_048_576))),
            Err("it is 1048600 bytes, over the queue's maximum message size of 1048576".into()),
            "the body's bytes and the attribute's name, type and value"
        );
        let held = queues.held("dead");
        assert_eq!(held.len(), 1);
        assert_eq!(held[0]["meta"]["senderId"], "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders");
        assert_eq!(held[0]["meta"]["messageAttributes"]["RequestID"]["StringValue"], "a-request");
    }

    /// A part of SQS's encoding of attributes: its length in 4 bytes, big-endian, then its bytes.
    fn part(bytes: &[u8]) -> Vec<u8> {
        [&u32::try_from(bytes.len()).unwrap().to_be_bytes()[..], bytes].concat()
    }

    #[test]
    fn checks_a_message_and_sums_its_attributes_as_sqs_does() {
        let picture = [0xff, 0x00, 0x7f];
        let attributes = Attributes::from([
            ("b-quantity".to_owned(), Attribute::string("Number", "12")),
            (
                "a-picture".to_owned(),
                Attribute { data_type: "Binary.png".into(), string: None, binary: Some(STANDARD.encode(picture)) },
            ),
        ]);
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
        assert_eq!(attributes_md5(&attributes), Some(md5::hex(&both)));
        assert_eq!(attributes_md5(&Attributes::new()), None);
        assert_eq!(message_size("سلام", &attributes), 8 + 9 + 10 + 3 + 10 + 6 + 2);

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
            json!({ "DataType": "Number", "StringValue": "Infinity" }),
            json!({ "DataType": "Binary", "BinaryValue": "not base64!" }),
            json!({ "DataType": "String" }),
            json!({ "DataType": "Strings", "StringValue": "x" }),
            json!({ "DataType": "String", "StringListValues": ["a"] }),
        ] {
            assert!(check_attributes(Some(&json!({ "a": value })), "MessageAttributes").is_err(), "{value}");
        }
        for number in ["12", " 1e3 ", "-.5", "0x1F", "+7"] {
            assert!(is_finite_number(number), "{number}");
        }
        let trace = json!({ "AWSTraceHeader": { "DataType": "String", "StringValue": "Root=1-a" } });
        assert!(check_system_attributes(Some(&trace)).is_ok());
        assert!(
            check_system_attributes(Some(&json!({ "Other": { "DataType": "String", "StringValue": "x" } }))).is_err()
        );
    }

    #[test]
    fn a_receipt_handle_names_the_message_and_its_receive() {
        let handle = receipt_handle(1_234_567_890_123, 3, "6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77");
        let named = Receipt {
            row: 1_234_567_890_123,
            receive_count: 3,
            message_id: "6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77".into(),
        };
        assert_eq!(parse_receipt(&handle), Some(named));
        for handle in ["", "not a handle", "made-up", &URL_SAFE_NO_PAD.encode("1:2:not-a-uuid"), &"a".repeat(300)] {
            assert_eq!(parse_receipt(handle), None, "{handle}");
        }
    }
}
