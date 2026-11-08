//! The developer tools' spike of `ff mcp`: an MCP server on stdio (JSON-RPC 2.0, one message a line) that lists one
//! tool, as `ff mcp` will list FF's, and writes every message it reads and sends to a log, with the time, so that what
//! a client asks (its protocol version, what it sends before tools/list, how it calls a tool) can be read afterwards.
//! The tool, `ff_functions`, answers a fixed list of functions; asked with `"fail": "tool"`, it answers a tool's error
//! (a result with isError), and with `"fail": "protocol"`, a JSON-RPC error, to see how a client shows each.
//!   mcp-spike [<log file>]      the log defaults to $FF_MCP_SPIKE_LOG, else hack/.spike-mcp/<client's pid>.jsonl
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// The protocol versions this server speaks, newest first: a client's own when it asks one of them, else the newest.
const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn tool() -> Value {
    json!({
        "name": "ff_functions",
        "title": "FF's functions",
        "description": "Lists the account's functions on FF, with their runtime and state.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "fail": { "type": "string", "enum": ["tool", "protocol"],
                          "description": "For the spike: answer a tool's error, or a protocol's" }
            },
            "additionalProperties": false
        }
    })
}

fn call(arguments: &Value) -> Result<Value, (i64, String)> {
    match arguments["fail"].as_str() {
        Some("tool") => Ok(json!({
            "content": [{ "type": "text", "text": "The API at https://api.ffunc.cloud refused the key: it was revoked" }],
            "isError": true
        })),
        Some("protocol") => Err((-32602, "fail: the spike's protocol error, as an unknown argument would be".into())),
        _ => Ok(json!({
            "content": [{ "type": "text", "text": "orders (nodejs, Active)\nthumbnails (python, Active)" }],
            "structuredContent": { "functions": [
                { "name": "orders", "runtime": "nodejs", "state": "Active" },
                { "name": "thumbnails", "runtime": "python", "state": "Active" }
            ] },
            "isError": false
        })),
    }
}

/// The answer to one message, or none for a notification.
fn answer(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message["method"].as_str().unwrap_or_default();
    let result = match method {
        "initialize" => {
            let asked = message["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "ff-mcp-spike", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "FF's functions, for the developer tools' spike."
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [tool()] })),
        "tools/call" if message["params"]["name"] == "ff_functions" => call(&message["params"]["arguments"]),
        "tools/call" => Err((-32602, format!("Unknown tool: {}", message["params"]["name"]))),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, text)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }),
    })
}

fn main() {
    let path = std::env::args().nth(1).or_else(|| std::env::var("FF_MCP_SPIKE_LOG").ok()).unwrap_or_else(|| {
        let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.spike-mcp");
        format!("{repo}/{}.jsonl", std::process::id())
    });
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&path).expect("the log");
    let mut record = |direction: &str, message: &Value| {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        writeln!(log, "{}", json!({ "at": at, "direction": direction, "message": message })).ok();
    };
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => {
                record("in", &message);
                answer(&message)
            }
            Err(error) => {
                record("in", &json!({ "unparsed": line }));
                Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": error.to_string() } }))
            }
        };
        if let Some(reply) = reply {
            record("out", &reply);
            let mut out = stdout.lock();
            writeln!(out, "{reply}").and_then(|()| out.flush()).expect("stdout");
        }
    }
    record("in", &json!({ "closed": true }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_version_asked_when_it_speaks_it_else_its_newest() {
        let ask = |version: &str| {
            answer(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": { "protocolVersion": version, "capabilities": {},
                                        "clientInfo": { "name": "test", "version": "1" } } }))
            .unwrap()["result"]["protocolVersion"]
                .clone()
        };
        assert_eq!(ask("2025-06-18"), "2025-06-18");
        assert_eq!(ask("2099-01-01"), VERSIONS[0]);
    }

    #[test]
    fn a_notification_has_no_answer() {
        assert_eq!(answer(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), None);
    }

    #[test]
    fn a_tools_error_is_a_result_and_a_protocols_an_error() {
        let call = |fail: &str| {
            answer(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                            "params": { "name": "ff_functions", "arguments": { "fail": fail } } }))
            .unwrap()
        };
        assert_eq!(call("tool")["result"]["isError"], true);
        assert_eq!(call("protocol")["error"]["code"], -32602);
        assert_eq!(call("none")["result"]["structuredContent"]["functions"][0]["name"], "orders");
    }

    #[test]
    fn an_unknown_method_is_not_found() {
        let reply = answer(&json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" })).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
    }
}
