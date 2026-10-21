//! `ff env` and `ff deploy --env` against a scripted API: the variables read, merged, and sent
//! whole, as the API replaces them all.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const CODE: &str = "def handler(event, context):\n    return 1\n";

fn function(environment: Value) -> Value {
    json!({ "id": "f1", "name": "hello", "runtime": "python", "code": CODE, "memory": 128, "timeout": 5, "status": "ACTIVE",
            "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "environment": environment,
            "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" })
}

fn listed() -> Value {
    let mut function = function(json!(null));
    function.as_object_mut().unwrap().remove("environment");
    json!([function])
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn list_gives_the_names_and_with_show_the_values() {
    let env = json!({ "TZ": "Africa/Tunis", "GREETING": "Ahlan" });
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, function(env.clone())),
        Reply::json(200, listed()),
        Reply::json(200, function(env)),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["env", "list", "hello"]).assert().success().stdout("GREETING\nTZ\n");
    ff(&dir).args(["env", "list", "hello", "--show"]).assert().success().stdout("GREETING=Ahlan\nTZ=Africa/Tunis\n");
    assert_eq!(api.requests()[1].path, "/functions/f1");
}

#[test]
fn set_merges_into_the_variables_and_sends_them_all() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, function(json!({ "TZ": "Africa/Tunis" }))),
        Reply::json(200, function(json!({ "TZ": "Africa/Tunis", "GREETING": "Ahlan", "TOKEN": "from-stdin" }))),
    ]);

    ff(&with_key(&api.url))
        .args(["env", "set", "hello", "GREETING=Ahlan", "TOKEN"])
        .write_stdin("from-stdin\n")
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^hello: GREETING, TOKEN changed, live in \d+(\.\d)? s\n$").unwrap());
    let put = &api.requests()[2];
    assert_eq!((put.method.as_str(), put.path.as_str()), ("PUT", "/functions/f1"));
    assert_eq!(
        body(put),
        json!({ "environment": { "TZ": "Africa/Tunis", "GREETING": "Ahlan", "TOKEN": "from-stdin" } })
    );
}

#[test]
fn set_sends_nothing_when_nothing_changes_and_unset_removes() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, function(json!({ "TZ": "Africa/Tunis", "GREETING": "Ahlan" }))),
        Reply::json(200, listed()),
        Reply::json(200, function(json!({ "TZ": "Africa/Tunis", "GREETING": "Ahlan" }))),
        Reply::json(200, function(json!({ "TZ": "Africa/Tunis" }))),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["env", "set", "hello", "GREETING=Ahlan"]).assert().success().stdout("hello: no changes\n");
    ff(&dir)
        .args(["env", "unset", "hello", "GREETING"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("hello: GREETING changed"));
    let requests = api.requests();
    assert_eq!(requests.len(), 5);
    assert_eq!(body(&requests[4]), json!({ "environment": { "TZ": "Africa/Tunis" } }));
}

#[test]
fn a_name_outside_lambdas_rule_is_refused_before_calling() {
    let api = Server::start(vec![]);

    ff(&with_key(&api.url))
        .args(["env", "set", "hello", "MY-VAR=1"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"MY-VAR\" can't be a variable's name"));
    assert!(api.requests().is_empty());
}

#[test]
fn deploy_creates_a_function_with_the_variables_given() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("hello.py"), CODE).unwrap();
    let api =
        Server::start(vec![Reply::json(200, json!([])), Reply::json(201, function(json!({ "GREETING": "Ahlan" })))]);

    ff(&with_key(&api.url))
        .args(["deploy", dir.path().join("hello.py").to_str().unwrap(), "--env", "GREETING=Ahlan"])
        .assert()
        .success();
    assert_eq!(body(&api.requests()[1])["environment"], json!({ "GREETING": "Ahlan" }));
}

#[test]
fn deploy_replaces_the_variables_when_they_differ_and_leaves_them_otherwise() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("hello.py"), CODE).unwrap();
    let file = dir.path().join("hello.py");
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, function(json!({ "OLD": "1", "GREETING": "Salut" }))),
        Reply::json(200, function(json!({ "GREETING": "Ahlan" }))),
        Reply::json(200, listed()),
        Reply::json(200, function(json!({ "GREETING": "Ahlan" }))),
    ]);
    let key = with_key(&api.url);

    ff(&key)
        .args(["deploy", file.to_str().unwrap(), "--env", "GREETING=Ahlan"])
        .assert()
        .success()
        .stdout(predicate::str::contains(", changed: environment\n"));
    assert_eq!(body(&api.requests()[2]), json!({ "environment": { "GREETING": "Ahlan" } }));
    ff(&key)
        .args(["deploy", file.to_str().unwrap(), "--env", "GREETING=Ahlan"])
        .assert()
        .success()
        .stdout(predicate::str::contains("no changes"));
    assert_eq!(api.requests().len(), 5);
}
