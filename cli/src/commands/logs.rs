//! `ff logs <name>`: a function's lines from the log store, the newest of a window, every page of
//! it, or the live tail as lines come.

use std::collections::{HashSet, VecDeque};
use std::io::{self, Write};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use super::Context;
use crate::api::events::Event;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::cli::{Format, LogsArgs};
use crate::error::{Error, Kind};
use crate::output::Output;

/// How long the store may stay unavailable, through new tails 5 s apart, before ff gives up.
const UNAVAILABLE_FOR: Duration = Duration::from_secs(60);
const RETRY_AFTER: Duration = Duration::from_secs(5);
/// A live tail lasts 30 minutes; its answer may take a little longer.
const TAIL_TIMEOUT: Duration = Duration::from_secs(31 * 60);
/// How often `--poll` asks, and how far back each time: lines reach the store up to seconds late.
const POLL_EVERY: Duration = Duration::from_secs(2);
const POLL_OVERLAP: Duration = Duration::from_secs(10);

/// One line of a function's log, as the API gives it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub time: String,
    pub instance: Option<String>,
    pub request_id: Option<String>,
    pub stream: Option<String>,
    pub message: String,
}

#[derive(Deserialize)]
struct Page {
    lines: Vec<Line>,
    next: Option<String>,
}

fn usage(message: impl Into<String>) -> Error {
    Error::new(Kind::Usage, message)
}

/// `--since 15m`: whole seconds back, as the API takes them.
pub fn since_seconds(text: &str) -> Result<u64, Error> {
    let duration = humantime::parse_duration(text)
        .map_err(|error| usage(format!("--since takes a duration such as 30s, 15m, 2h or 1d: {error}")))?;
    match duration.as_secs() {
        0 => Err(usage("--since must be a second at least")),
        seconds => Ok(seconds),
    }
}

/// The window's query: its size, its start and end, and what narrows it.
pub fn window(args: &LogsArgs) -> Result<Vec<(&'static str, String)>, Error> {
    let mut query = vec![("limit", if args.all { 1000 } else { args.tail }.to_string())];
    if let Some(since) = &args.since {
        query.push(("sinceSeconds", since_seconds(since)?.to_string()));
    }
    if let Some(start) = &args.start {
        query.push(("start", start.clone()));
    }
    if let Some(end) = &args.end {
        query.push(("end", end.clone()));
    }
    query.extend(narrowing(args));
    Ok(query)
}

/// What narrows a window and the live tail alike: a phrase, a call.
fn narrowing(args: &LogsArgs) -> Vec<(&'static str, String)> {
    let mut query = Vec::new();
    if let Some(phrase) = &args.grep {
        query.push(("q", phrase.clone()));
    }
    if let Some(request_id) = &args.request_id {
        query.push(("requestId", request_id.clone()));
    }
    query
}

/// `2026-10-17 10:00:00.123 [x2x9q] message`: the time to the millisecond, the instance by the end
/// of its pod's name; with `--verbose`, the call's request ID before the message.
pub fn text(line: &Line, verbose: bool) -> String {
    let time = match (line.time.get(..10), line.time.get(11..23)) {
        (Some(date), Some(clock)) => format!("{date} {clock}"),
        _ => line.time.clone(),
    };
    let instance = line.instance.as_deref().map(|pod| pod.rsplit('-').next().unwrap_or(pod)).unwrap_or("-");
    if verbose {
        format!("{time} [{instance}] {} {}", line.request_id.as_deref().unwrap_or("-"), line.message)
    } else {
        format!("{time} [{instance}] {}", line.message)
    }
}

/// Prints each line once, as it comes: text, or a JSON object a line; the store's notice of
/// dropped lines as a warning, not as the function's.
struct Printer<'a> {
    out: &'a Output,
    seen: HashSet<(String, Option<String>, String)>,
    order: VecDeque<(String, Option<String>, String)>,
    last_time: Option<String>,
}

impl<'a> Printer<'a> {
    fn new(out: &'a Output) -> Self {
        Printer { out, seen: HashSet::new(), order: VecDeque::new(), last_time: None }
    }

    fn print(&mut self, line: &Line) -> Result<(), Error> {
        let key = (line.time.clone(), line.instance.clone(), line.message.clone());
        if !self.seen.insert(key.clone()) {
            return Ok(());
        }
        self.order.push_back(key);
        if self.order.len() > 10_000 {
            let oldest = self.order.pop_front().expect("not empty");
            self.seen.remove(&oldest);
        }
        self.last_time = Some(line.time.clone());
        if self.out.format == Format::Json {
            writeln!(io::stdout().lock(), "{}", serde_json::to_string(line).expect("a line serializes"))?;
        } else if line.stream.as_deref() == Some("ff") {
            self.out.warn(&line.message);
        } else {
            writeln!(io::stdout().lock(), "{}", text(line, self.out.verbose))?;
        }
        Ok(())
    }
}

