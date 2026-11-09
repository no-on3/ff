//! `ff local start template.yaml`: a SAM template's app on this machine (ADR 0017), the template read as `ff deploy`
//! reads it, with its refusals. Its functions run in their runtime containers, each started at its first call through
//! the local front door, on one port, kept while calls come and stopped after `--idle` without one; `--watch` starts
//! one again when its code changes. Their names are their logical IDs unless the template names them, as `sam local`
//! names them; their variables the template's, its `Ref`s and `GetAtt`s resolved to what they are here, with the
//! variables FF gives a pod pointed at the front door, and the secrets file's. The functions sign with the local key,
//! which the front door checks a signed request against: made at the first start, printed at each, and kept in
//! `.ff/local/credentials`. `ff local reset` empties what it keeps.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;

use super::Context;
use super::env::{is_variable_name, reserved};
use super::functions::confirmed;
use super::template::{Location, Problems, Read, is_stack_name, is_template};
use crate::api::types::{DeletionPolicy, StackResource};
use crate::cli::LocalArgs;
use crate::config::{is_bucket_name, is_function_name, is_queue_name};
use crate::error::{Error, Kind};
use crate::local::events::{LAMBDA_RETRY_POLICY, RetryPolicy};
use crate::local::front_door::{FrontDoor, FunctionUrl, Settings, URL_DOMAIN};
use crate::local::instances::{Docker, Instances};
use crate::local::key::Key;
use crate::local::{self, Code, LocalFunction, http, images, url};
use crate::output::Output;
use crate::sam::Template;
use crate::sam::plan::{self, BUCKET, Place, QUEUE};
use crate::sam::resolve::FUNCTION;

/// What a refused start says it did.
const NOTHING: &str = "ff local start ran nothing";
/// The front door's port, unless `--port` says.
pub const DEFAULT_PORT: u16 = 3700;
/// FF's region as an installation has it unless set, and this machine's account: what ARNs name here.
const REGION: &str = "tn-tunis-1";
const ACCOUNT: &str = "000000000000";
/// This machine as its containers reach it: Docker Desktop's name for it, which `--add-host` gives Docker on Linux.
const HOST: &str = "host.docker.internal";
/// How long a function is kept without a call, unless `--idle` says.
const DEFAULT_IDLE: Duration = Duration::from_secs(600);
/// What ff local keeps, in the project's folder; and the secrets file there, unless `--secrets` names one.
const KEPT: &str = ".ff/local";
const SECRETS: &str = ".env.local";
/// The local key's file, in what ff local keeps.
const CREDENTIALS: &str = "credentials";

/// What `ff local start` was given for a template.
pub struct Options<'a> {
    pub port: Option<u16>,
    pub watch: bool,
    pub secrets: Option<&'a Path>,
    pub idle: Option<&'a str>,
    pub stack_name: Option<&'a str>,
    pub parameter_overrides: &'a [String],
}

/// The names the template's functions, queues and buckets have here, as a deploy keeps the last one's: each one's
/// logical ID, as `sam local` names functions, a bucket's in lower case. Those the template names keep their names,
/// and a logical ID that can't be such a name is named CloudFormation's way.
fn local_names(template: &Template) -> Vec<StackResource> {
    let resources = template.value.get("Resources").and_then(Value::as_object);
    let named = |(id, resource): (&String, &Value)| {
        let kind = resource.get("Type").and_then(Value::as_str)?;
        let name = match kind {
            FUNCTION if is_function_name(id) => id.clone(),
            QUEUE if is_queue_name(id) => id.clone(),
            BUCKET if is_bucket_name(&id.to_ascii_lowercase()) => id.to_ascii_lowercase(),
            _ => return None,
        };
        Some(StackResource {
            logical_id: id.clone(),
            kind: kind.to_owned(),
            physical_id: Some(name),
            deletion_policy: DeletionPolicy::default(),
        })
    };
    resources.into_iter().flatten().filter_map(named).collect()
}

/// The stack's name when neither `--stack-name` nor samconfig.toml gives one: the project's folder's, else `local`.
fn folder_stack(at: &Location) -> String {
    let folder = std::fs::canonicalize(&at.project).ok();
    let name = folder.as_ref().and_then(|folder| folder.file_name()).and_then(|name| name.to_str());
    name.filter(|name| is_stack_name(name)).unwrap_or("local").to_owned()
}

/// The variables FF gives a function's pod (`BE/src/storage/function-keys.service.ts`), each pointed at the front door:
/// the region, and the endpoints of S3, SQS, SES v2 and Lambda; and, apart, its key, which `docker run` is given by name
/// alone, out of its command line.
fn pod_variables(endpoint: &str, key: &Key) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let variables = ["AWS_REGION", "AWS_DEFAULT_REGION"].map(|name| (name.to_owned(), REGION.to_owned())).into_iter();
    let endpoints =
        ["S3", "SQS", "SESV2", "LAMBDA"].map(|service| (format!("AWS_ENDPOINT_URL_{service}"), endpoint.to_owned()));
    let key = [("AWS_ACCESS_KEY_ID", &key.id), ("AWS_SECRET_ACCESS_KEY", &key.secret)];
    (
        variables.chain(endpoints).collect(),
        key.into_iter().map(|(name, value)| (name.to_owned(), value.clone())).collect(),
    )
}

