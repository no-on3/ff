//! The API's records as ff reads them, and the lookups every command on a function starts with.

use serde::{Deserialize, Serialize};

use super::{Call, Client};
use crate::error::{Error, Kind};

/// A function, as `GET /functions` and `GET /functions/:id` answer it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    pub id: String,
    pub name: String,
    pub runtime: String,
    #[serde(default)]
    pub code: String,
    /// How its code comes, `inline` or `zip`; this and the three below are absent from an API before packages.
    #[serde(default)]
    pub package_type: Option<String>,
    /// What its runtime calls, as AWS Lambda's handler: `function.handler` unless it names another.
    #[serde(default)]
    pub handler: Option<String>,
    /// The SHA-256 of its code, in base64, as AWS Lambda's CodeSha256.
    #[serde(default)]
    pub code_sha256: Option<String>,
    /// Its code's size in bytes, as AWS Lambda's CodeSize.
    #[serde(default)]
    pub code_size: Option<u64>,
    pub memory: u32,
    pub timeout: u32,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub event_format: Option<String>,
    pub min_instances: u32,
    pub max_instances: u32,
    pub scale_to_zero: bool,
    /// Its variables, in `GET /functions/:id` only.
    #[serde(default)]
    pub environment: Option<serde_json::Map<String, serde_json::Value>>,
    pub created_at: String,
    pub updated_at: String,
}

/// A package the account has, as `POST /packages` and `GET /packages` answer it: its SHA-256
/// is what ff reads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPackage {
    pub code_sha256: String,
}

/// A function as ff prints it for scripts: its settings and state, its code's size rather than
/// its code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionView<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub runtime: &'a str,
    pub package_type: Option<&'a str>,
    pub handler: Option<&'a str>,
    pub memory: u32,
    pub timeout: u32,
    pub status: &'a str,
    pub error: Option<&'a str>,
    pub event_format: Option<&'a str>,
    pub min_instances: u32,
    pub max_instances: u32,
    pub scale_to_zero: bool,
    pub code_size: u64,
    pub code_sha256: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<&'a serde_json::Map<String, serde_json::Value>>,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

impl Function {
    /// Its code's size: the API's, or its inline code's from an API before packages.
    pub fn code_size(&self) -> u64 {
        self.code_size.unwrap_or(self.code.len() as u64)
    }

    pub fn view(&self) -> FunctionView<'_> {
        FunctionView {
            id: &self.id,
            name: &self.name,
            runtime: &self.runtime,
            package_type: self.package_type.as_deref(),
            handler: self.handler.as_deref(),
            memory: self.memory,
            timeout: self.timeout,
            status: &self.status,
            error: self.error.as_deref(),
            event_format: self.event_format.as_deref(),
            min_instances: self.min_instances,
            max_instances: self.max_instances,
            scale_to_zero: self.scale_to_zero,
            code_size: self.code_size(),
            code_sha256: self.code_sha256.as_deref(),
            environment: self.environment.as_ref(),
            created_at: &self.created_at,
            updated_at: &self.updated_at,
        }
    }
}

/// One call of a function, as the API keeps it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    pub id: String,
    /// The request's: an asynchronous call's attempts keep the first's. Missing from an older API, where it is the ID.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Which attempt of its request it was: an asynchronous call's from 1.
    #[serde(default)]
    pub attempt: Option<u32>,
    pub status: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub memory_used: Option<f64>,
    /// The event, as the history keeps it: up to 64 KiB of it, a string of its start when cut.
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default)]
    pub output: serde_json::Value,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
}

/// A page of a function's calls, newest first.
#[derive(Debug, Deserialize, Serialize)]
pub struct InvocationPage {
    pub invocations: Vec<Invocation>,
    pub total: u64,
}

/// How many instances a function keeps, and runs at most.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scaling {
    pub min_instances: u32,
    pub max_instances: u32,
    pub scale_to_zero: bool,
}

