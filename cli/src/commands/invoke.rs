//! `ff invoke <name>`: a call, its answer, and how it went: the request ID that finds its logs,
//! its duration and memory. A function that raised or timed out exits 5. With `--async`, the call
//! is kept and runs without waiting, as AWS Lambda's invocation type Event: its request ID at once;
//! with `--dry-run`, it is only checked.

use std::io::Read;
use std::time::Duration;

use serde_json::{Value, json};

use super::Context;
use crate::api::types::{Invocation, function_named};
use crate::api::{Call, Client};
use crate::cli::{Format, InvokeArgs};
use crate::error::{Error, Kind};

/// The event: inline JSON, `@file`, or `-` for stdin; none sends `{}`, as the API does.
pub fn input_of(data: Option<&str>) -> Result<Option<Value>, Error> {
    let Some(data) = data else { return Ok(None) };
    let (text, from) = match data {
        "-" => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| Error::new(Kind::Usage, format!("Couldn't read the event from stdin: {error}")))?;
            (text, "stdin".to_owned())
        }
        _ => match data.strip_prefix('@') {
            Some(path) => {
                let text = std::fs::read_to_string(path)
                    .map_err(|error| Error::new(Kind::Usage, format!("Couldn't read {path}: {error}")))?;
                (text, path.to_owned())
            }
            None => (data.to_owned(), "--data".to_owned()),
        },
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| Error::new(Kind::Usage, format!("The event in {from} isn't JSON: {error}")))
}

/// A request's body, as given: inline text, `@file`, or `-` for stdin, not necessarily JSON.
pub fn raw_data(data: &str) -> Result<Vec<u8>, Error> {
    match data {
        "-" => {
            let mut bytes = Vec::new();
            std::io::stdin()
                .read_to_end(&mut bytes)
                .map_err(|error| Error::new(Kind::Usage, format!("Couldn't read the body from stdin: {error}")))?;
            Ok(bytes)
        }
        _ => match data.strip_prefix('@') {
            Some(path) => {
                std::fs::read(path).map_err(|error| Error::new(Kind::Usage, format!("Couldn't read {path}: {error}")))
            }
            None => Ok(data.as_bytes().to_vec()),
        },
    }
}

/// How long the answer may take: a wait for a free instance and the call, each up to the
/// function's timeout, as the API waits; a cold start; and a margin.
pub fn timeout_for(function_timeout: u32) -> Duration {
    Duration::from_secs(2 * u64::from(function_timeout) + 90 + 10)
}

/// A refusal that carries the failed call: the function raised or timed out (5), and the call's
/// ID finds its logs.
fn invocation_failed(mut error: Error) -> Error {
    let invocation = error.details.as_ref().and_then(|details| details.get("invocation")).cloned();
    if let Some(invocation) = invocation {
        if matches!(invocation.get("status").and_then(Value::as_str), Some("ERROR" | "TIMEOUT")) {
            error.kind = Kind::InvocationFailed;
        }
        if let Some(id) = invocation.get("id").and_then(Value::as_str) {
            error.request_id = Some(id.to_owned());
        }
    }
    error
}

/// An asynchronous call, or a dry run: the invocation type in the body, which the API takes as it
/// takes Lambda's header. An asynchronous call's answer is its request ID, which each of its
/// attempts keeps.
fn without_waiting(
    client: &Client,
    name: &str,
    function_id: &str,
    mut body: Value,
    args: &InvokeArgs,
    context: &Context,
) -> Result<(), Error> {
    body["invocationType"] = json!(if args.dry_run { "DryRun" } else { "Event" });
    let call = Call::post(format!("/functions/{function_id}/invoke"), body);
    if args.dry_run {
        client.done(&call)?;
        return context.out.result(&json!({ "dryRun": true }), || format!("{name} would take the call: nothing ran"));
    }
    let answer: Value = client.json(&call)?;
    let request_id = answer.get("requestId").and_then(Value::as_str).unwrap_or_default().to_owned();
    if args.raw && context.out.format == Format::Text {
        return context.out.result(&answer, || request_id.clone());
    }
    context.out.result(&answer, || {
        format!("Kept: request {request_id}, run without waiting and retried on failure\nff history {name} shows its attempts")
    })
}

