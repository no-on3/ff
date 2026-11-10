//! `ff trace <id>`: one request's trail across the account's functions, as a timeline; and the trace's calls, which
//! `ff logs --trace` reads the lines of.

use std::collections::HashSet;
use std::time::SystemTime;

use super::Context;
use crate::api::types::{Trace, TraceCall, Trigger};
use crate::api::{Call, Client};
use crate::error::Error;
use crate::table::{table, time};

/// The timeline's width in characters: the trace's span, from its first call's start to the end of the last to end.
const TIMELINE_WIDTH: usize = 24;

/// The trace an argument names: a trace's ID in AWS X-Ray's format, or a header's `Root` field, in any case, as the
/// API reads either.
pub fn trace_id(text: &str) -> Result<String, Error> {
    let lower = text.trim().to_ascii_lowercase();
    let root = if is_trace_id(&lower) {
        Some(lower)
    } else {
        lower
            .split(';')
            .filter_map(|field| field.split_once('='))
            .find(|(name, _)| name.trim() == "root")
            .map(|(_, root)| root.trim().to_owned())
            .filter(|root| is_trace_id(root))
    };
    root.ok_or_else(|| {
        Error::usage(format!(
            "\"{text}\" is no trace ID: one is 1-, the time in 8 hex digits, -, then 24 hex digits, as AWS X-Ray writes it"
        ))
    })
}

/// `1-<the time, 8 hex digits>-<24 hex digits>`, in lower case.
fn is_trace_id(text: &str) -> bool {
    let hex = |part: &str, length: usize| {
        part.len() == length && part.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    };
    matches!(text.split('-').collect::<Vec<_>>().as_slice(), ["1", time, random] if hex(time, 8) && hex(random, 24))
}

/// The trace an argument names, as the API answers it: the account's calls in it, by time.
pub fn fetch(client: &Client, id: &str) -> Result<Trace, Error> {
    client.json(&Call::get(format!("/traces/{}", trace_id(id)?)))
}

/// The warning for a trace whose calls the API gave its first of.
pub fn truncated(trace: &Trace) -> String {
    format!("Trace {} has more calls than these, its first {}", trace.trace_id, trace.calls.len())
}

pub fn run(id: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let trace = fetch(&client, id)?;
    if trace.truncated {
        context.out.warn(&truncated(&trace));
    }
    context.out.result(&trace, || timeline(&trace))
}

/// How a call came, in words: its source, an asynchronous call's attempt, and what brought it, such as
/// `sqs, queue orders` or `schedule nightly`.
pub fn how_it_came(source: &str, attempt: Option<u32>, trigger: Option<&Trigger>) -> String {
    let mut text = match (source, attempt) {
        ("async", Some(attempt)) => format!("async, attempt {attempt}"),
        (source, _) => source.to_owned(),
    };
    if let Some(trigger) = trigger {
        let named = [
            ("schedule", &trigger.schedule),
            ("queue", &trigger.queue),
            ("bucket", &trigger.bucket),
            ("record of", &trigger.record_of),
        ];
        for (what, name) in named {
            let Some(name) = name else { continue };
            if text == what {
                text = format!("{what} {name}");
            } else {
                text.push_str(&format!(", {what} {name}"));
            }
        }
    }
    text
}

/// A time since the trace's start: `12 ms`, `1.31 s`, `2 min 5 s`, `1 h 4 min`.
pub fn elapsed(ms: f64) -> String {
    let ms = ms.max(0.0);
    if ms < 1000.0 {
        return format!("{} ms", ms.round());
    }
    if ms < 60_000.0 {
        return format!("{:.2} s", ms / 1000.0);
    }
    let seconds = (ms / 1000.0).round() as u64;
    if seconds < 3600 {
        format!("{} min {} s", seconds / 60, seconds % 60)
    } else {
        format!("{} h {} min", seconds / 3600, seconds % 3600 / 60)
    }
}

/// The function that ran a call, with the alias it named or its version: `orders`, `orders:live`, `orders:3`.
fn qualified(call: &TraceCall) -> String {
    match (&call.alias, call.version) {
        (Some(alias), _) => format!("{}:{alias}", call.function_name),
        (None, Some(version)) => format!("{}:{version}", call.function_name),
        (None, None) => call.function_name.clone(),
    }
}

