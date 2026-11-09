//! `ff deploy template.yaml` and `ff delete-stack`: a SAM template's functions and their events made on FF as
//! `sam deploy` makes them on AWS (ADR 0016), and the stack kept in FF's API, what each logical ID made, so that the
//! next deploy changes what the template changed and deletes what it no longer has, after asking, or leaves it in the
//! account when its DeletionPolicy says Retain.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

use super::deploy::{self, Code, Deploy, Wanted};
use super::event_sources::{self, EventSource};
use super::functions::confirmed;
use super::queues;
use super::schedule::{self, Schedule};
use super::secrets::Secrets;
use super::sites;
use super::template::{self, Location, Problems, Read};
use super::url::FunctionUrl;
use super::{Context, account, async_config};
use crate::api::types::{Function, LATEST, Stack, StackResource, find, name_in_arn};
use crate::api::{Call, Client};
use crate::cli::{DeployArgs, Runtime};
use crate::error::{Error, Kind};
use crate::package::{self, Options, Package};
use crate::sam::Template;
use crate::sam::parameters::SAMCONFIG;
use crate::sam::plan::{
    self, ALIAS, BUCKET, EVENT_INVOKE_CONFIG, Known, MAPPING, Made, Place, QUEUE, RULE, SCHEDULE, Target, URL,
};
use crate::sam::resolve::FUNCTION;

/// What a refused deploy says it did.
const NOTHING: &str = "ff deploy changed nothing";

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

/// What the deploy did to one of the template's queues.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueDeployed {
    logical_id: String,
    name: String,
    /// created, updated or unchanged.
    action: &'static str,
    /// Its attributes changed, by FF's API's names, and `tags`.
    changed: Vec<String>,
}

/// What the deploy did to one of the template's buckets.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BucketDeployed {
    logical_id: String,
    name: String,
    /// created, updated or unchanged.
    action: &'static str,
    /// tags, site, notifications.
    changed: Vec<&'static str>,
    /// Its site's address, when it is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    site: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackDeployed {
    stack: String,
    buckets: Vec<BucketDeployed>,
    queues: Vec<QueueDeployed>,
    functions: Vec<FunctionDeployed>,
    deleted: Vec<StackResource>,
    kept: Vec<StackResource>,
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
    let no_echo =
        |name: &str| template.value.pointer(&format!("/Parameters/{name}/NoEcho")).and_then(plan::flag) == Some(true);
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

/// What a schedule or a queue reader runs: the function's alias with AutoPublishAlias, as SAM's events call it; else
/// the function as it is.
fn runs(alias: Option<&str>) -> &str {
    alias.unwrap_or(LATEST)
}

/// The function's schedules as its Schedule and ScheduleV2 events say, by name: made, changed, or kept; and whether
/// any changed. A schedule of the function the template doesn't name stays.
fn ensure_schedules(
    client: &Client,
    function: &Function,
    alias: Option<&str>,
    wanted: &[plan::Schedule],
) -> Result<bool, Error> {
    if wanted.is_empty() {
        return Ok(false);
    }
    let current = schedule::schedules(client, &function.id)?;
    let path = format!("/functions/{}/schedules", function.id);
    let mut changed = false;
    for schedule in wanted {
        let input = schedule.input.clone().unwrap_or(Value::Null);
        let as_wanted = |existing: &Schedule| {
            existing.expression == schedule.expression
                && existing.description == schedule.description
                && existing.input == input
                && existing.enabled == schedule.enabled
                && existing.qualifier.as_deref() == alias
        };
        let body = json!({
            "name": schedule.name,
            "expression": schedule.expression,
            "description": schedule.description,
            "input": input,
            "enabled": schedule.enabled,
            "qualifier": runs(alias),
        });
        let call = match current.iter().find(|existing| existing.name == schedule.name) {
            Some(existing) if as_wanted(existing) => continue,
            Some(existing) => Call::put(format!("{path}/{}", existing.id), body),
            None => Call::post(path.clone(), body),
        };
        client.json::<Schedule>(&call)?;
        changed = true;
    }
    Ok(changed)
}

