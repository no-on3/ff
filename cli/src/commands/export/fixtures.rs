//! An account for the export's tests, read as the API answers: three functions, one with a name
//! from before Lambda's rule, two with what their keys used; three queues, a bucket with events and
//! a site, a database, a cache and a mail domain.

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::account::{Account, BucketRecord, FunctionRecord};
use super::roles::KeyUse;

const ACCOUNT: &str = "123456789012";
const AT: &str = "2026-10-21T09:00:00.000Z";

fn read<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("the API's answer")
}

/// What a function's keys used, by service, resource and operation, seen from 2026-10-21 to 2026-10-31.
pub fn uses(rows: &[(&str, &str, &str)]) -> Vec<KeyUse> {
    rows.iter()
        .map(|(service, resource, operation)| {
            read(json!({ "service": service, "resource": resource, "operation": operation,
                         "firstDay": "2026-10-21", "lastDay": "2026-10-31" }))
        })
        .collect()
}

fn function(id: &str, name: &str, runtime: &str, settings: Value) -> Value {
    let mut function = json!({ "id": id, "name": name, "runtime": runtime, "code": "", "packageType": "inline",
                               "handler": "function.handler", "memory": 128, "timeout": 3, "status": "ACTIVE",
                               "eventFormat": "lambda", "minInstances": 0, "maxInstances": 3, "scaleToZero": true,
                               "environment": {}, "createdAt": AT, "updatedAt": AT });
    for (key, value) in settings.as_object().expect("settings") {
        function[key] = value.clone();
    }
    function
}

fn arn(service: &str, name: &str) -> String {
    match service {
        "lambda" => format!("arn:aws:lambda:tn-tunis-1:{ACCOUNT}:function:{name}"),
        _ => format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:{name}"),
    }
}

fn queue(name: &str, visibility: u32, dead_letters: Option<&str>) -> Value {
    json!({ "name": name, "url": format!("https://sqs.ff.tn/{ACCOUNT}/{name}"), "arn": arn("sqs", name),
            "visibilityTimeout": visibility, "messageRetentionPeriod": 345_600, "delaySeconds": 0, "maximumMessageSize": 1_048_576,
            "receiveMessageWaitTimeSeconds": 0,
            "redrivePolicy": dead_letters.map(|name| json!({ "deadLetterTargetArn": arn("sqs", name), "maxReceiveCount": 5 })),
            "messages": { "available": 0, "inFlight": 0, "delayed": 0 }, "sizeBytes": 0, "createdAt": AT, "updatedAt": AT })
}

fn schedule(name: &str, expression: &str, input: Value, enabled: bool) -> Value {
    json!({ "id": name, "functionId": "f1", "name": name, "description": null, "expression": expression, "input": input,
            "enabled": enabled, "nextRunAt": null, "lastRunAt": null, "lastRequestId": null, "lastOutcome": null,
            "createdAt": AT, "updatedAt": AT })
}