/// `GET /me`: the user, or the API key, and the accounts it reaches.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Me {
    pub user: Option<MeUser>,
    #[serde(default)]
    pub key: Option<MeKey>,
    pub accounts: Vec<MeAccount>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MeUser {
    pub email: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MeKey {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
}

/// An account as `GET /me` gives it: the caller's role in it, its plan with its limits.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeAccount {
    pub id: String,
    pub name: String,
    pub status: String,
    pub role: String,
    pub plan: Plan,
    #[serde(default)]
    pub internet_egress: Option<bool>,
    #[serde(default)]
    pub data_deletion_due_at: Option<String>,
    #[serde(default)]
    pub data_deleted_at: Option<String>,
    /// FF's region and endpoints, for AWS's tools; none from an API older than this ff.
    #[serde(default)]
    pub aws: Option<AwsEndpoints>,
}

/// FF's region and the endpoints AWS's tools reach the account's buckets, queues, mail and functions at, as
/// `GET /me` gives them with each account; each but S3's empty where FF has none.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsEndpoints {
    pub region: String,
    pub s3_endpoint: String,
    #[serde(default)]
    pub sqs_endpoint: String,
    #[serde(default)]
    pub ses_endpoint: String,
    #[serde(default)]
    pub lambda_endpoint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub limits: serde_json::Map<String, serde_json::Value>,
}

/// `$LATEST`, the function as it is: what a call, an alias, a schedule or a queue reader runs when it names no version.
pub const LATEST: &str = "$LATEST";

/// A version, as `GET /functions/:id/versions` lists it: the function as it was published, which never changes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionVersion {
    pub function_id: String,
    pub function_arn: String,
    /// Its number, as Lambda writes it: "1", "2", "3"…
    pub version: String,
    pub description: String,
    pub runtime: String,
    pub handler: String,
    pub package_type: String,
    pub code_sha256: String,
    pub code_size: u64,
    pub memory: u32,
    pub timeout: u32,
    pub event_format: String,
    pub aws_endpoints: Vec<String>,
    pub revision_id: String,
    pub created_at: String,
}

/// An alias, as `GET /functions/:id/aliases` lists it: a name for a version, or `$LATEST`, with at most one
/// more version and its share of the calls.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionAlias {
    pub alias_arn: String,
    pub name: String,
    /// `$LATEST`, or the number of the version its calls go to.
    pub function_version: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_config: Option<RoutingConfig>,
    pub revision_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingConfig {
    /// One version, by its number, and its share of the calls, from 0 to 1.
    pub additional_version_weights: std::collections::BTreeMap<String, f64>,
}

impl FunctionAlias {
    /// The other version that gets a share of its calls, and that share, from 0 to 1.
    pub fn share(&self) -> Option<(&str, f64)> {
        let weights = &self.routing_config.as_ref()?.additional_version_weights;
        weights.iter().next().map(|(version, weight)| (version.as_str(), *weight))
    }

    /// Where its calls go, in words: `version 3`, `$LATEST`, `version 3, 10% of its calls to version 4`.
    pub fn route(&self) -> String {
        let own = if self.function_version == LATEST {
            LATEST.to_owned()
        } else {
            format!("version {}", self.function_version)
        };
        match self.share() {
            Some((version, weight)) => format!("{own}, {} of its calls to version {version}", percent(weight)),
            None => own,
        }
    }
}

/// A share of the calls as a percentage, to a tenth: 0.1 is `10%`, 0.125 `12.5%`.
pub fn percent(weight: f64) -> String {
    format!("{}%", (weight * 1000.0).round() / 10.0)
}

/// A function's name as Lambda takes it, with a version or an alias after a colon (`orders:live`): the name, and
/// the qualifier when there is one, `$LATEST` as none. A function's name has no colon.
pub fn split_qualified(name: &str) -> (&str, Option<&str>) {
    match name.split_once(':') {
        Some((function, qualifier)) if !qualifier.is_empty() && qualifier != LATEST => (function, Some(qualifier)),
        Some((function, _)) => (function, None),
        None => (name, None),
    }
}

/// The name in an ARN: a function's, without the version or alias after it; else its last part, a
/// queue's or a bucket's.
pub fn name_in_arn(arn: &str) -> &str {
    match arn.split_once(":function:") {
        Some((_, rest)) => rest.split(':').next().unwrap_or(rest),
        None => arn.rsplit(':').next().unwrap_or(arn),
    }
}