/// Whether a mapping reads its queue as the SQS event says.
fn mapping_as_wanted(existing: &EventSource, wanted: &plan::Mapping, alias: Option<&str>) -> bool {
    existing.batch_size == wanted.batch_size
        && existing.maximum_batching_window_in_seconds == wanted.batching_window
        && existing.reports_failures() == wanted.report_batch_item_failures
        && existing.scaling_config.as_ref().map(|config| config.maximum_concurrency) == wanted.max_concurrency
        && (existing.state == "Enabled") == wanted.enabled
        // A qualified function's ARN has its version or alias after the name.
        && existing.function_arn.split(':').nth(7) == alias
}

/// The queues the function reads as its SQS events say, each by its ARN: mappings made, changed, or kept; and whether
/// any changed. A mapping of the function the template doesn't name stays.
fn ensure_mappings(
    client: &Client,
    function: &Function,
    alias: Option<&str>,
    wanted: &[plan::Mapping],
) -> Result<bool, Error> {
    if wanted.is_empty() {
        return Ok(false);
    }
    let current = event_sources::of_function(client, &function.id)?;
    let mut changed = false;
    for mapping in wanted {
        let mut body = json!({
            "batchSize": mapping.batch_size,
            "maximumBatchingWindowInSeconds": mapping.batching_window,
            "functionResponseTypes": event_sources::response_types(mapping.report_batch_item_failures),
            "scalingConfig": mapping.max_concurrency.map(|most| json!({ "maximumConcurrency": most })),
            "enabled": mapping.enabled,
            "qualifier": runs(alias),
        });
        let call = match current.iter().find(|existing| existing.event_source_arn == mapping.queue_arn) {
            Some(existing) if mapping_as_wanted(existing, mapping, alias) => continue,
            Some(existing) => Call::patch(format!("/event-sources/{}", existing.uuid), body),
            None => {
                body["eventSourceArn"] = mapping.queue_arn.clone().into();
                Call::post(format!("/functions/{}/event-sources", function.id), body)
            }
        };
        client.json::<EventSource>(&call)?;
        changed = true;
    }
    Ok(changed)
}

/// What the template names that the account has to have, said before any change: each schedule's expression as FF's
/// own parser reads it, each queue a function reads, each dead-letter queue, and each function and queue a bucket
/// tells, but the template's own.
fn check_named(client: &Client, deployment: &plan::Plan, problems: &mut Problems) -> Result<(), Error> {
    let made: BTreeSet<&str> = deployment.queues.iter().map(|queue| queue.name.as_str()).collect();
    let missing = |queue: &str| -> Result<bool, Error> {
        Ok(!made.contains(queue) && client.json_if_any::<Value>(&Call::get(format!("/queues/{queue}")))?.is_none())
    };
    let functions_made: BTreeSet<&str> = deployment.functions.iter().map(|function| function.name.as_str()).collect();
    for bucket in &deployment.buckets {
        for notification in &bucket.notifications {
            let name = notification.destination();
            let (absent, what, makes) = match notification.target {
                Target::Queue => (missing(name)?, "queue", format!("`ff queues create {name}`")),
                Target::Function => (
                    !functions_made.contains(name) && find(client, name)?.is_none(),
                    "function",
                    format!("`ff deploy` of its code as {name}"),
                ),
            };
            if absent {
                problems.at(
                    &notification.at,
                    &format!(
                        "{}: the notification {} tells the {what} {name}, which the account hasn't: a {what} of the \
                         template, or {makes}, makes it",
                        bucket.id, notification.id
                    ),
                );
            }
        }
    }
    for queue in &deployment.queues {
        let Some(dead_letter) = queue.dead_letter() else { continue };
        if missing(dead_letter)? {
            let id = &queue.id;
            problems.at(
                &format!("/Resources/{id}/Properties/RedrivePolicy/deadLetterTargetArn"),
                &format!(
                    "{id}: RedrivePolicy's dead-letter queue {dead_letter}, which the account hasn't: a queue of \
                     the template, or `ff queues create {dead_letter}`, makes it"
                ),
            );
        }
    }
    for function in &deployment.functions {
        let id = &function.id;
        for schedule in &function.schedules {
            let key = plan::expression_key(schedule.kind);
            match schedule::next_runs(client, &schedule.expression) {
                Err(error) if error.status == Some(400) => problems.at(
                    &format!("/Resources/{id}/Properties/Events/{}/Properties/{key}", schedule.event),
                    &format!("{id}: event {}'s {key} {}: {}", schedule.event, schedule.expression, error.message),
                ),
                done => {
                    done?;
                }
            }
        }
        for mapping in &function.mappings {
            let queue = mapping.queue();
            if missing(queue)? {
                problems.at(
                    &format!("/Resources/{id}/Properties/Events/{}/Properties/Queue", mapping.event),
                    &format!(
                        "{id}: event {} reads the queue {queue}, which the account hasn't: `ff queues create {queue}` \
                         makes it",
                        mapping.event
                    ),
                );
            }
        }
    }
    Ok(())
}