/// The secrets file's variables, `KEY=value` lines as `.env` files have them: blank lines and `#` comments passed over,
/// `export ` before a name taken, and one pair of quotes around a value taken off. Every problem at its line, never a
/// value in it.
fn secrets(text: &str) -> Result<BTreeMap<String, String>, Vec<(usize, String)>> {
    let (mut secrets, mut problems) = (BTreeMap::new(), Vec::new());
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.strip_prefix("export ").unwrap_or(line).split_once('=') else {
            problems.push((index + 1, "a line is KEY=value, or a # comment".to_owned()));
            continue;
        };
        let name = name.trim();
        let problem = match reserved(name) {
            _ if !is_variable_name(name) => Some(format!(
                "\"{name}\" can't be a variable's name: a letter, then letters, digits or underscores, two characters at least"
            )),
            Some(why) => Some(why),
            None => None,
        };
        if let Some(problem) = problem {
            problems.push((index + 1, problem));
            continue;
        }
        let value = value.trim();
        let quoted = value.len() >= 2
            && (value.starts_with('"') && value.ends_with('"') || value.starts_with('\'') && value.ends_with('\''));
        secrets.insert(name.to_owned(), if quoted { &value[1..value.len() - 1] } else { value }.to_owned());
    }
    if problems.is_empty() { Ok(secrets) } else { Err(problems) }
}

/// The secrets file `--secrets` names, which must be there; else `.env.local` in the project's folder, if it is.
fn read_secrets(given: Option<&Path>, project: &Path) -> Result<(BTreeMap<String, String>, Option<String>), Error> {
    let path = match given {
        Some(path) => path.to_path_buf(),
        None if project.join(SECRETS).is_file() => project.join(SECRETS),
        None => return Ok((BTreeMap::new(), None)),
    };
    let file = path.display().to_string();
    let text = std::fs::read_to_string(&path)
        .map_err(|error| Error::usage(format!("Couldn't read the secrets in {file}: {error}")))?;
    match secrets(&text) {
        Ok(secrets) => Ok((secrets, Some(file))),
        Err(problems) => {
            let count =
                if problems.len() == 1 { "a problem".to_owned() } else { format!("{} problems", problems.len()) };
            let lines: Vec<String> =
                problems.iter().map(|(line, problem)| format!("{file}:{line}: {problem}")).collect();
            Err(Error::usage(format!("{NOTHING}: {file} has {count}\n{}", lines.join("\n"))))
        }
    }
}

/// Each function of the plan as it runs here: the template's settings and variables, then the pod's, then the
/// secrets', a secret taking the place of the template's variable of its name, which `notes` says. What can't run here
/// is a problem at its line: a .zip, which ff local doesn't unpack, and a variable FF sets itself.
fn functions(
    planned: &plan::Plan,
    pod: &(BTreeMap<String, String>, BTreeMap<String, String>),
    secrets: &BTreeMap<String, String>,
    problems: &mut Problems,
    notes: &mut Vec<String>,
) -> Vec<LocalFunction> {
    let mut functions = Vec::new();
    for function in &planned.functions {
        let id = &function.id;
        let at = |property: &str| format!("/Resources/{id}/Properties/{property}");
        if function.code.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("zip")) {
            let message =
                format!("{id}: CodeUri names a .zip, which ff local doesn't unpack: name the folder it is made of");
            problems.at(&at("CodeUri"), &message);
            continue;
        }
        let code = match std::fs::canonicalize(&function.code) {
            Ok(folder) if folder.is_dir() => Code::Folder(folder),
            _ => {
                let message = format!("{id}: CodeUri {} is no folder here", function.code.display());
                problems.at(&at("CodeUri"), &message);
                continue;
            }
        };
        for (name, why) in function.environment.keys().filter_map(|name| reserved(name).map(|why| (name, why))) {
            problems.at(&at(&format!("Environment/Variables/{name}")), &format!("{id}: {why}"));
        }
        let mut environment = function.environment.clone();
        environment.extend(pod.0.clone());
        for (name, value) in secrets {
            if environment.insert(name.clone(), value.clone()).is_some() {
                notes.push(format!("{id}: the secret {name} takes the place of the template's variable"));
            }
        }
        let mut secret_values = pod.1.clone();
        secret_values.extend(secrets.iter().map(|(name, value)| (name.clone(), value.clone())));
        for name in secret_values.keys() {
            environment.remove(name);
        }
        functions.push(LocalFunction {
            name: function.name.clone(),
            runtime: function.runtime,
            memory: function.memory,
            timeout: function.timeout,
            code,
            handler: function.handler.clone(),
            environment,
            secrets: secret_values,
            reaches_this_machine: true,
        });
    }
    functions
}

