//! `ff event-sources` against a scripted API: a function and a queue named as people name them, the
//! queue sent as the ARN the API gives it; Lambda's settings from flags, held to their ranges before
//! any call; a list, a change, a removal asked first.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const ACCOUNT: &str = "000000000001";
const FUNCTION_ID: &str = "6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70";
const UUID: &str = "1f0e2d3c-4b5a-4968-8776-655443322110";

fn function() -> Value {
    json!({ "id": FUNCTION_ID, "name": "orders-worker", "runtime": "nodejs", "memory": 128, "timeout": 5, "status": "ACTIVE", "minInstances": 0, "maxInstances": 3,
            "scaleToZero": true, "createdAt": "2026-10-24T08:00:00.000Z", "updatedAt": "2026-10-24T08:00:00.000Z" })
}

fn queue() -> Value {
    json!({ "name": "orders", "arn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders") })
}

fn mapping(state: &str) -> Value {
    json!({
        "uuid": UUID,
        "eventSourceArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders"),
        "functionArn": format!("arn:aws:lambda:tn-tunis-1:{ACCOUNT}:function:orders-worker"),
        "batchSize": 100,
        "maximumBatchingWindowInSeconds": 2,
        "functionResponseTypes": ["ReportBatchItemFailures"],
        "scalingConfig": { "maximumConcurrency": 2 },
        "state": state,
        "stateTransitionReason": "USER_INITIATED",
        "lastModified": "2026-10-24T08:00:00.000Z"
    })
}

fn calls(api: &Server) -> Vec<String> {
    api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect()
}

fn body(api: &Server, index: usize) -> Value {
    serde_json::from_str(&api.requests()[index].body).unwrap()
}

#[test]
fn add_names_the_function_and_the_queue_and_sends_lambdas_settings_the_queue_by_its_arn() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, queue()),
        Reply::json(201, mapping("Enabled")),
    ]);

    ff(&with_key(&api.url))
        .args([
            "event-sources", "add", "orders", "orders-worker", "--batch-size", "100", "--batching-window", "2s", "--max-concurrency", "2",
            "--report-batch-item-failures",
        ])
        .assert()
        .success()
        .stdout(format!(
            "orders-worker reads the queue orders: batches of 100 at most, a window of 2 seconds, the answer naming the messages that failed, \
             2 batches at once at most; reading ({UUID})\n"
        ));
    assert_eq!(calls(&api)[1..], ["GET /queues/orders", &format!("POST /functions/{FUNCTION_ID}/event-sources")]);
    assert_eq!(
        body(&api, 2),
        json!({
            "eventSourceArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders"),
            "batchSize": 100,
            "maximumBatchingWindowInSeconds": 2,
            "functionResponseTypes": ["ReportBatchItemFailures"],
            "scalingConfig": { "maximumConcurrency": 2 }
        })
    );
}

#[test]
fn settings_out_of_lambdas_ranges_and_a_mapping_id_that_isnt_one_are_refused_before_any_call() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);

    for (args, words) in [
        (
            vec!["event-sources", "add", "orders", "orders-worker", "--batching-window", "301s"],
            "--batching-window takes whole seconds from 0s to 5m",
        ),
        (vec!["event-sources", "add", "orders.fifo", "orders-worker"], "FIFO queues come later"),
        (vec!["event-sources", "update", "not-a-uuid", "--enable"], "is no event source mapping's ID"),
        (vec!["event-sources", "update", UUID], "Say what changes"),
        (vec!["event-sources", "get", "orders"], "is no event source mapping's ID"),
    ] {
        ff(&dir).args(&args).assert().code(2).stderr(predicate::str::contains(words));
    }
    for args in [
        vec!["event-sources", "add", "orders", "orders-worker", "--batch-size", "0"],
        vec!["event-sources", "add", "orders", "orders-worker", "--max-concurrency", "1"],
        vec!["event-sources", "update", UUID, "--enable", "--disable"],
        vec!["event-sources", "update", UUID, "--max-concurrency", "3", "--no-max-concurrency"],
    ] {
        ff(&dir).args(&args).assert().code(2);
    }
    assert!(api.requests().is_empty());
}

#[test]
fn list_shows_the_accounts_mappings_or_a_functions_or_a_queues() {
    let api = Server::start(vec![
        Reply::json(200, json!([mapping("Enabled")])),
        Reply::json(200, json!([function()])),
        Reply::json(200, json!([mapping("Disabled")])),
        Reply::json(200, json!([mapping("Enabled")])),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["event-sources", "list"]).assert().success().stdout(format!(
        "UUID                                  QUEUE   FUNCTION       BATCH  WINDOW  FAILURES  CONCURRENCY  STATE    CHANGED (UTC)\n\
         {UUID}  orders  orders-worker  100    2s      item      2            Enabled  2026-10-24 08:00:00\n"
    ));
    ff(&dir)
        .args(["event-sources", "list", "--function", "orders-worker"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Disabled"));
    ff(&dir)
        .args(["event-sources", "list", "--queue", "invoices"])
        .assert()
        .success()
        .stdout("No function reads a queue here: `ff event-sources add <queue> <function>` has one read\n");
    assert_eq!(
        calls(&api)[2..],
        [format!("GET /functions/{FUNCTION_ID}/event-sources"), "GET /event-sources".to_owned()]
    );
}

#[test]
fn update_sends_what_changes_and_remove_asks_first() {
    let api = Server::start(vec![Reply::json(200, mapping("Disabled")), Reply::json(204, json!(null))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["event-sources", "update", UUID, "--disable", "--no-max-concurrency", "--no-report-batch-item-failures"])
        .assert()
        .success()
        .stdout(predicate::str::ends_with(format!("disabled: nothing read ({UUID})\n")));
    assert_eq!(body(&api, 0), json!({ "functionResponseTypes": [], "scalingConfig": null, "enabled": false }));
    ff(&dir)
        .args(["event-sources", "remove", UUID])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff event-sources remove asks first"));
    ff(&dir)
        .args(["event-sources", "remove", UUID, "--yes"])
        .assert()
        .success()
        .stdout(format!("removed the mapping {UUID}: the queue's messages stay\n"));
    assert_eq!(calls(&api), [format!("PATCH /event-sources/{UUID}"), format!("DELETE /event-sources/{UUID}")]);
}

#[test]
fn the_apis_refusals_come_in_its_words() {
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, queue()),
        Reply::json(
            400,
            json!({ "statusCode": 400, "message": "Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds" }),
        ),
    ]);

    ff(&with_key(&api.url)).args(["event-sources", "add", "orders", "orders-worker"]).assert().code(3).stderr(
        predicate::str::contains("Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds"),
    );
}
