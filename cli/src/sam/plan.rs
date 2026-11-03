//! A template's functions as `ff deploy` makes them (ADR 0016): each one's name, code and settings, read from its
//! properties with the Globals merged and the intrinsics resolved; the resources the stack keeps for each; what a deploy
//! deletes of the stack's last; and the template's outputs once FF knows what they name.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::Template;
use super::resolve::{self, FUNCTION};
use crate::api::types::{DEFAULT_MAX_INSTANCES, StackResource};
use crate::cli::Runtime;
use crate::config::is_function_name;

/// The resources SAM makes of a function that a stack keeps, by their CloudFormation types.
pub const URL: &str = "AWS::Lambda::Url";
pub const ALIAS: &str = "AWS::Lambda::Alias";
pub const EVENT_INVOKE_CONFIG: &str = "AWS::Lambda::EventInvokeConfig";
/// Kept without effect: on FF a function's URL and its account's buckets and queues call it with no permission.
pub const PERMISSION: &str = "AWS::Lambda::Permission";

/// Lambda's defaults, which a template's functions get, as on AWS.
const DEFAULT_MEMORY: u32 = 128;
const DEFAULT_TIMEOUT: u32 = 3;
/// What a random suffix of a name CloudFormation makes holds, and how long it is.
const SUFFIX_CHARACTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
pub const SUFFIX_LENGTH: usize = 12;

/// What the deploy is for: the stack, FF's region and the account, which the pseudo parameters and the ARNs give.
pub struct Place<'a> {
    pub stack: &'a str,
    pub region: &'a str,
    pub account: &'a str,
}

impl Place<'_> {
    /// A function's ARN, qualified by a version or an alias after a colon when one is given.
    pub fn arn(&self, name: &str) -> String {
        format!("arn:aws:lambda:{}:{}:function:{name}", self.region, self.account)
    }
}

/// A function's URL as its FunctionUrlConfig asks: who may call it, and its CORS as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Url {
    pub auth_type: String,
    pub cors: Option<Value>,
}

/// A function of the template, as FF makes it.
#[derive(Debug, PartialEq)]
pub struct Function {
    pub id: String,
    pub name: String,
    /// Its CodeUri, from the template's folder: a folder, or a .zip.
    pub code: PathBuf,
    pub runtime: Runtime,
    pub handler: String,
    pub memory: u32,
    pub timeout: u32,
    pub description: String,
    pub environment: BTreeMap<String, String>,
    pub tags: BTreeMap<String, String>,
    /// ReservedConcurrentExecutions: the most instances it runs.
    pub reserved: Option<u32>,
    /// ProvisionedConcurrencyConfig's: the instances it keeps running.
    pub provisioned: Option<u32>,
    /// AutoPublishAlias: a version published at each deploy, and this alias pointed at it.
    pub alias: Option<String>,
    pub url: Option<Url>,
    /// EventInvokeConfig, as FF's API takes it.
    pub event_invoke_config: Option<Value>,
    /// DeadLetterQueue's TargetArn.
    pub dead_letter: Option<String>,
}

impl Function {
    /// `orders`, or `orders:live` with an alias, which SAM gives the URL and the asynchronous settings of.
    pub fn qualified(&self) -> String {
        match &self.alias {
            Some(alias) => format!("{}:{alias}", self.name),
            None => self.name.clone(),
        }
    }

    /// The instances it keeps running and the most it runs: the template's, else none kept and FF's default most.
    pub fn instances(&self) -> (u32, u32) {
        let min = self.provisioned.unwrap_or(0);
        (min, self.reserved.unwrap_or(DEFAULT_MAX_INSTANCES.max(min)))
    }

    /// The resources the stack keeps of it, named as SAM names them: the function, its URL, its alias and its
    /// asynchronous calls' settings.
    pub fn resources(&self) -> Vec<StackResource> {
        let resource = |logical_id: String, kind: &str, physical_id: String| StackResource {
            logical_id,
            kind: kind.to_owned(),
            physical_id: Some(physical_id),
        };
        let id = &self.id;
        let mut resources = vec![resource(id.clone(), FUNCTION, self.name.clone())];
        if self.url.is_some() {
            resources.push(resource(format!("{id}Url"), URL, self.qualified()));
        }
        if let Some(alias) = &self.alias {
            resources.push(resource(alias_id(id, alias), ALIAS, self.qualified()));
        }
        if self.event_invoke_config.is_some() {
            resources.push(resource(format!("{id}EventInvokeConfig"), EVENT_INVOKE_CONFIG, self.name.clone()));
        }
        resources
    }
}

