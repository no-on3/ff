//! `ff deploy template.yaml` and `ff delete-stack`: a SAM template's functions made on FF as `sam deploy` makes them
//! on AWS (ADR 0016), and the stack kept in FF's API, what each logical ID made, so that the next deploy changes what
//! the template changed and deletes what it no longer has, after asking.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

use super::deploy::{self, Code, Deploy, Wanted};
use super::functions::confirmed;
use super::secrets::Secrets;
use super::url::FunctionUrl;
use super::{Context, account, async_config};
use crate::api::types::{Function, Stack, StackResource, find};
use crate::api::{Call, Client};
use crate::cli::{DeployArgs, Runtime};
use crate::error::{Error, Kind};
use crate::package::{self, Options, Package};
use crate::sam::parameters::{self, SAMCONFIG, Samconfig};
use crate::sam::plan::{self, ALIAS, EVENT_INVOKE_CONFIG, Known, Made, Place, URL};
use crate::sam::resolve::FUNCTION;
use crate::sam::{self, Template, subset};

/// A stack's name, as CloudFormation takes one: letters, digits and hyphens, a letter first, 128 at most.
pub(super) fn is_stack_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes.next().is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Whether `ff deploy` was given a SAM template: a .yaml or .yml file.
pub fn is_template(path: &Path) -> bool {
    path.is_file() && path.extension().is_some_and(|extension| extension == "yaml" || extension == "yml")
}

/// The flags of a function's deploy, which a template's functions take from it instead.
fn function_flags(args: &DeployArgs) -> Vec<&'static str> {
    [
        ("--name", args.name.is_some()),
        ("--runtime", args.runtime.is_some()),
        ("--handler", args.handler.is_some()),
        ("--memory", args.memory.is_some()),
        ("--timeout", args.timeout.is_some()),
        ("--min-instances", args.min_instances.is_some()),
        ("--max-instances", args.max_instances.is_some()),
        ("--env", !args.env.is_empty()),
        ("--publish", args.publish),
        ("--alias", args.alias.is_some()),
    ]
    .into_iter()
    .filter(|(_, given)| *given)
    .map(|(flag, _)| flag)
    .collect()
}

/// The flags of a template's deploy, refused for a function's file or folder.
pub fn stack_flags(args: &DeployArgs) -> Result<(), Error> {
    if args.stack_name.is_some() || !args.parameter_overrides.is_empty() || args.yes {
        return Err(Error::usage(
            "--stack-name, --parameter-overrides and --yes are for a SAM template, a .yaml or .yml file: a function's file or \
             folder is deployed alone",
        ));
    }
    Ok(())
}

/// Where a template's code and its samconfig.toml are. `sam build`'s template, in `.aws-sam/build`, names the folders
/// it built, which ff deploys as they are; its project, and samconfig.toml, are two folders up.
struct Location {
    folder: PathBuf,
    project: PathBuf,
    built: bool,
}

impl Location {
    fn of(template: &Path) -> Location {
        let folder_of = |path: Option<&Path>| match path {
            Some(path) if !path.as_os_str().is_empty() => path.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let folder = folder_of(template.parent());
        let built = folder.ends_with(".aws-sam/build");
        let project = if built { folder_of(folder.parent().and_then(Path::parent)) } else { folder.clone() };
        Location { folder, project, built }
    }
}

/// The folder's samconfig.toml as `sam deploy` reads it, if it has one.
fn samconfig(folder: &Path) -> Result<Option<Samconfig>, Error> {
    let path = folder.join(SAMCONFIG);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(None) };
    parameters::samconfig(&text)
        .map(Some)
        .map_err(|why| Error::usage(format!("{}: the SAM CLI can't read it for `sam deploy`: {why}", path.display())))
}

/// A SHA-256 in lowercase hexadecimal, as the stack keeps its template's.
fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A random part for each name ff deploy makes, drawn before the plan, which can't fail halfway.
fn suffixes(count: usize) -> Result<Vec<String>, Error> {
    (0..count)
        .map(|_| {
            let mut random = [0u8; plan::SUFFIX_LENGTH];
            getrandom::fill(&mut random)
                .map_err(|error| Error::new(Kind::Failed, format!("No randomness for a function's name: {error}")))?;
            Ok(plan::suffix(&random))
        })
        .collect()
}

