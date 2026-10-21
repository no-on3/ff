//! `ff deploy <file>`: the function of the file's name made, or updated with what changed, and
//! live once the API answers; its instances set after.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{Context, env};
use crate::api::types::{Function, FunctionView, Scaling, find};
use crate::api::{Call, Client};
use crate::cli::{DeployArgs, Runtime};
use crate::config::is_function_name;
use crate::error::{Error, Kind};
use crate::progress::Progress;

/// A deploy waits for its rollout: the API waits up to 90 s for the new version, then answers.
pub const DEPLOY_TIMEOUT: Duration = Duration::from_secs(120);
/// A new function's settings when the command names none: the getting-started guide's.
const DEFAULT_MEMORY: u32 = 128;
const DEFAULT_TIMEOUT: u32 = 5;

fn usage(message: impl Into<String>) -> Error {
    Error::new(Kind::Usage, message)
}

/// The name a file gives: its own without its extension; for `function.*`, the name of the file
/// `ff init` makes, its folder's.
fn file_name(file: &Path) -> String {
    let stem = file.file_stem().and_then(|stem| stem.to_str()).unwrap_or("");
    if stem == "function" {
        let folder =
            std::fs::canonicalize(file).ok().and_then(|path| Some(path.parent()?.file_name()?.to_str()?.to_owned()));
        if let Some(folder) = folder {
            return folder;
        }
    }
    stem.to_owned()
}

/// The name: `--name`, else the file's, by Lambda's rule.
pub fn name_of(file: &Path, name: Option<&str>) -> Result<String, Error> {
    let name = match name {
        Some(name) => name.to_owned(),
        None => file_name(file),
    };
    if is_function_name(&name) {
        Ok(name)
    } else {
        Err(usage(format!(
            "\"{name}\" can't be a function's name: 1 to 64 letters, digits, hyphens or underscores, as on AWS Lambda; name it with --name"
        )))
    }
}

/// The runtime: `--runtime`, else the file's extension.
pub fn runtime_of(file: &Path, runtime: Option<Runtime>) -> Result<Runtime, Error> {
    if let Some(runtime) = runtime {
        return Ok(runtime);
    }
    match file.extension().and_then(|extension| extension.to_str()) {
        Some("ts" | "js" | "cjs") => Ok(Runtime::Nodejs),
        Some("py") => Ok(Runtime::Python),
        other => Err(usage(format!(
            "Can't tell the runtime from {}: .ts, .js and .cjs are nodejs, .py python; or name it with --runtime",
            other
                .map(|extension| format!("the extension .{extension}"))
                .unwrap_or_else(|| "a file without an extension".to_owned())
        ))),
    }
}

/// What an update sends: only what differs from the function as it is.
pub fn changes(
    function: &Function,
    code: &str,
    runtime: Runtime,
    memory: Option<u32>,
    timeout: Option<u32>,
) -> Map<String, Value> {
    let mut changes = Map::new();
    if function.code != code {
        changes.insert("code".into(), code.into());
    }
    if function.runtime != runtime.as_str() {
        changes.insert("runtime".into(), runtime.as_str().into());
    }
    if let Some(memory) = memory.filter(|memory| *memory != function.memory) {
        changes.insert("memory".into(), memory.into());
    }
    if let Some(timeout) = timeout.filter(|timeout| *timeout != function.timeout) {
        changes.insert("timeout".into(), timeout.into());
    }
    changes
}

/// A refusal that names the function the API kept, which the new version never served: the
/// deploy failed (4), and the API's message is the diagnosis.
pub fn deploy_failed(mut error: Error) -> Error {
    let named = error.details.as_ref().and_then(|details| details.get("functionId")).is_some();
    if named && error.kind == Kind::Failed {
        error.kind = Kind::DeployFailed;
    }
    error
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Deployed<'a> {
    /// created, updated or unchanged.
    action: &'a str,
    changed: Vec<&'a str>,
    seconds: f64,
    function: FunctionView<'a>,
}