/// The logical ID SAM gives a function's alias: the function's, `Alias`, and the alias's letters and digits, as a
/// logical ID holds no other character.
pub fn alias_id(function: &str, alias: &str) -> String {
    let alias: String = alias.chars().filter(char::is_ascii_alphanumeric).collect();
    format!("{function}Alias{alias}")
}

/// The template's functions, in its order, and the permissions it has, which FF keeps without effect.
#[derive(Debug)]
pub struct Plan {
    pub functions: Vec<Function>,
    pub permissions: Vec<String>,
}

impl Plan {
    /// What the stack keeps once the deploy is done.
    pub fn resources(&self) -> Vec<StackResource> {
        let permissions = self.permissions.iter().map(|id| StackResource {
            logical_id: id.clone(),
            kind: PERMISSION.to_owned(),
            physical_id: None,
        });
        self.functions.iter().flat_map(Function::resources).chain(permissions).collect()
    }
}

/// What a value of the template can't be, at its JSON pointer.
pub type Problems = Vec<(String, String)>;

/// A name CloudFormation's way: the stack's, the logical ID's and a random suffix, each cut so that the whole is within
/// Lambda's 64 characters, the logical ID keeping half of what is left at least.
pub fn generated_name(stack: &str, id: &str, suffix: &str) -> String {
    let room = 64 - suffix.len() - 2;
    let id_part = &id[..id.len().min((room / 2).max(room.saturating_sub(stack.len())))];
    let stack_part = &stack[..stack.len().min(room - id_part.len())];
    format!("{stack_part}-{id_part}-{suffix}")
}

/// The subset's resources and events that `ff deploy` doesn't make yet: what is outside the subset its check refuses.
const RESOURCES_NEXT: [&str; 4] =
    ["AWS::SQS::Queue", "AWS::SQS::QueuePolicy", "AWS::S3::Bucket", "AWS::S3::BucketPolicy"];
const EVENTS_NEXT: [&str; 5] = ["Schedule", "ScheduleV2", "SQS", "S3", "HttpApi"];

/// A random suffix for a name, from 12 random bytes, letters and digits as CloudFormation's.
pub fn suffix(random: &[u8; SUFFIX_LENGTH]) -> String {
    random.iter().map(|byte| SUFFIX_CHARACTERS[usize::from(*byte) % SUFFIX_CHARACTERS.len()] as char).collect()
}

/// What FF knows of the template's names: the parameters' values, the pseudo parameters, each function's name, its
/// ARN and its alias's; after the deploy, its URL and the version it published.
pub struct Known<'a> {
    pub place: &'a Place<'a>,
    pub values: &'a BTreeMap<String, Value>,
    pub functions: BTreeMap<String, Made>,
}

/// What a function of the template is on FF.
#[derive(Clone, Debug, Default)]
pub struct Made {
    pub name: String,
    pub alias: Option<String>,
    pub url: Option<String>,
    pub version: Option<String>,
}

impl Known<'_> {
    /// What `Ref name`, or with an attribute `Fn::GetAtt name.attribute`, gives, if FF knows it.
    pub fn get(&self, name: &str, attribute: Option<&str>) -> Option<Value> {
        let place = self.place;
        if attribute.is_none() {
            if let Some(value) = self.values.get(name) {
                return Some(value.clone());
            }
            let pseudo = match name {
                "AWS::Region" => Some(place.region),
                "AWS::AccountId" => Some(place.account),
                "AWS::StackName" => Some(place.stack),
                "AWS::Partition" => Some("aws"),
                _ => None,
            };
            if let Some(pseudo) = pseudo {
                return Some(pseudo.into());
            }
        }
        if let Some(made) = self.functions.get(name) {
            return match attribute {
                None => Some(made.name.clone().into()),
                Some("Arn") => Some(place.arn(&made.name).into()),
                Some(_) => None,
            };
        }
        // What SAM makes of a function, named after it: the longest function's ID that starts the name.
        let (id, made) =
            self.functions.iter().filter(|(id, _)| name.starts_with(id.as_str())).max_by_key(|(id, _)| id.len())?;
        let qualified = |qualifier: &str| place.arn(&format!("{}:{qualifier}", made.name));
        let alias_arn = || made.alias.as_deref().map(|alias| Value::from(qualified(alias)));
        match (&name[id.len()..], attribute) {
            ("Url", Some("FunctionUrl")) => made.url.clone().map(Value::from),
            ("Url", None | Some("FunctionArn")) => {
                Some(made.alias.as_deref().map(qualified).unwrap_or_else(|| place.arn(&made.name)).into())
            }
            (".Alias", None) => alias_arn(),
            (".Version", None) => made.version.as_deref().map(|version| Value::from(qualified(version))),
            (_, None) if made.alias.as_deref().is_some_and(|alias| alias_id(id, alias) == name) => alias_arn(),
            _ => None,
        }
    }

    /// The value with each intrinsic FF knows resolved.
    pub fn resolve(&self, value: &Value) -> Value {
        resolve::resolve(value, &|name, attribute| self.get(name, attribute))
    }
}

