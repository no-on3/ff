//! `ff secrets list|set|unset <name>`: a function's secrets, variables whose values nobody reads
//! back, not even through the API: their names, and when each was set. A value is never on the
//! command line, where the shell's history would keep it: it comes from a prompt, or stdin.

use std::collections::BTreeMap;
use std::io::{self, BufRead, IsTerminal};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Context;
use super::env::is_variable_name;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::progress::Progress;
use crate::table::{table, time};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Secret {
    pub(super) name: String,
    updated_at: String,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Secrets {
    pub(super) secrets: Vec<Secret>,
}

fn names(given: &[String]) -> Result<Vec<String>, Error> {
    given
        .iter()
        .map(|name| {
            if name.contains('=') {
                Err(Error::usage(format!("A secret's value doesn't go on the command line, where the shell's history keeps it: `ff secrets set <function> {}` asks for it", name.split('=').next().unwrap_or(name))))
            } else if is_variable_name(name) {
                Ok(name.clone())
            } else {
                Err(Error::usage(format!("\"{name}\" can't be a secret's name: a letter, then letters, digits or underscores, two characters at least")))
            }
        })
        .collect()
}

/// Each secret's value: from a prompt that doesn't show it, in a terminal; else a line of stdin
/// each, in the order the names come.
fn values(names: &[String]) -> Result<BTreeMap<String, String>, Error> {
    let mut values = BTreeMap::new();
    if io::stdin().is_terminal() {
        for name in names {
            let value = rpassword::prompt_password(format!("{name} (not shown as you type or paste it): "))
                .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read the value: {error}")))?;
            values.insert(name.clone(), value);
        }
        return Ok(values);
    }
    let mut lines = io::stdin().lock().lines();
    for name in names {
        let value = lines
            .next()
            .transpose()
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read {name}'s value from stdin: {error}")))?
            .ok_or_else(|| {
                Error::usage(format!("stdin has no line for {name}: a line each, in the order the names come"))
            })?;
        values.insert(name.clone(), value);
    }
    Ok(values)
}

pub fn list(name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let secrets: Secrets = client.json(&Call::get(format!("/functions/{}/secrets", function.id)))?;
    context.out.result(&secrets, || {
        if secrets.secrets.is_empty() {
            return format!("{name} has no secret");
        }
        let rows: Vec<Vec<String>> =
            secrets.secrets.iter().map(|secret| vec![secret.name.clone(), time(&secret.updated_at)]).collect();
        table(&["NAME", "SET (UTC)"], &rows)
    })
}

/// A change of secrets: `PATCH`, then the answer once the new version is live.
fn change(name: &str, changes: Value, what: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let started = Instant::now();
    let progress = Progress::start(context.out, &format!("rolling {name} out with its secrets"));
    let call = Call::patch(format!("/functions/{}/secrets", function.id), json!({ "secrets": changes }))
        .timeout(super::deploy::DEPLOY_TIMEOUT);
    let secrets = client.json::<Secrets>(&call);
    progress.stop();
    let secrets = secrets.map_err(super::deploy::deploy_failed)?;
    let seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    context.out.result(&secrets, || {
        let names: Vec<&str> = secrets.secrets.iter().map(|secret| secret.name.as_str()).collect();
        format!(
            "{name}: {what}, live in {seconds} s; its secrets: {}",
            if names.is_empty() { "none".to_owned() } else { names.join(", ") }
        )
    })
}

pub fn set(name: &str, given: &[String], context: &Context) -> Result<(), Error> {
    let names = names(given)?;
    let values = values(&names)?;
    change(name, json!(values), &format!("{} set", names.join(", ")), context)
}

pub fn unset(name: &str, given: &[String], context: &Context) -> Result<(), Error> {
    let names = names(given)?;
    let removals: BTreeMap<&String, Value> = names.iter().map(|secret| (secret, Value::Null)).collect();
    change(name, json!(removals), &format!("{} removed", names.join(", ")), context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_never_comes_on_the_command_line() {
        assert_eq!(names(&["DB_PASSWORD".into()]).unwrap(), ["DB_PASSWORD"]);
        let refused = names(&["DB_PASSWORD=hunter2".into()]).unwrap_err();
        assert_eq!(refused.exit_code(), 2);
        assert!(refused.message.starts_with("A secret's value doesn't go on the command line"), "{}", refused.message);
        assert!(!refused.message.contains("hunter2"), "the value is never echoed");
        assert_eq!(names(&["db-password".into()]).unwrap_err().exit_code(), 2);
    }
}
