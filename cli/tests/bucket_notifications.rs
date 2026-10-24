//! `ff buckets notify` and `ff buckets notifications` against a scripted API: a configuration added to
//! the bucket's whole, its destination by name, S3's events held to their names before any call; the
//! configurations listed, one removed by its ID, all of them after asking.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const FUNCTION_ARN: &str = "arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails";
const QUEUE_ARN: &str = "arn:aws:sqs:tn-tunis-1:000000000001:removals";

fn removals() -> Value {
    json!({ "id": "removals", "queueArn": QUEUE_ARN, "events": ["s3:ObjectRemoved:*"] })
}

fn thumbnails() -> Value {
    json!({ "id": "thumbs", "lambdaFunctionArn": FUNCTION_ARN, "events": ["s3:ObjectCreated:*"], "filter": { "key": { "filterRules": [{ "name": "prefix", "value": "images/" }] } } })
}

fn calls(api: &Server) -> Vec<String> {
    api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect()
}

#[test]
fn notify_adds_a_configuration_to_the_buckets_its_function_by_name_and_says_what_it_sends() {
    let api = Server::start(vec![
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [removals()] })),
        Reply::json(
            200,
            json!({ "lambdaFunctionConfigurations": [thumbnails()], "queueConfigurations": [removals()] }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["buckets", "notify", "photos", "thumbnails", "--prefix", "images/", "--id", "thumbs"])
        .assert()
        .success()
        .stdout(
            "photos now sends:\nID        EVENTS              KEYS            TO\n\
             thumbs    s3:ObjectCreated:*  prefix images/  function thumbnails\n\
             removals  s3:ObjectRemoved:*  every key       queue removals\n",
        );
    assert_eq!(calls(&api), ["GET /buckets/photos/notifications", "PUT /buckets/photos/notifications"]);
    assert_eq!(
        serde_json::from_str::<Value>(&api.requests()[1].body).unwrap(),
        json!({
            "lambdaFunctionConfigurations": [{ "id": "thumbs", "lambdaFunctionArn": "thumbnails", "events": ["s3:ObjectCreated:*"], "filter": { "key": { "filterRules": [{ "name": "prefix", "value": "images/" }] } } }],
            "queueConfigurations": [removals()]
        })
    );
}

#[test]
fn notify_sends_to_a_queue_the_events_it_names() {
    let api = Server::start(vec![
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [] })),
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [removals()] })),
    ]);

    ff(&with_key(&api.url))
        .args([
            "buckets",
            "notify",
            "photos",
            "--queue",
            "removals",
            "--event",
            "s3:ObjectRemoved:*",
            "--suffix",
            ".jpg",
        ])
        .assert()
        .success();
    assert_eq!(
        serde_json::from_str::<Value>(&api.requests()[1].body).unwrap()["queueConfigurations"],
        json!([{ "queueArn": "removals", "events": ["s3:ObjectRemoved:*"], "filter": { "key": { "filterRules": [{ "name": "suffix", "value": ".jpg" }] } } }])
    );
}

#[test]
fn an_event_s3_doesnt_send_a_bucket_name_or_no_destination_are_refused_before_any_call() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["buckets", "notify", "photos", "thumbnails", "--event", "s3:ObjectTagging:*"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"s3:ObjectTagging:*\" is no event a bucket sends"));
    ff(&dir).args(["buckets", "notify", "My.Photos", "thumbnails"]).assert().code(2);
    ff(&dir).args(["buckets", "notify", "photos"]).assert().code(2);
    ff(&dir).args(["buckets", "notify", "photos", "thumbnails", "--queue", "removals"]).assert().code(2);
    assert!(api.requests().is_empty());
}

#[test]
fn notifications_lists_them_removes_one_by_its_id_and_clears_them_after_asking() {
    let both = json!({ "lambdaFunctionConfigurations": [thumbnails()], "queueConfigurations": [removals()] });
    let api = Server::start(vec![
        Reply::json(200, both.clone()),
        Reply::json(200, both.clone()),
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [removals()] })),
        Reply::json(200, both),
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [] })),
        Reply::json(200, json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [] })),
    ]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["buckets", "notifications", "photos"])
        .assert()
        .success()
        .stdout(predicate::str::contains("thumbs    s3:ObjectCreated:*  prefix images/  function thumbnails"));
    ff(&dir)
        .args(["buckets", "notifications", "photos", "--remove", "thumbs"])
        .assert()
        .success()
        .stdout("removed thumbs: photos sends its events no more\n");
    ff(&dir)
        .args(["buckets", "notifications", "photos", "--remove", "nope"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("photos has no notification configuration nope"));
    ff(&dir)
        .args(["buckets", "notifications", "photos", "--clear"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("asks first"));
    ff(&dir)
        .args(["buckets", "notifications", "photos", "--clear", "--yes"])
        .assert()
        .success()
        .stdout("photos sends no event any more\n");
    ff(&dir)
        .args(["buckets", "notifications", "photos"])
        .assert()
        .success()
        .stdout("photos sends no event: `ff buckets notify photos <function>` has it run one\n");
    assert_eq!(
        calls(&api),
        [
            "GET /buckets/photos/notifications",
            "GET /buckets/photos/notifications",
            "PUT /buckets/photos/notifications",
            "GET /buckets/photos/notifications",
            "PUT /buckets/photos/notifications",
            "GET /buckets/photos/notifications",
        ]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&api.requests()[2].body).unwrap(),
        json!({ "lambdaFunctionConfigurations": [], "queueConfigurations": [removals()] })
    );
    assert_eq!(serde_json::from_str::<Value>(&api.requests()[4].body).unwrap(), json!({}));
}