/// The text of a scalar, as CloudFormation takes one where it wants text: a number's or a boolean's written out.
fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// A whole number, as CloudFormation takes one: a number, or a string of one.
fn whole(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// What an unresolved value is, for a message: the intrinsic FF couldn't resolve.
fn unresolved(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => match resolve::intrinsic(map) {
            Some((function, args)) => Some(format!("{function} {args}")),
            None => map.values().find_map(unresolved),
        },
        Value::Array(items) => items.iter().find_map(unresolved),
        _ => None,
    }
}

/// A function's properties, read with the problems found, each at its pointer.
struct Reading<'a> {
    id: &'a str,
    properties: &'a Map<String, Value>,
    pointer: String,
    problems: Problems,
}

impl Reading<'_> {
    fn problem(&mut self, path: &str, message: String) {
        self.problems.push((format!("{}/{path}", self.pointer), format!("{}: {message}", self.id)));
    }

    /// The value at a path of the properties, `/` apart, once FF knows it all; else none, the problem said.
    fn known(&mut self, path: &str) -> Option<Value> {
        let mut value = self.properties.get(path.split('/').next()?)?;
        for key in path.split('/').skip(1) {
            value = value.get(key)?;
        }
        let value = value.clone();
        match unresolved(&value) {
            Some(what) => {
                let said = path.replace('/', ".");
                self.problem(
                    path,
                    format!("{said} holds {what}, which ff deploy doesn't know before it makes the function"),
                );
                None
            }
            None => Some(value),
        }
    }

    fn text(&mut self, path: &str) -> Option<String> {
        let value = self.known(path)?;
        let found = text(&value);
        if found.is_none() {
            self.problem(path, format!("{} is text, as CloudFormation takes it", path.replace('/', ".")));
        }
        found
    }

    /// A whole number within bounds, saying them otherwise.
    fn number(&mut self, path: &str, least: i64, most: i64, unit: &str) -> Option<u32> {
        let value = self.known(path)?;
        match whole(&value).filter(|number| (least..=most).contains(number)) {
            Some(number) => u32::try_from(number).ok(),
            None => {
                let said = path.replace('/', ".");
                self.problem(path, format!("{said} {value}: a whole number of {unit} from {least} to {most}"));
                None
            }
        }
    }

    /// A mapping of text by name, as Environment's Variables and Tags are, each value written out.
    fn texts(&mut self, path: &str) -> BTreeMap<String, String> {
        let Some(value) = self.known(path) else { return BTreeMap::new() };
        let Some(map) = value.as_object() else {
            self.problem(path, format!("{} is a mapping of names to values", path.replace('/', ".")));
            return BTreeMap::new();
        };
        let mut texts = BTreeMap::new();
        for (name, value) in map {
            match text(value) {
                Some(text) => {
                    texts.insert(name.clone(), text);
                }
                None => self.problem(
                    &format!("{path}/{name}"),
                    format!("{}'s {name} is text, a number or a boolean", path.replace('/', ".")),
                ),
            }
        }
        texts
    }
}

/// FF's runtime of one of the subset's Lambda runtimes.
fn runtime(lambda: &str) -> Option<Runtime> {
    [Runtime::Nodejs, Runtime::Python].into_iter().find(|runtime| runtime.lambda() == lambda)
}

/// Lambda's rule for an alias's name: letters, digits, hyphens and underscores, 128 at most, not digits alone.
fn is_alias_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && !name.bytes().all(|byte| byte.is_ascii_digit())
}

/// FunctionUrlConfig's Cors as FF's API takes it: Lambda's fields, their first letter lowercase.
fn cors(sent: &Map<String, Value>) -> Value {
    let fields = sent.iter().map(|(field, value)| {
        let mut name = field.clone();
        name[..1].make_ascii_lowercase();
        (name, value.clone())
    });
    Value::Object(fields.collect())
}

/// Whether a CodeUri names code `ff deploy` takes: a folder it packages, or a .zip made elsewhere.
fn is_code(path: &Path) -> bool {
    path.is_dir() || (path.is_file() && path.extension().is_some_and(|extension| extension == "zip"))
}

