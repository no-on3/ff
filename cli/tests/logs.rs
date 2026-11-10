//! `ff logs` against a scripted API: pages of lines, every page, and the live tail.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn function() -> Value {
    json!({ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
            "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" })
}

fn line(second: u32, message: &str) -> Value {
    json!({ "time": format!("2026-10-21T09:00:{second:02}.123456000Z"), "instance": "fn-f1-7d9f8b6c5-x2x9q",
            "requestId": "0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f", "stream": "stdout", "message": message })
}

#[test]
fn the_newest_lines_of_the_window_print_oldest_first_and_the_stores_notice_as_a_warning() {
    let notice = json!({ "time": "2026-10-21T09:00:02.000000000Z", "instance": null, "requestId": null, "stream": "ff",
                         "message": "12 lines dropped: the account's limit is 2,000 lines a second" });
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(
            200,
            json!({ "lines": [line(1, "START RequestId: 0b7c"), notice, line(3, "greeting Tunis")], "next": "c1" }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["logs", "hello"])
        .assert()
        .success()
        .stdout(
            "2026-10-21 09:00:01.123 [x2x9q] START RequestId: 0b7c\n2026-10-21 09:00:03.123 [x2x9q] greeting Tunis\n",
        )
        .stderr(predicate::str::contains("warning: 12 lines dropped: the account's limit is 2,000 lines a second"));
    assert_eq!(api.requests()[1].path, "/functions/f1/logs?limit=100");
}

#[test]
fn as_json_each_line_is_an_object_of_its_own() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, json!({ "lines": [line(1, "a"), line(2, "b")], "next": null })),
    ]);

    let output = ff(&with_key(&api.url)).args(["logs", "hello", "--output", "json"]).output().unwrap();
    let lines: Vec<Value> =
        String::from_utf8(output.stdout).unwrap().lines().map(|text| serde_json::from_str(text).unwrap()).collect();

    assert_eq!(lines, [line(1, "a"), line(2, "b")]);
}

#[test]
fn the_window_and_what_narrows_it_go_to_the_api() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, json!({ "lines": [], "next": null })),
    ]);

    ff(&with_key(&api.url))
        .args([
            "logs",
            "hello",
            "--since",
            "15m",
            "--tail",
            "20",
            "--grep",
            "time out",
            "--request-id",
            "0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f",
        ])
        .assert()
        .success()
        .stdout("");
    assert_eq!(
        api.requests()[1].path,
        "/functions/f1/logs?limit=20&sinceSeconds=900&q=time%20out&requestId=0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f"
    );
    ff(&with_key(&api.url))
        .args(["logs", "hello", "--since", "soon"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--since takes a duration"));
}

#[test]
fn all_follows_the_pages_back_and_prints_the_window_in_order() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, json!({ "lines": [line(3, "three"), line(4, "four")], "next": "older" })),
        Reply::json(200, json!({ "lines": [line(1, "one"), line(2, "two")], "next": null })),
    ]);

    let output = ff(&with_key(&api.url)).args(["logs", "hello", "--all"]).output().unwrap();
    let messages: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|text| text.rsplit(' ').next().unwrap().to_owned())
        .collect();

    assert_eq!(messages, ["one", "two", "three", "four"]);
    assert_eq!(api.requests()[2].path, "/functions/f1/logs?limit=1000&cursor=older");
}

fn traced(id: &str, function: &str, attempt: u32, at: &str) -> Value {
    json!({ "id": format!("{id}-{attempt}"), "requestId": id, "attempt": attempt, "functionId": format!("id-{function}"),
            "functionName": function, "source": "async", "trigger": null, "version": null, "alias": null,
            "status": "COMPLETED", "duration": 5, "createdAt": at })
}

fn line_of(at: &str, request_id: &str, message: &str) -> Value {
    json!({ "time": at, "instance": "fn-x-7d9f8b6c5-x2x9q", "requestId": request_id, "stream": "stdout", "message": message })
}

