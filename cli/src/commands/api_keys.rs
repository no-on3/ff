//! `ff api-keys list|create|revoke`: the account's API keys, which a script or a CI calls FF with, each with its
//! scopes, and never doing more than its creator's role allows. Only an owner's login manages them: the API refuses
//! a key, so ff says so before calling with one.

use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use crate::api::{Call, Client};
use crate::cli::ApiKeysCommand;
use crate::config::Source;
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// An API key, as `GET /api-keys` lists it: never the key itself.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiKey {
    id: String,
    name: String,
    scopes: Vec<String>,
    created_by: String,
    created_at: String,
    expires_at: Option<String>,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
}

/// Whether a key works, as the API decides it: not once revoked, nor from its expiry on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Active,
    Revoked,
    Expired,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Revoked => "revoked",
            State::Expired => "expired",
        }
    }
}

impl ApiKey {
    fn state(&self, now: SystemTime) -> State {
        if self.revoked_at.is_some() {
            return State::Revoked;
        }
        match self.expires_at.as_deref().and_then(|at| humantime::parse_rfc3339(at).ok()) {
            Some(end) if end <= now => State::Expired,
            _ => State::Active,
        }
    }

    /// How a message names it: its name and its ID.
    fn label(&self) -> String {
        format!("\"{}\" ({})", self.name, self.id)
    }

    /// Its scopes, and its expiry when it has one, in words.
    fn reach(&self) -> String {
        let until = match &self.expires_at {
            Some(at) => format!("until {} UTC", time(at)),
            None => "with no expiry".to_owned(),
        };
        format!("with the scopes {}, {until}", self.scopes.join(", "))
    }
}

/// A key just made: the key itself, this once.
#[derive(Deserialize, Serialize)]
struct CreatedApiKey {
    #[serde(flatten)]
    view: ApiKey,
    key: String,
}

pub fn run(command: ApiKeysCommand, context: &Context) -> Result<(), Error> {
    match command {
        ApiKeysCommand::List => list(context),
        ApiKeysCommand::Create { name, scopes, expires } => create(&name, &scopes, expires.as_deref(), context),
        ApiKeysCommand::Revoke { key, yes } => revoke(&key, yes, context),
    }
}

/// A client calling with the user's login. API keys are an owner's to manage, and the API refuses a key, so when
/// ff would send one, it says where the key comes from and how to use the login instead.
fn owner_client(context: &Context) -> Result<Client, Error> {
    let settings = context.settings()?;
    if let Some(token) = settings.token.as_ref().filter(|token| token.value.is_api_key()) {
        let instead = match token.source {
            Source::Environment(_) => "unset it for ff to use your login, or `ff login` first".to_owned(),
            _ => format!(
                "`ff login --replace` logs in on profile {} in place of the key, or `ff login --profile <name>` on \
                 another profile",
                settings.profile.value
            ),
        };
        return Err(Error::new(
            Kind::Failed,
            format!(
                "API keys are managed with an owner's login, never with a key, and ff would send the API key {} from \
                 {}: {instead}",
                token.value.masked(),
                token.source
            ),
        ));
    }
    Client::new(&settings)
}

fn api_keys(client: &Client) -> Result<Vec<ApiKey>, Error> {
    client.json(&Call::get("/api-keys"))
}

fn list(context: &Context) -> Result<(), Error> {
    let keys = api_keys(&owner_client(context)?)?;
    let now = SystemTime::now();
    context.out.result(&keys, || {
        if keys.is_empty() {
            return "The account has no API key: `ff api-keys create --name <name> --scopes <scope,...>` makes one"
                .to_owned();
        }
        let rows: Vec<Vec<String>> = keys
            .iter()
            .map(|key| {
                vec![
                    key.id.clone(),
                    key.name.clone(),
                    key.scopes.join(","),
                    key.state(now).as_str().to_owned(),
                    key.expires_at.as_deref().map(time).unwrap_or_else(|| "never".to_owned()),
                    key.last_used_at.as_deref().map(time).unwrap_or_else(|| "never".to_owned()),
                    time(&key.created_at),
                ]
            })
            .collect();
        table(&["ID", "NAME", "SCOPES", "STATE", "EXPIRES (UTC)", "LAST USED (UTC)", "CREATED (UTC)"], &rows)
    })
}

