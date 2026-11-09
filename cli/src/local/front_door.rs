//! The local front door (ADR 0017): one port on this machine that answers as FF's front doors answer, in the protocols
//! AWS's SDKs speak, the backend's words in its refusals. Lambda's `Invoke` (`BE/src/lambda/lambda-invoke.ts`): a call
//! waited for, its answer as the runtime sent it, a function's error as Lambda's document with
//! `X-Amz-Function-Error: Unhandled`; an `Event`, answered 202 and run apart; a `DryRun`, checked only.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};

use super::http::{Answers, PAYLOAD_LIMIT, Request, Response, percent_decode};
use super::instances::{Called, Instances, Runner};

/// What Lambda takes of an `Event` invocation's payload: 1 MB.
const ASYNC_PAYLOAD_LIMIT: usize = 1024 * 1024;
/// The invocation types, in the order Lambda's refusal names them.
const INVOCATION_TYPES: [&str; 3] = ["RequestResponse", "Event", "DryRun"];
/// What the front door answers of its own failure, as Lambda does.
const SERVICE_EXCEPTION: &str = "The AWS Lambda service encountered an internal error.";

/// An answer of Lambda's REST JSON protocol: a status, the error's name in `x-amzn-ErrorType`, and whose fault it is
/// with its message.
fn refusal(status: u16, error_type: &str, message: &str) -> Response {
    Response {
        status,
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("x-amzn-ErrorType".into(), error_type.into()),
        ],
        body: json!({ "Type": if status < 500 { "User" } else { "Service" }, "message": message })
            .to_string()
            .into_bytes(),
    }
}

/// A function's answer, or its error as Lambda's document, both 200, as Lambda answers them.
fn answered(body: Vec<u8>, function_error: bool) -> Response {
    let mut headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-amz-executed-version".to_owned(), "$LATEST".to_owned()),
    ];
    if function_error {
        headers.push(("x-amz-function-error".into(), "Unhandled".into()));
    }
    Response { status: 200, headers, body }
}

fn error_document(error_type: &str, message: &str) -> Vec<u8> {
    json!({ "errorType": error_type, "errorMessage": message }).to_string().into_bytes()
}

/// What a request's `FunctionName` says: the function's name, and where and which of it, as it says them.
struct Named<'a> {
    region: Option<&'a str>,
    account: Option<&'a str>,
    name: &'a str,
    qualifier: Option<&'a str>,
}

/// The front door to the template's app.
pub struct FrontDoor<R: Runner> {
    pub instances: Arc<Instances<R>>,
    pub region: String,
    pub account: String,
    /// Each function's alias, by its name: a name for the function as it is, here.
    pub aliases: BTreeMap<String, String>,
    /// Says what goes wrong that no caller sees: an `Event`'s failure.
    pub say: Arc<dyn Fn(&str) + Send + Sync>,
}

impl<R: Runner> FrontDoor<R> {
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