/// `request 7d1e… · 12 ms · 36 MB`
fn summary(invocation: &Invocation) -> String {
    let mut parts = vec![format!("request {}", invocation.id)];
    if let Some(duration) = invocation.duration {
        parts.push(format!("{duration} ms"));
    }
    if let Some(memory) = invocation.memory_used {
        parts.push(format!("{memory} MB"));
    }
    parts.join(" · ")
}

pub fn run(args: InvokeArgs, context: &Context) -> Result<(), Error> {
    if let Some(http) = &args.http {
        return super::url::invoke_http(&args.name, &http[0], &http[1], &args.headers, args.data.as_deref(), context);
    }
    let input = input_of(args.data.as_deref())?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let function = function_named(&client, &args.name)?;
    let body = match input {
        Some(input) => json!({ "input": input }),
        None => json!({}),
    };
    if args.asynchronous || args.dry_run {
        return without_waiting(&client, &args.name, &function.id, body, &args, context);
    }
    let call = Call::post(format!("/functions/{}/invoke", function.id), body).timeout(timeout_for(function.timeout));
    let invocation: Invocation = client.json(&call).map_err(invocation_failed)?;

    if args.raw && context.out.format == Format::Text {
        return context.out.result(&invocation.output, || invocation.output.to_string());
    }
    context.out.result(&invocation, || {
        let output = serde_json::to_string_pretty(&invocation.output).expect("JSON serializes");
        format!("{output}\n{}", summary(&invocation))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_event_is_json_inline_or_from_a_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("event.json");
        std::fs::write(&file, r#"{"name": "Tunis"}"#).unwrap();

        assert_eq!(input_of(None).unwrap(), None);
        assert_eq!(input_of(Some(r#"{"name": "x"}"#)).unwrap(), Some(json!({ "name": "x" })));
        assert_eq!(input_of(Some("42")).unwrap(), Some(json!(42)));
        assert_eq!(input_of(Some(&format!("@{}", file.display()))).unwrap(), Some(json!({ "name": "Tunis" })));
        let refused = input_of(Some("{name: x}")).unwrap_err();
        assert_eq!(refused.exit_code(), 2);
        assert!(refused.message.starts_with("The event in --data isn't JSON: "), "{}", refused.message);
    }

    #[test]
    fn it_waits_for_an_instance_the_call_and_a_cold_start() {
        assert_eq!(timeout_for(5), Duration::from_secs(110));
        assert_eq!(timeout_for(300), Duration::from_secs(700));
    }

    #[test]
    fn a_call_that_raised_or_timed_out_exits_5_with_its_id() {
        let refusal = |status: &str| {
            let mut error = Error::new(Kind::Failed, "Sandbox.Timedout: Task timed out after 5.00 seconds");
            error.request_id = Some("http-request".into());
            error.details = Some(json!({ "invocation": { "id": "inv-1", "status": status } }));
            invocation_failed(error)
        };

        let timeout = refusal("TIMEOUT");
        assert_eq!((timeout.exit_code(), timeout.request_id.as_deref()), (5, Some("inv-1")));
        assert_eq!(refusal("ERROR").exit_code(), 5);
        assert_eq!(invocation_failed(Error::new(Kind::Failed, "Function is not active")).exit_code(), 3);
    }

    #[test]
    fn the_summary_names_the_request_its_duration_and_memory() {
        let invocation: Invocation = serde_json::from_value(json!({
            "id": "7d1e", "status": "COMPLETED", "duration": 12, "memoryUsed": 36, "output": 1, "createdAt": "2026-10-21T09:00:00.000Z"
        }))
        .unwrap();

        assert_eq!(summary(&invocation), "request 7d1e · 12 ms · 36 MB");
    }
}