fn page(client: &Client, path: &str, query: &[(&str, String)], cursor: Option<&str>) -> Result<Page, Error> {
    let mut call = Call::get(path);
    for (name, value) in query {
        call = call.query(name, value);
    }
    if let Some(cursor) = cursor {
        call = call.query("cursor", cursor);
    }
    client.json(&call)
}

pub fn run(args: LogsArgs, context: &Context) -> Result<(), Error> {
    let query = window(&args)?;
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, &args.name)?;
    let path = format!("/functions/{}/logs", function.id);
    let mut printer = Printer::new(context.out);

    // A page is the newest lines of the window, oldest first; the pages before it are older.
    let first = page(&client, &path, &query, None)?;
    let mut pages = vec![first.lines];
    let mut next = if args.all { first.next } else { None };
    while let Some(cursor) = next {
        let older = page(&client, &path, &query, Some(&cursor))?;
        pages.push(older.lines);
        next = older.next;
    }
    for line in pages.iter().rev().flatten() {
        printer.print(line)?;
    }
    if !args.follow {
        return Ok(());
    }
    if args.poll {
        return poll(&client, &path, &narrowing(&args), &mut printer);
    }
    let tail = format!("/functions/{}/logs/stream", function.id);
    let narrowed = narrowing(&args);
    follow(
        || {
            let mut call = Call::get(&tail).timeout(TAIL_TIMEOUT);
            for (name, value) in &narrowed {
                call = call.query(name, value);
            }
            client.events(&call).map(|events| Box::new(events) as Box<dyn Iterator<Item = io::Result<Event>>>)
        },
        |line| printer.print(&line),
        thread::sleep,
        Instant::now,
    )
}

/// How a live tail stopped.
#[derive(Debug, PartialEq, Eq)]
enum Stopped {
    /// After 30 minutes, or when the store ended it: another is opened at once.
    Ended,
    /// The store failed, or the connection went: another after 5 s, for a minute at most.
    Unavailable,
}

/// The live tail, one stream after another, each line handed on as it comes. An API's refusal,
/// such as the function deleted, ends it; the store or the connection failing for a minute too.
fn follow(
    mut open: impl FnMut() -> Result<Box<dyn Iterator<Item = io::Result<Event>>>, Error>,
    mut on_line: impl FnMut(Line) -> Result<(), Error>,
    mut sleep: impl FnMut(Duration),
    clock: impl Fn() -> Instant,
) -> Result<(), Error> {
    let mut failing_since: Option<Instant> = None;
    loop {
        let stopped = match open() {
            Err(error) if error.status.is_some() => return Err(error),
            Err(_) => Stopped::Unavailable,
            Ok(events) => {
                let mut stopped = Stopped::Unavailable;
                for event in events {
                    let Ok(event) = event else { break };
                    match event.kind.as_str() {
                        "message" => {
                            failing_since = None;
                            let line: Line = serde_json::from_str(&event.data).map_err(|error| {
                                Error::new(
                                    Kind::Failed,
                                    format!("The live tail sent a line that isn't the JSON expected: {error}"),
                                )
                            })?;
                            on_line(line)?;
                        }
                        "end" => {
                            stopped = Stopped::Ended;
                            break;
                        }
                        "unavailable" => break,
                        _ => {} // ping
                    }
                }
                stopped
            }
        };
        if stopped == Stopped::Unavailable {
            let since = *failing_since.get_or_insert_with(&clock);
            if clock().duration_since(since) >= UNAVAILABLE_FOR {
                return Err(Error::new(
                    Kind::Failed,
                    "The live tail has been unavailable for a minute: try again later, or with --poll through a proxy that holds streams back",
                ));
            }
            sleep(RETRY_AFTER);
        }
    }
}