#[test]
fn a_traces_lines_come_by_time_across_its_functions_each_request_read_once() {
    let trace = json!({ "traceId": "1-6730a1f2-0123456789abcdef01234567", "truncated": false, "calls": [
        traced("r1", "api", 1, "2026-11-10T09:15:03.250Z"),
        traced("r2", "worker", 1, "2026-11-10T09:15:04.000Z"),
        traced("r2", "worker", 2, "2026-11-10T09:16:04.000Z")] });
    let api = Server::start(vec![
        Reply::json(200, trace),
        Reply::json(
            200,
            json!({ "lines": [line_of("2026-11-10T09:15:03.300000000Z", "r1", "job taken")], "next": null }),
        ),
        Reply::json(
            200,
            json!({ "lines": [line_of("2026-11-10T09:16:04.100000000Z", "r2", "job done")], "next": "older" }),
        ),
        Reply::json(
            200,
            json!({ "lines": [line_of("2026-11-10T09:15:04.100000000Z", "r2", "job failed")], "next": null }),
        ),
    ]);

    ff(&with_key(&api.url)).args(["logs", "--trace", "1-6730a1f2-0123456789abcdef01234567"]).assert().success().stdout(
        "2026-11-10 09:15:03.300 api [x2x9q] job taken\n\
         2026-11-10 09:15:04.100 worker [x2x9q] job failed\n\
         2026-11-10 09:16:04.100 worker [x2x9q] job done\n",
    );
    let paths: Vec<String> = api.requests().iter().map(|request| request.path.clone()).collect();
    assert_eq!(
        paths,
        [
            "/traces/1-6730a1f2-0123456789abcdef01234567",
            "/functions/id-api/logs?limit=1000&requestId=r1&start=2026-11-10T09%3A14%3A03.250Z",
            "/functions/id-worker/logs?limit=1000&requestId=r2&start=2026-11-10T09%3A14%3A04.000Z",
            "/functions/id-worker/logs?limit=1000&requestId=r2&start=2026-11-10T09%3A14%3A04.000Z&cursor=older",
        ]
    );
}

#[test]
fn a_traces_lines_of_one_function_name_it_in_their_json_and_a_function_without_a_call_in_it_is_said() {
    let trace = json!({ "traceId": "1-6730a1f2-0123456789abcdef01234567", "truncated": false, "calls": [
        traced("r1", "api", 1, "2026-11-10T09:15:03.250Z"), traced("r2", "worker", 1, "2026-11-10T09:15:04.000Z")] });
    let api = Server::start(vec![
        Reply::json(200, trace.clone()),
        Reply::json(
            200,
            json!({ "lines": [line_of("2026-11-10T09:15:04.100000000Z", "r2", "job done")], "next": null }),
        ),
        Reply::json(200, trace),
    ]);
    let dir = with_key(&api.url);

    let output = ff(&dir)
        .args([
            "logs",
            "worker",
            "--trace",
            "1-6730a1f2-0123456789abcdef01234567",
            "--grep",
            "done",
            "--output",
            "json",
        ])
        .output()
        .unwrap();
    let mut expected = line_of("2026-11-10T09:15:04.100000000Z", "r2", "job done");
    expected["function"] = json!("worker");
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), expected);
    assert_eq!(
        api.requests()[1].path,
        "/functions/id-worker/logs?limit=1000&requestId=r2&start=2026-11-10T09%3A14%3A04.000Z&q=done"
    );
    ff(&dir)
        .args(["logs", "orders", "--trace", "1-6730a1f2-0123456789abcdef01234567"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("Trace 1-6730a1f2-0123456789abcdef01234567 has no call of orders"));
    ff(&dir)
        .args(["logs", "--trace", "1-6730a1f2-0123456789abcdef01234567", "--follow"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("cannot be used with"));
    ff(&dir).args(["logs"]).assert().code(2).stderr(predicate::str::contains("<NAME>"));
}

#[test]
fn follow_prints_the_live_tails_lines_and_opens_another_when_one_ends() {
    let event = |value: Value| format!("id: 1\ndata: {value}\n\n");
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, json!({ "lines": [line(1, "before")], "next": null })),
        Reply::events(&format!(
            "{}event: ping\ndata: \n\n{}event: end\ndata: {{\"message\":\"The live tail lasts 30 minutes\"}}\n\n",
            event(line(5, "live")),
            event(line(6, "more"))
        )),
        Reply::json(404, json!({ "statusCode": 404, "message": "Function with ID f1 not found" })),
    ]);

    ff(&with_key(&api.url))
        .args(["logs", "hello", "--follow", "--grep", "live"])
        .assert()
        .code(3)
        .stdout(predicate::str::ends_with(
            "[x2x9q] before\n2026-10-21 09:00:05.123 [x2x9q] live\n2026-10-21 09:00:06.123 [x2x9q] more\n",
        ))
        .stderr(predicate::str::contains("error: Function with ID f1 not found"));
    let paths: Vec<String> = api.requests().iter().map(|request| request.path.clone()).collect();
    assert_eq!(&paths[2..], ["/functions/f1/logs/stream?q=live", "/functions/f1/logs/stream?q=live"]);
}

#[test]
fn an_unavailable_store_is_said_as_the_api_says_it() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(
            503,
            json!({ "statusCode": 503, "message": "Logs are unavailable right now. Try again in a minute." }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["logs", "hello"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("error: Logs are unavailable right now. Try again in a minute."));
}
