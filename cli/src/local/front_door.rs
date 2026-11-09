//! The local front door (ADR 0017): one port on this machine that answers as FF's front doors answer, in the protocols
//! AWS's SDKs speak, the backend's words in its refusals. A request signed with Signature Version 4 is checked against
//! the local key, as FF checks one against its keys; an unsigned one is taken, for `curl`, where FF refuses it.
//! Lambda's `Invoke` (`BE/src/lambda/lambda-invoke.ts`), its checks in the backend's order: a call waited for, its
//! answer as the runtime sent it, a function's error as Lambda's document with `X-Amz-Function-Error: Unhandled`, the
//! call's log with `X-Amz-Log-Type: Tail`, the caller's ClientContext passed on; an `Event`, answered 202 and run apart
//! as FF runs one, retried, its record sent to its destination; a `DryRun`, checked only. Its cases are
//! `BE/src/lambda/lambda-invoke-examples.json`'s, which the backend's tests read too. And `GetFunctionConfiguration`,
//! as the backend answers it for `$LATEST`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{GeneralPurpose, NO_PAD_INDIFFERENT, STANDARD};
use serde_json::{Value, json};

use super::events::{self, Attempts, End, Outcome, RetryPolicy, Settlement};
use super::http::{Answers, PAYLOAD_LIMIT, Request, Response, percent_decode, request_id};
use super::instances::{Called, Instances, Runner};
use super::key::Key;
use super::{Asks, Code};
use crate::error::{Error, Kind};
use crate::sigv4::{Problem, SignedRequest, check_authorization, read_authorization, sha256_hex};

/// What Lambda takes of an `Event` invocation's payload: 1 MB.
const ASYNC_PAYLOAD_LIMIT: usize = 1024 * 1024;
/// The invocation types, and the log types, in the order Lambda's refusals name them.
const INVOCATION_TYPES: [&str; 3] = ["RequestResponse", "Event", "DryRun"];
const LOG_TYPES: [&str; 2] = ["None", "Tail"];
/// Lambda's limit on a ClientContext, in base64.
const CLIENT_CONTEXT_BYTES: usize = 3583;
/// What the front door answers of its own failure, as Lambda does.
const SERVICE_EXCEPTION: &str = "The AWS Lambda service encountered an internal error.";
/// Lambda's reason for a call that found none of the function's instances free.
const INSTANCES_BUSY: &str = "ReservedFunctionConcurrentInvocationLimitExceeded";
/// The service Lambda's requests are signed for.
const SERVICE: &str = "lambda";
/// Lambda's words for a signature that isn't the key's.
const SIGNATURE_MISMATCH: &str = "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.";

/// An answer of Lambda's REST JSON protocol: a status, the error's name in `x-amzn-ErrorType`, and whose fault it is
/// with its message, and Lambda's fields beside them.
fn refusal_with(status: u16, error_type: &str, message: &str, fields: &[(&str, &str)]) -> Response {
    let mut body = json!({ "Type": if status < 500 { "User" } else { "Service" }, "message": message });
    for (name, value) in fields {
        body[*name] = Value::from(*value);
    }
    Response {
        status,
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("x-amzn-ErrorType".into(), error_type.into()),
        ],
        body: body.to_string().into_bytes(),
    }
}

fn refusal(status: u16, error_type: &str, message: &str) -> Response {
    refusal_with(status, error_type, message, &[])
}

fn unrecognized_client() -> Response {
    refusal(403, "UnrecognizedClientException", "The security token included in the request is invalid.")
}

/// A signature's problem in Lambda's words, as the backend says them (`serviceWords`, `BE/src/common/signature-v4.ts`).
fn signature_refusal(problem: Problem) -> Response {
    let incomplete = |message: &str| refusal(400, "IncompleteSignatureException", message);
    let mismatch = |message: &str| refusal(403, "InvalidSignatureException", message);
    match problem {
        Problem::Token => unrecognized_client(),
        Problem::Algorithm => {
            incomplete("The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.")
        }
        Problem::Parts => {
            incomplete("Authorization header requires Credential, SignedHeaders and Signature parameters.")
        }
        Problem::Credential { .. } => {
            incomplete(&format!("The Credential is not <access key ID>/<date>/<region>/{SERVICE}/aws4_request."))
        }
        Problem::Service { .. } => mismatch(&format!("Credential should be scoped to correct service: '{SERVICE}'.")),
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
        Problem::Mismatch => mismatch(SIGNATURE_MISMATCH),
    }
}

/// A function's answer, or its error as Lambda's document, both 200, as Lambda answers them; the call's log with them
/// when it was asked.
fn answered(body: Vec<u8>, function_error: bool, log_result: Option<String>) -> Response {
    let mut headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-amz-executed-version".to_owned(), "$LATEST".to_owned()),
    ];
    if let Some(log_result) = log_result {
        headers.push(("x-amz-log-result".into(), log_result));
    }
    if function_error {
        headers.push(("x-amz-function-error".into(), "Unhandled".into()));
    }
    Response { status: 200, headers, body }
}

fn error_document(error_type: &str, message: &str) -> Value {
    json!({ "errorType": error_type, "errorMessage": message })
}

/// One of the values Lambda takes for a header, or its default; refused, naming them, otherwise.
fn one_of<'a>(
    request: &'a Request,
    header: &str,
    field: &str,
    values: &[&str],
    default: &'a str,
) -> Result<&'a str, Response> {
    let value = request.header(header).unwrap_or(default);
    if values.contains(&value) {
        return Ok(value);
    }
    let message = format!("{field} must be {}, not {value}.", values.join(", "));
    Err(refusal(400, "InvalidParameterValueException", &message))
}

/// Base64 as Node.js reads it, which the backend's check is: either alphabet, padding or none, up to the first `=`,
/// what isn't base64 passed over.
fn lenient_base64(text: &str) -> Vec<u8> {
    let mut kept: String = text
        .chars()
        .take_while(|character| *character != '=')
        .map(|character| match character {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '/'))
        .collect();
    if kept.len() % 4 == 1 {
        kept.pop();
    }
    let engine =
        GeneralPurpose::new(&base64::alphabet::STANDARD, NO_PAD_INDIFFERENT.with_decode_allow_trailing_bits(true));
    engine.decode(kept).unwrap_or_default()
}

