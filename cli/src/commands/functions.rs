//! `ff list`, `ff get`, `ff history`, `ff scale` and `ff delete`: a function's settings, state
//! and calls, read and changed by its name.

use std::io::{self, BufRead, IsTerminal, Write};

use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::{Function, FunctionView, InvocationPage, Scaling, function_named};
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{first_line, table, time};

fn client(context: &Context) -> Result<Client, Error> {
    Client::new(&context.settings()?)
}

/// `0 to 3, to zero when idle`, or `2 to 5, 2 kept running`.
fn instances(min: u32, max: u32, scale_to_zero: bool) -> String {
    if scale_to_zero || min == 0 {
        format!("{min} to {max}, to zero when idle")
    } else {
        format!("{min} to {max}, {min} kept running")
    }
}

pub fn list(context: &Context) -> Result<(), Error> {
    let functions: Vec<Function> = client(context)?.json(&Call::get("/functions"))?;
    let views: Vec<FunctionView> = functions.iter().map(Function::view).collect();
    context.out.result(&views, || {
        if functions.is_empty() {
            return "No function yet: `ff deploy <file>` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = functions
            .iter()
            .map(|function| {
                vec![
                    function.name.clone(),
                    function.runtime.clone(),
                    format!("{} MB", function.memory),
                    format!("{} s", function.timeout),
                    function.status.clone(),
                    format!("{}-{}", function.min_instances, function.max_instances),
                    time(&function.updated_at),
                ]
            })
            .collect();
        table(&["NAME", "RUNTIME", "MEMORY", "TIMEOUT", "STATUS", "INSTANCES", "UPDATED (UTC)"], &rows)
    })
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let client = client(context)?;
    let found = function_named(&client, name)?;
    let function: Function = client.json(&Call::get(format!("/functions/{}", found.id)))?;
    context.out.result(&function.view(), || {
        let mut lines = vec![
            format!("name         {}", function.name),
            format!("id           {}", function.id),
            format!("runtime      {}", function.runtime),
        ];
        if let Some(handler) = &function.handler {
            lines.push(format!("handler      {handler}"));
        }
        lines.extend([
            format!("memory       {} MB", function.memory),
            format!("timeout      {} s", function.timeout),
            format!("status       {}", function.status),
        ]);
        if let Some(error) = &function.error {
            lines.push(format!("error        {error}"));
        }
        if let Some(format) = &function.event_format {
            lines.push(format!("event        {format}"));
        }
        lines.push(format!(
            "instances    {}",
            instances(function.min_instances, function.max_instances, function.scale_to_zero)
        ));
        lines.push(format!("code         {}", code(&function)));
        if let Some(environment) = function.environment.as_ref().filter(|environment| !environment.is_empty()) {
            lines.push(format!("environment  {}", environment.keys().cloned().collect::<Vec<_>>().join(", ")));
        }
        lines.push(format!("created      {} UTC", time(&function.created_at)));
        lines.push(format!("updated      {} UTC", time(&function.updated_at)));
        lines.join("\n")
    })
}

/// Its code: how it comes, its size and its SHA-256, as AWS Lambda gives them, where the API does.
fn code(function: &Function) -> String {
    match (&function.package_type, &function.code_sha256) {
        (Some(package), Some(sha256)) => format!("{package}, {} bytes, SHA-256 {sha256}", function.code_size()),
        _ => format!("{} bytes", function.code_size()),
    }
}

pub fn history(name: &str, limit: u32, context: &Context) -> Result<(), Error> {
    let client = client(context)?;
    let function = function_named(&client, name)?;
    let page: InvocationPage =
        client.json(&Call::get(format!("/functions/{}/invocations", function.id)).query("limit", limit))?;
    context.out.result(&page, || {
        if page.invocations.is_empty() {
            return format!("{name} has no call yet");
        }
        let rows: Vec<Vec<String>> = page
            .invocations
            .iter()
            .map(|call| {
                vec![
                    time(&call.created_at),
                    call.id.clone(),
                    call.status.clone(),
                    call.duration.map(|duration| format!("{duration} ms")).unwrap_or_default(),
                    call.source.clone().unwrap_or_default(),
                    call.error.as_deref().map(|error| first_line(error, 60)).unwrap_or_default(),
                ]
            })
            .collect();
        let shown = format!("{} of {} calls, newest first", page.invocations.len(), page.total);
        format!("{}\n{shown}", table(&["TIME (UTC)", "REQUEST ID", "STATUS", "DURATION", "SOURCE", "ERROR"], &rows))
    })
}

pub fn scale(name: &str, min: Option<u32>, max: Option<u32>, context: &Context) -> Result<(), Error> {
    if min.is_none() && max.is_none() {
        return Err(Error::new(
            Kind::Usage,
            "Say what changes: --min, the instances kept running, and --max, the most it runs",
        ));
    }
    let client = client(context)?;
    let function = function_named(&client, name)?;
    let mut body = Map::new();
    if let Some(min) = min {
        body.insert("minInstances".into(), min.into());
    }
    if let Some(max) = max {
        body.insert("maxInstances".into(), max.into());
    }
    let scaling: Scaling =
        client.json(&Call::put(format!("/functions/{}/scaling-config", function.id), Value::Object(body)))?;
    context.out.result(&scaling, || {
        format!("{name}: instances {}", instances(scaling.min_instances, scaling.max_instances, scaling.scale_to_zero))
    })
}

/// Whether to go on: asked in a terminal; a script says `--yes`. `command` names it when there is no terminal.
pub fn confirmed(command: &str, question: &str, yes: bool) -> Result<bool, Error> {
    if yes {
        return Ok(true);
    }
    if !io::stdin().is_terminal() {
        return Err(Error::new(
            Kind::Usage,
            format!("{command} asks first, and there is no terminal to ask in: say --yes"),
        ));
    }
    eprint!("{question} [y/N] ");
    let _ = io::stderr().flush();
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read the answer: {error}")))?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}

pub fn delete(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = client(context)?;
    let function = function_named(&client, name)?;
    if !confirmed("ff delete", &format!("Delete {name}, with its history and its logs?"), yes)? {
        return context.out.result(&json!({ "deleted": false, "name": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/functions/{}", function.id)))?;
    context.out.result(&json!({ "deleted": true, "name": name, "id": function.id }), || format!("deleted {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instances_say_whether_any_keep_running() {
        assert_eq!(instances(0, 3, true), "0 to 3, to zero when idle");
        assert_eq!(instances(2, 5, false), "2 to 5, 2 kept running");
    }
}
