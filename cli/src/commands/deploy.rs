//! `ff deploy <file>` and `ff deploy <folder>`: the function of that name made, or updated with
//! what changed, and live once the API answers; its instances set after. A file is inline code,
//! its text alone; a folder is a package, made with its libraries as `ff package` makes it, and
//! uploaded only when the account hasn't it.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::package::{folder_name, handler_of, size};
use super::{Context, env};
use crate::api::types::{Function, FunctionView, Scaling, StoredPackage, find};
use crate::api::{Call, Client};
use crate::cli::{DeployArgs, Runtime};
use crate::config::is_function_name;
use crate::error::{Error, Kind};
use crate::output::Output;
use crate::package::{self, Options, Package};
use crate::progress::Progress;

/// A deploy waits for its rollout: the API waits up to 90 s for the new version, then answers.
pub const DEPLOY_TIMEOUT: Duration = Duration::from_secs(120);
/// A new function's settings when the command names none: the getting-started guide's.
const DEFAULT_MEMORY: u32 = 128;
const DEFAULT_TIMEOUT: u32 = 5;
/// Inline code's handler unless one is named: the API's own default.
const INLINE_HANDLER: &str = "function.handler";

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

/// `--name`, else the one the file or the folder gives, by Lambda's rule.
fn checked_name(name: String) -> Result<String, Error> {
    if is_function_name(&name) {
        Ok(name)
    } else {
        Err(Error::usage(format!(
            "\"{name}\" can't be a function's name: 1 to 64 letters, digits, hyphens or underscores, as on AWS Lambda; name it with --name"
        )))
    }
}

/// The name: `--name`, else the file's, by Lambda's rule.
pub fn name_of(file: &Path, name: Option<&str>) -> Result<String, Error> {
    checked_name(name.map(str::to_owned).unwrap_or_else(|| file_name(file)))
}

/// The runtime: `--runtime`, else the file's extension.
pub fn runtime_of(file: &Path, runtime: Option<Runtime>) -> Result<Runtime, Error> {
    if let Some(runtime) = runtime {
        return Ok(runtime);
    }
    match file.extension().and_then(|extension| extension.to_str()) {
        Some("ts" | "js" | "cjs") => Ok(Runtime::Nodejs),
        Some("py") => Ok(Runtime::Python),
        other => Err(Error::usage(format!(
            "Can't tell the runtime from {}: .ts, .js and .cjs are nodejs, .py python; or name it with --runtime",
            other
                .map(|extension| format!("the extension .{extension}"))
                .unwrap_or_else(|| "a file without an extension".to_owned())
        ))),
    }
}

/// What a deploy gives the function as its code.
#[derive(Clone, Copy, Debug)]
pub enum Code<'a> {
    /// A file's text, which the API keeps as the function's one file.
    Inline(&'a str),
    /// A package of the account's, named by its SHA-256.
    Package(&'a str),
}

/// What a deploy makes the function: its code and the settings the command names.
pub struct Wanted<'a> {
    pub code: Code<'a>,
    pub handler: Option<&'a str>,
    pub runtime: Runtime,
    pub memory: Option<u32>,
    pub timeout: Option<u32>,
}

fn runs_package(function: &Function) -> bool {
    function.package_type.as_deref() == Some("zip")
}

/// What an update sends: only what differs from the function as it is. Inline code's handler
/// is `function.<name>`, so a package's goes with it unless one is named.
pub fn changes(function: &Function, wanted: &Wanted) -> Map<String, Value> {
    let mut changes = Map::new();
    let package = runs_package(function);
    match wanted.code {
        Code::Inline(code) if package || function.code != code => {
            changes.insert("code".into(), code.into());
        }
        Code::Package(code_sha256) if !package || function.code_sha256.as_deref() != Some(code_sha256) => {
            changes.insert("codeSha256".into(), code_sha256.into());
        }
        _ => {}
    }
    let handler = match (wanted.handler, wanted.code) {
        (Some(handler), _) => Some(handler),
        (None, Code::Inline(_)) if package => Some(INLINE_HANDLER),
        _ => None,
    };
    if let Some(handler) = handler.filter(|handler| function.handler.as_deref() != Some(*handler)) {
        changes.insert("handler".into(), handler.into());
    }
    if function.runtime != wanted.runtime.as_str() {
        changes.insert("runtime".into(), wanted.runtime.as_str().into());
    }
    if let Some(memory) = wanted.memory.filter(|memory| *memory != function.memory) {
        changes.insert("memory".into(), memory.into());
    }
    if let Some(timeout) = wanted.timeout.filter(|timeout| *timeout != function.timeout) {
        changes.insert("timeout".into(), timeout.into());
    }
    changes
}