/// A template's problems, each at its line, as one refusal.
struct Problems<'a> {
    file: String,
    template: &'a Template,
    found: Vec<String>,
}

impl Problems<'_> {
    /// A problem at a value of the template, or where its resource starts when the value is the Globals'.
    fn at(&mut self, pointer: &str, message: &str) {
        let resource: String = pointer.split('/').take(3).collect::<Vec<_>>().join("/");
        let line = self.template.line(pointer).or_else(|| self.template.line(&resource));
        self.line(line, message);
    }

    fn line(&mut self, line: Option<usize>, message: &str) {
        let file = &self.file;
        self.found.push(match line {
            Some(line) => format!("{file}:{line}: {message}"),
            None => format!("{file}: {message}"),
        });
    }

    fn refusal(self) -> Result<(), Error> {
        match self.found.len() {
            0 => Ok(()),
            count => Err(Error::usage(format!(
                "ff deploy changed nothing: the template has {}\n{}",
                if count == 1 { "a problem".to_owned() } else { format!("{count} problems") },
                self.found.join("\n")
            ))),
        }
    }
}

/// The stack as FF keeps it, saved whole as the deploy goes: what it made is the stack's when it stops halfway.
struct Record<'a> {
    client: &'a Client,
    name: &'a str,
    template_sha256: String,
    parameters: BTreeMap<String, String>,
    resources: Vec<StackResource>,
}

impl Record<'_> {
    /// What a function made, in place of what had its logical IDs or named the same FF resources.
    fn keep(&mut self, made: &[StackResource]) {
        let same = |old: &StackResource, new: &StackResource| {
            old.logical_id == new.logical_id
                || (new.physical_id.is_some() && (&old.kind, &old.physical_id) == (&new.kind, &new.physical_id))
        };
        self.resources.retain(|old| !made.iter().any(|new| same(old, new)));
        self.resources.extend(made.iter().cloned());
    }

    fn save(&self) -> Result<(), Error> {
        let body = json!({
            "templateSha256": self.template_sha256,
            "parameters": self.parameters,
            "resources": self.resources,
        });
        self.client.json::<Stack>(&Call::put(format!("/stacks/{}", self.name), body)).map(|_| ())
    }
}

/// What the deploy did to one of the template's functions.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionDeployed {
    logical_id: String,
    name: String,
    /// created, updated or unchanged.
    action: &'static str,
    changed: Vec<&'static str>,
    seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackDeployed {
    stack: String,
    functions: Vec<FunctionDeployed>,
    deleted: Vec<StackResource>,
    outputs: Vec<plan::Output>,
}

/// The parameters' values as `sam deploy` gives them: on an update, each one not given keeps the stack's last value;
/// those given, from `--parameter-overrides`, else samconfig.toml; the template's Default for the rest.
fn given_values(template: &Template, last: Option<&Stack>, given: Vec<(String, String)>) -> Vec<(String, String)> {
    let names = template.value.get("Parameters").and_then(Value::as_object);
    let previous = last.into_iter().flat_map(|stack| stack.parameters.iter());
    previous
        .filter(|(name, _)| names.is_some_and(|names| names.contains_key(*name)))
        .map(|(name, value)| (name.clone(), value.clone()))
        .chain(given)
        .collect()
}

/// The values the stack keeps for the next deploy: each parameter's but a NoEcho one's, a list's items apart by commas.
fn kept_values(template: &Template, values: &BTreeMap<String, Value>) -> BTreeMap<String, String> {
    let no_echo = |name: &str| {
        template.value.pointer(&format!("/Parameters/{name}/NoEcho")).is_some_and(|flag| {
            flag.as_bool() == Some(true) || flag.as_str().is_some_and(|text| text.eq_ignore_ascii_case("true"))
        })
    };
    values
        .iter()
        .filter(|(name, _)| !no_echo(name))
        .map(|(name, value)| {
            let text = match value {
                Value::Array(items) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","),
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            (name.clone(), text)
        })
        .collect()
}