/// What the front door answers of each function besides how it runs, by its name: its alias, its description and
/// the template's variables, a secret's left out; its asynchronous calls' retries and destinations, each within what
/// FF takes, else a problem at its line; and its URL, its CORS as FF takes it, its host no other's.
fn settings(
    planned: &plan::Plan,
    secrets: &BTreeMap<String, String>,
    problems: &mut Problems,
) -> BTreeMap<String, Settings> {
    let mut all = BTreeMap::new();
    // Each URL's host, by the function whose logical ID has it.
    let mut hosts: BTreeMap<String, &String> = BTreeMap::new();
    for function in &planned.functions {
        let id = &function.id;
        let config = function.event_invoke_config.as_ref();
        let mut bounded = |field: &str, property: &str, (least, most): (u64, u64), default: u64| {
            let Some(value) = config.and_then(|config| config.get(field)) else { return default };
            match value.as_u64().filter(|number| (least..=most).contains(number)) {
                Some(number) => number,
                None => {
                    let message = format!(
                        "{id}: EventInvokeConfig's {property} is a whole number from {least} to {most}, as FF takes it, not {value}"
                    );
                    problems.at(&format!("/Resources/{id}/Properties/EventInvokeConfig/{property}"), &message);
                    default
                }
            }
        };
        let retries = RetryPolicy {
            maximum_retry_attempts: bounded(
                "maximumRetryAttempts",
                "MaximumRetryAttempts",
                (0, 2),
                u64::from(LAMBDA_RETRY_POLICY.maximum_retry_attempts),
            )
            .try_into()
            .unwrap_or(LAMBDA_RETRY_POLICY.maximum_retry_attempts),
            maximum_event_age_seconds: bounded(
                "maximumEventAgeInSeconds",
                "MaximumEventAgeInSeconds",
                (60, LAMBDA_RETRY_POLICY.maximum_event_age_seconds),
                LAMBDA_RETRY_POLICY.maximum_event_age_seconds,
            ),
        };
        let mut destination = |on: &str, field: &str| {
            let pointer = format!("/destinationConfig/{on}/destination");
            let arn = config.and_then(|config| config.pointer(&pointer)).and_then(Value::as_str)?;
            let own = format!("arn:aws:lambda:{REGION}:{ACCOUNT}:function:{}", function.name);
            if arn == own || arn.starts_with(&format!("{own}:")) {
                let message =
                    format!("{id}: a function can't be its own destination, as each record would call it again");
                problems
                    .at(&format!("/Resources/{id}/Properties/EventInvokeConfig/DestinationConfig/{field}"), &message);
            }
            Some(arn.to_owned())
        };
        let (on_success, on_failure) = (destination("onSuccess", "OnSuccess"), destination("onFailure", "OnFailure"));
        let url = function.url.as_ref().map(|function_url| {
            let cors = function_url.cors.as_ref().and_then(|cors| {
                let refused = url::cors_refusals(cors);
                for (property, why) in &refused {
                    let at = format!("/Resources/{id}/Properties/FunctionUrlConfig/Cors/{property}");
                    problems.at(&at, &format!("{id}: FunctionUrlConfig's Cors {why}"));
                }
                if refused.is_empty() { serde_json::from_value(cors.clone()).ok() } else { None }
            });
            if let Some(other) = hosts.insert(function.name.to_ascii_lowercase(), id) {
                let message = format!(
                    "{id}: its URL's host, {}, would be {other}'s too, as a host's case doesn't count: name one of them otherwise",
                    url_host(&function.name)
                );
                problems.at(&format!("/Resources/{id}/Properties/FunctionUrlConfig"), &message);
            }
            FunctionUrl { iam: function_url.auth_type == "AWS_IAM", cors }
        });
        let variables = function.environment.iter().filter(|(name, _)| !secrets.contains_key(*name));
        all.insert(
            function.name.clone(),
            Settings {
                alias: function.alias.clone(),
                description: function.description.clone(),
                variables: variables.map(|(name, value)| (name.clone(), value.clone())).collect(),
                dead_letter: function.dead_letter.clone(),
                retries,
                on_success,
                on_failure,
                url,
            },
        );
    }
    all
}

/// The host of a function's URL here, its name in lower case under the URLs' domain.
fn url_host(name: &str) -> String {
    format!("{}.{URL_DOMAIN}", name.to_ascii_lowercase())
}

/// How long a second of an asynchronous call's waits and age lasts: a second, but in a test build, as the `ff` suite's,
/// `FF_TEST_ASYNC_SECOND_MS`'s milliseconds, for its retries to come in its time.
fn async_second() -> Duration {
    let tests = if cfg!(debug_assertions) { std::env::var("FF_TEST_ASYNC_SECOND_MS").ok() } else { None };
    tests.and_then(|milliseconds| milliseconds.parse().ok()).map_or(Duration::from_secs(1), Duration::from_millis)
}

