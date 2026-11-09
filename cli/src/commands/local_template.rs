//! `ff local start template.yaml`: a SAM template's app on this machine (ADR 0017), the template read as `ff deploy`
//! reads it, with its refusals. Its functions run in their runtime containers, each started at its first call through
//! the local front door, on one port, kept while calls come and stopped after `--idle` without one; `--watch` starts
//! one again when its code changes. Their names are their logical IDs unless the template names them, as `sam local`
//! names them; their variables the template's, its `Ref`s and `GetAtt`s resolved to what they are here, with the
//! variables FF gives a pod pointed at the front door, and the secrets file's. The functions sign with the local key,
//! which the front door checks a signed request against: made at the first start, printed at each, and kept in
//! `.ff/local/credentials`. Its queues answer SQS at the front door, kept in memory while it runs, and its functions'
//! SQS events read them as FF's event source mappings do. Its buckets answer S3 there, each object a file kept from a
//! start to the next; their notifications send their events to functions and queues, and a bucket whose
//! WebsiteConfiguration makes it a site answers a browser at `http://<bucket>.site.localhost:<port>`, from a folder
//! of this machine's when `--site <bucket>=<folder>` names one. `--with postgres` and `--with valkey` run a
//! PostgreSQL and a Valkey beside the functions, at `DATABASE_URL` and `REDIS_URL` unless the secrets file names them,
//! their data in Docker's volumes of the project's. The mail the functions send, SES v2's `SendEmail` at the front
//! door, is kept in `.ff/local/mail/`, never sent: each message a file a mail reader opens, said as it comes, and
//! listed by `ff local mail`. `ff local reset` empties what it keeps, and `--data` removes those volumes.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Context;
use super::env::{is_variable_name, reserved};
use super::functions::confirmed;
use super::template::{Location, Problems, Read, is_stack_name, is_template};
use crate::api::types::{DeletionPolicy, StackResource};
use crate::cli::LocalArgs;
use crate::config::{is_bucket_name, is_function_name, is_queue_name};
use crate::dates::iso;
use crate::error::{Error, Kind};
use crate::local::events::{LAMBDA_RETRY_POLICY, RetryPolicy};
use crate::local::front_door::{FrontDoor, FunctionUrl, Settings, URL_DOMAIN};
use crate::local::instances::{Docker, Instances};
use crate::local::key::Key;
use crate::local::mail::{self, KeptMessage, Mail};
use crate::local::mappings::LocalMapping;
use crate::local::s3::events::{Rule, Target};
use crate::local::s3::site::{SITES_HOST, Website};
use crate::local::s3::{Buckets, LocalBucket};
use crate::local::schedule_expression::{Expression, InvalidExpression, Millis};
use crate::local::schedules::{self, LocalSchedule, Timetable};
use crate::local::services::{self, Running, Service};
use crate::local::sqs::{QueueSettings, Queues};
use crate::local::{self, Code, LocalFunction, http, images, url};
use crate::output::Output;
use crate::package::ignore::{self, FF_FOLDER};
use crate::sam::Template;
use crate::sam::plan::{self, BUCKET, Place, QUEUE};
use crate::sam::resolve::FUNCTION;
use crate::sigv4::{Credentials, Signable, amz_date, authorization, sha256_hex, uri_encode};

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
/// The buckets' folders, in what ff local keeps.
const BUCKETS: &str = "buckets";
/// The mail's folder, each message and its envelope, in what ff local keeps.
const MAIL: &str = "mail";
/// The front door's address while ff local start runs, in what ff local keeps, for ff local run to find it.
const ENDPOINT: &str = "endpoint";
/// The data services' passwords and ports, in what ff local keeps.
const SERVICES: &str = "services.json";

/// What `ff local start` was given for a template.
pub struct Options<'a> {
    pub port: Option<u16>,
    pub watch: bool,
    pub secrets: Option<&'a Path>,
    pub idle: Option<&'a str>,
    pub stack_name: Option<&'a str>,
    pub parameter_overrides: &'a [String],
    /// `<bucket>=<folder>`: a site that answers a folder's files.
    pub sites: &'a [String],
    /// The data services to run beside the functions.
    pub with: &'a [Service],
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
    // A bucket's virtual-hosted address, which AWS's SDK for JavaScript makes of a bucket's name, reaches this machine
    // too.
    let hosts: Vec<(String, String)> = std::iter::once(HOST.to_owned())
        .chain(planned.buckets.iter().map(|bucket| format!("{}.{HOST}", bucket.name)))
        .map(|name| (name, "host-gateway".to_owned()))
        .collect();
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
            hosts: hosts.clone(),
        });
    }
    functions
}

/// Each function reaches each running data service at its name, and finds it at its variable, `DATABASE_URL` or
/// `REDIS_URL`, unless the secrets file names that: the services whose variable it names.
fn with_services(functions: &mut [LocalFunction], running: &[(Service, String, String)]) -> BTreeSet<Service> {
    let mut named = BTreeSet::new();
    for function in functions {
        for (service, address, password) in running {
            function.hosts.push((service.name().to_owned(), address.clone()));
            let variable = service.variable();
            if function.secrets.contains_key(variable) {
                named.insert(*service);
                continue;
            }
            function.environment.remove(variable);
            function.secrets.insert(variable.to_owned(), service.url(service.name(), service.port(), password));
        }
    }
    named
}

