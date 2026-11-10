//! The tools: each one of ff's commands, its arguments the command's options it takes, described as clap describes
//! them for `--help`, so that nothing is written twice. A call is the command typed with those options, parsed by
//! clap as the shell's would be, and run with the server's profile into a buffer: its answer the command's JSON
//! document, its error the command's own.

use std::any::TypeId;
use std::panic::{self, AssertUnwindSafe};

use clap::{Arg, ArgAction, Command as Spec, CommandFactory, Parser};
use serde_json::{Map, Value, json};

use crate::cli::Cli;
use crate::commands::{self, Context};
use crate::error::{Error, Kind};
use crate::output::{self, Output};

/// A tool: one of ff's commands and the options it takes from the tool's arguments.
pub struct Tool {
    name: &'static str,
    title: &'static str,
    /// The command's words, as typed after `ff`; a flag among them is always given, and describes the tool.
    command: &'static [&'static str],
    /// The command's options the tool takes, by clap's names, in the order the tool lists them.
    options: &'static [&'static str],
    /// The key a list, or a log's lines, goes under, as the protocol's structured content is an object.
    many: &'static str,
    effect: Effect,
}

/// What a tool's command does to the account, which its annotations tell the client; all but a read need
/// `--allow-write`.
#[derive(Clone, Copy, PartialEq)]
enum Effect {
    Reads,
    /// A version, a message: called twice, it adds twice.
    Adds,
    /// Code, variables, an alias, a site's files: called twice, the same as once.
    Replaces,
    /// A function's call, which may do anything.
    Runs,
}

use Effect::{Adds, Reads, Replaces, Runs};

