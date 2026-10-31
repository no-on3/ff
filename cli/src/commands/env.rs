//! `ff env list|set|unset <name>`: a function's environment variables, as AWS Lambda's. They are
//! readable like its code; a value nobody should read back is a secret (`ff secrets`).

use std::collections::BTreeMap;
use std::io::{self, IsTerminal, Read};
use std::time::Instant;

use serde_json::{Value, json};

use super::Context;
use crate::api::types::{Function, function_named};
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::progress::Progress;

pub type Variables = BTreeMap<String, String>;

/// AWS Lambda's rule for a variable's name, which the API follows: a letter, then letters, digits
/// or underscores, two characters at least. The API also refuses the names Lambda and FF set.
pub fn is_variable_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() >= 2
        && bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// The names AWS Lambda sets itself, and FF's runtimes read, which a function's variables may not
/// be; and any name starting with `FF_`. The API refuses them; `ff local` refuses them too, before
/// they would change how the runtime runs. A test holds this list to the API's.
pub const RESERVED: [&str; 27] = [
    "_HANDLER",
    "_X_AMZN_TRACE_ID",
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "AWS_EXECUTION_ENV",
    "AWS_LAMBDA_FUNCTION_NAME",
    "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
    "AWS_LAMBDA_FUNCTION_VERSION",
    "AWS_LAMBDA_INITIALIZATION_TYPE",
    "AWS_LAMBDA_LOG_GROUP_NAME",
    "AWS_LAMBDA_LOG_STREAM_NAME",
    "AWS_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_LAMBDA_RUNTIME_API",
    "LAMBDA_TASK_ROOT",
    "LAMBDA_RUNTIME_DIR",
    "AWS_LAMBDA_MAX_CONCURRENCY",
    "AWS_LAMBDA_METADATA_API",
    "AWS_LAMBDA_METADATA_TOKEN",
    "FUNCTION_NAME",
    "FUNCTION_VERSION",
    "FUNCTION_MEMORY_LIMIT",
    "FUNCTION_TIMEOUT",
    "PORT",
    "PATH",
];

/// The names FF sets with a function's own key to its account's buckets, queues and mail, and why, which the API refuses
/// too. A test holds this list to the API's.
pub const ENDPOINTS_RESERVED: [(&str, &str); 3] = [
    ("AWS_ENDPOINT_URL_S3", "FF sets it, with the function's own key to its account's buckets"),
    ("AWS_ENDPOINT_URL_SQS", "FF sets it, with the function's own key to its account's queues"),
    ("AWS_ENDPOINT_URL_SESV2", "FF sets it, with the function's own key to its account's mail"),
];

/// Why a name can't be a variable's, in the API's words, or none.
pub fn reserved(name: &str) -> Option<String> {
    if RESERVED.contains(&name) {
        Some(format!("{name} is reserved: AWS Lambda or FF's runtime sets it"))
    } else if let Some((_, why)) = ENDPOINTS_RESERVED.iter().find(|(reserved, _)| *reserved == name) {
        Some(format!("{name} is reserved: {why}"))
    } else if name.starts_with("FF_") {
        Some(format!("{name} is reserved: names starting with FF_ are FF's own"))
    } else {
        None
    }
}

fn named(name: &str) -> Result<String, Error> {
    if is_variable_name(name) {
        Ok(name.to_owned())
    } else {
        Err(Error::usage(format!(
            "\"{name}\" can't be a variable's name: a letter, then letters, digits or underscores, two characters at least"
        )))
    }
}

/// `KEY=value`, the value possibly empty; a `KEY` alone has none, for the caller to read.
pub fn assignment(text: &str) -> Result<(String, Option<String>), Error> {
    match text.split_once('=') {
        Some((name, value)) => Ok((named(name)?, Some(value.to_owned()))),
        None => Ok((named(text)?, None)),
    }
}

/// `--env KEY=value`, repeated: every variable, a value required.
pub fn variables(assignments: &[String]) -> Result<Variables, Error> {
    let mut variables = Variables::new();
    for text in assignments {
        match assignment(text)? {
            (name, Some(value)) => {
                variables.insert(name, value);
            }
            (name, None) => return Err(Error::usage(format!("--env {name} has no value: --env {name}=<value>"))),
        }
    }
    Ok(variables)
}

/// A value from a prompt that doesn't show it, in a terminal, else the first line of stdin.
fn read_value(name: &str) -> Result<String, Error> {
    if io::stdin().is_terminal() {
        return rpassword::prompt_password(format!("{name} (not shown as you type it): "))
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read the value: {error}")));
    }
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read {name}'s value from stdin: {error}")))?;
    Ok(text.lines().next().unwrap_or("").to_owned())
}

/// The function with its variables, which only `GET /functions/:id` gives.
pub fn described(client: &Client, name: &str) -> Result<Function, Error> {
    let found = function_named(client, name)?;
    client.json(&Call::get(format!("/functions/{}", found.id)))
}

pub fn current(function: &Function) -> Variables {
    function
        .environment
        .iter()
        .flatten()
        .map(|(name, value)| (name.clone(), value.as_str().unwrap_or_default().to_owned()))
        .collect()
}