/// What the front door answers of each function besides how it runs, by its name: its alias, its description and
/// the template's variables, a secret's left out; its asynchronous calls' retries and destinations, each within what
/// FF takes, else a problem at its line; its URL, its CORS as FF takes it, its host no other's; its schedules; and the
/// queues of the template it reads, each hiding a message received for the function's timeout at least, as FF
/// requires, a queue that isn't the template's noted.
fn settings(
    planned: &plan::Plan,
    secrets: &BTreeMap<String, String>,
    problems: &mut Problems,
    notes: &mut Vec<String>,
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
        let mut function_schedules = Vec::new();
        for schedule in &function.schedules {
            match Expression::parse(&schedule.expression) {
                Ok(reader) => function_schedules.push(LocalSchedule {
                    name: schedule.name.clone(),
                    expression: schedule.expression.clone(),
                    reader,
                    input: schedule.input.clone(),
                    enabled: schedule.enabled,
                }),
                Err(InvalidExpression(why)) => {
                    let property = plan::expression_key(schedule.kind);
                    let at = format!("/Resources/{id}/Properties/Events/{}/Properties/{property}", schedule.event);
                    problems.at(&at, &format!("{id}: the schedule {}: {why}", schedule.name));
                }
            }
        }
        let mut mappings = Vec::new();
        for mapping in &function.mappings {
            let Some(queue) = planned.queues.iter().find(|queue| queue.name == mapping.queue()) else {
                notes.push(format!(
                    "{id}: its event {} reads the queue {}, which isn't the template's: nothing reads it here, as ff local has the template's queues alone",
                    mapping.event,
                    mapping.queue()
                ));
                continue;
            };
            let visibility = QueueSettings::of(&queue.attributes).visibility_timeout;
            if visibility < i64::from(function.timeout) {
                let message = format!(
                    "{id}: event {} reads the queue {}, whose VisibilityTimeout of {visibility} s is shorter than the function's Timeout of {timeout} s: FF refuses it in Lambda's words, Invalid parameter: Queue visibility timeout: {visibility} seconds is less than Function timeout: {timeout} seconds",
                    mapping.event,
                    queue.name,
                    timeout = function.timeout
                );
                problems.at(&format!("/Resources/{id}/Properties/Events/{}/Properties/Queue", mapping.event), &message);
            }
            mappings.push(LocalMapping {
                event: mapping.event.clone(),
                queue: queue.name.clone(),
                batch_size: usize::try_from(mapping.batch_size).unwrap_or(usize::MAX),
                batching_window: Duration::from_secs(u64::from(mapping.batching_window)),
                report_batch_item_failures: mapping.report_batch_item_failures,
                enabled: mapping.enabled,
            });
        }
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
                schedules: function_schedules,
                mappings,
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

/// How far the schedules' clock is ahead of this machine's: none, but in a test build, as the `ff` suite's, where
/// `FF_TEST_NOW` is the time it starts at, for a schedule's run to come in its time.
fn clock_offset() -> Millis {
    let tests = if cfg!(debug_assertions) { std::env::var("FF_TEST_NOW").ok() } else { None };
    let start = tests.and_then(|text| humantime::parse_rfc3339(&text).ok());
    let millis = |time: SystemTime| time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis());
    start.map_or(0, |start| Millis::try_from(millis(start)).unwrap_or(0) - schedules::now_ms(0))
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
    buckets: Vec<LocalBucket>,
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
            let functions = functions(planned, &pod, &secrets, &mut problems, &mut notes);
            (functions, settings(planned, &secrets, &mut problems, &mut notes))
        }
        None => (Vec::new(), BTreeMap::new()),
    };
    problems.refusal()?;
    let planned = planned.expect("a plan without problems");
    let buckets = local_buckets(&planned, options.sites)?;
    Ok(Prepared { read, planned, functions, settings, buckets, secrets_file, notes })
}

