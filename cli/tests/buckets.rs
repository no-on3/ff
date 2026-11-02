//! `ff buckets` against a scripted API: a bucket's address, a name held to AWS's rule before any
//! call, and a deletion asked first and emptying only when told. Its keys are `ff keys`'s, in keys.rs.

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

#[test]
fn create_makes_it_and_says_where_aws_tools_reach_it_and_that_ff_keeps_no_copy() {
    let api = Server::start(vec![Reply::json(201, bucket("photos"))]);

    ff(&with_key(&api.url)).args(["buckets", "create", "photos"]).assert().success().stdout(
        "photos made\nendpoint  https://s3.example.tn\naddress   https://photos.s3.example.tn (and https://s3.example.tn/photos path-style)\n\
         region    tn-tunis-1\n`ff keys create` makes an access key for AWS's SDKs and CLI\n\
         FF keeps no copy of its files at a second site: keep your own of those that matter (`aws s3 sync`)\n",
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