pub fn run(args: DeployArgs, context: &Context) -> Result<(), Error> {
    let code = std::fs::read_to_string(&args.file)
        .map_err(|error| usage(format!("Couldn't read {} as UTF-8 text: {error}", args.file.display())))?;
    let name = name_of(&args.file, args.name.as_deref())?;
    let runtime = runtime_of(&args.file, args.runtime)?;
    let environment = (!args.env.is_empty()).then(|| env::variables(&args.env)).transpose()?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let started = Instant::now();

    let (action, changed, function) = match find(&client, &name)? {
        Some(function) => update(&client, context, function, &code, runtime, environment.as_ref(), &args)?,
        None => {
            let memory = args.memory.unwrap_or(DEFAULT_MEMORY);
            let timeout = args.timeout.unwrap_or(DEFAULT_TIMEOUT);
            let mut body = json!({ "name": name, "runtime": runtime.as_str(), "code": code, "memory": memory, "timeout": timeout });
            if let Some(environment) = &environment {
                body["environment"] = json!(environment);
            }
            let progress = Progress::start(
                context.out,
                &format!("creating {name} ({}, {memory} MB, {timeout} s)", runtime.as_str()),
            );
            let created = client.json::<Function>(&Call::post("/functions", body).timeout(DEPLOY_TIMEOUT));
            progress.stop();
            match created {
                Ok(function) => ("created", vec!["code", "runtime", "memory", "timeout"], function),
                // Another deploy took the name meanwhile: this one updates that function.
                Err(error) if error.status == Some(409) => match find(&client, &name)? {
                    Some(function) => update(&client, context, function, &code, runtime, environment.as_ref(), &args)?,
                    None => return Err(error),
                },
                Err(error) => return Err(deploy_failed(error)),
            }
        }
    };
    let seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;

    let function = if args.min_instances.is_some() || args.max_instances.is_some() {
        let mut body = Map::new();
        if let Some(min) = args.min_instances {
            body.insert("minInstances".into(), min.into());
        }
        if let Some(max) = args.max_instances {
            body.insert("maxInstances".into(), max.into());
        }
        let scaling: Scaling =
            client.json(&Call::put(format!("/functions/{}/scaling-config", function.id), Value::Object(body)))?;
        Function {
            min_instances: scaling.min_instances,
            max_instances: scaling.max_instances,
            scale_to_zero: scaling.scale_to_zero,
            ..function
        }
    } else {
        function
    };

    let deployed = Deployed { action, changed, seconds, function: function.view() };
    context.out.result(&deployed, || match action {
        "unchanged" => format!(
            "{name}: no changes ({}, {} MB, {} s, {})",
            function.runtime, function.memory, function.timeout, function.status
        ),
        _ => format!(
            "{action} {name} ({}, {} MB, {} s): {} in {seconds} s{}",
            function.runtime,
            function.memory,
            function.timeout,
            function.status,
            if action == "updated" { format!(", changed: {}", deployed.changed.join(", ")) } else { String::new() }
        ),
    })
}