/// The template's buckets as ff local keeps them: each one's notifications, and its site, which answers the folder
/// `--site <bucket>=<folder>` names, the bucket the template's by its name or its logical ID, its WebsiteConfiguration
/// making it a site.
fn local_buckets(planned: &plan::Plan, sites: &[String]) -> Result<Vec<LocalBucket>, Error> {
    let mut folders: BTreeMap<&str, PathBuf> = BTreeMap::new();
    for given in sites {
        let refused = |why: String| Error::usage(format!("--site {given}: {why}"));
        let Some((named, folder)) =
            given.split_once('=').filter(|(named, folder)| !named.is_empty() && !folder.is_empty())
        else {
            return Err(refused(
                "a bucket of the template's and the folder its site answers, as <bucket>=<folder>".into(),
            ));
        };
        let Some(bucket) = planned.buckets.iter().find(|bucket| bucket.name == named || bucket.id == named) else {
            let names: Vec<&str> = planned.buckets.iter().map(|bucket| bucket.name.as_str()).collect();
            let known = match names.is_empty() {
                true => "the template has none".to_owned(),
                false => format!("the template's are {}", names.join(", ")),
            };
            return Err(refused(format!("{named} is no bucket of the template's: {known}")));
        };
        if bucket.website.is_none() {
            let why = format!("{} has no WebsiteConfiguration in the template, which makes a bucket a site", bucket.id);
            return Err(refused(why));
        }
        let folder = std::fs::canonicalize(folder)
            .ok()
            .filter(|folder| folder.is_dir())
            .ok_or_else(|| refused(format!("{folder} is no folder")))?;
        if folders.insert(bucket.name.as_str(), folder).is_some() {
            return Err(Error::usage(format!("--site names the bucket {} twice", bucket.name)));
        }
    }
    let rule = |notification: &plan::Notification| Rule {
        id: notification.id.clone(),
        target: match notification.target {
            plan::Target::Function => Target::Function,
            plan::Target::Queue => Target::Queue,
        },
        arn: notification.arn.clone(),
        events: notification.events.clone(),
        prefix: notification.prefix.clone(),
        suffix: notification.suffix.clone(),
    };
    let buckets = planned.buckets.iter().map(|bucket| LocalBucket {
        name: bucket.name.clone(),
        notifications: bucket.notifications.iter().map(rule).collect(),
        website: bucket.website.as_ref().map(|website| Website {
            index_document: website.index_document.clone(),
            error_document: website.error_document.clone(),
        }),
        site_folder: folders.remove(bucket.name.as_str()),
    });
    Ok(buckets.collect())
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
struct StartedSchedule {
    function: String,
    name: String,
    expression: String,
    enabled: bool,
    /// When it runs next; none when it is disabled or has no run left.
    next_run: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedQueue {
    logical_id: String,
    name: String,
    /// Its URL from this machine; its functions reach it at host.docker.internal.
    url: String,
    /// The queue its redrive policy moves a message to, and after how many receives.
    #[serde(skip_serializing_if = "Option::is_none")]
    dead_letter_queue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_receive_count: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedMapping {
    function: String,
    event: String,
    queue: String,
    batch_size: usize,
    /// How long a batch waits for more messages, in seconds.
    batching_window: u64,
    report_batch_item_failures: bool,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedService {
    name: &'static str,
    image: &'static str,
    /// Its URL from this machine, with its password.
    url: String,
    /// Where the functions reach it.
    from_functions: String,
    /// The variable the functions find it by: none when the secrets file names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    variable: Option<&'static str>,
    /// Docker's volume its data is kept in.
    volume: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedBucket {
    logical_id: String,
    name: String,
    /// The folder its objects are files in.
    folder: String,
    /// The functions and the queues its notifications send its events to, by name.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    events_to: Vec<String>,
    /// Its site's address, when its WebsiteConfiguration makes it one.
    #[serde(skip_serializing_if = "Option::is_none")]
    site: Option<String>,
    /// The folder its site answers instead of its objects, when --site names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    site_folder: Option<String>,
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
    schedules: Vec<StartedSchedule>,
    queues: Vec<StartedQueue>,
    mappings: Vec<StartedMapping>,
    buckets: Vec<StartedBucket>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    services: Vec<StartedService>,
    /// The folder the mail the functions send is kept in.
    mail: String,
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
    let Prepared { read, planned, mut functions, settings, buckets: local_buckets, secrets_file, notes } =
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
    ignore::make_folder(&logs)
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
    // The data services, each answering before a function can start; their passwords and ports kept for the next.
    let wanted: Vec<Service> = options.with.iter().copied().collect::<BTreeSet<_>>().into_iter().collect();
    let services_file = kept.join(SERVICES);
    let accesses = services::accesses(&wanted, &services::read_kept(&services_file)?)?;
    let mut running: Vec<Running> = Vec::new();
    for &service in &wanted {
        running.push(services::start(service, &project, &accesses[&service], context.out)?);
    }
    // Kept once they run: a start refused, another of the project's running them, leaves the file as it was.
    if !wanted.is_empty() {
        services::write_kept(&services_file, &accesses)?;
    }
    let reached: Vec<(Service, String, String)> = running
        .iter()
        .map(|service| (service.service, service.address.clone(), accesses[&service.service].password.clone()))
        .collect();
    let named_by_secrets = with_services(&mut functions, &reached);

    let quiet = context.out.quiet;
    let say: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
        if !quiet {
            eprintln!("{line}")
        }
    });
    let to_say = Arc::clone(&say);
    let docker = Docker { images: runtime_images, logs: logs.clone(), echo: !quiet };
    let instances = Arc::new(Instances::new(docker, functions.clone(), idle, move |line| to_say(line)));
    let queues = planned.queues.iter().map(|queue| (queue.name.clone(), QueueSettings::of(&queue.attributes)));
    let buckets_folder = kept.join(BUCKETS);
    let buckets = Buckets::open(
        &buckets_folder,
        local_buckets.clone(),
        REGION,
        ACCOUNT,
        Arc::new(|| schedules::now_ms(0)),
        Arc::clone(&say),
    )
    .map_err(|error| {
        Error::new(Kind::Failed, format!("Couldn't keep the buckets in {}: {error}", buckets_folder.display()))
    })?;
    let mail_folder = kept.join(MAIL);
    let mail = Mail::new(&mail_folder, Arc::new(|| schedules::now_ms(0)), Arc::clone(&say));
    let door = FrontDoor {
        instances: Arc::clone(&instances),
        region: REGION.to_owned(),
        account: ACCOUNT.to_owned(),
        key: key.clone(),
        settings: Arc::new(settings),
        started: SystemTime::now(),
        second: async_second(),
        say,
        clock_offset: clock_offset(),
        queues: Arc::new(Queues::new(REGION, ACCOUNT, queues, Arc::new(|| schedules::now_ms(0)))),
        buckets: Arc::new(buckets),
        mail: Arc::new(mail),
    };
    let front_door: Arc<dyn http::Answers> = Arc::new(door.clone());
    http::serve(listener, Arc::clone(&front_door));
    let endpoint_file = kept.join(ENDPOINT);
    std::fs::write(&endpoint_file, format!("{endpoint}\n"))
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't write {}: {error}", endpoint_file.display())))?;
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
        watch(Arc::clone(&instances), &functions, project.join(FF_FOLDER))?;
    }
    let offset = door.clock_offset;
    let table = Timetable::new(
        door.settings.iter().map(|(name, settings)| (name, settings.schedules.as_slice())),
        schedules::now_ms(offset),
    );
    let started_schedules: Vec<StartedSchedule> = door
        .settings
        .iter()
        .flat_map(|(function, settings)| settings.schedules.iter().map(move |schedule| (function, schedule)))
        .map(|(function, schedule)| StartedSchedule {
            function: function.clone(),
            name: schedule.name.clone(),
            expression: schedule.expression.clone(),
            enabled: schedule.enabled,
            next_run: table.next_run(function, &schedule.name).map(iso),
        })
        .collect();
    let scheduled = door.clone();
    std::thread::spawn(move || {
        schedules::keep(
            table,
            move || schedules::now_ms(offset),
            move |due| {
                scheduled.run_schedule(&due.function, &due.schedule, due.at);
            },
        )
    });
    // S3's test event to each queue a bucket's notifications name, as S3 sends one when the bucket is made.
    door.deliver(door.buckets.test_events());
    door.read_queues(&Arc::new(AtomicBool::new(false)));
    let started_mappings: Vec<StartedMapping> = door
        .settings
        .iter()
        .flat_map(|(function, settings)| settings.mappings.iter().map(move |mapping| (function, mapping)))
        .map(|(function, mapping)| StartedMapping {
            function: function.clone(),
            event: mapping.event.clone(),
            queue: mapping.queue.clone(),
            batch_size: mapping.batch_size,
            batching_window: mapping.batching_window.as_secs(),
            report_batch_item_failures: mapping.report_batch_item_failures,
            enabled: mapping.enabled,
        })
        .collect();

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
        schedules: started_schedules,
        queues: planned
            .queues
            .iter()
            .map(|queue| StartedQueue {
                logical_id: queue.id.clone(),
                name: queue.name.clone(),
                url: format!("{endpoint}/{ACCOUNT}/{}", queue.name),
                dead_letter_queue: queue.dead_letter().map(str::to_owned),
                max_receive_count: queue.attributes.pointer("/redrivePolicy/maxReceiveCount").and_then(Value::as_u64),
            })
            .collect(),
        mappings: started_mappings,
        buckets: planned
            .buckets
            .iter()
            .zip(&local_buckets)
            .map(|(bucket, local)| StartedBucket {
                logical_id: bucket.id.clone(),
                name: bucket.name.clone(),
                folder: buckets_folder.join(&bucket.name).display().to_string(),
                events_to: bucket.notifications.iter().fold(Vec::new(), |mut names, notification| {
                    let name = notification.destination().to_owned();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                    names
                }),
                site: bucket.website.as_ref().map(|_| format!("http://{}.{SITES_HOST}:{port}/", bucket.name)),
                site_folder: local.site_folder.as_ref().map(|folder| folder.display().to_string()),
            })
            .collect(),
        services: running
            .iter()
            .map(|service| {
                let (name, access) = (service.service, &accesses[&service.service]);
                StartedService {
                    name: name.name(),
                    image: name.image(),
                    url: name.url("127.0.0.1", access.port, &access.password),
                    from_functions: format!("{}:{}", name.name(), name.port()),
                    variable: (!named_by_secrets.contains(&name)).then(|| name.variable()),
                    volume: service.volume.clone(),
                }
            })
            .collect(),
        mail: mail_folder.display().to_string(),
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
        if !started.schedules.is_empty() {
            lines.push("Its schedules, run on time while it runs, or now by ff local run <schedule>:".to_owned());
            let width =
                started.schedules.iter().map(|schedule| schedule.function.len() + schedule.name.len() + 1).max().unwrap_or(0);
            lines.extend(started.schedules.iter().map(|schedule| {
                let next = match (&schedule.next_run, schedule.enabled) {
                    (Some(next), _) => format!("next {next}"),
                    (None, true) => "no run left".to_owned(),
                    (None, false) => "disabled".to_owned(),
                };
                let named = format!("{}/{}", schedule.function, schedule.name);
                format!("  {named:width$}  {}  {next}", schedule.expression)
            }));
        }
        if !started.queues.is_empty() {
            lines.push(format!("Its queues, SQS's at {endpoint}, kept while it runs:"));
            let width = started.queues.iter().map(|queue| queue.name.len()).max().unwrap_or(0);
            lines.extend(started.queues.iter().map(|queue| {
                let line = format!("  {:width$}  {}", queue.name, queue.url);
                match (&queue.dead_letter_queue, queue.max_receive_count) {
                    (Some(dead), Some(count)) => format!("{line}, to {dead} after {count} receives"),
                    _ => line,
                }
            }));
        }
        if !started.mappings.is_empty() {
            lines.push("Its SQS events, each reading its queue while it runs, as FF's event source mappings:".to_owned());
            let width =
                started.mappings.iter().map(|mapping| mapping.function.len() + mapping.event.len() + 1).max().unwrap_or(0);
            lines.extend(started.mappings.iter().map(|mapping| {
                let named = format!("{}/{}", mapping.function, mapping.event);
                let mut line = format!("  {named:width$}  {}: batches of {}", mapping.queue, mapping.batch_size);
                if mapping.batching_window > 0 {
                    line.push_str(&format!(" within {} s", mapping.batching_window));
                }
                if mapping.report_batch_item_failures {
                    line.push_str(", ReportBatchItemFailures");
                }
                if !mapping.enabled {
                    line.push_str(", disabled");
                }
                line
            }));
        }
        if !started.buckets.is_empty() {
            lines.push(format!(
                "Its buckets, S3's at {endpoint}, each object a file in its bucket's folder, kept from a start to the next:"
            ));
            let width = started.buckets.iter().map(|bucket| bucket.name.len()).max().unwrap_or(0);
            lines.extend(started.buckets.iter().map(|bucket| {
                let line = format!("  {:width$}  {}", bucket.name, bucket.folder);
                match bucket.events_to.is_empty() {
                    true => line,
                    false => format!("{line}, its events to {}", bucket.events_to.join(", ")),
                }
            }));
        }
        let sites: Vec<&StartedBucket> = started.buckets.iter().filter(|bucket| bucket.site.is_some()).collect();
        if !sites.is_empty() {
            lines.push("Its sites, each answering a browser at its address:".to_owned());
            let width = sites.iter().map(|bucket| bucket.name.len()).max().unwrap_or(0);
            lines.extend(sites.iter().map(|bucket| {
                let line = format!("  {:width$}  {}", bucket.name, bucket.site.as_deref().unwrap_or_default());
                match &bucket.site_folder {
                    Some(folder) => format!("{line}, {folder}'s files"),
                    None => format!("{line}, its objects"),
                }
            }));
        }
        if !started.services.is_empty() {
            lines.push(
                "Its data, each service's in Docker's volume of the project's, kept until ff local reset --data:".to_owned(),
            );
            let width = started.services.iter().map(|service| service.name.len()).max().unwrap_or(0);
            lines.extend(started.services.iter().map(|service| {
                let variable = match service.variable {
                    Some(variable) => format!("the functions' {variable}"),
                    None => "the secrets file's URL theirs".to_owned(),
                };
                format!("  {:width$}  {}, at {} from the functions, {variable}", service.name, service.url, service.from_functions)
            }));
        }
        lines.push(format!(
            "Its mail, SES v2's SendEmail at {endpoint}, is kept in {}, never sent: ff local mail lists it",
            started.mail
        ));
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

/// The project of a template, or of its folder; this folder's, without one.
fn project_of(path: Option<&Path>) -> Result<PathBuf, Error> {
    let path = path.unwrap_or(Path::new("."));
    if is_template(path) {
        Ok(Location::of(path).project)
    } else if path.is_dir() {
        Ok(path.to_path_buf())
    } else {
        Err(Error::usage(format!("{} is neither a SAM template nor a folder", path.display())))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleRun {
    function: String,
    schedule: String,
    request_id: String,
}

/// `ff local run <schedule>`: the template's app, as ff local start runs it, asked to run the schedule now, signed
/// with the project's key, so that the app of another project, started since on the same port, refuses it.
pub fn run(schedule: &str, path: Option<&Path>, context: &Context) -> Result<(), Error> {
    let project = project_of(path)?;
    let kept = project.join(KEPT);
    let not_running = || {
        Error::new(
            Kind::Failed,
            format!("ff local start isn't running for {}: start it, then run the schedule", project.display()),
        )
    };
    let endpoint = std::fs::read_to_string(kept.join(ENDPOINT)).map_err(|_| not_running())?.trim().to_owned();
    let key = Key::read(&kept.join(CREDENTIALS))?.ok_or_else(not_running)?;
    let target = match schedule.split_once('/') {
        Some((function, name)) => {
            format!("/ff-local/schedules/{}/{}", uri_encode(function, false), uri_encode(name, false))
        }
        None => format!("/ff-local/schedules/{}", uri_encode(schedule, false)),
    };
    let host = endpoint.split_once("://").map_or(endpoint.as_str(), |(_, host)| host).to_owned();
    let date = amz_date(SystemTime::now());
    let payload = sha256_hex(b"");
    let headers = vec![("host".to_owned(), host), ("x-amz-date".to_owned(), date.clone())];
    let credentials = Credentials { access_key_id: key.id, secret_access_key: key.secret, region: REGION.to_owned() };
    let signable = Signable { method: "POST", path: &target, query: &[], headers: &headers, payload_sha256: &payload };
    let signature = authorization(&credentials, &signable, &date, "lambda");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .user_agent(format!("ff-cli/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut answer = agent
        .post(&format!("{endpoint}{target}"))
        .header("x-amz-date", &date)
        .header("authorization", &signature)
        .send_empty()
        .map_err(|error| {
            Error::new(
                Kind::Failed,
                format!(
                    "ff local start isn't running for {}: nothing answers at {endpoint} ({error}): start it, then run the schedule",
                    project.display()
                ),
            )
        })?;
    let status = answer.status().as_u16();
    let body: Value = serde_json::from_str(&answer.body_mut().read_to_string().unwrap_or_default()).unwrap_or_default();
    let message = body["message"].as_str().unwrap_or_default();
    match status {
        202 => {
            let ran: ScheduleRun = serde_json::from_value(body.clone()).map_err(|error| {
                Error::new(Kind::Failed, format!("ff local start's answer at {endpoint} can't be read: {error}"))
            })?;
            context.out.result(&ran, || {
                format!(
                    "{}'s schedule {} runs now: the asynchronous call {}, whose log is ff local start's",
                    ran.function, ran.schedule, ran.request_id
                )
            })
        }
        403 => Err(Error::new(
            Kind::Failed,
            format!(
                "the app at {endpoint} isn't {}'s: its ff local start stopped, and another project's runs there",
                project.display()
            ),
        )),
        400 | 404 => Err(Error::usage(message.to_owned())),
        _ => Err(Error::new(Kind::Failed, format!("ff local start at {endpoint} answered {status}: {message}"))),
    }
}

#[derive(Serialize)]
struct KeptMail {
    folder: String,
    /// The latest last.
    messages: Vec<KeptMessage>,
}

/// `ff local mail`: the mail the template's functions sent, which ff local start keeps, the latest last.
pub fn mail(path: Option<&Path>, context: &Context) -> Result<(), Error> {
    let folder = project_of(path)?.join(KEPT).join(MAIL);
    let messages = mail::kept_in(&folder)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read {}: {error}", folder.display())))?;
    let kept = KeptMail { folder: folder.display().to_string(), messages };
    context.out.result(&kept, || {
        if kept.messages.is_empty() {
            return format!(
                "No mail in {}: a message a function sends with SES v2's SendEmail is kept there while ff local start runs",
                kept.folder
            );
        }
        let count = match kept.messages.len() {
            1 => "1 message".to_owned(),
            count => format!("{count} messages"),
        };
        let mut lines = vec![format!("{count} kept in {}, never sent, the latest last:", kept.folder)];
        for message in &kept.messages {
            lines.push(format!(
                "  {}  from {} to {}: \"{}\", {} bytes",
                message.sent_at,
                message.from,
                message.recipients.join(", "),
                message.subject,
                message.bytes
            ));
            lines.push(format!("    {}", message.file));
        }
        lines.join("\n")
    })
}

/// `ff local reset`: what ff local keeps for the project removed, and with `data` its data services' volumes, which
/// Docker finds by the project's folder.
pub fn reset(path: Option<&Path>, data: bool, yes: bool, context: &Context) -> Result<(), Error> {
    let project = project_of(path)?;
    let kept = project.join(KEPT);
    let folder = kept.display().to_string();
    let volumes = match data {
        true => services::volumes_of(&std::fs::canonicalize(&project).unwrap_or_else(|_| project.clone()))?,
        false => Vec::new(),
    };
    let answer =
        |reset: bool, volumes: &[String]| serde_json::json!({ "reset": reset, "folder": folder, "volumes": volumes });
    if !kept.exists() && volumes.is_empty() {
        let nor = if data { " nor a volume of its data" } else { "" };
        return context.out.result(&answer(false, &[]), || format!("Nothing to reset: there is no {folder}{nor}"));
    }
    let mut what = Vec::new();
    if kept.exists() {
        what.push(format!(
            "{folder}, what ff local keeps: the functions' logs, the buckets' objects, the mail kept and the local key"
        ));
    }
    if !volumes.is_empty() {
        what.push(format!("its data, Docker's volumes {}", volumes.join(", ")));
    }
    if !confirmed("ff local reset", &format!("Remove {}?", what.join(", and ")), yes)? {
        return context.out.result(&answer(false, &[]), || "Nothing removed".to_owned());
    }
    for volume in &volumes {
        let removed = local::docker(&["volume".into(), "rm".into(), volume.clone()])?;
        if !removed.status.success() {
            return Err(Error::new(
                Kind::Failed,
                format!(
                    "Couldn't remove Docker's volume {volume}: {}: stop ff local start first",
                    local::stderr_of(&removed)
                ),
            ));
        }
    }
    if kept.exists() {
        std::fs::remove_dir_all(&kept)
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't remove {folder}: {error}")))?;
    }
    context.out.result(&answer(true, &volumes), || {
        let mut removed = vec![folder.clone()];
        removed.extend(volumes.iter().map(|volume| format!("Docker's volume {volume}")));
        format!("removed {}", removed.join(", "))
    })
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
        Options {
            port: None,
            watch: false,
            secrets: None,
            idle: None,
            stack_name: None,
            parameter_overrides: &[],
            sites: &[],
            with: &[],
        }
    }

    fn key() -> Key {
        Key { id: "AKFFLOCALKEY0000TEST".into(), secret: "a-secret".into() }
    }

    fn function<'a>(prepared: &'a Prepared, name: &str) -> &'a LocalFunction {
        prepared.functions.iter().find(|function| function.name == name).unwrap()
    }

    #[test]
    fn each_function_reaches_a_running_data_service_at_its_name_and_its_variable_unless_the_secrets_file_names_it() {
        let (_folder, project) = project(TEMPLATE);
        std::fs::write(project.join(".env.local"), "REDIS_URL=redis://default:mine@cache.example:6379\n").unwrap();
        let mut functions =
            prepared(&project.join("template.yaml"), &options(), 3700, &key(), &Output::quiet()).unwrap().functions;
        functions[0].environment.insert("DATABASE_URL".into(), "the template's".into());
        let running = [(Service::Postgres, "172.17.0.5", "pw1"), (Service::Valkey, "172.17.0.6", "pw2")]
            .map(|(service, address, password)| (service, address.to_owned(), password.to_owned()));

        let named_by_secrets = with_services(&mut functions, &running);

        assert_eq!(named_by_secrets, BTreeSet::from([Service::Valkey]));
        assert_eq!(functions.len(), 2);
        for function in &functions {
            assert_eq!(function.secrets["DATABASE_URL"], "postgresql://app:pw1@postgres:5432/app", "{}", function.name);
            assert_eq!(function.secrets["REDIS_URL"], "redis://default:mine@cache.example:6379", "the secrets file's");
            assert!(!function.environment.contains_key("DATABASE_URL"), "given by its name alone");
            let hosts =
                [("postgres", "172.17.0.5"), ("valkey", "172.17.0.6")].map(|(name, at)| (name.into(), at.into()));
            assert!(hosts.iter().all(|host| function.hosts.contains(host)), "{:?}", function.hosts);
        }
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
        let hosts =
            ["host.docker.internal", "uploads.host.docker.internal"].map(|name| (name.into(), "host-gateway".into()));
        assert_eq!(orders.hosts, hosts, "this machine, at its name and each bucket's under it");

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

    /// The template, `Orders` with a Schedule event `Nightly` and a ScheduleV2 event `Often`, its expression `often`,
    /// disabled, with its own input.
    fn with_schedules(often: &str) -> String {
        let events = format!(
            "      Events:\n        Nightly:\n          Type: Schedule\n          Properties:\n            Schedule: cron(0 2 * * ? *)\n        Often:\n          Type: ScheduleV2\n          Properties:\n            Name: often\n            ScheduleExpression: {often}\n            State: DISABLED\n            Input: '{{\"report\": \"often\"}}'\n"
        );
        TEMPLATE.replace("      CodeUri: orders/\n", &format!("      CodeUri: orders/\n{events}"))
    }

    #[test]
    fn a_functions_schedules_are_read_and_an_expression_ff_refuses_is_refused_at_its_line() {
        let (_folder, project) = project(&with_schedules("rate(5 minutes)"));
        let path = project.join("template.yaml");

        let read_here = prepared(&path, &options(), 3700, &key(), &Output::quiet()).unwrap();

        let read: Vec<(&str, &str, bool, Option<&Value>)> = read_here.settings["Orders"]
            .schedules
            .iter()
            .map(|schedule| {
                (schedule.name.as_str(), schedule.expression.as_str(), schedule.enabled, schedule.input.as_ref())
            })
            .collect();
        let input = serde_json::json!({ "report": "often" });
        assert_eq!(
            read,
            [("Nightly", "cron(0 2 * * ? *)", true, None), ("often", "rate(5 minutes)", false, Some(&input))]
        );

        std::fs::write(&path, with_schedules("rate(5 minute)")).unwrap();
        let error = prepared(&path, &options(), 3700, &key(), &Output::quiet()).err().unwrap();

        assert_eq!(
            error.message,
            format!(
                "ff local start ran nothing: the template has a problem\n{}:21: Orders: the schedule often: rate(5 minute) must be rate(5 minutes): the unit is plural above 1",
                path.display()
            )
        );
    }

    /// The template, `Orders`, its timeout `timeout` seconds, reading `Jobs`, the template's queue, in batches of 5
    /// within 2 s, its failures reported; and a queue of the account the template hasn't, through a literal ARN.
    fn with_mappings(timeout: u32) -> String {
        let events = format!(
            "      Timeout: {timeout}\n      Events:\n        Work:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Jobs.Arn\n            BatchSize: 5\n            MaximumBatchingWindowInSeconds: 2\n            FunctionResponseTypes:\n              - ReportBatchItemFailures\n        Elsewhere:\n          Type: SQS\n          Properties:\n            Queue: arn:aws:sqs:tn-tunis-1:000000000000:elsewhere\n            Enabled: false\n"
        );
        TEMPLATE.replace("      CodeUri: orders/\n", &format!("      CodeUri: orders/\n{events}"))
    }

    #[test]
    fn a_functions_sqs_events_read_the_templates_queues_each_hiding_a_message_for_its_timeout() {
        let (_folder, project) = project(&with_mappings(30));
        let path = project.join("template.yaml");

        let read_here = prepared(&path, &options(), 3700, &key(), &Output::quiet()).unwrap();

        let work = LocalMapping {
            event: "Work".into(),
            queue: "Jobs".into(),
            batch_size: 5,
            batching_window: Duration::from_secs(2),
            report_batch_item_failures: true,
            enabled: true,
        };
        assert_eq!(read_here.settings["Orders"].mappings, [work]);
        assert!(read_here.settings["payments-fn"].mappings.is_empty());
        assert_eq!(
            read_here.notes,
            [
                "Orders: its event Elsewhere reads the queue elsewhere, which isn't the template's: nothing reads it here, as ff local has the template's queues alone"
            ]
        );

        std::fs::write(&path, with_mappings(31)).unwrap();
        let error = prepared(&path, &options(), 3700, &key(), &Output::quiet()).err().unwrap();

        assert_eq!(
            error.message,
            format!(
                "ff local start ran nothing: the template has a problem\n{}:17: Orders: event Work reads the queue Jobs, whose VisibilityTimeout of 30 s is shorter than the function's Timeout of 31 s: FF refuses it in Lambda's words, Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 31 seconds",
                path.display()
            )
        );
    }

    /// A front door that answers `ff local run` as `answer` says, keeping what it was asked.
    struct Asked {
        requests: Arc<std::sync::Mutex<Vec<http::Request>>>,
    }

    impl http::Answers for Asked {
        fn answer(&self, request: &http::Request, _: &str, _: &str) -> http::Response {
            self.requests.lock().unwrap().push(request.clone());
            let refused = |status: u16, message: &str| http::Response {
                status,
                headers: Vec::new(),
                body: serde_json::json!({ "Type": "User", "message": message }).to_string().into_bytes(),
            };
            match request.target.as_str() {
                "/ff-local/schedules/Reporter/Nightly" => http::Response {
                    status: 202,
                    headers: Vec::new(),
                    body: br#"{"function": "Reporter", "schedule": "Nightly", "requestId": "a-run"}"#.to_vec(),
                },
                "/ff-local/schedules/Elsewhere" => {
                    refused(403, "The security token included in the request is invalid.")
                }
                _ => refused(404, "No function has a schedule Hourly: the template's are Reporter/Nightly"),
            }
        }

        fn unreadable(&self, _: bool, _: Option<&http::Request>) -> http::Response {
            http::Response { status: 400, headers: Vec::new(), body: Vec::new() }
        }
    }

    #[test]
    fn a_templates_buckets_keep_their_notifications_and_a_site_answers_the_folder_site_names() {
        let template = TEMPLATE
            .replace(
                "      AutoPublishAlias: live\n",
                "      AutoPublishAlias: live\n      Events:\n        Upload:\n          Type: S3\n          Properties:\n            Bucket: !Ref Uploads\n            Events: s3:ObjectCreated:*\n",
            )
            .replace(
                "  Uploads:\n    Type: AWS::S3::Bucket\n",
                "  Uploads:\n    Type: AWS::S3::Bucket\n    Properties:\n      NotificationConfiguration:\n        QueueConfigurations:\n          - Event: s3:ObjectRemoved:*\n            Queue: !GetAtt Jobs.Arn\n  Site:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: shop-site\n      WebsiteConfiguration:\n        IndexDocument: index.html\n        ErrorDocument: 404.html\n",
            );
        let (_folder, project) = project(&template);
        std::fs::create_dir_all(project.join("site")).unwrap();
        let path = project.join("template.yaml");
        let folder = project.join("site").display().to_string();
        let given = |sites: &[String]| prepared(&path, &Options { sites, ..options() }, 3700, &key(), &Output::quiet());

        let read_here = given(&[format!("Site={folder}")]).unwrap();

        let rule = |id: &str, target: Target, arn: &str, event: &str| Rule {
            id: id.into(),
            target,
            arn: arn.into(),
            events: vec![event.into()],
            prefix: None,
            suffix: None,
        };
        let uploads = LocalBucket {
            name: "uploads".into(),
            notifications: vec![
                rule("UploadsQueue1", Target::Queue, "arn:aws:sqs:tn-tunis-1:000000000000:Jobs", "s3:ObjectRemoved:*"),
                rule(
                    "OrdersUpload",
                    Target::Function,
                    "arn:aws:lambda:tn-tunis-1:000000000000:function:Orders:live",
                    "s3:ObjectCreated:*",
                ),
            ],
            website: None,
            site_folder: None,
        };
        let site = LocalBucket {
            name: "shop-site".into(),
            notifications: Vec::new(),
            website: Some(Website { index_document: "index.html".into(), error_document: Some("404.html".into()) }),
            site_folder: Some(std::fs::canonicalize(project.join("site")).unwrap()),
        };
        assert_eq!(read_here.buckets, [uploads, site.clone()]);
        assert_eq!(given(&[format!("shop-site={folder}")]).unwrap().buckets[1], site, "by its name too");
        assert_eq!(given(&[]).unwrap().buckets[1].site_folder, None, "its objects, without --site");

        let refused = |sites: &[&str]| {
            given(&sites.iter().map(|site| (*site).to_owned()).collect::<Vec<_>>()).err().unwrap().message
        };
        assert_eq!(
            refused(&["nowhere=site"]),
            "--site nowhere=site: nowhere is no bucket of the template's: the template's are uploads, shop-site"
        );
        assert_eq!(
            refused(&["Uploads=site"]),
            "--site Uploads=site: Uploads has no WebsiteConfiguration in the template, which makes a bucket a site"
        );
        assert_eq!(
            refused(&["Site"]),
            "--site Site: a bucket of the template's and the folder its site answers, as <bucket>=<folder>"
        );
        let missing = project.join("missing").display().to_string();
        assert_eq!(refused(&[&format!("Site={missing}")]), format!("--site Site={missing}: {missing} is no folder"));
        let twice = [format!("Site={folder}"), format!("shop-site={folder}")];
        assert_eq!(refused(&[&twice[0], &twice[1]]), "--site names the bucket shop-site twice");
    }

    #[test]
    fn run_asks_the_running_app_signed_with_the_projects_key_and_says_why_it_cant() {
        let (_folder, project) = project(TEMPLATE);
        let kept = project.join(KEPT);
        let (connection, out) = (ConnectionArgs::default(), Output::quiet());
        let context = Context { connection: &connection, out: &out };
        let not_running =
            format!("ff local start isn't running for {}: start it, then run the schedule", project.display());

        assert_eq!(run("Nightly", Some(&project), &context).unwrap_err().message, not_running);
        std::fs::create_dir_all(&kept).unwrap();
        key().write(&kept.join(CREDENTIALS)).unwrap();
        let gone = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::fs::write(kept.join(ENDPOINT), format!("http://127.0.0.1:{gone}\n")).unwrap();
        let message = run("Nightly", Some(&project.join("template.yaml")), &context).unwrap_err().message;
        assert!(
            message.starts_with(&format!(
                "ff local start isn't running for {}: nothing answers at http://127.0.0.1:{gone} (",
                project.display()
            )),
            "{message}"
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        http::serve(listener, Arc::new(Asked { requests: Arc::clone(&requests) }));
        std::fs::write(kept.join(ENDPOINT), format!("{endpoint}\n")).unwrap();

        run("Reporter/Nightly", Some(&project), &context).unwrap();
        let hourly = run("Hourly", Some(&project), &context).unwrap_err();
        let elsewhere = run("Elsewhere", Some(&project), &context).unwrap_err();

        assert_eq!(
            (hourly.kind, hourly.message.as_str()),
            (Kind::Usage, "No function has a schedule Hourly: the template's are Reporter/Nightly")
        );
        assert_eq!(
            elsewhere.message,
            format!(
                "the app at {endpoint} isn't {}'s: its ff local start stopped, and another project's runs there",
                project.display()
            )
        );
        let asked = requests.lock().unwrap()[0].clone();
        assert_eq!((asked.method.as_str(), asked.target.as_str()), ("POST", "/ff-local/schedules/Reporter/Nightly"));
        let signature = crate::sigv4::read_authorization(&asked.headers, "lambda").unwrap().unwrap();
        let signed = crate::sigv4::SignedRequest {
            method: &asked.method,
            raw_path: &asked.target,
            raw_query: "",
            headers: &asked.headers,
        };
        let now = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()).unwrap();
        assert_eq!(signature.access_key_id, key().id);
        crate::sigv4::check_authorization(&signed, b"", &signature, &key().secret, now, "lambda").unwrap();
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

        reset(Some(&project.join("template.yaml")), false, true, &context).unwrap();
        assert!(!project.join(".ff/local").exists() && project.join("template.yaml").exists());
        reset(Some(&project), false, true, &context).unwrap();
        assert!(reset(Some(&project.join("missing.txt")), false, true, &context).is_err());
    }
}