/// The caller's ClientContext, `X-Amz-Client-Context`, as Lambda takes it: the base64 of a JSON object, its 3583 bytes
/// at most, passed on as sent.
fn client_context(header: Option<&str>) -> Result<Option<String>, Response> {
    let Some(header) = header else { return Ok(None) };
    if header.len() > CLIENT_CONTEXT_BYTES {
        let message =
            format!("ClientContext must be at most {CLIENT_CONTEXT_BYTES} bytes of base64, not {}.", header.len());
        return Err(refusal(400, "InvalidParameterValueException", &message));
    }
    match serde_json::from_slice::<Value>(&lenient_base64(header)) {
        Ok(Value::Object(_)) => Ok(Some(header.to_owned())),
        _ => Err(refusal(
            400,
            "InvalidRequestContentException",
            "Client context must be a valid Base64-encoded JSON object.",
        )),
    }
}

/// The `Qualifier` a request's query names, decoded.
fn qualifier_in(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| pair.strip_prefix("Qualifier=")).map(percent_decode)
}

/// A function's output, as a record gives it: its JSON, the text it is when it is none, null when there is none.
fn output_of(body: &str) -> Value {
    match body.trim() {
        "" => Value::Null,
        text => serde_json::from_str(text).unwrap_or_else(|_| Value::String(body.to_owned())),
    }
}

/// The time as Lambda's `LastModified` says it: 2026-11-09T10:00:00.000+0000.
fn lambda_time(at: SystemTime) -> String {
    humantime::format_rfc3339_millis(at).to_string().replace('Z', "+0000")
}

/// The function's code as Lambda's CodeSize and CodeSha256 say it: what runs here, its folder as its package would
/// hold it unbuilt.
fn code_of(code: &Code) -> Result<(u64, String), Error> {
    match code {
        Code::Folder(folder) => crate::package::unbuilt_code(folder),
        Code::File { path, .. } => {
            let bytes = std::fs::read(path)
                .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read {}: {error}", path.display())))?;
            Ok((bytes.len() as u64, STANDARD.encode(ring::digest::digest(&ring::digest::SHA256, &bytes))))
        }
    }
}

/// What a request's `FunctionName` says: the function's name, and where and which of it, as it says them.
struct Named<'a> {
    region: Option<&'a str>,
    account: Option<&'a str>,
    name: &'a str,
    qualifier: Option<&'a str>,
}

/// The function a path or an ARN names, as Lambda reads `FunctionName`: a name, `name:qualifier`,
/// `account:function:name`, or the whole ARN, a `Qualifier` in the query naming its version or its alias instead.
fn named<'a>(text: &'a str, qualifier: Option<&'a str>) -> Named<'a> {
    let parts: Vec<&str> = text.split(':').collect();
    let (region, account, rest) = match parts.as_slice() {
        ["arn", "aws", "lambda", region, account, "function", rest @ ..] => (Some(*region), Some(*account), rest),
        [account, "function", rest @ ..] => (None, Some(*account), rest),
        rest => (None, None, rest),
    };
    let (name, own) = match rest {
        [name] => (*name, None),
        [name, qualifier] => (*name, Some(*qualifier)),
        _ => (text, None),
    };
    Named { region, account, name, qualifier: qualifier.or(own) }
}

/// What the front door knows of a function besides how it runs: what Lambda's operations answer of it, and how its
/// asynchronous calls end.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    /// Its alias: a name for the function as it is, here.
    pub alias: Option<String>,
    pub description: String,
    /// Its variables as the template gives them, which GetFunctionConfiguration shows: never a secret.
    pub variables: BTreeMap<String, String>,
    /// Its dead-letter queue's ARN.
    pub dead_letter: Option<String>,
    /// How its asynchronous calls are retried, and where each one's record goes, as it ends.
    pub retries: RetryPolicy,
    pub on_success: Option<String>,
    pub on_failure: Option<String>,
}

/// The front door to the template's app.
pub struct FrontDoor<R: Runner> {
    pub instances: Arc<Instances<R>>,
    pub region: String,
    pub account: String,
    /// The key a signed request is checked against.
    pub key: Key,
    /// Each function's settings, by its name.
    pub settings: Arc<BTreeMap<String, Settings>>,
    /// When the app started: its functions' LastModified.
    pub started: SystemTime,
    /// How long a second of an asynchronous call's waits and age lasts: a second, but in the `ff` suite's builds.
    pub second: Duration,
    /// Says what goes wrong that no caller sees: an `Event`'s failure.
    pub say: Arc<dyn Fn(&str) + Send + Sync>,
}

impl<R: Runner> Clone for FrontDoor<R> {
    fn clone(&self) -> Self {
        FrontDoor {
            instances: Arc::clone(&self.instances),
            region: self.region.clone(),
            account: self.account.clone(),
            key: self.key.clone(),
            settings: Arc::clone(&self.settings),
            started: self.started,
            second: self.second,
            say: Arc::clone(&self.say),
        }
    }
}

impl<R: Runner> FrontDoor<R> {
    /// A signed request's signature checked against the local key, as FF checks one against its keys; an unsigned
    /// request taken. A key that isn't the local one is said here, as no caller learns which key FF has.
    fn signed(&self, request: &Request, path: &str, query: &str) -> Result<(), Response> {
        let Some(signature) = read_authorization(&request.headers, SERVICE).map_err(signature_refusal)? else {
            return Ok(());
        };
        if signature.access_key_id != self.key.id {
            (self.say)(&format!(
                "A request signed with {}, not the local key {}: .ff/local/credentials holds it",
                signature.access_key_id, self.key.id
            ));
            return Err(unrecognized_client());
        }
        let signed =
            SignedRequest { method: &request.method, raw_path: path, raw_query: query, headers: &request.headers };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
        let now = i64::try_from(now).unwrap_or(i64::MAX);
        check_authorization(&signed, &request.body, &signature, &self.key.secret, now, SERVICE)
            .map_err(signature_refusal)
    }

    fn arn(&self, name: &str) -> String {
        format!("arn:aws:lambda:{}:{}:function:{name}", self.region, self.account)
    }