/// Whether the URL is as the template says: who may call it, and its CORS, a field it leaves out empty.
fn url_as_wanted(url: &FunctionUrl, wanted: &plan::Url) -> bool {
    let empty = Value::Object(Default::default());
    let current = url.cors.as_ref().unwrap_or(&empty);
    let wanted_cors = wanted.cors.as_ref().unwrap_or(&empty);
    let is_empty = |value: &Value| match value {
        Value::Null | Value::Bool(false) => true,
        Value::Array(items) => items.is_empty(),
        Value::Number(number) => number.as_u64() == Some(0),
        _ => false,
    };
    let fields: BTreeSet<&String> =
        current.as_object().into_iter().chain(wanted_cors.as_object()).flat_map(|fields| fields.keys()).collect();
    url.auth_type == wanted.auth_type
        && fields.into_iter().all(|field| match (current.get(field), wanted_cors.get(field)) {
            (Some(current), Some(wanted)) => current == wanted,
            (Some(one), None) | (None, Some(one)) => is_empty(one),
            (None, None) => true,
        })
}

/// The function's URL as the template says, its alias's with AutoPublishAlias: made, changed, or kept; and whether it
/// changed.
fn ensure_url(
    client: &Client,
    function: &Function,
    alias: Option<&str>,
    wanted: &plan::Url,
) -> Result<(FunctionUrl, bool), Error> {
    let qualified = |call: Call| match alias {
        Some(alias) => call.query("qualifier", alias),
        None => call,
    };
    let path = format!("/functions/{}/url", function.id);
    let body = json!({ "authType": wanted.auth_type, "cors": wanted.cors });
    match client.json_if_any::<FunctionUrl>(&qualified(Call::get(path.clone())))? {
        Some(url) if url_as_wanted(&url, wanted) => Ok((url, false)),
        Some(_) => Ok((client.json(&qualified(Call::put(path, body)))?, true)),
        None => Ok((client.json(&qualified(Call::post(path, body)))?, true)),
    }
}

/// The settings of its asynchronous calls as FF's API answers them, Lambda's fields alone, those unset left out.
fn event_invoke_fields(config: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for field in ["maximumRetryAttempts", "maximumEventAgeInSeconds"] {
        if let Some(value) = config.get(field).filter(|value| !value.is_null()) {
            fields.insert(field.into(), value.clone());
        }
    }
    let mut destinations = serde_json::Map::new();
    for field in ["onSuccess", "onFailure"] {
        if let Some(destination) =
            config.pointer(&format!("/destinationConfig/{field}/destination")).filter(|value| !value.is_null())
        {
            destinations.insert(field.into(), json!({ "destination": destination }));
        }
    }
    if !destinations.is_empty() {
        fields.insert("destinationConfig".into(), Value::Object(destinations));
    }
    Value::Object(fields)
}

/// The settings of its asynchronous calls as the template says, put when they differ; whether they did.
fn ensure_event_invoke_config(client: &Client, function: &Function, wanted: &Value) -> Result<bool, Error> {
    let current = async_config::current(client, &function.id)?;
    if current.as_ref().map(event_invoke_fields).as_ref() == Some(&event_invoke_fields(wanted)) {
        return Ok(false);
    }
    client.json::<Value>(&Call::put(format!("/functions/{}/event-invoke-config", function.id), wanted.clone()))?;
    Ok(true)
}