fn function(reading: &mut Reading, name: String, folder: &Path) -> Option<Function> {
    let code = reading.text("CodeUri");
    if let Some(given) = &code
        && !is_code(&folder.join(given))
    {
        reading.problem("CodeUri", format!("CodeUri {given}: there is no folder or .zip there"));
    }
    let runtime = reading.text("Runtime").and_then(|lambda| runtime(&lambda));
    let handler = reading.text("Handler");
    let memory = match reading.properties.contains_key("MemorySize") {
        true => reading.number("MemorySize", 128, 10_240, "MB"),
        false => Some(DEFAULT_MEMORY),
    };
    let timeout = match reading.properties.contains_key("Timeout") {
        true => reading.number("Timeout", 1, 900, "seconds"),
        false => Some(DEFAULT_TIMEOUT),
    };
    let description = if reading.properties.contains_key("Description") { reading.text("Description") } else { None };
    let environment = if reading.properties.contains_key("Environment") {
        reading.texts("Environment/Variables")
    } else {
        BTreeMap::new()
    };
    let tags = if reading.properties.contains_key("Tags") { reading.texts("Tags") } else { BTreeMap::new() };
    let reserved = match reading.known("ReservedConcurrentExecutions") {
        Some(value) if whole(&value) == Some(0) => {
            reading.problem(
                "ReservedConcurrentExecutions",
                "ReservedConcurrentExecutions 0 stops every call, which ff deploy doesn't do: Lambda's \
                 PutFunctionConcurrency at FF's endpoint does"
                    .to_owned(),
            );
            None
        }
        Some(_) => reading.number("ReservedConcurrentExecutions", 1, 1000, "instances"),
        None => None,
    };
    let alias = reading.properties.contains_key("AutoPublishAlias").then(|| reading.text("AutoPublishAlias")).flatten();
    if let Some(alias) = alias.as_deref().filter(|alias| !is_alias_name(alias)) {
        reading.problem(
            "AutoPublishAlias",
            format!("AutoPublishAlias {alias}: an alias's name is letters, digits, hyphens and underscores, not digits alone"),
        );
    }
    let provisioned = match reading.properties.contains_key("ProvisionedConcurrencyConfig") {
        true if alias.is_none() => {
            let message = "ProvisionedConcurrencyConfig needs AutoPublishAlias, as SAM's does: its alias is kept warm";
            reading.problem("ProvisionedConcurrencyConfig", message.to_owned());
            None
        }
        true => reading.number("ProvisionedConcurrencyConfig/ProvisionedConcurrentExecutions", 0, 1000, "instances"),
        false => None,
    };
    let url = match reading.known("FunctionUrlConfig") {
        Some(config) => {
            let auth_type =
                config.get("AuthType").and_then(Value::as_str).filter(|auth| ["NONE", "AWS_IAM"].contains(auth));
            if auth_type.is_none() {
                reading.problem(
                    "FunctionUrlConfig",
                    "FunctionUrlConfig's AuthType is NONE or AWS_IAM, as Lambda's".to_owned(),
                );
            }
            let cors = config.get("Cors").and_then(Value::as_object).map(cors);
            auth_type.map(|auth_type| Url { auth_type: auth_type.to_owned(), cors })
        }
        None => None,
    };
    let event_invoke_config = reading.known("EventInvokeConfig").map(|config| event_invoke_config(reading, &config));
    let dead_letter = match reading.properties.contains_key("DeadLetterQueue") {
        true => reading.text("DeadLetterQueue/TargetArn"),
        false => None,
    };
    Some(Function {
        id: reading.id.to_owned(),
        name,
        code: folder.join(code?),
        runtime: runtime?,
        handler: handler?,
        memory: memory?,
        timeout: timeout?,
        description: description.unwrap_or_default(),
        environment,
        tags,
        reserved,
        provisioned,
        alias,
        url,
        event_invoke_config,
        dead_letter,
    })
}

/// EventInvokeConfig as FF's API takes it, Lambda's fields: a destination by the ARN the template gives.
fn event_invoke_config(reading: &mut Reading, config: &Value) -> Value {
    let mut body = Map::new();
    for (field, name) in
        [("MaximumRetryAttempts", "maximumRetryAttempts"), ("MaximumEventAgeInSeconds", "maximumEventAgeInSeconds")]
    {
        if let Some(value) = config.get(field) {
            body.insert(name.into(), whole(value).map(Value::from).unwrap_or_else(|| value.clone()));
        }
    }
    let mut destinations = Map::new();
    for (field, name) in [("OnSuccess", "onSuccess"), ("OnFailure", "onFailure")] {
        let Some(destination) = config.pointer(&format!("/DestinationConfig/{field}")) else { continue };
        match destination.get("Destination").and_then(Value::as_str) {
            Some(arn) => {
                destinations.insert(name.into(), json!({ "destination": arn }));
            }
            None => reading.problem(
                &format!("EventInvokeConfig/DestinationConfig/{field}"),
                format!(
                    "EventInvokeConfig's {field} names no Destination, for which SAM would make a queue: ff deploy \
                     doesn't, name one of the account's"
                ),
            ),
        }
    }
    if !destinations.is_empty() {
        body.insert("destinationConfig".into(), Value::Object(destinations));
    }
    Value::Object(body)
}