/// What of a queue differs from the template's, as a change's body: each attribute, by FF's API's names, and its tags.
fn queue_changes(existing: &queues::Queue, wanted: &plan::Queue) -> Value {
    let current = serde_json::to_value(existing).unwrap_or_default();
    let mut changes = serde_json::Map::new();
    for (field, value) in wanted.attributes.as_object().into_iter().flatten() {
        if current.get(field) != Some(value) {
            changes.insert(field.clone(), value.clone());
        }
    }
    if existing.tags.clone().unwrap_or_default() != wanted.tags {
        changes.insert("tags".into(), json!(wanted.tags));
    }
    Value::Object(changes)
}

/// The queue as the template says: made with its attributes and tags, or what differs of them changed.
fn ensure_queue(
    client: &Client,
    queue: &plan::Queue,
    existing: Option<&queues::Queue>,
) -> Result<QueueDeployed, Error> {
    let deployed =
        |action, changed| QueueDeployed { logical_id: queue.id.clone(), name: queue.name.clone(), action, changed };
    let Some(existing) = existing else {
        let mut body = queue.attributes.as_object().cloned().unwrap_or_default();
        // A new queue has no redrive policy unless it is given one.
        body.retain(|_, value| !value.is_null());
        body.insert("name".into(), queue.name.clone().into());
        if !queue.tags.is_empty() {
            body.insert("tags".into(), json!(queue.tags));
        }
        client.json::<Value>(&Call::post("/queues", Value::Object(body)))?;
        return Ok(deployed("created", Vec::new()));
    };
    let changes = queue_changes(existing, queue);
    let changed: Vec<String> = changes.as_object().map(|changes| changes.keys().cloned().collect()).unwrap_or_default();
    if changed.is_empty() {
        return Ok(deployed("unchanged", changed));
    }
    client.json::<Value>(&Call::patch(format!("/queues/{}", queue.name), changes))?;
    Ok(deployed("updated", changed))
}

/// The bucket as the template says: made with its tags, or its tags replaced when they differ; and its site.
fn ensure_bucket(client: &Client, bucket: &plan::Bucket, existing: Option<&Value>) -> Result<BucketDeployed, Error> {
    let mut changed = Vec::new();
    let action = match existing {
        None => {
            let mut body = json!({ "name": bucket.name });
            if !bucket.tags.is_empty() {
                body["tags"] = json!(bucket.tags);
            }
            client.json::<Value>(&Call::post("/buckets", body))?;
            "created"
        }
        Some(existing) => {
            let tags: BTreeMap<String, String> = serde_json::from_value(existing["tags"].clone()).unwrap_or_default();
            if tags != bucket.tags {
                client
                    .json::<Value>(&Call::patch(format!("/buckets/{}", bucket.name), json!({ "tags": bucket.tags })))?;
                changed.push("tags");
            }
            "unchanged"
        }
    };
    let website = bucket.website.as_ref().map(|site| (site.index_document.as_str(), site.error_document.as_deref()));
    let (site, site_changed) = sites::ensure(client, &bucket.name, website)?;
    if site_changed && existing.is_some() {
        changed.push("site");
    }
    let action = if action == "unchanged" && !changed.is_empty() { "updated" } else { action };
    Ok(BucketDeployed { logical_id: bucket.id.clone(), name: bucket.name.clone(), action, changed, site })
}