    /// The function's name, if this machine has the function, at its `$LATEST` or its alias; else Lambda's 404, the
    /// function named by its ARN.
    fn found<'a>(&self, named: &Named<'a>) -> Result<&'a str, Response> {
        let here = named.region.is_none_or(|region| region == self.region)
            && named.account.is_none_or(|account| account == self.account);
        let known = here
            && self.instances.function(named.name).is_some()
            && named.qualifier.is_none_or(|qualifier| {
                qualifier == "$LATEST" || self.aliases.get(named.name).is_some_and(|alias| alias == qualifier)
            });
        if known { Ok(named.name) } else { Err(self.missing(named)) }
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

    fn invoke(&self, request: &Request, function_name: &str, query: &str, request_id: &str) -> Response {
        let qualifier = query.split('&').find_map(|pair| pair.strip_prefix("Qualifier=")).map(percent_decode);
        let name = match self.found(&Self::named(function_name, qualifier.as_deref())) {
            Ok(name) => name,
            Err(refused) => return refused,
        };
        let invocation_type = request.header("x-amz-invocation-type").unwrap_or("RequestResponse");
        if !INVOCATION_TYPES.contains(&invocation_type) {
            let message = format!("InvocationType must be {}, not {invocation_type}.", INVOCATION_TYPES.join(", "));
            return refusal(400, "InvalidParameterValueException", &message);
        }
        if invocation_type == "Event" && request.body.len() > ASYNC_PAYLOAD_LIMIT {
            let message =
                format!("Request must be smaller than {ASYNC_PAYLOAD_LIMIT} bytes for the InvokeFunction operation");
            return refusal(413, "RequestEntityTooLargeException", &message);
        }
        let event: Value = match request.body.is_empty() {
            true => json!({}),
            false => match serde_json::from_slice(&request.body) {
                Ok(event) => event,
                Err(error) => {
                    let message = format!("Could not parse request body into json: {error}");
                    return refusal(400, "InvalidRequestContentException", &message);
                }
            },
        };
        match invocation_type {
            "DryRun" => Response { status: 204, headers: Vec::new(), body: Vec::new() },
            "Event" => {
                let (instances, say, name, id) =
                    (Arc::clone(&self.instances), Arc::clone(&self.say), name.to_owned(), request_id.to_owned());
                std::thread::spawn(move || {
                    let failed = match instances.call(&name, &event, &id) {
                        Some(Ok(Called::Answered(answer))) => {
                            answer.function_error().map(|(kind, why)| format!("{kind}: {why}"))
                        }
                        Some(Ok(Called::NotLoaded { error_type, message })) => Some(format!("{error_type}: {message}")),
                        Some(Err(error)) => Some(error.message),
                        None => None,
                    };
                    if let Some(why) = failed {
                        say(&format!("{name}: the asynchronous call {id} failed: {why}"));
                    }
                });
                Response { status: 202, headers: Vec::new(), body: Vec::new() }
            }
            _ => self.called(name, &event, request_id),
        }
    }

    /// A call waited for, answered as Lambda answers it.
    fn called(&self, name: &str, event: &Value, request_id: &str) -> Response {
        match self.instances.call(name, event, request_id) {
            Some(Ok(Called::Answered(answer))) => match answer.function_error() {
                Some((error_type, message)) => answered(error_document(&error_type, &message), true),
                None if answer.status == 200 => answered(answer.body.into_bytes(), false),
                None if answer.status == 429 => refusal(429, "TooManyRequestsException", "Rate exceeded"),
                None => {
                    (self.say)(&format!("{name}: its runtime answered {}: {}", answer.status, answer.body.trim()));
                    refusal(500, "ServiceException", SERVICE_EXCEPTION)
                }
            },
            Some(Ok(Called::NotLoaded { error_type, message })) => {
                answered(error_document(&error_type, &message), true)
            }
            Some(Err(error)) => {
                (self.say)(&format!("{name}: {}", error.message));
                refusal(500, "ServiceException", SERVICE_EXCEPTION)
            }
            None => self.missing(&Self::named(name, None)),
        }
    }
}

