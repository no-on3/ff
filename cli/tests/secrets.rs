//! `ff secrets` against a scripted API: names only in every answer, values from stdin, never the
//! command line.

mod common;

use common::{KEY, Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn listed() -> Value {
    json!([{ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

fn secrets(names: &[&str]) -> Value {
    json!({ "secrets": names.iter().map(|name| json!({ "name": name, "updatedAt": "2026-10-21T09:30:00.000Z" })).collect::<Vec<_>>() })
}

#[test]
fn list_gives_names_and_when_each_was_set() {
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, secrets(&["API_TOKEN", "DB_PASSWORD"]))]);

    ff(&with_key(&api.url))
        .args(["secrets", "list", "hello"])
        .assert()
        .success()
        .stdout("NAME         SET (UTC)\nAPI_TOKEN    2026-10-21 09:30:00\nDB_PASSWORD  2026-10-21 09:30:00\n");
    assert_eq!(api.requests()[1].path, "/functions/f1/secrets");
}

#[test]
fn set_reads_a_line_of_stdin_per_secret_and_never_prints_a_value() {
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, secrets(&["API_TOKEN", "DB_PASSWORD"]))]);

    let output = ff(&with_key(&api.url))
        .args(["secrets", "set", "hello", "DB_PASSWORD", "API_TOKEN"])
        .write_stdin("hunter2\ns3cr3t\n")
        .output()
        .unwrap();

    assert!(output.status.success());
    let printed = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(printed.contains("hello: DB_PASSWORD, API_TOKEN set, live in "), "{printed}");
    assert!(!printed.contains("hunter2") && !printed.contains("s3cr3t"), "{printed}");
    let patch = &api.requests()[1];
    assert_eq!((patch.method.as_str(), patch.path.as_str()), ("PATCH", "/functions/f1/secrets"));
    assert_eq!(
        serde_json::from_str::<Value>(&patch.body).unwrap(),
        json!({ "secrets": { "DB_PASSWORD": "hunter2", "API_TOKEN": "s3cr3t" } })
    );
    assert_eq!(patch.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
}

#[test]
fn unset_sends_null_for_each() {
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, secrets(&[]))]);

    ff(&with_key(&api.url))
        .args(["secrets", "unset", "hello", "DB_PASSWORD"])
        .assert()
        .success()
        .stdout(predicate::str::contains("its secrets: none"));
    assert_eq!(
        serde_json::from_str::<Value>(&api.requests()[1].body).unwrap(),
        json!({ "secrets": { "DB_PASSWORD": null } })
    );
}

#[test]
fn a_value_on_the_command_line_or_a_missing_line_is_refused_before_anything_is_sent() {
    let api = Server::start(vec![Reply::json(200, listed())]);
    let dir = with_key(&api.url);

    ff(&dir).args(["secrets", "set", "hello", "DB_PASSWORD=hunter2"]).assert().code(2).stderr(
        predicate::str::contains("doesn't go on the command line").and(predicate::str::contains("hunter2").not()),
    );
    ff(&dir)
        .args(["secrets", "set", "hello", "A1", "B2"])
        .write_stdin("only-one\n")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("stdin has no line for B2"));
    assert!(api.requests().is_empty());
}
