//! `ff publish`, `ff versions` and `ff alias`: a function's versions and aliases, as AWS Lambda's. A version is the
//! function as it was published, which never changes; an alias a name for one, or for `$LATEST`, which calls, URLs,
//! schedules and queue readers name, and which a rollback points back.

use serde_json::{Map, Value, json};

use super::Context;
use super::functions::confirmed;
use super::url::FunctionUrl;
use crate::api::types::{FunctionAlias, FunctionVersion, LATEST, aliases_of, function_named, percent, versions_of};
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{first_line, table, time};

/// The start of a code's SHA-256, enough to tell two versions' code apart.
fn short_sha(sha: &str) -> String {
    if sha.chars().count() > 12 { format!("{}…", sha.chars().take(12).collect::<String>()) } else { sha.to_owned() }
}

/// The aliases whose calls reach a version, each with its part of them when it shares them: `live 90%, beta`.
fn aliases_on(version: &str, aliases: &[FunctionAlias]) -> String {
    let parts: Vec<String> = aliases
        .iter()
        .filter_map(|alias| match alias.share() {
            Some((_, weight)) if alias.function_version == version => {
                Some(format!("{} {}", alias.name, percent(1.0 - weight)))
            }
            Some((other, weight)) if other == version => Some(format!("{} {}", alias.name, percent(weight))),
            None if alias.function_version == version => Some(alias.name.clone()),
            _ => None,
        })
        .collect();
    if parts.is_empty() { "-".to_owned() } else { parts.join(", ") }
}

/// Publishes the function as it is; `fresh` says whether the version is new, Lambda answering with the last one when
/// nothing but the description changed since.
pub fn publish_version(
    client: &Client,
    function_id: &str,
    description: Option<&str>,
) -> Result<(FunctionVersion, bool), Error> {
    let before = versions_of(client, function_id)?;
    let mut body = Map::new();
    if let Some(description) = description {
        body.insert("description".into(), description.into());
    }
    let version: FunctionVersion =
        client.json(&Call::post(format!("/functions/{function_id}/versions"), Value::Object(body)))?;
    let fresh = !before.iter().any(|existing| existing.version == version.version);
    Ok((version, fresh))
}

pub fn publish(name: &str, description: Option<&str>, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let (version, fresh) = publish_version(&client, &function.id, description)?;
    let document = json!({ "version": version, "new": fresh });
    context.out.result(&document, || {
        if fresh {
            format!(
                "{name}: version {} published ({}, {} MB, {} s, code {}), which never changes\n`ff alias set {name} live {}` points an alias at it",
                version.version,
                version.runtime,
                version.memory,
                version.timeout,
                short_sha(&version.code_sha256),
                version.version
            )
        } else {
            format!(
                "{name}: nothing but the description changed since version {}, which it is again, as Lambda answers",
                version.version
            )
        }
    })
}

pub fn list(name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let mut versions = versions_of(&client, &function.id)?;
    let aliases = aliases_of(&client, &function.id)?;
    versions.sort_by_key(|version| std::cmp::Reverse(version.version.parse::<u64>().unwrap_or(0)));
    context.out.result(&versions, || {
        if versions.is_empty() {
            return format!("{name} has no version: `ff publish {name}` publishes one");
        }
        let rows: Vec<Vec<String>> = versions
            .iter()
            .map(|version| {
                vec![
                    version.version.clone(),
                    time(&version.created_at),
                    short_sha(&version.code_sha256),
                    format!("{} MB", version.memory),
                    format!("{} s", version.timeout),
                    aliases_on(&version.version, &aliases),
                    first_line(&version.description, 48),
                ]
            })
            .collect();
        table(&["VERSION", "PUBLISHED (UTC)", "CODE", "MEMORY", "TIMEOUT", "ALIASES", "DESCRIPTION"], &rows)
    })
}