/// The fields a deploy changed, as it says them: a package's hash is its code.
fn changed_fields(changes: &Map<String, Value>) -> Vec<&'static str> {
    [("code", "code"), ("codeSha256", "code"), ("handler", "handler"), ("runtime", "runtime")]
        .into_iter()
        .chain([("memory", "memory"), ("timeout", "timeout"), ("environment", "environment")])
        .filter(|(field, _)| changes.contains_key(*field))
        .map(|(_, said)| said)
        .collect()
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

/// The API's answer to a function naming a package the account no longer has: the hourly purge
/// took it between ff's question and the rollout, as it takes one unused for an hour.
fn package_gone(error: &Error) -> bool {
    error.status == Some(400) && error.message.contains("has no package")
}

/// Sends the package's zip; the API answers its SHA-256, which must be the one ff made.
fn upload(client: &Client, out: &Output, package: &Package) -> Result<(), Error> {
    let bytes = package.zip.len() as u64;
    let progress = Progress::start(out, &format!("uploading the package ({})", size(bytes)));
    // 50 MB over a slow link: a minute, and a second per 100 KB.
    let timeout = Duration::from_secs(60 + bytes / 100_000);
    let stored = client
        .json::<StoredPackage>(&Call::post_bytes("/packages", package.zip.clone(), "application/zip").timeout(timeout));
    progress.stop();
    let stored = stored?;
    if stored.code_sha256 != package.code_sha256 {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "The API kept the package as {}, where ff made {}: deploy again",
                stored.code_sha256, package.code_sha256
            ),
        ));
    }
    Ok(())
}

/// The package uploaded unless the account has it: whether its bytes were sent.
fn provide(client: &Client, out: &Output, package: &Package) -> Result<bool, Error> {
    let found: Vec<StoredPackage> = client.json(&Call::get("/packages").query("codeSha256", &package.code_sha256))?;
    if found.iter().any(|stored| stored.code_sha256 == package.code_sha256) {
        return Ok(false);
    }
    upload(client, out, package)?;
    Ok(true)
}

/// A create or an update, its progress shown; naming a package the purge took meanwhile, the
/// package is sent again and the call tried once more.
fn rollout(
    client: &Client,
    out: &Output,
    doing: &str,
    package: Option<&Package>,
    uploaded: &mut bool,
    call: &Call,
) -> Result<Function, Error> {
    let send = || {
        let progress = Progress::start(out, doing);
        let answer = client.json::<Function>(call);
        progress.stop();
        answer
    };
    match (send(), package) {
        (Err(error), Some(package)) if package_gone(&error) => {
            upload(client, out, package)?;
            *uploaded = true;
            send()
        }
        (answer, _) => answer,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageSent<'a> {
    code_sha256: &'a str,
    code_size: u64,
    unpacked_size: u64,
    file_count: usize,
    /// Whether its bytes were sent: else the account had it, or the code didn't change.
    uploaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Deployed<'a> {
    /// created, updated or unchanged.
    action: &'a str,
    changed: Vec<&'a str>,
    seconds: f64,
    function: FunctionView<'a>,
    /// A folder's package, as made.
    #[serde(skip_serializing_if = "Option::is_none")]
    package: Option<PackageSent<'a>>,
}

/// What one deploy is about: the function's name, what it should be, and its package.
struct Deploy<'a> {
    name: String,
    wanted: Wanted<'a>,
    environment: Option<env::Variables>,
    package: Option<&'a Package>,
    /// What the code comes from, as the command named it.
    source: &'a Path,
}