const TOOLS: &[Tool] = &[
    Tool {
        name: "ff_list_functions",
        title: "Functions",
        command: &["list"],
        options: &[],
        many: "functions",
        effect: Reads,
    },
    Tool {
        name: "ff_get_function",
        title: "A function",
        command: &["get"],
        options: &["name"],
        many: "function",
        effect: Reads,
    },
    Tool {
        name: "ff_logs",
        title: "A function's logs",
        command: &["logs"],
        options: &["name", "tail", "since", "start", "end", "grep", "request_id", "all", "trace"],
        many: "lines",
        effect: Reads,
    },
    Tool {
        name: "ff_history",
        title: "A function's calls",
        command: &["history"],
        options: &["name", "limit"],
        many: "invocations",
        effect: Reads,
    },
    Tool {
        name: "ff_trace",
        title: "A request's trail",
        command: &["trace"],
        options: &["id"],
        many: "calls",
        effect: Reads,
    },
    Tool {
        name: "ff_metrics",
        title: "Metrics",
        command: &["metrics"],
        options: &["name", "period", "since"],
        many: "periods",
        effect: Reads,
    },
    Tool {
        name: "ff_usage",
        title: "Usage",
        command: &["usage"],
        options: &["month"],
        many: "functions",
        effect: Reads,
    },
    Tool { name: "ff_balance", title: "Balance", command: &["balance"], options: &[], many: "balance", effect: Reads },
    Tool {
        name: "ff_estimate",
        title: "The cost on AWS",
        command: &["usage", "--aws"],
        options: &["months", "without"],
        many: "months",
        effect: Reads,
    },
    Tool {
        name: "ff_list_queues",
        title: "Queues",
        command: &["queues", "list"],
        options: &[],
        many: "queues",
        effect: Reads,
    },
    Tool {
        name: "ff_get_queue",
        title: "A queue",
        command: &["queues", "get"],
        options: &["name"],
        many: "queue",
        effect: Reads,
    },
    Tool {
        name: "ff_list_buckets",
        title: "Buckets",
        command: &["buckets", "list"],
        options: &[],
        many: "buckets",
        effect: Reads,
    },
    Tool {
        name: "ff_get_bucket",
        title: "A bucket",
        command: &["buckets", "get"],
        options: &["name"],
        many: "bucket",
        effect: Reads,
    },
    Tool {
        name: "ff_list_databases",
        title: "Databases",
        command: &["db", "list"],
        options: &[],
        many: "databases",
        effect: Reads,
    },
    Tool {
        name: "ff_get_database",
        title: "A database",
        command: &["db", "get"],
        options: &["name"],
        many: "database",
        effect: Reads,
    },
    Tool {
        name: "ff_list_caches",
        title: "Caches",
        command: &["caches", "list"],
        options: &[],
        many: "caches",
        effect: Reads,
    },
    Tool {
        name: "ff_get_cache",
        title: "A cache",
        command: &["caches", "get"],
        options: &["name"],
        many: "cache",
        effect: Reads,
    },
    Tool {
        name: "ff_doctor",
        title: "Doctor",
        command: &["doctor"],
        options: &["path", "strict", "deployed", "parameter_overrides"],
        many: "findings",
        effect: Reads,
    },
    // The tools that change the account. `ff deploy`'s --yes isn't among its options, as it deletes what a template
    // no longer has without asking: without it, the command asks, which an agent can't answer, and stops.
    Tool {
        name: "ff_deploy",
        title: "Deploy",
        command: &["deploy"],
        options: &[
            "path",
            "name",
            "runtime",
            "handler",
            "container",
            "no_build",
            "memory",
            "timeout",
            "min_instances",
            "max_instances",
            "env",
            "publish",
            "alias",
            "stack_name",
            "parameter_overrides",
        ],
        many: "functions",
        effect: Replaces,
    },
    Tool {
        name: "ff_invoke",
        title: "Invoke",
        command: &["invoke"],
        options: &["name", "data", "http", "asynchronous", "dry_run", "headers"],
        many: "answer",
        effect: Runs,
    },
    Tool {
        name: "ff_set_env",
        title: "Set variables",
        command: &["env", "set"],
        options: &["name", "variables"],
        many: "variables",
        effect: Replaces,
    },
    Tool {
        name: "ff_publish",
        title: "Publish a version",
        command: &["publish"],
        options: &["name", "description"],
        many: "version",
        effect: Adds,
    },
    Tool {
        name: "ff_set_alias",
        title: "Set an alias",
        command: &["alias", "set"],
        options: &["function", "alias", "to", "also", "description"],
        many: "alias",
        effect: Replaces,
    },
    Tool {
        name: "ff_send_to_queue",
        title: "Send a message",
        command: &["queues", "send"],
        options: &["name", "body", "delay", "attributes"],
        many: "message",
        effect: Adds,
    },
    Tool {
        name: "ff_deploy_site",
        title: "Deploy a site",
        command: &["sites", "deploy"],
        options: &["bucket", "folder", "spa", "no_spa", "index_document", "error_document", "keep"],
        many: "files",
        effect: Replaces,
    },
];

/// The tool of that name.
pub fn named(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// The tools that change the account, which `--allow-write` runs.
pub fn writing() -> Vec<&'static str> {
    TOOLS.iter().filter(|tool| tool.effect != Reads).map(|tool| tool.name).collect()
}

/// Each tool as `tools/list` gives it, from ff itself: no API, so that a client starts before any login, offline.
pub fn definitions() -> Vec<Value> {
    let cli = Cli::command();
    TOOLS.iter().map(|tool| definition(tool, &cli)).collect()
}

fn definition(tool: &Tool, cli: &Spec) -> Value {
    let command = spec(tool, cli);
    let mut properties = Map::new();
    let mut required = Vec::new();
    for id in tool.options {
        let arg = option(command, id);
        properties.insert(argument_name(id), schema(tool, arg));
        if arg.is_required_set() {
            required.push(argument_name(id));
        }
    }
    let mut input = json!({ "type": "object", "properties": properties, "additionalProperties": false });
    if !required.is_empty() {
        input["required"] = json!(required);
    }
    json!({
        "name": tool.name,
        "title": tool.title,
        "description": description(tool, command),
        "inputSchema": input,
        "annotations": annotations(tool.effect),
    })
}

