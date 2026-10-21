//! `ff whoami` against a scripted API: what the client sends, and how it reads the API's answers
//! and refusals.

mod common;

use common::{KEY, Reply, Server, ff, settings, unreachable_url, with_key};
use predicates::prelude::*;
use serde_json::json;

fn key_me() -> serde_json::Value {
    json!({
        "user": null,
        "key": { "id": "0123456789ab", "name": "laptop", "scopes": ["functions:read", "logs:read"] },
        "accounts": [{ "id": "123456789012", "name": "Acme Dev", "status": "active", "role": "developer",
                       "plan": { "id": "beta", "name": "Beta", "limits": {} }, "dataDeletionDueAt": null, "dataDeletedAt": null }]
    })
}

#[test]
fn a_key_is_sent_with_ffs_user_agent_and_said_back() {
    let api = Server::start(vec![Reply::json(200, key_me())]);
    let dir = with_key(&api.url);

    ff(&dir).arg("whoami").assert().success().stdout(format!(
        "API key \"laptop\" (ffk_0123456789ab_…) on account 123456789012 \"Acme Dev\" (active, plan Beta)\n\
         scopes: functions:read, logs:read, within its creator's role: developer\nAPI: {}\n",
        api.url
    ));

    let requests = api.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!((request.method.as_str(), request.path.as_str()), ("GET", "/me"));
    assert_eq!(request.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert_eq!(request.header("user-agent"), Some(concat!("ff-cli/", env!("CARGO_PKG_VERSION"))));
    assert_eq!((request.header("x-ff-account"), request.header("x-ff-dev-account")), (None, None));
}

#[test]
fn as_json_it_prints_the_apis_answer() {
    let api = Server::start(vec![Reply::json(200, key_me())]);
    let output = ff(&with_key(&api.url)).args(["whoami", "--output", "json"]).output().unwrap();

    assert!(output.status.success());
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(), key_me());
}

#[test]
fn the_account_flag_and_a_development_account_go_in_their_headers() {
    let api = Server::start(vec![Reply::json(200, key_me()), Reply::json(200, key_me())]);
    ff(&with_key(&api.url)).args(["whoami", "--account", "222222222222"]).assert().success();
    let dev =
        settings(&format!("[profiles.default]\nendpoint = \"{}\"\ndev_account = \"333333333333\"\n", api.url), "");
    ff(&dev).arg("whoami").assert().success();

    let requests = api.requests();
    assert_eq!(requests[0].header("x-ff-account"), Some("222222222222"));
    assert_eq!(
        (requests[1].header("x-ff-dev-account"), requests[1].header("authorization")),
        (Some("333333333333"), None)
    );
}

#[test]
fn without_a_token_it_says_how_to_get_one_and_calls_nothing() {
    let api = Server::start(vec![Reply::json(200, key_me())]);
    let dir = settings(&format!("[profiles.default]\nendpoint = \"{}\"\n", api.url), "");

    ff(&dir).arg("whoami").assert().code(3).stderr(predicate::str::contains(format!(
        "error: There is no token to call {} with. An owner of the account makes an API key in the console's API keys page",
        api.url
    )));
    assert!(api.requests().is_empty());
}

#[test]
fn an_unreachable_api_is_a_failure_naming_its_address() {
    let url = unreachable_url();
    ff(&with_key(&url))
        .arg("whoami")
        .assert()
        .code(3)
        .stderr(format!("error: Couldn't reach the API at {url}: the connection was refused\n"));
}

#[test]
fn plain_http_to_another_machine_is_refused_before_any_call() {
    ff(&with_key("http://localhost:1")).args(["whoami", "--endpoint", "http://ff.lan:3000"]).assert().code(3).stderr(
        predicate::str::contains("error: http://ff.lan:3000 is plain http, which would send your token unencrypted"),
    );
}

#[test]
fn a_refusal_for_the_account_exits_6_with_the_apis_message_and_request_id() {
    let api = Server::start(vec![Reply::json(
        403,
        json!({ "statusCode": 403, "message": "This API key lacks the scope functions:write", "error": "Forbidden", "requestId": "7d1e5c1a" }),
    )]);

    ff(&with_key(&api.url))
        .arg("whoami")
        .assert()
        .code(6)
        .stderr("error: This API key lacks the scope functions:write\nrequest ID: 7d1e5c1a\n");
}

#[test]
fn a_refused_token_says_to_save_another() {
    let api = Server::start(vec![Reply::json(401, json!({ "statusCode": 401, "message": "The API key was revoked" }))]);

    ff(&with_key(&api.url)).arg("whoami").assert().code(3).stderr(predicate::str::contains(
        "error: The API key was revoked: save another key with `ff config set-token`",
    ));
}

#[test]
fn a_read_refused_for_the_rate_is_tried_once_more_after_retry_after() {
    let busy = || {
        Reply::json(429, json!({ "statusCode": 429, "message": "Too many requests: the beta plan allows 10 a second" }))
            .header("retry-after", "1")
    };
    let api = Server::start(vec![busy(), Reply::json(200, key_me())]);
    ff(&with_key(&api.url)).arg("whoami").assert().success();
    assert_eq!(api.requests().len(), 2);

    let api = Server::start(vec![busy(), busy(), Reply::json(200, key_me())]);
    ff(&with_key(&api.url)).args(["whoami", "--output", "json"]).assert().code(6).stderr(
        predicate::str::contains("\"message\": \"Too many requests: the beta plan allows 10 a second\"")
            .and(predicate::str::contains("\"status\": 429")),
    );
    assert_eq!(api.requests().len(), 2);
}