/// Each call's start, in milliseconds after the first call's.
fn offsets(calls: &[TraceCall]) -> Vec<f64> {
    let starts: Vec<Option<SystemTime>> =
        calls.iter().map(|call| humantime::parse_rfc3339_weak(&call.created_at).ok()).collect();
    let first = starts.iter().flatten().min().copied();
    starts
        .iter()
        .map(|start| match (first, start) {
            (Some(first), Some(start)) => start.duration_since(first).unwrap_or_default().as_secs_f64() * 1000.0,
            _ => 0.0,
        })
        .collect()
}

/// A call's bar on the timeline, from its start to its end, the trace's span `width` characters: one at least.
fn bar(start: f64, duration: f64, span: f64, width: usize) -> String {
    let column = |ms: f64| (ms / span * width as f64).clamp(0.0, width as f64);
    let from = (column(start).floor() as usize).min(width - 1);
    let to = (column(start + duration).ceil() as usize).clamp(from + 1, width);
    format!("{}{}", " ".repeat(from), "█".repeat(to - from))
}

/// The trace as people read it: what it is, then a row a call, its start after the first's, its bar, its function,
/// how it came, its status, its duration and its request ID, which `ff logs --request-id` takes.
fn timeline(trace: &Trace) -> String {
    let offsets = offsets(&trace.calls);
    let span = trace.calls.iter().zip(&offsets).map(|(call, start)| start + call.duration).fold(1.0, f64::max);
    let functions: HashSet<&str> = trace.calls.iter().map(|call| call.function_id.as_str()).collect();
    let rows: Vec<Vec<String>> = trace
        .calls
        .iter()
        .zip(&offsets)
        .map(|(call, &start)| {
            vec![
                format!("+{}", elapsed(start)),
                bar(start, call.duration, span, TIMELINE_WIDTH),
                qualified(call),
                how_it_came(&call.source, Some(call.attempt), call.trigger.as_ref()),
                call.status.clone(),
                elapsed(call.duration),
                call.request_id.clone(),
            ]
        })
        .collect();
    let started = trace.calls.first().map(|call| format!(", from {} UTC", time(&call.created_at))).unwrap_or_default();
    format!(
        "Trace {}: {} of {}{started}, over {}\n\n{}",
        trace.trace_id,
        counted(trace.calls.len(), "call"),
        counted(functions.len(), "function"),
        elapsed(span),
        table(&["AT", "TIMELINE", "FUNCTION", "SOURCE", "STATUS", "DURATION", "REQUEST ID"], &rows)
    )
}

