//! `ff queues` against a scripted API: a queue's URL, ARN and endpoint; SQS's attributes from
//! durations, a dead-letter queue by its name, as its ARN; a name held to SQS's rule before any
//! call; messages sent from stdin with attributes, received and deleted; a purge and a deletion
//! asked first; the API's refusals in its words.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const ACCOUNT: &str = "000000000001";

fn queue(name: &str) -> Value {
    json!({
        "name": name,
        "url": format!("https://sqs.example.tn/{ACCOUNT}/{name}"),
        "arn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:{name}"),
        "visibilityTimeout": 30,
        "messageRetentionPeriod": 345_600,
        "delaySeconds": 0,
        "maximumMessageSize": 1_048_576,
        "receiveMessageWaitTimeSeconds": 0,
        "redrivePolicy": null,
        "messages": { "available": 0, "inFlight": 0, "delayed": 0 },
        "sizeBytes": 0,
        "createdAt": "2026-10-24T08:00:00.000Z",
        "updatedAt": "2026-10-24T08:00:00.000Z"
    })
}

fn with_dead_letters(name: &str) -> Value {
    let mut queue = queue(name);
    queue["redrivePolicy"] =
        json!({ "deadLetterTargetArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders-dlq"), "maxReceiveCount": 3 });
    queue["visibilityTimeout"] = json!(60);
    queue
}

fn calls(api: &Server) -> Vec<String> {
    api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect()
}

fn body(api: &Server, index: usize) -> Value {
    serde_json::from_str(&api.requests()[index].body).unwrap()
}

#[test]
fn create_sends_the_attributes_its_flags_give_its_dead_letter_queue_by_the_arn_the_api_answers() {
    let api = Server::start(vec![Reply::json(200, queue("orders-dlq")), Reply::json(201, with_dead_letters("orders"))]);

    ff(&with_key(&api.url))
        .args(["queues", "create", "orders", "--visibility-timeout", "1m", "--retention", "1d", "--dead-letter-queue", "orders-dlq", "--max-receive-count", "3"])
        .assert()
        .success()
        .stdout(format!(
            "orders made\nurl                 https://sqs.example.tn/{ACCOUNT}/orders\narn                 arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders\n\
             endpoint            https://sqs.example.tn (AWS_ENDPOINT_URL_SQS)\n\
             `ff buckets keys create --queue orders` makes an access key for AWS's SDKs and CLI\n"
        ));
    assert_eq!(calls(&api), ["GET /queues/orders-dlq", "POST /queues"]);
    assert_eq!(
        body(&api, 1),
        json!({
            "name": "orders",
            "visibilityTimeout": 60,
            "messageRetentionPeriod": 86_400,
            "redrivePolicy": { "deadLetterTargetArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders-dlq"), "maxReceiveCount": 3 }
        })
    );
}

#[test]
fn names_and_durations_sqs_wouldnt_take_are_refused_before_any_call() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);

    for (args, words) in [
        (vec!["queues", "create", "orders.fifo"], "FF's queues are standard queues, and FIFO queues come later"),
        (
            vec!["queues", "create", "my orders"],
            "can't be a queue's name: 1 to 80 letters, digits, hyphens and underscores",
        ),
        (
            vec!["queues", "create", "orders", "--visibility-timeout", "13h"],
            "--visibility-timeout takes whole seconds from 0s to 12h",
        ),
        (
            vec!["queues", "create", "orders", "--dead-letter-queue", "orders"],
            "A queue can't be its own dead-letter queue",
        ),
        (vec!["queues", "set", "orders"], "Say what changes: --visibility-timeout"),
        (vec!["queues", "send", "orders", "x", "--attribute", "nameless"], "--attribute takes NAME=VALUE"),
        (vec!["queues", "receive", "orders", "--wait", "21s"], "--wait takes whole seconds from 0s to 20s"),
        (vec!["queues", "delete-message", "orders", "not/a/handle"], "is no receipt handle of FF's"),
    ] {
        ff(&dir).args(&args).assert().code(2).stderr(predicate::str::contains(words));
    }
    ff(&dir).args(["queues", "receive", "orders", "--max", "11"]).assert().code(2);
    ff(&dir).args(["queues", "create", "orders", "--max-receive-count", "3"]).assert().code(2);
    assert!(api.requests().is_empty());
}

