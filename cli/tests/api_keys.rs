//! `ff api-keys` against a scripted API: an owner's login makes, lists and revokes the account's keys; a key is
//! refused before any call.

mod common;

use std::time::{Duration, SystemTime};

use common::{Reply, Server, ff, logged_in, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

/// A login whose access token is far from its end, so that nothing renews it.
const FAR: &str = "2099-01-01T00:00:00Z";

fn view(id: &str, name: &str, expires_at: Value, revoked_at: Value) -> Value {
    json!({ "id": id, "name": name, "scopes": ["functions:read", "functions:write"], "createdBy": "u1",
            "createdAt": "2026-11-01T08:00:00.000Z", "expiresAt": expires_at, "lastUsedAt": null, "revokedAt": revoked_at })
}

fn listed() -> Value {
    let mut used = view("0f3a9c21be47", "CI deploys", json!("2027-02-07T10:00:00.000Z"), Value::Null);
    used["lastUsedAt"] = json!("2026-11-09T07:30:12.000Z");
    json!([used, view("aaaaaaaaaaaa", "old", Value::Null, json!("2026-11-02T09:00:00.000Z"))])
}

#[test]
fn a_key_made_is_shown_once_last_with_its_scopes_and_its_expiry_sent_as_a_time() {
    let mut made = view("0f3a9c21be47", "CI deploys", json!("2027-02-07T10:00:00.000Z"), Value::Null);
    made["key"] = json!("ffk_0f3a9c21be47_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe");
    let api = Server::start(vec![Reply::json(201, made)]);

    let asked_at = SystemTime::now();
    ff(&logged_in(&api.url, FAR, false))
        .args(["api-keys", "create", "--name", "CI deploys", "--scopes", "functions:read,functions:write"])
        .args(["--scopes", "functions:read", "--expires", "90d"])
        .assert()
        .success()
        .stdout(
            "API key \"CI deploys\" (0f3a9c21be47) made, with the scopes functions:read, functions:write, until \
             2027-02-07 10:00:00 UTC. Here it is, shown this once, as FF keeps only its hash: where it is used, \
             FF_TOKEN holds it, or `ff config set-token` saves it; `ff api-keys revoke 0f3a9c21be47` stops it.\n\
             ffk_0f3a9c21be47_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe\n",
        );

    let request = &api.requests()[0];
    assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/api-keys"));
    assert_eq!(request.header("authorization"), Some("Bearer old-access"), "the login's token");
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["name"], "CI deploys");
    assert_eq!(body["scopes"], json!(["functions:read", "functions:write"]), "each scope once");
    let expires = humantime::parse_rfc3339(body["expiresAt"].as_str().unwrap()).unwrap();
    let ninety_days = Duration::from_secs(90 * 86_400);
    assert!(expires >= asked_at + ninety_days - Duration::from_secs(1) && expires <= SystemTime::now() + ninety_days);
}

#[test]
fn as_json_a_key_made_is_the_apis_answer_with_the_key_in_its_field() {
    let mut made = view("0f3a9c21be47", "CI deploys", Value::Null, Value::Null);
    made["key"] = json!("ffk_0f3a9c21be47_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe");
    let api = Server::start(vec![Reply::json(201, made.clone())]);

    let output = ff(&logged_in(&api.url, FAR, false))
        .args(["--output", "json", "api-keys", "create", "--name", "CI deploys", "--scopes", "functions:read"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), made);
    let body: Value = serde_json::from_str(&api.requests()[0].body).unwrap();
    assert_eq!(body.get("expiresAt"), None, "no expiry unless asked");
}

