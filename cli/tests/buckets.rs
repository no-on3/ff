//! `ff buckets` against a scripted API: a bucket's address, a name held to AWS's rule before any
//! call, a deletion asked first and emptying only when told, and an access key's secret printed
//! once, as the variables AWS's tools read.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn bucket(name: &str) -> Value {
    json!({ "name": name, "status": "active", "region": "tn-tunis-1", "endpoint": "https://s3.example.tn",
            "url": format!("https://{name}.s3.example.tn"), "sizeBytes": null, "objects": null, "measuredAt": null, "createdAt": "2026-10-23T06:35:00.000Z" })
}

/// One measured once, at the hour.
fn measured(name: &str) -> Value {
    let mut bucket = bucket(name);
    bucket["sizeBytes"] = json!(161_480_253);
    bucket["objects"] = json!(1204);
    bucket["measuredAt"] = json!("2026-10-23T09:00:00.000Z");
    bucket
}

fn key(id: &str, buckets: Value, read_only: bool) -> Value {
    json!({ "id": id, "buckets": buckets, "readOnly": read_only, "createdAt": "2026-10-23T06:36:00.000Z", "lastUsedAt": null })
}

const KEY_ID: &str = "AKFF7Q2MLKX4RTZB3W5N";

#[test]
fn create_makes_it_and_says_where_aws_tools_reach_it() {
    let api = Server::start(vec![Reply::json(201, bucket("photos"))]);

    ff(&with_key(&api.url)).args(["buckets", "create", "photos"]).assert().success().stdout(
        "photos made\nendpoint  https://s3.example.tn\naddress   https://photos.s3.example.tn (and https://s3.example.tn/photos path-style)\n\
         region    tn-tunis-1\n`ff buckets keys create` makes an access key for AWS's SDKs and CLI\n",
    );
    let requests = api.requests();
    assert_eq!(format!("{} {}", requests[0].method, requests[0].path), "POST /buckets");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), json!({ "name": "photos" }));
}

#[test]
fn a_name_aws_wouldnt_take_is_refused_before_any_call() {
    let api = Server::start(vec![]);

    ff(&with_key(&api.url))
        .args(["buckets", "create", "my.photos"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"my.photos\" can't be a bucket's name: 3 to 63 lower-case letters"));
    assert!(api.requests().is_empty());
}