/// The bucket's notifications as the template says, put whole when they differ from the bucket's: once its functions
/// are made, which FF's API wants there. Whether they did.
fn ensure_notifications(client: &Client, bucket: &plan::Bucket) -> Result<bool, Error> {
    let path = format!("/buckets/{}/notifications", bucket.name);
    let wanted = bucket.notification_configuration();
    if client.json::<Value>(&Call::get(path.clone()))? == wanted {
        return Ok(false);
    }
    client.json::<Value>(&Call::put(path, wanted))?;
    Ok(true)
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

/// What a resource of the stack is or is of, by name: a function, a queue or a bucket.
#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
enum Owner<'a> {
    Function(&'a str),
    Queue(&'a str),
    Bucket(&'a str),
}

fn owner(resource: &StackResource) -> Owner<'_> {
    let name = plan::function_of(resource);
    match resource.kind.as_str() {
        QUEUE => Owner::Queue(name),
        BUCKET => Owner::Bucket(name),
        _ => Owner::Function(name),
    }
}

/// Deletes what a resource of the stack made, unless it is gone already: a queue, a bucket that is empty, as
/// CloudFormation deletes one, or what is a function's.
fn delete_resource(client: &Client, resource: &StackResource) -> Result<(), Error> {
    let call = match (resource.kind.as_str(), resource.physical_id.as_deref()) {
        (QUEUE, Some(name)) => Some(Call::delete(format!("/queues/{name}"))),
        (BUCKET, Some(name)) => Some(Call::delete(format!("/buckets/{name}"))),
        _ => function_deletion(client, resource)?,
    };
    let Some(call) = call else { return Ok(()) };
    match client.done(&call) {
        Err(error) if error.status == Some(404) => Ok(()),
        Err(error) if error.status == Some(409) && resource.kind == BUCKET => {
            let (name, id) = (plan::function_of(resource), &resource.logical_id);
            Err(Error::new(
                Kind::Failed,
                format!(
                    "The bucket {name} ({id}) isn't empty, and CloudFormation deletes a bucket that is: empty it, or \
                     delete it with `ff buckets delete {name} --force`, then run this again"
                ),
            ))
        }
        done => done,
    }
}

/// What deletes a function's resource of the stack, none when it is gone already: the function with what is its, its
/// URL, its alias, its asynchronous calls' settings, one of its schedules or its reading of a queue.
fn function_deletion(client: &Client, resource: &StackResource) -> Result<Option<Call>, Error> {
    let Some(function) = find(client, plan::function_of(resource))? else { return Ok(None) };
    // What follows the function's name: an alias's, a schedule's or a queue's.
    let named = resource.physical_id.as_deref().and_then(|id| id.split_once(':')).map(|(_, named)| named);
    let id = &function.id;
    let call = match (resource.kind.as_str(), named) {
        (FUNCTION, _) => Call::delete(format!("/functions/{id}")),
        (URL, None) => Call::delete(format!("/functions/{id}/url")),
        (URL, Some(alias)) => Call::delete(format!("/functions/{id}/url")).query("qualifier", alias),
        (ALIAS, Some(alias)) => Call::delete(format!("/functions/{id}/aliases/{alias}")),
        (EVENT_INVOKE_CONFIG, _) => Call::delete(format!("/functions/{id}/event-invoke-config")),
        (RULE | SCHEDULE, Some(name)) => {
            let schedules = schedule::schedules(client, id)?;
            let Some(schedule) = schedules.into_iter().find(|schedule| schedule.name == name) else { return Ok(None) };
            Call::delete(format!("/functions/{id}/schedules/{}", schedule.id))
        }
        (MAPPING, Some(queue)) => {
            let mappings = event_sources::of_function(client, id)?;
            let found = mappings.into_iter().find(|mapping| name_in_arn(&mapping.event_source_arn) == queue);
            let Some(mapping) = found else { return Ok(None) };
            Call::delete(format!("/event-sources/{}", mapping.uuid))
        }
        _ => return Ok(None),
    };
    Ok(Some(call))
}

/// What a function of the stack is, for the question before a delete: its resources in words.
fn listed(resources: &[StackResource]) -> String {
    resources.iter().map(plan::in_words).collect::<Vec<_>>().join(", ")
}

/// The report's lines of what was deleted and of what was left in the account.
fn removal_lines(removed: &plan::Removed) -> impl Iterator<Item = String> + '_ {
    let deleted = removed.deleted.iter().map(|resource| format!("deleted {}", plan::in_words(resource)));
    deleted.chain(removed.kept.iter().map(|resource| format!("kept {}", left_in_the_account(resource))))
}

/// A resource its template said to retain, in words.
fn left_in_the_account(resource: &StackResource) -> String {
    format!("{}: in the account, out of the stack, as its template said Retain", plan::in_words(resource))
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
    let read = Read::of(&args.path, args.stack_name.as_deref(), &args.parameter_overrides, |_| {
        Err(Error::usage(format!(
            "Name the stack: --stack-name, or stack_name in {SAMCONFIG}, as `sam deploy` takes it"
        )))
    })?;
    let Read { text, template, at, stack_name, .. } = &read;

    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let me = account::me(&client)?;
    let account = account::current(&me, &settings)?;
    let aws = account.aws.as_ref().ok_or_else(|| {
        Error::new(
            Kind::Failed,
            "The API doesn't say FF's region, which a template's ARNs name: it is older than this ff",
        )
    })?;
    // An API that doesn't say where functions reach SQS has them reach its public endpoint.
    let sqs_function_endpoint =
        if aws.sqs_function_endpoint.is_empty() { &aws.sqs_endpoint } else { &aws.sqs_function_endpoint };
    let place = Place {
        stack: stack_name,
        region: &aws.region,
        account: &account.id,
        sqs_endpoint: &aws.sqs_endpoint,
        sqs_function_endpoint,
        s3_endpoint: &aws.s3_endpoint,
    };
    let last: Option<Stack> = client.json_if_any(&Call::get(format!("/stacks/{stack_name}")))?;
    let last_resources = last.as_ref().map(|stack| stack.resources.as_slice()).unwrap_or_default();

    // Every problem before any change: the template's, its parameters', then what the account has.
    let given = given_values(template, last.as_ref(), read.given.clone());
    let (values, mut problems) = read.checked(&given, "ff deploy", NOTHING, context.out);
    // Each function, queue and bucket may need a name CloudFormation's way, with a random suffix.
    let named_in_template = template.value.get("Resources").and_then(Value::as_object).map_or(0, |resources| {
        let named = [FUNCTION, QUEUE, BUCKET];
        resources.values().filter(|resource| named.iter().any(|kind| resource["Type"] == *kind)).count()
    });
    let mut suffixes = suffixes(named_in_template)?;
    let planned = plan::plan(template, &values.values, &place, last_resources, &at.folder, &mut || {
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
    let mut problems = read.problems(NOTHING);

    let ours = |kind: &str, name: &str| {
        last_resources.iter().any(|resource| resource.kind == kind && resource.physical_id.as_deref() == Some(name))
    };
    // A resource of the template's name that the account has outside the stack, which the deploy doesn't take over.
    let taken = |problems: &mut Problems, id: &str, what: &str, name: &str, property: &str, delete: &str| {
        problems.at(
            &format!("/Resources/{id}"),
            &format!(
                "{id}: the account has a {what} {name} outside the stack: ff deploy doesn't take it over; give {id} \
                 another {property}, or delete that {what} with `{delete} {name}`"
            ),
        );
    };
    let mut existing_buckets = Vec::new();
    for bucket in &deployment.buckets {
        let found: Option<Value> = client.json_if_any(&Call::get(format!("/buckets/{}", bucket.name)))?;
        if found.is_some() && !ours(BUCKET, &bucket.name) {
            taken(&mut problems, &bucket.id, "bucket", &bucket.name, "BucketName", "ff buckets delete");
        }
        existing_buckets.push(found);
    }
    let mut existing = Vec::new();
    for function in &deployment.functions {
        let found = find(&client, &function.name)?;
        let id = &function.id;
        let name = &function.name;
        match &found {
            Some(other) if !ours(FUNCTION, name.as_str()) => {
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
    let mut existing_queues = Vec::new();
    for queue in &deployment.queues {
        let found: Option<queues::Queue> = client.json_if_any(&Call::get(format!("/queues/{}", queue.name)))?;
        if found.is_some() && !ours(QUEUE, &queue.name) {
            taken(&mut problems, &queue.id, "queue", &queue.name, "QueueName", "ff queues delete");
        }
        existing_queues.push(found);
    }
    check_named(&client, &deployment, &mut problems)?;
    let next = deployment.resources();
    let removed = plan::removed(last_resources, &next, &deployment.replace_policies());
    let (built, indexes) = packages(&deployment.functions, at, args, &mut problems, context)?;
    problems.refusal()?;
    if !removed.deleted.is_empty()
        && !confirmed(
            "ff deploy",
            &format!(
                "The template no longer has what the stack {stack_name} made: {}. Delete it as the deploy goes?",
                listed(&removed.deleted)
            ),
            args.yes,
        )?
    {
        return context
            .out
            .result(&json!({ "stack": stack_name, "deployed": false }), || "Nothing deployed".to_owned());
    }

    // What the stack has that is still there, by the function, the queue or the bucket it is: the record starts from
    // it.
    let mut still_there = BTreeSet::new();
    let named = last_resources.iter().filter(|resource| resource.physical_id.is_some()).map(owner);
    let there = |path: String| -> Result<bool, Error> { Ok(client.json_if_any::<Value>(&Call::get(path))?.is_some()) };
    for owned in named.collect::<BTreeSet<_>>() {
        let is_there = match owned {
            Owner::Queue(name) => {
                deployment.queues.iter().any(|queue| queue.name == name) || there(format!("/queues/{name}"))?
            }
            Owner::Bucket(name) => {
                deployment.buckets.iter().any(|bucket| bucket.name == name) || there(format!("/buckets/{name}"))?
            }
            Owner::Function(name) => {
                deployment.functions.iter().any(|function| function.name == name) || find(&client, name)?.is_some()
            }
        };
        if is_there {
            still_there.insert(owned);
        }
    }
    let template_sha256 = sha256_hex(text.as_bytes());
    let parameters = kept_values(template, &values.values);
    let mut record = Record {
        client: &client,
        name: stack_name,
        template_sha256: last.as_ref().map_or_else(|| template_sha256.clone(), |stack| stack.template_sha256.clone()),
        parameters: last.as_ref().map_or_else(|| parameters.clone(), |stack| stack.parameters.clone()),
        resources: last_resources
            .iter()
            .filter(|resource| resource.physical_id.is_none() || still_there.contains(&owner(resource)))
            .cloned()
            .collect(),
    };
    if last.is_none() {
        // Made first, empty: a stack the account can't have more of changes nothing.
        record.save()?;
    }

    let started = Instant::now();
    // The buckets first, a name another account has refused before anything else is made, their sites with them.
    let mut buckets_deployed = Vec::new();
    for (bucket, existing) in deployment.buckets.iter().zip(&existing_buckets) {
        buckets_deployed.push(ensure_bucket(&client, bucket, existing.as_ref())?);
        record.keep(&[bucket.resource()]);
        if existing.is_none() {
            record.save()?;
        }
    }
    // Then the queues, each dead-letter queue before those that use it: the functions read them and send to them.
    let mut queues_deployed = Vec::new();
    for (queue, existing) in deployment.queues.iter().zip(&existing_queues) {
        queues_deployed.push(ensure_queue(&client, queue, existing.as_ref())?);
        record.keep(&[queue.resource()]);
        if existing.is_none() {
            record.save()?;
        }
    }
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
        if ensure_schedules(&client, &answer, function.alias.as_deref(), &function.schedules)? {
            changed.push("schedules");
        }
        if ensure_mappings(&client, &answer, function.alias.as_deref(), &function.mappings)? {
            changed.push("queues read");
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
    // The buckets' notifications once the functions they call are made, before what the template no longer has goes.
    for (bucket, deployed) in deployment.buckets.iter().zip(&mut buckets_deployed) {
        if ensure_notifications(&client, bucket)? && deployed.action != "created" {
            deployed.changed.push("notifications");
            deployed.action = "updated";
        }
    }
    for resource in &removed.deleted {
        delete_resource(&client, resource)?;
    }
    // What its template said to retain is the account's from now on, as a stack CloudFormation updates leaves it.
    Record { template_sha256, parameters, resources: next, ..record }.save()?;

    let by_id = |id: &String, name: &String| (id.clone(), name.clone());
    let known = Known {
        functions: made,
        queues: deployment.queues.iter().map(|queue| by_id(&queue.id, &queue.name)).collect(),
        buckets: deployment.buckets.iter().map(|bucket| by_id(&bucket.id, &bucket.name)).collect(),
        sites: buckets_deployed
            .iter()
            .filter_map(|bucket| Some((bucket.logical_id.clone(), bucket.site.clone()?)))
            .collect(),
        ..Known::new(&place, &values.values, place.sqs_endpoint)
    };
    let outputs = plan::outputs(template, &known);
    let seconds = deploy::seconds_since(started);
    let removal_lines: Vec<String> = removal_lines(&removed).collect();
    let plan::Removed { deleted, kept } = removed;
    let document = StackDeployed {
        stack: stack_name.clone(),
        buckets: buckets_deployed,
        queues: queues_deployed,
        functions: deployed,
        deleted,
        kept,
        outputs,
    };
    context.out.result(&document, || {
        let mut lines = vec![format!("{stack_name}: deployed in {seconds} s")];
        let changed = |action: &str, changed: String| match action {
            "updated" => format!(", changed: {changed}"),
            _ => String::new(),
        };
        for bucket in &document.buckets {
            let changed = changed(bucket.action, bucket.changed.join(", "));
            lines.push(format!("{} the bucket {} ({}){changed}", bucket.action, bucket.name, bucket.logical_id));
        }
        for queue in &document.queues {
            let changed = changed(queue.action, queue.changed.join(", "));
            lines.push(format!("{} the queue {} ({}){changed}", queue.action, queue.name, queue.logical_id));
        }
        for function in &document.functions {
            let changed = changed(function.action, function.changed.join(", "));
            let version = function.version.as_deref().map(|version| format!(", version {version}")).unwrap_or_default();
            lines.push(format!("{} {} ({}){changed}{version}", function.action, function.name, function.logical_id));
        }
        lines.extend(removal_lines);
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

/// `ff delete-stack`: what the stack made deleted, but what its template said to retain, then the stack. With no name,
/// the one samconfig.toml names here.
pub fn delete_stack(name: Option<&str>, yes: bool, context: &Context) -> Result<(), Error> {
    let name = match name {
        Some(name) => name.to_owned(),
        None => template::samconfig(Path::new("."))?.and_then(|config| config.stack_name).ok_or_else(|| {
            Error::usage(format!("Name the stack: ff delete-stack <name>, or run it where {SAMCONFIG} names it"))
        })?,
    };
    let client = Client::new(&context.settings()?)?;
    let stack: Stack = client.json(&Call::get(format!("/stacks/{name}")))?;
    let removed = plan::removed(&stack.resources, &[], &BTreeMap::new());
    let mut question = match removed.deleted.len() {
        0 => format!("Delete the stack {name}? It made nothing that is still there to delete"),
        _ => format!("Delete the stack {name} and what it made: {}?", listed(&removed.deleted)),
    };
    if !removed.kept.is_empty() {
        let kept: Vec<String> = removed.kept.iter().map(left_in_the_account).collect();
        question.push_str(&format!(" It keeps {}", kept.join(", ")));
    }
    if !confirmed("ff delete-stack", &question, yes)? {
        return context.out.result(&json!({ "deleted": false, "stack": name }), || "Nothing deleted".to_owned());
    }
    for resource in &removed.deleted {
        delete_resource(&client, resource)?;
    }
    client.done(&Call::delete(format!("/stacks/{name}")))?;
    let document = json!({ "deleted": true, "stack": name, "resources": removed.deleted, "kept": removed.kept });
    context.out.result(&document, || {
        let mut lines: Vec<String> = removal_lines(&removed).collect();
        lines.push(format!("deleted the stack {name}"));
        lines.join("\n")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::DeletionPolicy;
    use crate::sam::{self, parameters};

    fn template(text: &str) -> Template {
        sam::read(text).unwrap()
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
    fn the_report_says_what_was_deleted_and_what_its_template_said_to_retain() {
        let function = |logical_id: &str, name: &str, deletion_policy| StackResource {
            logical_id: logical_id.into(),
            kind: FUNCTION.into(),
            physical_id: Some(name.into()),
            deletion_policy,
        };
        let removed = plan::Removed {
            deleted: vec![function("Old", "old", DeletionPolicy::Delete)],
            kept: vec![function("Reports", "reports", DeletionPolicy::Retain)],
        };

        assert_eq!(
            removal_lines(&removed).collect::<Vec<_>>(),
            [
                "deleted the function old (Old)",
                "kept the function reports (Reports): in the account, out of the stack, as its template said Retain",
            ]
        );
    }

    #[test]
    fn a_mapping_is_as_wanted_by_its_settings_its_state_and_the_alias_its_functions_arn_names() {
        let mapping = |function_arn: &str, state: &str, scaling: Value| -> EventSource {
            serde_json::from_value(json!({
                "uuid": "6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70",
                "eventSourceArn": "arn:aws:sqs:tn-tunis-1:000000000001:jobs",
                "functionArn": function_arn,
                "batchSize": 100,
                "maximumBatchingWindowInSeconds": 5,
                "functionResponseTypes": ["ReportBatchItemFailures"],
                "scalingConfig": scaling,
                "state": state,
                "stateTransitionReason": "USER_INITIATED",
                "lastModified": "2026-11-03T10:00:00Z",
            }))
            .unwrap()
        };
        let arn = "arn:aws:lambda:tn-tunis-1:000000000001:function:orders";
        let wanted = plan::Mapping {
            event: "Jobs".into(),
            queue_arn: "arn:aws:sqs:tn-tunis-1:000000000001:jobs".into(),
            batch_size: 100,
            batching_window: 5,
            report_batch_item_failures: true,
            max_concurrency: Some(2),
            enabled: true,
        };
        let most = json!({ "maximumConcurrency": 2 });

        assert!(mapping_as_wanted(&mapping(&format!("{arn}:live"), "Enabled", most.clone()), &wanted, Some("live")));
        assert!(!mapping_as_wanted(&mapping(arn, "Enabled", most.clone()), &wanted, Some("live")));
        assert!(!mapping_as_wanted(&mapping(&format!("{arn}:live"), "Enabled", most.clone()), &wanted, None));
        assert!(!mapping_as_wanted(&mapping(&format!("{arn}:live"), "Disabled", most), &wanted, Some("live")));
        assert!(!mapping_as_wanted(&mapping(&format!("{arn}:live"), "Enabled", Value::Null), &wanted, Some("live")));
        let unlimited = plan::Mapping { max_concurrency: None, ..wanted };
        assert!(mapping_as_wanted(&mapping(arn, "Enabled", Value::Null), &unlimited, None));
    }

    #[test]
    fn a_queues_changes_are_the_attributes_and_the_tags_that_differ_from_the_templates() {
        let existing: queues::Queue = serde_json::from_value(json!({
            "name": "jobs",
            "url": "https://sqs.ffunc.cloud/000000000001/jobs",
            "arn": "arn:aws:sqs:tn-tunis-1:000000000001:jobs",
            "visibilityTimeout": 30,
            "messageRetentionPeriod": 345_600,
            "delaySeconds": 0,
            "maximumMessageSize": 1_048_576,
            "receiveMessageWaitTimeSeconds": 0,
            "redrivePolicy": { "deadLetterTargetArn": "arn:aws:sqs:tn-tunis-1:000000000001:jobs-failed", "maxReceiveCount": 3 },
            "tags": { "team": "shop" },
            "messages": { "available": 0, "inFlight": 0, "delayed": 0 },
            "sizeBytes": 0,
            "createdAt": "2026-11-03T10:00:00.000Z",
            "updatedAt": "2026-11-03T10:00:00.000Z"
        }))
        .unwrap();
        let attributes = |timeout: u32, redrive: Value| {
            json!({
                "visibilityTimeout": timeout,
                "messageRetentionPeriod": 345_600,
                "delaySeconds": 0,
                "maximumMessageSize": 1_048_576,
                "receiveMessageWaitTimeSeconds": 0,
                "redrivePolicy": redrive,
            })
        };
        let redrive = existing.redrive_policy.clone().map(|policy| serde_json::to_value(policy).unwrap()).unwrap();
        let wanted = plan::Queue {
            id: "Jobs".into(),
            name: "jobs".into(),
            attributes: attributes(30, redrive),
            tags: [("team".to_owned(), "shop".to_owned())].into(),
            policies: plan::Policies::default(),
        };

        assert_eq!(queue_changes(&existing, &wanted), json!({}));
        let changed = plan::Queue { attributes: attributes(60, Value::Null), tags: BTreeMap::new(), ..wanted };
        assert_eq!(
            queue_changes(&existing, &changed),
            json!({ "visibilityTimeout": 60, "redrivePolicy": null, "tags": {} })
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