/// The address this machine has on Docker's default network, where `host.docker.internal` leads containers on Linux;
/// none where Docker runs in a machine of its own, as Docker Desktop does, whose name leads to this machine's 127.0.0.1.
fn docker_gateway() -> Option<IpAddr> {
    let inspect = ["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"];
    let output = local::docker(&inspect.map(str::to_owned)).ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace().filter_map(|address| address.parse::<IpAddr>().ok()).find(IpAddr::is_ipv4)
}

/// Starts each running function again when its code changes, once a second passes without another change; what ff
/// local keeps, in `.ff/`, and git's folder are let be.
fn watch(instances: Arc<Instances<Docker>>, functions: &[LocalFunction], kept: PathBuf) -> Result<(), Error> {
    let failed =
        |error: notify::Error| Error::new(Kind::Failed, format!("Couldn't watch the code for changes: {error}"));
    let folders: Vec<(String, PathBuf)> = functions
        .iter()
        .filter_map(|function| match &function.code {
            Code::Folder(folder) => Some((function.name.clone(), folder.clone())),
            Code::File { .. } => None,
        })
        .collect();
    let (sender, changes) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(failed)?;
    for folder in folders.iter().map(|(_, folder)| folder).collect::<BTreeSet<_>>() {
        watcher.watch(folder, RecursiveMode::Recursive).map_err(failed)?;
    }
    let changed = move |event: &notify::Event, names: &mut BTreeSet<String>| {
        if event.kind.is_access() {
            return;
        }
        for path in &event.paths {
            if path.starts_with(&kept) || path.components().any(|part| part.as_os_str() == ".git") {
                continue;
            }
            names.extend(folders.iter().filter(|(_, folder)| path.starts_with(folder)).map(|(name, _)| name.clone()));
        }
    };
    std::thread::spawn(move || {
        let _watcher = watcher;
        loop {
            let mut names = BTreeSet::new();
            match changes.recv() {
                Ok(Ok(event)) => changed(&event, &mut names),
                Ok(Err(_)) => continue,
                Err(_) => return,
            }
            if names.is_empty() {
                continue;
            }
            loop {
                match changes.recv_timeout(Duration::from_secs(1)) {
                    Ok(Ok(event)) => changed(&event, &mut names),
                    Ok(Err(_)) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            for name in names {
                instances.restart(&name);
            }
        }
    });
    Ok(())
}

/// A template's app as it runs here, read and planned; nothing of it started.
struct Prepared {
    read: Read,
    planned: plan::Plan,
    functions: Vec<LocalFunction>,
    /// What the front door answers of each function besides how it runs.
    settings: BTreeMap<String, Settings>,
    /// The secrets file read, if one was.
    secrets_file: Option<String>,
    /// What a secret takes the place of.
    notes: Vec<String>,
}

/// The template read as `ff deploy` reads it and planned as its app runs here, its front door on `port`, its functions
/// signing with `key`: its every problem one refusal, at its line.
fn prepared(path: &Path, options: &Options, port: u16, key: &Key, out: &Output) -> Result<Prepared, Error> {
    let read = Read::of(path, options.stack_name, options.parameter_overrides, |at| Ok(folder_stack(at)))?;
    let (values, mut problems) = read.checked(&read.given, "ff local start", NOTHING, out);
    let endpoint = format!("http://127.0.0.1:{port}");
    let from_containers = format!("http://{HOST}:{port}");
    let s3 = format!("http://s3.localhost:{port}");
    let place = Place {
        stack: &read.stack_name,
        region: REGION,
        account: ACCOUNT,
        sqs_endpoint: &endpoint,
        sqs_function_endpoint: &from_containers,
        s3_endpoint: &s3,
    };
    let names = local_names(&read.template);
    let planned = plan::plan(&read.template, &values.values, &place, &names, &read.at.folder, &mut || "LOCAL".into());
    let planned = match planned {
        Ok(planned) => Some(planned),
        Err(found) => {
            for (pointer, message) in found {
                problems.at(&pointer, &message);
            }
            None
        }
    };
    let (secrets, secrets_file) = read_secrets(options.secrets, &read.at.project)?;
    let pod = pod_variables(&from_containers, key);
    let mut notes = Vec::new();
    let (functions, settings) = match &planned {
        Some(planned) => {
            (functions(planned, &pod, &secrets, &mut problems, &mut notes), settings(planned, &secrets, &mut problems))
        }
        None => (Vec::new(), BTreeMap::new()),
    };
    problems.refusal()?;
    let planned = planned.expect("a plan without problems");
    Ok(Prepared { read, planned, functions, settings, secrets_file, notes })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedFunction {
    logical_id: String,
    name: String,
    runtime: &'static str,
    memory: u32,
    timeout: u32,
    /// Its URL, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    /// Its URL's AuthType.
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedKey {
    access_key_id: String,
    secret_access_key: String,
    file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    stack: String,
    endpoint: String,
    region: &'static str,
    key: StartedKey,
    functions: Vec<StartedFunction>,
    logs: String,
}

/// `ff local start template.yaml`, until Ctrl-C.
pub fn start(args: &LocalArgs, options: &Options, context: &Context) -> Result<(), Error> {
    let flags: Vec<&str> = [
        ("--name", args.name.is_some()),
        ("--runtime", args.runtime.is_some()),
        ("--memory", args.memory.is_some()),
        ("--timeout", args.timeout.is_some()),
        ("--env", !args.env.is_empty()),
    ]
    .into_iter()
    .filter_map(|(flag, given)| given.then_some(flag))
    .collect();
    if !flags.is_empty() {
        return Err(Error::usage(format!(
            "{} {} for a function's file or folder: a template's functions take their settings from it, their secrets from --secrets",
            flags.join(", "),
            if flags.len() == 1 { "is" } else { "are" }
        )));
    }
    let idle = match options.idle {
        Some(text) => humantime::parse_duration(text)
            .map_err(|error| Error::usage(format!("--idle {text}: {error}: a duration, such as 10m or 30s")))?,
        None => DEFAULT_IDLE,
    };
    let port = options.port.unwrap_or(DEFAULT_PORT);
    let endpoint = format!("http://127.0.0.1:{port}");
    // The project's key, kept from a start to the next; one made is written once the start goes ahead.
    let credentials = Location::of(&args.path).project.join(KEPT).join(CREDENTIALS);
    let kept_key = Key::read(&credentials)?;
    let key = match &kept_key {
        Some(key) => key.clone(),
        None => Key::made()?,
    };
    let Prepared { read, planned, functions, settings, secrets_file, notes } =
        prepared(&args.path, options, port, &key, context.out)?;
    for note in &notes {
        context.out.warn(note);
    }

    local::check_docker()?;
    let mut runtime_images = BTreeMap::new();
    for runtime in functions.iter().map(|function| function.runtime).collect::<BTreeSet<_>>() {
        runtime_images.insert(runtime, images::for_runtime(runtime, context.out)?);
    }
    local::remove_on_interrupt();
    let project = std::fs::canonicalize(&read.at.project).unwrap_or_else(|_| read.at.project.clone());
    let kept = project.join(KEPT);
    let logs = kept.join("logs");
    std::fs::create_dir_all(&logs)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't make {}: {error}", logs.display())))?;
    let credentials = kept.join(CREDENTIALS);
    if kept_key.is_none() {
        key.write(&credentials)?;
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
        Error::new(
            Kind::Failed,
            format!(
                "Couldn't listen on 127.0.0.1:{port}: {error}: another program has it; name another port with --port"
            ),
        )
    })?;

    let quiet = context.out.quiet;
    let say: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
        if !quiet {
            eprintln!("{line}")
        }
    });
    let to_say = Arc::clone(&say);
    let docker = Docker { images: runtime_images, logs: logs.clone(), echo: !quiet };
    let instances = Arc::new(Instances::new(docker, functions.clone(), idle, move |line| to_say(line)));
    let front_door: Arc<dyn http::Answers> = Arc::new(FrontDoor {
        instances: Arc::clone(&instances),
        region: REGION.to_owned(),
        account: ACCOUNT.to_owned(),
        key: key.clone(),
        settings: Arc::new(settings),
        started: SystemTime::now(),
        second: async_second(),
        say,
    });
    http::serve(listener, Arc::clone(&front_door));
    // Where containers reach this machine on Linux, which Docker Desktop leads to 127.0.0.1 itself.
    if let Some(gateway) = docker_gateway()
        && let Ok(listener) = TcpListener::bind((gateway, port))
    {
        http::serve(listener, front_door);
    }
    let idle_instances = Arc::clone(&instances);
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            idle_instances.stop_idle(Instant::now());
        }
    });
    if options.watch {
        watch(Arc::clone(&instances), &functions, project.join(".ff"))?;
    }

    let started = Started {
        stack: read.stack_name.clone(),
        endpoint: endpoint.clone(),
        region: REGION,
        key: StartedKey {
            access_key_id: key.id.clone(),
            secret_access_key: key.secret.clone(),
            file: credentials.display().to_string(),
        },
        functions: planned
            .functions
            .iter()
            .map(|function| StartedFunction {
                logical_id: function.id.clone(),
                name: function.name.clone(),
                runtime: function.runtime.as_str(),
                memory: function.memory,
                timeout: function.timeout,
                url: function.url.as_ref().map(|_| format!("http://{}:{port}/", url_host(&function.name))),
                auth_type: function.url.as_ref().map(|function_url| function_url.auth_type.clone()),
            })
            .collect(),
        logs: logs.display().to_string(),
    };
    context.out.result(&started, || {
        let mut lines = vec![format!("{} ({}) runs on this machine, its front door at {endpoint}:", read.stack_name, read.file)];
        let width = started.functions.iter().map(|function| function.name.len()).max().unwrap_or(0);
        lines.extend(started.functions.iter().map(|function| {
            let line =
                format!("  {:width$}  {:6}  {} MB, {} s", function.name, function.runtime, function.memory, function.timeout);
            match (&function.url, function.auth_type.as_deref()) {
                (Some(url), Some("AWS_IAM")) => format!("{line}  {url}, signed with its key"),
                (Some(url), _) => format!("{line}  {url}"),
                _ => line,
            }
        }));
        if let Some(first) = started.functions.first() {
            lines.push(format!(
                "Each starts at its first call, by Lambda's Invoke: curl -d '{{}}' {endpoint}/2015-03-31/functions/{}/invocations",
                first.name
            ));
        }
        lines.push(format!(
            "Its key, which a signed request is checked against, is in {}: AWS_ACCESS_KEY_ID={} AWS_SECRET_ACCESS_KEY={}, in the region {REGION}",
            started.key.file, started.key.access_key_id, started.key.secret_access_key
        ));
        if let Some(file) = &secrets_file {
            lines.push(format!("Their secrets are {file}'s."));
        }
        let again = if options.watch { "; a change of a function's code starts it again" } else { "" };
        lines.push(format!("Ctrl-C stops them; their logs are in {}{again}", started.logs));
        lines.join("\n")
    })?;
    loop {
        std::thread::park();
    }
}

