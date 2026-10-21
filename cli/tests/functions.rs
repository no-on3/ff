//! The commands on functions against a scripted API: what they send, what they print, and the
//! exit codes a script reads.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const CODE: &str =
    "def handler(event, context):\n    return {\"message\": \"Hello \" + event.get(\"name\", \"world\")}\n";

fn function(code: &str) -> Value {
    json!({
        "id": "f1", "name": "hello", "accountId": "123456789012", "runtime": "python", "code": code, "memory": 128, "timeout": 5,
        "status": "ACTIVE", "eventFormat": "lambda", "metadata": null, "error": null, "minInstances": 0, "maxInstances": 3,
        "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:05:00.000Z"
    })
}

/// A folder with hello.py holding `code`.
fn project(code: &str) -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("hello.py"), code).unwrap();
    dir
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn deploy_creates_a_function_the_account_lacks_with_the_files_name_and_runtime() {
    let api = Server::start(vec![Reply::json(200, json!([])), Reply::json(201, function(CODE))]);
    let code = project(CODE);

    ff(&with_key(&api.url)).args(["deploy", code.path().join("hello.py").to_str().unwrap()]).assert().success().stdout(
        predicate::str::is_match(r"^created hello \(python, 128 MB, 5 s\): ACTIVE in \d+(\.\d)? s\n$").unwrap(),
    );

    let requests = api.requests();
    assert_eq!((requests[0].method.as_str(), requests[0].path.as_str()), ("GET", "/functions?name=hello"));
    assert_eq!((requests[1].method.as_str(), requests[1].path.as_str()), ("POST", "/functions"));
    assert_eq!(
        body(&requests[1]),
        json!({ "name": "hello", "runtime": "python", "code": CODE, "memory": 128, "timeout": 5 })
    );
}

#[test]
fn deploy_updates_only_what_changed_and_says_so() {
    let new_code = CODE.replace("Hello", "Ahlan");
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, function(&new_code))]);
    let code = project(&new_code);

    ff(&with_key(&api.url))
        .args(["deploy", code.path().join("hello.py").to_str().unwrap(), "--memory", "128"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("updated hello (python, 128 MB, 5 s): ACTIVE in")
                .and(predicate::str::contains(", changed: code\n")),
        );

    let requests = api.requests();
    assert_eq!((requests[1].method.as_str(), requests[1].path.as_str()), ("PUT", "/functions/f1"));
    assert_eq!(body(&requests[1]), json!({ "code": new_code }));
}

#[test]
fn deploy_sends_nothing_when_nothing_changed() {
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)]))]);
    let code = project(CODE);

    ff(&with_key(&api.url))
        .args(["deploy", code.path().join("hello.py").to_str().unwrap()])
        .assert()
        .success()
        .stdout("hello: no changes (python, 128 MB, 5 s, ACTIVE)\n");
    assert_eq!(api.requests().len(), 1);
}