#[test]
fn list_shows_each_queue_its_messages_what_they_hold_and_its_dead_letters() {
    let mut orders = with_dead_letters("orders");
    orders["messages"] = json!({ "available": 3, "inFlight": 1, "delayed": 2 });
    orders["sizeBytes"] = json!(1536);
    let api = Server::start(vec![Reply::json(200, json!([orders, queue("orders-dlq")])), Reply::json(200, json!([]))]);
    let dir = with_key(&api.url);

    ff(&dir).args(["queues", "list"]).assert().success().stdout(
        "NAME        WAITING  IN FLIGHT  DELAYED  HOLDING  DEAD LETTERS TO  CREATED (UTC)\n\
         orders      3        1          2        1.5 KB   orders-dlq       2026-10-24 08:00:00\n\
         orders-dlq  0        0          0        0 bytes  -                2026-10-24 08:00:00\n",
    );
    ff(&dir)
        .args(["queues", "list"])
        .assert()
        .success()
        .stdout("The account has no queue: `ff queues create <name>` makes one\n");
}

#[test]
fn get_shows_its_messages_where_it_is_reached_and_its_attributes_in_words() {
    let mut orders = with_dead_letters("orders");
    orders["messages"] = json!({ "available": 3, "inFlight": 1, "delayed": 0 });
    orders["sizeBytes"] = json!(2048);
    let api = Server::start(vec![Reply::json(200, orders)]);

    ff(&with_key(&api.url)).args(["queues", "get", "orders"]).assert().success().stdout(format!(
        "orders\nmessages            3 waiting, 1 in flight\nholding             2 KB\n\
         url                 https://sqs.example.tn/{ACCOUNT}/orders\narn                 arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders\n\
         endpoint            https://sqs.example.tn (AWS_ENDPOINT_URL_SQS)\n\
         visibility timeout  1 minute\nretention           4 days\ndelivery delay      0 seconds\nreceive wait        0 seconds\n\
         largest message     1048576 bytes\ndead letters        to orders-dlq after 3 receives\ncreated             2026-10-24 08:00:00 UTC\n"
    ));
    assert_eq!(calls(&api), ["GET /queues/orders"]);
}

