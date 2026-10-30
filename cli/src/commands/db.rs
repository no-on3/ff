//! `ff db create|list|get|password|delete <name>`: the account's PostgreSQL databases, as AWS RDS
//! gives them. A database's password, in its connection string, is shown once, when it is made or
//! given a new one: FF keeps no copy. `--secret-for` sets that string then as a secret of the
//! functions named, `DATABASE_URL` by default, through `ff secrets`' route.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use super::env::is_variable_name;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::progress::Progress;
use crate::table::{table, time};

/// A database, as `GET /databases` and `GET /databases/:id` answer it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Database {
    id: String,
    name: String,
    status: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    connection_url: String,
    size_bytes: Option<u64>,
    connections: Option<u32>,
    connection_limit: u32,
    storage_limit_mb: u32,
    password_set_at: Option<String>,
    created_at: String,
}

/// A database just made, or given a new password: its password and connection string, this once.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WithPassword {
    #[serde(flatten)]
    database: Database,
    password: String,
    connection_string: String,
}

/// A secret set from the connection string: the function, and the secret's name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecretSet {
    pub(super) function: String,
    pub(super) secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Made {
    #[serde(flatten)]
    database: WithPassword,
    secrets_set: Vec<SecretSet>,
}

/// AWS RDS's rule for a name, as the API's: 1 to 63 lower-case letters, digits and hyphens, a
/// letter first, no two hyphens in a row and none last.
pub fn is_database_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !name.contains("--")
        && !name.ends_with('-')
}

fn checked_name(name: &str) -> Result<&str, Error> {
    if is_database_name(name) {
        Ok(name)
    } else {
        Err(Error::new(
            Kind::Usage,
            format!(
                "\"{name}\" can't be a database's name: 1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases"
            ),
        ))
    }
}

/// The status in a word, as the console says it.
fn status(status: &str) -> &str {
    match status {
        "active" => "available",
        "read_only" => "read-only",
        other => other,
    }
}

/// A size in MB of 1,048,576 bytes, or GB from 1,024 MB on, to a tenth; a dash for none.
pub fn size(bytes: Option<u64>) -> String {
    let Some(bytes) = bytes else { return "-".to_owned() };
    let mb = bytes as f64 / 1_048_576.0;
    let (value, unit) = if mb >= 1024.0 { (mb / 1024.0, "GB") } else { (mb, "MB") };
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 { format!("{rounded:.0} {unit}") } else { format!("{rounded:.1} {unit}") }
}

fn databases(client: &Client) -> Result<Vec<Database>, Error> {
    client.json(&Call::get("/databases"))
}

/// The account's database of that name, or the error that says how to find it.
fn database_named(client: &Client, name: &str) -> Result<Database, Error> {
    databases(client)?.into_iter().find(|database| database.name == name).ok_or_else(|| {
        Error::new(
            Kind::Failed,
            format!("There is no database named \"{name}\" in the account: `ff db list` shows its databases"),
        )
    })
}

pub fn list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let databases = databases(&client)?;
    context.out.result(&databases, || {
        if databases.is_empty() {
            return "The account has no database: `ff db create <name>` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = databases
            .iter()
            .map(|database| {
                vec![
                    database.name.clone(),
                    status(&database.status).to_owned(),
                    format!("{} of {} MB", size(database.size_bytes), database.storage_limit_mb),
                    format!(
                        "{} of {}",
                        database.connections.map(|n| n.to_string()).unwrap_or_else(|| "-".to_owned()),
                        database.connection_limit
                    ),
                    time(&database.created_at),
                ]
            })
            .collect();
        table(&["NAME", "STATUS", "STORAGE", "SESSIONS", "CREATED (UTC)"], &rows)
    })
}

/// How to reach it, without its password.
fn details(database: &Database) -> String {
    let rows = [
        ("status", status(&database.status).to_owned()),
        ("storage", format!("{} of the plan's {} MB", size(database.size_bytes), database.storage_limit_mb)),
        (
            "sessions",
            format!(
                "{} of {} at most",
                database.connections.map(|n| n.to_string()).unwrap_or_else(|| "-".to_owned()),
                database.connection_limit
            ),
        ),
        ("host", format!("{}:{}", database.host, database.port)),
        ("database", database.database.clone()),
        ("user", database.user.clone()),
        ("url", database.connection_url.clone()),
        (
            "password",
            database
                .password_set_at
                .as_deref()
                .map(|at| format!("made {} UTC, shown then only", time(at)))
                .unwrap_or_default(),
        ),
        ("created", format!("{} UTC", time(&database.created_at))),
    ];
    rows.iter().map(|(label, value)| format!("{label:<9} {value}")).collect::<Vec<_>>().join("\n")
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let database = database_named(&client, checked_name(name)?)?;
    context.out.result(&database, || format!("{}\n{}", database.name, details(&database)))
}

