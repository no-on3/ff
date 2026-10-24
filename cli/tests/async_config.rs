//! `ff async-config` against a scripted API: a function's settings for its calls that don't
//! wait, shown, changed with what isn't given kept, and back to Lambda's defaults.

mod common;

use common::{Reply, Server, ff, with_key};
use serde_json::{Value, json};

const ARN: &str = "arn:aws:lambda:tn-tunis-1:123456789012:function:failed-orders";

fn listed() -> Value {
    json!([{ "id": "f1", "name": "orders", "runtime": "nodejs", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

fn config(retries: Value, age: Value, on_failure: Option<&str>) -> Value {
    json!({ "functionArn": "arn:aws:lambda:tn-tunis-1:123456789012:function:orders:$LATEST", "maximumRetryAttempts": retries,
            "maximumEventAgeInSeconds": age,
            "destinationConfig": { "onSuccess": {}, "onFailure": on_failure.map(|arn| json!({ "destination": arn })).unwrap_or(json!({})) },
            "lastModified": "2026-10-23T10:00:00.000Z" })
}

fn none() -> Reply {
    Reply::json(
        404,
        json!({ "statusCode": 404, "message": "The function arn:aws:lambda:tn-tunis-1:123456789012:function:orders has no event invoke configuration" }),
    )
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn async_config_says_lambdas_defaults_for_a_function_without_settings() {
    let api = Server::start(vec![Reply::json(200, listed()), none()]);

    ff(&with_key(&api.url)).args(["async-config", "orders"]).assert().success().stdout(
        "orders: a call that fails is retried twice, and kept 6 hours at most, going nowhere once it ends (AWS Lambda's defaults)\n",
    );
    assert_eq!(api.requests()[1].path, "/functions/f1/event-invoke-config");
}

#[test]
fn async_config_changes_what_it_is_given_and_keeps_the_rest() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, config(json!(0), Value::Null, Some(ARN))),
        Reply::json(200, config(json!(0), json!(1800), Some(ARN))),
    ]);

    ff(&with_key(&api.url))
        .args(["async-config", "orders", "--max-age", "30m"])
        .assert()
        .success()
        .stdout("orders: a call that fails is not retried, and kept 30 minutes at most; one that fails for good to failed-orders\n");
    let requests = api.requests();
    assert_eq!((requests[2].method.as_str(), requests[2].path.as_str()), ("PUT", "/functions/f1/event-invoke-config"));
    assert_eq!(
        body(&requests[2]),
        json!({ "maximumRetryAttempts": 0, "maximumEventAgeInSeconds": 1800, "destinationConfig": { "onFailure": { "destination": ARN } } })
    );
}

#[test]
fn async_config_names_a_destination_by_its_function_and_clears_one() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        none(),
        Reply::json(200, config(Value::Null, Value::Null, Some(ARN))),
        Reply::json(200, listed()),
        Reply::json(200, config(Value::Null, Value::Null, Some(ARN))),
        Reply::json(200, config(Value::Null, Value::Null, None)),
    ]);

    ff(&with_key(&api.url)).args(["async-config", "orders", "--on-failure", "failed-orders"]).assert().success();
    ff(&with_key(&api.url)).args(["async-config", "orders", "--no-on-failure"]).assert().success();

    let requests = api.requests();
    assert_eq!(body(&requests[2]), json!({ "destinationConfig": { "onFailure": { "destination": "failed-orders" } } }));
    assert_eq!(body(&requests[5]), json!({}));
}

#[test]
fn async_config_reset_goes_back_to_lambdas_defaults_and_refuses_changes_with_it() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, config(json!(1), Value::Null, None)),
        Reply::text(204, "application/json", ""),
    ]);

    ff(&with_key(&api.url))
        .args(["async-config", "orders", "--reset"])
        .assert()
        .success()
        .stdout("orders: a call that fails is retried twice, and kept 6 hours at most, going nowhere once it ends (AWS Lambda's defaults)\n");
    assert_eq!(api.requests()[2].method, "DELETE");
    ff(&with_key(&api.url)).args(["async-config", "orders", "--reset", "--retries", "0"]).assert().code(2);
    ff(&with_key(&api.url)).args(["async-config", "orders", "--retries", "3"]).assert().code(2);
    ff(&with_key(&api.url)).args(["async-config", "orders", "--max-age", "7h"]).assert().code(2);
}