/// When a key asked to expire `when` stops: in a while from `now`, as `90d`, or at a time; in the future either way.
fn expiry(when: &str, now: SystemTime) -> Result<SystemTime, Error> {
    let at = match humantime::parse_duration(when) {
        Ok(after) => now.checked_add(after).ok_or_else(|| Error::usage(format!("--expires {when} is too far")))?,
        Err(_) => humantime::parse_rfc3339_weak(when).map_err(|_| {
            Error::usage(format!(
                "--expires {when} is neither a while, as 90d, 12h or 2w, nor a time, as 2027-01-31T00:00:00Z"
            ))
        })?,
    };
    if at <= now {
        return Err(Error::usage(format!(
            "--expires {when} is not in the future: a key that has expired works nowhere"
        )));
    }
    Ok(at)
}

fn create(name: &str, scopes: &[String], expires: Option<&str>, context: &Context) -> Result<(), Error> {
    if !(1..=100).contains(&name.chars().count()) {
        return Err(Error::usage("--name: 1 to 100 characters, saying what the key is for"));
    }
    // Each once, as the API takes them, in the order given.
    let mut once: Vec<&String> = Vec::new();
    for scope in scopes {
        if !once.contains(&scope) {
            once.push(scope);
        }
    }
    let mut body = json!({ "name": name, "scopes": once });
    if let Some(when) = expires {
        body["expiresAt"] = json!(humantime::format_rfc3339_seconds(expiry(when, SystemTime::now())?).to_string());
    }
    let made: CreatedApiKey = owner_client(context)?.json(&Call::post("/api-keys", body))?;
    context.out.result(&made, || {
        format!(
            "API key {} made, {}. Here it is, shown this once, as FF keeps only its hash: where it is used, FF_TOKEN \
             holds it, or `ff config set-token` saves it; `ff api-keys revoke {}` stops it.\n{}",
            made.view.label(),
            made.view.reach(),
            made.view.id,
            made.key
        )
    })
}

/// The key `wanted` names: by its ID, else by the name of the account's one working key of that name.
fn find<'a>(keys: &'a [ApiKey], wanted: &str, now: SystemTime) -> Result<&'a ApiKey, Error> {
    if let Some(key) = keys.iter().find(|key| key.id == wanted) {
        return Ok(key);
    }
    let named: Vec<&ApiKey> = keys.iter().filter(|key| key.name == wanted && key.state(now) == State::Active).collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => Err(Error::new(
            Kind::Failed,
            format!(
                "The account has no API key with the ID {wanted}, nor a working one by that name: `ff api-keys list` lists them"
            ),
        )),
        several => Err(Error::new(
            Kind::Failed,
            format!(
                "{} working API keys are named {wanted}: name the one to revoke by its ID, {}",
                several.len(),
                several.iter().map(|key| key.id.as_str()).collect::<Vec<_>>().join(" or ")
            ),
        )),
    }
}