pub fn run(args: DeployArgs, context: &Context) -> Result<(), Error> {
    let environment = (!args.env.is_empty()).then(|| env::variables(&args.env)).transpose()?;
    if args.path.is_dir() {
        return run_folder(&args, environment, context);
    }
    if args.build.container || args.build.no_build {
        return Err(Error::usage(
            "--container and --no-build are for a folder, which ff packages: a file is deployed as it is",
        ));
    }
    if args.path.extension().is_some_and(|extension| extension == "zip") {
        return Err(Error::usage(format!(
            "{} is a zip: ff deploy takes the function's folder, which it packages itself, or its code's one file",
            args.path.display()
        )));
    }
    let code = std::fs::read_to_string(&args.path)
        .map_err(|error| Error::usage(format!("Couldn't read {} as UTF-8 text: {error}", args.path.display())))?;
    let name = name_of(&args.path, args.name.as_deref())?;
    let runtime = runtime_of(&args.path, args.runtime)?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let wanted = Wanted {
        code: Code::Inline(&code),
        handler: args.handler.as_deref(),
        runtime,
        memory: args.memory,
        timeout: args.timeout,
    };
    let deploy = Deploy { name, wanted, environment, package: None, source: &args.path };
    let existing = find(&client, &deploy.name)?;
    finish(&client, context, &deploy, existing, &args)
}

/// A folder: packaged first, as `ff package` does, then deployed by its SHA-256. The handler
/// is the one named, else the function's while the package has its module, else the one the
/// package's files say.
fn run_folder(args: &DeployArgs, environment: Option<env::Variables>, context: &Context) -> Result<(), Error> {
    let name = checked_name(match &args.name {
        Some(name) => name.clone(),
        None => folder_name(&args.path)?,
    })?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let options = Options {
        runtime: args.runtime,
        container: args.build.container,
        no_build: args.build.no_build,
        compile: false,
        leave_out: None,
    };
    let package = package::build(&args.path, &options, context.out)?;
    let named = handler_of(&package, args.handler.as_deref())?;
    let existing = find(&client, &name)?;
    let kept = existing
        .as_ref()
        .and_then(|function| function.handler.clone())
        .filter(|handler| package::handler_problem(&package.files, handler, package.runtime).is_none());
    let handler = match (args.handler.is_some(), named, kept) {
        (true, named, _) => named,
        (false, _, Some(kept)) => Some(kept),
        (false, default, None) => default,
    }
    .ok_or_else(|| {
        Error::usage(format!(
            "Can't tell the handler of {}: it has no function.* file, nor {}; name it with --handler, such as src/app.handler",
            args.path.display(),
            match package.runtime {
                Runtime::Nodejs => "index.js, .mjs, .cjs or .ts",
                Runtime::Python => "lambda_function.py",
            }
        ))
    })?;
    let wanted = Wanted {
        code: Code::Package(&package.code_sha256),
        handler: Some(&handler),
        runtime: package.runtime,
        memory: args.memory,
        timeout: args.timeout,
    };
    let deploy = Deploy { name, wanted, environment, package: Some(&package), source: &args.path };
    finish(&client, context, &deploy, existing, args)
}