/// Each function's name: its FunctionName, else the one the stack's last deploy gave it, else one CloudFormation's way.
fn names(
    template: &Value,
    functions: &[String],
    known: &Known,
    last: &[StackResource],
    suffix: &mut dyn FnMut() -> String,
    problems: &mut Problems,
) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for id in functions {
        let pointer = format!("/Resources/{id}/Properties/FunctionName");
        let name = match template.pointer(&pointer).map(|value| known.resolve(value)) {
            Some(Value::String(name)) if is_function_name(&name) => name,
            Some(value) => {
                let message = format!(
                    "{id}: FunctionName {}: 1 to 64 letters, digits, hyphens or underscores, as Lambda's, known before the deploy",
                    text(&value).unwrap_or_else(|| value.to_string())
                );
                problems.push((pointer, message));
                continue;
            }
            None => last
                .iter()
                .find(|resource| resource.logical_id == *id && resource.kind == FUNCTION)
                .and_then(|resource| resource.physical_id.clone())
                .unwrap_or_else(|| generated_name(known.place.stack, id, &suffix())),
        };
        if let Some((other, _)) = names.iter().find(|(_, taken)| **taken == name) {
            problems
                .push((pointer, format!("{id}: FunctionName {name} is {other}'s too: a function's name is its own")));
            continue;
        }
        names.insert(id.clone(), name);
    }
    names
}

/// The template's functions as FF makes them, from its folder, its parameters' values and the stack's last deploy; or
/// every problem found, each at its pointer. `suffix` gives a new name's random part.
pub fn plan(
    template: &Template,
    values: &BTreeMap<String, Value>,
    place: &Place,
    last: &[StackResource],
    folder: &Path,
    suffix: &mut dyn FnMut() -> String,
) -> Result<Plan, Problems> {
    let merged = resolve::with_globals(&template.value);
    let resources = merged.get("Resources").and_then(Value::as_object).cloned().unwrap_or_default();
    let of_type = |kind: &str| {
        let mut ids: Vec<String> = resources
            .iter()
            .filter(|(_, resource)| resource.get("Type").and_then(Value::as_str) == Some(kind))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by_key(|id| template.line(&format!("/Resources/{id}")));
        ids
    };
    let (ids, permissions) = (of_type(FUNCTION), of_type(PERMISSION));
    let mut problems = Problems::new();
    for (id, resource) in &resources {
        let kind = resource.get("Type").and_then(Value::as_str).unwrap_or("");
        if RESOURCES_NEXT.contains(&kind) {
            problems.push((
                format!("/Resources/{id}"),
                format!("{id}: ff deploy makes a template's functions so far: its {kind} comes with queues and buckets, next"),
            ));
        }
        let events = resource.pointer("/Properties/Events").and_then(Value::as_object).into_iter().flatten();
        let next = events.filter(|(_, event)| {
            event.get("Type").and_then(Value::as_str).is_some_and(|kind| EVENTS_NEXT.contains(&kind))
        });
        for (name, _) in next {
            problems.push((
                format!("/Resources/{id}/Properties/Events/{name}"),
                format!("{id}: ff deploy makes a template's functions so far: their events, {name} among them, come with queues and buckets, next"),
            ));
        }
    }
    let mut known = Known { place, values, functions: BTreeMap::new() };
    let names = names(&merged, &ids, &known, last, suffix, &mut problems);
    for id in &ids {
        let Some(name) = names.get(id) else { continue };
        let alias = merged
            .pointer(&format!("/Resources/{id}/Properties/AutoPublishAlias"))
            .and_then(|value| text(&known.resolve(value)));
        known.functions.insert(id.clone(), Made { name: name.clone(), alias, ..Made::default() });
    }
    let resolved = known.resolve(&merged);
    let mut functions = Vec::new();
    for id in &ids {
        let Some(name) = names.get(id) else { continue };
        let empty = Map::new();
        let properties =
            resolved.pointer(&format!("/Resources/{id}/Properties")).and_then(Value::as_object).unwrap_or(&empty);
        let mut reading =
            Reading { id, properties, pointer: format!("/Resources/{id}/Properties"), problems: Vec::new() };
        let function = function(&mut reading, name.clone(), folder);
        problems.append(&mut reading.problems);
        functions.extend(function);
    }
    if problems.is_empty() { Ok(Plan { functions, permissions }) } else { Err(problems) }
}

