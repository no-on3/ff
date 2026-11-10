//! `ff mcp`: ff's commands as the tools of a Model Context Protocol server, for an AI coding agent on the developer's
//! machine. JSON-RPC 2.0 on stdin and stdout, a message a line, as the protocol's stdio transport says: the
//! handshake, `ping`, `tools/list` and `tools/call`, at one version of the protocol. The server holds no state and
//! opens no port; each tool runs its command with the profile's token, as typed, into a buffer it answers with.

mod tools;

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::commands::Context;
use crate::error::Error;

/// The protocol's version this server speaks, which it answers a client asking for another with: the client then
/// goes on with it or stops.
pub const PROTOCOL_VERSION: &str = "2025-11-25";

// JSON-RPC's codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// A request refused before any tool ran: JSON-RPC's code and its message.
struct Refused {
    code: i64,
    message: String,
}

impl Refused {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Refused { code, message: message.into() }
    }
}

/// Answers each message read until the input ends, as a client closes it to stop the server. Stdin is the
/// protocol's meanwhile: a command that would read a value or an answer from it refuses instead.
pub fn serve(input: impl BufRead, mut output: impl Write, allow_write: bool, context: &Context) -> Result<(), Error> {
    let _held = crate::stdin::hold();
    let server = Server { allow_write, context };
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(answer) = server.answer(&line) {
            writeln!(output, "{answer}")?;
            output.flush()?;
        }
    }
    Ok(())
}

struct Server<'a> {
    allow_write: bool,
    context: &'a Context<'a>,
}

impl Server<'_> {
    /// The answer to one line: none for a notification, or for a response, as this server asks the client nothing.
    fn answer(&self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => return Some(refusal(Value::Null, Refused::new(PARSE_ERROR, format!("Not JSON: {error}")))),
        };
        let Some(message) = message.as_object() else {
            let why = "A message is one JSON-RPC object, a request or a notification: a batch isn't taken";
            return Some(refusal(Value::Null, Refused::new(INVALID_REQUEST, why)));
        };
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str);
        match (id, method) {
            (None, _) => None,
            (Some(_), None) if message.contains_key("result") || message.contains_key("error") => None,
            (Some(id), None) => Some(refusal(id, Refused::new(INVALID_REQUEST, "A request names its method"))),
            (Some(id), Some(method)) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                Some(match self.handled(method, &params) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err(refused) => refusal(id, refused),
                })
            }
        }
    }

    fn handled(&self, method: &str, params: &Value) -> Result<Value, Refused> {
        match method {
            "initialize" => Ok(initialized(self.allow_write)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools::definitions() })),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Err(Refused::new(INVALID_PARAMS, "tools/call names its tool, in params.name"));
                };
                let arguments = match params.get("arguments") {
                    None | Some(Value::Null) => serde_json::Map::new(),
                    Some(Value::Object(arguments)) => arguments.clone(),
                    Some(_) => return Err(Refused::new(INVALID_PARAMS, "A tool's arguments are a JSON object")),
                };
                let Some(tool) = tools::named(name) else {
                    return Err(Refused::new(INVALID_PARAMS, format!("Unknown tool: {name}; tools/list names ff's")));
                };
                Ok(tools::call(tool, &arguments, self.allow_write, self.context))
            }
            _ => Err(Refused::new(METHOD_NOT_FOUND, format!("Method not found: {method}"))),
        }
    }
}

fn refusal(id: Value, refused: Refused) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": refused.code, "message": refused.message } })
}

