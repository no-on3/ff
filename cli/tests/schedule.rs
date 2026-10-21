//! `ff schedule` against a scripted API: a schedule made or changed, its next runs said, enabled,
//! disabled and removed.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn listed() -> Value {
    json!([{ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

fn schedule(name: &str, expression: &str, enabled: bool, input: Value) -> Value {
    json!({ "id": "s1", "functionId": "f1", "name": name, "description": null, "expression": expression, "input": input, "enabled": enabled,
            "nextRunAt": if enabled { json!("2026-10-22T02:00:00.000Z") } else { Value::Null },
            "lastRunAt": "2026-10-21T02:00:00.000Z", "lastRequestId": "r1", "lastOutcome": "success",
            "createdAt": "2026-10-20T09:00:00.000Z", "updatedAt": "2026-10-20T09:00:00.000Z" })
}

fn runs() -> Value {
    json!({ "runs": ["2026-10-22T02:00:00.000Z", "2026-10-23T02:00:00.000Z"] })
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn list_shows_each_schedule_its_next_run_and_last() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([schedule("nightly", "cron(0 2 * * ? *)", true, Value::Null)])),
    ]);

    ff(&with_key(&api.url)).args(["schedule", "list", "hello"]).assert().success().stdout(
        "NAME     EXPRESSION         ENABLED  NEXT RUN (UTC)       LAST RUN (UTC)\n\
         nightly  cron(0 2 * * ? *)  yes      2026-10-22 02:00:00  success, due 2026-10-21 02:00:00\n",
    );
}

#[test]
fn set_makes_a_schedule_with_its_input_and_says_its_next_runs() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, runs()),
        Reply::json(200, json!([])),
        Reply::json(201, schedule("nightly", "cron(0 2 * * ? *)", true, json!({ "report": "daily" }))),
    ]);

    ff(&with_key(&api.url))
        .args(["schedule", "set", "hello", "cron(0 2 * * ? *)", "--name", "nightly", "--input", r#"{"report": "daily"}"#])
        .assert()
        .success()
        .stdout("hello's schedule nightly made: cron(0 2 * * ? *), with its own input\nnext runs (UTC): 2026-10-22 02:00:00, 2026-10-23 02:00:00\n");
    let requests = api.requests();
    assert_eq!(requests[1].path, "/schedules/next-runs?expression=cron(0%202%20*%20*%20%3F%20*)");
    assert_eq!(
        (requests[3].method.as_str(), body(&requests[3])),
        (
            "POST",
            json!({ "name": "nightly", "expression": "cron(0 2 * * ? *)", "input": { "report": "daily" }, "enabled": true })
        )
    );
}

#[test]
fn set_changes_a_schedule_there_is_back_to_the_scheduled_event() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, runs()),
        Reply::json(200, json!([schedule("schedule", "rate(1 hour)", true, json!({ "x": 1 }))])),
        Reply::json(200, schedule("schedule", "rate(2 hours)", true, Value::Null)),
    ]);

    ff(&with_key(&api.url))
        .args(["schedule", "set", "hello", "rate(2 hours)", "--no-input"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with(
            "hello's schedule schedule changed: rate(2 hours), with EventBridge's Scheduled Event\n",
        ));
    let put = &api.requests()[3];
    assert_eq!(
        (put.method.as_str(), put.path.as_str(), body(put)),
        ("PUT", "/functions/f1/schedules/s1", json!({ "expression": "rate(2 hours)", "input": null }))
    );
}

#[test]
fn a_wrong_expression_is_said_in_the_apis_words_before_anything_changes() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(
            400,
            json!({ "statusCode": 400, "message": "rate(5 minute) must be rate(5 minutes): the unit is plural above 1" }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["schedule", "set", "hello", "rate(5 minute)"])
        .assert()
        .code(3)
        .stderr("error: rate(5 minute) must be rate(5 minutes): the unit is plural above 1\n");
    assert_eq!(api.requests().len(), 2);
}

#[test]
fn enable_disable_and_remove_find_the_schedule_by_its_name() {
    let one = || Reply::json(200, json!([schedule("nightly", "cron(0 2 * * ? *)", true, Value::Null)]));
    let api = Server::start(vec![
        Reply::json(200, listed()),
        one(),
        Reply::json(200, schedule("nightly", "cron(0 2 * * ? *)", false, Value::Null)),
        Reply::json(200, listed()),
        one(),
        Reply::json(200, json!(null)),
        Reply::json(200, listed()),
        one(),
    ]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["schedule", "disable", "hello", "--name", "nightly"])
        .assert()
        .success()
        .stdout("hello's schedule nightly disabled: it doesn't run\n");
    assert_eq!(body(&api.requests()[2]), json!({ "enabled": false }));
    ff(&dir).args(["schedule", "remove", "hello", "--name", "nightly"]).assert().success();
    assert_eq!(format!("{} {}", api.requests()[5].method, api.requests()[5].path), "DELETE /functions/f1/schedules/s1");
    ff(&dir)
        .args(["schedule", "enable", "hello"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("hello has no schedule named \"schedule\""));
}
