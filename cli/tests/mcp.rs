//! `ff mcp` over a pipe, as an AI coding agent runs it, against a scripted API: the tools listed without the API,
//! and each call the command run with the profile's key, answered with the command's document or its error.

mod common;

use common::{KEY, Reply, Server, ff, with_key};
use serde_json::{Value, json};
use tempfile::TempDir;

fn function() -> Value {
    json!({ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
            "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" })
}

fn line(second: u32, message: &str) -> Value {
    json!({ "time": format!("2026-10-21T09:00:{second:02}.123456000Z"), "instance": "fn-f1-7d9f8b6c5-x2x9q",
            "requestId": "0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f", "stream": "stdout", "message": message })
}

fn call(id: u32, tool: &str, arguments: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": arguments } })
}

/// The messages written to `ff mcp`'s stdin, its stdin then closed, and each line it answered on stdout.
fn session(dir: &TempDir, flags: &[&str], messages: &[Value]) -> Vec<Value> {
    let input: String = messages.iter().map(|message| format!("{message}\n")).collect();
    let output = ff(dir).args(flags).arg("mcp").write_stdin(input).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let answers = String::from_utf8(output.stdout).unwrap();
    answers.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[test]
fn a_session_lists_the_tools_without_the_api_then_calls_each_with_the_profile_s_key_and_flags() {
    let notice = json!({ "time": "2026-10-21T09:00:02.000000000Z", "instance": null, "requestId": null, "stream": "ff",
                         "message": "12 lines dropped: the account's limit is 2,000 lines a second" });
    let api = Server::start(vec![
        Reply::json(200, json!([function()])),
        Reply::json(200, json!([function()])),
        Reply::json(200, json!({ "lines": [line(1, "START"), notice, line(3, "greeting Tunis")], "next": null })),
    ]);
    let initialize = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "a test", "version": "1" } } });
    let answers = session(
        &with_key(&api.url),
        &["--account", "222222222222"],
        &[
            initialize,
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            call(3, "ff_list_functions", json!({})),
            call(4, "ff_logs", json!({ "name": "hello", "tail": 5 })),
        ],
    );

    let ids: Vec<&Value> = answers.iter().map(|answer| &answer["id"]).collect();
    assert_eq!(ids, [1, 2, 3, 4]);
    assert_eq!(answers[0]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(answers[1]["result"]["tools"][0]["name"], "ff_list_functions");

    let listed = &answers[2]["result"];
    assert_eq!(listed["isError"], false);
    assert_eq!(listed["structuredContent"]["functions"][0]["name"], "hello");
    assert_eq!(listed["structuredContent"]["functions"][0].get("code"), None);
    assert_eq!(
        serde_json::from_str::<Value>(listed["content"][0]["text"].as_str().unwrap()).unwrap(),
        listed["structuredContent"]
    );

    let logs = &answers[3]["result"]["structuredContent"];
    assert_eq!(logs, &json!({ "lines": [line(1, "START"), notice, line(3, "greeting Tunis")] }));

    let requests = api.requests();
    assert_eq!(requests.len(), 3, "tools/list asks the API nothing");
    assert_eq!(requests[2].path, "/functions/f1/logs?limit=5");
    for request in &requests {
        assert_eq!(request.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
        assert_eq!(request.header("x-ff-account"), Some("222222222222"));
    }
}

#[test]
fn a_failed_command_is_the_tool_s_error_its_message_and_exit_code_and_the_session_goes_on() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);
    let answers = session(
        &with_key(&api.url),
        &[],
        &[
            call(1, "ff_get_function", json!({ "name": "nope" })),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
        ],
    );

    let failed = &answers[0]["result"];
    assert_eq!(failed["isError"], true);
    assert_eq!(
        failed["structuredContent"]["error"],
        json!({ "message": "There is no function named \"nope\" in the account: `ff list` shows its functions",
                "exitCode": 3, "status": null, "requestId": null })
    );
    assert_eq!(answers[1], json!({ "jsonrpc": "2.0", "id": 2, "result": {} }));
}