pub fn list(name: &str, show: bool, context: &Context) -> Result<(), Error> {
    let function = described(&Client::new(&context.settings()?)?, name)?;
    let variables = current(&function);
    let document =
        if show { json!({ "variables": variables }) } else { json!({ "names": variables.keys().collect::<Vec<_>>() }) };
    context.out.result(&document, || {
        if variables.is_empty() {
            return format!("{name} has no variable");
        }
        variables
            .iter()
            .map(|(key, value)| if show { format!("{key}={value}") } else { key.clone() })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

/// Sends every variable, as the API replaces them all, and waits for the rollout.
fn replace(client: &Client, context: &Context, function: &Function, variables: &Variables) -> Result<f64, Error> {
    let started = Instant::now();
    let progress = Progress::start(context.out, &format!("rolling {} out with its variables", function.name));
    let updated = client.json::<Value>(
        &Call::put(format!("/functions/{}", function.id), json!({ "environment": variables }))
            .timeout(super::deploy::DEPLOY_TIMEOUT),
    );
    progress.stop();
    updated.map_err(super::deploy::deploy_failed)?;
    Ok((started.elapsed().as_secs_f64() * 10.0).round() / 10.0)
}

pub fn set(name: &str, assignments: &[String], context: &Context) -> Result<(), Error> {
    let mut asked = Vec::new();
    for text in assignments {
        let (key, value) = assignment(text)?;
        asked.push((key, value));
    }
    let client = Client::new(&context.settings()?)?;
    let function = described(&client, name)?;
    let mut variables = current(&function);
    let before = variables.clone();
    for (key, value) in asked {
        let value = match value {
            Some(value) => value,
            None => read_value(&key)?,
        };
        variables.insert(key, value);
    }
    finish(&client, context, &function, &before, &variables)
}

pub fn unset(name: &str, keys: &[String], context: &Context) -> Result<(), Error> {
    let keys: Vec<String> = keys.iter().map(|key| named(key)).collect::<Result<_, _>>()?;
    let client = Client::new(&context.settings()?)?;
    let function = described(&client, name)?;
    let before = current(&function);
    let mut variables = before.clone();
    for key in &keys {
        variables.remove(key);
    }
    finish(&client, context, &function, &before, &variables)
}

/// What changed, rolled out; or nothing sent when nothing did.
fn finish(
    client: &Client,
    context: &Context,
    function: &Function,
    before: &Variables,
    after: &Variables,
) -> Result<(), Error> {
    let names = after.keys().cloned().collect::<Vec<_>>();
    if before == after {
        return context
            .out
            .result(&json!({ "changed": false, "names": names }), || format!("{}: no changes", function.name));
    }
    let seconds = replace(client, context, function, after)?;
    let changed: Vec<&String> = before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key) != after.get(*key))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    context.out.result(
        &json!({ "changed": true, "variablesChanged": changed, "names": names, "seconds": seconds }),
        || {
            let list = changed.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", ");
            format!("{}: {list} changed, live in {seconds} s", function.name)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::listed;

    #[test]
    fn a_name_follows_lambdas_rule() {
        for name in ["TABLE_NAME", "ab", "Region2"] {
            assert!(is_variable_name(name), "{name}");
        }
        for name in ["A", "1ST", "_X", "MY-VAR", "été", ""] {
            assert!(!is_variable_name(name), "{name}");
        }
    }

    #[test]
    fn an_assignment_has_a_name_and_maybe_a_value() {
        assert_eq!(assignment("GREETING=Ahlan").unwrap(), ("GREETING".into(), Some("Ahlan".into())));
        assert_eq!(assignment("URL=https://x/?a=b").unwrap(), ("URL".into(), Some("https://x/?a=b".into())));
        assert_eq!(assignment("EMPTY=").unwrap(), ("EMPTY".into(), Some(String::new())));
        assert_eq!(assignment("TOKEN").unwrap(), ("TOKEN".into(), None));
        assert_eq!(assignment("MY-VAR=1").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn the_reserved_names_are_the_apis() {
        let source = include_str!("../../../BE/src/functions/environment.ts");
        let api: Vec<String> = [listed(source, "LAMBDA_RESERVED"), listed(source, "FF_RESERVED")].concat();

        assert_eq!(api, RESERVED.map(str::to_owned));
        // The API's endpoints, a map of each name to why: ['NAME', "why"] pairs.
        let start = source.find("const ENDPOINTS_RESERVED = new Map([").expect("the API's endpoints");
        let end = start + source[start..].find("]);").expect("their end");
        let endpoints: Vec<(String, String)> = source[start..end]
            .lines()
            .filter_map(|line| {
                let (name, why) = line.trim().strip_prefix("['")?.split_once("', \"")?;
                Some((name.to_owned(), why.strip_suffix("\"],")?.to_owned()))
            })
            .collect();
        assert_eq!(endpoints, ENDPOINTS_RESERVED.map(|(name, why)| (name.to_owned(), why.to_owned())));
        assert_eq!(
            reserved("AWS_ENDPOINT_URL_S3").unwrap(),
            "AWS_ENDPOINT_URL_S3 is reserved: FF sets it, with the function's own key to its account's buckets"
        );
        assert_eq!(
            reserved("AWS_ENDPOINT_URL_SQS").unwrap(),
            "AWS_ENDPOINT_URL_SQS is reserved: FF sets it, with the function's own key to its account's queues"
        );
        assert_eq!(
            reserved("AWS_ENDPOINT_URL_SESV2").unwrap(),
            "AWS_ENDPOINT_URL_SESV2 is reserved: FF sets it, with the function's own key to its account's mail"
        );
        assert_eq!(reserved("FF_DEBUG").unwrap(), "FF_DEBUG is reserved: names starting with FF_ are FF's own");
        assert_eq!(reserved("TZ"), None);
    }

    #[test]
    fn env_flags_need_their_values() {
        let given = variables(&["A1=x".into(), "B2=y".into(), "A1=z".into()]).unwrap();

        assert_eq!(given, Variables::from([("A1".into(), "z".into()), ("B2".into(), "y".into())]));
        assert_eq!(variables(&["TOKEN".into()]).unwrap_err().message, "--env TOKEN has no value: --env TOKEN=<value>");
    }
}