    /// Whether this machine has the function named, in this region and account.
    fn has(&self, named: &Named) -> bool {
        named.region.is_none_or(|region| region == self.region)
            && named.account.is_none_or(|account| account == self.account)
            && self.instances.function(named.name).is_some()
    }

    /// Whether the qualifier names the function as it runs here: `$LATEST`, or its alias.
    fn runs_as(&self, named: &Named) -> bool {
        named.qualifier.is_none_or(|qualifier| {
            qualifier == "$LATEST"
                || self.settings.get(named.name).and_then(|settings| settings.alias.as_deref()) == Some(qualifier)
        })
    }

    /// Lambda's 404 for a function this machine hasn't, named by its ARN.
    fn missing(&self, named: &Named) -> Response {
        let qualified = named.qualifier.map(|qualifier| format!(":{qualifier}")).unwrap_or_default();
        let arn = format!(
            "arn:aws:lambda:{}:{}:function:{}{qualified}",
            named.region.unwrap_or(&self.region),
            named.account.unwrap_or(&self.account),
            named.name
        );
        refusal(404, "ResourceNotFoundException", &format!("Function not found: {arn}"))
    }

    fn invoke(
        &self,
        request: &Request,
        function_name: &str,
        query: &str,
        request_id: &str,
    ) -> Result<Response, Response> {
        let qualifier = qualifier_in(query);
        let named = named(function_name, qualifier.as_deref());
        if !self.has(&named) {
            return Err(self.missing(&named));
        }
        let invocation_type =
            one_of(request, "x-amz-invocation-type", "InvocationType", &INVOCATION_TYPES, "RequestResponse")?;
        let log_tail = one_of(request, "x-amz-log-type", "LogType", &LOG_TYPES, "None")? == "Tail";
        let client_context = client_context(request.header("x-amz-client-context"))?;
        if invocation_type == "Event" && request.body.len() > ASYNC_PAYLOAD_LIMIT {
            let message =
                format!("Request must be smaller than {ASYNC_PAYLOAD_LIMIT} bytes for the InvokeFunction operation");
            return Err(refusal(413, "RequestEntityTooLargeException", &message));
        }
        let event: Value = match request.body.is_empty() {
            true => json!({}),
            false => serde_json::from_slice(&request.body).map_err(|error| {
                let message = format!("Could not parse request body into json: {error}");
                refusal(400, "InvalidRequestContentException", &message)
            })?,
        };
        if !self.runs_as(&named) {
            return Err(self.missing(&named));
        }
        Ok(match invocation_type {
            "DryRun" => Response { status: 204, headers: Vec::new(), body: Vec::new() },
            "Event" => {
                self.send(named.name, event, request_id, named.qualifier);
                Response { status: 202, headers: Vec::new(), body: Vec::new() }
            }
            _ => self.called(named.name, &event, request_id, &Asks { log_tail, client_context }),
        })
    }

    /// A call waited for, answered as Lambda answers it, as the backend reads the runtime's answer.
    fn called(&self, name: &str, event: &Value, request_id: &str, asks: &Asks) -> Response {
        let document = |error_type: &str, message: &str| error_document(error_type, message).to_string().into_bytes();
        match self.instances.call(name, event, request_id, asks) {
            Some(Ok(Called::Answered(answer))) => match answer.function_error() {
                Some((error_type, message)) => answered(document(&error_type, &message), true, answer.log_result),
                // None is null, as the backend reads it.
                None if answer.status == 200 && answer.body.is_empty() => {
                    answered(b"null".to_vec(), false, answer.log_result)
                }
                None if answer.status == 200 => answered(answer.body.into_bytes(), false, answer.log_result),
                None if answer.status == 429 => {
                    let body: Value = serde_json::from_str(&answer.body).unwrap_or_default();
                    let message = body["errorMessage"].as_str().unwrap_or("Rate exceeded");
                    refusal_with(429, "TooManyRequestsException", message, &[("Reason", INSTANCES_BUSY)])
                }
                None => {
                    (self.say)(&format!("{name}: its runtime answered {}: {}", answer.status, answer.body.trim()));
                    refusal(500, "ServiceException", SERVICE_EXCEPTION)
                }
            },
            Some(Ok(Called::NotLoaded { error_type, message })) => {
                answered(document(&error_type, &message), true, None)
            }
            Some(Err(error)) => {
                // The details stay on this machine's stderr, as the backend keeps them in its log.
                (self.say)(&format!("{name}: {}", error.message));
                refusal(500, "ServiceException", SERVICE_EXCEPTION)
            }
            None => self.missing(&named(name, None)),
        }
    }

    /// An asynchronous call, run apart to its end.
    fn send(&self, name: &str, event: Value, request_id: &str, qualifier: Option<&str>) {
        let (door, name, request_id, qualifier) =
            (self.clone(), name.to_owned(), request_id.to_owned(), qualifier.map(str::to_owned));
        std::thread::spawn(move || door.run(&name, &event, &request_id, qualifier.as_deref()));
    }

    /// An asynchronous call's attempts as FF's worker makes them, each failure said, until it ends; then its record
    /// to its destination, and its event, failed, to its dead-letter queue.
    fn run(&self, name: &str, event: &Value, request_id: &str, qualifier: Option<&str>) {
        let settings = self.settings.get(name).cloned().unwrap_or_default();
        let sent = Instant::now();
        let mut attempts = Attempts::default();
        loop {
            // A function gone ends its calls, and no destination is told.
            let Some((outcome, response)) = self.attempt(name, event, request_id) else { return };
            let age = sent.elapsed().as_secs_f64() / self.second.as_secs_f64();
            let failed = format!(
                "{name}: the asynchronous call {request_id} failed: {}: {}",
                response.payload["errorType"].as_str().unwrap_or_default(),
                response.payload["errorMessage"].as_str().unwrap_or_default()
            );
            match events::after_attempt(attempts, outcome, age, settings.retries) {
                Settlement::Retry { wait_seconds, attempts: next } => {
                    (self.say)(&format!("{failed}; tried again in {wait_seconds} s"));
                    attempts = next;
                    std::thread::sleep(self.second.saturating_mul(u32::try_from(wait_seconds).unwrap_or(u32::MAX)));
                }
                Settlement::End(end, attempts) => {
                    match end {
                        End::Succeeded => {}
                        End::RetriesExhausted => (self.say)(&format!(
                            "{failed}; dropped after {} attempts: its retries are used",
                            attempts.settled
                        )),
                        End::TooOld => (self.say)(&format!(
                            "{failed}; dropped: its next attempt would come past its maximum age, {} s",
                            settings.retries.maximum_event_age_seconds
                        )),
                    }
                    let call = events::Call {
                        request_id,
                        function_arn: &self.arn(name),
                        qualifier,
                        approximate_invoke_count: attempts.settled,
                        request_payload: event,
                    };
                    self.hand_over(&call, end, &response, &settings);
                    return;
                }
            }
        }
    }