#[test]
fn set_changes_what_is_given_and_removes_a_dead_letter_queue_with_null() {
    let api = Server::start(vec![Reply::json(200, queue("orders")), Reply::json(200, queue("orders"))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["queues", "set", "orders", "--delay", "5", "--receive-wait", "20s", "--max-message-size", "262144"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("orders changed\nvisibility timeout  30 seconds\n"));
    ff(&dir).args(["queues", "set", "orders", "--no-dead-letter-queue"]).assert().success();
    assert_eq!(calls(&api), ["PATCH /queues/orders", "PATCH /queues/orders"]);
    assert_eq!(
        body(&api, 0),
        json!({ "delaySeconds": 5, "receiveMessageWaitTimeSeconds": 20, "maximumMessageSize": 262_144 })
    );
    assert_eq!(body(&api, 1), json!({ "redrivePolicy": null }));
}

#[test]
fn send_takes_its_body_from_stdin_with_string_attributes_and_a_delay() {
    let api = Server::start(vec![Reply::json(
        201,
        json!({ "messageId": "7e4d1c2a-0000-4000-8000-000000000001", "md5OfBody": "x" }),
    )]);

    ff(&with_key(&api.url))
        .args(["queues", "send", "orders", "-", "--attribute", "item=harissa", "--delay", "30s"])
        .write_stdin("{\"order\": 42}")
        .assert()
        .success()
        .stdout("sent 7e4d1c2a-0000-4000-8000-000000000001 to orders\n");
    assert_eq!(calls(&api), ["POST /queues/orders/messages"]);
    assert_eq!(
        body(&api, 0),
        json!({ "body": "{\"order\": 42}", "delaySeconds": 30, "attributes": { "item": { "dataType": "String", "stringValue": "harissa" } } })
    );
}

#[test]
fn receive_prints_each_message_and_with_delete_deletes_each_by_its_handle() {
    let message = json!({
        "messageId": "7e4d1c2a-0000-4000-8000-000000000001",
        "receiptHandle": "MTo6MTo3ZTRk",
        "body": "{\"order\": 42}",
        "attributes": { "item": { "dataType": "String", "stringValue": "harissa" } },
        "receiveCount": 2,
        "senderId": "AKFF7Q2MLKX4RTZB3W5N",
        "sentAt": "2026-10-24T08:00:00.000Z"
    });
    let api = Server::start(vec![
        Reply::json(200, json!([message])),
        Reply::json(200, json!([message])),
        Reply::json(204, json!(null)),
        Reply::json(200, json!([])),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["queues", "receive", "orders", "--max", "10", "--wait", "20s", "--visibility-timeout", "5m"]).assert().success().stdout(
        "message 7e4d1c2a-0000-4000-8000-000000000001, received 2 times, sent 2026-10-24 08:00:00 UTC by AKFF7Q2MLKX4RTZB3W5N\n\
         attribute item=harissa (String)\nhandle MTo6MTo3ZTRk\n{\"order\": 42}\n",
    );
    let deleted = ff(&dir).args(["queues", "receive", "orders", "--delete", "--output", "json"]).output().unwrap();
    let deleted: Value = serde_json::from_slice(&deleted.stdout).unwrap();
    assert_eq!(
        (deleted[0]["deleted"].clone(), deleted[0]["receiptHandle"].clone()),
        (json!(true), json!("MTo6MTo3ZTRk"))
    );
    ff(&dir)
        .args(["queues", "receive", "orders"])
        .assert()
        .success()
        .stdout("No message: orders had none to give within the wait\n");
    assert_eq!(
        calls(&api),
        [
            "POST /queues/orders/receive",
            "POST /queues/orders/receive",
            "DELETE /queues/orders/messages/MTo6MTo3ZTRk",
            "POST /queues/orders/receive"
        ]
    );
    assert_eq!(body(&api, 0), json!({ "maxMessages": 10, "waitTimeSeconds": 20, "visibilityTimeout": 300 }));
    assert_eq!(body(&api, 1), json!({ "maxMessages": 1 }));
}

#[test]
fn a_message_is_deleted_by_its_receipt_handle() {
    let api = Server::start(vec![Reply::json(204, json!(null))]);

    ff(&with_key(&api.url))
        .args(["queues", "delete-message", "orders", "MTo6MTo3ZTRk"])
        .assert()
        .success()
        .stdout("deleted from orders the message that handle received, if that was its last receive\n");
    assert_eq!(calls(&api), ["DELETE /queues/orders/messages/MTo6MTo3ZTRk"]);
}

#[test]
fn purge_and_delete_ask_first_and_a_script_must_say_yes() {
    let api = Server::start(vec![Reply::json(204, json!(null)), Reply::json(204, json!(null))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["queues", "purge", "orders"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff queues purge asks first"));
    ff(&dir)
        .args(["queues", "delete", "orders"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff queues delete asks first"));
    ff(&dir)
        .args(["queues", "purge", "orders", "--yes"])
        .assert()
        .success()
        .stdout("deleted every message of orders\n");
    ff(&dir).args(["queues", "delete", "orders", "--yes"]).assert().success().stdout("deleted the queue orders\n");
    assert_eq!(calls(&api), ["POST /queues/orders/purge", "DELETE /queues/orders"]);
}

#[test]
fn the_apis_refusals_come_in_its_words() {
    let api = Server::start(vec![
        Reply::json(404, json!({ "statusCode": 404, "message": "The account has no queue named \"orders-dlq\"" })),
        Reply::json(409, json!({ "statusCode": 409, "message": "The account has a queue named \"orders\" already" })),
        Reply::json(
            429,
            json!({ "statusCode": 429, "message": "The account's messages hold 100 MB together, the Beta plan's limit" }),
        ),
    ]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["queues", "create", "orders", "--dead-letter-queue", "orders-dlq"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("The account has no queue named \"orders-dlq\""));
    ff(&dir).args(["queues", "create", "orders"]).assert().code(3).stderr(predicate::str::contains("already"));
    ff(&dir)
        .args(["queues", "send", "orders", "x"])
        .assert()
        .code(6)
        .stderr(predicate::str::contains("the Beta plan's limit"));
    assert_eq!(calls(&api), ["GET /queues/orders-dlq", "POST /queues", "POST /queues/orders/messages"]);
}
