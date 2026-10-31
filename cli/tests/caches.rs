//! `ff caches` against a scripted API: the address printed once, set as functions' secrets with
//! `--secret-for`, a name held to ElastiCache's rule before any call, and a deletion asked first.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const URL: &str = "rediss://default:pw@cache.example.tn:6400";

fn cache(name: &str) -> Value {
    json!({ "name": name, "status": "active", "host": "cache.example.tn", "port": 6400,
            "address": "rediss://default@cache.example.tn:6400", "memoryMb": 64,
            "bytesUsedForCache": 1_258_291, "currConnections": 2, "engine": "Valkey 9.1",
            "passwordSetAt": "2026-10-30T06:35:00.000Z", "createdAt": "2026-10-30T06:35:00.000Z" })
}

fn with_password(name: &str) -> Value {
    let mut made = cache(name);
    made.as_object_mut().unwrap().extend(json!({ "password": "pw", "url": URL }).as_object().unwrap().clone());
    made
}

fn functions() -> Value {
    json!([{ "id": "f1", "name": "api", "runtime": "nodejs", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

#[test]
fn create_prints_the_address_once_and_sets_it_as_a_functions_redis_url() {
    let api = Server::start(vec![
        Reply::json(200, functions()),
        Reply::json(201, with_password("sessions")),
        Reply::json(200, functions()),
        Reply::json(200, json!({ "secrets": [{ "name": "REDIS_URL", "updatedAt": "2026-10-30T06:35:10.000Z" }] })),
    ]);

    ff(&with_key(&api.url))
        .args(["caches", "create", "sessions", "--secret-for", "api"])
        .assert()
        .success()
        .stdout(format!(
            "sessions made: its address, shown this once (FF keeps no copy; `ff caches password sessions` makes a new one):\n{URL}\nREDIS_URL set on api\n"
        ));
    let requests = api.requests();
    assert_eq!(format!("{} {}", requests[1].method, requests[1].path), "POST /caches");
    assert_eq!(serde_json::from_str::<Value>(&requests[1].body).unwrap(), json!({ "name": "sessions" }));
    assert_eq!(format!("{} {}", requests[3].method, requests[3].path), "PATCH /functions/f1/secrets");
    assert_eq!(serde_json::from_str::<Value>(&requests[3].body).unwrap(), json!({ "secrets": { "REDIS_URL": URL } }));
}

#[test]
fn create_refuses_a_name_elasticache_wouldnt_take_and_a_function_there_isnt_before_making_anything() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["caches", "create", "Sessions"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"Sessions\" can't be a cache's name: 1 to 40 lower-case letters"));
    ff(&dir)
        .args(["caches", "create", "sessions", "--secret-for", "missing"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("There is no function named \"missing\""));
    // Only the function's lookup: nothing reached POST /caches.
    let requests = api.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!((requests[0].method.as_str(), requests[0].path.starts_with("/functions")), ("GET", true));
}

#[test]
fn list_and_get_show_status_memory_and_connections_never_a_password() {
    let api = Server::start(vec![Reply::json(200, json!([cache("sessions")])), Reply::json(200, cache("sessions"))]);
    let dir = with_key(&api.url);

    ff(&dir).args(["caches", "list"]).assert().success().stdout(
        "NAME      STATUS     MEMORY           CONNECTIONS  CREATED (UTC)\nsessions  available  1.2 MB of 64 MB  2            2026-10-30 06:35:00\n",
    );
    let shown = ff(&dir).args(["caches", "get", "sessions"]).output().unwrap();
    let text = String::from_utf8_lossy(&shown.stdout);
    assert!(
        text.starts_with("sessions\nstatus      available\nmemory      1.2 MB of 64 MB; past it, the least recently used keys go\nconnections 2\naddress     rediss://default@cache.example.tn:6400\nengine      Valkey 9.1\n"),
        "{text}"
    );
    assert!(!text.contains(":pw@"), "{text}");
    assert_eq!(format!("{} {}", api.requests()[1].method, api.requests()[1].path), "GET /caches/sessions");
}

#[test]
fn password_gives_a_new_address_once_under_the_secret_name_asked() {
    let api = Server::start(vec![
        Reply::json(200, functions()),
        Reply::json(200, with_password("sessions")),
        Reply::json(200, functions()),
        Reply::json(200, json!({ "secrets": [] })),
    ]);

    ff(&with_key(&api.url))
        .args(["caches", "password", "sessions", "--secret-for", "api", "--secret-name", "SESSIONS_URL"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("sessions has a new password: its address, shown this once"))
        .stdout(predicate::str::contains("SESSIONS_URL set on api"));
    let requests = api.requests();
    assert_eq!(format!("{} {}", requests[1].method, requests[1].path), "POST /caches/sessions/password");
    assert_eq!(
        serde_json::from_str::<Value>(&requests[3].body).unwrap(),
        json!({ "secrets": { "SESSIONS_URL": URL } })
    );
}

#[test]
fn delete_asks_first_naming_itself_and_a_script_must_say_yes() {
    let api = Server::start(vec![]);
    ff(&with_key(&api.url))
        .args(["caches", "delete", "sessions"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff caches delete asks first, and there is no terminal to ask in: say --yes"));

    let api = Server::start(vec![Reply::json(204, json!(null))]);
    ff(&with_key(&api.url))
        .args(["caches", "delete", "sessions", "--yes"])
        .assert()
        .success()
        .stdout("deleted the cache sessions, with its keys\n");
    assert_eq!(format!("{} {}", api.requests()[0].method, api.requests()[0].path), "DELETE /caches/sessions");
}

#[test]
fn a_cache_not_there_says_so_in_the_apis_words() {
    let api = Server::start(vec![Reply::json(
        404,
        json!({ "statusCode": 404, "message": "The account has no cache sessions" }),
    )]);

    ff(&with_key(&api.url))
        .args(["caches", "get", "sessions"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("The account has no cache sessions"));
}