fn revoke(wanted: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = owner_client(context)?;
    let keys = api_keys(&client)?;
    let key = find(&keys, wanted, SystemTime::now())?;
    if let Some(at) = &key.revoked_at {
        let document = json!({ "revoked": true, "id": key.id, "revokedAt": at });
        return context
            .out
            .result(&document, || format!("The API key {} was revoked already, at {} UTC", key.label(), time(at)));
    }
    if !super::functions::confirmed(
        "ff api-keys revoke",
        &format!("Revoke the API key {}, {}? Whatever uses it is refused at once", key.label(), key.reach()),
        yes,
    )? {
        return context.out.result(&json!({ "revoked": false, "id": key.id }), || "Nothing revoked".to_owned());
    }
    let revoked: ApiKey = client.json(&Call::delete(format!("/api-keys/{}", key.id)))?;
    let document = json!({ "revoked": true, "id": revoked.id, "revokedAt": revoked.revoked_at });
    context.out.result(&document, || format!("Revoked the API key {}: whatever uses it is refused", revoked.label()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::{class_fields, listed, sorted, sorted_keys};
    use crate::cli::API_KEY_SCOPES;
    use std::time::Duration;

    const DTO: &str = include_str!("../../../BE/src/api-keys/dto/api-key.dto.ts");

    fn key(name: &str, revoked_at: Option<&str>, expires_at: Option<&str>) -> ApiKey {
        ApiKey {
            id: format!("{:0>12}", name.len()),
            name: name.into(),
            scopes: vec!["functions:read".into()],
            created_by: "u1".into(),
            created_at: "2026-11-01T08:00:00.000Z".into(),
            expires_at: expires_at.map(str::to_owned),
            last_used_at: None,
            revoked_at: revoked_at.map(str::to_owned),
        }
    }

    fn at(text: &str) -> SystemTime {
        humantime::parse_rfc3339(text).unwrap()
    }

    #[test]
    fn the_scopes_and_a_keys_fields_are_the_apis() {
        let scopes = listed(include_str!("../../../BE/src/api-keys/api-key-format.ts"), "SCOPES");
        assert_eq!(scopes, API_KEY_SCOPES, "the scopes ff offers are the API's, in its order");
        let view = key("ci", None, None);
        assert_eq!(sorted_keys(&view), sorted(class_fields(DTO, "ApiKeyView")));
        let made = CreatedApiKey { view, key: "ffk_…".into() };
        let mut fields = class_fields(DTO, "ApiKeyView");
        fields.extend(class_fields(DTO, "CreatedApiKey"));
        assert_eq!(sorted_keys(&made), sorted(fields));
    }

    #[test]
    fn a_key_works_until_revoked_or_from_its_expiry_on() {
        let now = at("2026-11-09T12:00:00Z");
        assert_eq!(key("ci", None, None).state(now), State::Active);
        assert_eq!(key("ci", None, Some("2026-11-09T12:00:00.001Z")).state(now), State::Active);
        assert_eq!(key("ci", None, Some("2026-11-09T12:00:00.000Z")).state(now), State::Expired);
        assert_eq!(
            key("ci", Some("2026-11-08T00:00:00.000Z"), Some("2027-01-01T00:00:00.000Z")).state(now),
            State::Revoked
        );
    }

    #[test]
    fn an_expiry_is_a_while_from_now_or_a_time_to_come() {
        let now = at("2026-11-09T12:00:00Z");
        assert_eq!(expiry("90d", now).unwrap(), now + Duration::from_secs(90 * 86_400));
        assert_eq!(expiry("2w", now).unwrap(), now + Duration::from_secs(14 * 86_400));
        assert_eq!(expiry("2027-01-31T00:00:00Z", now).unwrap(), at("2027-01-31T00:00:00Z"));
        assert!(expiry("0d", now).unwrap_err().message.contains("is not in the future"));
        assert!(expiry("2026-11-01T00:00:00Z", now).unwrap_err().message.contains("is not in the future"));
        assert!(expiry("soon", now).unwrap_err().message.contains("is neither a while"));
    }

    #[test]
    fn a_key_is_found_by_its_id_or_the_name_of_the_one_working_key_so_named() {
        let now = at("2026-11-09T12:00:00Z");
        let mut keys = vec![key("ci", Some("2026-11-02T00:00:00Z"), None), key("deploys", None, None)];
        keys[0].id = "aaaaaaaaaaaa".into();
        keys[1].id = "bbbbbbbbbbbb".into();
        assert_eq!(find(&keys, "aaaaaaaaaaaa", now).unwrap().id, "aaaaaaaaaaaa", "a revoked key by its ID");
        assert_eq!(find(&keys, "deploys", now).unwrap().id, "bbbbbbbbbbbb");
        assert!(find(&keys, "ci", now).unwrap_err().message.contains("nor a working one by that name"));
        keys.push(ApiKey { id: "cccccccccccc".into(), ..key("deploys", None, None) });
        assert_eq!(
            find(&keys, "deploys", now).unwrap_err().message,
            "2 working API keys are named deploys: name the one to revoke by its ID, bbbbbbbbbbbb or cccccccccccc"
        );
    }
}