/// The function made or updated, its instances set, and what happened said.
fn finish(
    client: &Client,
    context: &Context,
    deploy: &Deploy,
    existing: Option<Function>,
    args: &DeployArgs,
) -> Result<(), Error> {
    let started = Instant::now();
    let mut uploaded = false;
    let (action, changed, function) = match existing {
        Some(function) => update(client, context, function, deploy, &mut uploaded)?,
        None => create(client, context, deploy, &mut uploaded)?,
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

    let package = deploy.package.map(|package| PackageSent {
        code_sha256: &package.code_sha256,
        code_size: package.zip.len() as u64,
        unpacked_size: package.unpacked,
        file_count: package.files.len(),
        uploaded,
    });
    let name = &deploy.name;
    // Said when the code changed: the package then went up, or the account had it.
    let package_line = match &package {
        Some(package) if changed.contains(&"code") => format!(
            "\npackage: {} files, {}, {}",
            package.file_count,
            size(package.code_size),
            if package.uploaded { "uploaded" } else { "which the account had" }
        ),
        _ => String::new(),
    };
    let deployed = Deployed { action, changed, seconds, function: function.view(), package };
    context.out.result(&deployed, || match action {
        "unchanged" => format!(
            "{name}: no changes ({}, {} MB, {} s, {})",
            function.runtime, function.memory, function.timeout, function.status
        ),
        _ => format!(
            "{action} {name} ({}, {} MB, {} s): {} in {seconds} s{}{package_line}",
            function.runtime,
            function.memory,
            function.timeout,
            function.status,
            if action == "updated" { format!(", changed: {}", deployed.changed.join(", ")) } else { String::new() }
        ),
    })
}

/// The function made; when another deploy took the name meanwhile, that function updated.
fn create<'a>(
    client: &Client,
    context: &Context,
    deploy: &Deploy,
    uploaded: &mut bool,
) -> Result<(&'a str, Vec<&'a str>, Function), Error> {
    let wanted = &deploy.wanted;
    let memory = wanted.memory.unwrap_or(DEFAULT_MEMORY);
    let timeout = wanted.timeout.unwrap_or(DEFAULT_TIMEOUT);
    let mut body =
        json!({ "name": deploy.name, "runtime": wanted.runtime.as_str(), "memory": memory, "timeout": timeout });
    match wanted.code {
        Code::Inline(code) => body["code"] = code.into(),
        Code::Package(code_sha256) => body["codeSha256"] = code_sha256.into(),
    }
    if let Some(handler) = wanted.handler {
        body["handler"] = handler.into();
    }
    if let Some(environment) = &deploy.environment {
        body["environment"] = json!(environment);
    }
    if let Some(package) = deploy.package {
        *uploaded = provide(client, context.out, package)?;
    }
    let doing = format!("creating {} ({}, {memory} MB, {timeout} s)", deploy.name, wanted.runtime.as_str());
    let call = Call::post("/functions", body).timeout(DEPLOY_TIMEOUT);
    match rollout(client, context.out, &doing, deploy.package, uploaded, &call) {
        Ok(function) => {
            let handler = wanted.handler.map(|_| "handler");
            let changed = ["code"].into_iter().chain(handler).chain(["runtime", "memory", "timeout"]).collect();
            Ok(("created", changed, function))
        }
        // Another deploy took the name meanwhile: this one updates that function.
        Err(error) if error.status == Some(409) => match find(client, &deploy.name)? {
            Some(function) => update(client, context, function, deploy, uploaded),
            None => Err(error),
        },
        Err(error) => Err(deploy_failed(error)),
    }
}

