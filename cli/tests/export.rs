//! `ff export` against a scripted API: the account read, route by route, and the folder it writes.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const ACCOUNT: &str = "123456789012";
const AT: &str = "2026-10-21T09:00:00.000Z";

fn me() -> Value {
    json!({ "user": null, "key": { "id": "0123456789ab", "name": "ci", "scopes": ["functions:read"] },
            "accounts": [{ "id": ACCOUNT, "name": "Shop", "status": "active", "role": "developer",
                           "plan": { "id": "beta", "name": "Beta", "limits": {} },
                           "internetEgress": false, "dataDeletionDueAt": null, "dataDeletedAt": null }] })
}

fn function(environment: Option<Value>) -> Value {
    let mut function = json!({ "id": "f1", "name": "send-receipts", "runtime": "nodejs", "code": "", "packageType": "inline",
                               "handler": "function.handler", "memory": 256, "timeout": 60, "status": "ACTIVE",
                               "eventFormat": "lambda", "minInstances": 0, "maxInstances": 3, "scaleToZero": true,
                               "createdAt": AT, "updatedAt": AT });
    if let Some(environment) = environment {
        function["environment"] = environment;
    }
    function
}

fn queue(name: &str, visibility: u32) -> Value {
    json!({ "name": name, "url": format!("https://sqs.ff.tn/{ACCOUNT}/{name}"), "arn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:{name}"),
            "visibilityTimeout": visibility, "messageRetentionPeriod": 345_600, "delaySeconds": 0, "maximumMessageSize": 1_048_576,
            "receiveMessageWaitTimeSeconds": 0, "redrivePolicy": null, "messages": { "available": 0, "inFlight": 0, "delayed": 0 },
            "sizeBytes": 0, "createdAt": AT, "updatedAt": AT })
}