/// `1 call`, `3 calls`.
fn counted(count: usize, what: &str) -> String {
    if count == 1 { format!("1 {what}") } else { format!("{count} {what}s") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::{class_fields, sorted, sorted_keys};

    const DTO: &str = include_str!("../../../BE/src/functions/dto/trace.dto.ts");
    const TRACE: &str = "1-6730a1f2-0123456789abcdef01234567";

    fn call(function: &str, source: &str, at: &str, duration: f64) -> TraceCall {
        TraceCall {
            id: format!("{function}-{at}"),
            request_id: format!("req-{function}"),
            attempt: 1,
            function_id: format!("id-{function}"),
            function_name: function.into(),
            source: source.into(),
            trigger: None,
            version: None,
            alias: None,
            status: "COMPLETED".into(),
            duration,
            created_at: format!("2026-11-10T09:15:{at}Z"),
        }
    }

    #[test]
    fn a_traces_fields_are_the_apis() {
        let every = Trigger {
            schedule: Some("nightly".into()),
            queue: Some("orders".into()),
            message_id: Some("m-1".into()),
            bucket: Some("photos".into()),
            record_of: Some("req-1".into()),
        };
        let one = TraceCall { trigger: Some(every.clone()), ..call("api", "url", "03.000", 12.0) };
        assert_eq!(sorted_keys(&every), sorted(class_fields(DTO, "InvocationTriggerView")));
        assert_eq!(sorted_keys(&one), sorted(class_fields(DTO, "TraceCallView")));
        let trace = Trace { trace_id: TRACE.into(), calls: vec![one], truncated: false };
        assert_eq!(sorted_keys(&trace), sorted(class_fields(DTO, "TraceView")));
    }

    #[test]
    fn a_trace_is_its_id_or_a_headers_root_in_any_case_and_nothing_else() {
        assert_eq!(trace_id(TRACE).unwrap(), TRACE);
        assert_eq!(trace_id(" 1-6730A1F2-0123456789ABCDEF01234567 ").unwrap(), TRACE);
        assert_eq!(trace_id(&format!("Parent=53995c3f42cd8ad8; root={TRACE};Sampled=0")).unwrap(), TRACE);
        let refused = trace_id("Root=1-6730a1f2-0123").unwrap_err();
        assert_eq!(
            (refused.exit_code(), refused.message.as_str()),
            (
                2,
                "\"Root=1-6730a1f2-0123\" is no trace ID: one is 1-, the time in 8 hex digits, -, then 24 hex digits, as \
                 AWS X-Ray writes it"
            )
        );
        assert!(trace_id("2-6730a1f2-0123456789abcdef01234567").is_err());
        assert!(trace_id("1-6730a1f2-0123456789abcdef0123456g").is_err());
    }

    #[test]
    fn a_call_says_how_it_came_and_what_brought_it() {
        let queue = Trigger { queue: Some("orders".into()), message_id: Some("m-1".into()), ..Trigger::default() };
        let schedule = Trigger { schedule: Some("nightly".into()), ..Trigger::default() };
        let bucket = Trigger { bucket: Some("photos".into()), ..Trigger::default() };
        let record = Trigger { record_of: Some("req-1".into()), ..Trigger::default() };
        assert_eq!(
            [
                how_it_came("url", Some(1), None),
                how_it_came("async", Some(2), None),
                how_it_came("sqs", Some(1), Some(&queue)),
                how_it_came("schedule", Some(1), Some(&schedule)),
                how_it_came("async", Some(1), Some(&bucket)),
                how_it_came("async", Some(1), Some(&record)),
                how_it_came("api", None, None),
            ],
            [
                "url",
                "async, attempt 2",
                "sqs, queue orders",
                "schedule nightly",
                "async, attempt 1, bucket photos",
                "async, attempt 1, record of req-1",
                "api"
            ]
        );
    }

    #[test]
    fn a_time_since_the_start_reads_in_its_unit() {
        assert_eq!(
            [elapsed(0.0), elapsed(12.4), elapsed(1310.0), elapsed(125_000.0), elapsed(3_840_000.0)],
            ["0 ms", "12 ms", "1.31 s", "2 min 5 s", "1 h 4 min"]
        );
    }

    #[test]
    fn a_trace_reads_as_a_timeline_each_call_at_its_start_with_its_bar() {
        let api = TraceCall { alias: Some("live".into()), version: Some(3), ..call("api", "url", "03.000", 100.0) };
        let worker = TraceCall {
            trigger: Some(Trigger { queue: Some("jobs".into()), ..Trigger::default() }),
            ..call("worker", "sqs", "03.300", 900.0)
        };
        let retried = TraceCall { attempt: 2, status: "ERROR".into(), ..call("worker", "async", "04.100", 100.0) };
        let trace = Trace { trace_id: TRACE.into(), calls: vec![api, worker, retried], truncated: false };

        assert_eq!(
            timeline(&trace),
            [
                "Trace 1-6730a1f2-0123456789abcdef01234567: 3 calls of 2 functions, from 2026-11-10 09:15:03 UTC, over \
                 1.20 s",
                "",
                "AT       TIMELINE                  FUNCTION  SOURCE            STATUS     DURATION  REQUEST ID",
                "+0 ms    ██                        api:live  url               COMPLETED  100 ms    req-api",
                "+300 ms        ██████████████████  worker    sqs, queue jobs   COMPLETED  900 ms    req-worker",
                "+1.10 s                        ██  worker    async, attempt 2  ERROR      100 ms    req-worker",
            ]
            .join("\n")
        );
    }

    #[test]
    fn a_bar_is_one_character_at_least_and_stays_on_the_timeline() {
        assert_eq!(bar(0.0, 0.0, 1000.0, 10), "█");
        assert_eq!(bar(1000.0, 0.0, 1000.0, 10), format!("{}█", " ".repeat(9)));
        assert_eq!(bar(250.0, 500.0, 1000.0, 8), "  ████");
    }
}