/// The function updated with what changed, or left as it is. Variables given replace them all,
/// as on Lambda; their values are read first, as the list of functions doesn't hold them.
fn update<'a>(
    client: &Client,
    context: &Context,
    function: Function,
    deploy: &Deploy,
    uploaded: &mut bool,
) -> Result<(&'a str, Vec<&'a str>, Function), Error> {
    let mut changes = changes(&function, &deploy.wanted);
    if let Some(environment) = &deploy.environment {
        let current = env::current(&client.json::<Function>(&Call::get(format!("/functions/{}", function.id)))?);
        if &current != environment {
            changes.insert("environment".into(), json!(environment));
        }
    }
    if changes.is_empty() {
        return Ok(("unchanged", Vec::new(), function));
    }
    let name = &function.name;
    if changes.contains_key("code") && runs_package(&function) {
        context.out.warn(&format!(
            "{name} ran a package: it becomes inline code, {} alone, its handler {}",
            deploy.source.display(),
            changes.get("handler").and_then(Value::as_str).or(function.handler.as_deref()).unwrap_or(INLINE_HANDLER)
        ));
    }
    if changes.contains_key("codeSha256") && !runs_package(&function) {
        context
            .out
            .warn(&format!("{name} ran inline code: it becomes a package, which the console shows but doesn't edit"));
    }
    if let (Some(package), true) = (deploy.package, changes.contains_key("codeSha256")) {
        *uploaded = provide(client, context.out, package)?;
    }
    let changed = changed_fields(&changes);
    let doing = format!("updating {name} ({})", changed.join(", "));
    let call = Call::put(format!("/functions/{}", function.id), Value::Object(changes)).timeout(DEPLOY_TIMEOUT);
    let updated = rollout(client, context.out, &doing, deploy.package, uploaded, &call);
    Ok(("updated", changed, updated.map_err(deploy_failed)?))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn function() -> Function {
        serde_json::from_value(json!({
            "id": "f1", "name": "hello", "runtime": "python", "code": "def handler(e, c): return 1\n", "memory": 128, "timeout": 5,
            "packageType": "inline", "handler": "function.handler", "codeSha256": "inline=", "codeSize": 28,
            "status": "ACTIVE", "minInstances": 0, "maxInstances": 3, "scaleToZero": true,
            "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z"
        }))
        .unwrap()
    }

    fn packaged() -> Function {
        Function {
            code: String::new(),
            package_type: Some("zip".into()),
            handler: Some("app.main".into()),
            code_sha256: Some("zip=".into()),
            ..function()
        }
    }

    fn inline<'a>(code: &'a str, runtime: Runtime) -> Wanted<'a> {
        Wanted { code: Code::Inline(code), handler: None, runtime, memory: None, timeout: None }
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

        assert!(changes(&function, &inline(&function.code, Runtime::Python)).is_empty());
        assert!(
            changes(
                &function,
                &Wanted { memory: Some(128), timeout: Some(5), ..inline(&function.code, Runtime::Python) }
            )
            .is_empty()
        );
        assert_eq!(
            Value::Object(changes(
                &function,
                &Wanted { memory: Some(256), ..inline("def handler(e, c): return 2\n", Runtime::Python) }
            )),
            json!({ "code": "def handler(e, c): return 2\n", "memory": 256 })
        );
        assert_eq!(
            Value::Object(changes(&function, &Wanted { timeout: Some(10), ..inline(&function.code, Runtime::Nodejs) })),
            json!({ "runtime": "nodejs", "timeout": 10 })
        );
        assert_eq!(
            Value::Object(changes(
                &function,
                &Wanted { handler: Some("function.main"), ..inline(&function.code, Runtime::Python) }
            )),
            json!({ "handler": "function.main" })
        );
    }

    #[test]
    fn a_package_is_sent_by_its_hash_when_it_or_its_handler_changed() {
        let package = |code_sha256, handler| Wanted {
            code: Code::Package(code_sha256),
            handler: Some(handler),
            runtime: Runtime::Python,
            memory: None,
            timeout: None,
        };

        assert!(changes(&packaged(), &package("zip=", "app.main")).is_empty());
        assert_eq!(Value::Object(changes(&packaged(), &package("new=", "app.main"))), json!({ "codeSha256": "new=" }));
        assert_eq!(
            Value::Object(changes(&packaged(), &package("zip=", "app.handler"))),
            json!({ "handler": "app.handler" })
        );
        // Inline code becomes a package, whatever the hashes say.
        assert_eq!(
            Value::Object(changes(&function(), &package("inline=", "function.handler"))),
            json!({ "codeSha256": "inline=" })
        );
    }

    #[test]
    fn a_file_over_a_package_becomes_inline_code_with_inline_codes_handler_unless_named() {
        assert_eq!(
            Value::Object(changes(&packaged(), &inline("", Runtime::Python))),
            json!({ "code": "", "handler": "function.handler" })
        );
        assert_eq!(
            Value::Object(changes(
                &packaged(),
                &Wanted { handler: Some("function.main"), ..inline("x", Runtime::Python) }
            )),
            json!({ "code": "x", "handler": "function.main" })
        );
    }

    #[test]
    fn says_a_packages_hash_changed_as_its_code() {
        let changes = changes(
            &packaged(),
            &Wanted {
                code: Code::Package("new="),
                handler: Some("app.handler"),
                runtime: Runtime::Nodejs,
                memory: Some(256),
                timeout: None,
            },
        );

        assert_eq!(changed_fields(&changes), ["code", "handler", "runtime", "memory"]);
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