/// The replies, in the order ff export asks: the account, the function, what calls it and what its
/// keys used, the queues, the buckets, the databases, caches and mail, then the function's code.
fn account(zip: &[u8]) -> Vec<Reply> {
    vec![
        Reply::json(200, me()),
        Reply::json(200, json!([function(None)])),
        Reply::json(200, function(Some(json!({ "LOG_LEVEL": "info" })))),
        Reply::json(200, json!({ "secrets": [{ "name": "DATABASE_URL", "updatedAt": AT }] })),
        Reply::json(
            200,
            json!({ "functionUrl": "https://abc.fn.ff.tn/", "functionId": "f1", "authType": "NONE",
                                 "cors": { "allowOrigins": ["https://shop.tn"] }, "invokeMode": "BUFFERED", "createdAt": AT, "updatedAt": AT }),
        ),
        Reply::json(200, json!([])),
        Reply::json(
            200,
            json!([{ "id": "s1", "functionId": "f1", "name": "nightly", "description": null, "expression": "cron(0 2 * * ? *)",
                                  "input": { "report": true }, "enabled": true, "nextRunAt": null, "lastRunAt": null,
                                  "lastRequestId": null, "lastOutcome": null, "createdAt": AT, "updatedAt": AT }]),
        ),
        Reply::json(
            200,
            json!([{ "uuid": "9a1c1b52-5c87-4e0e-9a43-0d2f6f0d6c11", "eventSourceArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders"),
                                  "functionArn": format!("arn:aws:lambda:tn-tunis-1:{ACCOUNT}:function:send-receipts"), "batchSize": 10,
                                  "maximumBatchingWindowInSeconds": 0, "functionResponseTypes": ["ReportBatchItemFailures"],
                                  "scalingConfig": null, "state": "Enabled", "stateTransitionReason": "USER_INITIATED", "lastModified": AT }]),
        ),
        Reply::json(
            200,
            json!({ "functionArn": format!("arn:aws:lambda:tn-tunis-1:{ACCOUNT}:function:send-receipts:$LATEST"),
                                 "maximumRetryAttempts": 1, "maximumEventAgeInSeconds": null,
                                 "destinationConfig": { "onSuccess": {}, "onFailure": { "destination": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:failed-receipts") } },
                                 "lastModified": AT }),
        ),
        Reply::json(
            200,
            json!({ "uses": [{ "service": "s3", "resource": "uploads", "operation": "GetObject", "firstDay": "2026-10-21", "lastDay": "2026-10-30" },
                             { "service": "sqs", "resource": "orders", "operation": "SendMessage", "firstDay": "2026-10-22", "lastDay": "2026-10-31" }] }),
        ),
        Reply::json(200, json!([queue("failed-receipts", 30), queue("orders", 30)])),
        Reply::json(
            200,
            json!([{ "name": "uploads", "status": "active", "region": "tn-tunis-1", "endpoint": "https://s3.ff.tn",
                                  "url": "https://uploads.s3.ff.tn", "sizeBytes": null, "objects": null, "measuredAt": null, "createdAt": AT }]),
        ),
        Reply::json(404, json!({ "statusCode": 404, "message": "The bucket uploads is no site" })),
        Reply::json(
            200,
            json!({ "queueConfigurations": [{ "id": "incoming", "events": ["s3:ObjectCreated:*"],
                                                           "queueArn": format!("arn:aws:sqs:tn-tunis-1:{ACCOUNT}:orders") }] }),
        ),
        Reply::json(
            200,
            json!([{ "id": "d1", "name": "shop", "status": "available", "host": "db.ff.tn", "port": 5432, "database": "shop",
                                  "user": "shop", "connectionUrl": "postgresql://shop@db.ff.tn:5432/shop", "sizeBytes": 52_428_800,
                                  "connections": 0, "connectionLimit": 10, "storageLimitMb": 1024, "passwordSetAt": AT, "createdAt": AT }]),
        ),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::bytes(200, "application/zip", zip.to_vec()),
    ]
}

#[test]
fn an_export_reads_the_account_and_writes_the_template_the_code_and_the_runbook() {
    let zip = b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0".to_vec();
    let api = Server::start(account(&zip));
    let dir = with_key(&api.url);
    let out = tempfile::TempDir::new().unwrap();
    let folder = out.path().join("to-aws");

    ff(&dir)
        .args(["export", folder.to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("MIGRATION.md"));

    let paths: Vec<String> = api.requests().iter().map(|request| request.path.clone()).collect();
    assert_eq!(
        paths,
        [
            "/me",
            "/functions",
            "/functions/f1",
            "/functions/f1/secrets",
            "/functions/f1/url",
            "/functions/f1/url/domains",
            "/functions/f1/schedules",
            "/functions/f1/event-sources",
            "/functions/f1/event-invoke-config",
            "/functions/f1/key-uses",
            "/queues",
            "/buckets",
            "/buckets/uploads/website",
            "/buckets/uploads/notifications",
            "/databases",
            "/caches",
            "/email/identities",
            "/functions/f1/code?javascript=true",
        ]
    );
    assert_eq!(api.requests()[17].header("accept"), Some("application/zip"));
    assert_eq!(std::fs::read(folder.join("code/send-receipts.zip")).unwrap(), zip);
    let read = |path: &str| std::fs::read_to_string(folder.join(path)).unwrap();
    let template = read("template.yaml");
    for line in [
        "  SendReceiptsFunction:\n    Type: AWS::Serverless::Function\n",
        "      CodeUri: code/send-receipts.zip\n",
        "      Runtime: nodejs24.x\n",
        "          LOG_LEVEL: !Ref SendReceiptsLogLevel\n",
        "          DATABASE_URL: !Ref SendReceiptsDatabaseUrl\n",
        "            Queue: !GetAtt OrdersQueue.Arn\n",
        "            Destination: !GetAtt FailedReceiptsQueue.Arn\n",
        "            State: !Ref ScheduleState\n",
        "      BucketName: !Ref UploadsBucketName\n",
        "      VisibilityTimeout: 60\n",
        "        - S3ReadPolicy:\n            BucketName: !Ref UploadsBucketName\n",
        "        - SQSSendMessagePolicy:\n            QueueName: !GetAtt OrdersQueue.QueueName\n",
    ] {
        assert!(template.contains(line), "{line:?} in:\n{template}");
    }
    assert!(!read("template-before-copy.yaml").contains("QueueConfigurations"));
    assert_eq!(
        read("secrets.template.env").lines().filter(|line| !line.starts_with('#')).collect::<Vec<_>>(),
        ["SendReceiptsLogLevel=", "SendReceiptsDatabaseUrl="]
    );
    let migration = read("MIGRATION.md");
    assert!(migration.starts_with("# Moving Shop from FF to AWS\n"), "{migration}");
    assert!(migration.contains("`ff schedule disable send-receipts nightly`"), "{migration}");
    assert!(migration.contains("on FF from 2026-10-21 to 2026-10-31, as FF noted each use"), "{migration}");
    assert!(read("data/postgres.md").contains("> **In this account:** the database `shop` (50 MB)."));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(std::fs::metadata(folder.join("data/s3-sync.sh")).unwrap().permissions().mode() & 0o111, 0);
    }
    assert!(!folder.join("data/elasticache.md").exists(), "a page for what the account has alone");
}

#[test]
fn an_export_refuses_a_folder_with_files_before_any_call_and_a_function_the_account_lacks() {
    let out = tempfile::TempDir::new().unwrap();
    std::fs::write(out.path().join("notes.txt"), "mine").unwrap();
    let dir = with_key(&common::unreachable_url());

    ff(&dir)
        .args(["export", out.path().to_str().unwrap()])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("already holds files: ff export writes a new folder"));

    let api = Server::start(vec![Reply::json(200, me()), Reply::json(200, json!([function(None)]))]);
    let dir = with_key(&api.url);
    let folder = out.path().join("to-aws");
    ff(&dir)
        .args(["export", "--functions", "send-receipts,orders", folder.to_str().unwrap()])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("There is no function named \"orders\" in the account"));
    assert!(!folder.exists(), "nothing written");
}