/// `ff local reset`: what ff local keeps for the template's project removed, after asking.
pub fn reset(path: Option<&Path>, yes: bool, context: &Context) -> Result<(), Error> {
    let path = path.unwrap_or(Path::new("."));
    let project = if is_template(path) {
        Location::of(path).project
    } else if path.is_dir() {
        path.to_path_buf()
    } else {
        return Err(Error::usage(format!("{} is neither a SAM template nor a folder", path.display())));
    };
    let kept = project.join(KEPT);
    let folder = kept.display().to_string();
    if !kept.exists() {
        return context.out.result(&serde_json::json!({ "reset": false, "folder": folder }), || {
            format!("Nothing to reset: there is no {folder}")
        });
    }
    let question = format!("Remove {folder}, what ff local keeps: the functions' logs and the local key?");
    if !confirmed("ff local reset", &question, yes)? {
        return context
            .out
            .result(&serde_json::json!({ "reset": false, "folder": folder }), || "Nothing removed".to_owned());
    }
    std::fs::remove_dir_all(&kept)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't remove {folder}: {error}")))?;
    context.out.result(&serde_json::json!({ "reset": true, "folder": folder }), || format!("removed {folder}"))
}

#[cfg(test)]
mod tests {
    use crate::cli::ConnectionArgs;