/// Deletes what a resource of the stack made, unless it is gone already: a function with what is its, its URL, its
/// alias, or its asynchronous calls' settings.
fn delete_resource(client: &Client, resource: &StackResource) -> Result<(), Error> {
    let Some(function) = find(client, plan::function_of(resource))? else { return Ok(()) };
    let qualifier = resource.physical_id.as_deref().and_then(|id| id.split_once(':')).map(|(_, qualifier)| qualifier);
    let id = &function.id;
    let call = match (resource.kind.as_str(), qualifier) {
        (FUNCTION, _) => Call::delete(format!("/functions/{id}")),
        (URL, None) => Call::delete(format!("/functions/{id}/url")),
        (URL, Some(alias)) => Call::delete(format!("/functions/{id}/url")).query("qualifier", alias),
        (ALIAS, Some(alias)) => Call::delete(format!("/functions/{id}/aliases/{alias}")),
        (EVENT_INVOKE_CONFIG, _) => Call::delete(format!("/functions/{id}/event-invoke-config")),
        _ => return Ok(()),
    };
    match client.done(&call) {
        Err(error) if error.status == Some(404) => Ok(()),
        done => done,
    }
}

/// What a function of the stack is, for the question before a delete: its resources in words.
fn listed(resources: &[StackResource]) -> String {
    resources.iter().map(plan::in_words).collect::<Vec<_>>().join(", ")
}

/// The functions' packages, each folder built once for its runtime and each .zip read once, each function's handler
/// checked: the packages, and the one of each function.
fn packages(
    functions: &[plan::Function],
    at: &Location,
    args: &DeployArgs,
    problems: &mut Problems,
    context: &Context,
) -> Result<(Vec<Package>, Vec<usize>), Error> {
    let mut built: Vec<((PathBuf, Runtime), Package)> = Vec::new();
    let mut each = Vec::new();
    for function in functions {
        let key = (function.code.clone(), function.runtime);
        let index = match built.iter().position(|(made, _)| *made == key) {
            Some(index) => index,
            None => {
                let package = if function.code.is_dir() {
                    let options = Options {
                        runtime: Some(function.runtime),
                        container: args.build.container,
                        no_build: args.build.no_build || at.built,
                        compile: false,
                        leave_out: None,
                    };
                    package::build(&function.code, &options, context.out)?
                } else {
                    package::from_zip(&function.code, function.runtime)?
                };
                built.push((key, package));
                built.len() - 1
            }
        };
        if let Some(problem) = package::handler_problem(&built[index].1.files, &function.handler, function.runtime) {
            problems
                .at(&format!("/Resources/{}/Properties/Handler", function.id), &format!("{}: {problem}", function.id));
        }
        each.push(index);
    }
    Ok((built.into_iter().map(|(_, package)| package).collect(), each))
}

