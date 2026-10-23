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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub limits: serde_json::Map<String, serde_json::Value>,
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