impl<R: Runner> Answers for FrontDoor<R> {
    fn answer(&self, request: &Request, request_id: &str, _source_ip: &str) -> Response {
        let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
        let segments: Vec<&str> = path.split('/').collect();
        match (request.method.as_str(), segments.as_slice()) {
            ("POST", ["", "2015-03-31", "functions", function, "invocations"]) => {
                self.invoke(request, &percent_decode(function), query, request_id)
            }
            (method, _) => refusal(
                400,
                "UnknownOperationException",
                &format!(
                    "ff local doesn't offer {method} {path}: its front door answers Lambda's Invoke, POST /2015-03-31/functions/<name>/invocations"
                ),
            ),
        }
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::super::instances::stand::{Stand, instances};
    use super::*;

    struct Door {
        door: FrontDoor<Stand>,
        said: Arc<Mutex<Vec<String>>>,
        starts: Arc<AtomicUsize>,
    }

    /// `Orders`, its alias `live`, and `Broken`, whose code doesn't load.
    fn door() -> Door {
        let said = Arc::new(Mutex::new(Vec::new()));
        let (instances, starts, _) = instances(&said);
        let say_to = Arc::clone(&said);
        let door = FrontDoor {
            instances: Arc::new(instances),
            region: "tn-tunis-1".into(),
            account: "000000000000".into(),
            aliases: BTreeMap::from([("Orders".to_owned(), "live".to_owned())]),
            say: Arc::new(move |line| say_to.lock().unwrap().push(line.to_owned())),
        };
        Door { door, said, starts }
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

    fn body(response: &Response) -> Value {
        serde_json::from_slice(&response.body).unwrap_or(Value::Null)
    }

    /// A refusal's status, its error's name, and its message.
    fn refused(response: &Response) -> (u16, String, String) {
        let error_type = header(response, "x-amzn-ErrorType").unwrap_or_default().to_owned();
        (response.status, error_type, body(response)["message"].as_str().unwrap_or_default().to_owned())
    }

    #[test]
    fn a_call_is_waited_for_and_answered_as_lambda_answers_it() {
        let door = door();

        let called = door.invoke("Orders", &[], r#"{"order":7}"#);
        let empty = door.invoke("Orders", &[("X-Amz-Invocation-Type", "RequestResponse")], "");

        assert_eq!((called.status, body(&called)), (200, json!({ "order": 7 })));
        assert_eq!(header(&called, "x-amz-executed-version"), Some("$LATEST"));
        assert_eq!(header(&called, "x-amz-function-error"), None);
        assert_eq!((empty.status, body(&empty)), (200, json!({})));
        assert_eq!(door.starts.load(Ordering::SeqCst), 1, "the second call reuses the first one's instance");
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
        assert_eq!(body(&old)["Type"], "User");
    }

    #[test]
    fn a_functions_error_is_answered_200_with_its_document() {
        let door = door();

        let thrown = door.invoke("Orders", &[], r#"{"throw":true}"#);
        let broken = door.invoke("Broken", &[], "{}");

        assert_eq!(thrown.status, 200);
        assert_eq!(header(&thrown, "x-amz-function-error"), Some("Unhandled"));
        assert_eq!(body(&thrown), json!({ "errorType": "Error", "errorMessage": "thrown" }));
        assert_eq!(broken.status, 200);
        assert_eq!(header(&broken, "x-amz-function-error"), Some("Unhandled"));
        assert_eq!(body(&broken)["errorType"], "Runtime.UserCodeSyntaxError");
    }

    #[test]
    fn a_dry_run_starts_nothing_and_an_event_runs_apart() {
        let door = door();

        let dry_run = door.invoke("Orders", &[("X-Amz-Invocation-Type", "DryRun")], "{}");
        assert_eq!((dry_run.status, door.starts.load(Ordering::SeqCst)), (204, 0));

        let event = door.invoke("Orders", &[("X-Amz-Invocation-Type", "Event")], r#"{"throw":true}"#);
        assert_eq!((event.status, event.body.as_slice()), (202, &b""[..]));
        let failure = "Orders: the asynchronous call a-request failed: Error: thrown";
        assert!(door.until(|door| door.said.lock().unwrap().iter().any(|line| line == failure)), "said: {failure}");
        assert_eq!(door.starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn what_lambda_refuses_is_refused_in_its_words() {
        let door = door();

        let later = door.invoke("Orders", &[("X-Amz-Invocation-Type", "Later")], "{}");
        let unparsed = door.invoke("Orders", &[], "{");
        let large = "x".repeat(ASYNC_PAYLOAD_LIMIT + 1);
        let too_large = door.invoke("Orders", &[("X-Amz-Invocation-Type", "Event")], &format!("\"{large}\""));
        let listed = door.send("GET", "/2015-03-31/functions", &[], b"");

        assert_eq!(
            refused(&later),
            (
                400,
                "InvalidParameterValueException".into(),
                "InvocationType must be RequestResponse, Event, DryRun, not Later.".into()
            )
        );
        let (status, error_type, message) = refused(&unparsed);
        assert_eq!((status, error_type.as_str()), (400, "InvalidRequestContentException"));
        assert!(message.starts_with("Could not parse request body into json: "), "{message}");
        assert_eq!(refused(&too_large).0, 413);
        assert_eq!((refused(&listed).0, refused(&listed).1.as_str()), (400, "UnknownOperationException"));
        assert_eq!(refused(&door.door.unreadable(true)).0, 413);
        assert_eq!(door.starts.load(Ordering::SeqCst), 0, "nothing refused started its function");
    }
}