/// The function updated with what changed, or left as it is. Variables given replace them all,
/// as on Lambda; their values are read first, as the list of functions doesn't hold them.
fn update<'a>(
    client: &Client,
    context: &Context,
    function: Function,
    code: &str,
    runtime: Runtime,
    environment: Option<&env::Variables>,
    args: &DeployArgs,
) -> Result<(&'a str, Vec<&'a str>, Function), Error> {
    let mut changes = changes(&function, code, runtime, args.memory, args.timeout);
    if let Some(environment) = environment {
        let current = env::current(&client.json::<Function>(&Call::get(format!("/functions/{}", function.id)))?);
        if &current != environment {
            changes.insert("environment".into(), json!(environment));
        }
    }
    if changes.is_empty() {
        return Ok(("unchanged", Vec::new(), function));
    }
    let changed: Vec<&'a str> = ["code", "runtime", "memory", "timeout", "environment"]
        .into_iter()
        .filter(|field| changes.contains_key(*field))
        .collect();
    let progress = Progress::start(context.out, &format!("updating {} ({})", function.name, changed.join(", ")));
    let updated = client.json::<Function>(
        &Call::put(format!("/functions/{}", function.id), Value::Object(changes)).timeout(DEPLOY_TIMEOUT),
    );
    progress.stop();
    Ok(("updated", changed, updated.map_err(deploy_failed)?))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn function() -> Function {
        serde_json::from_value(json!({
            "id": "f1", "name": "hello", "runtime": "python", "code": "def handler(e, c): return 1\n", "memory": 128, "timeout": 5,
            "status": "ACTIVE", "minInstances": 0, "maxInstances": 3, "scaleToZero": true,
            "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn the_name_is_the_files_unless_named_and_follows_lambdas_rule() {
        assert_eq!(name_of(&PathBuf::from("examples/hello.py"), None).unwrap(), "hello");
        assert_eq!(name_of(&PathBuf::from("src/index.ts"), Some("orders-api")).unwrap(), "orders-api");

        let refused = name_of(&PathBuf::from("my function.py"), None).unwrap_err();
        assert_eq!(refused.exit_code(), 2);
        assert!(
            refused.message.starts_with("\"my function\" can't be a function's name: 1 to 64 letters"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn a_function_file_takes_its_folders_name_as_ff_init_makes_them() {
        let dir = tempfile::TempDir::new().unwrap();
        let folder = dir.path().join("orders-api");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("function.py"), "").unwrap();

        assert_eq!(name_of(&folder.join("function.py"), None).unwrap(), "orders-api");
        assert_eq!(name_of(&folder.join("function.py"), Some("orders")).unwrap(), "orders");
    }

    #[test]
    fn the_runtime_comes_from_the_extension_unless_named() {
        let runtime = |file: &str| runtime_of(&PathBuf::from(file), None).map_err(|error| error.message);

        assert_eq!(runtime("a.ts"), Ok(Runtime::Nodejs));
        assert_eq!(runtime("a.js"), Ok(Runtime::Nodejs));
        assert_eq!(runtime("a.cjs"), Ok(Runtime::Nodejs));
        assert_eq!(runtime("a.py"), Ok(Runtime::Python));
        assert_eq!(runtime_of(&PathBuf::from("handler"), Some(Runtime::Python)).unwrap(), Runtime::Python);
        assert_eq!(
            runtime("a.rb"),
            Err("Can't tell the runtime from the extension .rb: .ts, .js and .cjs are nodejs, .py python; or name it with --runtime".into())
        );
        assert!(runtime("Makefile").unwrap_err().contains("a file without an extension"));
    }

    #[test]
    fn an_update_sends_only_what_differs() {
        let function = function();

        assert!(changes(&function, &function.code, Runtime::Python, None, None).is_empty());
        assert!(changes(&function, &function.code, Runtime::Python, Some(128), Some(5)).is_empty());
        assert_eq!(
            Value::Object(changes(&function, "def handler(e, c): return 2\n", Runtime::Python, Some(256), None)),
            json!({ "code": "def handler(e, c): return 2\n", "memory": 256 })
        );
        assert_eq!(
            Value::Object(changes(&function, &function.code, Runtime::Nodejs, None, Some(10))),
            json!({ "runtime": "nodejs", "timeout": 10 })
        );
    }

    #[test]
    fn a_refusal_naming_the_kept_function_is_a_failed_deploy() {
        let mut kept = Error::new(Kind::Failed, "The function failed to load: SyntaxError: invalid syntax");
        kept.details = Some(json!({ "functionId": "f1" }));
        let validation = Error::new(Kind::Failed, "memory must not be greater than 1024");
        let mut plan = Error::new(Kind::RefusedByAccount, "The beta plan allows 25 functions");
        plan.details = Some(json!({ "functionId": "f1" }));

        assert_eq!(
            [deploy_failed(kept).exit_code(), deploy_failed(validation).exit_code(), deploy_failed(plan).exit_code()],
            [4, 3, 6]
        );
    }
}