pub fn delete(name: &str, version: u32, yes: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    if !confirmed(
        "ff versions --delete",
        &format!("Delete version {version} of {name}? Its number is never given again"),
        yes,
    )? {
        return context
            .out
            .result(&json!({ "deleted": false, "version": version.to_string() }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/functions/{}/versions/{version}", function.id)))?;
    context.out.result(&json!({ "deleted": true, "version": version.to_string() }), || {
        format!("{name}: version {version} deleted")
    })
}

/// A version as the command line names it: its number, or `$LATEST`, which `latest` spares quoting.
pub fn version_named(text: &str) -> Result<String, Error> {
    if text == LATEST || text.eq_ignore_ascii_case("latest") {
        return Ok(LATEST.to_owned());
    }
    match text.parse::<u32>() {
        Ok(number) if number > 0 && text == number.to_string() => Ok(text.to_owned()),
        _ => Err(Error::usage(format!(
            "{text} isn't a version: its number, such as 3, or $LATEST (latest), the function as it is"
        ))),
    }
}

/// What a schedule or a queue reader runs, as `--qualifier` names it: a version's number, an alias's name, or
/// `$LATEST`, which `latest` spares quoting. The API checks that the function has it.
pub fn qualifier_named(text: &str) -> String {
    if text.eq_ignore_ascii_case("latest") { LATEST.to_owned() } else { text.to_owned() }
}

/// What a schedule or a queue reader runs, in words: `$LATEST`, `version 3`, `alias live`.
pub fn runs_text(qualifier: Option<&str>) -> String {
    match qualifier {
        None | Some(LATEST) => LATEST.to_owned(),
        Some(version) if version.bytes().all(|byte| byte.is_ascii_digit()) => format!("version {version}"),
        Some(alias) => format!("alias {alias}"),
    }
}

/// A share of the calls as the command line gives it: `10%`, or `0.1`, from 0 to 1.
pub fn share_named(text: &str) -> Result<f64, Error> {
    let share = match text.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f64>().map(|value| value / 100.0),
        None => text.parse::<f64>(),
    };
    match share {
        Ok(share) if (0.0..=1.0).contains(&share) => Ok(share),
        _ => Err(Error::usage(format!(
            "{text} isn't a share of the calls: a percentage, 10%, or a fraction from 0 to 1, 0.1"
        ))),
    }
}

/// What `ff alias set` asks for: the alias's version, and maybe another with its share.
pub struct AliasRoute {
    pub version: String,
    pub also: Option<(String, f64)>,
}

impl AliasRoute {
    /// From the command line's words, checked as the API checks them, before any call.
    pub fn from_args(version: &str, also: Option<&[String]>) -> Result<AliasRoute, Error> {
        let version = version_named(version)?;
        let also = match also {
            Some([other, share]) => {
                let other = version_named(other)?;
                if version == LATEST || other == LATEST {
                    return Err(Error::usage(
                        "A share of the calls goes from one version to another: an alias naming $LATEST has none, as on Lambda",
                    ));
                }
                if other == version {
                    return Err(Error::usage(format!("--also names version {other}, the alias's own: name another")));
                }
                Some((other, share_named(share)?))
            }
            _ => None,
        };
        Ok(AliasRoute { version, also })
    }

    /// The routing Lambda's names give it: `{}` for none, which a change sends to clear a share.
    fn routing(&self) -> Value {
        let weights = match &self.also {
            Some((other, share)) => json!({ other.as_str(): share }),
            None => json!({}),
        };
        json!({ "additionalVersionWeights": weights })
    }
}

/// Points the alias as asked, making it if the function hasn't it; the alias before, when there was one.
pub fn set_alias(
    client: &Client,
    function_id: &str,
    name: &str,
    route: &AliasRoute,
    description: Option<&str>,
) -> Result<(FunctionAlias, Option<FunctionAlias>), Error> {
    let before = aliases_of(client, function_id)?.into_iter().find(|alias| alias.name == name);
    let mut body = Map::new();
    body.insert("functionVersion".into(), route.version.clone().into());
    if let Some(description) = description {
        body.insert("description".into(), description.into());
    }
    let alias: FunctionAlias = match &before {
        Some(existing) => {
            body.insert("routingConfig".into(), route.routing());
            body.insert("revisionId".into(), existing.revision_id.clone().into());
            client.json(&Call::put(format!("/functions/{function_id}/aliases/{name}"), Value::Object(body)))?
        }
        None => {
            body.insert("name".into(), name.into());
            if route.also.is_some() {
                body.insert("routingConfig".into(), route.routing());
            }
            client.json(&Call::post(format!("/functions/{function_id}/aliases"), Value::Object(body)))?
        }
    };
    Ok((alias, before))
}

/// `orders:live made: version 3`, or `orders:live: version 3 → version 2`.
pub fn set_text(function: &str, alias: &FunctionAlias, before: Option<&FunctionAlias>) -> String {
    match before {
        None => format!("{function}:{} made: {}", alias.name, alias.route()),
        Some(before) if before.route() == alias.route() => {
            format!("{function}:{}: {}, as it was", alias.name, alias.route())
        }
        Some(before) => format!("{function}:{}: {} → {}", alias.name, before.route(), alias.route()),
    }
}

pub fn alias_set(
    function: &str,
    name: &str,
    route: AliasRoute,
    description: Option<&str>,
    context: &Context,
) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let (alias, before) = set_alias(&client, &found.id, name, &route, description)?;
    let document = json!({ "alias": alias, "before": before });
    context.out.result(&document, || set_text(function, &alias, before.as_ref()))
}

fn urls_of(client: &Client, function_id: &str) -> Result<Vec<FunctionUrl>, Error> {
    client.json(&Call::get(format!("/functions/{function_id}/urls")))
}

pub fn alias_list(function: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let aliases = aliases_of(&client, &found.id)?;
    let urls = urls_of(&client, &found.id)?;
    let url_of =
        |name: &str| urls.iter().find(|url| url.alias.as_deref() == Some(name)).map(|url| url.function_url.clone());
    let document: Vec<Value> = aliases
        .iter()
        .map(|alias| {
            let mut entry = serde_json::to_value(alias).expect("an alias serializes");
            entry["functionUrl"] = url_of(&alias.name).map(Value::from).unwrap_or(Value::Null);
            entry
        })
        .collect();
    context.out.result(&document, || {
        if aliases.is_empty() {
            return format!("{function} has no alias: `ff alias set {function} live <version>` makes one");
        }
        let rows: Vec<Vec<String>> = aliases
            .iter()
            .map(|alias| {
                vec![
                    alias.name.clone(),
                    alias.route(),
                    url_of(&alias.name).unwrap_or_else(|| "-".to_owned()),
                    first_line(&alias.description, 40),
                ]
            })
            .collect();
        table(&["NAME", "ITS CALLS GO TO", "URL", "DESCRIPTION"], &rows)
    })
}

pub fn alias_remove(function: &str, name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    if !aliases_of(&client, &found.id)?.iter().any(|alias| alias.name == name) {
        return Err(Error::new(
            Kind::Failed,
            format!("{function} has no alias named \"{name}\": `ff alias list {function}` lists them"),
        ));
    }
    let url = urls_of(&client, &found.id)?.into_iter().find(|url| url.alias.as_deref() == Some(name));
    let question = match &url {
        Some(url) => format!("Remove {function}:{name}? Its URL {} goes with it, and its domains", url.function_url),
        None => format!("Remove {function}:{name}? The versions it names stay"),
    };
    if !confirmed("ff alias remove", &question, yes)? {
        return context.out.result(&json!({ "removed": false, "name": name }), || "Nothing removed".to_owned());
    }
    client.done(&Call::delete(format!("/functions/{}/aliases/{name}", found.id)))?;
    context.out.result(&json!({ "removed": true, "name": name }), || {
        format!("{function}:{name} removed: what names it stops until an alias of that name is made again")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias(version: &str, weights: Value) -> FunctionAlias {
        serde_json::from_value(json!({
            "aliasArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:orders:live", "name": "live",
            "functionVersion": version, "description": "", "routingConfig": { "additionalVersionWeights": weights },
            "revisionId": "r-1", "createdAt": "2026-11-02T08:00:00.000Z", "updatedAt": "2026-11-02T08:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn a_version_is_its_number_or_latest() {
        assert_eq!(version_named("3").unwrap(), "3");
        assert_eq!(version_named("$LATEST").unwrap(), "$LATEST");
        assert_eq!(version_named("latest").unwrap(), "$LATEST");
        for wrong in ["0", "03", "live", "-1", "1.5"] {
            let error = version_named(wrong).unwrap_err();
            assert_eq!(error.exit_code(), 2, "{wrong}");
            assert!(error.message.starts_with(&format!("{wrong} isn't a version")), "{}", error.message);
        }
    }

    #[test]
    fn a_qualifier_is_kept_as_given_latest_spared_its_quotes() {
        assert_eq!(
            [qualifier_named("live"), qualifier_named("3"), qualifier_named("latest")],
            ["live", "3", "$LATEST"]
        );
        assert_eq!(
            [runs_text(None), runs_text(Some("$LATEST")), runs_text(Some("3")), runs_text(Some("live"))],
            ["$LATEST", "$LATEST", "version 3", "alias live"]
        );
    }

    #[test]
    fn a_share_is_a_percentage_or_a_fraction() {
        assert_eq!(share_named("10%").unwrap(), 0.1);
        assert_eq!(share_named("0.25").unwrap(), 0.25);
        assert_eq!(share_named("100%").unwrap(), 1.0);
        assert_eq!(share_named("101%").unwrap_err().exit_code(), 2);
        assert_eq!(share_named("10").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn a_route_is_checked_as_the_api_checks_it_before_any_call() {
        let also = |other: &str, share: &str| vec![other.to_owned(), share.to_owned()];
        let route = AliasRoute::from_args("3", Some(&also("4", "10%"))).unwrap();
        assert_eq!(route.routing(), json!({ "additionalVersionWeights": { "4": 0.1 } }));
        assert_eq!(AliasRoute::from_args("latest", None).unwrap().routing(), json!({ "additionalVersionWeights": {} }));
        let beside_latest = AliasRoute::from_args("$LATEST", Some(&also("4", "10%"))).map(|_| ()).unwrap_err();
        assert!(beside_latest.message.contains("an alias naming $LATEST has none"), "{}", beside_latest.message);
        let own = AliasRoute::from_args("3", Some(&also("3", "10%"))).map(|_| ()).unwrap_err();
        assert_eq!(own.message, "--also names version 3, the alias's own: name another");
    }

    #[test]
    fn a_set_says_what_the_alias_was_and_is() {
        let canary = alias("3", json!({ "4": 0.1 }));
        assert_eq!(set_text("orders", &canary, None), "orders:live made: version 3, 10% of its calls to version 4");
        assert_eq!(
            set_text("orders", &alias("2", json!({})), Some(&canary)),
            "orders:live: version 3, 10% of its calls to version 4 → version 2"
        );
        assert_eq!(
            set_text("orders", &canary, Some(&canary)),
            "orders:live: version 3, 10% of its calls to version 4, as it was"
        );
    }

    #[test]
    fn a_version_lists_the_aliases_whose_calls_reach_it() {
        let aliases = [alias("3", json!({ "4": 0.1 })), FunctionAlias { name: "beta".into(), ..alias("4", json!({})) }];
        assert_eq!(aliases_on("3", &aliases), "live 90%");
        assert_eq!(aliases_on("4", &aliases), "live 10%, beta");
        assert_eq!(aliases_on("2", &aliases), "-");
        assert_eq!(short_sha("n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="), "n4bQgYhMfWWa…");
    }
}
