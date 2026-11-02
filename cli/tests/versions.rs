//! `ff publish`, `ff versions` and `ff alias` against a scripted API: what they send, Lambda's names, and what
//! they print.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const SHA: &str = "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=";

fn listed() -> Value {
    json!([{ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

fn version(number: &str, description: &str) -> Value {
    json!({ "functionId": "f1", "functionArn": format!("arn:aws:lambda:tn-tunis-1:000000000001:function:hello:{number}"),
            "version": number, "description": description, "runtime": "python", "handler": "hello.handler", "packageType": "Zip",
            "codeSha256": SHA, "codeSize": 120, "memory": 128, "timeout": 5, "eventFormat": "wrapped", "awsEndpoints": [],
            "revisionId": format!("v-{number}"), "createdAt": format!("2026-11-0{number}T08:00:00.000Z") })
}

fn alias(name: &str, number: &str, weights: Value) -> Value {
    json!({ "aliasArn": format!("arn:aws:lambda:tn-tunis-1:000000000001:function:hello:{name}"), "name": name,
            "functionVersion": number, "description": "", "routingConfig": { "additionalVersionWeights": weights },
            "revisionId": "r-1", "createdAt": "2026-11-02T08:00:00.000Z", "updatedAt": "2026-11-02T08:00:00.000Z" })
}

fn url(alias: Option<&str>) -> Value {
    json!({ "functionUrl": "https://abc.fn.ff.tn/", "functionId": "f1", "alias": alias, "authType": "NONE", "cors": null,
            "invokeMode": "BUFFERED", "createdAt": "2026-11-02T08:00:00.000Z", "updatedAt": "2026-11-02T08:00:00.000Z" })
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn publish_makes_a_version_with_its_description_and_says_how_to_name_it() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([])),
        Reply::json(201, version("1", "The first shop")),
    ]);

    ff(&with_key(&api.url)).args(["publish", "hello", "--description", "The first shop"]).assert().success().stdout(
        "hello: version 1 published (python, 128 MB, 5 s, code n4bQgYhMfWWa…), which never changes\n\
             `ff alias set hello live 1` points an alias at it\n",
    );
    let requests = api.requests();
    assert_eq!((requests[2].method.as_str(), requests[2].path.as_str()), ("POST", "/functions/f1/versions"));
    assert_eq!(body(&requests[2]), json!({ "description": "The first shop" }));
}

#[test]
fn publish_with_nothing_changed_says_lambda_answered_the_last_version() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([version("1", "")])),
        Reply::json(201, version("1", "")),
    ]);

    ff(&with_key(&api.url))
        .args(["publish", "hello", "--output", "json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"new\": false"));
    assert_eq!(body(&api.requests()[2]), json!({}));
}

#[test]
fn versions_lists_them_newest_first_with_the_aliases_whose_calls_reach_each() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([version("1", "The first shop"), version("2", "")])),
        Reply::json(200, json!([alias("live", "1", json!({ "2": 0.1 })), alias("beta", "2", json!({}))])),
    ]);

    ff(&with_key(&api.url)).args(["versions", "hello"]).assert().success().stdout(
        "VERSION  PUBLISHED (UTC)      CODE           MEMORY  TIMEOUT  ALIASES         DESCRIPTION\n\
         2        2026-11-02 08:00:00  n4bQgYhMfWWa…  128 MB  5 s      live 10%, beta\n\
         1        2026-11-01 08:00:00  n4bQgYhMfWWa…  128 MB  5 s      live 90%        The first shop\n",
    );
}

#[test]
fn versions_delete_asks_first_and_a_script_says_yes() {
    let api =
        Server::start(vec![Reply::json(200, listed()), Reply::json(200, listed()), Reply::json(204, Value::Null)]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["versions", "hello", "--delete", "1"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("asks first, and there is no terminal to ask in: say --yes"));
    ff(&dir)
        .args(["versions", "hello", "--delete", "1", "--yes"])
        .assert()
        .success()
        .stdout("hello: version 1 deleted\n");
    let requests = api.requests();
    assert_eq!((requests[2].method.as_str(), requests[2].path.as_str()), ("DELETE", "/functions/f1/versions/1"));
}

#[test]
fn alias_set_makes_an_alias_the_function_lacks() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([])),
        Reply::json(201, alias("live", "1", json!({}))),
    ]);

    ff(&with_key(&api.url))
        .args(["alias", "set", "hello", "live", "1", "--description", "The shop"])
        .assert()
        .success()
        .stdout("hello:live made: version 1\n");
    let requests = api.requests();
    assert_eq!((requests[2].method.as_str(), requests[2].path.as_str()), ("POST", "/functions/f1/aliases"));
    assert_eq!(body(&requests[2]), json!({ "name": "live", "functionVersion": "1", "description": "The shop" }));
}

#[test]
fn alias_set_moves_an_alias_with_its_revision_and_a_share_of_the_calls() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([alias("live", "1", json!({}))])),
        Reply::json(200, alias("live", "1", json!({ "2": 0.1 }))),
    ]);

    ff(&with_key(&api.url))
        .args(["alias", "set", "hello", "live", "1", "--also", "2", "10%"])
        .assert()
        .success()
        .stdout("hello:live: version 1 → version 1, 10% of its calls to version 2\n");
    let requests = api.requests();
    assert_eq!((requests[2].method.as_str(), requests[2].path.as_str()), ("PUT", "/functions/f1/aliases/live"));
    assert_eq!(
        body(&requests[2]),
        json!({ "functionVersion": "1", "routingConfig": { "additionalVersionWeights": { "2": 0.1 } }, "revisionId": "r-1" })
    );
}

#[test]
fn alias_set_refuses_a_share_beside_latest_before_calling() {
    let api = Server::start(vec![]);

    ff(&with_key(&api.url))
        .args(["alias", "set", "hello", "live", "latest", "--also", "2", "10%"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("an alias naming $LATEST has none, as on Lambda"));
    assert!(api.requests().is_empty());
}

#[test]
fn alias_list_says_where_each_ones_calls_go_and_its_url() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([alias("live", "1", json!({ "2": 0.1 })), alias("next", "$LATEST", json!({}))])),
        Reply::json(200, json!([url(None), url(Some("live"))])),
    ]);

    ff(&with_key(&api.url)).args(["alias", "list", "hello"]).assert().success().stdout(
        "NAME  ITS CALLS GO TO                           URL                    DESCRIPTION\n\
         live  version 1, 10% of its calls to version 2  https://abc.fn.ff.tn/\n\
         next  $LATEST                                   -\n",
    );
}

#[test]
fn alias_remove_names_the_url_that_goes_with_it() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, json!([alias("live", "1", json!({}))])),
        Reply::json(200, json!([url(Some("live"))])),
        Reply::json(204, Value::Null),
    ]);

    ff(&with_key(&api.url))
        .args(["alias", "remove", "hello", "live", "--yes"])
        .assert()
        .success()
        .stdout("hello:live removed: what names it stops until an alias of that name is made again\n");
    let requests = api.requests();
    assert_eq!((requests[3].method.as_str(), requests[3].path.as_str()), ("DELETE", "/functions/f1/aliases/live"));
}

#[test]
fn alias_remove_says_so_when_the_function_has_no_such_alias() {
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, json!([]))]);

    ff(&with_key(&api.url))
        .args(["alias", "remove", "hello", "live", "--yes"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("hello has no alias named \"live\": `ff alias list hello` lists them"));
    assert_eq!(api.requests().len(), 2);
}
