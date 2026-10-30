//! `ff caches create|list|get|password|delete <name>`: the account's caches, Valkey as AWS
//! ElastiCache gives it. A cache's password, in its address, is shown once, when it is made or
//! given a new one: FF keeps no copy. `--secret-for` sets that address then as a secret of the
//! functions named, `REDIS_URL` by default, as `ff db` does with a connection string.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use super::db::{SecretSet, secret_name, set_secrets, size};
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// A cache, as `GET /caches` and `GET /caches/:name` answer it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    name: String,
    status: String,
    host: String,
    port: u16,
    address: String,
    memory_mb: u32,
    bytes_used_for_cache: Option<u64>,
    curr_connections: Option<u32>,
    engine: String,
    password_set_at: Option<String>,
    created_at: String,
}

/// A cache just made, or given a new password: its password and address, this once.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WithPassword {
    #[serde(flatten)]
    cache: Cache,
    password: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Made {
    #[serde(flatten)]
    cache: WithPassword,
    secrets_set: Vec<SecretSet>,
}

/// AWS ElastiCache's rule for a cluster's name, as the API's: 1 to 40 lower-case letters, digits
/// and hyphens, a letter first, no two hyphens in a row and none last.
pub fn is_cache_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !name.contains("--")
        && !name.ends_with('-')
}

fn checked_name(name: &str) -> Result<&str, Error> {
    if is_cache_name(name) {
        Ok(name)
    } else {
        Err(Error::new(
            Kind::Usage,
            format!(
                "\"{name}\" can't be a cache's name: 1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters"
            ),
        ))
    }
}

/// The status in a word, as ElastiCache and the console say it.
fn status(status: &str) -> &str {
    match status {
        "active" => "available",
        other => other,
    }
}

/// Its memory: what its keys use now, of the plan's.
fn memory(cache: &Cache) -> String {
    format!("{} of {} MB", size(cache.bytes_used_for_cache), cache.memory_mb)
}

fn connections(cache: &Cache) -> String {
    cache.curr_connections.map(|n| n.to_string()).unwrap_or_else(|| "-".to_owned())
}

pub fn list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let caches: Vec<Cache> = client.json(&Call::get("/caches"))?;
    context.out.result(&caches, || {
        if caches.is_empty() {
            return "The account has no cache: `ff caches create <name>` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = caches
            .iter()
            .map(|cache| {
                vec![
                    cache.name.clone(),
                    status(&cache.status).to_owned(),
                    memory(cache),
                    connections(cache),
                    time(&cache.created_at),
                ]
            })
            .collect();
        table(&["NAME", "STATUS", "MEMORY", "CONNECTIONS", "CREATED (UTC)"], &rows)
    })
}

/// How to reach it, without its password.
fn details(cache: &Cache) -> String {
    let rows = [
        ("status", status(&cache.status).to_owned()),
        ("memory", format!("{}; past it, the least recently used keys go", memory(cache))),
        ("connections", connections(cache)),
        ("address", cache.address.clone()),
        ("engine", cache.engine.clone()),
        (
            "password",
            cache
                .password_set_at
                .as_deref()
                .map(|at| format!("made {} UTC, shown then only", time(at)))
                .unwrap_or_default(),
        ),
        ("created", format!("{} UTC", time(&cache.created_at))),
    ];
    rows.iter().map(|(label, value)| format!("{label:<11} {value}")).collect::<Vec<_>>().join("\n")
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    let cache: Cache = client.json(&Call::get(format!("/caches/{name}")))?;
    context.out.result(&cache, || format!("{}\n{}", cache.name, details(&cache)))
}

/// The answer with the password: the address once, and where it went.
fn shown_once(made: Made, what: &str, context: &Context) -> Result<(), Error> {
    let name = made.cache.cache.name.clone();
    context.out.result(&made, || {
        let mut text = format!(
            "{name} {what}: its address, shown this once (FF keeps no copy; `ff caches password {name}` makes a new one):\n{}",
            made.cache.url
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
    // Each function first: a name that isn't one stops it before a cache is made.
    for function in functions {
        function_named(&client, function)?;
    }
    let made: WithPassword = client.json(&Call::post("/caches", json!({ "name": name })))?;
    let secrets_set = set_secrets(&client, &made.url, functions, secret, context)?;
    shown_once(Made { cache: made, secrets_set }, "made", context)
}

pub fn password(name: &str, functions: &[String], secret: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let secret = secret_name(secret)?;
    let client = Client::new(&context.settings()?)?;
    for function in functions {
        function_named(&client, function)?;
    }
    let changed: WithPassword = client.json(&Call::post(format!("/caches/{name}/password"), json!({})))?;
    let secrets_set = set_secrets(&client, &changed.url, functions, secret, context)?;
    shown_once(Made { cache: changed, secrets_set }, "has a new password", context)
}

pub fn delete(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff caches delete",
        &format!("Delete the cache {name}, with its keys? Nothing can bring them back"),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false, "name": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/caches/{name}")))?;
    context.out.result(&json!({ "deleted": true, "name": name }), || format!("deleted the cache {name}, with its keys"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_elasticache_as_the_api_does() {
        for name in ["sessions", "a", "rates-2", &format!("a{}", "b".repeat(39))] {
            assert!(is_cache_name(name), "{name}");
        }
        for name in ["", "Sessions", "1-cache", "two--hyphens", "last-", "under_score", &format!("a{}", "b".repeat(40))]
        {
            assert!(!is_cache_name(name), "{name}");
        }
        assert_eq!(checked_name("Sessions").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn statuses_read_as_elasticache_says_them() {
        assert_eq!([status("active"), status("suspended"), status("creating")], ["available", "suspended", "creating"]);
    }
}