    use super::*;
    use crate::local::url::Cors;

    const TEMPLATE: &str = r#"AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: nodejs24.x
    Handler: app.handler
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: orders/
      AutoPublishAlias: live
      Environment:
        Variables:
          QUEUE_URL: !Ref Jobs
          BUCKET: !Ref Uploads
          PAYMENTS: !GetAtt Payments.Arn
          TOKEN: from-the-template
  Payments:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: payments-fn
      CodeUri: payments/
      EventInvokeConfig:
        MaximumRetryAttempts: 1
        MaximumEventAgeInSeconds: 600
        DestinationConfig:
          OnSuccess:
            Type: Lambda
            Destination: !GetAtt Orders.Arn
          OnFailure:
            Type: SQS
            Destination: !GetAtt Jobs.Arn
      DeadLetterQueue:
        Type: SQS
        TargetArn: !GetAtt Jobs.Arn
  Jobs:
    Type: AWS::SQS::Queue
  Uploads:
    Type: AWS::S3::Bucket
"#;

    /// A project, `shop`, with the template and its functions' folders.
    fn project(template: &str) -> (tempfile::TempDir, PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        let project = folder.path().join("shop");
        for code in ["orders", "payments"] {
            std::fs::create_dir_all(project.join(code)).unwrap();
            std::fs::write(project.join(code).join("app.js"), "exports.handler = async (event) => event;").unwrap();
        }
        std::fs::write(project.join("template.yaml"), template).unwrap();
        (folder, project)
    }

    fn options<'a>() -> Options<'a> {
        Options { port: None, watch: false, secrets: None, idle: None, stack_name: None, parameter_overrides: &[] }
    }

    fn key() -> Key {
        Key { id: "AKFFLOCALKEY0000TEST".into(), secret: "a-secret".into() }
    }