#[test]
fn deploy_updates_the_function_another_deploy_made_meanwhile() {
    let api = Server::start(vec![
        Reply::json(200, json!([])),
        Reply::json(
            409,
            json!({ "statusCode": 409, "message": "A function named \"hello\" already exists in this account" }),
        ),
        Reply::json(200, json!([function("old")])),
        Reply::json(200, function(CODE)),
    ]);
    let code = project(CODE);

    ff(&with_key(&api.url))
        .args(["deploy", code.path().join("hello.py").to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("updated hello"));
    let methods: Vec<String> =
        api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect();
    assert_eq!(
        methods,
        ["GET /functions?name=hello", "POST /functions", "GET /functions?name=hello", "PUT /functions/f1"]
    );
}

#[test]
fn a_deploy_whose_code_fails_to_load_exits_4_with_the_diagnosis() {
    let api = Server::start(vec![
        Reply::json(200, json!([])),
        Reply::json(
            400,
            json!({ "statusCode": 400, "error": "Bad Request", "message": "The function failed to load: SyntaxError: invalid syntax (function.py, line 1)", "functionId": "f1", "requestId": "r1" }),
        ),
    ]);
    let code = project("def handler(:\n");

    ff(&with_key(&api.url)).args(["deploy", code.path().join("hello.py").to_str().unwrap()]).assert().code(4).stderr(
        predicate::str::contains(
            "error: The function failed to load: SyntaxError: invalid syntax (function.py, line 1)\nrequest ID: r1",
        ),
    );
}

#[test]
fn deploy_refuses_a_name_outside_lambdas_rule_before_calling() {
    let api = Server::start(vec![]);
    let code = project(CODE);

    ff(&with_key(&api.url))
        .args(["deploy", code.path().join("hello.py").to_str().unwrap(), "--name", "my function"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"my function\" can't be a function's name"));
    assert!(api.requests().is_empty());
}

#[test]
fn deploy_then_sets_the_instances_asked_for() {
    let api = Server::start(vec![
        Reply::json(200, json!([function(CODE)])),
        Reply::json(200, json!({ "minInstances": 1, "maxInstances": 5, "scaleToZero": false })),
    ]);
    let code = project(CODE);

    let output = ff(&with_key(&api.url))
        .args([
            "deploy",
            code.path().join("hello.py").to_str().unwrap(),
            "--min-instances",
            "1",
            "--max-instances",
            "5",
            "--output",
            "json",
        ])
        .output()
        .unwrap();

    assert!(output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        (
            printed["action"].as_str(),
            printed["function"]["minInstances"].as_u64(),
            printed["function"]["maxInstances"].as_u64()
        ),
        (Some("unchanged"), Some(1), Some(5))
    );
    assert_eq!(printed["function"].get("code"), None);
    let requests = api.requests();
    assert_eq!((requests[1].method.as_str(), requests[1].path.as_str()), ("PUT", "/functions/f1/scaling-config"));
    assert_eq!(body(&requests[1]), json!({ "minInstances": 1, "maxInstances": 5 }));
}

fn invocation() -> Value {
    json!({ "id": "7d1e5c1a", "functionId": "f1", "status": "COMPLETED", "source": "api", "duration": 12, "memoryUsed": 36,
            "input": { "name": "Tunis" }, "output": { "message": "Hello Tunis" }, "createdAt": "2026-10-21T09:10:00.000Z" })
}

#[test]
fn invoke_prints_the_answer_and_how_the_call_went() {
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(201, invocation())]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello", "--data", r#"{"name": "Tunis"}"#])
        .assert()
        .success()
        .stdout("{\n  \"message\": \"Hello Tunis\"\n}\nrequest 7d1e5c1a · 12 ms · 36 MB\n");
    let requests = api.requests();
    assert_eq!((requests[1].method.as_str(), requests[1].path.as_str()), ("POST", "/functions/f1/invoke"));
    assert_eq!(body(&requests[1]), json!({ "input": { "name": "Tunis" } }));
}

#[test]
fn invoke_raw_prints_the_answer_only_and_takes_the_event_from_stdin() {
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(201, invocation())]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello", "--data", "-", "--raw"])
        .write_stdin("{\"name\": \"Tunis\"}")
        .assert()
        .success()
        .stdout("{\"message\":\"Hello Tunis\"}\n");
}

#[test]
fn a_call_that_timed_out_exits_5_with_its_request_id() {
    let api = Server::start(vec![
        Reply::json(200, json!([function(CODE)])),
        Reply::json(
            400,
            json!({ "statusCode": 400, "error": "Bad Request", "message": "Sandbox.Timedout: Task timed out after 5.00 seconds",
                                 "invocation": { "id": "inv-9", "status": "TIMEOUT", "duration": 5003 }, "requestId": "http-1" }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello"])
        .assert()
        .code(5)
        .stderr("error: Sandbox.Timedout: Task timed out after 5.00 seconds\nrequest ID: inv-9\n");
    assert_eq!(body(&api.requests()[1]), json!({}));
}

#[test]
fn a_call_refused_for_the_rate_or_the_credit_exits_6() {
    let api = Server::start(vec![
        Reply::json(200, json!([function(CODE)])),
        Reply::json(
            402,
            json!({ "statusCode": 402, "message": "The account's balance has been below its buffer for 24 hours: top up to call functions again" }),
        ),
    ]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello"])
        .assert()
        .code(6)
        .stderr(predicate::str::contains("top up to call functions again"));
}

#[test]
fn invoke_refuses_an_event_that_isnt_json_before_calling() {
    let api = Server::start(vec![]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello", "--data", "{name: x}"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("The event in --data isn't JSON"));
    assert!(api.requests().is_empty());
}

#[test]
fn a_function_the_account_lacks_is_named_as_missing() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);

    ff(&with_key(&api.url))
        .args(["get", "nope"])
        .assert()
        .code(3)
        .stderr("error: There is no function named \"nope\" in the account: `ff list` shows its functions\n");
}

#[test]
fn list_shows_a_table_and_json_without_the_code() {
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, json!([function(CODE)]))]);
    let dir = with_key(&api.url);

    ff(&dir).arg("list").assert().success().stdout(
        "NAME   RUNTIME  MEMORY  TIMEOUT  STATUS  INSTANCES  UPDATED (UTC)\nhello  python   128 MB  5 s      ACTIVE  0-3        2026-10-21 09:05:00\n",
    );
    let output = ff(&dir).args(["list", "--output", "json"]).output().unwrap();
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed[0]["codeSize"], CODE.len());
    assert_eq!(printed[0].get("code"), None);
}