    /// One attempt of an asynchronous call: how it ended, and its answer as a record gives it; none when the function
    /// is gone.
    fn attempt(&self, name: &str, event: &Value, request_id: &str) -> Option<(Outcome, events::Response)> {
        let failed = |error_type: &str, message: &str| events::Response {
            status: 200,
            function_error: true,
            payload: error_document(error_type, message),
        };
        let not_made = |status: u16, error_type: &str, message: &str| events::Response {
            status,
            function_error: false,
            payload: error_document(error_type, message),
        };
        Some(match self.instances.call(name, event, request_id, &Asks::default())? {
            Ok(Called::Answered(answer)) => match answer.function_error() {
                Some((error_type, message)) => (Outcome::FunctionError, failed(&error_type, &message)),
                None if answer.status == 200 => (
                    Outcome::Success,
                    events::Response { status: 200, function_error: false, payload: output_of(&answer.body) },
                ),
                None if answer.status == 429 => {
                    let body: Value = serde_json::from_str(&answer.body).unwrap_or_default();
                    let message = body["errorMessage"].as_str().unwrap_or("Rate exceeded");
                    (Outcome::Throttled, not_made(429, "TooManyRequestsException", message))
                }
                None => {
                    let message = format!("ff local couldn't make the call: its runtime answered {}", answer.status);
                    (Outcome::SystemError, not_made(500, "ServiceException", &message))
                }
            },
            Ok(Called::NotLoaded { error_type, message }) => (Outcome::FunctionError, failed(&error_type, &message)),
            Err(error) => {
                let message = format!("ff local couldn't make the call: {}", error.message);
                (Outcome::SystemError, not_made(500, "ServiceException", &message))
            }
        })
    }

    /// The call's record to the destination its function names for how it ended, and its event, failed, to the
    /// function's dead-letter queue, as FF sends both: a function's an asynchronous call here, a queue's said, as ff
    /// local runs no queue yet.
    fn hand_over(&self, call: &events::Call, end: End, response: &events::Response, settings: &Settings) {
        let (name, id) = (call.function_arn.rsplit(':').next().unwrap_or_default(), call.request_id);
        let destination = if end == End::Succeeded { &settings.on_success } else { &settings.on_failure };
        if let Some(destination) = destination {
            let record = events::invocation_record(call, end, Some(response), SystemTime::now());
            let target = named(destination, None);
            if destination.starts_with("arn:aws:sqs:") {
                (self.say)(&format!(
                    "{name}: the asynchronous call {id}'s record, for {destination}, which ff local doesn't run yet: {record}"
                ));
            } else if self.has(&target) && self.runs_as(&target) {
                self.send(target.name, record, &request_id(), target.qualifier);
            } else {
                (self.say)(&format!(
                    "{name}: the asynchronous call {id}'s record was not delivered: its destination {destination} is no function here"
                ));
            }
        }
        if let Some(queue) = settings.dead_letter.as_ref().filter(|_| end != End::Succeeded) {
            (self.say)(&format!(
                "{name}: the asynchronous call {id}'s event, for its dead-letter queue {queue}, which ff local doesn't run yet: {}",
                call.request_payload
            ));
        }
    }

    /// GetFunctionConfiguration, as the backend answers it for `$LATEST`: the function as it runs here, its code's size
    /// and SHA-256 as its package would have them unbuilt, the template's variables, never a secret.
    fn configuration(&self, function_name: &str, query: &str) -> Result<Response, Response> {
        let qualifier = qualifier_in(query);
        let named = named(function_name, qualifier.as_deref());
        let function = self.instances.function(named.name);
        let (Some(function), true) = (function, self.has(&named) && self.runs_as(&named)) else {
            return Err(self.missing(&named));
        };
        let (code_size, code_sha256) = code_of(&function.code).map_err(|error| {
            (self.say)(&format!("{}: {}", function.name, error.message));
            refusal(500, "ServiceException", SERVICE_EXCEPTION)
        })?;
        let settings = self.settings.get(&function.name).cloned().unwrap_or_default();
        let revision = sha256_hex(format!("{}\n{code_sha256}", function.name).as_bytes());
        let mut document = json!({
            "FunctionName": function.name,
            "FunctionArn": self.arn(&function.name),
            "Runtime": function.runtime.lambda(),
            "Handler": function.handler,
            "CodeSize": code_size,
            "Description": settings.description,
            "Timeout": function.timeout,
            "MemorySize": function.memory,
            "CodeSha256": code_sha256,
            "TracingConfig": { "Mode": "PassThrough" },
            "PackageType": "Zip",
            "Architectures": ["x86_64"],
            "EphemeralStorage": { "Size": 512 },
            "SnapStart": { "ApplyOn": "None", "OptimizationStatus": "Off" },
            "LoggingConfig": { "LogFormat": "Text", "LogGroup": format!("/aws/lambda/{}", function.name) },
            "LastModified": lambda_time(self.started),
            "Version": "$LATEST",
            // A revision for each code, as Lambda gives one for each change.
            "RevisionId": format!(
                "{}-{}-{}-{}-{}",
                &revision[..8],
                &revision[8..12],
                &revision[12..16],
                &revision[16..20],
                &revision[20..32]
            ),
            "State": "Active",
            "LastUpdateStatus": "Successful",
        });
        if !settings.variables.is_empty() {
            document["Environment"] = json!({ "Variables": settings.variables });
        }
        if let Some(queue) = &settings.dead_letter {
            document["DeadLetterConfig"] = json!({ "TargetArn": queue });
        }
        Ok(Response {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: document.to_string().into_bytes(),
        })
    }
}