pub fn deploy(args: &DeployArgs, context: &Context) -> Result<(), Error> {
    let flags = function_flags(args);
    if !flags.is_empty() {
        return Err(Error::usage(format!(
            "{} {} for a function's file or folder: a template's functions take their settings from it",
            flags.join(", "),
            if flags.len() == 1 { "is" } else { "are" }
        )));
    }
    let path = &args.path;
    let text = std::fs::read_to_string(path)
        .map_err(|error| Error::usage(format!("Couldn't read {} as UTF-8 text: {error}", path.display())))?;
    let file = path.display().to_string();
    let template = sam::read(&text).map_err(|error| {
        Error::usage(format!(
            "{file}:{}: CloudFormation can't read it, at column {}: {}",
            error.at.line, error.at.column, error.message
        ))
    })?;
    let at = Location::of(path);
    let config = samconfig(&at.project)?;
    let stack_name = match (&args.stack_name, config.as_ref().and_then(|config| config.stack_name.as_ref())) {
        (Some(name), _) | (None, Some(name)) => name.clone(),
        (None, None) => {
            return Err(Error::usage(format!(
                "Name the stack: --stack-name, or stack_name in {SAMCONFIG}, as `sam deploy` takes it"
            )));
        }
    };
    if !is_stack_name(&stack_name) {
        return Err(Error::usage(format!(
            "{stack_name} can't be a stack's name: letters, digits and hyphens, a letter first, 128 at most, as CloudFormation's"
        )));
    }
    let (given, from) = if args.parameter_overrides.is_empty() {
        (config.map(|config| config.parameter_overrides).unwrap_or_default(), SAMCONFIG)
    } else {
        let overrides = parameters::overrides(&args.parameter_overrides)
            .map_err(|why| Error::usage(format!("--parameter-overrides: {why}")))?;
        (overrides, "--parameter-overrides")
    };

    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let me = account::me(&client)?;
    let account = account::current(&me, &settings)?;
    let region = account.aws.as_ref().map(|aws| aws.region.as_str()).ok_or_else(|| {
        Error::new(
            Kind::Failed,
            "The API doesn't say FF's region, which a template's ARNs name: it is older than this ff",
        )
    })?;
    let place = Place { stack: &stack_name, region, account: &account.id };
    let last: Option<Stack> = client.json_if_any(&Call::get(format!("/stacks/{stack_name}")))?;
    let last_resources = last.as_ref().map(|stack| stack.resources.as_slice()).unwrap_or_default();

    // Every problem before any change: the template's, its parameters', then what the account has.
    let values = parameters::values(&template, &given_values(&template, last.as_ref(), given));
    let mut problems = Problems { file: file.clone(), template: &template, found: Vec::new() };
    let parameter_line = |name: &str| template.line(&format!("/Parameters/{name}"));
    // What is outside FF's subset is refused too, which `ff doctor` warns of since AWS takes it.
    for problem in subset::check(&template, &values.values) {
        problems.line(problem.line, &problem.message);
    }
    for (name, why) in &values.refused {
        problems.line(parameter_line(name), &format!("the parameter {name}: {why}, which CloudFormation refuses"));
    }
    for name in &values.missing {
        problems.line(
            parameter_line(name),
            &format!("the parameter {name} has no Default and no value: give one with --parameter-overrides {name}=…, or in {SAMCONFIG}"),
        );
    }
    for name in &values.unknown {
        context.out.warn(&format!("{from} gives {name}, which the template has no parameter for: ff deploy passes it over, as `sam deploy` does"));
    }
    let functions_in_template = template
        .value
        .get("Resources")
        .and_then(Value::as_object)
        .map_or(0, |resources| resources.values().filter(|resource| resource["Type"] == FUNCTION).count());
    let mut suffixes = suffixes(functions_in_template)?;
    let planned = plan::plan(&template, &values.values, &place, last_resources, &at.folder, &mut || {
        suffixes.pop().unwrap_or_default()
    });
    let deployment = match planned {
        Ok(deployment) => deployment,
        Err(found) => {
            for (pointer, message) in found {
                problems.at(&pointer, &message);
            }
            return problems.refusal();
        }
    };
    problems.refusal()?;
    let mut problems = Problems { file: file.clone(), template: &template, found: Vec::new() };

    let ours = |name: &str| {
        last_resources.iter().any(|resource| resource.kind == FUNCTION && resource.physical_id.as_deref() == Some(name))
    };
    let mut existing = Vec::new();
    for function in &deployment.functions {
        let found = find(&client, &function.name)?;
        let id = &function.id;
        let name = &function.name;
        match &found {
            Some(other) if !ours(name.as_str()) => {
                let answer: Function = client.json(&Call::get(format!("/functions/{}", other.id)))?;
                let whose = match &answer.stack {
                    Some(stack) => format!("the stack {stack}'s"),
                    None => "the account's, in no stack".to_owned(),
                };
                problems.at(
                    &format!("/Resources/{id}"),
                    &format!(
                        "{id}: the function {name} is {whose}: ff deploy doesn't take it over; give {id} another FunctionName, \
                         or delete that function with `ff delete {name}`"
                    ),
                );
            }
            Some(kept) => {
                let secrets: Secrets = client.json(&Call::get(format!("/functions/{}/secrets", kept.id)))?;
                for secret in secrets.secrets.iter().filter(|secret| function.environment.contains_key(&secret.name)) {
                    let variable = &secret.name;
                    problems.at(
                        &format!("/Resources/{id}/Properties/Environment/Variables/{variable}"),
                        &format!(
                            "{id}: {variable} is a secret of {name}'s, which stays with `ff secrets`, out of the template: \
                             remove the variable, or the secret with `ff secrets unset {name} {variable}`"
                        ),
                    );
                }
            }
            None => {}
        }
        existing.push(found);
    }
    let next = deployment.resources();
    let removed = plan::removed(last_resources, &next);
    let (built, indexes) = packages(&deployment.functions, &at, args, &mut problems, context)?;
    problems.refusal()?;
    if !removed.is_empty()
        && !confirmed(
            "ff deploy",
            &format!(
                "The template no longer has what the stack {stack_name} made: {}. Delete it as the deploy goes?",
                listed(&removed)
            ),
            args.yes,
        )?
    {
        return context
            .out
            .result(&json!({ "stack": stack_name, "deployed": false }), || "Nothing deployed".to_owned());
    }

    // What the stack has that is still there: its record as the deploy goes starts from it.
    let mut still_there = BTreeSet::new();
    let named = last_resources.iter().filter(|resource| resource.physical_id.is_some()).map(plan::function_of);
    for name in named.collect::<BTreeSet<_>>() {
        if deployment.functions.iter().any(|function| function.name == name) || find(&client, name)?.is_some() {
            still_there.insert(name.to_owned());
        }
    }
    let template_sha256 = sha256_hex(text.as_bytes());
    let parameters = kept_values(&template, &values.values);
    let mut record = Record {
        client: &client,
        name: &stack_name,
        template_sha256: last.as_ref().map_or_else(|| template_sha256.clone(), |stack| stack.template_sha256.clone()),
        parameters: last.as_ref().map_or_else(|| parameters.clone(), |stack| stack.parameters.clone()),
        resources: last_resources
            .iter()
            .filter(|resource| resource.physical_id.is_none() || still_there.contains(plan::function_of(resource)))
            .cloned()
            .collect(),
    };
    if last.is_none() {
        // Made first, empty: a stack the account can't have more of changes nothing.
        record.save()?;
    }

    let started = Instant::now();
    let mut made = BTreeMap::new();
    let mut deployed = Vec::new();
    for ((function, existing), index) in deployment.functions.iter().zip(existing).zip(indexes) {
        let function_started = Instant::now();
        let new = existing.is_none();
        let package = &built[index];
        let wanted = Wanted {
            code: Code::Package(&package.code_sha256),
            handler: Some(&function.handler),
            runtime: function.runtime,
            memory: Some(function.memory),
            timeout: Some(function.timeout),
            description: Some(&function.description),
            dead_letter: Some(function.dead_letter.as_deref()),
        };
        let deploy = Deploy {
            name: function.name.clone(),
            wanted,
            environment: Some(function.environment.clone()),
            tags: Some(&function.tags),
            package: Some(package),
            source: &function.code,
        };
        let mut uploaded = false;
        let applied = deploy::apply(&client, context, &deploy, existing, &mut uploaded);
        let resources = function.resources();
        let own = &resources[..1];
        let (action, mut changed, answer) = match applied {
            Ok(applied) => applied,
            Err(error) => {
                // A function made that didn't start is the stack's all the same: the next deploy updates it.
                if new && error.details.as_ref().and_then(|details| details.get("functionId")).is_some() {
                    record.keep(own);
                    if let Err(unsaved) = record.save() {
                        context.out.warn(&format!(
                            "The stack {stack_name} doesn't have {} yet: {}",
                            function.name, unsaved.message
                        ));
                    }
                }
                return Err(error);
            }
        };
        if new {
            record.keep(own);
            record.save()?;
        }
        let (min, max) = function.instances();
        let answer = if (answer.min_instances, answer.max_instances) == (min, max) {
            answer
        } else {
            changed.push("instances");
            deploy::set_instances(&client, answer, Some(min), Some(max))?
        };
        let published =
            deploy::publish_deployed(&client, &answer, function.alias.is_some(), function.alias.as_deref())?;
        let url = match &function.url {
            Some(wanted) => {
                let (url, url_changed) = ensure_url(&client, &answer, function.alias.as_deref(), wanted)?;
                if url_changed {
                    changed.push("URL");
                }
                Some(url.function_url)
            }
            None => None,
        };
        if let Some(config) = &function.event_invoke_config
            && ensure_event_invoke_config(&client, &answer, config)?
        {
            changed.push("asynchronous calls");
        }
        record.keep(&resources);
        let version = published.map(|published| published.version.version);
        made.insert(
            function.id.clone(),
            Made {
                name: function.name.clone(),
                alias: function.alias.clone(),
                url: url.clone(),
                version: version.clone(),
            },
        );
        let action = if action == "unchanged" && !changed.is_empty() { "updated" } else { action };
        deployed.push(FunctionDeployed {
            logical_id: function.id.clone(),
            name: function.name.clone(),
            action,
            changed,
            seconds: deploy::seconds_since(function_started),
            version,
            url,
        });
    }
    for resource in &removed {
        delete_resource(&client, resource)?;
    }
    Record { template_sha256, parameters, resources: next, ..record }.save()?;

    let known = Known { place: &place, values: &values.values, functions: made };
    let outputs = plan::outputs(&template, &known);
    let seconds = deploy::seconds_since(started);
    let document = StackDeployed { stack: stack_name.clone(), functions: deployed, deleted: removed, outputs };
    context.out.result(&document, || {
        let mut lines = vec![format!("{stack_name}: deployed in {seconds} s")];
        for function in &document.functions {
            let changed = match function.action {
                "updated" => format!(", changed: {}", function.changed.join(", ")),
                _ => String::new(),
            };
            let version = function.version.as_deref().map(|version| format!(", version {version}")).unwrap_or_default();
            lines.push(format!("{} {} ({}){changed}{version}", function.action, function.name, function.logical_id));
        }
        lines.extend(document.deleted.iter().map(|resource| format!("deleted {}", plan::in_words(resource))));
        if !document.outputs.is_empty() {
            lines.push("outputs:".to_owned());
            for output in &document.outputs {
                let value = output.value.as_str().map_or_else(|| output.value.to_string(), str::to_owned);
                lines.push(format!("  {}: {value}", output.name));
            }
        }
        lines.join("\n")
    })
}