#[test]
fn get_shows_the_function_with_its_error_and_its_variables_names() {
    let mut broken = function(CODE);
    broken["status"] = json!("ERROR");
    broken["error"] = json!("The function failed to load: NameError: name 'x' is not defined");
    broken["environment"] = json!({ "TABLE_NAME": "orders", "LOG_LEVEL": "info" });
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, broken)]);

    ff(&with_key(&api.url)).args(["get", "hello"]).assert().success().stdout(
        predicate::str::contains(
            "status       ERROR\nerror        The function failed to load: NameError: name 'x' is not defined\nevent        lambda\n\
             instances    0 to 3, to zero when idle\n",
        )
        .and(predicate::str::contains("environment  LOG_LEVEL, TABLE_NAME\n"))
        // From an API before packages, which gives neither the handler nor the code's hash: its inline code's size.
        .and(predicate::str::contains(format!("code         {} bytes\n", CODE.len())))
        .and(predicate::str::contains("handler").not()),
    );
    assert_eq!(api.requests()[1].path, "/functions/f1");
}

#[test]
fn get_shows_the_handler_and_the_code_as_aws_lambda_describes_them() {
    let mut described = function(CODE);
    described["packageType"] = json!("inline");
    described["handler"] = json!("function.lambda_handler");
    described["codeSha256"] = json!("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    described["codeSize"] = json!(4096);
    let api = Server::start(vec![
        Reply::json(200, json!([function(CODE)])),
        Reply::json(200, described.clone()),
        Reply::json(200, json!([function(CODE)])),
        Reply::json(200, described),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["get", "hello"]).assert().success().stdout(
        predicate::str::contains("runtime      python\nhandler      function.lambda_handler\nmemory       128 MB\n")
            .and(predicate::str::contains(
                "code         inline, 4096 bytes, SHA-256 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n",
            )),
    );
    let output = ff(&dir).args(["get", "hello", "--output", "json"]).output().unwrap();
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        [&printed["packageType"], &printed["handler"], &printed["codeSize"], &printed["codeSha256"]],
        [
            &json!("inline"),
            &json!("function.lambda_handler"),
            &json!(4096),
            &json!("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")
        ]
    );
}

#[test]
fn history_lists_the_calls_with_their_request_ids() {
    let page = json!({ "invocations": [invocation(), { "id": "inv-9", "status": "ERROR", "source": "url", "duration": 3,
        "error": "Error: boom\n    at handler", "output": null, "createdAt": "2026-10-21T09:09:00.000Z" }], "total": 7 });
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, page)]);

    ff(&with_key(&api.url)).args(["history", "hello", "--limit", "2"]).assert().success().stdout(
        "TIME (UTC)           REQUEST ID  STATUS     DURATION  SOURCE  ERROR\n\
         2026-10-21 09:10:00  7d1e5c1a    COMPLETED  12 ms     api\n\
         2026-10-21 09:09:00  inv-9       ERROR      3 ms      url     Error: boom\n\
         2 of 7 calls, newest first\n",
    );
    assert_eq!(api.requests()[1].path, "/functions/f1/invocations?limit=2");
}

#[test]
fn scale_sets_what_it_is_given() {
    let api = Server::start(vec![
        Reply::json(200, json!([function(CODE)])),
        Reply::json(200, json!({ "minInstances": 2, "maxInstances": 5, "scaleToZero": false })),
    ]);

    ff(&with_key(&api.url))
        .args(["scale", "hello", "--min", "2", "--max", "5"])
        .assert()
        .success()
        .stdout("hello: instances 2 to 5, 2 kept running\n");
    assert_eq!(body(&api.requests()[1]), json!({ "minInstances": 2, "maxInstances": 5 }));
    ff(&with_key(&api.url)).args(["scale", "hello"]).assert().code(2);
}

#[test]
fn delete_asks_first_and_a_script_must_say_yes() {
    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, json!([function(CODE)]))]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["delete", "hello"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("there is no terminal to ask in: say --yes"));

    let api = Server::start(vec![Reply::json(200, json!([function(CODE)])), Reply::json(200, json!(null))]);
    ff(&with_key(&api.url)).args(["delete", "hello", "--yes"]).assert().success().stdout("deleted hello\n");
    assert_eq!(format!("{} {}", api.requests()[1].method, api.requests()[1].path), "DELETE /functions/f1");
}