/// The account, as `ff export` reads it.
pub fn shop() -> Account {
    let send_receipts = FunctionRecord {
        function: read(function(
            "f1",
            "send-receipts",
            "nodejs",
            json!({ "memory": 256, "timeout": 60, "environment": { "LOG_LEVEL": "info" } }),
        )),
        secrets: vec!["DATABASE_URL".to_owned()],
        url: Some(read(json!({ "functionUrl": "https://abc.fn.ff.tn/", "functionId": "f1", "authType": "AWS_IAM",
                               "cors": { "allowOrigins": ["https://shop.tn"], "allowMethods": ["POST"], "maxAge": 300, "allowCredentials": null },
                               "invokeMode": "BUFFERED", "createdAt": AT, "updatedAt": AT }))),
        domains: vec!["api.shop.tn".to_owned()],
        schedules: vec![
            read(schedule("nightly", "cron(0 2 * * ? *)", json!({ "report": true }), true)),
            read(schedule("weekly", "rate(7 days)", Value::Null, false)),
        ],
        event_sources: vec![read(
            json!({ "uuid": "9a1c1b52-5c87-4e0e-9a43-0d2f6f0d6c11", "eventSourceArn": arn("sqs", "orders"),
                                          "functionArn": arn("lambda", "send-receipts"), "batchSize": 10,
                                          "maximumBatchingWindowInSeconds": 2, "functionResponseTypes": ["ReportBatchItemFailures"],
                                          "scalingConfig": { "maximumConcurrency": 5 }, "state": "Enabled",
                                          "stateTransitionReason": "USER_INITIATED", "lastModified": AT }),
        )],
        async_config: Some(read(
            json!({ "functionArn": format!("{}:$LATEST", arn("lambda", "send-receipts")), "maximumRetryAttempts": 1,
                                        "maximumEventAgeInSeconds": null,
                                        "destinationConfig": { "onSuccess": { "destination": arn("lambda", "audit") },
                                                               "onFailure": { "destination": arn("sqs", "failed-receipts") } },
                                        "lastModified": AT }),
        )),
        // The site, a bucket gone since, a queue gone since, the account's mail and its own.
        uses: uses(&[
            ("s3", "archive", "GetObject"),
            ("s3", "photos", "GetBucketNotificationConfiguration"),
            ("s3", "photos", "GetObject"),
            ("s3", "photos", "ListObjectsV2"),
            ("s3", "www", "PutObject"),
            ("sesv2", "", "GetAccount"),
            ("sesv2", "receipts@shop.tn", "SendEmail"),
            ("sqs", "failed-receipts", "SendMessage"),
            ("sqs", "invoices", "SendMessageBatch"),
            ("sqs", "orders", "GetQueueAttributes"),
        ]),
    };
    let make_thumbnail = FunctionRecord {
        function: read(function(
            "f2",
            "make-thumbnail",
            "python",
            json!({ "packageType": "zip", "handler": "app.handler", "memory": 512, "timeout": 30, "minInstances": 1, "maxInstances": 10 }),
        )),
        secrets: Vec::new(),
        url: None,
        domains: Vec::new(),
        schedules: Vec::new(),
        event_sources: Vec::new(),
        async_config: None,
        uses: uses(&[
            ("s3", "", "ListBuckets"),
            ("s3", "photos", "DeleteObject"),
            ("s3", "photos", "GetObject"),
            ("s3", "photos", "PutObject"),
        ]),
    };
    let report = FunctionRecord {
        function: read(function("f3", "report.v1", "nodejs", json!({ "eventFormat": "wrapped" }))),
        secrets: Vec::new(),
        url: None,
        domains: Vec::new(),
        schedules: Vec::new(),
        event_sources: Vec::new(),
        async_config: None,
        uses: Vec::new(),
    };
    let photos = BucketRecord {
        name: "photos".to_owned(),
        notifications: read(json!({
            "lambdaFunctionConfigurations": [{ "id": "thumbnails", "events": ["s3:ObjectCreated:*"],
                                               "filter": { "key": { "filterRules": [{ "name": "prefix", "value": "in/" }, { "name": "suffix", "value": ".jpg" }] } },
                                               "lambdaFunctionArn": arn("lambda", "make-thumbnail") }],
            "queueConfigurations": [{ "id": "removed", "events": ["s3:ObjectRemoved:Delete", "s3:ObjectRemoved:DeleteMarkerCreated"],
                                      "queueArn": arn("sqs", "orders") }],
        })),
        website: None,
        site_domains: Vec::new(),
    };
    let www = BucketRecord {
        name: "www".to_owned(),
        notifications: read(json!({})),
        website: Some(read(
            json!({ "indexDocument": { "suffix": "index.html" }, "singlePageApp": true, "url": "https://www.site.ff.tn" }),
        )),
        site_domains: vec!["shop.tn".to_owned()],
    };
    Account {
        id: ACCOUNT.to_owned(),
        name: "Shop".to_owned(),
        functions: vec![make_thumbnail, report, send_receipts],
        queues: vec![
            read(queue("failed-receipts", 30, None)),
            read(queue("orders", 30, Some("orders-dlq"))),
            read(queue("orders-dlq", 30, None)),
        ],
        buckets: vec![photos, www],
        databases: vec![read(
            json!({ "id": "d1", "name": "shop", "status": "available", "host": "db.ff.tn", "port": 5432, "database": "shop",
                                     "user": "shop", "connectionUrl": "postgresql://shop@db.ff.tn:5432/shop", "sizeBytes": 52_428_800,
                                     "connections": 0, "connectionLimit": 10, "storageLimitMb": 1024, "passwordSetAt": AT, "createdAt": AT }),
        )],
        caches: vec![read(
            json!({ "name": "sessions", "status": "active", "host": "cache.ff.tn", "port": 6400, "address": "rediss://cache.ff.tn:6400",
                                  "memoryMb": 64, "bytesUsedForCache": null, "currConnections": null, "engine": "valkey 9.1",
                                  "passwordSetAt": AT, "createdAt": AT }),
        )],
        identities: vec![read(
            json!({ "identity": "shop.tn", "type": "DOMAIN", "status": "SUCCESS", "sendingEnabled": true,
                                      "dkimSelector": "ff1", "mailFromDomain": null, "mailFromVerified": false, "records": [],
                                      "verifiedAt": AT, "createdAt": AT }),
        )],
    }
}