/// The handshake's answer, whichever version the client asked for: this server speaks one. Its instructions, which
/// a client gives the model, say where paths start and whether the tools that change the account run.
fn initialized(allow_write: bool) -> Value {
    let folder = std::env::current_dir().map(|folder| folder.display().to_string()).unwrap_or_else(|_| ".".into());
    let writing = tools::writing().join(", ");
    let writes = match allow_write {
        true => format!("The tools that change the account, {writing}, run: ff mcp was started with --allow-write."),
        false => format!(
            "The tools that change the account, {writing}, are refused: ff mcp was started without --allow-write, \
             which the developer adds to allow them."
        ),
    };
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "ff", "title": "FF", "version": env!("CARGO_PKG_VERSION") },
        "instructions": format!(
            "Each tool runs one of ff's commands with the developer's own login or key, as typed in a terminal in \
             {folder}, where relative paths start, and answers with the command's JSON document, and under `warned` \
             the warnings a terminal would show; a failed command answers with its error and its exit code. {writes} \
             No tool deletes, nor makes keys, sets secrets or logs in."
        ),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;

    use super::*;
    use crate::cli::ConnectionArgs;
    use crate::output::Output;

    /// The server's answers to the lines, in order, as a client reads them; the server started without
    /// --allow-write. No test here runs a command that calls the API, which would use the developer's own login:
    /// `tests/mcp.rs` does, against a scripted API.
    fn session(lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let (connection, out) = (ConnectionArgs::default(), Output::quiet());
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output, false, &Context { connection: &connection, out: &out }).unwrap();
        String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn call(id: i64, tool: &str, arguments: Value) -> Value {
        request(id, "tools/call", json!({ "name": tool, "arguments": arguments }))
    }

    #[test]
    fn the_handshake_at_its_version_a_client_asking_another_told_which_its_notification_unanswered_a_probe_refused() {
        let answers = session(&[
            request(1, "server/discover", json!({ "_meta": { "protocolVersion": "2026-07-28" } })),
            request(2, "initialize", json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {} })),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            request(3, "initialize", json!({ "protocolVersion": "2024-11-05", "capabilities": {} })),
            request(4, "ping", json!({})),
        ]);
        assert_eq!(answers.len(), 4, "a notification gets no answer: {answers:?}");
        assert_eq!(answers[0]["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(answers[1]["id"], 2);
        assert_eq!(answers[1]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(answers[1]["result"]["capabilities"], json!({ "tools": { "listChanged": false } }));
        assert_eq!(answers[1]["result"]["serverInfo"]["name"], "ff");
        assert_eq!(answers[2]["result"]["protocolVersion"], PROTOCOL_VERSION, "the one it speaks, not the one asked");
        assert_eq!(answers[3], json!({ "jsonrpc": "2.0", "id": 4, "result": {} }));
    }

    #[test]
    fn the_instructions_say_where_paths_start_and_whether_the_tools_that_change_the_account_run() {
        let folder = std::env::current_dir().unwrap().display().to_string();
        let refused = initialized(false)["instructions"].as_str().unwrap().to_owned();
        assert!(
            refused.contains(&format!("as typed in a terminal in {folder}, where relative paths start")),
            "{refused}"
        );
        assert!(
            refused.contains(
                "The tools that change the account, ff_deploy, ff_invoke, ff_set_env, ff_publish, \
                 ff_set_alias, ff_send_to_queue, ff_deploy_site, are refused: ff mcp was started without --allow-write"
            ),
            "{refused}"
        );
        let allowed = initialized(true)["instructions"].as_str().unwrap().to_owned();
        assert!(allowed.contains("ff_deploy_site, run: ff mcp was started with --allow-write."), "{allowed}");
        assert!(allowed.ends_with("No tool deletes, nor makes keys, sets secrets or logs in."), "{allowed}");
    }

    #[test]
    fn a_tool_that_changes_the_account_is_refused_without_allow_write_saying_so_before_its_command_runs() {
        let answers = session(&[call(1, "ff_publish", json!({ "name": "orders" }))]);
        let result = &answers[0]["result"];
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["structuredContent"]["error"]["message"],
            "ff_publish changes the account, and ff mcp runs such a tool only when started with --allow-write: the \
             developer adds it to ff mcp's line in the agent's settings"
        );
        assert_eq!(result["structuredContent"]["error"]["exitCode"], 2);
    }

    #[test]
    fn what_isn_t_a_request_is_refused_with_json_rpc_s_codes_and_a_response_is_left() {
        let input =
            "not json\n[1, 2]\n{\"jsonrpc\": \"2.0\", \"id\": 7}\n{\"jsonrpc\": \"2.0\", \"id\": 8, \"result\": {}}\n";
        let (connection, out) = (ConnectionArgs::default(), Output::quiet());
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output, false, &Context { connection: &connection, out: &out }).unwrap();
        let answers: Vec<Value> =
            String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let codes: Vec<(Value, Value)> =
            answers.iter().map(|a| (a["id"].clone(), a["error"]["code"].clone())).collect();
        assert_eq!(
            codes,
            [
                (Value::Null, json!(PARSE_ERROR)),
                (Value::Null, json!(INVALID_REQUEST)),
                (json!(7), json!(INVALID_REQUEST))
            ]
        );
    }

    #[test]
    fn tools_list_names_the_tools_each_with_its_schema_from_its_command_and_no_api_needed() {
        let answers = session(&[request(1, "tools/list", json!({}))]);
        let tools = answers[0]["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "ff_list_functions",
                "ff_get_function",
                "ff_logs",
                "ff_history",
                "ff_trace",
                "ff_metrics",
                "ff_usage",
                "ff_balance",
                "ff_estimate",
                "ff_list_queues",
                "ff_get_queue",
                "ff_list_buckets",
                "ff_get_bucket",
                "ff_list_databases",
                "ff_get_database",
                "ff_list_caches",
                "ff_get_cache",
                "ff_doctor",
                "ff_deploy",
                "ff_invoke",
                "ff_set_env",
                "ff_publish",
                "ff_set_alias",
                "ff_send_to_queue",
                "ff_deploy_site"
            ]
        );
        let logs = tools.iter().find(|tool| tool["name"] == "ff_logs").unwrap();
        assert_eq!(
            logs["description"],
            "Show a function's log lines: the newest of a window, every page of it, or the live tail; or a trace's, \
             across the functions it called"
        );
        let schema = &logs["inputSchema"];
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema.get("required").is_none(), "a trace's lines name no function");
        assert_eq!(
            schema["properties"]["name"],
            json!({ "type": "string", "description": "The function's name; with --trace, its lines of the trace alone" })
        );
        assert_eq!(schema["properties"]["trace"]["type"], "string");
        let trace = tools.iter().find(|tool| tool["name"] == "ff_trace").unwrap();
        assert_eq!(trace["inputSchema"]["required"], json!(["id"]));
        assert_eq!(trace["annotations"]["readOnlyHint"], true);
        assert_eq!(schema["properties"]["tail"]["type"], "integer");
        assert_eq!(schema["properties"]["tail"]["default"], 100);
        assert_eq!(schema["properties"]["requestId"]["type"], "string");
        assert_eq!(schema["properties"]["all"]["type"], "boolean");
        assert!(schema["properties"].get("follow").is_none(), "a tool's call ends: no live tail");
        assert_eq!(logs["annotations"]["readOnlyHint"], true);
        let doctor = tools.iter().find(|tool| tool["name"] == "ff_doctor").unwrap();
        assert_eq!(doctor["inputSchema"]["properties"]["parameterOverrides"]["type"], "array");
        assert_eq!(doctor["inputSchema"]["properties"]["path"]["default"], ".");
        let estimate = tools.iter().find(|tool| tool["name"] == "ff_estimate").unwrap();
        assert!(estimate["description"].as_str().unwrap().starts_with("The last months as FF counted them at AWS's"));
        let balance = tools.iter().find(|tool| tool["name"] == "ff_balance").unwrap();
        assert_eq!(
            balance["inputSchema"],
            json!({ "type": "object", "properties": {}, "additionalProperties": false })
        );
        let hints = |name: &str| &tools.iter().find(|tool| tool["name"] == name).unwrap()["annotations"];
        assert_eq!(
            hints("ff_deploy"),
            &json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": true })
        );
        assert_eq!(hints("ff_publish")["destructiveHint"], false);
        assert_eq!(hints("ff_invoke")["idempotentHint"], false);
        let deploy = tools.iter().find(|tool| tool["name"] == "ff_deploy").unwrap();
        assert!(deploy["inputSchema"]["properties"].get("yes").is_none(), "no delete without asking");
        assert_eq!(deploy["inputSchema"]["properties"]["runtime"]["enum"], json!(["nodejs", "python"]));
        let invoke = tools.iter().find(|tool| tool["name"] == "ff_invoke").unwrap();
        let http = &invoke["inputSchema"]["properties"]["http"];
        assert_eq!((&http["type"], &http["minItems"], &http["maxItems"]), (&json!("array"), &json!(2), &json!(2)));
    }

    #[test]
    fn a_tool_answers_with_its_command_s_json_document_as_structured_content_and_as_text() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("index.mjs"), "export const handler = async () => ({ ok: true });\n").unwrap();
        let path = folder.path().to_str().unwrap();
        let answers = session(&[call(1, "ff_doctor", json!({ "path": path }))]);
        let result = &answers[0]["result"];
        assert_eq!(result["isError"], false, "{result}");
        assert_eq!(result["structuredContent"]["errors"], 0);
        assert_eq!(result["content"][0]["type"], "text");
        let text: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, result["structuredContent"]);
    }

    #[test]
    fn a_failed_command_answers_as_a_tool_s_error_its_message_and_exit_code_as_ff_writes_them() {
        let answers = session(&[call(1, "ff_doctor", json!({ "path": "/nowhere/at/all" }))]);
        let result = &answers[0]["result"];
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["error"]["message"], "/nowhere/at/all isn't there");
        assert_eq!(result["structuredContent"]["error"]["exitCode"], 2);
        let text: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, result["structuredContent"]);
    }

    #[test]
    fn arguments_the_tool_or_its_command_refuses_are_a_tool_s_error_an_unknown_tool_json_rpc_s() {
        let answers = session(&[
            call(1, "ff_logs", json!({ "name": "orders", "follow": true })),
            call(2, "ff_logs", json!({ "name": "orders", "tail": "many" })),
            call(3, "ff_logs", json!({ "name": "orders", "since": "1h", "start": "2026-11-09T09:00:00Z" })),
            call(4, "ff_logs", json!({})),
            call(5, "ff_delete", json!({ "name": "orders" })),
            request(6, "tools/call", json!({ "name": "ff_logs", "arguments": ["orders"] })),
        ]);
        let said = |answer: &Value| {
            assert_eq!(answer["result"]["isError"], true, "{answer}");
            answer["result"]["structuredContent"]["error"]["message"].as_str().unwrap().to_owned()
        };
        assert_eq!(
            said(&answers[0]),
            "ff_logs takes no argument follow: it takes name, tail, since, start, end, grep, requestId, all, trace"
        );
        assert_eq!(said(&answers[1]), "ff_logs's tail is a whole number");
        assert!(
            said(&answers[2]).contains("'--since <SINCE>' cannot be used with '--start <START>'"),
            "{}",
            answers[2]
        );
        assert!(said(&answers[3]).contains("<NAME>"), "{}", answers[3]);
        assert_eq!(answers[4]["error"]["code"], INVALID_PARAMS);
        assert_eq!(answers[4]["error"]["message"], "Unknown tool: ff_delete; tools/list names ff's");
        assert_eq!(answers[5]["error"]["code"], INVALID_PARAMS);
    }
}