impl<R: Runner> Answers for FrontDoor<R> {
    fn answer(&self, request: &Request, request_id: &str, _source_ip: &str) -> Response {
        let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
        if let Err(refused) = self.signed(request, path, query) {
            return refused;
        }
        let segments: Vec<&str> = path.split('/').collect();
        let answer = match (request.method.as_str(), segments.as_slice()) {
            ("POST", ["", "2015-03-31", "functions", function, "invocations"]) => {
                self.invoke(request, &percent_decode(function), query, request_id)
            }
            ("GET", ["", "2015-03-31", "functions", function, "configuration"]) => {
                self.configuration(&percent_decode(function), query)
            }
            (method, _) => Err(refusal(
                400,
                "UnknownOperationException",
                &format!(
                    "ff local doesn't offer {method} {path}: its front door answers Lambda's Invoke, POST /2015-03-31/functions/<name>/invocations, and GetFunctionConfiguration, GET /2015-03-31/functions/<name>/configuration"
                ),
            )),
        };
        answer.unwrap_or_else(|refused| refused)
    }

    fn unreadable(&self, too_large: bool) -> Response {
        match too_large {
            true => refusal(
                413,
                "RequestEntityTooLargeException",
                &format!("Request must be smaller than {PAYLOAD_LIMIT} bytes for the InvokeFunction operation"),
            ),
            false => refusal(400, "InvalidRequestContentException", "The request couldn't be read as HTTP."),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::Ordering;

    use serde::Deserialize;

    use super::super::instances::stand::{Stand, function, instances_of};
    use super::super::{Answer, LocalFunction};
    use super::*;
    use crate::sigv4::{Credentials, Signable, amz_date, authorization};

    const REGION: &str = "tn-tunis-1";
    const ACCOUNT: &str = "000000000000";

    struct Door {
        door: FrontDoor<Stand>,
        said: Arc<Mutex<Vec<String>>>,
        stand: Stand,
    }

    fn key() -> Key {
        Key { id: "AKFFLOCALKEY0000TEST".into(), secret: "a-secret".into() }
    }

    /// 2026-10-23T10:00:00Z.
    fn started() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_749_600)
    }

    /// The functions on the stand-in, behind a front door, each with its alias `live` and what `adjust` gives it, an
    /// asynchronous call's second a millisecond.
    fn door_with(functions: Vec<LocalFunction>, adjust: impl Fn(&str, &mut Settings)) -> Door {
        let said = Arc::new(Mutex::new(Vec::new()));
        let settings = functions
            .iter()
            .map(|function| {
                let mut settings = Settings { alias: Some("live".into()), ..Settings::default() };
                adjust(&function.name, &mut settings);
                (function.name.clone(), settings)
            })
            .collect();
        let (instances, stand) = instances_of(functions, &said);
        let say_to = Arc::clone(&said);
        let door = FrontDoor {
            instances: Arc::new(instances),
            region: REGION.into(),
            account: ACCOUNT.into(),
            key: key(),
            settings: Arc::new(settings),
            started: started(),
            second: Duration::from_millis(1),
            say: Arc::new(move |line| say_to.lock().unwrap().push(line.to_owned())),
        };
        Door { door, said, stand }
    }

    fn door_of(functions: Vec<LocalFunction>) -> Door {
        door_with(functions, |_, _| {})
    }

    /// A request's headers as AWS's SDKs sign Lambda's, with `key`, at `amz_date`: its Host and its time signed.
    fn signed(key: &Key, path: &str, body: &[u8], amz_date: &str, service: &str) -> Vec<(String, String)> {
        let mut headers =
            vec![("Host".to_owned(), "127.0.0.1:3700".to_owned()), ("X-Amz-Date".to_owned(), amz_date.to_owned())];
        let credentials =
            Credentials { access_key_id: key.id.clone(), secret_access_key: key.secret.clone(), region: REGION.into() };
        let payload = sha256_hex(body);
        let request = Signable { method: "POST", path, query: &[], headers: &headers, payload_sha256: &payload };
        let signature = authorization(&credentials, &request, amz_date, service);
        headers.push(("Authorization".to_owned(), signature));
        headers
    }

    /// `Orders`, its alias `live`, and `Broken`, whose code doesn't load.
    fn door() -> Door {
        door_of(vec![function("Orders", "app.handler"), function("Broken", "broken.handler")])
    }

