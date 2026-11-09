//! The local front door (ADR 0017): one port on this machine that answers as FF's front doors answer, in the protocols
//! AWS's SDKs speak, the backend's words in its refusals. A request signed with Signature Version 4 is checked against
//! the local key, as FF checks one against its keys; an unsigned one is taken, for `curl`, where FF refuses it.
//! Lambda's `Invoke` (`BE/src/lambda/lambda-invoke.ts`), its checks in the backend's order: a call waited for, its
//! answer as the runtime sent it, a function's error as Lambda's document with `X-Amz-Function-Error: Unhandled`, the
//! call's log with `X-Amz-Log-Type: Tail`, the caller's ClientContext passed on; an `Event`, answered 202 and run apart
//! as FF runs one, retried, its record sent to its destination; a `DryRun`, checked only. Its cases are
//! `BE/src/lambda/lambda-invoke-examples.json`'s, which the backend's tests read too. And `GetFunctionConfiguration`,
//! as the backend answers it for `$LATEST`. Each function's URL is at `http://<function>.fn.localhost:<port>`, served
//! as FF's gateway serves one (`BE/src/function-urls/function-url.gateway.ts`), its CORS applied, and one that takes
//! the account's credentials refused without the local key's signature. A function's schedules run as asynchronous
//! calls, on time ([`super::schedules`]) or now, when `ff local run` asks. SQS's JSON protocol, at `/` or by its
//! `X-Amz-Target`, is answered by the template's queues ([`super::sqs`]), its signature checked as Lambda's is; an
//! asynchronous call's record and its dead letter go to them as FF sends both. S3 is answered by the template's
//! buckets ([`super::s3`]): a request at a bucket's host, signed for S3, or unsigned and naming one of them, or the
//! service, by its path; its body read as it streams. A write's events go where its bucket's notifications send them,
//! as FF delivers them: to a function, an asynchronous call; to a queue, a message from the bucket. And a bucket that
//! is a site answers a browser at `http://<bucket>.site.localhost:<port>` ([`super::s3::site`]).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{GeneralPurpose, NO_PAD_INDIFFERENT, STANDARD};
use serde_json::{Value, json};

use super::events::{self, Attempts, End, Outcome, RetryPolicy, Settlement};
use super::http::{Answers, Incoming, PAYLOAD_LIMIT, Reply, Request, Response, percent_decode, request_id};
use super::instances::{Called, Instances, Runner};
use super::key::Key;
use super::mappings::LocalMapping;
use super::s3::events::BucketEvent;
use super::s3::requests::{Style, address_of, signed_service};
use super::s3::{Buckets, OWN_HOSTS, site};
use super::schedule_expression::Millis;
use super::schedules::{self, LocalSchedule};
use super::sqs::{self, Outgoing, Queues};
use super::url::{self, Caller, Cors, Ran, UrlRequest};
use super::{Asks, Code};
use crate::dates::iso;
use crate::error::{Error, Kind};
use crate::sigv4::{Problem, SignedRequest, Words, check_authorization, read_authorization, sha256_hex, words};

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
/// Lambda's words for a signature that isn't the key's, and its URLs'.
const SIGNATURE_MISMATCH: &str = "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.";
const URL_SIGNATURE_MISMATCH: &str = "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.";
/// Lambda's words for a key it doesn't know.
const INVALID_TOKEN: &str = "The security token included in the request is invalid.";
/// The domain each function's URL is under, its name the first label: `<function>.fn.localhost`.
pub const URL_DOMAIN: &str = "fn.localhost";

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
    refusal(403, "UnrecognizedClientException", INVALID_TOKEN)
}

/// A signature's problem in Lambda's words.
fn signature_refusal(problem: Problem) -> Response {
    match words(problem, SERVICE) {
        Words::Token => unrecognized_client(),
        Words::Incomplete(message) => refusal(400, "IncompleteSignatureException", &message),
        Words::Mismatch(message) => {
            refusal(403, "InvalidSignatureException", message.as_deref().unwrap_or(SIGNATURE_MISMATCH))
        }
    }
}

/// A 403 of a function's URL that says why, as the gateway says it.
fn forbidden(message: &str) -> Response {
    url::message(403, &format!("Forbidden: {message}"))
}

/// A signature's problem in the words of a function's URL: each a 403, as the gateway says them.
fn url_signature_refusal(problem: Problem) -> Response {
    match words(problem, SERVICE) {
        Words::Token => forbidden(INVALID_TOKEN),
        Words::Incomplete(message) => forbidden(&message),
        Words::Mismatch(message) => forbidden(message.as_deref().unwrap_or(URL_SIGNATURE_MISMATCH)),
    }
}

/// Now, in seconds since 1970, as a signature's time is checked against.
fn now_seconds() -> i64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
    i64::try_from(now).unwrap_or(i64::MAX)
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

/// A function's URL, as its FunctionUrlConfig asks: whether it takes the account's credentials, and its CORS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FunctionUrl {
    /// AuthType AWS_IAM: a request signed with the local key, as FF takes one signed by an access key of the account.
    pub iam: bool,
    pub cors: Option<Cors>,
}