/// The name in an ARN as people read it: a function's, with the version or the alias that qualifies it after a
/// colon, as Lambda writes a qualified name (`thumbnails:live`), `$LATEST` as none; else its last part.
pub fn qualified_name_in_arn(arn: &str) -> &str {
    match arn.split_once(":function:") {
        Some((_, rest)) => rest.strip_suffix(":$LATEST").unwrap_or(rest),
        None => name_in_arn(arn),
    }
}

/// The account's function of that name: `GET /functions?name=`, compared exactly.
pub fn find(client: &Client, name: &str) -> Result<Option<Function>, Error> {
    let found: Vec<Function> = client.json(&Call::get("/functions").query("name", name))?;
    Ok(found.into_iter().find(|function| function.name == name))
}

/// The account's function of that name, or why there is none.
pub fn function_named(client: &Client, name: &str) -> Result<Function, Error> {
    find(client, name)?.ok_or_else(|| {
        Error::new(
            Kind::Failed,
            format!("There is no function named \"{name}\" in the account: `ff list` shows its functions"),
        )
    })
}

/// The function's versions, oldest first.
pub fn versions_of(client: &Client, function_id: &str) -> Result<Vec<FunctionVersion>, Error> {
    client.json(&Call::get(format!("/functions/{function_id}/versions")))
}

/// The function's aliases, by name.
pub fn aliases_of(client: &Client, function_id: &str) -> Result<Vec<FunctionAlias>, Error> {
    client.json(&Call::get(format!("/functions/{function_id}/aliases")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alias(version: &str, weights: serde_json::Value) -> FunctionAlias {
        serde_json::from_value(json!({
            "aliasArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:orders:live", "name": "live",
            "functionVersion": version, "description": "", "routingConfig": { "additionalVersionWeights": weights },
            "revisionId": "r-1", "createdAt": "2026-11-02T08:00:00.000Z", "updatedAt": "2026-11-02T08:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn a_qualified_name_is_the_function_and_its_version_or_alias() {
        assert_eq!(split_qualified("orders:live"), ("orders", Some("live")));
        assert_eq!(split_qualified("orders:3"), ("orders", Some("3")));
        assert_eq!(split_qualified("orders"), ("orders", None));
        assert_eq!(split_qualified("orders:$LATEST"), ("orders", None));
        assert_eq!(split_qualified("orders:"), ("orders", None));
    }

    #[test]
    fn an_alias_says_where_its_calls_go() {
        assert_eq!(alias("3", json!({})).route(), "version 3");
        assert_eq!(alias("$LATEST", json!({})).route(), "$LATEST");
        assert_eq!(alias("3", json!({ "4": 0.125 })).route(), "version 3, 12.5% of its calls to version 4");
        assert_eq!(alias("3", json!({ "4": 0.1 })).share(), Some(("4", 0.1)));
        assert_eq!([percent(0.0), percent(1.0), percent(0.05)], ["0%", "100%", "5%"]);
    }

    #[test]
    fn a_version_and_an_alias_have_the_apis_fields() {
        use crate::backend_source::{class_fields, sorted, sorted_keys};
        let version: FunctionVersion = serde_json::from_value(json!({
            "functionId": "f1", "functionArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:orders:1", "version": "1",
            "description": "", "runtime": "python", "handler": "orders.handler", "packageType": "Zip", "codeSha256": "c1",
            "codeSize": 99, "memory": 128, "timeout": 5, "eventFormat": "lambda", "awsEndpoints": [], "revisionId": "v-1",
            "createdAt": "2026-11-02T08:00:00.000Z"
        }))
        .unwrap();
        // The list ff reads leaves out a version's variables, which a single version's answer alone has.
        let version_view =
            class_fields(include_str!("../../../BE/src/functions/dto/versions.dto.ts"), "FunctionVersionView");
        assert_eq!(
            sorted_keys(&version),
            sorted(version_view.into_iter().filter(|field| field != "environment").collect())
        );
        let alias_view =
            class_fields(include_str!("../../../BE/src/functions/dto/aliases.dto.ts"), "FunctionAliasView");
        assert_eq!(sorted_keys(&alias("3", json!({ "4": 0.1 }))), sorted(alias_view));
    }
}