/// The connection string, or a cache's address, as a secret of each function named, each rolled out before the next.
pub(super) fn set_secrets(
    client: &Client,
    connection_string: &str,
    functions: &[String],
    secret: &str,
    context: &Context,
) -> Result<Vec<SecretSet>, Error> {
    let mut set = Vec::new();
    for name in functions {
        let function = function_named(client, name)?;
        let started = Instant::now();
        let progress = Progress::start(context.out, &format!("rolling {name} out with {secret}"));
        let call = Call::patch(
            format!("/functions/{}/secrets", function.id),
            json!({ "secrets": { secret: connection_string } }),
        )
        .timeout(super::deploy::DEPLOY_TIMEOUT);
        let done = client.done(&call);
        progress.stop();
        done.map_err(super::deploy::deploy_failed)?;
        if !context.out.quiet {
            let seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
            eprintln!("{secret} set on {name}, live in {seconds} s");
        }
        set.push(SecretSet { function: name.clone(), secret: secret.to_owned() });
    }
    Ok(set)
}

pub(super) fn secret_name(secret: &str) -> Result<&str, Error> {
    if is_variable_name(secret) {
        Ok(secret)
    } else {
        Err(Error::new(
            Kind::Usage,
            format!(
                "\"{secret}\" can't be a secret's name: a letter, then letters, digits or underscores, two characters at least"
            ),
        ))
    }
}

/// The answer with the password: the string once, and where it went.
fn shown_once(made: Made, what: &str, context: &Context) -> Result<(), Error> {
    let name = made.database.database.name.clone();
    context.out.result(&made, || {
        let mut text = format!(
            "{name} {what}: its connection string, shown this once (FF keeps no copy; `ff db password {name}` makes a new one):\n{}",
            made.database.connection_string
        );
        for set in &made.secrets_set {
            text.push_str(&format!("\n{} set on {}", set.secret, set.function));
        }
        text
    })
}

pub fn create(name: &str, functions: &[String], secret: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let secret = secret_name(secret)?;
    let client = Client::new(&context.settings()?)?;
    // Each function first: a name that isn't one stops it before a database is made.
    for function in functions {
        function_named(&client, function)?;
    }
    let made: WithPassword = client.json(&Call::post("/databases", json!({ "name": name })))?;
    let secrets_set = set_secrets(&client, &made.connection_string, functions, secret, context)?;
    shown_once(Made { database: made, secrets_set }, "made", context)
}

pub fn password(name: &str, functions: &[String], secret: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let secret = secret_name(secret)?;
    let client = Client::new(&context.settings()?)?;
    let database = database_named(&client, name)?;
    for function in functions {
        function_named(&client, function)?;
    }
    let changed: WithPassword = client.json(&Call::post(format!("/databases/{}/password", database.id), json!({})))?;
    let secrets_set = set_secrets(&client, &changed.connection_string, functions, secret, context)?;
    shown_once(Made { database: changed, secrets_set }, "has a new password", context)
}

pub fn delete(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let database = database_named(&client, checked_name(name)?)?;
    if !super::functions::confirmed(
        "ff db delete",
        &format!("Delete the database {name}, with its data? Nothing can bring it back"),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false, "name": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/databases/{}", database.id)))?;
    context.out.result(&json!({ "deleted": true, "name": name, "id": database.id }), || {
        format!("deleted the database {name}, with its data")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_rds_as_the_api_does() {
        for name in ["orders", "a", "shop-2", &format!("a{}", "b".repeat(62))] {
            assert!(is_database_name(name), "{name}");
        }
        for name in ["", "Orders", "2shop", "shop--2", "shop-", "shop_2", &format!("a{}", "b".repeat(63))] {
            assert!(!is_database_name(name), "{name}");
        }
        assert_eq!(checked_name("Orders").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn sizes_and_statuses_read_as_the_console_says_them() {
        assert_eq!(
            [size(Some(7_634_423)), size(Some(1_073_741_824)), size(Some(1_610_612_736)), size(None)],
            ["7.3 MB", "1 GB", "1.5 GB", "-"]
        );
        assert_eq!(
            [status("active"), status("read_only"), status("suspended")],
            ["available", "read-only", "suspended"]
        );
    }
}