    fn function<'a>(prepared: &'a Prepared, name: &str) -> &'a LocalFunction {
        prepared.functions.iter().find(|function| function.name == name).unwrap()
    }

    #[test]
    fn a_templates_functions_are_named_and_given_what_they_are_here() {
        let (_folder, project) = project(TEMPLATE);
        std::fs::write(project.join(".env.local"), "# the app's secrets\nTOKEN=from-the-file\n").unwrap();

        let prepared = prepared(&project.join("template.yaml"), &options(), 3700, &key(), &Output::quiet()).unwrap();

        let names: Vec<&str> = prepared.functions.iter().map(|function| function.name.as_str()).collect();
        assert_eq!(names, ["Orders", "payments-fn"], "a logical ID, unless the template names the function");
        assert_eq!(prepared.read.stack_name, "shop", "the project's folder names the stack");
        let orders = function(&prepared, "Orders");
        let variable = |name: &str| orders.environment.get(name).map(String::as_str);
        assert_eq!(variable("QUEUE_URL"), Some("http://host.docker.internal:3700/000000000000/Jobs"));
        assert_eq!(variable("BUCKET"), Some("uploads"));
        assert_eq!(variable("PAYMENTS"), Some("arn:aws:lambda:tn-tunis-1:000000000000:function:payments-fn"));
        assert_eq!(variable("AWS_REGION"), Some("tn-tunis-1"));
        for service in ["S3", "SQS", "SESV2", "LAMBDA"] {
            let name = format!("AWS_ENDPOINT_URL_{service}");
            assert_eq!(variable(&name), Some("http://host.docker.internal:3700"), "{name}");
        }
        assert_eq!(variable("TOKEN"), None, "a secret is given by its name alone");
        assert_eq!(orders.secrets.get("TOKEN").map(String::as_str), Some("from-the-file"));
        assert_eq!(orders.secrets["AWS_ACCESS_KEY_ID"], key().id, "the functions sign with the local key");
        assert_eq!(orders.secrets["AWS_SECRET_ACCESS_KEY"], key().secret);
        assert_eq!(prepared.notes, ["Orders: the secret TOKEN takes the place of the template's variable"]);
        assert_eq!(prepared.secrets_file.as_deref().map(|file| file.ends_with(".env.local")), Some(true));
        assert!(orders.reaches_this_machine);

        let (orders, payments) = (&prepared.settings["Orders"], &prepared.settings["payments-fn"]);
        assert_eq!(orders.alias.as_deref(), Some("live"));
        assert_eq!(orders.variables["QUEUE_URL"], "http://host.docker.internal:3700/000000000000/Jobs");
        assert!(!orders.variables.contains_key("TOKEN"), "a secret is never shown");
        assert!(!orders.variables.contains_key("AWS_REGION"), "nor what FF gives every function");
        assert_eq!(
            (orders.retries, orders.on_success.as_ref(), orders.dead_letter.as_ref()),
            (LAMBDA_RETRY_POLICY, None, None)
        );
        let jobs = "arn:aws:sqs:tn-tunis-1:000000000000:Jobs";
        assert_eq!(payments.retries, RetryPolicy { maximum_retry_attempts: 1, maximum_event_age_seconds: 600 });
        assert_eq!(payments.on_success.as_deref(), Some("arn:aws:lambda:tn-tunis-1:000000000000:function:Orders"));
        assert_eq!((payments.on_failure.as_deref(), payments.dead_letter.as_deref()), (Some(jobs), Some(jobs)));
    }

    #[test]
    fn what_cant_run_here_is_refused_at_its_line() {
        let template = TEMPLATE
            .replace("CodeUri: payments/", "CodeUri: payments.zip")
            .replace("TOKEN: from-the-template", "AWS_REGION: eu-west-1")
            .replace("MaximumRetryAttempts: 1", "MaximumRetryAttempts: 5")
            .replace("Destination: !GetAtt Orders.Arn", "Destination: !GetAtt Payments.Arn");
        let (_folder, project) = project(&template);
        std::fs::write(project.join("payments.zip"), "PK").unwrap();
        let path = project.join("template.yaml");

        let error = prepared(&path, &options(), 3700, &key(), &Output::quiet()).err().unwrap();

        let file = path.display();
        assert_eq!(
            error.message,
            format!(
                "ff local start ran nothing: the template has 4 problems\n\
                 {file}:18: Orders: AWS_REGION is reserved: AWS Lambda or FF's runtime sets it\n\
                 {file}:23: Payments: CodeUri names a .zip, which ff local doesn't unpack: name the folder it is made of\n\
                 {file}:25: Payments: EventInvokeConfig's MaximumRetryAttempts is a whole number from 0 to 2, as FF takes it, not 5\n\
                 {file}:28: Payments: a function can't be its own destination, as each record would call it again"
            )
        );
    }

    /// The template, `Orders` with a URL anyone may call, its CORS as `cors` says, and `Payments` with one that takes
    /// the account's credentials, named `payments_name`.
    fn with_urls(cors: &str, payments_name: &str) -> String {
        TEMPLATE
            .replace(
                "      CodeUri: orders/\n",
                &format!(
                    "      CodeUri: orders/\n      FunctionUrlConfig:\n        AuthType: NONE\n        Cors:\n{cors}"
                ),
            )
            .replace("FunctionName: payments-fn", &format!("FunctionName: {payments_name}"))
            .replace(
                "      CodeUri: payments/\n",
                "      CodeUri: payments/\n      FunctionUrlConfig:\n        AuthType: AWS_IAM\n",
            )
    }

    #[test]
    fn a_functions_url_is_its_host_here_with_the_templates_cors() {
        let cors = "          AllowOrigins: [https://app.example.tn]\n          AllowMethods: [GET, POST]\n          MaxAge: 300\n";
        let (_folder, project) = project(&with_urls(cors, "payments-fn"));

        let prepared = prepared(&project.join("template.yaml"), &options(), 3700, &key(), &Output::quiet()).unwrap();

        let cors = Cors {
            allow_origins: Some(vec!["https://app.example.tn".into()]),
            allow_methods: Some(vec!["GET".into(), "POST".into()]),
            max_age: Some(300),
            ..Cors::default()
        };
        assert_eq!(prepared.settings["Orders"].url, Some(FunctionUrl { iam: false, cors: Some(cors) }));
        assert_eq!(prepared.settings["payments-fn"].url, Some(FunctionUrl { iam: true, cors: None }));
        assert_eq!(
            (url_host("Orders"), url_host("payments-fn")),
            ("orders.fn.localhost".into(), "payments-fn.fn.localhost".into())
        );
    }

    #[test]
    fn a_url_that_ff_would_refuse_or_whose_host_is_anothers_is_refused_at_its_line() {
        let cors = "          AllowOrigins: [https://app.example.tn/path]\n          AllowMethods: [GET, OPTIONS]\n          MaxAge: 90000\n";
        let (_folder, project) = project(&with_urls(cors, "ORDERS"));
        let path = project.join("template.yaml");

        let error = prepared(&path, &options(), 3700, &key(), &Output::quiet()).err().unwrap();

        let file = path.display();
        assert_eq!(
            error.message,
            format!(
                "ff local start ran nothing: the template has 4 problems\n\
                 {file}:15: Orders: FunctionUrlConfig's Cors AllowOrigins is a list of at most 100 origins, such as https://www.example.tn, or *, as FF takes it, not \"https://app.example.tn/path\"\n\
                 {file}:16: Orders: FunctionUrlConfig's Cors AllowMethods is a list of at most 6 of GET, PUT, HEAD, POST, PATCH, DELETE and *, as FF takes it, not \"OPTIONS\"\n\
                 {file}:17: Orders: FunctionUrlConfig's Cors MaxAge is a whole number of seconds from 0 to 86400, as FF takes it, not 90000\n\
                 {file}:30: Payments: its URL's host, orders.fn.localhost, would be Orders's too, as a host's case doesn't count: name one of them otherwise"
            )
        );
    }

    #[test]
    fn a_secrets_file_is_read_as_env_files_are_and_its_problems_said_at_their_lines() {
        let text = "# secrets\n\nexport TOKEN=\"a b\"\nPLAIN=x=y\nSINGLE='q'\nEMPTY=\n";
        let found = secrets(text).unwrap();
        let expected = [("EMPTY", ""), ("PLAIN", "x=y"), ("SINGLE", "q"), ("TOKEN", "a b")];
        assert_eq!(found, expected.map(|(name, value)| (name.to_owned(), value.to_owned())).into());

        let problems = secrets("TOKEN=ok\nno equals sign\n1X=y\nAWS_REGION=eu-west-1\n").unwrap_err();
        let lines: Vec<usize> = problems.iter().map(|(line, _)| *line).collect();
        assert_eq!(lines, [2, 3, 4]);
        assert_eq!(problems[0].1, "a line is KEY=value, or a # comment");
        assert!(problems[2].1.starts_with("AWS_REGION is reserved"), "{}", problems[2].1);

        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("secrets");
        std::fs::write(&file, "1X=secret-value\n").unwrap();
        let error = read_secrets(Some(&file), folder.path()).unwrap_err();
        assert!(error.message.starts_with(&format!("{NOTHING}: {} has a problem\n", file.display())));
        assert!(!error.message.contains("secret-value"), "a value is never said");
        assert!(read_secrets(Some(&folder.path().join("missing")), folder.path()).is_err());
        assert_eq!(read_secrets(None, folder.path()).unwrap(), (BTreeMap::new(), None));
    }

    #[test]
    fn reset_removes_what_ff_local_keeps_and_says_when_there_is_nothing() {
        let (_folder, project) = project(TEMPLATE);
        let logs = project.join(".ff/local/logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("Orders.log"), "a line\n").unwrap();
        let (connection, out) = (ConnectionArgs::default(), Output::quiet());
        let context = Context { connection: &connection, out: &out };

        reset(Some(&project.join("template.yaml")), true, &context).unwrap();
        assert!(!project.join(".ff/local").exists() && project.join("template.yaml").exists());
        reset(Some(&project), true, &context).unwrap();
        assert!(reset(Some(&project.join("missing.txt")), true, &context).is_err());
    }
}