/// `--follow --poll`: the window since the last line printed, every 2 s, without the lines
/// already printed, for a proxy that holds a stream back.
fn poll(client: &Client, path: &str, narrowing: &[(&'static str, String)], printer: &mut Printer) -> Result<(), Error> {
    loop {
        thread::sleep(POLL_EVERY);
        let from = printer
            .last_time
            .as_deref()
            .and_then(|time| humantime::parse_rfc3339_weak(time).ok())
            .unwrap_or_else(SystemTime::now);
        let start = from.checked_sub(POLL_OVERLAP).unwrap_or(from);
        let mut query =
            vec![("limit", "1000".to_owned()), ("start", humantime::format_rfc3339_nanos(start).to_string())];
        query.extend(narrowing.iter().cloned());
        for line in page(client, path, &query, None)?.lines {
            printer.print(&line)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn line(message: &str) -> Line {
        Line {
            time: "2026-10-17T10:00:00.123456000Z".into(),
            instance: Some("fn-3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f-7d9f8b6c5-x2x9q".into()),
            request_id: Some("0b7c6f2e".into()),
            stream: Some("stdout".into()),
            message: message.into(),
        }
    }

    #[test]
    fn a_line_reads_with_its_time_to_the_millisecond_and_its_instance_short() {
        assert_eq!(text(&line("greeting Tunis"), false), "2026-10-17 10:00:00.123 [x2x9q] greeting Tunis");
        assert_eq!(text(&line("greeting Tunis"), true), "2026-10-17 10:00:00.123 [x2x9q] 0b7c6f2e greeting Tunis");
        assert_eq!(
            text(&Line { instance: None, request_id: None, ..line("x") }, true),
            "2026-10-17 10:00:00.123 [-] - x"
        );
    }

    #[test]
    fn since_is_a_duration_in_whole_seconds() {
        assert_eq!(
            [
                since_seconds("30s").unwrap(),
                since_seconds("15m").unwrap(),
                since_seconds("2h").unwrap(),
                since_seconds("1d").unwrap()
            ],
            [30, 900, 7200, 86400]
        );
        assert_eq!(since_seconds("soon").unwrap_err().exit_code(), 2);
        assert_eq!(since_seconds("500ms").unwrap_err().message, "--since must be a second at least");
    }

    fn event(kind: &str, data: &str) -> io::Result<Event> {
        Ok(Event { kind: kind.into(), data: data.into() })
    }

    fn line_event(message: &str) -> io::Result<Event> {
        event("message", &serde_json::to_string(&line(message)).unwrap())
    }

    /// A follow over scripted streams, its clock moved by its sleeps: the lines it handed on, the
    /// sleeps, and how it ended.
    fn follow_scripted(streams: Vec<Result<Vec<io::Result<Event>>, Error>>) -> (Vec<String>, Vec<Duration>, Error) {
        let streams = RefCell::new(streams.into_iter());
        let lines = RefCell::new(Vec::new());
        let slept = RefCell::new(Vec::new());
        let start = Instant::now();
        let error = follow(
            || match streams.borrow_mut().next() {
                Some(stream) => {
                    stream.map(|events| Box::new(events.into_iter()) as Box<dyn Iterator<Item = io::Result<Event>>>)
                }
                None => {
                    let mut gone = Error::new(Kind::Failed, "There is no function named \"hello\"");
                    gone.status = Some(404);
                    Err(gone)
                }
            },
            |line| {
                lines.borrow_mut().push(line.message);
                Ok(())
            },
            |duration| slept.borrow_mut().push(duration),
            || start + slept.borrow().iter().sum::<Duration>(),
        )
        .unwrap_err();
        (lines.into_inner(), slept.into_inner(), error)
    }

    #[test]
    fn a_tail_that_ends_is_followed_by_another_at_once() {
        let (lines, slept, error) = follow_scripted(vec![
            Ok(vec![line_event("one"), event("ping", ""), line_event("two"), event("end", "{}")]),
            Ok(vec![line_event("three"), event("end", "{}")]),
        ]);

        assert_eq!((lines, slept), (vec!["one".to_owned(), "two".into(), "three".into()], vec![]));
        assert_eq!((error.status, error.exit_code()), (Some(404), 3));
    }

    #[test]
    fn an_unavailable_store_or_a_lost_connection_is_tried_again_5_s_later() {
        let lost = Error::new(Kind::Failed, "Couldn't reach the API");
        let (lines, slept, _) = follow_scripted(vec![
            Ok(vec![line_event("one"), event("unavailable", "{}")]),
            Err(lost),
            Ok(vec![line_event("two"), Err(io::Error::from(io::ErrorKind::ConnectionReset))]),
            Ok(vec![line_event("three"), event("end", "{}")]),
        ]);

        assert_eq!(lines, ["one", "two", "three"]);
        assert_eq!(slept, [RETRY_AFTER, RETRY_AFTER, RETRY_AFTER]);
    }

    #[test]
    fn a_minute_without_the_store_ends_the_follow() {
        let unavailable = || Ok(vec![event("unavailable", "{}")]);
        let (_, slept, error) = follow_scripted((0..20).map(|_| unavailable()).collect());

        assert_eq!(slept.len(), 12);
        assert_eq!(error.exit_code(), 3);
        assert!(error.message.starts_with("The live tail has been unavailable for a minute"), "{}", error.message);
    }
}