/// What the front door knows of a function besides how it runs: what Lambda's operations answer of it, how its
/// asynchronous calls end, and its URL.
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
    pub url: Option<FunctionUrl>,
    pub schedules: Vec<LocalSchedule>,
    /// The queues it reads, its SQS events.
    pub mappings: Vec<LocalMapping>,
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
    /// How far the schedules' clock is ahead of this machine's: none, but in the `ff` suite's builds.
    pub clock_offset: Millis,
    /// The template's queues.
    pub queues: Arc<Queues>,
    /// The template's buckets.
    pub buckets: Arc<Buckets>,
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
            clock_offset: self.clock_offset,
            queues: Arc::clone(&self.queues),
            buckets: Arc::clone(&self.buckets),
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
            self.not_the_local_key(&signature.access_key_id);
            return Err(unrecognized_client());
        }
        let signed =
            SignedRequest { method: &request.method, raw_path: path, raw_query: query, headers: &request.headers };
        check_authorization(&signed, &request.body, &signature, &self.key.secret, now_seconds(), SERVICE)
            .map_err(signature_refusal)
    }

    /// Says that a request was signed with a key that isn't the local one, which no caller learns.
    fn not_the_local_key(&self, key_id: &str) {
        (self.say)(&format!(
            "A request signed with {key_id}, not the local key {}: .ff/local/credentials holds it",
            self.key.id
        ));
    }

    /// The function whose URL a request's host names, `<function>.fn.localhost` in any case, with its URL; None for a
    /// host under that domain that names none; and nothing for any other host.
    fn url_of(&self, request: &Request) -> Option<Option<(&String, &FunctionUrl)>> {
        let host = url::host_name(request.header("host"))?;
        let label = host.strip_suffix(URL_DOMAIN)?.strip_suffix('.')?;
        Some(self.settings.iter().find_map(|(name, settings)| {
            let function_url = settings.url.as_ref()?;
            name.eq_ignore_ascii_case(label).then_some((name, function_url))
        }))
    }

    /// A request to a function's URL, answered as FF's gateway answers it: 404 for a host that names no URL; a
    /// browser's preflight answered by its CORS, without a call; one that takes the account's credentials refused
    /// without the local key's signature; the function called with the URL's event, its return value the response;
    /// and the CORS's headers on every answer, a refusal's too.
    fn url(
        &self,
        found: Option<(&String, &FunctionUrl)>,
        request: &Request,
        request_id: &str,
        source_ip: &str,
    ) -> Response {
        let Some((name, function_url)) = found else { return url::message(404, "Not Found") };
        let origin = request.header("origin");
        let cors = function_url.cors.as_ref();
        if let Some(cors) = cors
            && url::is_preflight(request)
        {
            return Response { status: 204, headers: cors.preflight_headers(origin), body: Vec::new() };
        }
        let answer =
            self.url_call(name, function_url, request, request_id, source_ip).unwrap_or_else(|refused| refused);
        match cors {
            Some(cors) => cors.applied(answer, origin),
            None => answer,
        }
    }

    /// The URL's call of its function, as the gateway makes it; a refusal when it can't be made.
    fn url_call(
        &self,
        name: &str,
        function_url: &FunctionUrl,
        request: &Request,
        request_id: &str,
        source_ip: &str,
    ) -> Result<Response, Response> {
        let caller = if function_url.iam { Some(self.url_caller(request)?) } else { None };
        let domain_name = url::host_name(request.header("host")).unwrap_or_default();
        let url_id = domain_name.split('.').next().unwrap_or_default();
        let event = url::sized(url::event(&UrlRequest {
            request,
            source_ip,
            domain_name: &domain_name,
            domain_prefix: url_id,
            url_id,
            request_id,
            time: SystemTime::now(),
            account_id: if caller.is_some() { &self.account } else { "anonymous" },
            caller: caller.as_ref(),
            // The signature that let the caller in is never the function's to see.
            without_headers: if caller.is_some() { &["authorization"] } else { &[] },
        }))?;
        let ran = match self.instances.call(name, &event, request_id, &Asks::default()) {
            Some(Ok(Called::Answered(answer))) if answer.status == 200 => {
                Ran::Output(serde_json::from_str(&answer.body).unwrap_or(Value::Null))
            }
            Some(Ok(Called::Answered(answer))) if answer.status == 429 => Ran::Throttled,
            // The function's own error, which its log has.
            Some(Ok(_)) => Ran::Failed,
            Some(Err(error)) => {
                (self.say)(&format!("{name}: {}", error.message));
                Ran::Failed
            }
            None => return Err(url::message(404, "Not Found")),
        };
        Ok(url::response_of(ran, &|line| (self.say)(&format!("{name}: {line}"))))
    }

    /// The caller of a URL that takes the account's credentials, as the gateway checks one: a request signed for
    /// lambda, here with the local key, the account's one key. ff local has no API keys, which FF takes too.
    fn url_caller(&self, request: &Request) -> Result<Caller, Response> {
        let authorization = request.header("authorization").unwrap_or_default().trim();
        if authorization.starts_with("AWS4-HMAC-SHA256 ") {
            let signature = read_authorization(&request.headers, SERVICE)
                .map_err(url_signature_refusal)?
                .ok_or_else(|| forbidden(INVALID_TOKEN))?;
            if signature.access_key_id != self.key.id {
                self.not_the_local_key(&signature.access_key_id);
                return Err(forbidden(INVALID_TOKEN));
            }
            let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
            let signed =
                SignedRequest { method: &request.method, raw_path: path, raw_query: query, headers: &request.headers };
            check_authorization(&signed, &request.body, &signature, &self.key.secret, now_seconds(), SERVICE)
                .map_err(url_signature_refusal)?;
            return Ok(Caller {
                access_key: self.key.id.clone(),
                account_id: self.account.clone(),
                user_id: self.key.id.clone(),
            });
        }
        let bearer = authorization.split_once(char::is_whitespace);
        if bearer
            .is_some_and(|(scheme, key)| scheme.eq_ignore_ascii_case("bearer") && key.trim_start().starts_with("ffk_"))
        {
            (self.say)(
                "A request to a URL with an API key, which ff local hasn't: sign it with the local key, as AWS's tools do",
            );
            return Err(url::message(403, "Forbidden"));
        }
        Err(forbidden(
            "this URL takes a request signed for lambda by an access key of its account, or an API key of it, as \"Authorization: Bearer ffk_…\"",
        ))
    }

    /// A run of a function's schedule due at `due_at`, as FF's scheduler makes one: an asynchronous call of the
    /// function, or of its alias, with EventBridge's Scheduled Event or the schedule's input; the call's request ID.
    pub fn run_schedule(&self, function: &str, name: &str, due_at: Millis) -> Option<String> {
        let settings = self.settings.get(function)?;
        let schedule = settings.schedules.iter().find(|schedule| schedule.name == name)?;
        let request_id = request_id();
        let rule = schedules::rule_name(function, name);
        let event = schedule
            .input
            .clone()
            .unwrap_or_else(|| schedules::scheduled_event(&request_id, &self.account, due_at, &self.region, &rule));
        (self.say)(&format!(
            "{function}: its schedule {name} runs, due at {}: the asynchronous call {request_id}",
            iso(due_at)
        ));
        self.send(function, event, &request_id, settings.alias.as_deref());
        Some(request_id)
    }

    /// `ff local run`'s request: a schedule, named alone or after its function, run now; 202 with the call's request
    /// ID, as an `Event` is answered.
    fn run_now(&self, function: Option<&str>, name: &str) -> Result<Response, Response> {
        let having: Vec<&String> = self
            .settings
            .iter()
            .filter(|(each, settings)| {
                function.is_none_or(|function| function == each.as_str())
                    && settings.schedules.iter().any(|schedule| schedule.name == name)
            })
            .map(|(each, _)| each)
            .collect();
        let missing = match function {
            Some(function) => format!("{function} has no schedule {name}"),
            None => format!("No function has a schedule {name}"),
        };
        let function = match having.as_slice() {
            [function] => *function,
            [] => {
                let all: Vec<String> = self
                    .settings
                    .iter()
                    .flat_map(|(each, settings)| {
                        settings.schedules.iter().map(move |schedule| format!("{each}/{}", schedule.name))
                    })
                    .collect();
                let known = if all.is_empty() {
                    "the template has none".to_owned()
                } else {
                    format!("the template's are {}", all.join(", "))
                };
                return Err(refusal(404, "ResourceNotFoundException", &format!("{missing}: {known}")));
            }
            several => {
                let names: Vec<&str> = several.iter().map(|each| each.as_str()).collect();
                return Err(refusal(
                    400,
                    "InvalidParameterValueException",
                    &format!(
                        "{} have a schedule {name}: name it after its function, as {}/{name}",
                        names.join(" and "),
                        names[0]
                    ),
                ));
            }
        };
        let now = schedules::now_ms(self.clock_offset);
        let request_id = self.run_schedule(function, name, now).ok_or_else(|| self.missing(&named(function, None)))?;
        let body = json!({ "function": function, "schedule": name, "requestId": request_id });
        Ok(Response {
            status: 202,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
        })
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
    pub(super) fn attempt(&self, name: &str, event: &Value, request_id: &str) -> Option<(Outcome, events::Response)> {
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
    /// function's dead-letter queue, as FF sends both: a function's an asynchronous call, a queue's a message from the
    /// function; one that can't be sent said.
    fn hand_over(&self, call: &events::Call, end: End, response: &events::Response, settings: &Settings) {
        let (name, id) = (call.function_arn.rsplit(':').next().unwrap_or_default(), call.request_id);
        let destination = if end == End::Succeeded { &settings.on_success } else { &settings.on_failure };
        if let Some(destination) = destination {
            let record = events::invocation_record(call, end, Some(response), SystemTime::now());
            let target = named(destination, None);
            if destination.starts_with("arn:aws:sqs:") {
                let message = Outgoing {
                    body: record.to_string(),
                    attributes: sqs::Attributes::new(),
                    trace_header: None,
                    sender_id: call.function_arn.to_owned(),
                    delay_seconds: None,
                };
                if let Err(why) = self.queues.send_as_ff(destination, message) {
                    (self.say)(&format!(
                        "{name}: the asynchronous call {id}'s record was not delivered to its destination {destination}: {why}"
                    ));
                }
            } else if self.has(&target) && self.runs_as(&target) {
                self.send(target.name, record, &request_id(), target.qualifier);
            } else {
                (self.say)(&format!(
                    "{name}: the asynchronous call {id}'s record was not delivered: its destination {destination} is no function here"
                ));
            }
        }
        if let Some(queue) = settings.dead_letter.as_ref().filter(|_| end != End::Succeeded) {
            let message = Outgoing {
                body: call.request_payload.to_string(),
                attributes: events::dead_letter_attributes(id, response),
                trace_header: None,
                sender_id: call.function_arn.to_owned(),
                delay_seconds: None,
            };
            if let Err(why) = self.queues.send_as_ff(queue, message) {
                (self.say)(&format!(
                    "{name}: the asynchronous call {id}'s event was not sent to its dead-letter queue {queue}: {why}"
                ));
            }
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

impl<R: Runner> FrontDoor<R> {
    /// Whether a request is SQS's, not a function URL's, nor S3's.
    fn is_sqs(&self, head: &Request) -> bool {
        self.url_of(head).is_none() && !self.is_s3(head) && sqs::is_sqs(head)
    }

    /// Whether a request is a site's, at a host under the sites' host.
    fn is_site(&self, head: &Request) -> bool {
        site::is_site(head.header("host"))
    }

    /// Whether a request is S3's: signed for S3; or unsigned, at a bucket's host, or naming one of the template's
    /// buckets by its path, or the service itself. Never a function URL's, nor a site's, nor one of SQS's JSON
    /// protocol.
    fn is_s3(&self, head: &Request) -> bool {
        if self.url_of(head).is_some() || self.is_site(head) || head.header("x-amz-target").is_some() {
            return false;
        }
        let (path, query) = head.target.split_once('?').unwrap_or((head.target.as_str(), ""));
        if let Some(service) = signed_service(head.header("authorization"), query) {
            return service == "s3";
        }
        let address = address_of(head.header("host"), path, &OWN_HOSTS);
        address.style == Style::VirtualHosted
            || self.buckets.has(&address.bucket)
            || (head.method == "GET" && path == "/")
    }

    /// A bucket's events, delivered as FF delivers them: to a function, S3's event as an asynchronous call of what the
    /// rule's ARN names, its alias, else `$LATEST`; to a queue, a message from the bucket. One that can't go is said and
    /// dropped, as S3 drops what it can't deliver.
    pub fn deliver(&self, events: Vec<BucketEvent>) {
        for event in events {
            let (arn, body) = (event.destination(), event.body());
            let dropped = |why: &str| {
                (self.say)(&format!("An event of bucket {} was not delivered to {arn}: {why}", event.bucket()))
            };
            if event.to_queue() {
                let message = Outgoing {
                    body: body.to_string(),
                    attributes: sqs::Attributes::new(),
                    trace_header: None,
                    sender_id: format!("arn:aws:s3:::{}", event.bucket()),
                    delay_seconds: None,
                };
                if let Err(why) = self.queues.send_as_ff(arn, message) {
                    dropped(&why);
                }
                continue;
            }
            let target = named(arn, None);
            let size = body.to_string().len();
            if !self.has(&target) {
                dropped("it is no function here");
            } else if !self.runs_as(&target) {
                dropped(&format!("the function has no {} here", target.qualifier.unwrap_or_default()));
            } else if size > ASYNC_PAYLOAD_LIMIT {
                dropped(&format!("the event is {size} bytes, over an asynchronous call's {ASYNC_PAYLOAD_LIMIT}"));
            } else {
                self.send(target.name, body, &request_id(), target.qualifier);
            }
        }
    }

    /// A request in SQS's JSON protocol, answered by the queues, their URLs under the address it reached: this
    /// machine's, or the one the functions reach it at.
    fn sqs(&self, request: &Request) -> Response {
        let endpoint = format!("http://{}", request.header("host").unwrap_or("127.0.0.1"));
        self.queues.answer(request, &self.key, &endpoint, |key_id| self.not_the_local_key(key_id))
    }
}

impl<R: Runner> Answers for FrontDoor<R> {
    fn answer(&self, request: &Request, request_id: &str, source_ip: &str) -> Response {
        if let Some(found) = self.url_of(request) {
            return self.url(found, request, request_id, source_ip);
        }
        if sqs::is_sqs(request) {
            return self.sqs(request);
        }
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
            ("POST", ["", "ff-local", "schedules", name]) => self.run_now(None, &percent_decode(name)),
            ("POST", ["", "ff-local", "schedules", function, name]) => {
                self.run_now(Some(&percent_decode(function)), &percent_decode(name))
            }
            (method, _) => Err(refusal(
                400,
                "UnknownOperationException",
                &format!(
                    "ff local doesn't offer {method} {path}: its front door answers Lambda's Invoke, POST /2015-03-31/functions/<name>/invocations, GetFunctionConfiguration, GET /2015-03-31/functions/<name>/configuration, SQS's JSON protocol, POST / with X-Amz-Target AmazonSQS.<operation>, and ff local run's POST /ff-local/schedules/[<function>/]<schedule>"
                ),
            )),
        };
        answer.unwrap_or_else(|refused| refused)
    }

    fn unreadable(&self, too_large: bool, head: Option<&Request>) -> Response {
        // A function's URL refuses it in its words, its CORS with them.
        if let Some(found) = head.and_then(|head| self.url_of(head)) {
            let Some((_, function_url)) = found else { return url::message(404, "Not Found") };
            let refused = if too_large { url::too_large() } else { url::message(400, "Bad Request") };
            return match &function_url.cors {
                Some(cors) => cors.applied(refused, head.and_then(|head| head.header("origin"))),
                None => refused,
            };
        }
        if head.is_some_and(|head| self.is_site(head)) {
            return self.buckets.site_unreadable(&request_id());
        }
        if head.is_some_and(|head| self.is_s3(head)) {
            return self.buckets.unreadable(&request_id());
        }
        if head.is_some_and(sqs::is_sqs) {
            return sqs::unreadable(too_large);
        }
        match too_large {
            true => refusal(
                413,
                "RequestEntityTooLargeException",
                &format!("Request must be smaller than {PAYLOAD_LIMIT} bytes for the InvokeFunction operation"),
            ),
            false => refusal(400, "InvalidRequestContentException", "The request couldn't be read as HTTP."),
        }
    }

    fn limit(&self, head: &Request) -> usize {
        if self.is_sqs(head) { sqs::MAX_BODY_BYTES } else { PAYLOAD_LIMIT }
    }

    fn streams(&self, head: &Request) -> bool {
        self.is_site(head) || self.is_s3(head)
    }

    fn answer_streaming(&self, head: &Request, body: &mut Incoming, request_id: &str, source_ip: &str) -> Reply {
        if self.is_site(head) {
            return self.buckets.site(head, request_id);
        }
        if !self.is_s3(head) {
            return Reply::Whole(self.answer(head, request_id, source_ip));
        }
        let (reply, events) =
            self.buckets.answer(head, body, &self.key, request_id, source_ip, |key_id| self.not_the_local_key(key_id));
        self.deliver(events);
        reply
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::Mutex;
    use std::sync::atomic::Ordering;

    use serde::Deserialize;

    use super::super::instances::stand::{Stand, function, instances_of};
    use super::super::s3::LocalBucket;
    use super::super::s3::events::{Rule, Target};
    use super::super::s3::site::Website;
    use super::super::sqs::QueueSettings;
    use super::super::{Answer, LocalFunction};
    use super::*;
    use crate::sigv4::{Credentials, Signable, amz_date, authorization};

    const REGION: &str = "tn-tunis-1";
    const ACCOUNT: &str = "000000000000";

    struct Door {
        door: FrontDoor<Stand>,
        said: Arc<Mutex<Vec<String>>>,
        stand: Stand,
        /// The buckets' folder, removed with the door.
        _buckets: tempfile::TempDir,
    }

    fn key() -> Key {
        Key { id: "AKFFLOCALKEY0000TEST".into(), secret: "a-secret".into() }
    }

    /// 2026-10-23T10:00:00Z.
    fn started() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_749_600)
    }

    /// The functions on the stand-in, behind a front door, each with its alias `live` and what `adjust` gives it, an
    /// asynchronous call's second a millisecond; the queues `orders`, `Done` and `Dead`; and the bucket `photos`.
    fn door_with(functions: Vec<LocalFunction>, adjust: impl Fn(&str, &mut Settings)) -> Door {
        door_with_buckets(functions, adjust, vec![LocalBucket::named("photos")])
    }

    /// The same, with those buckets.
    fn door_with_buckets(
        functions: Vec<LocalFunction>,
        adjust: impl Fn(&str, &mut Settings),
        buckets: Vec<LocalBucket>,
    ) -> Door {
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
        let say: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line| say_to.lock().unwrap().push(line.to_owned()));
        let folder = tempfile::tempdir().unwrap();
        let buckets =
            Buckets::open(folder.path(), buckets, REGION, ACCOUNT, Arc::new(|| schedules::now_ms(0)), Arc::clone(&say))
                .unwrap();
        let door = FrontDoor {
            instances: Arc::new(instances),
            region: REGION.into(),
            account: ACCOUNT.into(),
            key: key(),
            settings: Arc::new(settings),
            started: started(),
            second: Duration::from_millis(1),
            say,
            clock_offset: 0,
            queues: Arc::new(Queues::new(
                REGION,
                ACCOUNT,
                ["orders", "Done", "Dead"].map(|name| (name.to_owned(), QueueSettings::default())),
                Arc::new(|| schedules::now_ms(0)),
            )),
            buckets: Arc::new(buckets),
        };
        Door { door, said, stand, _buckets: folder }
    }

    fn door_of(functions: Vec<LocalFunction>) -> Door {
        door_with(functions, |_, _| {})
    }

    /// A request's headers as AWS's SDKs sign Lambda's, with `key`, at `amz_date`: its Host and its time signed.
    fn signed(key: &Key, path: &str, body: &[u8], amz_date: &str, service: &str) -> Vec<(String, String)> {
        signed_to("127.0.0.1:3700", "POST", key, path, body, amz_date, service)
    }

    /// The same, to a host, by a method.
    fn signed_to(
        host: &str,
        method: &str,
        key: &Key,
        path: &str,
        body: &[u8],
        amz_date: &str,
        service: &str,
    ) -> Vec<(String, String)> {
        let mut headers = vec![("Host".to_owned(), host.to_owned()), ("X-Amz-Date".to_owned(), amz_date.to_owned())];
        let credentials =
            Credentials { access_key_id: key.id.clone(), secret_access_key: key.secret.clone(), region: REGION.into() };
        let payload = sha256_hex(body);
        let request = Signable { method, path, query: &[], headers: &headers, payload_sha256: &payload };
        let signature = authorization(&credentials, &request, amz_date, service);
        headers.push(("Authorization".to_owned(), signature));
        headers
    }

    fn as_refs(headers: &[(String, String)]) -> Vec<(&str, &str)> {
        headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect()
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

        /// The messages a queue holds, received with all their attributes and left visible.
        fn received_from(&self, queue: &str) -> Value {
            let input = json!({
                "QueueUrl": format!("http://127.0.0.1:3700/{ACCOUNT}/{queue}"),
                "MaxNumberOfMessages": 10,
                "VisibilityTimeout": 0,
                "AttributeNames": ["All"],
                "MessageAttributeNames": ["All"],
            });
            let caller = sqs::Caller { key_id: &self.door.key.id, endpoint: "http://127.0.0.1:3700" };
            self.door.queues.run("ReceiveMessage", &input, &caller).unwrap()["Messages"].clone()
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

        let failed = "Orders: the asynchronous call a-request failed: Error: thrown";
        let dropped = format!("{failed}; dropped after 3 attempts: its retries are used");
        assert!(door.until(|door| door.said().contains(&dropped)), "said: {:?}", door.said());
        assert!(door.until(|door| door.received_from("Dead").is_array()), "the event in its dead-letter queue");
        let dead_letters = door.received_from("Dead");
        assert_eq!(
            door.said_of_events(),
            [format!("{failed}; tried again in 60 s"), format!("{failed}; tried again in 120 s"), dropped]
        );
        assert_eq!(dead_letters.as_array().unwrap().len(), 1);
        assert_eq!(dead_letters[0]["Body"], r#"{"throw":true}"#);
        assert_eq!(dead_letters[0]["Attributes"]["SenderId"], "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders");
        assert_eq!(
            dead_letters[0]["MessageAttributes"],
            json!({
                "ErrorCode": { "DataType": "Number", "StringValue": "200" },
                "ErrorMessage": { "DataType": "String", "StringValue": "thrown" },
                "RequestID": { "DataType": "String", "StringValue": "a-request" },
            })
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
        assert!(door.until(|door| door.received_from("Done").is_array()), "the record in its destination");
        let records = door.received_from("Done");
        assert_eq!(records[0]["Attributes"]["SenderId"], "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders");
        let record: Value = serde_json::from_str(records[0]["Body"].as_str().unwrap()).unwrap();
        assert_eq!(record["requestContext"]["condition"], "Success");
        assert_eq!(
            record["requestContext"]["functionArn"],
            "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders:live"
        );
        assert_eq!(record["responsePayload"], json!({ "order": 7 }));
        assert_eq!(door.said_of_events(), Vec::<String>::new(), "nothing said of a call that succeeded");
        assert_eq!(
            door.received_from("Dead").as_array().map(Vec::len),
            Some(1),
            "no dead letter for a call that succeeded"
        );
    }

    #[test]
    fn a_record_or_a_dead_letter_that_cant_be_sent_to_its_queue_is_said() {
        let gone = "arn:aws:sqs:tn-tunis-1:000000000000:Gone";
        let door = door_with(vec![function("Orders", "app.handler")], |_, settings| {
            settings.on_failure = Some(gone.into());
            settings.dead_letter = Some(gone.into());
            settings.retries.maximum_retry_attempts = 0;
        });

        door.invoke("Orders", &[("X-Amz-Invocation-Type", "Event")], r#"{"throw":true}"#);

        let not_sent = format!(
            "Orders: the asynchronous call a-request's event was not sent to its dead-letter queue {gone}: {gone} is no queue here"
        );
        assert!(door.until(|door| door.said().contains(&not_sent)), "said: {:?}", door.said());
        assert!(door.said().contains(&format!(
            "Orders: the asynchronous call a-request's record was not delivered to its destination {gone}: {gone} is no queue here"
        )));
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
        assert_eq!(refused(&door.door.unreadable(true, None)).0, 413);
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

    /// `orders`, its URL as `function_url` says.
    fn door_with_url(function_url: FunctionUrl) -> Door {
        door_with(vec![function("orders", "app.handler")], move |_, settings| settings.url = Some(function_url.clone()))
    }

    /// What the runtime answers: a status, whether the function failed, the body.
    fn runtime(status: u16, function_error: bool, body: String) -> Answer {
        Answer { status, request_id: None, duration_ms: None, memory_mb: None, function_error, body, log_result: None }
    }

    /// A response as the server sends it for the request's method: its status, its headers by lower-case name, its
    /// body.
    fn as_sent(response: &Response, method: &str) -> (u16, BTreeMap<String, String>, Vec<u8>) {
        let mut sent = Vec::new();
        super::super::http::write_response(&mut sent, response, "a-request", method == "HEAD").unwrap();
        let end = sent.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&sent[..end]).into_owned();
        let headers = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(": "))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
            .collect();
        (response.status, headers, sent[end + 4..].to_vec())
    }

    /// A function URL's Message.
    fn message_of(response: &Response) -> (u16, String) {
        (response.status, body_of(response)["Message"].as_str().unwrap_or_default().to_owned())
    }

    #[test]
    fn a_url_answers_the_gateways_cases_as_the_gateway_does() {
        let table = url::tests::table();
        let mut checked = 0;
        for (group, cases) in table["gateway"].as_object().unwrap() {
            for case in cases.as_array().unwrap() {
                let title = format!("{group}: {}", case["title"]);
                let cors = case.get("cors").map(|cors| serde_json::from_value::<Cors>(cors.clone()).unwrap());
                let door = door_with_url(FunctionUrl { iam: false, cors });
                let ran = &case["ran"];
                let scripted = match (ran.get("output"), ran.get("error")) {
                    (Some(output), _) => runtime(200, false, output.to_string()),
                    (None, Some(error)) if error["kind"] == "throttled" => {
                        let document =
                            json!({ "errorType": "TooManyRequestsException", "errorMessage": error["message"] });
                        runtime(429, false, document.to_string())
                    }
                    (None, Some(error)) => runtime(
                        500,
                        true,
                        json!({ "errorType": error["type"], "errorMessage": error["message"] }).to_string(),
                    ),
                    (None, None) => runtime(200, false, json!({ "statusCode": 200, "body": "ok" }).to_string()),
                };
                door.stand.script.lock().unwrap().push_back(Ok(scripted));
                let request = &case["request"];
                let method = request["method"].as_str().unwrap();
                let mut headers = vec![("Host".to_owned(), "orders.fn.localhost:3700".to_owned())];
                headers.extend(
                    request["headers"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned())),
                );
                let body = request["body"].as_str().unwrap_or_default();

                let response =
                    door.send(method, request["path"].as_str().unwrap(), &as_refs(&headers), body.as_bytes());

                let (status, sent, body) = as_sent(&response, method);
                let expected = &case["answer"];
                assert_eq!(u64::from(status), expected["status"].as_u64().unwrap(), "{title}");
                for (name, value) in expected.get("headers").and_then(Value::as_object).into_iter().flatten() {
                    assert_eq!(sent.get(name).map(String::as_str), value.as_str(), "{title}: {name}");
                }
                for prefix in expected.get("noHeadersStartingWith").and_then(Value::as_array).into_iter().flatten() {
                    let prefix = prefix.as_str().unwrap();
                    assert!(!sent.keys().any(|name| name.starts_with(prefix)), "{title}: {sent:?}");
                }
                if let Some(text) = expected.get("body").and_then(Value::as_str) {
                    assert_eq!(String::from_utf8_lossy(&body), text, "{title}");
                }
                let received = door.stand.received.lock().unwrap().clone();
                match case.get("called") {
                    Some(Value::Bool(false)) => assert!(received.is_empty(), "{title}: nothing called"),
                    Some(called) => {
                        for (path, value) in called["has"].as_object().unwrap() {
                            assert_eq!(url::tests::at(&received[0].0, path), Some(value), "{title}: {path}");
                        }
                    }
                    None => {}
                }
                if let Some(says) = case.get("says").and_then(Value::as_str) {
                    assert!(door.said().iter().any(|line| line.contains(says)), "{title}: {:?}", door.said());
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 10, "every case of the gateway's");
    }

    #[test]
    fn a_url_is_its_functions_name_under_fn_localhost_in_any_case() {
        let door =
            door_with(vec![function("Orders", "app.handler"), function("Plain", "app.handler")], |name, settings| {
                if name == "Orders" {
                    settings.url = Some(FunctionUrl::default());
                }
            });
        let get = |host: &str, target: &str| door.send("GET", target, &[("Host", host)], b"");

        // The stand-in answers with the event it got, which a value without statusCode answers as its JSON.
        let answered = get("ORDERS.fn.localhost:3700", "/items?id=7");
        let event = body_of(&answered);
        assert_eq!(answered.status, 200);
        assert_eq!(
            [&event["rawPath"], &event["requestContext"]["domainName"], &event["requestContext"]["apiId"]],
            ["/items", "orders.fn.localhost", "orders"]
        );
        assert_eq!(
            [&event["requestContext"]["accountId"], &event["requestContext"]["http"]["sourceIp"]],
            ["anonymous", "127.0.0.1"]
        );
        // A function without a URL, or none at all, is the gateway's 404; another host, Lambda's API, and SQS's at /.
        for host in ["plain.fn.localhost:3700", "nothing.fn.localhost", "a.orders.fn.localhost"] {
            assert_eq!(message_of(&get(host, "/")), (404, "Not Found".to_owned()), "{host}");
        }
        assert_eq!(refused(&get("fn.localhost", "/items")).1, "UnknownOperationException");
        assert_eq!(refused(&get("127.0.0.1:3700", "/items")).1, "UnknownOperationException");
        assert_eq!(body_of(&get("127.0.0.1:3700", "/"))["__type"], "com.amazonaws.sqs#UnsupportedOperation");
        assert_eq!(door.stand.received.lock().unwrap().len(), 1, "only the URL's function was called");
    }

    #[test]
    fn a_url_that_takes_the_accounts_credentials_takes_a_request_signed_with_the_local_key() {
        let door = door_with_url(FunctionUrl { iam: true, cors: None });
        let host = "orders.fn.localhost:3700";
        let now = amz_date(SystemTime::now());
        let send = |headers: &[(String, String)], body: &[u8]| door.send("POST", "/pay", &as_refs(headers), body);

        let called = send(&signed_to(host, "POST", &key(), "/pay", b"{}", &now, "lambda"), b"{}");
        let event = body_of(&called);
        assert_eq!(called.status, 200);
        assert_eq!(event["requestContext"]["accountId"], ACCOUNT);
        assert_eq!(
            event["requestContext"]["authorizer"]["iam"],
            json!({ "accessKey": key().id, "accountId": ACCOUNT, "callerId": key().id, "cognitoIdentity": null, "principalOrgId": null, "userArn": null, "userId": key().id })
        );
        assert!(event["headers"].get("authorization").is_none(), "the signature is never the function's");

        let another = Key { id: "AKFFNOTTHELOCALKEY00".into(), secret: "other".into() };
        let refusals = [
            (
                send(&[("Host".to_owned(), host.to_owned())], b""),
                "Forbidden: this URL takes a request signed for lambda by an access key of its account, or an API key of it, as \"Authorization: Bearer ffk_…\"",
            ),
            (
                send(&signed_to(host, "POST", &another, "/pay", b"{}", &now, "lambda"), b"{}"),
                "Forbidden: The security token included in the request is invalid.",
            ),
            (
                send(&signed_to(host, "POST", &key(), "/pay", b"{}", &now, "lambda"), b"{\"changed\": 1}"),
                "Forbidden: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
            ),
            (
                send(&signed_to(host, "POST", &key(), "/pay", b"{}", &now, "s3"), b"{}"),
                "Forbidden: Credential should be scoped to correct service: 'lambda'.",
            ),
            (
                send(
                    &[("Host".to_owned(), host.to_owned()), ("Authorization".to_owned(), "Bearer ffk_abc".to_owned())],
                    b"",
                ),
                "Forbidden",
            ),
        ];
        for (response, message) in refusals {
            assert_eq!(message_of(&response), (403, message.to_owned()));
        }
        assert_eq!(door.stand.received.lock().unwrap().len(), 1, "nothing refused was called");
        let said = door.said();
        assert!(said.iter().any(|line| line.contains("AKFFNOTTHELOCALKEY00, not the local key")), "{said:?}");
        assert!(said.iter().any(|line| line.contains("an API key, which ff local hasn't")), "{said:?}");
    }

    #[test]
    fn a_request_too_large_for_a_url_is_refused_in_its_words_with_its_cors() {
        let cors = Cors { allow_origins: Some(vec!["https://app.example.tn".into()]), ..Cors::default() };
        let door = door_with_url(FunctionUrl { iam: false, cors: Some(cors) });
        let head = |host: &str, target: &str| Request {
            method: "POST".into(),
            target: target.into(),
            protocol: "HTTP/1.1".into(),
            headers: vec![("Host".into(), host.into()), ("Origin".into(), "https://app.example.tn".into())],
            body: Vec::new(),
        };
        let unreadable = |host: &str, target: &str| door.door.unreadable(true, Some(&head(host, target)));
        let invoke = "/2015-03-31/functions/orders/invocations";

        let refused_here = unreadable("orders.fn.localhost:3700", "/");
        assert_eq!(message_of(&refused_here), (413, "Request Entity Too Large".to_owned()));
        assert_eq!(header(&refused_here, "access-control-allow-origin"), Some("https://app.example.tn"));
        assert_eq!(door.door.limit(&head("orders.fn.localhost:3700", "/")), PAYLOAD_LIMIT, "a URL's, not SQS's");
        assert_eq!(message_of(&unreadable("none.fn.localhost", "/")).0, 404);
        assert_eq!(refused(&unreadable("127.0.0.1:3700", invoke)).1, "RequestEntityTooLargeException");
        assert_eq!(door.door.limit(&head("127.0.0.1:3700", invoke)), PAYLOAD_LIMIT);
        assert_eq!(refused(&door.door.unreadable(false, None)).1, "InvalidRequestContentException");
    }

    /// A request on the wire to SQS's endpoint, as the table writes one.
    fn sqs_request(request: &Value, headers: Vec<(String, String)>) -> Request {
        let given = request["headers"].as_object().into_iter().flatten();
        let mut headers = headers;
        headers.extend(given.map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned())));
        Request {
            method: request["method"].as_str().unwrap().into(),
            target: "/".into(),
            protocol: "HTTP/1.1".into(),
            headers,
            body: request["body"].as_str().unwrap_or_default().as_bytes().to_vec(),
        }
    }

    /// Each case of the table's requests on the wire: an operation signed with the local key, another key, or the
    /// key with another secret, refused with SQS's two names for it; or a request as it is sent, and its answer, its
    /// headers as the server sends them; a body too large refused before it is read. A request without a signature,
    /// which FF refuses, is taken here, as the local key's.
    #[test]
    fn sqs_on_the_wire_answers_the_backends_cases_as_its_front_door_does() {
        let door = door();
        let table = sqs::tests::table();
        let mut checked = 0;
        for (group, cases) in table["frontDoor"].as_object().unwrap() {
            for case in cases.as_array().unwrap() {
                let title = format!("{group}: {}", case["title"].as_str().unwrap());
                let local = key();
                let signer = match case["key"].as_str() {
                    None => local.clone(),
                    Some("another") => Key { id: "AKFFZZZZZZZZZZZZZZZZ".into(), ..local.clone() },
                    Some("anotherSecret") => Key { secret: "b".repeat(40), ..local.clone() },
                    Some(other) => panic!("{title}: no key {other}"),
                };
                let (request, wanted) = match case.get("operation") {
                    Some(operation) => {
                        let body = sqs::tests::filled(&case["input"], sqs::tests::ENDPOINT, &local.id).to_string();
                        let now = amz_date(SystemTime::now());
                        let headers = signed_to("127.0.0.1:3700", "POST", &signer, "/", body.as_bytes(), &now, "sqs");
                        let wire = json!({
                            "method": "POST",
                            "headers": {
                                "content-type": "application/x-amz-json-1.0",
                                "x-amz-target": format!("AmazonSQS.{}", operation.as_str().unwrap()),
                            },
                            "body": body,
                        });
                        (sqs_request(&wire, headers), case["refused"].clone())
                    }
                    None => (
                        sqs_request(&case["request"], vec![("Host".into(), "127.0.0.1:3700".into())]),
                        case["answer"].clone(),
                    ),
                };
                if group == "unsigned" {
                    let taken = door.door.answer(&request, "a-request", "127.0.0.1");
                    assert_eq!(
                        (taken.status, body_of(&taken)["QueueUrls"].as_array().map(Vec::len)),
                        (200, Some(3)),
                        "{title}"
                    );
                    checked += 1;
                    continue;
                }
                let response = if group == "tooLarge" {
                    assert_eq!(door.door.limit(&request), 3 * 1024 * 1024, "{title}");
                    door.door.unreadable(true, Some(&request))
                } else {
                    door.door.answer(&request, "a-request", "127.0.0.1")
                };

                let (status, headers, body) = as_sent(&response, "POST");
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(
                    (
                        status,
                        body["__type"].clone(),
                        headers.get("x-amzn-query-error").cloned(),
                        body["message"].clone()
                    ),
                    (
                        u16::try_from(wanted["status"].as_u64().unwrap()).unwrap(),
                        json!(format!("com.amazonaws.sqs#{}", wanted["type"].as_str().unwrap())),
                        Some(wanted["queryError"].as_str().unwrap().to_owned()),
                        wanted["message"].clone()
                    ),
                    "{title}"
                );
                for (name, value) in wanted["headers"].as_object().into_iter().flatten() {
                    assert_eq!(headers.get(name).map(String::as_str), value.as_str(), "{title}: {name}");
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 7, "every case of the table");
        let other_key = "A request signed with AKFFZZZZZZZZZZZZZZZZ, not the local key AKFFLOCALKEY0000TEST: .ff/local/credentials holds it";
        assert_eq!(door.said(), [other_key], "the other key said here alone");
        assert_eq!(door.stand.starts.load(Ordering::SeqCst), 0, "SQS starts no function");
    }

    #[test]
    fn sqs_answers_a_signed_request_its_queues_urls_under_the_address_it_reached() {
        let door = door();
        let local = key();
        let send = |host: &str, operation: &str, input: Value| {
            let body = input.to_string();
            let now = amz_date(SystemTime::now());
            let headers = signed_to(host, "POST", &local, "/", body.as_bytes(), &now, "sqs");
            let wire = json!({
                "method": "POST",
                "headers": { "content-type": "application/x-amz-json-1.0", "x-amz-target": format!("AmazonSQS.{operation}") },
                "body": body,
            });
            let response = door.door.answer(&sqs_request(&wire, headers), "a-request", "127.0.0.1");
            (response.status, body_of(&response))
        };

        let from_here = send("127.0.0.1:3700", "GetQueueUrl", json!({ "QueueName": "orders" }));
        let from_a_function = send("host.docker.internal:3700", "GetQueueUrl", json!({ "QueueName": "orders" }));
        let queue_url = format!("http://host.docker.internal:3700/{ACCOUNT}/orders");
        let sent = send("127.0.0.1:3700", "SendMessage", json!({ "QueueUrl": queue_url, "MessageBody": "an order" }));
        let received = send(
            "host.docker.internal:3700",
            "ReceiveMessage",
            json!({ "QueueUrl": queue_url, "AttributeNames": ["SenderId"] }),
        );

        assert_eq!(from_here, (200, json!({ "QueueUrl": format!("http://127.0.0.1:3700/{ACCOUNT}/orders") })));
        assert_eq!(from_a_function, (200, json!({ "QueueUrl": queue_url })));
        assert_eq!(sent.1["MD5OfMessageBody"], crate::md5::hex(b"an order"));
        assert_eq!(received.1["Messages"][0]["MessageId"], sent.1["MessageId"]);
        assert_eq!(received.1["Messages"][0]["Attributes"]["SenderId"], local.id, "sent by the key that signed");
    }

    /// A request's line and headers, to a host.
    fn head_to(method: &str, host: &str, target: &str, headers: &[(&str, &str)]) -> Request {
        let mut sent = vec![("Host".to_owned(), host.to_owned())];
        sent.extend(headers.iter().map(|(name, value)| (name.to_string(), value.to_string())));
        Request {
            method: method.into(),
            target: target.into(),
            protocol: "HTTP/1.1".into(),
            headers: sent,
            body: Vec::new(),
        }
    }

    /// The front door's answer to a request whose body streams, as its server reads it: its status and its body.
    fn streamed(door: &Door, head: &Request, body: &[u8]) -> (u16, String) {
        let (mut reader, mut written) = (body, Vec::new());
        let mut incoming = Incoming::of(head, &mut reader, &mut written).unwrap();
        match door.door.answer_streaming(head, &mut incoming, "a-request", "127.0.0.1") {
            Reply::Whole(response) => (response.status, String::from_utf8(response.body).unwrap()),
            Reply::File { response, file, length } => {
                let mut read = String::new();
                file.unwrap().take(length).read_to_string(&mut read).unwrap();
                (response.status, read)
            }
        }
    }

    #[test]
    fn s3_is_a_request_signed_for_it_at_a_buckets_host_or_naming_one_its_body_streamed_to_the_buckets() {
        let door = door();
        let signed_for = |service: &str| {
            let scope = format!("20261023/{REGION}/{service}/aws4_request");
            format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host, Signature=00", key().id)
        };
        let (s3, sqs, lambda) = (signed_for("s3"), signed_for("sqs"), signed_for("lambda"));
        let is_s3 = |method: &str, host: &str, target: &str, headers: &[(&str, &str)]| {
            door.door.is_s3(&head_to(method, host, target, headers))
        };
        let presigned = "/photos/a.jpg?X-Amz-Credential=AKFF%2F20261023%2Ftn-tunis-1%2Fs3%2Faws4_request";
        let invoke = "/2015-03-31/functions/Orders/invocations";
        let target = ("X-Amz-Target", "AmazonSQS.ListQueues");

        assert!(is_s3("GET", "127.0.0.1:3700", "/", &[("Authorization", &s3)]), "ListBuckets");
        assert!(is_s3("PUT", "127.0.0.1:3700", "/elsewhere/a.jpg", &[("Authorization", &s3)]));
        assert!(is_s3("GET", "127.0.0.1:3700", presigned, &[]));
        assert!(is_s3("GET", "photos.localhost:3700", "/a.jpg", &[]), "at a bucket's host");
        assert!(is_s3("GET", "photos.host.docker.internal:3700", "/a.jpg", &[]), "from a function");
        assert!(is_s3("GET", "127.0.0.1:3700", "/photos/a.jpg", &[]), "unsigned, naming a bucket");
        assert!(is_s3("GET", "127.0.0.1:3700", "/", &[]), "unsigned, the service");
        assert!(!is_s3("POST", "127.0.0.1:3700", "/", &[("Authorization", &sqs), target]));
        assert!(!is_s3("POST", "127.0.0.1:3700", "/", &[target]), "SQS's JSON protocol unsigned");
        assert!(!is_s3("POST", "127.0.0.1:3700", invoke, &[("Authorization", &lambda)]));
        assert!(!is_s3("POST", "127.0.0.1:3700", invoke, &[]), "unsigned, naming no bucket");
        assert!(!is_s3("GET", "orders.fn.localhost:3700", "/photos/a.jpg", &[]), "a function's URL");
        assert!(door.door.streams(&head_to("GET", "127.0.0.1:3700", "/photos/a.jpg", &[])));
        assert!(!door.door.streams(&head_to("POST", "127.0.0.1:3700", invoke, &[])));
        assert_eq!(door.door.limit(&head_to("POST", "127.0.0.1:3700", "/", &[target])), sqs::MAX_BODY_BYTES);

        let put = head_to("PUT", "photos.localhost:3700", "/a.txt", &[("Content-Length", "5")]);
        assert_eq!(streamed(&door, &put, b"hello").0, 200);
        assert_eq!(
            streamed(&door, &head_to("GET", "127.0.0.1:3700", "/photos/a.txt", &[]), b""),
            (200, "hello".into())
        );
        let other = [
            ("X-Amz-Date", "20261023T060000Z"),
            ("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 Credential=AKFFOTHERKEY0000TEST/20261023/tn-tunis-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=00",
            ),
        ];
        let (status, body) = streamed(&door, &head_to("GET", "127.0.0.1:3700", "/photos/a.txt", &other), b"");
        assert_eq!(status, 403);
        assert!(body.contains("<Code>InvalidAccessKeyId</Code>"), "{body}");
        assert_eq!(
            door.said(),
            [
                "A request signed with AKFFOTHERKEY0000TEST, not the local key AKFFLOCALKEY0000TEST: .ff/local/credentials holds it"
            ]
        );
    }

    /// `Orders`, its alias `live`; and `photos`, whose created images go to Orders's alias, whose removals go to the
    /// queue `orders`, and whose other writes go to what isn't here; and `shop`, a site.
    fn door_with_notifications() -> Door {
        let rule = |id: &str, target: Target, arn: &str, event: &str, prefix: &str| Rule {
            id: id.into(),
            target,
            arn: arn.into(),
            events: vec![event.into()],
            prefix: Some(prefix.into()),
            suffix: None,
        };
        let function = |name: &str| format!("arn:aws:lambda:{REGION}:{ACCOUNT}:function:{name}");
        let photos = LocalBucket {
            notifications: vec![
                rule("thumbs", Target::Function, &function("Orders:live"), "s3:ObjectCreated:*", "images/"),
                rule(
                    "removals",
                    Target::Queue,
                    &format!("arn:aws:sqs:{REGION}:{ACCOUNT}:orders"),
                    "s3:ObjectRemoved:*",
                    "",
                ),
                rule("gone", Target::Function, &function("Gone"), "s3:ObjectCreated:*", "gone/"),
                rule("old", Target::Function, &function("Orders:v9"), "s3:ObjectCreated:*", "old/"),
                rule(
                    "nowhere",
                    Target::Queue,
                    &format!("arn:aws:sqs:{REGION}:{ACCOUNT}:nowhere"),
                    "s3:ObjectCreated:*",
                    "q/",
                ),
            ],
            ..LocalBucket::named("photos")
        };
        let website = Website { index_document: "index.html".into(), error_document: None };
        let shop = LocalBucket { website: Some(website), ..LocalBucket::named("shop") };
        door_with_buckets(vec![function_of("Orders")], |_, _| {}, vec![photos, shop])
    }

    fn function_of(name: &str) -> LocalFunction {
        function(name, "app.handler")
    }

    #[test]
    fn a_buckets_events_go_to_a_function_as_an_asynchronous_call_and_to_a_queue_as_a_message_from_the_bucket() {
        let door = door_with_notifications();
        let put = |key: &str, body: &[u8]| {
            let length = body.len().to_string();
            streamed(&door, &head_to("PUT", "photos.localhost:3700", key, &[("Content-Length", &length)]), body).0
        };

        assert_eq!(put("/images/cat.jpg", b"meow"), 200);
        assert!(door.until(|door| !door.stand.received.lock().unwrap().is_empty()), "{:?}", door.said());
        let [record] = events_received(&door)[0]["Records"].as_array().unwrap().clone().try_into().unwrap();
        assert_eq!(
            (&record["eventName"], &record["s3"]["configurationId"], &record["s3"]["object"]["key"]),
            (&json!("ObjectCreated:Put"), &json!("thumbs"), &json!("images%2Fcat.jpg"))
        );
        assert_eq!(record["s3"]["object"]["eTag"], json!(crate::md5::hex(b"meow")));
        assert_eq!(record["requestParameters"]["sourceIPAddress"], json!("127.0.0.1"));
        assert_eq!(record["responseElements"]["x-amz-request-id"], json!("a-request"));

        let deleted = streamed(&door, &head_to("DELETE", "photos.localhost:3700", "/images/cat.jpg", &[]), b"");
        assert_eq!(deleted.0, 204);
        let messages = door.received_from("orders");
        let body: Value = serde_json::from_str(messages[0]["Body"].as_str().unwrap()).unwrap();
        assert_eq!(body["Records"][0]["eventName"], json!("ObjectRemoved:Delete"));
        assert_eq!(messages[0]["Attributes"]["SenderId"], json!("arn:aws:s3:::photos"));

        for key in ["/gone/a.txt", "/old/a.txt", "/q/a.txt"] {
            assert_eq!(put(key, b"x"), 200);
        }
        let dropped: Vec<String> = door.said().into_iter().filter(|line| line.starts_with("An event")).collect();
        assert_eq!(
            dropped,
            [
                format!(
                    "An event of bucket photos was not delivered to arn:aws:lambda:{REGION}:{ACCOUNT}:function:Gone: it is no function here"
                ),
                format!(
                    "An event of bucket photos was not delivered to arn:aws:lambda:{REGION}:{ACCOUNT}:function:Orders:v9: the function has no v9 here"
                ),
                format!(
                    "An event of bucket photos was not delivered to arn:aws:sqs:{REGION}:{ACCOUNT}:nowhere: arn:aws:sqs:{REGION}:{ACCOUNT}:nowhere is no queue here"
                ),
            ]
        );

        door.door.deliver(door.door.buckets.test_events());
        let tested = door.received_from("orders");
        let test: Value = serde_json::from_str(tested[1]["Body"].as_str().unwrap()).unwrap();
        assert_eq!((&test["Event"], &test["Bucket"]), (&json!("s3:TestEvent"), &json!("photos")));
    }

    #[test]
    fn a_site_is_a_request_at_a_host_under_site_localhost_answered_by_its_bucket_never_as_s3() {
        let door = door_with_notifications();
        let page = head_to(
            "PUT",
            "shop.localhost:3700",
            "/index.html",
            &[("Content-Length", "11"), ("Content-Type", "text/html")],
        );
        assert_eq!(streamed(&door, &page, b"<h1>Hi</h1>").0, 200);

        let visit = head_to("GET", "shop.site.localhost:3700", "/", &[]);
        assert!(door.door.streams(&visit) && !door.door.is_s3(&visit));
        assert_eq!(streamed(&door, &visit, b""), (200, "<h1>Hi</h1>".to_owned()));
        let (status, body) = streamed(
            &door,
            &head_to("PUT", "shop.site.localhost:3700", "/index.html", &[("Content-Length", "1")]),
            b"x",
        );
        assert_eq!(status, 405, "never S3's PutObject: {body}");
        let (status, body) = streamed(&door, &head_to("GET", "photos.site.localhost:3700", "/", &[]), b"");
        assert_eq!(status, 404);
        assert!(body.contains("<li>Code: NoSuchWebsiteConfiguration</li>"), "{body}");
        let unreadable = door.door.unreadable(false, Some(&head_to("GET", "shop.site.localhost:3700", "/", &[])));
        assert_eq!(unreadable.status, 400);
        assert!(String::from_utf8(unreadable.body).unwrap().contains("<li>Code: BadRequest</li>"));
    }

    /// `Cleaner`, with a schedule `Nightly`; and `Reporter`, with one too, and `Weekly`, which has its own input.
    fn door_with_schedules() -> Door {
        door_with(vec![function("Cleaner", "app.handler"), function("Reporter", "app.handler")], |name, settings| {
            let schedule = |name: &str, input: Option<Value>| LocalSchedule {
                name: name.into(),
                expression: "cron(0 2 * * ? *)".into(),
                reader: super::super::schedule_expression::Expression::parse("cron(0 2 * * ? *)").unwrap(),
                input,
                enabled: true,
            };
            settings.schedules = match name {
                "Reporter" => vec![schedule("Nightly", None), schedule("Weekly", Some(json!({ "report": "week" })))],
                _ => vec![schedule("Nightly", None)],
            };
        })
    }

    fn millis(text: &str) -> Millis {
        let time = humantime::parse_rfc3339(text).unwrap();
        Millis::try_from(time.duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }

    /// The events the functions got, as each run ended.
    fn events_received(door: &Door) -> Vec<Value> {
        door.stand.received.lock().unwrap().iter().map(|(event, _)| event.clone()).collect()
    }

    #[test]
    fn a_schedules_run_is_an_asynchronous_call_with_eventbridges_scheduled_event_or_its_input() {
        let door = door_with_schedules();
        let due = millis("2026-11-10T02:00:00Z");

        let nightly = door.door.run_schedule("Reporter", "Nightly", due).unwrap();
        door.door.run_schedule("Reporter", "Weekly", due).unwrap();

        assert!(door.until(|door| door.stand.received.lock().unwrap().len() == 2), "{:?}", door.said());
        let events = events_received(&door);
        let scheduled = schedules::scheduled_event(&nightly, ACCOUNT, due, REGION, "Reporter-Nightly");
        assert!(events.contains(&scheduled), "{events:?}");
        assert!(events.contains(&json!({ "report": "week" })), "a schedule's input in place of the event");
        let said = format!(
            "Reporter: its schedule Nightly runs, due at 2026-11-10T02:00:00Z: the asynchronous call {nightly}"
        );
        assert!(door.said().contains(&said), "{:?}", door.said());
        assert_eq!(door.door.run_schedule("Reporter", "Hourly", due), None);
        assert_eq!(door.door.run_schedule("Nobody", "Nightly", due), None);
    }

    #[test]
    fn ff_local_run_runs_a_schedule_named_alone_or_after_its_function_now() {
        let door = door_with_schedules();
        let run = |target: &str| door.send("POST", target, &[], b"");

        let weekly = run("/ff-local/schedules/Weekly");
        assert_eq!(
            (weekly.status, &body_of(&weekly)["function"], &body_of(&weekly)["schedule"]),
            (202, &json!("Reporter"), &json!("Weekly"))
        );
        let cleaner = run("/ff-local/schedules/Cleaner/Nightly");
        assert_eq!(cleaner.status, 202);
        let refusals = [
            (
                run("/ff-local/schedules/Nightly"),
                (
                    400,
                    "InvalidParameterValueException",
                    "Cleaner and Reporter have a schedule Nightly: name it after its function, as Cleaner/Nightly",
                ),
            ),
            (
                run("/ff-local/schedules/Reporter/Hourly"),
                (
                    404,
                    "ResourceNotFoundException",
                    "Reporter has no schedule Hourly: the template's are Cleaner/Nightly, Reporter/Nightly, Reporter/Weekly",
                ),
            ),
            (
                run("/ff-local/schedules/Hourly"),
                (
                    404,
                    "ResourceNotFoundException",
                    "No function has a schedule Hourly: the template's are Cleaner/Nightly, Reporter/Nightly, Reporter/Weekly",
                ),
            ),
        ];
        for (response, (status, error_type, message)) in refusals {
            assert_eq!(refused(&response), (status, error_type.to_owned(), message.to_owned()));
        }

        assert!(door.until(|door| door.stand.received.lock().unwrap().len() == 2), "two runs, and nothing refused ran");
        let request_id = body_of(&cleaner)["requestId"].as_str().unwrap().to_owned();
        let event = events_received(&door).into_iter().find(|event| event["id"] == request_id.as_str()).unwrap();
        let time = millis(event["time"].as_str().unwrap());
        assert!((schedules::now_ms(0) - time).abs() < 5_000, "a run by hand is due now: {event}");
        assert_eq!(event["resources"], json!(["arn:aws:events:tn-tunis-1:000000000000:rule/Cleaner-Nightly"]));
    }
}