#[test]
fn a_scope_or_an_expiry_ff_cant_send_is_refused_before_any_call() {
    let api = Server::start(vec![]);
    let dir = logged_in(&api.url, FAR, false);

    ff(&dir)
        .args(["api-keys", "create", "--name", "ci", "--scopes", "functions:read,everything"])
        .assert()
        .code(2)
        .stderr(
            predicate::str::contains("invalid value 'everything'").and(predicate::str::contains("functions:invoke")),
        );
    ff(&dir)
        .args(["api-keys", "create", "--name", "ci", "--scopes", "logs:read", "--expires", "2026-01-01T00:00:00Z"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--expires 2026-01-01T00:00:00Z is not in the future"));
    ff(&dir)
        .args(["api-keys", "create", "--name", "ci", "--scopes", "logs:read", "--expires", "soon"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("is neither a while, as 90d, 12h or 2w, nor a time"));
    assert!(api.requests().is_empty());
}

#[test]
fn the_keys_are_listed_with_whether_each_works_and_never_the_key() {
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, json!([]))]);
    let dir = logged_in(&api.url, FAR, false);

    ff(&dir).args(["api-keys", "list"]).assert().success().stdout(
        "ID            NAME        SCOPES                          STATE    EXPIRES (UTC)        LAST USED (UTC)      CREATED (UTC)\n\
         0f3a9c21be47  CI deploys  functions:read,functions:write  active   2027-02-07 10:00:00  2026-11-09 07:30:12  2026-11-01 08:00:00\n\
         aaaaaaaaaaaa  old         functions:read,functions:write  revoked  never                never                2026-11-01 08:00:00\n",
    );
    ff(&dir)
        .args(["api-keys", "list"])
        .assert()
        .success()
        .stdout("The account has no API key: `ff api-keys create --name <name> --scopes <scope,...>` makes one\n");
}

#[test]
fn a_key_is_revoked_by_its_name_once_found_and_one_revoked_already_is_said_so() {
    let mut revoked = listed()[0].clone();
    revoked["revokedAt"] = json!("2026-11-09T12:00:00.000Z");
    let api = Server::start(vec![Reply::json(200, listed()), Reply::json(200, revoked), Reply::json(200, listed())]);
    let dir = logged_in(&api.url, FAR, false);

    ff(&dir)
        .args(["api-keys", "revoke", "CI deploys", "--yes"])
        .assert()
        .success()
        .stdout("Revoked the API key \"CI deploys\" (0f3a9c21be47): whatever uses it is refused\n");
    ff(&dir)
        .args(["api-keys", "revoke", "aaaaaaaaaaaa"])
        .assert()
        .success()
        .stdout("The API key \"old\" (aaaaaaaaaaaa) was revoked already, at 2026-11-02 09:00:00 UTC\n");

    let asked: Vec<_> = api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect();
    assert_eq!(asked, ["GET /api-keys", "DELETE /api-keys/0f3a9c21be47", "GET /api-keys"]);
}

#[test]
fn a_revocation_asks_first_and_a_script_must_say_yes() {
    let api = Server::start(vec![Reply::json(200, listed())]);

    ff(&logged_in(&api.url, FAR, false)).args(["api-keys", "revoke", "0f3a9c21be47"]).assert().code(2).stderr(
        predicate::str::contains("ff api-keys revoke asks first, and there is no terminal to ask in: say --yes"),
    );
    assert_eq!(api.requests().len(), 1, "nothing revoked");
}

#[test]
fn an_api_key_is_refused_before_any_call_saying_how_to_use_the_login() {
    let api = Server::start(vec![]);

    ff(&with_key(&api.url)).args(["api-keys", "list"]).assert().code(3).stderr(predicate::str::contains(
        "API keys are managed with an owner's login, never with a key, and ff would send the API key \
         ffk_0123456789ab_… from credentials.toml: `ff login --replace` logs in on profile default in place of the \
         key, or `ff login --profile <name>` on another profile",
    ));
    ff(&logged_in(&api.url, FAR, false))
        .env("FF_TOKEN", common::KEY)
        .args(["api-keys", "list"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("from FF_TOKEN: unset it for ff to use your login, or `ff login` first"));
    assert!(api.requests().is_empty());
}

#[test]
fn a_member_who_isnt_an_owner_is_told_by_the_api() {
    let refused = json!({ "statusCode": 403, "message": "The developer role can't do this", "error": "Forbidden" });
    let api = Server::start(vec![Reply::json(403, refused)]);

    ff(&logged_in(&api.url, FAR, false))
        .args(["api-keys", "list"])
        .assert()
        .code(6)
        .stderr(predicate::str::contains("The developer role can't do this"));
}