/// What the stack's last deploy made that this one doesn't, by type and FF resource: each to delete, a URL first and a
/// function last, a function's own resources going with it.
pub fn removed(last: &[StackResource], next: &[StackResource]) -> Vec<StackResource> {
    let identity = |resource: &StackResource| Some((resource.kind.clone(), resource.physical_id.clone()?));
    let kept: BTreeSet<(String, String)> = next.iter().filter_map(identity).collect();
    let gone: Vec<&StackResource> =
        last.iter().filter(|resource| identity(resource).is_some_and(|identity| !kept.contains(&identity))).collect();
    let functions_gone: BTreeSet<&str> = gone
        .iter()
        .filter(|resource| resource.kind == FUNCTION)
        .filter_map(|resource| resource.physical_id.as_deref())
        .collect();
    let rank = |kind: &str| [URL, EVENT_INVOKE_CONFIG, ALIAS, FUNCTION].iter().position(|of| *of == kind).unwrap_or(0);
    let mut removed: Vec<StackResource> = gone
        .into_iter()
        .filter(|resource| resource.kind == FUNCTION || !functions_gone.contains(function_of(resource)))
        .cloned()
        .collect();
    removed.sort_by_key(|resource| rank(&resource.kind));
    removed
}

/// The function a resource of the stack belongs to: its physical ID's name, before a version's or an alias's colon.
pub fn function_of(resource: &StackResource) -> &str {
    let id = resource.physical_id.as_deref().unwrap_or("");
    id.split(':').next().unwrap_or(id)
}

/// A resource of the stack in words, for a question and a report: `the function orders (Orders)`.
pub fn in_words(resource: &StackResource) -> String {
    let id = resource.physical_id.as_deref().unwrap_or("");
    let what = match resource.kind.as_str() {
        FUNCTION => format!("the function {id}"),
        URL => format!("{id}'s URL"),
        ALIAS => format!("the alias {id}"),
        EVENT_INVOKE_CONFIG => format!("{id}'s asynchronous calls' settings"),
        other => format!("the {other} {id}"),
    };
    format!("{what} ({})", resource.logical_id)
}

/// A template's output: its name, its value as FF knows it, and its description.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Output {
    pub name: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The template's outputs, in its order, each value resolved by what FF knows once the deploy is done.
