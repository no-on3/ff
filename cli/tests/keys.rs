//! `ff keys` against a scripted API: a key's secret printed once, as the variables AWS's tools read;
//! its name, buckets, queues and functions held to the API's rules before any call; the list with
//! what each key reaches; a key revoked by its ID or its name; `ff buckets keys` another name for all.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const KEY_ID: &str = "AKFF7Q2MLKX4RTZB3W5N";

fn key(id: &str, buckets: Value, read_only: bool) -> Value {
    json!({ "id": id, "name": id, "buckets": buckets, "queues": null, "readOnly": read_only, "functions": null, "functionAccess": null,
            "createdAt": "2026-10-23T06:36:00.000Z", "lastUsedAt": null })
}

/// The answer to POST /storage-keys for a key: it, its secret and the endpoints.
fn made(mut key: Value) -> Value {
    key.as_object_mut().unwrap().extend(
        json!({ "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "endpoint": "https://s3.example.tn", "sqsEndpoint": "https://sqs.example.tn", "sesEndpoint": "https://email.example.tn", "region": "tn-tunis-1" })
            .as_object()
            .unwrap()
            .clone(),
    );
    key
}

fn body(api: &Server) -> Value {
    serde_json::from_str(&api.requests()[0].body).unwrap()
}

#[test]
fn create_prints_the_secret_once_as_aws_tools_read_it() {
    let api = Server::start(vec![Reply::json(201, made(key(KEY_ID, json!(["photos"]), true)))]);

    ff(&with_key(&api.url)).args(["keys", "create", "--bucket", "photos", "--read-only"]).assert().success().stdout(format!(
        "{KEY_ID} made, reaching the bucket photos, read-only: its secret, shown this once (FF keeps it sealed; `ff keys revoke {KEY_ID}` stops it):\n\
         export AWS_ACCESS_KEY_ID={KEY_ID}\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nexport AWS_REGION=tn-tunis-1\n\
         export AWS_ENDPOINT_URL_S3=https://s3.example.tn\nexport AWS_ENDPOINT_URL_SQS=https://sqs.example.tn\nexport AWS_ENDPOINT_URL_SESV2=https://email.example.tn\n"
    ));
    assert_eq!(body(&api), json!({ "buckets": ["photos"], "readOnly": true }));
}

#[test]
fn create_for_queues_alone_sends_their_names_held_to_sqss_rule_before_any_call() {
    let mut queues = key(KEY_ID, json!(null), false);
    queues["queues"] = json!(["orders", "orders-dlq"]);
    let api = Server::start(vec![Reply::json(201, made(queues))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["keys", "create", "--queue", "orders.fifo"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("FIFO queues come later"));
    ff(&dir).args(["keys", "create", "--queue", "orders", "--queue", "orders-dlq"]).assert().success().stdout(
        predicate::str::starts_with(format!("{KEY_ID} made, reaching the queues orders, orders-dlq: its secret")),
    );
    assert_eq!(api.requests().len(), 1);
    assert_eq!(body(&api), json!({ "queues": ["orders", "orders-dlq"], "readOnly": false }));
}

#[test]
fn create_names_the_key_and_its_functions_at_a_level_invoke_when_none_is_said() {
    let mut writer = key(KEY_ID, json!(["photos"]), false);
    writer["name"] = json!("ci-deploy");
    writer["functions"] = json!(["orders", "thumbs"]);
    writer["functionAccess"] = json!("write");
    let mut invoker = key("AKFFBBBBBBBBBBBBBBBB", json!(null), false);
    invoker["functions"] = json!(["*"]);
    invoker["functionAccess"] = json!("invoke");
    let api = Server::start(vec![Reply::json(201, made(writer)), Reply::json(201, made(invoker))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["keys", "create", "--name", "ci-deploy", "--bucket", "photos", "--function", "orders", "--function", "thumbs", "--function-access", "write"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with(format!(
            "ci-deploy ({KEY_ID}) made, reaching the bucket photos, and the functions orders, thumbs, to write: its secret, shown this once \
             (FF keeps it sealed; `ff keys revoke {KEY_ID}` stops it)"
        )));
    ff(&dir).args(["keys", "create", "--function", "*"]).assert().success().stdout(predicate::str::starts_with(
        "AKFFBBBBBBBBBBBBBBBB made, reaching every function of the account, to invoke:",
    ));
    let requests = api.requests();
    assert_eq!(
        [&requests[0].body, &requests[1].body].map(|sent| serde_json::from_str::<Value>(sent).unwrap()),
        [
            json!({ "name": "ci-deploy", "buckets": ["photos"], "readOnly": false, "functions": ["orders", "thumbs"], "functionAccess": "write" }),
            json!({ "readOnly": false, "functions": ["*"], "functionAccess": "invoke" }),
        ]
    );
}

#[test]
fn create_refuses_what_the_api_would_before_any_call() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);
    let refused = |args: &[&str], words: &str| {
        ff(&dir)
            .arg("keys")
            .arg("create")
            .args(args)
            .assert()
            .code(2)
            .stderr(predicate::str::contains(words.to_owned()));
    };

    refused(&["--name", "my key"], "\"my key\" can't be an access key's name: 1 to 64 letters, digits and +=,.@_-");
    refused(&["--function", "orders.v2"], "\"orders.v2\" can't be a function's name");
    refused(
        &["--function", "*", "--function", "orders"],
        "--function '*' names all the account's functions: it goes alone",
    );
    refused(&["--function", "orders", "--read-only"], "--read-only is for a key's buckets and queues");
    refused(&["--function-access", "write"], "--function <NAME>");
    refused(&["--function", "orders", "--function-access", "admin"], "invalid value 'admin'");
    assert!(api.requests().is_empty());
}

#[test]
fn list_shows_each_keys_name_and_what_it_reaches_never_a_secret() {
    let mut queues = key("AKFFCCCCCCCCCCCCCCCC", json!(null), false);
    queues["queues"] = json!(["orders"]);
    queues["name"] = json!("orders-worker");
    let mut invoker = key("AKFFDDDDDDDDDDDDDDDD", json!(null), false);
    invoker["functions"] = json!(["*"]);
    invoker["functionAccess"] = json!("invoke");
    let keys =
        json!([key(KEY_ID, json!(null), false), key("AKFFBBBBBBBBBBBBBBBB", json!(["photos"]), true), queues, invoker]);
    let api = Server::start(vec![Reply::json(200, keys.clone()), Reply::json(200, keys)]);
    let dir = with_key(&api.url);

    let shown = ff(&dir).args(["keys", "list"]).output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&shown.stdout),
        "ID                    NAME           BUCKETS  QUEUES  ACCESS      FUNCTIONS     LAST USED (UTC)  CREATED (UTC)\n\
         AKFF7Q2MLKX4RTZB3W5N  -              all      all     read-write  -             never            2026-10-23 06:36:00\n\
         AKFFBBBBBBBBBBBBBBBB  -              photos   -       read-only   -             never            2026-10-23 06:36:00\n\
         AKFFCCCCCCCCCCCCCCCC  orders-worker  -        orders  read-write  -             never            2026-10-23 06:36:00\n\
         AKFFDDDDDDDDDDDDDDDD  -              -        -       -           all (invoke)  never            2026-10-23 06:36:00\n"
    );
    // The name it had first, for the scripts written then.
    ff(&dir)
        .args(["buckets", "keys", "list"])
        .assert()
        .success()
        .stdout(String::from_utf8_lossy(&shown.stdout).into_owned());
}

#[test]
fn revoke_takes_ffs_ids_or_a_keys_name_and_asks_first() {
    let mut named = key("AKFFCCCCCCCCCCCCCCCC", json!(null), false);
    named["name"] = json!("orders-worker");
    let api = Server::start(vec![
        Reply::json(204, json!(null)),
        Reply::json(200, json!([key(KEY_ID, json!(null), false), named.clone()])),
        Reply::json(204, json!(null)),
        Reply::json(200, json!([named])),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["keys", "revoke", "a key", "--yes"]).assert().code(2).stderr(predicate::str::contains(
        "is neither an access key ID of FF's, AKFF and 16 letters and digits, nor an access key's name",
    ));
    ff(&dir)
        .args(["keys", "revoke", KEY_ID, "--yes"])
        .assert()
        .success()
        .stdout(format!("revoked the access key {KEY_ID}\n"));
    ff(&dir)
        .args(["buckets", "keys", "revoke", "orders-worker", "--yes"])
        .assert()
        .success()
        .stdout("revoked the access key orders-worker (AKFFCCCCCCCCCCCCCCCC)\n");
    ff(&dir).args(["keys", "revoke", "AKIAIOSFODNN7EXAMPLE", "--yes"]).assert().code(3).stderr(
        predicate::str::contains("The account has no access key named AKIAIOSFODNN7EXAMPLE: `ff keys list` lists them"),
    );
    let calls: Vec<String> =
        api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect();
    assert_eq!(
        calls,
        [
            format!("DELETE /storage-keys/{KEY_ID}"),
            "GET /storage-keys".to_owned(),
            "DELETE /storage-keys/AKFFCCCCCCCCCCCCCCCC".to_owned(),
            "GET /storage-keys".to_owned(),
        ]
    );
}