    impl Door {
        fn send(&self, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Response {
            let request = Request {
                method: method.into(),
                target: target.into(),
                protocol: "HTTP/1.1".into(),
                headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
                body: body.to_vec(),
            };
            self.door.answer(&request, "a-request", "127.0.0.1")
        }

        fn invoke(&self, function: &str, headers: &[(&str, &str)], body: &str) -> Response {
            self.send("POST", &format!("/2015-03-31/functions/{function}/invocations"), headers, body.as_bytes())
        }

        fn said(&self) -> Vec<String> {
            self.said.lock().unwrap().clone()
        }

        /// What was said of asynchronous calls.
        fn said_of_events(&self) -> Vec<String> {
            self.said().into_iter().filter(|line| line.contains("the asynchronous call")).collect()
        }

        /// Waits up to 2 s for what happens apart.
        fn until(&self, done: impl Fn(&Door) -> bool) -> bool {
            let started = Instant::now();
            while !done(self) && started.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(10));
            }
            done(self)
        }
    }

    fn header<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
        response.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn body_of(response: &Response) -> Value {
        serde_json::from_slice(&response.body).unwrap_or(Value::Null)
    }

    /// A refusal's status, its error's name, and its message.
    fn refused(response: &Response) -> (u16, String, String) {
        let error_type = header(response, "x-amzn-ErrorType").unwrap_or_default().to_owned();
        (response.status, error_type, body_of(response)["message"].as_str().unwrap_or_default().to_owned())
    }

    #[test]
    fn a_call_is_waited_for_and_answered_as_lambda_answers_it() {
        let door = door();

        let called = door.invoke("Orders", &[], r#"{"order":7}"#);
        let empty = door.invoke("Orders", &[("X-Amz-Invocation-Type", "RequestResponse")], "");

        assert_eq!((called.status, body_of(&called)), (200, json!({ "order": 7 })));
        assert_eq!(header(&called, "x-amz-executed-version"), Some("$LATEST"));
        assert_eq!(header(&called, "x-amz-function-error"), None);
        assert_eq!((empty.status, body_of(&empty)), (200, json!({})));
        assert_eq!(door.stand.starts.load(Ordering::SeqCst), 1, "the second call reuses the first one's instance");
    }

    #[test]
    fn a_function_is_named_as_lambda_names_it() {
        let door = door();
        let names = [
            "Orders",
            "Orders:live",
            "Orders:%24LATEST",
            "000000000000:function:Orders",
            "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders:live",
            "arn%3Aaws%3Alambda%3Atn-tunis-1%3A000000000000%3Afunction%3AOrders",
        ];

        for name in names {
            assert_eq!(door.invoke(name, &[], "{}").status, 200, "{name}");
        }
        let by_query = door.send("POST", "/2015-03-31/functions/Orders/invocations?Qualifier=live", &[], b"{}");
        assert_eq!(by_query.status, 200);

        let missing = |name: &str| refused(&door.invoke(name, &[], "{}"));
        let arn = "arn:aws:lambda:tn-tunis-1:000000000000:function";
        let not_found =
            |arn: String| (404, "ResourceNotFoundException".to_owned(), format!("Function not found: {arn}"));
        assert_eq!(missing("Orders:old"), not_found(format!("{arn}:Orders:old")));
        assert_eq!(missing("Payments"), not_found(format!("{arn}:Payments")));
        assert_eq!(
            missing("arn:aws:lambda:tn-tunis-1:111111111111:function:Orders"),
            not_found("arn:aws:lambda:tn-tunis-1:111111111111:function:Orders".into()),
            "another account's function is one this machine hasn't"
        );
        assert_eq!(missing("arn:aws:lambda:eu-west-1:000000000000:function:Orders").0, 404);
        let old = door.send("POST", "/2015-03-31/functions/Orders/invocations?Qualifier=old", &[], b"{}");
        assert_eq!(refused(&old), not_found(format!("{arn}:Orders:old")));
        assert_eq!(body_of(&old)["Type"], "User");
    }

    #[test]
    fn a_functions_error_is_answered_200_with_its_document() {
        let door = door();

        let thrown = door.invoke("Orders", &[], r#"{"throw":true}"#);
        let broken = door.invoke("Broken", &[], "{}");

        assert_eq!(thrown.status, 200);
        assert_eq!(header(&thrown, "x-amz-function-error"), Some("Unhandled"));
        assert_eq!(body_of(&thrown), json!({ "errorType": "Error", "errorMessage": "thrown" }));
        assert_eq!(broken.status, 200);
        assert_eq!(header(&broken, "x-amz-function-error"), Some("Unhandled"));
        assert_eq!(body_of(&broken)["errorType"], "Runtime.UserCodeSyntaxError");
    }

    #[test]
    fn a_dry_run_starts_nothing_and_an_event_runs_apart() {
        let door = door();

        let dry_run = door.invoke("Orders", &[("X-Amz-Invocation-Type", "DryRun")], "{}");
        assert_eq!((dry_run.status, door.stand.starts.load(Ordering::SeqCst)), (204, 0));

        let event = door.invoke("Orders", &[("X-Amz-Invocation-Type", "Event")], r#"{"throw":true}"#);
        assert_eq!((event.status, event.body.as_slice()), (202, &b""[..]));
        let failure = "Orders: the asynchronous call a-request failed: Error: thrown; tried again in 60 s";
        assert!(door.until(|door| door.said().iter().any(|line| line == failure)), "said: {failure}");
        assert_eq!(door.stand.starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_event_is_retried_as_ff_retries_it_and_its_record_sent_where_its_function_says() {
        let failures = "arn:aws:lambda:tn-tunis-1:000000000000:function:Failures";
        let (done, dead) = ("arn:aws:sqs:tn-tunis-1:000000000000:Done", "arn:aws:sqs:tn-tunis-1:000000000000:Dead");
        let functions = vec![function("Orders", "app.handler"), function("Failures", "app.handler")];
        let door = door_with(functions, |name, settings| {
            if name == "Orders" {
                settings.on_failure = Some(failures.into());
                settings.on_success = Some(done.into());
                settings.dead_letter = Some(dead.into());
            }
        });

        door.invoke("Orders", &[("X-Amz-Invocation-Type", "Event")], r#"{"throw":true}"#);

        let dead_letter = format!(
            "Orders: the asynchronous call a-request's event, for its dead-letter queue {dead}, which ff local doesn't run yet: {{\"throw\":true}}"
        );
        assert!(door.until(|door| door.said().contains(&dead_letter)), "said: {:?}", door.said());
        let failed = "Orders: the asynchronous call a-request failed: Error: thrown";
        assert_eq!(
            door.said_of_events(),
            [
                format!("{failed}; tried again in 60 s"),
                format!("{failed}; tried again in 120 s"),
                format!("{failed}; dropped after 3 attempts: its retries are used"),
                dead_letter,
            ]
        );
        assert!(door.until(|door| door.stand.received.lock().unwrap().len() == 4), "three attempts, then the record");
        let record = door.stand.received.lock().unwrap()[3].0.clone();
        assert_eq!(
            record["requestContext"],
            json!({
                "requestId": "a-request",
                "functionArn": "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders:$LATEST",
                "condition": "RetriesExhausted",
                "approximateInvokeCount": 3
            })
        );
        assert_eq!(record["requestPayload"], json!({ "throw": true }));
        assert_eq!(
            [&record["responseContext"], &record["responsePayload"]],
            [
                &json!({ "statusCode": 200, "executedVersion": "$LATEST", "functionError": "Unhandled" }),
                &json!({ "errorType": "Error", "errorMessage": "thrown" })
            ]
        );

        door.said.lock().unwrap().clear();
        door.invoke("Orders:live", &[("X-Amz-Invocation-Type", "Event")], r#"{"order":7}"#);
        let to_queue =
            format!("Orders: the asynchronous call a-request's record, for {done}, which ff local doesn't run yet: ");
        assert!(
            door.until(|door| door.said_of_events().iter().any(|line| line.starts_with(&to_queue))),
            "{:?}",
            door.said()
        );
        let record: Value = serde_json::from_str(&door.said_of_events()[0][to_queue.len()..]).unwrap();
        assert_eq!(record["requestContext"]["condition"], "Success");
        assert_eq!(
            record["requestContext"]["functionArn"],
            "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders:live"
        );
        assert_eq!(record["responsePayload"], json!({ "order": 7 }));
        assert_eq!(door.said_of_events().len(), 1, "no dead letter for a call that succeeded");
    }

    #[test]
    fn a_signed_request_is_checked_against_the_local_key_and_an_unsigned_one_taken() {
        let door = door();
        let path = "/2015-03-31/functions/Orders/invocations";
        let now = amz_date(SystemTime::now());
        let call = |headers: &[(String, String)], body: &str| {
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
            door.send("POST", path, &headers, body.as_bytes())
        };
        let good = signed(&key(), path, b"{}", &now, "lambda");

        assert_eq!(call(&good, "{}").status, 200);
        assert_eq!(call(&[], "{}").status, 200, "unsigned, as curl sends it");

        let mismatch = |message: &str| (403, "InvalidSignatureException".to_owned(), message.to_owned());
        assert_eq!(refused(&call(&good, r#"{"changed":true}"#)), mismatch(SIGNATURE_MISMATCH));
        let someone = Key { id: "AKFFSOMEONEELSE00000".into(), secret: "a-secret".into() };
        let invalid = (
            403,
            "UnrecognizedClientException".to_owned(),
            "The security token included in the request is invalid.".to_owned(),
        );
        assert_eq!(refused(&call(&signed(&someone, path, b"{}", &now, "lambda"), "{}")), invalid);
        assert!(door.said().contains(&"A request signed with AKFFSOMEONEELSE00000, not the local key AKFFLOCALKEY0000TEST: .ff/local/credentials holds it".to_owned()));
        let mut with_token = good.clone();
        with_token.push(("X-Amz-Security-Token".into(), "a-token".into()));
        assert_eq!(refused(&call(&with_token, "{}")), invalid);
        assert_eq!(
            refused(&call(&signed(&key(), path, b"{}", "20200101T000000Z", "lambda"), "{}")),
            mismatch("Signature expired: 20200101T000000Z is more than 15 minutes from the request's arrival.")
        );
        assert_eq!(
            refused(&call(&signed(&key(), path, b"{}", &now, "s3"), "{}")),
            mismatch("Credential should be scoped to correct service: 'lambda'.")
        );
        let basic = [("Authorization".to_owned(), "Basic dXNlcjpwYXNz".to_owned())];
        assert_eq!(
            refused(&call(&basic, "{}")),
            (
                400,
                "IncompleteSignatureException".to_owned(),
                "The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256."
                    .to_owned()
            )
        );
        assert_eq!(door.stand.received.lock().unwrap().len(), 2, "nothing refused ran");
    }

    #[test]
    fn a_functions_configuration_is_answered_as_the_backend_answers_it_for_latest() {
        let code = tempfile::tempdir().unwrap();
        std::fs::write(code.path().join("app.js"), "exports.handler = async (event) => event;\n").unwrap();
        let mut orders = function("Orders", "app.handler");
        orders.code = Code::Folder(code.path().to_path_buf());
        let queue = "arn:aws:sqs:tn-tunis-1:000000000000:Dead";
        let door = door_with(vec![orders], |_, settings| {
            settings.description = "Takes orders".into();
            settings.variables = BTreeMap::from([("TABLE".to_owned(), "orders".to_owned())]);
            settings.dead_letter = Some(queue.into());
        });
        let (size, sha256) = crate::package::unbuilt_code(code.path()).unwrap();
        let configuration = |target: &str| door.send("GET", &format!("/2015-03-31/functions/{target}"), &[], b"");

        let answer = configuration("Orders/configuration");

        assert_eq!(answer.status, 200);
        let document = body_of(&answer);
        let revision = document["RevisionId"].as_str().unwrap().to_owned();
        assert_eq!(
            document,
            json!({
                "FunctionName": "Orders",
                "FunctionArn": "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders",
                "Runtime": "nodejs24.x",
                "Handler": "app.handler",
                "CodeSize": size,
                "Description": "Takes orders",
                "Timeout": 3,
                "MemorySize": 128,
                "CodeSha256": sha256,
                "Environment": { "Variables": { "TABLE": "orders" } },
                "DeadLetterConfig": { "TargetArn": queue },
                "TracingConfig": { "Mode": "PassThrough" },
                "PackageType": "Zip",
                "Architectures": ["x86_64"],
                "EphemeralStorage": { "Size": 512 },
                "SnapStart": { "ApplyOn": "None", "OptimizationStatus": "Off" },
                "LoggingConfig": { "LogFormat": "Text", "LogGroup": "/aws/lambda/Orders" },
                "LastModified": "2026-10-23T10:00:00.000+0000",
                "Version": "$LATEST",
                "RevisionId": revision,
                "State": "Active",
                "LastUpdateStatus": "Successful"
            })
        );
        assert_eq!(revision.len(), 36);
        assert_eq!(body_of(&configuration("Orders/configuration?Qualifier=live")), document);
        assert_eq!(
            body_of(&configuration("arn%3Aaws%3Alambda%3Atn-tunis-1%3A000000000000%3Afunction%3AOrders/configuration")),
            document
        );
        assert_eq!(refused(&configuration("Orders/configuration?Qualifier=old")).0, 404);
        assert_eq!(refused(&configuration("Payments/configuration")).1, "ResourceNotFoundException");

        std::fs::write(code.path().join("app.js"), "exports.handler = async () => 'changed';\n").unwrap();
        let changed = body_of(&configuration("Orders/configuration"));
        assert_ne!(
            (&changed["CodeSha256"], &changed["RevisionId"]),
            (&document["CodeSha256"], &document["RevisionId"])
        );
        assert_eq!(door.stand.starts.load(Ordering::SeqCst), 0, "a configuration starts nothing");
    }

    #[test]
    fn what_the_front_door_doesnt_offer_is_refused_in_lambdas_words() {
        let door = door();

        let listed = door.send("GET", "/2015-03-31/functions", &[], b"");

        assert_eq!((refused(&listed).0, refused(&listed).1.as_str()), (400, "UnknownOperationException"));
        assert_eq!(refused(&door.door.unreadable(true)).0, 413);
        assert_eq!(door.stand.starts.load(Ordering::SeqCst), 0, "nothing refused started its function");
    }

    /// A case of the backend's table of `Invoke`, `BE/src/lambda/lambda-invoke-examples.json`.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Example {
        title: String,
        #[serde(default)]
        versions: bool,
        request: ExampleRequest,
        ran: Option<Ran>,
        answer: Option<ExampleAnswer>,
        refused: Option<ExampleRefusal>,
        payload: Option<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExampleRequest {
        qualifier: Option<String>,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        body: Option<String>,
        payload_bytes: Option<usize>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Ran {
        output: Option<String>,
        error: Option<RanError>,
        log_result: Option<String>,
    }

    #[derive(Deserialize)]
    struct RanError {
        kind: Option<String>,
        #[serde(rename = "type")]
        error_type: Option<String>,
        message: String,
    }

    #[derive(Deserialize)]
    struct ExampleAnswer {
        status: u16,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        body: Option<String>,
        document: Option<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExampleRefusal {
        status: u16,
        #[serde(rename = "type")]
        error_type: String,
        message: Option<String>,
        message_starts: Option<String>,
        reason: Option<String>,
    }

    /// What the runtime answers for what a case's call did, as the backend reads a runtime's answer: its error document,
    /// a function's own with `x-ff-function-error`, a timeout by its type, a full queue by its 429; the platform's
    /// failure no answer at all.
    fn runtime_answer(ran: &Ran) -> Result<Answer, Error> {
        let answer = |status: u16, function_error: bool, body: String| {
            Ok(Answer {
                status,
                request_id: None,
                duration_ms: None,
                memory_mb: None,
                function_error,
                body,
                log_result: ran.log_result.clone(),
            })
        };
        let Some(error) = &ran.error else {
            return answer(
                200,
                false,
                ran.output.clone().expect("a case says what its call answered, or how it failed"),
            );
        };
        let document = |error_type: &str| json!({ "errorType": error_type, "errorMessage": error.message }).to_string();
        match error.kind.as_deref() {
            Some("timeout") => answer(500, false, document("Sandbox.Timedout")),
            Some("throttled") => answer(429, false, document("TooManyRequestsException")),
            Some("platform") => Err(Error::new(Kind::Failed, error.message.clone())),
            _ => answer(500, true, document(error.error_type.as_deref().unwrap_or("Error"))),
        }
    }

    #[test]
    fn invoke_answers_the_backends_cases_as_the_backend_does() {
        let table: BTreeMap<String, Value> =
            serde_json::from_str(include_str!("../../../BE/src/lambda/lambda-invoke-examples.json")).unwrap();
        let mut checked = 0;
        for (group, cases) in table.iter().filter(|(key, _)| *key != "about") {
            for case in serde_json::from_value::<Vec<Example>>(cases.clone()).unwrap() {
                // A published version is FF's alone: here a function runs as its code is.
                if case.versions {
                    continue;
                }
                let title = format!("{group}: {}", case.title);
                let door = door_of(vec![function("orders", "app.handler")]);
                if let Some(ran) = &case.ran {
                    door.stand.script.lock().unwrap().push_back(runtime_answer(ran));
                }
                let request = &case.request;
                let query =
                    request.qualifier.as_ref().map(|qualifier| format!("?Qualifier={qualifier}")).unwrap_or_default();
                let body = match request.payload_bytes {
                    Some(bytes) => format!("\"{}\"", "a".repeat(bytes - 2)),
                    None => request.body.clone().unwrap_or_default(),
                };
                let headers: Vec<(&str, &str)> =
                    request.headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
                let target = format!("/2015-03-31/functions/orders/invocations{query}");

                let response = door.send("POST", &target, &headers, body.as_bytes());

                let invocation_type =
                    request.headers.get("X-Amz-Invocation-Type").map_or("RequestResponse", String::as_str);
                let received = door.stand.received.lock().unwrap().clone();
                if let Some(answer) = &case.answer {
                    assert_eq!(response.status, answer.status, "{title}");
                    for (name, value) in &answer.headers {
                        assert_eq!(header(&response, name), Some(value.as_str()), "{title}: {name}");
                    }
                    if let Some(sent) = &answer.body {
                        assert_eq!(String::from_utf8_lossy(&response.body), sent.as_str(), "{title}");
                    }
                    if let Some(document) = &answer.document {
                        assert_eq!(&body_of(&response), document, "{title}");
                    }
                }
                if let Some(expected) = &case.refused {
                    let (status, error_type, message) = refused(&response);
                    assert_eq!(
                        (status, error_type.as_str()),
                        (expected.status, expected.error_type.as_str()),
                        "{title}"
                    );
                    match (&expected.message, &expected.message_starts) {
                        (Some(words), _) => {
                            assert_eq!(
                                message,
                                words.replace("{region}", REGION).replace("{account}", ACCOUNT),
                                "{title}"
                            )
                        }
                        (None, Some(start)) => assert!(message.starts_with(start.as_str()), "{title}: {message}"),
                        (None, None) => panic!("{title}: a refusal says its message"),
                    }
                    assert_eq!(body_of(&response)["Reason"].as_str(), expected.reason.as_deref(), "{title}");
                    if case.ran.is_none() {
                        assert!(received.is_empty(), "{title}: nothing ran");
                    }
                }
                if invocation_type == "DryRun" {
                    assert!(received.is_empty(), "{title}: nothing ran");
                }
                if invocation_type == "RequestResponse" && case.answer.is_some() {
                    let header = |name: &str| request.headers.get(name).cloned();
                    let asked = Asks {
                        log_tail: header("X-Amz-Log-Type").as_deref() == Some("Tail"),
                        client_context: header("X-Amz-Client-Context"),
                    };
                    assert_eq!(received.iter().map(|(_, asks)| asks.clone()).collect::<Vec<_>>(), [asked], "{title}");
                    if let Some(payload) = &case.payload {
                        assert_eq!(&received[0].0, payload, "{title}");
                    }
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 28, "every case of the table but the one that names a version");
    }
}