pub fn outputs(template: &Template, known: &Known) -> Vec<Output> {
    let Some(outputs) = template.value.get("Outputs").and_then(Value::as_object) else { return Vec::new() };
    let mut names: Vec<&String> = outputs.keys().collect();
    names.sort_by_key(|name| template.line(&format!("/Outputs/{name}")));
    names
        .into_iter()
        .map(|name| {
            let output = &outputs[name];
            Output {
                name: name.clone(),
                value: output.get("Value").map(|value| known.resolve(value)).unwrap_or(Value::Null),
                description: output.get("Description").and_then(text),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sam::read;

    const PLACE: Place = Place { stack: "shop", region: "tn-tunis-1", account: "000000000001" };

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("orders")).unwrap();
        std::fs::write(dir.path().join("reports.zip"), "PK").unwrap();
        dir
    }

    fn planned(text: &str, last: &[StackResource], values: &[(&str, &str)]) -> Result<Plan, Problems> {
        let dir = folder();
        let values: BTreeMap<String, Value> =
            values.iter().map(|(name, value)| (name.to_string(), Value::from(*value))).collect();
        let mut n = 0;
        plan(&read(text).unwrap(), &values, &PLACE, last, dir.path(), &mut || {
            n += 1;
            format!("SUFFIX{n:06}")
        })
        .map(|mut plan| {
            for function in &mut plan.functions {
                function.code = function.code.strip_prefix(dir.path()).unwrap().to_owned();
            }
            plan
        })
    }

    fn resource(logical_id: &str, kind: &str, physical_id: Option<&str>) -> StackResource {
        StackResource { logical_id: logical_id.into(), kind: kind.into(), physical_id: physical_id.map(str::to_owned) }
    }

    const SHOP: &str = "\
Transform: AWS::Serverless-2016-10-31
Parameters:
  Stage:
    Type: String
Globals:
  Function:
    Runtime: nodejs24.x
    Timeout: 10
    Tags:
      app: shop
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: orders
      Handler: index.handler
      MemorySize: '256'
      Description: !Sub Takes ${Stage} orders
      Environment:
        Variables:
          STAGE: !Ref Stage
          REPORTS: !Ref Reports
          RETRIES: 3
      AutoPublishAlias: live
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 1
      FunctionUrlConfig:
        AuthType: NONE
        Cors:
          AllowOrigins: ['https://shop.example.tn']
      EventInvokeConfig:
        MaximumRetryAttempts: 1
        DestinationConfig:
          OnFailure:
            Type: Lambda
            Destination: !GetAtt Reports.Arn
  Reports:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub ${AWS::StackName}-reports
      CodeUri: reports.zip
      Handler: app.handler
      Runtime: python3.13
      ReservedConcurrentExecutions: 5
      DeadLetterQueue:
        Type: SQS
        TargetArn: arn:aws:sqs:tn-tunis-1:000000000001:failed
  AllowAll:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref Orders
      Principal: '*'
Outputs:
  OrdersUrl:
    Description: Where orders go
    Value: !GetAtt OrdersUrl.FunctionUrl
  Live:
    Value: !Ref Orders.Alias
";

    #[test]
    fn reads_each_function_with_its_globals_and_its_values_resolved_named_its_way() {
        let plan = planned(SHOP, &[], &[("Stage", "prod")]).unwrap();

        let [orders, reports] = &plan.functions[..] else { panic!("{plan:?}") };
        assert_eq!(
            orders,
            &Function {
                id: "Orders".into(),
                name: "shop-Orders-SUFFIX000001".into(),
                code: "orders".into(),
                runtime: Runtime::Nodejs,
                handler: "index.handler".into(),
                memory: 256,
                timeout: 10,
                description: "Takes prod orders".into(),
                environment: [("STAGE", "prod"), ("REPORTS", "shop-reports"), ("RETRIES", "3")]
                    .map(|(name, value)| (name.to_owned(), value.to_owned()))
                    .into(),
                tags: [("app".to_owned(), "shop".to_owned())].into(),
                reserved: None,
                provisioned: Some(1),
                alias: Some("live".into()),
                url: Some(Url {
                    auth_type: "NONE".into(),
                    cors: Some(json!({ "allowOrigins": ["https://shop.example.tn"] }))
                }),
                event_invoke_config: Some(json!({
                    "maximumRetryAttempts": 1,
                    "destinationConfig": { "onFailure": { "destination": "arn:aws:lambda:tn-tunis-1:000000000001:function:shop-reports" } }
                })),
                dead_letter: None,
            }
        );
        assert_eq!(
            (reports.name.as_str(), reports.memory, reports.timeout, reports.reserved, reports.dead_letter.as_deref()),
            ("shop-reports", 128, 10, Some(5), Some("arn:aws:sqs:tn-tunis-1:000000000001:failed"))
        );
        assert_eq!((orders.instances(), reports.instances()), ((1, 3), (0, 5)));
        assert_eq!(
            plan.resources(),
            [
                resource("Orders", FUNCTION, Some("shop-Orders-SUFFIX000001")),
                resource("OrdersUrl", URL, Some("shop-Orders-SUFFIX000001:live")),
                resource("OrdersAliaslive", ALIAS, Some("shop-Orders-SUFFIX000001:live")),
                resource("OrdersEventInvokeConfig", EVENT_INVOKE_CONFIG, Some("shop-Orders-SUFFIX000001")),
                resource("Reports", FUNCTION, Some("shop-reports")),
                resource("AllowAll", PERMISSION, None),
            ]
        );
    }

    #[test]
    fn keeps_the_name_the_stacks_last_deploy_gave_a_function_and_cuts_a_new_one_to_lambdas_64() {
        let last = [resource("Orders", FUNCTION, Some("shop-Orders-KEPT00000000"))];

        let plan = planned(SHOP, &last, &[("Stage", "prod")]).unwrap();

        assert_eq!(plan.functions[0].name, "shop-Orders-KEPT00000000");
        let long = generated_name(&"s".repeat(128), "OrdersFunction", "ABCDEFGHIJKL");
        assert_eq!((long.len(), long.ends_with("-OrdersFunction-ABCDEFGHIJKL")), (64, true));
        let both = generated_name("shop-in-tunis-and-sfax-and-sousse", &"F".repeat(40), "ABCDEFGHIJKL");
        assert_eq!(both, format!("shop-in-tunis-and-sfax-an-{}-ABCDEFGHIJKL", "F".repeat(25)));
        assert_eq!(suffix(&[0, 25, 26, 35, 36, 255, 1, 2, 3, 4, 5, 6]), "AZ09ADBCDEFG");
    }

    #[test]
    fn says_every_problem_at_its_pointer_what_ff_cant_know_before_the_deploy_among_them() {
        let template = "\
Transform: AWS::Serverless-2016-10-31
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: orders
      CodeUri: nowhere
      Handler: index.handler
      Runtime: nodejs24.x
      Timeout: 901
      ReservedConcurrentExecutions: 0
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 1
      Environment:
        Variables:
          URL: !GetAtt OrdersUrl.FunctionUrl
      FunctionUrlConfig:
        AuthType: NONE
      EventInvokeConfig:
        DestinationConfig:
          OnFailure:
            Type: SQS
      Events:
        Hourly:
          Type: Schedule
          Properties:
            Schedule: rate(1 hour)
  Twin:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: orders
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
  Queue:
    Type: AWS::SQS::Queue
";
        let problems = planned(template, &[], &[]).unwrap_err();

        let props = "/Resources/Orders/Properties";
        assert_eq!(
            problems,
            [
                (format!("{props}/Events/Hourly"), "Orders: ff deploy makes a template's functions so far: their events, Hourly among them, come with queues and buckets, next".to_owned()),
                ("/Resources/Queue".to_owned(), "Queue: ff deploy makes a template's functions so far: its AWS::SQS::Queue comes with queues and buckets, next".to_owned()),
                ("/Resources/Twin/Properties/FunctionName".to_owned(), "Twin: FunctionName orders is Orders's too: a function's name is its own".to_owned()),
                (format!("{props}/CodeUri"), "Orders: CodeUri nowhere: there is no folder or .zip there".to_owned()),
                (format!("{props}/Timeout"), "Orders: Timeout 901: a whole number of seconds from 1 to 900".to_owned()),
                (format!("{props}/Environment/Variables"), "Orders: Environment.Variables holds Fn::GetAtt [\"OrdersUrl\",\"FunctionUrl\"], which ff deploy doesn't know before it makes the function".to_owned()),
                (format!("{props}/ReservedConcurrentExecutions"), "Orders: ReservedConcurrentExecutions 0 stops every call, which ff deploy doesn't do: Lambda's PutFunctionConcurrency at FF's endpoint does".to_owned()),
                (format!("{props}/ProvisionedConcurrencyConfig"), "Orders: ProvisionedConcurrencyConfig needs AutoPublishAlias, as SAM's does: its alias is kept warm".to_owned()),
                (format!("{props}/EventInvokeConfig/DestinationConfig/OnFailure"), "Orders: EventInvokeConfig's OnFailure names no Destination, for which SAM would make a queue: ff deploy doesn't, name one of the account's".to_owned()),
            ]
        );
    }

    #[test]
    fn deletes_what_the_last_deploy_made_and_this_one_doesnt_a_url_first_a_function_last_with_its_own() {
        let last = [
            resource("Orders", FUNCTION, Some("orders")),
            resource("OrdersUrl", URL, Some("orders")),
            resource("OrdersAliaslive", ALIAS, Some("orders:live")),
            resource("Old", FUNCTION, Some("old")),
            resource("OldUrl", URL, Some("old")),
            resource("Allow", PERMISSION, None),
        ];
        let next = [
            resource("Orders", FUNCTION, Some("orders")),
            resource("OrdersUrl", URL, Some("orders:live")),
            resource("OrdersAliaslive", ALIAS, Some("orders:live")),
        ];

        let removed = removed(&last, &next);

        assert_eq!(removed, [resource("OrdersUrl", URL, Some("orders")), resource("Old", FUNCTION, Some("old"))]);
        assert_eq!(
            removed.iter().map(in_words).collect::<Vec<_>>(),
            ["orders's URL (OrdersUrl)", "the function old (Old)"]
        );
    }

    #[test]
    fn resolves_the_outputs_once_ff_knows_the_urls_and_the_versions() {
        let template = read(SHOP).unwrap();
        let values = [("Stage".to_owned(), Value::from("prod"))].into();
        let made = Made {
            name: "shop-orders".into(),
            alias: Some("live".into()),
            url: Some("https://o.example.tn/".into()),
            version: Some("3".into()),
        };
        let known = Known { place: &PLACE, values: &values, functions: [("Orders".to_owned(), made)].into() };

        assert_eq!(
            outputs(&template, &known),
            [
                Output {
                    name: "OrdersUrl".into(),
                    value: "https://o.example.tn/".into(),
                    description: Some("Where orders go".into())
                },
                Output {
                    name: "Live".into(),
                    value: "arn:aws:lambda:tn-tunis-1:000000000001:function:shop-orders:live".into(),
                    description: None
                },
            ]
        );
        assert_eq!(
            known.get("Orders.Version", None),
            Some("arn:aws:lambda:tn-tunis-1:000000000001:function:shop-orders:3".into())
        );
        assert_eq!(
            known.get("OrdersUrl", Some("FunctionArn")),
            Some("arn:aws:lambda:tn-tunis-1:000000000001:function:shop-orders:live".into())
        );
    }
}
