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

/// A function as ff prints it for scripts: its settings and state, its code's size rather than
/// its code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionView<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub runtime: &'a str,
    pub memory: u32,
    pub timeout: u32,
    pub status: &'a str,
    pub error: Option<&'a str>,
    pub event_format: Option<&'a str>,
    pub min_instances: u32,
    pub max_instances: u32,
    pub scale_to_zero: bool,
    pub code_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<&'a serde_json::Map<String, serde_json::Value>>,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

impl Function {
    pub fn view(&self) -> FunctionView<'_> {
        FunctionView {
            id: &self.id,
            name: &self.name,
            runtime: &self.runtime,
            memory: self.memory,
            timeout: self.timeout,
            status: &self.status,
            error: self.error.as_deref(),
            event_format: self.event_format.as_deref(),
            min_instances: self.min_instances,
            max_instances: self.max_instances,
            scale_to_zero: self.scale_to_zero,
            code_size: self.code.len(),
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