/// What the protocol's hints say of a tool: whether it changes anything, replaces what was there, and does the same
/// when called again; each reaches the account, a world outside the agent's.
fn annotations(effect: Effect) -> Value {
    let (read_only, destructive, idempotent) = match effect {
        Reads => (true, false, true),
        Adds => (false, false, false),
        Replaces => (false, true, true),
        Runs => (false, true, false),
    };
    json!({ "readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": true })
}

/// The command a tool runs, as clap knows it.
fn spec<'a>(tool: &Tool, cli: &'a Spec) -> &'a Spec {
    words(tool).fold(cli, |command, word| {
        command.find_subcommand(word).unwrap_or_else(|| panic!("{} runs ff {word}, which ff hasn't", tool.name))
    })
}

/// The command's words, without the flags the tool always gives.
fn words(tool: &Tool) -> impl Iterator<Item = &'static str> {
    tool.command.iter().copied().filter(|word| !word.starts_with('-'))
}

fn option<'a>(command: &'a Spec, id: &str) -> &'a Arg {
    command
        .get_arguments()
        .find(|arg| arg.get_id() == id)
        .unwrap_or_else(|| panic!("ff {} has no option {id}", command.get_name()))
}

/// The command's own description; a tool that always gives a flag, the flag's. Its clause on a flag the tool
/// neither gives nor takes is left out, as that flag is another tool's: `ff usage`'s "with --aws" is the estimate's.
fn description(tool: &Tool, command: &Spec) -> String {
    let help = match given_flags(tool).next() {
        Some(long) => command.get_arguments().find(|arg| arg.get_long() == Some(long)).and_then(Arg::get_help),
        None => command.get_about(),
    };
    let help = help.map(ToString::to_string).unwrap_or_default();
    match help.split_once("; with --") {
        Some((before, after)) if !takes_flag(tool, command, after.split([',', ' ']).next().unwrap_or(after)) => {
            before.to_owned()
        }
        _ => help,
    }
}

/// The flags a tool always gives, without their dashes.
fn given_flags(tool: &Tool) -> impl Iterator<Item = &'static str> {
    tool.command.iter().filter_map(|word| word.strip_prefix("--"))
}

fn takes_flag(tool: &Tool, command: &Spec, long: &str) -> bool {
    given_flags(tool).any(|given| given == long)
        || tool.options.iter().any(|id| option(command, id).get_long() == Some(long))
}

/// An option's help as the tool's: "With --aws, " is said of each of the estimate's, which always gives it.
fn option_help(tool: &Tool, arg: &Arg) -> Option<String> {
    let help = arg.get_help()?.to_string();
    let given = given_flags(tool).find_map(|long| help.strip_prefix(&format!("With --{long}, ")).map(str::to_owned));
    Some(match given {
        Some(rest) => rest.chars().take(1).flat_map(char::to_uppercase).chain(rest.chars().skip(1)).collect(),
        None => help,
    })
}