#[test]
fn list_shows_each_bucket_what_it_held_and_its_address() {
    let api = Server::start(vec![
        Reply::json(200, json!([bucket("exports"), measured("photos")])),
        Reply::json(200, json!([])),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["buckets", "list"]).assert().success().stdout(
        "NAME     STATUS  SIZE    ADDRESS                        CREATED (UTC)\n\
         exports  active  -       https://exports.s3.example.tn  2026-10-23 06:35:00\n\
         photos   active  154 MB  https://photos.s3.example.tn   2026-10-23 06:35:00\n",
    );
    ff(&dir)
        .args(["buckets", "list"])
        .assert()
        .success()
        .stdout("The account has no bucket: `ff buckets create <name>` makes one\n");
}

#[test]
fn get_says_what_it_held_at_its_last_measure_and_where_aws_tools_reach_it() {
    let api = Server::start(vec![Reply::json(200, measured("photos")), Reply::json(200, bucket("fresh"))]);
    let dir = with_key(&api.url);

    ff(&dir).args(["buckets", "get", "photos"]).assert().success().stdout(
        "photos\nstatus    active\nheld      154 MB, 1204 objects, as measured at 2026-10-23 09:00 UTC\nendpoint  https://s3.example.tn\n\
         address   https://photos.s3.example.tn (and https://s3.example.tn/photos path-style)\nregion    tn-tunis-1\ncreated   2026-10-23 06:35:00 UTC\n",
    );
    ff(&dir)
        .args(["buckets", "get", "fresh"])
        .assert()
        .success()
        .stdout(predicate::str::contains("held      not measured yet: within the hour\n"));
}

#[test]
fn delete_asks_first_and_empties_only_when_told() {
    let api = Server::start(vec![]);
    ff(&with_key(&api.url)).args(["buckets", "delete", "photos"]).assert().code(2).stderr(predicate::str::contains(
        "ff buckets delete asks first, and there is no terminal to ask in: say --yes",
    ));

    let api = Server::start(vec![Reply::json(204, json!(null)), Reply::json(204, json!(null))]);
    let dir = with_key(&api.url);
    ff(&dir).args(["buckets", "delete", "photos", "--yes"]).assert().success().stdout("deleted the bucket photos\n");
    ff(&dir)
        .args(["buckets", "delete", "photos", "--force", "--yes"])
        .assert()
        .success()
        .stdout("deleted the bucket photos, with its files\n");
    let requests = api.requests();
    assert_eq!(
        requests.iter().map(|request| format!("{} {}", request.method, request.path)).collect::<Vec<_>>(),
        ["DELETE /buckets/photos", "DELETE /buckets/photos?force=true"]
    );
}

#[test]
fn a_bucket_with_files_answers_the_apis_words() {
    let api = Server::start(vec![Reply::json(
        409,
        json!({ "statusCode": 409, "message": "The bucket photos isn't empty: delete its objects first, or delete it with ?force=true, which deletes them all" }),
    )]);

    ff(&with_key(&api.url))
        .args(["buckets", "delete", "photos", "--yes"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("The bucket photos isn't empty"));
}

#[test]
fn keys_create_prints_the_secret_once_as_aws_tools_read_it() {
    let mut made = key(KEY_ID, json!(["photos"]), true);
    made.as_object_mut().unwrap().extend(
        json!({ "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "endpoint": "https://s3.example.tn", "region": "tn-tunis-1" })
            .as_object()
            .unwrap()
            .clone(),
    );
    let api = Server::start(vec![Reply::json(201, made)]);

    ff(&with_key(&api.url)).args(["buckets", "keys", "create", "--bucket", "photos", "--read-only"]).assert().success().stdout(format!(
        "{KEY_ID} made, reaching photos (read-only): its secret, shown this once (FF keeps it sealed; `ff buckets keys revoke {KEY_ID}` stops it):\n\
         export AWS_ACCESS_KEY_ID={KEY_ID}\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nexport AWS_REGION=tn-tunis-1\n\
         export AWS_ENDPOINT_URL_S3=https://s3.example.tn\n"
    ));
    assert_eq!(
        serde_json::from_str::<Value>(&api.requests()[0].body).unwrap(),
        json!({ "buckets": ["photos"], "readOnly": true })
    );
}

#[test]
fn keys_list_shows_what_each_reaches_never_a_secret() {
    let api = Server::start(vec![Reply::json(
        200,
        json!([key(KEY_ID, json!(null), false), key("AKFFBBBBBBBBBBBBBBBB", json!(["photos"]), true)]),
    )]);

    let shown = ff(&with_key(&api.url)).args(["buckets", "keys", "list"]).output().unwrap();
    let text = String::from_utf8_lossy(&shown.stdout);
    assert_eq!(
        text,
        "ID                    BUCKETS             LAST USED (UTC)  CREATED (UTC)\n\
         AKFF7Q2MLKX4RTZB3W5N  all                 never            2026-10-23 06:36:00\n\
         AKFFBBBBBBBBBBBBBBBB  photos (read-only)  never            2026-10-23 06:36:00\n"
    );
}

#[test]
fn keys_revoke_takes_ffs_ids_and_asks_first() {
    let api = Server::start(vec![Reply::json(204, json!(null))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["buckets", "keys", "revoke", "AKIAIOSFODNN7EXAMPLE", "--yes"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("is no access key ID of FF's"));
    ff(&dir)
        .args(["buckets", "keys", "revoke", KEY_ID, "--yes"])
        .assert()
        .success()
        .stdout(format!("revoked the access key {KEY_ID}\n"));
    assert_eq!(
        format!("{} {}", api.requests()[0].method, api.requests()[0].path),
        format!("DELETE /storage-keys/{KEY_ID}")
    );
}
