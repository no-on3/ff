//! `ff db` against a scripted API: the connection string printed once, set as functions' secrets
//! with `--secret-for`, a name held to RDS's rule before any call, and a deletion asked first.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const STRING: &str =
    "postgresql://ff_0123456789abcdef01234567:pw@db.example.tn:5432/ff_0123456789abcdef01234567?sslmode=require";

fn database(name: &str) -> Value {
    json!({ "id": "d1", "name": name, "status": "active", "host": "db.example.tn", "port": 5432,
            "database": "ff_0123456789abcdef01234567", "user": "ff_0123456789abcdef01234567",
            "connectionUrl": "postgresql://ff_0123456789abcdef01234567@db.example.tn:5432/ff_0123456789abcdef01234567?sslmode=require",
            "sizeBytes": 7_634_423, "connections": 2, "connectionLimit": 10, "storageLimitMb": 1024,
            "passwordSetAt": "2026-10-23T06:35:00.000Z", "createdAt": "2026-10-23T06:35:00.000Z" })
}

fn with_password(name: &str) -> Value {
    let mut made = database(name);
    made.as_object_mut()
        .unwrap()
        .extend(json!({ "password": "pw", "connectionString": STRING }).as_object().unwrap().clone());
    made
}

fn functions() -> Value {
    json!([{ "id": "f1", "name": "api", "runtime": "nodejs", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

#[test]
fn create_prints_the_connection_string_once_and_sets_it_as_a_functions_secret() {
    let api = Server::start(vec![
        Reply::json(200, functions()),
        Reply::json(201, with_password("orders")),
        Reply::json(200, functions()),
        Reply::json(200, json!({ "secrets": [{ "name": "DATABASE_URL", "updatedAt": "2026-10-23T06:35:10.000Z" }] })),
    ]);

    ff(&with_key(&api.url))
        .args(["db", "create", "orders", "--secret-for", "api"])
        .assert()
        .success()
        .stdout(format!(
            "orders made: its connection string, shown this once (FF keeps no copy; `ff db password orders` makes a new one):\n{STRING}\nDATABASE_URL set on api\n"
        ));
    let requests = api.requests();
    assert_eq!(format!("{} {}", requests[1].method, requests[1].path), "POST /databases");
    assert_eq!(serde_json::from_str::<Value>(&requests[1].body).unwrap(), json!({ "name": "orders" }));
    assert_eq!(format!("{} {}", requests[3].method, requests[3].path), "PATCH /functions/f1/secrets");
    assert_eq!(
        serde_json::from_str::<Value>(&requests[3].body).unwrap(),
        json!({ "secrets": { "DATABASE_URL": STRING } })
    );
}

#[test]
fn create_refuses_a_name_rds_wouldnt_take_and_a_function_there_isnt_before_making_anything() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["db", "create", "Orders"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"Orders\" can't be a database's name: 1 to 63 lower-case letters"));
    ff(&dir)
        .args(["db", "create", "orders", "--secret-for", "missing"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("There is no function named \"missing\""));
    // Only the function's lookup: nothing reached POST /databases.
    let requests = api.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!((requests[0].method.as_str(), requests[0].path.starts_with("/functions")), ("GET", true));
}

#[test]
fn list_and_get_show_status_storage_and_sessions_never_a_password() {
    let api = Server::start(vec![
        Reply::json(200, json!([database("orders")])),
        Reply::json(200, json!([database("orders")])),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["db", "list"]).assert().success().stdout(
        "NAME    STATUS     STORAGE            SESSIONS  CREATED (UTC)\norders  available  7.3 MB of 1024 MB  2 of 10   2026-10-23 06:35:00\n",
    );
    let shown = ff(&dir).args(["db", "get", "orders"]).output().unwrap();
    let text = String::from_utf8_lossy(&shown.stdout);
    assert!(text.starts_with("orders\nstatus    available\nstorage   7.3 MB of the plan's 1024 MB\nsessions  2 of 10 at most\nhost      db.example.tn:5432\n"), "{text}");
    assert!(!text.contains(":pw@"), "{text}");
}

#[test]
fn password_gives_a_new_string_once_under_the_secret_name_asked() {
    let api = Server::start(vec![
        Reply::json(200, json!([database("orders")])),
        Reply::json(200, functions()),
        Reply::json(200, with_password("orders")),
        Reply::json(200, functions()),
        Reply::json(200, json!({ "secrets": [] })),
    ]);

    ff(&with_key(&api.url))
        .args(["db", "password", "orders", "--secret-for", "api", "--secret-name", "ORDERS_DB"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("orders has a new password: its connection string, shown this once"))
        .stdout(predicate::str::contains("ORDERS_DB set on api"));
    let requests = api.requests();
    assert_eq!(format!("{} {}", requests[2].method, requests[2].path), "POST /databases/d1/password");
    assert_eq!(
        serde_json::from_str::<Value>(&requests[4].body).unwrap(),
        json!({ "secrets": { "ORDERS_DB": STRING } })
    );
}

#[test]
fn delete_asks_first_naming_itself_and_a_script_must_say_yes() {
    let api = Server::start(vec![Reply::json(200, json!([database("orders")]))]);
    ff(&with_key(&api.url))
        .args(["db", "delete", "orders"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff db delete asks first, and there is no terminal to ask in: say --yes"));

    let api = Server::start(vec![Reply::json(200, json!([database("orders")])), Reply::json(200, json!(null))]);
    ff(&with_key(&api.url))
        .args(["db", "delete", "orders", "--yes"])
        .assert()
        .success()
        .stdout("deleted the database orders, with its data\n");
    assert_eq!(format!("{} {}", api.requests()[1].method, api.requests()[1].path), "DELETE /databases/d1");
}

#[test]
fn a_database_not_there_is_named_with_the_command_that_lists_them() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);

    ff(&with_key(&api.url)).args(["db", "get", "orders"]).assert().failure().stderr(predicate::str::contains(
        "There is no database named \"orders\" in the account: `ff db list` shows its databases",
    ));
}
