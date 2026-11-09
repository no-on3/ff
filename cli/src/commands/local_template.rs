//! `ff local start template.yaml`: a SAM template's app on this machine (ADR 0017), the template read as `ff deploy`
//! reads it, with its refusals. Its functions run in their runtime containers, each started at its first call through
//! the local front door, on one port, kept while calls come and stopped after `--idle` without one; `--watch` starts
//! one again when its code changes. Their names are their logical IDs unless the template names them, as `sam local`
//! names them; their variables the template's, its `Ref`s and `GetAtt`s resolved to what they are here, with the
//! variables FF gives a pod pointed at the front door, and the secrets file's. `ff local reset` empties what it keeps.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

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
use crate::local::front_door::FrontDoor;
use crate::local::instances::{Docker, Instances};
use crate::local::{self, Code, LocalFunction, http, images};
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

/// A key for the functions to sign with, as each function has its own on FF: an ID as FF's keys have them, and a secret.
fn local_key() -> Result<(String, String), Error> {
    const ID: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const SECRET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut random = [0u8; 56];
    getrandom::fill(&mut random)
        .map_err(|error| Error::new(Kind::Failed, format!("No randomness for the functions' key: {error}")))?;
    let pick = |alphabet: &[u8], bytes: &[u8]| -> String {
        bytes.iter().map(|byte| alphabet[usize::from(*byte) % alphabet.len()] as char).collect()
    };
    Ok((format!("AKFF{}", pick(ID, &random[..16])), pick(SECRET, &random[16..])))
}

/// The variables FF gives a function's pod (`BE/src/storage/function-keys.service.ts`), each pointed at the front door:
/// the region, and the endpoints of S3, SQS, SES v2 and Lambda; and, apart, its key, which `docker run` is given by name
/// alone, out of its command line.
fn pod_variables(endpoint: &str, key: &(String, String)) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let variables = ["AWS_REGION", "AWS_DEFAULT_REGION"].map(|name| (name.to_owned(), REGION.to_owned())).into_iter();
    let endpoints =
        ["S3", "SQS", "SESV2", "LAMBDA"].map(|service| (format!("AWS_ENDPOINT_URL_{service}"), endpoint.to_owned()));
    let key = [("AWS_ACCESS_KEY_ID", &key.0), ("AWS_SECRET_ACCESS_KEY", &key.1)];
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
    /// The secrets file read, if one was.
    secrets_file: Option<String>,
    /// What a secret takes the place of.
    notes: Vec<String>,
}

/// The template read as `ff deploy` reads it and planned as its app runs here, its front door on `port`: its every
/// problem one refusal, at its line.
fn prepared(path: &Path, options: &Options, port: u16, out: &Output) -> Result<Prepared, Error> {
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
    let pod = pod_variables(&from_containers, &local_key()?);
    let mut notes = Vec::new();
    let functions = match &planned {
        Some(planned) => functions(planned, &pod, &secrets, &mut problems, &mut notes),
        None => Vec::new(),
    };
    problems.refusal()?;
    let planned = planned.expect("a plan without problems");
    Ok(Prepared { read, planned, functions, secrets_file, notes })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedFunction {
    logical_id: String,
    name: String,
    runtime: &'static str,
    memory: u32,
    timeout: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    stack: String,
    endpoint: String,
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
    let Prepared { read, planned, functions, secrets_file, notes } = prepared(&args.path, options, port, context.out)?;
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
    let aliases = planned
        .functions
        .iter()
        .filter_map(|function| function.alias.clone().map(|alias| (function.name.clone(), alias)))
        .collect();
    let front_door: Arc<dyn http::Answers> = Arc::new(FrontDoor {
        instances: Arc::clone(&instances),
        region: REGION.to_owned(),
        account: ACCOUNT.to_owned(),
        aliases,
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
        functions: planned
            .functions
            .iter()
            .map(|function| StartedFunction {
                logical_id: function.id.clone(),
                name: function.name.clone(),
                runtime: function.runtime.as_str(),
                memory: function.memory,
                timeout: function.timeout,
            })
            .collect(),
        logs: logs.display().to_string(),
    };
    context.out.result(&started, || {
        let mut lines = vec![format!("{} ({}) runs on this machine, its front door at {endpoint}:", read.stack_name, read.file)];
        let width = started.functions.iter().map(|function| function.name.len()).max().unwrap_or(0);
        lines.extend(started.functions.iter().map(|function| {
            format!("  {:width$}  {:6}  {} MB, {} s", function.name, function.runtime, function.memory, function.timeout)
        }));
        if let Some(first) = started.functions.first() {
            lines.push(format!(
                "Each starts at its first call, by Lambda's Invoke: curl -d '{{}}' {endpoint}/2015-03-31/functions/{}/invocations",
                first.name
            ));
        }
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
    let question = format!("Remove {folder}, what ff local keeps: the functions' logs?");
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

    fn function<'a>(prepared: &'a Prepared, name: &str) -> &'a LocalFunction {
        prepared.functions.iter().find(|function| function.name == name).unwrap()
    }

    #[test]
    fn a_templates_functions_are_named_and_given_what_they_are_here() {
        let (_folder, project) = project(TEMPLATE);
        std::fs::write(project.join(".env.local"), "# the app's secrets\nTOKEN=from-the-file\n").unwrap();

        let prepared = prepared(&project.join("template.yaml"), &options(), 3700, &Output::quiet()).unwrap();

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
        let key = &orders.secrets["AWS_ACCESS_KEY_ID"];
        assert!(key.starts_with("AKFF") && key.len() == 20, "{key}");
        assert_eq!(orders.secrets["AWS_SECRET_ACCESS_KEY"].len(), 40);
        assert_eq!(prepared.notes, ["Orders: the secret TOKEN takes the place of the template's variable"]);
        assert_eq!(prepared.secrets_file.as_deref().map(|file| file.ends_with(".env.local")), Some(true));
        assert_eq!(prepared.planned.functions[0].alias.as_deref(), Some("live"));
        assert!(orders.reaches_this_machine);
    }

    #[test]
    fn what_cant_run_here_is_refused_at_its_line() {
        let template = TEMPLATE
            .replace("CodeUri: payments/", "CodeUri: payments.zip")
            .replace("TOKEN: from-the-template", "AWS_REGION: eu-west-1");
        let (_folder, project) = project(&template);
        std::fs::write(project.join("payments.zip"), "PK").unwrap();
        let path = project.join("template.yaml");

        let error = prepared(&path, &options(), 3700, &Output::quiet()).err().unwrap();

        let file = path.display();
        assert_eq!(
            error.message,
            format!(
                "ff local start ran nothing: the template has 2 problems\n\
                 {file}:18: Orders: AWS_REGION is reserved: AWS Lambda or FF's runtime sets it\n\
                 {file}:23: Payments: CodeUri names a .zip, which ff local doesn't unpack: name the folder it is made of"
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