/// `ff delete-stack`: what the stack made deleted, then the stack. With no name, the one samconfig.toml names here.
pub fn delete_stack(name: Option<&str>, yes: bool, context: &Context) -> Result<(), Error> {
    let name = match name {
        Some(name) => name.to_owned(),
        None => samconfig(Path::new("."))?.and_then(|config| config.stack_name).ok_or_else(|| {
            Error::usage(format!("Name the stack: ff delete-stack <name>, or run it where {SAMCONFIG} names it"))
        })?,
    };
    let client = Client::new(&context.settings()?)?;
    let stack: Stack = client.json(&Call::get(format!("/stacks/{name}")))?;
    let doomed = plan::removed(&stack.resources, &[]);
    let question = match doomed.len() {
        0 => format!("Delete the stack {name}? It made nothing that is still there"),
        _ => format!("Delete the stack {name} and what it made: {}?", listed(&doomed)),
    };
    if !confirmed("ff delete-stack", &question, yes)? {
        return context.out.result(&json!({ "deleted": false, "stack": name }), || "Nothing deleted".to_owned());
    }
    for resource in &doomed {
        delete_resource(&client, resource)?;
    }
    client.done(&Call::delete(format!("/stacks/{name}")))?;
    context.out.result(&json!({ "deleted": true, "stack": name, "resources": doomed }), || {
        let mut lines: Vec<String> =
            doomed.iter().map(|resource| format!("deleted {}", plan::in_words(resource))).collect();
        lines.push(format!("deleted the stack {name}"));
        lines.join("\n")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template(text: &str) -> Template {
        sam::read(text).unwrap()
    }

    #[test]
    fn a_stacks_name_is_cloudformations() {
        assert!(is_stack_name("shop-prod2"));
        for refused in ["", "2shop", "shop_prod", "shop.prod", &"s".repeat(129)] {
            assert!(!is_stack_name(refused), "{refused}");
        }
    }

    #[test]
    fn sam_builds_template_names_its_built_folders_and_its_project_is_two_folders_up() {
        let built = Location::of(Path::new("app/.aws-sam/build/template.yaml"));
        assert_eq!((built.folder, built.project, built.built), ("app/.aws-sam/build".into(), "app".into(), true));
        let here = Location::of(Path::new(".aws-sam/build/template.yaml"));
        assert_eq!((here.project, here.built), (".".into(), true));
        let source = Location::of(Path::new("template.yaml"));
        assert_eq!((source.folder, source.project, source.built), (".".into(), ".".into(), false));
    }

    #[test]
    fn a_parameter_not_given_keeps_the_stacks_last_value_and_a_noecho_ones_isnt_kept() {
        let template = template(
            "Parameters:\n  Stage:\n    Type: String\n  Zones:\n    Type: CommaDelimitedList\n  Token:\n    Type: String\n    NoEcho: true\nResources: {}\n",
        );
        let last = Stack {
            name: "shop".into(),
            template_sha256: "a".repeat(64),
            parameters: [("Stage", "prod"), ("Zones", "a,b"), ("Gone", "x")]
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .into(),
            resources: Vec::new(),
        };

        let given =
            given_values(&template, Some(&last), vec![("Stage".into(), "test".into()), ("Token".into(), "t".into())]);
        let values = parameters::values(&template, &given);

        assert_eq!(values.values["Stage"], "test");
        assert_eq!(values.values["Zones"], json!(["a", "b"]));
        assert_eq!(values.unknown, Vec::<String>::new());
        assert_eq!(
            kept_values(&template, &values.values),
            [("Stage", "test"), ("Zones", "a,b")].map(|(name, value)| (name.to_owned(), value.to_owned())).into()
        );
    }

    #[test]
    fn a_url_is_as_wanted_with_its_cors_fields_left_out_empty_and_the_settings_compared_by_lambdas_fields() {
        let url = |auth: &str, cors: Option<Value>| FunctionUrl {
            function_url: "https://o.example.tn/".into(),
            alias: None,
            auth_type: auth.into(),
            cors,
            invoke_mode: None,
            created_at: "2026-11-03T10:00:00Z".into(),
        };
        let wanted = plan::Url { auth_type: "NONE".into(), cors: Some(json!({ "allowOrigins": ["https://shop.tn"] })) };

        assert!(url_as_wanted(
            &url(
                "NONE",
                Some(json!({ "allowOrigins": ["https://shop.tn"], "allowCredentials": false, "exposeHeaders": [] }))
            ),
            &wanted
        ));
        assert!(!url_as_wanted(&url("AWS_IAM", Some(json!({ "allowOrigins": ["https://shop.tn"] }))), &wanted));
        assert!(!url_as_wanted(&url("NONE", None), &wanted));
        assert!(url_as_wanted(&url("NONE", None), &plan::Url { auth_type: "NONE".into(), cors: None }));

        let answered = json!({ "functionArn": "arn", "maximumRetryAttempts": 1, "maximumEventAgeInSeconds": null, "destinationConfig": { "onSuccess": null, "onFailure": { "destination": "arn:q" } }, "lastModified": "t" });
        assert_eq!(
            event_invoke_fields(&answered),
            json!({ "maximumRetryAttempts": 1, "destinationConfig": { "onFailure": { "destination": "arn:q" } } })
        );
    }

    #[test]
    fn a_functions_flags_are_refused_for_a_template_and_a_stacks_for_a_function() {
        use clap::Parser;
        let args = |line: &[&str]| match crate::cli::Cli::parse_from([&["ff", "deploy"][..], line].concat()).command {
            crate::cli::Command::Deploy(args) => args,
            _ => unreachable!(),
        };
        assert_eq!(function_flags(&args(&["template.yaml", "--memory", "256", "--env", "A=b"])), ["--memory", "--env"]);
        assert!(stack_flags(&args(&["function.ts", "--stack-name", "shop"])).is_err());
        assert!(stack_flags(&args(&["function.ts"])).is_ok());
    }
}