/// An option's name among a tool's arguments: camelCase, as FF's JSON names are.
fn argument_name(id: &str) -> String {
    let mut words = id.split('_');
    let first = words.next().unwrap_or_default().to_owned();
    words.fold(first, |name, word| {
        let mut letters = word.chars();
        match letters.next() {
            Some(letter) => name + &letter.to_uppercase().collect::<String>() + letters.as_str(),
            None => name,
        }
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Boolean,
    Integer,
    Text,
    Texts,
}

fn shape(arg: &Arg) -> Shape {
    if matches!(arg.get_action(), ArgAction::SetTrue) {
        return Shape::Boolean;
    }
    if matches!(arg.get_action(), ArgAction::Append) || arg.get_num_args().is_some_and(|count| count.max_values() > 1) {
        return Shape::Texts;
    }
    let parsed = arg.get_value_parser().type_id();
    let whole =
        [TypeId::of::<u8>(), TypeId::of::<u16>(), TypeId::of::<u32>(), TypeId::of::<u64>(), TypeId::of::<usize>()];
    if whole.iter().chain(&[TypeId::of::<i32>(), TypeId::of::<i64>()]).any(|t| parsed == *t) {
        Shape::Integer
    } else {
        Shape::Text
    }
}

/// How many values an option takes each time it is given, when it takes more than one: `--http GET /orders`.
fn fixed_count(arg: &Arg) -> Option<usize> {
    let range = arg.get_num_args()?;
    (range.min_values() == range.max_values() && range.max_values() > 1).then(|| range.max_values())
}

/// An option's JSON schema: its type, its help, its default, the values it takes.
fn schema(tool: &Tool, arg: &Arg) -> Value {
    let shape = shape(arg);
    let mut schema = match shape {
        Shape::Boolean => json!({ "type": "boolean" }),
        Shape::Integer => json!({ "type": "integer" }),
        Shape::Text => json!({ "type": "string" }),
        Shape::Texts => json!({ "type": "array", "items": { "type": "string" } }),
    };
    if let Some(help) = option_help(tool, arg) {
        schema["description"] = json!(help);
    }
    if let Some(count) = fixed_count(arg) {
        (schema["minItems"], schema["maxItems"]) = (json!(count), json!(count));
    }
    let values: Vec<String> = arg.get_possible_values().iter().map(|value| value.get_name().to_owned()).collect();
    match shape {
        _ if values.is_empty() => {}
        Shape::Text => schema["enum"] = json!(values),
        Shape::Texts => schema["items"]["enum"] = json!(values),
        Shape::Boolean | Shape::Integer => {}
    }
    if let [default] = arg.get_default_values() {
        let default = default.to_string_lossy();
        match shape {
            Shape::Integer => {
                if let Ok(number) = default.parse::<u64>() {
                    schema["default"] = json!(number);
                }
            }
            Shape::Text => schema["default"] = json!(default),
            Shape::Boolean | Shape::Texts => {}
        }
    }
    schema
}

/// The tool's answer to a call: the command run with the arguments given, or why they can't be.
pub fn call(tool: &Tool, arguments: &Map<String, Value>, allow_write: bool, context: &Context) -> Value {
    if tool.effect != Reads && !allow_write {
        let why = format!(
            "{} changes the account, and ff mcp runs such a tool only when started with --allow-write: the developer \
             adds it to ff mcp's line in the agent's settings",
            tool.name
        );
        return answered(None, Vec::new(), Some(Error::usage(why)));
    }
    let cli = Cli::command();
    let typed = match command_line(tool, spec(tool, &cli), arguments) {
        Ok(typed) => typed,
        Err(why) => return answered(None, Vec::new(), Some(Error::usage(why))),
    };
    let command = match Cli::try_parse_from(&typed) {
        Ok(parsed) => parsed.command,
        Err(refused) => return answered(None, Vec::new(), Some(Error::usage(clap_says(&refused)))),
    };
    let (out, buffer) = Output::buffered();
    let run = || commands::run(command, &Context { connection: context.connection, out: &out });
    let outcome = panic::catch_unwind(AssertUnwindSafe(run)).unwrap_or_else(|_| {
        Err(Error::new(Kind::Failed, format!("{} stopped on a fault of ff's own, said on ff mcp's stderr", tool.name)))
    });
    answered(document(&buffer.text(), tool.many), buffer.warnings(), outcome.err())
}

/// The command as typed: `ff`, its words, each option given, then `--` and the values that aren't options', in
/// clap's order, so that a value is never read as a flag.
fn command_line(tool: &Tool, command: &Spec, arguments: &Map<String, Value>) -> Result<Vec<String>, String> {
    let names: Vec<String> = tool.options.iter().map(|id| argument_name(id)).collect();
    if let Some(unknown) = arguments.keys().find(|key| !names.contains(key)) {
        return Err(match names.is_empty() {
            true => format!("{} takes no arguments, and was given {unknown}", tool.name),
            false => format!("{} takes no argument {unknown}: it takes {}", tool.name, names.join(", ")),
        });
    }
    let mut typed: Vec<String> = ["ff"].iter().chain(tool.command).map(|word| word.to_string()).collect();
    let mut positionals = Vec::new();
    for (id, name) in tool.options.iter().zip(&names) {
        let arg = option(command, id);
        let Some(value) = arguments.get(name).filter(|value| !value.is_null()) else { continue };
        let wrong = |what: &str| format!("{}'s {name} is {what}", tool.name);
        let given: Vec<String> = match shape(arg) {
            Shape::Boolean => match value.as_bool() {
                Some(true) => Vec::new(),
                Some(false) => continue,
                None => return Err(wrong("true or false")),
            },
            Shape::Integer => vec![value.as_u64().ok_or_else(|| wrong("a whole number"))?.to_string()],
            Shape::Text => vec![value.as_str().ok_or_else(|| wrong("text"))?.to_owned()],
            Shape::Texts => {
                let texts =
                    value.as_array().and_then(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>());
                let texts: Vec<String> =
                    texts.ok_or_else(|| wrong("a list of texts"))?.into_iter().map(str::to_owned).collect();
                match fixed_count(arg) {
                    _ if texts.is_empty() => continue,
                    Some(count) if texts.len() != count => return Err(wrong(&format!("a list of {count} texts"))),
                    _ => texts,
                }
            }
        };
        match (arg.get_long(), fixed_count(arg)) {
            (Some(long), _) if given.is_empty() => typed.push(format!("--{long}")),
            (Some(long), Some(_)) => typed.extend([format!("--{long}")].into_iter().chain(given)),
            (Some(long), None) => typed.extend(given.iter().map(|value| format!("--{long}={value}"))),
            (None, _) => positionals.push((arg.get_index().unwrap_or(usize::MAX), given)),
        }
    }
    positionals.sort_by_key(|(index, _)| *index);
    if !positionals.is_empty() {
        typed.push("--".to_owned());
        typed.extend(positionals.into_iter().flat_map(|(_, values)| values));
    }
    Ok(typed)
}

/// clap's refusal, its first paragraph on one line, without its `error:` and its usage, which name the shell's flags.
fn clap_says(refused: &clap::Error) -> String {
    let rendered = refused.render().to_string();
    let first = rendered.split("\n\n").next().unwrap_or_default();
    let words: Vec<&str> = first.split_whitespace().collect();
    words.join(" ").trim_start_matches("error: ").to_owned()
}

/// What the command wrote, as one JSON object: its document, or its lines, or its list under the tool's key.
fn document(written: &str, many: &str) -> Option<Value> {
    let written = written.trim();
    if written.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(written).ok().or_else(|| {
        let lines: Result<Vec<Value>, _> = written.lines().map(serde_json::from_str).collect();
        lines.ok().map(Value::Array)
    });
    Some(match parsed {
        Some(Value::Object(document)) => Value::Object(document),
        Some(other) => json!({ many: other }),
        None => json!({ "text": written }),
    })
}

/// The protocol's result: the document as structured content and as text, as the specification asks of a tool that
/// answers with structure; the command's warnings beside it, which a terminal shows on stderr, as `warned`, since a
/// document may have its own `warnings`; a failure, the command's error, as `--output json` writes it.
fn answered(document: Option<Value>, warnings: Vec<String>, error: Option<Error>) -> Value {
    let failed = error.is_some();
    let mut structured = document.unwrap_or_else(|| json!({}));
    if !warnings.is_empty() {
        structured["warned"] = json!(warnings);
    }
    if let Some(error) = error {
        structured["error"] = output::error_document(&error)["error"].take();
    }
    json!({
        "content": [{ "type": "text", "text": structured.to_string() }],
        "structuredContent": structured,
        "isError": failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command line a call types, which clap must take as typed.
    fn typed(tool: &str, arguments: Value) -> Result<Vec<String>, String> {
        let (cli, tool) = (Cli::command(), named(tool).unwrap());
        let typed = command_line(tool, spec(tool, &cli), arguments.as_object().unwrap())?;
        Cli::try_parse_from(&typed).unwrap_or_else(|refused| panic!("{typed:?}: {refused}"));
        Ok(typed)
    }

    fn defined(name: &str) -> Value {
        definitions().into_iter().find(|tool| tool["name"] == name).unwrap()
    }

    #[test]
    fn a_description_speaks_of_the_tool_s_arguments_not_of_flags_another_tool_gives() {
        assert_eq!(defined("ff_usage")["description"], "Show a month's usage per function, with its estimated cost");
        assert!(
            defined("ff_doctor")["description"]
                .as_str()
                .unwrap()
                .ends_with("; with --deployed, what in the account still points at FF")
        );
        let months = &defined("ff_estimate")["inputSchema"]["properties"]["months"];
        assert_eq!(months["description"], "How many months, this one so far last [default: 3]");
        assert_eq!(months["type"], "integer");
    }

    #[test]
    fn a_call_is_its_command_typed_its_options_as_flags_and_its_values_after_a_double_dash() {
        assert_eq!(
            typed(
                "ff_doctor",
                json!({ "parameterOverrides": ["Stage=prod", "Env=-x"], "strict": true, "deployed": false })
            )
            .unwrap(),
            ["ff", "doctor", "--strict", "--parameter-overrides=Stage=prod", "--parameter-overrides=Env=-x"]
        );
        assert_eq!(
            typed("ff_logs", json!({ "name": "-orders", "tail": 5, "requestId": "7d1e" })).unwrap(),
            ["ff", "logs", "--tail=5", "--request-id=7d1e", "--", "-orders"]
        );
        assert_eq!(typed("ff_estimate", json!({ "months": 6 })).unwrap(), ["ff", "usage", "--aws", "--months=6"]);
        assert_eq!(
            typed("ff_balance", json!({ "month": "2026-11" })).unwrap_err(),
            "ff_balance takes no arguments, and was given month"
        );
        assert_eq!(typed("ff_get_queue", json!({ "name": 7 })).unwrap_err(), "ff_get_queue's name is text");
        assert_eq!(
            typed("ff_doctor", json!({ "parameterOverrides": "Stage=prod" })).unwrap_err(),
            "ff_doctor's parameterOverrides is a list of texts"
        );
    }

    #[test]
    fn an_option_of_two_values_is_typed_once_with_both_and_the_values_go_in_clap_s_order_whatever_the_arguments_order()
    {
        assert_eq!(
            typed(
                "ff_invoke",
                json!({ "name": "orders", "http": ["GET", "/orders?status=new"], "headers": ["Accept: text/html"] })
            )
            .unwrap(),
            ["ff", "invoke", "--http", "GET", "/orders?status=new", "--header=Accept: text/html", "--", "orders"]
        );
        assert_eq!(
            typed("ff_set_alias", json!({ "to": "3", "alias": "live", "function": "orders", "also": ["4", "10%"] }))
                .unwrap(),
            ["ff", "alias", "set", "--also", "4", "10%", "--", "orders", "live", "3"]
        );
        assert_eq!(
            typed("ff_set_env", json!({ "variables": ["A=1", "B=2"], "name": "orders" })).unwrap(),
            ["ff", "env", "set", "--", "orders", "A=1", "B=2"]
        );
        assert_eq!(
            typed("ff_invoke", json!({ "name": "orders", "http": ["GET"] })).unwrap_err(),
            "ff_invoke's http is a list of 2 texts"
        );
        assert_eq!(
            typed("ff_deploy", json!({ "path": "app.py", "env": [] })).unwrap(),
            ["ff", "deploy", "--", "app.py"],
            "an empty list gives nothing"
        );
    }

    /// The commands without a tool for now: each could have one, a read or a change. Those that never may are
    /// `never_a_tool`'s.
    const WITHOUT_A_TOOL_YET: &[&str] = &[
        "init",
        "package",
        "scale",
        "versions",
        "alias list",
        "local invoke",
        "local start",
        "local run",
        "local mail",
        "local konnect",
        "env list",
        "url show",
        "url enable",
        "url disable",
        "domains list",
        "domains add",
        "domains verify",
        "schedule list",
        "schedule set",
        "schedule enable",
        "schedule disable",
        "async-config",
        "db create",
        "caches create",
        "email identities",
        "email add",
        "email get",
        "email verify",
        "email account",
        "email send",
        "email messages",
        "email suppressions",
        "email suppress",
        "buckets create",
        "buckets notify",
        "buckets notifications",
        "sites get",
        "sites metrics",
        "sites domains list",
        "sites domains add",
        "sites domains verify",
        "queues create",
        "queues metrics",
        "queues set",
        "queues receive",
        "event-sources add",
        "event-sources list",
        "event-sources get",
        "event-sources update",
        "export",
        "whoami",
        "accounts",
        "account",
        "version",
        "completion",
        "mcp",
    ];

    /// Why a command never gets a tool, whatever `--allow-write` says: an agent doesn't delete, hold a key or a
    /// secret, or log in as the developer.
    fn never_a_tool(words: &[&str]) -> Option<&'static str> {
        match words {
            [
                ..,
                "delete" | "delete-stack" | "delete-message" | "remove" | "unset" | "revoke" | "purge" | "reset"
                | "unsuppress",
            ] => Some("it deletes"),
            ["keys" | "api-keys", ..] | ["buckets", "keys", ..] => Some("it makes or lists keys"),
            ["secrets", ..] | ["db" | "caches", "password"] => Some("it sets or shows a secret"),
            ["login" | "logout"] | ["config", ..] => Some("it is the developer's login, or ff's settings"),
            _ => None,
        }
    }

    /// Each command ff runs, as its words: the commands without subcommands.
    fn commands(spec: &Spec, words: Vec<String>, found: &mut Vec<String>) {
        if spec.get_subcommands().next().is_none() {
            return found.push(words.join(" "));
        }
        for sub in spec.get_subcommands() {
            commands(sub, words.iter().cloned().chain([sub.get_name().to_owned()]).collect(), found);
        }
    }

    #[test]
    fn every_command_has_a_tool_or_is_said_to_have_none_and_none_that_deletes_or_holds_a_key_a_secret_or_the_login_has()
    {
        let mut all = Vec::new();
        commands(&Cli::command(), Vec::new(), &mut all);
        let tooled: Vec<String> = TOOLS.iter().map(|tool| words(tool).collect::<Vec<_>>().join(" ")).collect();
        for command in &all {
            let words: Vec<&str> = command.split(' ').collect();
            match never_a_tool(&words) {
                Some(why) => assert!(!tooled.contains(command), "ff {command} has a tool, which it mustn't: {why}"),
                None => assert!(
                    tooled.contains(command) || WITHOUT_A_TOOL_YET.contains(&command.as_str()),
                    "ff {command} has no tool and isn't among those without one: give it one, or say why not"
                ),
            }
        }
        for command in WITHOUT_A_TOOL_YET {
            assert!(all.iter().any(|known| known == command), "ff {command} isn't a command");
            assert!(!tooled.iter().any(|known| known == command), "ff {command} has a tool");
        }
        assert!(all.len() > 100, "{all:?}");
        assert!(TOOLS.iter().all(|tool| !tool.options.contains(&"yes")), "no tool deletes without asking");
    }

    #[test]
    fn what_a_command_wrote_is_one_object_its_document_its_list_or_its_lines_under_the_tool_s_key() {
        assert_eq!(document("{\n  \"name\": \"orders\"\n}\n", "function"), Some(json!({ "name": "orders" })));
        assert_eq!(
            document("[\n  {\"name\": \"a\"}\n]\n", "functions"),
            Some(json!({ "functions": [{ "name": "a" }] }))
        );
        assert_eq!(document("{\"m\":1}\n{\"m\":2}\n", "lines"), Some(json!({ "lines": [{ "m": 1 }, { "m": 2 }] })));
        assert_eq!(document("\n", "lines"), None);
    }

    #[test]
    fn the_command_s_warnings_are_beside_its_document_even_one_with_warnings_of_its_own() {
        let answer = answered(Some(json!({ "warnings": 0 })), vec!["FF_TOKEN is set".to_owned()], None);
        assert_eq!(answer["structuredContent"], json!({ "warnings": 0, "warned": ["FF_TOKEN is set"] }));
        assert_eq!(answer["isError"], false);
    }
}
