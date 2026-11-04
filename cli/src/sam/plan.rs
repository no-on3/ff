//! A template's functions, queues and buckets as `ff deploy` makes them (ADR 0016): each one's name and settings, a
//! function's code and events, read from its properties with the Globals merged and the intrinsics resolved; the
//! resources the stack keeps for each; what a deploy deletes of the stack's last; and the template's outputs once FF
//! knows what they name.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::Template;
use super::resolve::{self, FUNCTION};
use crate::api::types::{
    DEFAULT_MAX_INSTANCES, DeletionPolicy, REPORT_BATCH_ITEM_FAILURES, StackResource, name_in_arn,
};
use crate::cli::Runtime;
use crate::config::{EVENT_TYPES, is_bucket_name, is_function_name, is_queue_name};

/// The resources SAM makes of a function that a stack keeps, by their CloudFormation types.
pub const URL: &str = "AWS::Lambda::Url";
pub const ALIAS: &str = "AWS::Lambda::Alias";
pub const EVENT_INVOKE_CONFIG: &str = "AWS::Lambda::EventInvokeConfig";
/// Kept without effect: on FF a function's URL and its account's buckets and queues call it with no permission.
pub const PERMISSION: &str = "AWS::Lambda::Permission";
/// What SAM makes of a function's events: a Schedule event's EventBridge rule and a ScheduleV2 event's schedule, both
/// one of the function's schedules on FF, and an SQS event's mapping, the function reading the queue.
pub const RULE: &str = "AWS::Events::Rule";
pub const SCHEDULE: &str = "AWS::Scheduler::Schedule";
pub const MAPPING: &str = "AWS::Lambda::EventSourceMapping";
pub const QUEUE: &str = "AWS::SQS::Queue";
/// A queue's policy, kept without effect: on FF a queue's own account sends to it.
pub const QUEUE_POLICY: &str = "AWS::SQS::QueuePolicy";
pub const BUCKET: &str = "AWS::S3::Bucket";
/// A bucket's policy, kept without effect: on FF a bucket's own account reaches it, and its website configuration
/// alone makes its files public.
pub const BUCKET_POLICY: &str = "AWS::S3::BucketPolicy";
/// What the stack keeps of a function besides the function, named after it: each goes with it.
const OF_A_FUNCTION: [&str; 6] = [URL, ALIAS, EVENT_INVOKE_CONFIG, RULE, SCHEDULE, MAPPING];

/// SQS's attributes a queue of the template gives, by CloudFormation's names and FF's API's, with SQS's bounds, their
/// unit and SQS's default, which an attribute the template leaves out has, as CloudFormation sets it back.
const QUEUE_ATTRIBUTES: [(&str, &str, i64, i64, &str, u32); 5] = [
    ("VisibilityTimeout", "visibilityTimeout", 0, 43_200, "seconds", 30),
    ("MessageRetentionPeriod", "messageRetentionPeriod", 60, 1_209_600, "seconds", 345_600),
    ("DelaySeconds", "delaySeconds", 0, 900, "seconds", 0),
    ("MaximumMessageSize", "maximumMessageSize", 1024, 1_048_576, "bytes", 1_048_576),
    ("ReceiveMessageWaitTimeSeconds", "receiveMessageWaitTimeSeconds", 0, 20, "seconds", 0),
];

/// The most notification configurations a bucket keeps, and the most characters of an object's key, which a filter's
/// value, an index document and an error document have at most, as S3's.
const MOST_NOTIFICATIONS: usize = 100;
const MOST_KEY: usize = 1024;

/// Lambda's defaults, which a template's functions get, as on AWS.
const DEFAULT_MEMORY: u32 = 128;
const DEFAULT_TIMEOUT: u32 = 3;
/// The messages of one call of an SQS event, as Lambda's default; over it, Lambda wants a batching window.
const DEFAULT_BATCH_SIZE: u32 = 10;
/// What a random suffix of a name CloudFormation makes holds, and how long it is.
const SUFFIX_CHARACTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
pub const SUFFIX_LENGTH: usize = 12;

/// What the deploy is for: the stack, FF's region and the account, which the pseudo parameters and the ARNs give;
/// FF's SQS endpoint, which a queue's URL is under, the public one and the one functions reach inside the cluster; and
/// its S3 endpoint, which a bucket's domain is under.
pub struct Place<'a> {
    pub stack: &'a str,
    pub region: &'a str,
    pub account: &'a str,
    pub sqs_endpoint: &'a str,
    pub sqs_function_endpoint: &'a str,
    pub s3_endpoint: &'a str,
}

impl Place<'_> {
    /// A function's ARN, qualified by a version or an alias after a colon when one is given.
    pub fn arn(&self, name: &str) -> String {
        format!("arn:aws:lambda:{}:{}:function:{name}", self.region, self.account)
    }

    /// A queue's ARN.
    pub fn queue_arn(&self, name: &str) -> String {
        format!("arn:aws:sqs:{}:{}:{name}", self.region, self.account)
    }

    /// The queue an ARN names, when it is one of the account's in FF's region.
    fn queue_of<'a>(&self, arn: &'a str) -> Option<&'a str> {
        let prefix = self.queue_arn("");
        arn.strip_prefix(&prefix).filter(|name| !name.is_empty() && !name.contains(':'))
    }

    /// The function an ARN names, with its alias or version after a colon, when it is one of the account's in FF's
    /// region.
    fn function_of<'a>(&self, arn: &'a str) -> Option<&'a str> {
        let prefix = self.arn("");
        arn.strip_prefix(&prefix).filter(|name| !name.is_empty() && name.split(':').count() <= 2)
    }

    /// The host a bucket is reached at, its name before FF's S3 endpoint's: its DomainName.
    pub fn bucket_domain(&self, name: &str) -> String {
        let host = self.s3_endpoint.split_once("://").map_or(self.s3_endpoint, |(_, host)| host);
        format!("{name}.{}", host.trim_end_matches('/'))
    }
}

/// A bucket's ARN, which names no region and no account, as S3's.
pub fn bucket_arn(name: &str) -> String {
    format!("arn:aws:s3:::{name}")
}

/// A function's URL as its FunctionUrlConfig asks: who may call it, and its CORS as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Url {
    pub auth_type: String,
    pub cors: Option<Value>,
}

/// A Schedule or ScheduleV2 event: one of the function's schedules, as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Schedule {
    /// The event's key, which the logical ID SAM gives its resource ends with.
    pub event: String,
    /// RULE for a Schedule event, SCHEDULE for a ScheduleV2 one.
    pub kind: &'static str,
    /// Its Name, else the event's key: the function's schedule of that name.
    pub name: String,
    pub expression: String,
    pub description: Option<String>,
    /// Its Input's JSON; none, EventBridge's Scheduled Event.
    pub input: Option<Value>,
    pub enabled: bool,
}

/// An SQS event: the function reading one of the account's queues, as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Mapping {
    /// The event's key, which the logical ID SAM gives its mapping ends with.
    pub event: String,
    pub queue_arn: String,
    pub batch_size: u32,
    pub batching_window: u32,
    pub report_batch_item_failures: bool,
    pub max_concurrency: Option<u32>,
    pub enabled: bool,
}

impl Mapping {
    /// The queue's name, the end of its ARN.
    pub fn queue(&self) -> &str {
        self.queue_arn.rsplit(':').next().unwrap_or_default()
    }
}

/// What becomes of what a resource made once the template has it no more or the stack is deleted, its DeletionPolicy,
/// and once a new name replaces it, its UpdateReplacePolicy: a function's own resources follow the function's, as SAM
/// gives them its.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Policies {
    pub deletion: DeletionPolicy,
    pub update_replace: DeletionPolicy,
}

impl Policies {
    /// A resource's, Retain or Delete alone, as the subset's check takes them.
    fn of(resource: &Value) -> Self {
        let policy = |key: &str| match resource.get(key).and_then(Value::as_str) {
            Some("Retain") => DeletionPolicy::Retain,
            _ => DeletionPolicy::Delete,
        };
        Policies { deletion: policy("DeletionPolicy"), update_replace: policy("UpdateReplacePolicy") }
    }
}

/// A queue of the template, as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Queue {
    pub id: String,
    pub name: String,
    /// Its attributes by FF's API's names, each of them: the template's, else SQS's default; and its redrive policy, or
    /// null for none.
    pub attributes: Value,
    pub tags: BTreeMap<String, String>,
    pub policies: Policies,
}

impl Queue {
    /// The queue its redrive policy moves messages to, by name.
    pub fn dead_letter(&self) -> Option<&str> {
        self.attributes.pointer("/redrivePolicy/deadLetterTargetArn").and_then(Value::as_str).map(name_in_arn)
    }

    /// What the stack keeps of it.
    pub fn resource(&self) -> StackResource {
        StackResource {
            logical_id: self.id.clone(),
            kind: QUEUE.to_owned(),
            physical_id: Some(self.name.clone()),
            deletion_policy: self.policies.deletion,
        }
    }
}

/// Where a bucket's notification sends its events: a function, called without waiting, or a queue.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    Function,
    Queue,
}

/// One of a bucket's notification configurations, as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Notification {
    /// `PhotosLambda1`, `PhotosQueue1`: the bucket's own, by their order; `ResizerUpload`: a function's S3 event's.
    pub id: String,
    pub target: Target,
    /// The function's ARN, its alias's under AutoPublishAlias, or the queue's.
    pub arn: String,
    /// S3's event types, as FF's API takes them.
    pub events: Vec<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    /// Where the template says it: a JSON pointer, for a problem.
    pub at: String,
}

impl Notification {
    /// The function or the queue it sends to, by name, without an alias.
    pub fn destination(&self) -> &str {
        match self.target {
            Target::Function => self.arn.split(':').nth(6).unwrap_or_default(),
            Target::Queue => name_in_arn(&self.arn),
        }
    }

    /// Whether it could take an event the other takes too, which S3 refuses as ambiguous: an event type in common, or
    /// one the other's wildcard, and prefixes and suffixes that a key could have both of.
    fn overlaps(&self, other: &Notification) -> bool {
        let covers = |wild: &str, other: &str| wild.ends_with(":*") && other.starts_with(&wild[..wild.len() - 1]);
        let types = |a: &String, b: &String| a == b || covers(a, b) || covers(b, a);
        let events = self.events.iter().any(|a| other.events.iter().any(|b| types(a, b)));
        let both = |a: &Option<String>, b: &Option<String>, along: fn(&str, &str) -> bool| match (a, b) {
            (Some(a), Some(b)) => along(a, b) || along(b, a),
            _ => true,
        };
        events
            && both(&self.prefix, &other.prefix, |a, b| a.starts_with(b))
            && both(&self.suffix, &other.suffix, |a, b| a.ends_with(b))
    }

    /// As FF's API takes it and answers it: its filter's prefix before its suffix, no filter without either.
    fn configuration(&self) -> Value {
        let mut configuration = Map::new();
        configuration.insert("id".into(), self.id.clone().into());
        let field = if self.target == Target::Function { "lambdaFunctionArn" } else { "queueArn" };
        configuration.insert(field.into(), self.arn.clone().into());
        configuration.insert("events".into(), json!(self.events));
        let rules: Vec<Value> = [("prefix", &self.prefix), ("suffix", &self.suffix)]
            .into_iter()
            .filter_map(|(name, value)| Some(json!({ "name": name, "value": value.as_ref()? })))
            .collect();
        if !rules.is_empty() {
            configuration.insert("filter".into(), json!({ "key": { "filterRules": rules } }));
        }
        Value::Object(configuration)
    }
}

/// A bucket's site, as its WebsiteConfiguration says: what a folder's path answers, and what a path with no file does.
#[derive(Debug, PartialEq)]
pub struct Website {
    pub index_document: String,
    pub error_document: Option<String>,
}

/// A bucket of the template, as FF's API takes it.
#[derive(Debug, PartialEq)]
pub struct Bucket {
    pub id: String,
    pub name: String,
    pub tags: BTreeMap<String, String>,
    /// Its NotificationConfiguration's, then its functions' S3 events, which SAM writes into it.
    pub notifications: Vec<Notification>,
    pub website: Option<Website>,
    pub policies: Policies,
}

impl Bucket {
    /// What the stack keeps of it.
    pub fn resource(&self) -> StackResource {
        StackResource {
            logical_id: self.id.clone(),
            kind: BUCKET.to_owned(),
            physical_id: Some(self.name.clone()),
            deletion_policy: self.policies.deletion,
        }
    }

    /// Its notifications as FF's API takes them and answers them, the functions' then the queues'.
    pub fn notification_configuration(&self) -> Value {
        let of = |target: Target| -> Vec<Value> {
            self.notifications
                .iter()
                .filter(|notification| notification.target == target)
                .map(Notification::configuration)
                .collect()
        };
        json!({ "lambdaFunctionConfigurations": of(Target::Function), "queueConfigurations": of(Target::Queue) })
    }
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
    /// Its Schedule and ScheduleV2 events.
    pub schedules: Vec<Schedule>,
    /// Its SQS events.
    pub mappings: Vec<Mapping>,
    pub policies: Policies,
}

impl Function {
    /// `orders`, or `orders:live` with an alias, which SAM gives the URL and the asynchronous settings of.
    pub fn qualified(&self) -> String {
        qualified(&self.name, self.alias.as_deref())
    }

    /// The instances it keeps running and the most it runs: the template's, else none kept and FF's default most.
    pub fn instances(&self) -> (u32, u32) {
        let min = self.provisioned.unwrap_or(0);
        (min, self.reserved.unwrap_or(DEFAULT_MAX_INSTANCES.max(min)))
    }

    /// The resources the stack keeps of it, named as SAM names them: the function, its URL, its alias, its
    /// asynchronous calls' settings, and its events' schedules and mappings, each named after the function by FF, each
    /// with the function's DeletionPolicy.
    pub fn resources(&self) -> Vec<StackResource> {
        let resource = |logical_id: String, kind: &str, physical_id: String| StackResource {
            logical_id,
            kind: kind.to_owned(),
            physical_id: Some(physical_id),
            deletion_policy: self.policies.deletion,
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
        let of_an_event = |event: &str, kind: &str, named: &str| {
            resource(format!("{id}{event}"), kind, format!("{}:{named}", self.name))
        };
        resources
            .extend(self.schedules.iter().map(|schedule| of_an_event(&schedule.event, schedule.kind, &schedule.name)));
        resources.extend(self.mappings.iter().map(|mapping| of_an_event(&mapping.event, MAPPING, mapping.queue())));
        resources
    }
}

/// `orders`, or `orders:live` with an alias, which SAM gives a function's URL, its asynchronous settings and its S3
/// events.
fn qualified(name: &str, alias: Option<&str>) -> String {
    match alias {
        Some(alias) => format!("{name}:{alias}"),
        None => name.to_owned(),
    }
}

/// The logical ID SAM gives a function's alias: the function's, `Alias`, and the alias's letters and digits, as a
/// logical ID holds no other character.
pub fn alias_id(function: &str, alias: &str) -> String {
    let alias: String = alias.chars().filter(char::is_ascii_alphanumeric).collect();
    format!("{function}Alias{alias}")
}

/// The template's functions, queues and buckets, in its order but each dead-letter queue before the queues that use
/// it, and what FF keeps without effect, the permissions and the queues' and the buckets' policies.
#[derive(Debug)]
pub struct Plan {
    pub functions: Vec<Function>,
    pub queues: Vec<Queue>,
    pub buckets: Vec<Bucket>,
    pub without_effect: Vec<StackResource>,
}

impl Plan {
    /// What the stack keeps once the deploy is done.
    pub fn resources(&self) -> Vec<StackResource> {
        let functions = self.functions.iter().flat_map(Function::resources);
        let queues = self.queues.iter().map(Queue::resource);
        let buckets = self.buckets.iter().map(Bucket::resource);
        functions.chain(queues).chain(buckets).chain(self.without_effect.iter().cloned()).collect()
    }

    /// The UpdateReplacePolicy of each resource the deploy makes, by logical ID: what becomes of the one it replaces.
    pub fn replace_policies(&self) -> BTreeMap<String, DeletionPolicy> {
        let of_a_function = |function: &Function| {
            let policy = function.policies.update_replace;
            function.resources().into_iter().map(move |resource| (resource.logical_id, policy))
        };
        let of_a_queue = |queue: &Queue| (queue.id.clone(), queue.policies.update_replace);
        let of_a_bucket = |bucket: &Bucket| (bucket.id.clone(), bucket.policies.update_replace);
        let functions = self.functions.iter().flat_map(of_a_function);
        functions.chain(self.queues.iter().map(of_a_queue)).chain(self.buckets.iter().map(of_a_bucket)).collect()
    }
}

/// What a value of the template can't be, at its JSON pointer.
pub type Problems = Vec<(String, String)>;

/// A name CloudFormation's way: the stack's, the logical ID's and a random suffix, each cut so that the whole is within
/// Lambda's 64 characters, the logical ID keeping half of what is left at least.
pub fn generated_name(stack: &str, id: &str, suffix: &str, most: usize) -> String {
    let room = most - suffix.len() - 2;
    let id_part = &id[..id.len().min((room / 2).max(room.saturating_sub(stack.len())))];
    let stack_part = &stack[..stack.len().min(room - id_part.len())];
    format!("{stack_part}-{id_part}-{suffix}")
}

/// A random suffix for a name, from 12 random bytes, letters and digits as CloudFormation's.
pub fn suffix(random: &[u8; SUFFIX_LENGTH]) -> String {
    random.iter().map(|byte| SUFFIX_CHARACTERS[usize::from(*byte) % SUFFIX_CHARACTERS.len()] as char).collect()
}

/// What FF knows of the template's names: the parameters' values, the pseudo parameters, each function's name, its
/// ARN and its alias's, after the deploy its URL and the version it published; each queue's name, by logical ID, its
/// ARN and its URL under `queue_endpoint`, the public one or the one functions reach; each bucket's name, its ARN and
/// its domain, and after the deploy its site's address.
pub struct Known<'a> {
    pub place: &'a Place<'a>,
    pub values: &'a BTreeMap<String, Value>,
    pub functions: BTreeMap<String, Made>,
    pub queues: BTreeMap<String, String>,
    pub buckets: BTreeMap<String, String>,
    /// Each site's address, by its bucket's logical ID: its WebsiteURL, which FF's API gives once the site is made.
    pub sites: BTreeMap<String, String>,
    pub queue_endpoint: &'a str,
}

/// What a function of the template is on FF.
#[derive(Clone, Debug, Default)]
pub struct Made {
    pub name: String,
    pub alias: Option<String>,
    pub url: Option<String>,
    pub version: Option<String>,
}

impl<'a> Known<'a> {
    /// What FF knows before the deploy: the values and the place, none of the template's names yet.
    pub fn new(place: &'a Place<'a>, values: &'a BTreeMap<String, Value>, queue_endpoint: &'a str) -> Self {
        Known {
            place,
            values,
            functions: BTreeMap::new(),
            queues: BTreeMap::new(),
            buckets: BTreeMap::new(),
            sites: BTreeMap::new(),
            queue_endpoint,
        }
    }

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
        if let Some(queue) = self.queues.get(name) {
            return match attribute {
                None | Some("QueueUrl") => Some(format!("{}/{}/{queue}", self.queue_endpoint, place.account).into()),
                Some("Arn") => Some(place.queue_arn(queue).into()),
                Some("QueueName") => Some(queue.clone().into()),
                Some(_) => None,
            };
        }
        if let Some(bucket) = self.buckets.get(name) {
            return match attribute {
                None => Some(bucket.clone().into()),
                Some("Arn") => Some(bucket_arn(bucket).into()),
                Some("DomainName" | "RegionalDomainName") => Some(place.bucket_domain(bucket).into()),
                Some("WebsiteURL") => self.sites.get(name).cloned().map(Value::from),
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

/// A boolean, as CloudFormation takes one: true or false, or text of one.
pub fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) if text.eq_ignore_ascii_case("true") => Some(true),
        Value::String(text) if text.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// A property's path in words, for a message: `Timeout`, `Environment.Variables`, a list's item `Rules[0].Name`, or
/// an event's `event Jobs's BatchSize`.
fn said(path: &str) -> String {
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("Events"), Some(event), Some("Properties")) => {
            let rest = dotted(parts);
            let event = format!("event {event}");
            match rest.is_empty() {
                true => event,
                false => possessive(&event, &rest),
            }
        }
        _ => dotted(path.split('/')),
    }
}

/// A path's parts written as CloudFormation's messages write them: `Filter.S3Key.Rules[0].Name`.
fn dotted<'p>(parts: impl Iterator<Item = &'p str>) -> String {
    let mut said = String::new();
    for part in parts {
        if part.bytes().all(|byte| byte.is_ascii_digit()) {
            said.push_str(&format!("[{part}]"));
        } else {
            if !said.is_empty() {
                said.push('.');
            }
            said.push_str(part);
        }
    }
    said
}

/// `Orders' event`, `Jobs's BatchSize`: what an owner has.
fn possessive(owner: &str, what: &str) -> String {
    format!("{owner}{} {what}", if owner.ends_with('s') { "'" } else { "'s" })
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
    /// What the deploy makes of the resource, in words: the function, the queue.
    making: &'static str,
}

impl<'a> Reading<'a> {
    /// The properties of a resource of the resolved template, `empty` when it has none.
    fn of(resolved: &'a Value, empty: &'a Map<String, Value>, id: &'a str, making: &'static str) -> Self {
        let pointer = format!("/Resources/{id}/Properties");
        let properties = resolved.pointer(&pointer).and_then(Value::as_object).unwrap_or(empty);
        Reading { id, properties, pointer, problems: Vec::new(), making }
    }

    fn problem(&mut self, path: &str, message: String) {
        self.problems.push((format!("{}/{path}", self.pointer), format!("{}: {message}", self.id)));
    }

    /// The value at a path of the properties, `/` apart, a list's items by their index, known or not.
    fn at(&self, path: &str) -> Option<&'a Value> {
        let (first, rest) = path.split_once('/').unwrap_or((path, ""));
        let value = self.properties.get(first)?;
        if rest.is_empty() { Some(value) } else { value.pointer(&format!("/{rest}")) }
    }

    /// The value at a path of the properties once FF knows it all; else none, the problem said.
    fn known(&mut self, path: &str) -> Option<Value> {
        let value = self.at(path)?.clone();
        match unresolved(&value) {
            Some(what) => {
                self.problem(
                    path,
                    format!(
                        "{} holds {what}, which ff deploy doesn't know before it makes {}",
                        said(path),
                        self.making
                    ),
                );
                None
            }
            None => Some(value),
        }
    }

    /// Whether the properties have a value at the path, known or not.
    fn has(&self, path: &str) -> bool {
        self.at(path).is_some()
    }

    fn text(&mut self, path: &str) -> Option<String> {
        let value = self.known(path)?;
        let found = text(&value);
        if found.is_none() {
            self.problem(path, format!("{} is text, as CloudFormation takes it", said(path)));
        }
        found
    }

    /// Text CloudFormation needs: the problem said when there is none, `what` saying what it is.
    fn needed(&mut self, path: &str, what: &str) -> Option<String> {
        if self.has(path) {
            return self.text(path);
        }
        let (owner, name) = path.rsplit_once('/').map_or(("", path), |(owner, name)| (owner, name));
        let needs = match owner {
            "" => format!("{name} is needed: {what}"),
            _ => format!("{} needs its {name}: {what}", said(owner)),
        };
        self.problem(path, needs);
        None
    }

    /// A boolean of an event, which SAM's transform takes as true or false alone, where CloudFormation takes text too.
    fn flag(&mut self, path: &str) -> Option<bool> {
        let value = self.known(path)?;
        let found = value.as_bool();
        if found.is_none() {
            self.problem(path, format!("{} {value}: true or false, as SAM's transform takes it, not text", said(path)));
        }
        found
    }

    /// A whole number of an event, which SAM's transform takes as a number alone, within bounds.
    fn sam_number(&mut self, path: &str, least: i64, most: i64, unit: &str) -> Option<u32> {
        let value = self.known(path)?;
        if !value.is_number() {
            self.problem(path, format!("{} {value}: a number, as SAM's transform takes it, not text", said(path)));
            return None;
        }
        self.number(path, least, most, unit)
    }

    /// A whole number within bounds, saying them otherwise.
    fn number(&mut self, path: &str, least: i64, most: i64, unit: &str) -> Option<u32> {
        let value = self.known(path)?;
        match whole(&value).filter(|number| (least..=most).contains(number)) {
            Some(number) => u32::try_from(number).ok(),
            None => {
                self.problem(path, format!("{} {value}: a whole number of {unit} from {least} to {most}", said(path)));
                None
            }
        }
    }

    /// CloudFormation's Tags of a resource SAM doesn't make: a list of a Key and a Value each, both text.
    fn tag_list(&mut self, path: &str) -> BTreeMap<String, String> {
        let Some(value) = self.known(path) else { return BTreeMap::new() };
        let Some(list) = value.as_array() else {
            self.problem(path, format!("{} is a list of a Key and a Value each", said(path)));
            return BTreeMap::new();
        };
        let mut tags = BTreeMap::new();
        for (index, tag) in list.iter().enumerate() {
            match (tag.get("Key").and_then(text), tag.get("Value").and_then(text)) {
                (Some(key), Some(value)) => {
                    tags.insert(key, value);
                }
                _ => self.problem(
                    &format!("{path}/{index}"),
                    format!("{} {index} is a Key and a Value, both text", said(path)),
                ),
            }
        }
        tags
    }

    /// A mapping of text by name, as Environment's Variables and Tags are, each value written out.
    fn texts(&mut self, path: &str) -> BTreeMap<String, String> {
        let Some(value) = self.known(path) else { return BTreeMap::new() };
        let Some(map) = value.as_object() else {
            self.problem(path, format!("{} is a mapping of names to values", said(path)));
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
                    format!("{} is text, a number or a boolean", possessive(&said(path), name)),
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

/// The property of a schedule's event that holds its expression: a Schedule event's Schedule, a ScheduleV2 event's
/// ScheduleExpression.
pub fn expression_key(kind: &str) -> &'static str {
    if kind == RULE { "Schedule" } else { "ScheduleExpression" }
}

/// An EventBridge rule's name, which FF's schedules take: 1 to 64 letters, digits, '.', '-' and '_'.
fn is_schedule_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// A function's events that FF makes: its schedules, the queues it reads, whether HttpApi routes go to it, and the
/// notifications its S3 events give a bucket of the template, by the bucket's name.
#[derive(Default)]
struct Events {
    schedules: Vec<Schedule>,
    mappings: Vec<Mapping>,
    http_api: bool,
    s3: Vec<(String, Notification)>,
}

/// The function's events, each read from its Properties: what ff deploy makes of the subset's. `arn` is the
/// function's, its alias's under AutoPublishAlias, which a bucket's notification calls.
fn events(reading: &mut Reading, place: &Place, arn: &str) -> Events {
    let mut events = Events::default();
    let properties = reading.properties;
    let Some(all) = properties.get("Events").and_then(Value::as_object) else { return events };
    for (event, value) in all {
        let at = format!("Events/{event}/Properties");
        match value.get("Type").and_then(Value::as_str) {
            Some(kind @ ("Schedule" | "ScheduleV2")) => {
                let Some(schedule) = schedule(reading, event, kind, &at) else { continue };
                if let Some(other) = events.schedules.iter().find(|other| other.name == schedule.name) {
                    let message = format!(
                        "event {event}'s schedule {} is event {}'s too: a function's schedule has a name of its own",
                        schedule.name, other.event
                    );
                    reading.problem(&at, message);
                }
                events.schedules.push(schedule);
            }
            Some("SQS") => {
                let Some(mapping) = mapping(reading, event, &at, place) else { continue };
                if let Some(other) = events.mappings.iter().find(|other| other.queue_arn == mapping.queue_arn) {
                    let message = format!(
                        "event {event} reads the queue {}, as event {} does: Lambda has a function read a queue once",
                        mapping.queue(),
                        other.event
                    );
                    reading.problem(&format!("{at}/Queue"), message);
                }
                events.mappings.push(mapping);
            }
            Some("HttpApi") => events.http_api = true,
            Some("S3") => events.s3.extend(s3_event(reading, event, &at, arn)),
            _ => {}
        }
    }
    events
}

/// An S3 event: a bucket of the template calling the function, a notification SAM writes into the bucket's, which the
/// subset's check has the Bucket's `!Ref` name; with it, the bucket's name.
fn s3_event(reading: &mut Reading, event: &str, at: &str, arn: &str) -> Option<(String, Notification)> {
    let bucket = reading.needed(&format!("{at}/Bucket"), "!Ref of a bucket of the template");
    let events = event_types(reading, &format!("{at}/Events"));
    let filter = key_filter(reading, &format!("{at}/Filter"));
    let (prefix, suffix) = filter?;
    let notification = Notification {
        id: format!("{}{event}", reading.id),
        target: Target::Function,
        arn: arn.to_owned(),
        events: events?,
        prefix,
        suffix,
        at: format!("{}/{at}", reading.pointer),
    };
    Some((bucket?, notification))
}

/// S3's event types at a path, one or a list of them, each one FF's buckets send.
fn event_types(reading: &mut Reading, path: &str) -> Option<Vec<String>> {
    let value = match reading.has(path) {
        true => reading.known(path)?,
        false => {
            reading.needed(path, "S3's events, such as s3:ObjectCreated:*");
            return None;
        }
    };
    let listed: Option<Vec<String>> = match &value {
        Value::String(event) => Some(vec![event.clone()]),
        Value::Array(events) if !events.is_empty() => {
            events.iter().map(|event| event.as_str().map(str::to_owned)).collect()
        }
        _ => None,
    };
    let Some(listed) = listed else {
        reading.problem(path, format!("{} is one of S3's events or a list of them", said(path)));
        return None;
    };
    let refused: Vec<&String> = listed.iter().filter(|event| !EVENT_TYPES.contains(&event.as_str())).collect();
    if let Some(event) = refused.first() {
        reading
            .problem(path, format!("{} {event}: an event FF's buckets send: {}", said(path), EVENT_TYPES.join(", ")));
        return None;
    }
    let mut events = Vec::new();
    for event in listed {
        if !events.contains(&event) {
            events.push(event);
        }
    }
    Some(events)
}

/// A notification's Filter: its S3Key's Rules, a prefix and a suffix, each once at most, as S3's; neither without one.
fn key_filter(reading: &mut Reading, at: &str) -> Option<(Option<String>, Option<String>)> {
    let rules_at = format!("{at}/S3Key/Rules");
    if !reading.has(&rules_at) {
        return Some((None, None));
    }
    let rules = reading.known(&rules_at)?;
    let Some(rules) = rules.as_array() else {
        reading.problem(&rules_at, format!("{} is a list of a Name and a Value each", said(&rules_at)));
        return None;
    };
    let (mut prefix, mut suffix, mut complete) = (None, None, true);
    for (index, rule) in rules.iter().enumerate() {
        let rule_at = format!("{rules_at}/{index}");
        let name = rule.get("Name").and_then(text).map(|name| name.to_ascii_lowercase());
        let value = rule.get("Value").and_then(text);
        let (slot, which) = match name.as_deref() {
            Some("prefix") => (&mut prefix, "prefix"),
            Some("suffix") => (&mut suffix, "suffix"),
            _ => {
                reading.problem(
                    &rule_at,
                    format!("{} is a Name, prefix or suffix, and its Value, as S3's", said(&rule_at)),
                );
                complete = false;
                continue;
            }
        };
        let problem = match value {
            _ if slot.is_some() => Some(format!("{} is a second {which}: S3 takes one of each", said(&rule_at))),
            Some(value) if (1..=MOST_KEY).contains(&value.chars().count()) => {
                *slot = Some(value);
                None
            }
            _ => Some(format!("{}'s Value has 1 to {MOST_KEY} characters, as S3's", said(&rule_at))),
        };
        if let Some(problem) = problem {
            reading.problem(&rule_at, problem);
            complete = false;
        }
    }
    complete.then_some((prefix, suffix))
}

/// A Schedule event, EventBridge's rule, or a ScheduleV2 event, EventBridge Scheduler's schedule: on FF either is one
/// of the function's schedules, its expression in UTC.
fn schedule(reading: &mut Reading, event: &str, kind: &str, at: &str) -> Option<Schedule> {
    let kind = if kind == "Schedule" { RULE } else { SCHEDULE };
    let expression_key = expression_key(kind);
    let expression = reading.needed(&format!("{at}/{expression_key}"), "rate(…) or cron(…), as EventBridge's");
    if let Some(once) = expression.as_deref().filter(|expression| expression.trim_start().starts_with("at(")) {
        reading.problem(
            &format!("{at}/{expression_key}"),
            format!(
                "event {event}'s {expression_key} {once} runs once, which FF's schedules don't: rate(…) or cron(…)"
            ),
        );
    }
    let name = match reading.has(&format!("{at}/Name")) {
        true => reading.text(&format!("{at}/Name"))?,
        false => event.to_owned(),
    };
    if !is_schedule_name(&name) {
        reading.problem(
            &format!("{at}/Name"),
            format!(
                "event {event}'s schedule {name}: a schedule's name, its Name or else the event's key, is 1 to 64 \
                 letters, digits, '.', '-' and '_', as EventBridge's"
            ),
        );
    }
    let description = match reading.has(&format!("{at}/Description")) {
        true => reading.text(&format!("{at}/Description")),
        false => None,
    };
    if description.as_ref().is_some_and(|description| description.chars().count() > 512) {
        reading.problem(&format!("{at}/Description"), format!("event {event}'s Description: 512 characters at most"));
    }
    let input = match reading.has(&format!("{at}/Input")) {
        true => reading.text(&format!("{at}/Input")).and_then(|input| match serde_json::from_str(&input) {
            Ok(input) => Some(input),
            Err(error) => {
                let message = format!("event {event}'s Input is JSON text, as EventBridge's: {error}");
                reading.problem(&format!("{at}/Input"), message);
                None
            }
        }),
        false => None,
    };
    let state = format!("{at}/State");
    let enabled = match (reading.has(&state), reading.has(&format!("{at}/Enabled"))) {
        (true, true) => {
            reading.problem(&state, format!("event {event} has State and Enabled: SAM takes one or the other"));
            true
        }
        (true, false) => match reading.text(&state).as_deref() {
            Some("ENABLED") => true,
            Some("DISABLED") => false,
            Some(other) => {
                reading.problem(&state, format!("event {event}'s State {other}: ENABLED or DISABLED"));
                true
            }
            None => true,
        },
        (false, true) => reading.flag(&format!("{at}/Enabled")).unwrap_or(true),
        (false, false) => true,
    };
    Some(Schedule {
        event: event.to_owned(),
        kind,
        name,
        expression: expression?.trim().to_owned(),
        description,
        input,
        enabled,
    })
}

/// An SQS event: the function reading a queue of the account in FF's region, as Lambda's mapping.
fn mapping(reading: &mut Reading, event: &str, at: &str, place: &Place) -> Option<Mapping> {
    let queue_at = format!("{at}/Queue");
    let queue_arn = reading.needed(&queue_at, "the queue's ARN")?;
    if place.queue_of(&queue_arn).is_none() {
        let arn = place.queue_arn("<name>");
        reading
            .problem(&queue_at, format!("event {event}'s Queue {queue_arn}: the ARN of a queue of the account, {arn}"));
    }
    let number = |reading: &mut Reading, key: &str, least: i64, most: i64, unit: &str, default: u32| {
        let path = format!("{at}/{key}");
        if reading.has(&path) { reading.sam_number(&path, least, most, unit) } else { Some(default) }
    };
    let batch_size = number(reading, "BatchSize", 1, 10_000, "messages", DEFAULT_BATCH_SIZE);
    let batching_window = number(reading, "MaximumBatchingWindowInSeconds", 0, 300, "seconds", 0);
    if let (Some(batch), Some(0)) = (batch_size, batching_window)
        && batch > DEFAULT_BATCH_SIZE
    {
        reading.problem(
            &format!("{at}/BatchSize"),
            format!(
                "event {event}'s BatchSize {batch}: over {DEFAULT_BATCH_SIZE} needs a \
                 MaximumBatchingWindowInSeconds of 1 to 300, as Lambda's"
            ),
        );
    }
    let types_at = format!("{at}/FunctionResponseTypes");
    let report_batch_item_failures = match reading.has(&types_at) {
        true => {
            let types = reading.known(&types_at);
            let listed = types.as_ref().and_then(Value::as_array).filter(|types| {
                types.len() <= 1 && types.iter().all(|kind| kind.as_str() == Some(REPORT_BATCH_ITEM_FAILURES))
            });
            if types.is_some() && listed.is_none() {
                reading.problem(
                    &types_at,
                    format!("event {event}'s FunctionResponseTypes: [{REPORT_BATCH_ITEM_FAILURES}] or none, Lambda's for SQS"),
                );
            }
            listed.is_some_and(|types| !types.is_empty())
        }
        false => false,
    };
    let max_concurrency = match reading.has(&format!("{at}/ScalingConfig/MaximumConcurrency")) {
        true => reading.number(&format!("{at}/ScalingConfig/MaximumConcurrency"), 2, 1000, "batches"),
        false => None,
    };
    let enabled = match reading.has(&format!("{at}/Enabled")) {
        true => reading.flag(&format!("{at}/Enabled")).unwrap_or(true),
        false => true,
    };
    Some(Mapping {
        event: event.to_owned(),
        queue_arn,
        batch_size: batch_size?,
        batching_window: batching_window?,
        report_batch_item_failures,
        max_concurrency,
        enabled,
    })
}

/// A function of the template as FF makes it; the notifications its S3 events give the template's buckets in `s3`.
fn function(
    reading: &mut Reading,
    name: String,
    folder: &Path,
    place: &Place,
    policies: Policies,
    s3: &mut Vec<(String, Notification)>,
) -> Option<Function> {
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
    let mut events = events(reading, place, &place.arn(&qualified(&name, alias.as_deref())));
    s3.append(&mut events.s3);
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
        // An HttpApi's routes go to the function's URL, which anyone may call, as the API's routes have no Auth.
        None if events.http_api => Some(Url { auth_type: "NONE".to_owned(), cors: None }),
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
        schedules: events.schedules,
        mappings: events.mappings,
        policies,
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

/// How the template's resources of a type are named on FF: the property that names one, what it is in words, the rule
/// its name keeps, the most characters a name has, CloudFormation's included, and whether CloudFormation writes its
/// names in lower case, as it does a bucket's.
struct Naming {
    kind: &'static str,
    property: &'static str,
    what: &'static str,
    valid: fn(&str) -> bool,
    rule: &'static str,
    most: usize,
    lower_case: bool,
}

const FUNCTIONS: Naming = Naming {
    kind: FUNCTION,
    property: "FunctionName",
    what: "function",
    valid: is_function_name,
    rule: "1 to 64 letters, digits, hyphens or underscores, as Lambda's",
    most: 64,
    lower_case: false,
};

const QUEUES: Naming = Naming {
    kind: QUEUE,
    property: "QueueName",
    what: "queue",
    valid: is_queue_name,
    rule: "1 to 80 letters, digits, hyphens or underscores, as SQS's",
    most: 80,
    lower_case: false,
};

const BUCKETS: Naming = Naming {
    kind: BUCKET,
    property: "BucketName",
    what: "bucket",
    valid: is_bucket_name,
    rule: "3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as S3's, without dots \
           on FF",
    most: 63,
    lower_case: true,
};

/// Each resource's name: its own property's, else the one the stack's last deploy gave it, else one CloudFormation's
/// way.
fn names(
    naming: &Naming,
    template: &Value,
    ids: &[String],
    known: &Known,
    last: &[StackResource],
    suffix: &mut dyn FnMut() -> String,
    problems: &mut Problems,
) -> BTreeMap<String, String> {
    let Naming { kind, property, what, valid, rule, most, lower_case } = naming;
    let mut names = BTreeMap::new();
    for id in ids {
        let pointer = format!("/Resources/{id}/Properties/{property}");
        let name = match template.pointer(&pointer).map(|value| known.resolve(value)) {
            Some(Value::String(name)) if valid(&name) => name,
            Some(value) => {
                let value = text(&value).unwrap_or_else(|| value.to_string());
                problems.push((pointer, format!("{id}: {property} {value}: {rule}, known before the deploy")));
                continue;
            }
            None => {
                let kept = last.iter().find(|resource| resource.logical_id == *id && resource.kind == *kind);
                match kept.and_then(|resource| resource.physical_id.clone()) {
                    Some(name) => name,
                    None => {
                        let made = generated_name(known.place.stack, id, &suffix(), *most);
                        let made = if *lower_case { made.to_ascii_lowercase() } else { made };
                        if !valid(&made) {
                            problems.push((
                                format!("/Resources/{id}"),
                                format!("{id}: CloudFormation's way names it {made}, which is no {what}'s name: {rule}; give it a {property}"),
                            ));
                            continue;
                        }
                        made
                    }
                }
            }
        };
        if let Some((other, _)) = names.iter().find(|(_, taken)| **taken == name) {
            problems.push((pointer, format!("{id}: {property} {name} is {other}'s too: a {what}'s name is its own")));
            continue;
        }
        names.insert(id.clone(), name);
    }
    names
}

/// A queue of the template as FF's API takes it: SQS's attributes, its redrive policy to another queue of the
/// account, and its tags.
fn queue(reading: &mut Reading, name: String, place: &Place, policies: Policies) -> Option<Queue> {
    let mut attributes = Map::new();
    let mut complete = true;
    for (property, field, least, most, unit, default) in QUEUE_ATTRIBUTES {
        let value = if reading.has(property) { reading.number(property, least, most, unit) } else { Some(default) };
        match value {
            Some(value) => {
                attributes.insert(field.to_owned(), value.into());
            }
            None => complete = false,
        }
    }
    let redrive = match reading.has("RedrivePolicy") {
        true => redrive_policy(reading, &name, place),
        false => Some(Value::Null),
    };
    let tags = if reading.has("Tags") { reading.tag_list("Tags") } else { BTreeMap::new() };
    attributes.insert("redrivePolicy".to_owned(), redrive?);
    complete.then(|| Queue { id: reading.id.to_owned(), name, attributes: Value::Object(attributes), tags, policies })
}

/// A queue's RedrivePolicy as FF's API takes it: another queue of the account, by its ARN, and the receives a message
/// has before it goes there.
fn redrive_policy(reading: &mut Reading, name: &str, place: &Place) -> Option<Value> {
    let target_at = "RedrivePolicy/deadLetterTargetArn";
    let count_at = "RedrivePolicy/maxReceiveCount";
    let target = reading.needed(target_at, "the dead-letter queue's ARN");
    let count = match reading.has(count_at) {
        true => reading.number(count_at, 1, 1000, "receives"),
        false => {
            reading.needed(count_at, "the receives a message has before it goes there, 1 to 1000");
            None
        }
    };
    let target = target?;
    match place.queue_of(&target) {
        None => {
            let arn = place.queue_arn("<name>");
            reading
                .problem(target_at, format!("{} {target}: the ARN of a queue of the account, {arn}", said(target_at)));
            return None;
        }
        Some(dead_letter) if dead_letter == name => {
            let message =
                format!("{} names the queue itself: its dead-letter queue is another, as SQS's", said(target_at));
            reading.problem(target_at, message);
            return None;
        }
        Some(_) => {}
    }
    Some(json!({ "deadLetterTargetArn": target, "maxReceiveCount": count? }))
}

/// The queues, each dead-letter queue of the template before those that move messages to it, which FF's API wants
/// made first; a circle of them refused, as CloudFormation refuses one.
fn dead_letters_first(queues: Vec<Queue>, problems: &mut Problems) -> Vec<Queue> {
    let dead_letter: BTreeMap<&str, &str> =
        queues.iter().filter_map(|queue| Some((queue.name.as_str(), queue.dead_letter()?))).collect();
    // How many of the template's queues a queue's messages may go through after it: none for a queue that moves none.
    let depth = |name: &str| {
        let (mut at, mut depth) = (name, 0);
        while let Some(next) = dead_letter.get(at) {
            depth += 1;
            if depth > dead_letter.len() {
                return None;
            }
            at = next;
        }
        Some(depth)
    };
    let depths: Vec<Option<usize>> = queues.iter().map(|queue| depth(&queue.name)).collect();
    let mut ordered = Vec::new();
    for (queue, depth) in queues.into_iter().zip(depths) {
        match depth {
            Some(depth) => ordered.push((depth, queue)),
            None => problems.push((
                format!("/Resources/{}/Properties/RedrivePolicy", queue.id),
                format!(
                    "{}: RedrivePolicy's dead-letter queues go round in a circle, which CloudFormation refuses",
                    queue.id
                ),
            )),
        }
    }
    ordered.sort_by_key(|(depth, _)| *depth);
    ordered.into_iter().map(|(_, queue)| queue).collect()
}

/// A bucket of the template as FF's API takes it: its tags, its NotificationConfiguration's functions and queues of the
/// account, and its site.
fn bucket(reading: &mut Reading, name: String, place: &Place, policies: Policies) -> Option<Bucket> {
    let tags = if reading.has("Tags") { reading.tag_list("Tags") } else { BTreeMap::new() };
    let mut complete = true;
    let mut notifications = Vec::new();
    let kinds = [
        ("LambdaConfigurations", Target::Function, "Function", "Lambda"),
        ("QueueConfigurations", Target::Queue, "Queue", "Queue"),
    ];
    for (key, target, field, short) in kinds {
        let path = format!("NotificationConfiguration/{key}");
        if !reading.has(&path) {
            continue;
        }
        let Some(listed) = reading.known(&path) else {
            complete = false;
            continue;
        };
        let Some(listed) = listed.as_array() else {
            reading.problem(&path, format!("{} is a list of configurations", said(&path)));
            complete = false;
            continue;
        };
        let mut own: Vec<Notification> = Vec::new();
        for index in 0..listed.len() {
            let at = format!("{path}/{index}");
            let events = event_types(reading, &format!("{at}/Event"));
            let arn_at = format!("{at}/{field}");
            let (what, wanted) = match target {
                Target::Function => ("function", place.arn("<name>")),
                Target::Queue => ("queue", place.queue_arn("<name>")),
            };
            let arn = reading.needed(&arn_at, &format!("the {what}'s ARN")).filter(|arn| {
                let of_the_account = match target {
                    Target::Function => place.function_of(arn).is_some(),
                    Target::Queue => place.queue_of(arn).is_some(),
                };
                if !of_the_account {
                    reading.problem(
                        &arn_at,
                        format!("{} {arn}: the ARN of a {what} of the account, {wanted}", said(&arn_at)),
                    );
                }
                of_the_account
            });
            let filter = key_filter(reading, &format!("{at}/Filter"));
            let (Some(events), Some(arn), Some((prefix, suffix))) = (events, arn, filter) else {
                complete = false;
                continue;
            };
            // CloudFormation takes one event a configuration, where S3's API takes a list: those of one destination
            // and one filter are one configuration on FF.
            match own.iter_mut().find(|other| (&other.arn, &other.prefix, &other.suffix) == (&arn, &prefix, &suffix)) {
                Some(same) => {
                    for event in events {
                        if !same.events.contains(&event) {
                            same.events.push(event);
                        }
                    }
                }
                None => own.push(Notification {
                    id: format!("{}{short}{}", reading.id, own.len() + 1),
                    target,
                    arn,
                    events,
                    prefix,
                    suffix,
                    at: format!("{}/{at}", reading.pointer),
                }),
            }
        }
        notifications.extend(own);
    }
    let website = match reading.has("WebsiteConfiguration") {
        true => {
            let website = website(reading);
            complete &= website.is_some();
            website
        }
        false => None,
    };
    complete.then(|| Bucket { id: reading.id.to_owned(), name, tags, notifications, website, policies })
}

/// A bucket's WebsiteConfiguration: its IndexDocument, a name without a slash, and its ErrorDocument, an object's key.
fn website(reading: &mut Reading) -> Option<Website> {
    let index_at = "WebsiteConfiguration/IndexDocument";
    let error_at = "WebsiteConfiguration/ErrorDocument";
    let index = reading.needed(index_at, "the name a folder's path answers, such as index.html");
    let index = index.filter(|index| {
        let fine = (1..=MOST_KEY).contains(&index.chars().count()) && !index.contains('/');
        if !fine {
            let message = format!(
                "{} {index}: a name of 1 to {MOST_KEY} characters without a slash, such as index.html, as S3's",
                said(index_at)
            );
            reading.problem(index_at, message);
        }
        fine
    });
    let error = match reading.has(error_at) {
        true => {
            let error = reading.text(error_at);
            let error = error.filter(|error| {
                let fine = (1..=MOST_KEY).contains(&error.chars().count());
                if !fine {
                    reading.problem(
                        error_at,
                        format!("{} is an object's key, 1 to {MOST_KEY} characters", said(error_at)),
                    );
                }
                fine
            });
            Some(error?)
        }
        false => None,
    };
    Some(Website { index_document: index?, error_document: error })
}

/// A bucket's notifications refused as S3 refuses them: more than it keeps, or two that could take one event.
fn check_notifications(bucket: &Bucket, problems: &mut Problems) {
    let (id, notifications) = (&bucket.id, &bucket.notifications);
    if notifications.len() > MOST_NOTIFICATIONS {
        problems.push((
            format!("/Resources/{id}/Properties/NotificationConfiguration"),
            format!(
                "{id}: {} notifications, its own and its functions' S3 events: S3 keeps {MOST_NOTIFICATIONS} at most",
                notifications.len()
            ),
        ));
    }
    for (index, one) in notifications.iter().enumerate() {
        for other in notifications[index + 1..].iter().filter(|other| one.overlaps(other)) {
            problems.push((
                other.at.clone(),
                format!(
                    "{id}: the notifications {} and {} could both take one event, which S3 refuses as ambiguous: \
                     give them events, prefixes or suffixes that don't overlap",
                    one.id, other.id
                ),
            ));
        }
    }
}

/// The template's functions, queues and buckets as FF makes them, from its folder, its parameters' values and the
/// stack's last deploy; or every problem found, each at its pointer. `suffix` gives a new name's random part.
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
    let (ids, queue_ids, bucket_ids) = (of_type(FUNCTION), of_type(QUEUE), of_type(BUCKET));
    let mut without_effect = Vec::new();
    for kind in [PERMISSION, QUEUE_POLICY, BUCKET_POLICY] {
        without_effect.extend(of_type(kind).into_iter().map(|id| StackResource {
            deletion_policy: Policies::of(&resources[&id]).deletion,
            logical_id: id,
            kind: kind.to_owned(),
            physical_id: None,
        }));
    }
    let mut problems = Problems::new();
    let mut known = Known::new(place, values, place.sqs_function_endpoint);
    let function_names = names(&FUNCTIONS, &merged, &ids, &known, last, suffix, &mut problems);
    known.queues = names(&QUEUES, &merged, &queue_ids, &known, last, suffix, &mut problems);
    known.buckets = names(&BUCKETS, &merged, &bucket_ids, &known, last, suffix, &mut problems);
    for id in &ids {
        let Some(name) = function_names.get(id) else { continue };
        let alias = merged
            .pointer(&format!("/Resources/{id}/Properties/AutoPublishAlias"))
            .and_then(|value| text(&known.resolve(value)));
        known.functions.insert(id.clone(), Made { name: name.clone(), alias, ..Made::default() });
    }
    // Resolved as functions see it: a queue's URL is the one they reach, inside the cluster.
    let resolved = known.resolve(&merged);
    let empty = Map::new();
    let mut functions = Vec::new();
    let mut s3_events = Vec::new();
    for id in &ids {
        let Some(name) = function_names.get(id) else { continue };
        let mut reading = Reading::of(&resolved, &empty, id, "the function");
        let policies = Policies::of(&resources[id]);
        let function = function(&mut reading, name.clone(), folder, place, policies, &mut s3_events);
        problems.append(&mut reading.problems);
        functions.extend(function);
    }
    let mut queues = Vec::new();
    for id in &queue_ids {
        let Some(name) = known.queues.get(id) else { continue };
        let mut reading = Reading::of(&resolved, &empty, id, "the queue");
        let queue = queue(&mut reading, name.clone(), place, Policies::of(&resources[id]));
        problems.append(&mut reading.problems);
        queues.extend(queue);
    }
    let queues = dead_letters_first(queues, &mut problems);
    let mut buckets = Vec::new();
    for id in &bucket_ids {
        let Some(name) = known.buckets.get(id) else { continue };
        let mut reading = Reading::of(&resolved, &empty, id, "the bucket");
        let bucket = bucket(&mut reading, name.clone(), place, Policies::of(&resources[id]));
        problems.append(&mut reading.problems);
        buckets.extend(bucket);
    }
    // An S3 event's Bucket is one of the template's, which the subset's check says otherwise.
    for (name, notification) in s3_events {
        if let Some(bucket) = buckets.iter_mut().find(|bucket| bucket.name == name) {
            bucket.notifications.push(notification);
        }
    }
    for bucket in &buckets {
        check_notifications(bucket, &mut problems);
    }
    match problems.is_empty() {
        true => Ok(Plan { functions, queues, buckets, without_effect }),
        false => Err(problems),
    }
}

/// What the stack's last deploy made that this one doesn't, a function's own resources going with it.
#[derive(Debug, Default, PartialEq)]
pub struct Removed {
    /// Each to delete, a URL first, then a function, then a bucket, the queues last.
    pub deleted: Vec<StackResource>,
    /// Each its template said to retain, left in the account, out of the stack.
    pub kept: Vec<StackResource>,
}

/// What the stack's last deploy made that this one doesn't, by type and FF resource, split by its policy as
/// CloudFormation's: the last template's DeletionPolicy, else, for a resource that one of another name replaces under
/// its logical ID, that one's UpdateReplacePolicy, from `replacing`. A Schedule event's rule and a ScheduleV2 event's
/// schedule are one schedule of the function on FF: an event that changes from one to the other keeps it.
pub fn removed(
    last: &[StackResource],
    next: &[StackResource],
    replacing: &BTreeMap<String, DeletionPolicy>,
) -> Removed {
    let on_ff = |kind: &str| if kind == RULE { SCHEDULE.to_owned() } else { kind.to_owned() };
    let identity = |resource: &StackResource| Some((on_ff(&resource.kind), resource.physical_id.clone()?));
    let kept: BTreeSet<(String, String)> = next.iter().filter_map(identity).collect();
    let gone: Vec<&StackResource> =
        last.iter().filter(|resource| identity(resource).is_some_and(|identity| !kept.contains(&identity))).collect();
    let functions_gone: BTreeSet<&str> = gone
        .iter()
        .filter(|resource| resource.kind == FUNCTION)
        .filter_map(|resource| resource.physical_id.as_deref())
        .collect();
    // The buckets and the queues last, a function reading a queue or sending to it what it failed, and a bucket
    // telling one of its events.
    let order = [URL, EVENT_INVOKE_CONFIG, RULE, SCHEDULE, MAPPING, ALIAS, FUNCTION, BUCKET, QUEUE];
    let rank = |kind: &str| order.iter().position(|of| *of == kind).unwrap_or(0);
    let mut removed: Vec<StackResource> = gone
        .into_iter()
        .filter(|resource| {
            !OF_A_FUNCTION.contains(&resource.kind.as_str()) || !functions_gone.contains(function_of(resource))
        })
        .cloned()
        .collect();
    removed.sort_by_key(|resource| rank(&resource.kind));
    let (kept, deleted) = removed.into_iter().partition(|resource| {
        replacing.get(&resource.logical_id).copied().unwrap_or(resource.deletion_policy) == DeletionPolicy::Retain
    });
    Removed { deleted, kept }
}

/// The function a resource of the stack belongs to: its physical ID's name, before a version's or an alias's colon.
pub fn function_of(resource: &StackResource) -> &str {
    let id = resource.physical_id.as_deref().unwrap_or("");
    id.split(':').next().unwrap_or(id)
}

/// A resource of the stack in words, for a question and a report: `the function orders (Orders)`.
pub fn in_words(resource: &StackResource) -> String {
    let id = resource.physical_id.as_deref().unwrap_or("");
    let (function, named) = id.split_once(':').unwrap_or((id, ""));
    let what = match resource.kind.as_str() {
        FUNCTION => format!("the function {id}"),
        URL => format!("{id}'s URL"),
        ALIAS => format!("the alias {id}"),
        EVENT_INVOKE_CONFIG => format!("{id}'s asynchronous calls' settings"),
        RULE | SCHEDULE => format!("{function}'s schedule {named}"),
        MAPPING => format!("{function}'s reading of the queue {named}"),
        QUEUE => format!("the queue {id}"),
        BUCKET => format!("the bucket {id}"),
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

    const PLACE: Place = Place {
        stack: "shop",
        region: "tn-tunis-1",
        account: "000000000001",
        sqs_endpoint: "https://sqs.ffunc.cloud",
        sqs_function_endpoint: "http://10.43.0.251:3003",
        s3_endpoint: "https://s3.ffunc.cloud",
    };

    /// A template's folder: a function's code as a folder and as a .zip, and the code ff export's template names.
    fn folder() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("orders")).unwrap();
        std::fs::write(dir.path().join("reports.zip"), "PK").unwrap();
        std::fs::create_dir(dir.path().join("code")).unwrap();
        for function in ["make-thumbnail", "report_v1", "send-receipts"] {
            std::fs::write(dir.path().join(format!("code/{function}.zip")), "PK").unwrap();
        }
        dir
    }

    /// The plan of a template, its parameters' values the given, else their Default, as `ff deploy` takes them.
    fn planned(text: &str, last: &[StackResource], values: &[(&str, &str)]) -> Result<Plan, Problems> {
        let dir = folder();
        let template = read(text).unwrap();
        let given: Vec<(String, String)> =
            values.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        let values = crate::sam::parameters::values(&template, &given).values;
        let mut n = 0;
        plan(&template, &values, &PLACE, last, dir.path(), &mut || {
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
        StackResource {
            logical_id: logical_id.into(),
            kind: kind.into(),
            physical_id: physical_id.map(str::to_owned),
            deletion_policy: DeletionPolicy::Delete,
        }
    }

    fn retained(logical_id: &str, kind: &str, physical_id: Option<&str>) -> StackResource {
        StackResource { deletion_policy: DeletionPolicy::Retain, ..resource(logical_id, kind, physical_id) }
    }

    fn by_logical_id(policies: &[(&str, DeletionPolicy)]) -> BTreeMap<String, DeletionPolicy> {
        policies.iter().map(|(id, policy)| (id.to_string(), *policy)).collect()
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
                schedules: vec![],
                mappings: vec![],
                policies: Policies::default(),
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
        let long = generated_name(&"s".repeat(128), "OrdersFunction", "ABCDEFGHIJKL", 64);
        assert_eq!((long.len(), long.ends_with("-OrdersFunction-ABCDEFGHIJKL")), (64, true));
        let both = generated_name("shop-in-tunis-and-sfax-and-sousse", &"F".repeat(40), "ABCDEFGHIJKL", 64);
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
        Uploads:
          Type: S3
          Properties:
            Bucket: !Ref Uploads
            Events: s3:ObjectCreated:*
  Twin:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: orders
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
  Uploads:
    Type: AWS::S3::Bucket
";
        let problems = planned(template, &[], &[]).unwrap_err();

        let props = "/Resources/Orders/Properties";
        assert_eq!(
            problems,
            [
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

    /// A function's events, a fixture `sam validate --lint` takes.
    const EVENTS: &str = include_str!("testdata/events.yaml");

    #[test]
    fn makes_a_functions_schedules_and_the_queues_it_reads_of_its_events_and_its_http_api_routes_its_url() {
        let plan = planned(EVENTS, &[], &[("Jobs", "jobs")]).unwrap();

        let [orders, api] = &plan.functions[..] else { panic!("{plan:?}") };
        assert_eq!(
            orders.schedules,
            [
                Schedule {
                    event: "Hourly".into(),
                    kind: SCHEDULE,
                    name: "orders-hourly".into(),
                    expression: "rate(1 hour)".into(),
                    description: None,
                    input: None,
                    enabled: false,
                },
                Schedule {
                    event: "Nightly".into(),
                    kind: RULE,
                    name: "Nightly".into(),
                    expression: "cron(0 2 * * ? *)".into(),
                    description: Some("The night's report".into()),
                    input: Some(json!({ "report": "daily" })),
                    enabled: true,
                },
            ]
        );
        let jobs = Mapping {
            event: "Jobs".into(),
            queue_arn: "arn:aws:sqs:tn-tunis-1:000000000001:jobs".into(),
            batch_size: 100,
            batching_window: 5,
            report_batch_item_failures: true,
            max_concurrency: Some(2),
            enabled: false,
        };
        assert_eq!(orders.mappings, [jobs]);
        assert_eq!(orders.url, None);
        // Lambda's defaults where the event says nothing.
        let failed = Mapping {
            event: "Failed".into(),
            queue_arn: "arn:aws:sqs:tn-tunis-1:000000000001:failed".into(),
            batch_size: 10,
            batching_window: 0,
            report_batch_item_failures: false,
            max_concurrency: None,
            enabled: true,
        };
        assert_eq!((api.mappings.as_slice(), api.schedules.is_empty()), ([failed].as_slice(), true));
        assert_eq!(api.url, Some(Url { auth_type: "NONE".into(), cors: None }));
        assert_eq!(
            plan.resources(),
            [
                resource("Orders", FUNCTION, Some("orders")),
                resource("OrdersAliaslive", ALIAS, Some("orders:live")),
                resource("OrdersHourly", SCHEDULE, Some("orders:orders-hourly")),
                resource("OrdersNightly", RULE, Some("orders:Nightly")),
                resource("OrdersJobs", MAPPING, Some("orders:jobs")),
                resource("Api", FUNCTION, Some("orders-api")),
                resource("ApiUrl", URL, Some("orders-api")),
                resource("ApiFailed", MAPPING, Some("orders-api:failed")),
            ]
        );
    }

    #[test]
    fn says_what_ff_cant_make_of_an_event_at_its_property() {
        let template = "\
Transform: AWS::Serverless-2016-10-31
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: orders
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
      Events:
        Once:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: at(2026-12-01T08:00:00)
        Bad:
          Type: Schedule
          Properties:
            Schedule: rate(1 day)
            Name: a/b
            Input: '{not json'
            State: PAUSED
        Twin:
          Type: Schedule
          Properties:
            Schedule: rate(2 days)
            Name: Once
        Empty:
          Type: Schedule
          Properties: {}
        Elsewhere:
          Type: SQS
          Properties:
            Queue: arn:aws:sqs:eu-west-3:123456789012:jobs
            BatchSize: 50
            FunctionResponseTypes: [Other]
        Jobs:
          Type: SQS
          Properties:
            Queue: arn:aws:sqs:tn-tunis-1:000000000001:jobs
        Typed:
          Type: SQS
          Properties:
            Queue: arn:aws:sqs:tn-tunis-1:000000000001:typed
            BatchSize: '5'
        Again:
          Type: SQS
          Properties:
            Queue: arn:aws:sqs:tn-tunis-1:000000000001:jobs
            Enabled: maybe
";
        let problems = planned(template, &[], &[]).unwrap_err();

        let events = "/Resources/Orders/Properties/Events";
        let expected = [
            ("Again/Properties/Enabled", "event Again's Enabled \"maybe\": true or false, as SAM's transform takes it, not text"),
            ("Bad/Properties/Name", "event Bad's schedule a/b: a schedule's name, its Name or else the event's key, is 1 to 64 letters, digits, '.', '-' and '_', as EventBridge's"),
            ("Bad/Properties/Input", "event Bad's Input is JSON text, as EventBridge's: key must be a string at line 1 column 2"),
            ("Bad/Properties/State", "event Bad's State PAUSED: ENABLED or DISABLED"),
            ("Elsewhere/Properties/Queue", "event Elsewhere's Queue arn:aws:sqs:eu-west-3:123456789012:jobs: the ARN of a queue of the account, arn:aws:sqs:tn-tunis-1:000000000001:<name>"),
            ("Elsewhere/Properties/BatchSize", "event Elsewhere's BatchSize 50: over 10 needs a MaximumBatchingWindowInSeconds of 1 to 300, as Lambda's"),
            ("Elsewhere/Properties/FunctionResponseTypes", "event Elsewhere's FunctionResponseTypes: [ReportBatchItemFailures] or none, Lambda's for SQS"),
            ("Empty/Properties/Schedule", "event Empty needs its Schedule: rate(…) or cron(…), as EventBridge's"),
            ("Jobs/Properties/Queue", "event Jobs reads the queue jobs, as event Again does: Lambda has a function read a queue once"),
            ("Once/Properties/ScheduleExpression", "event Once's ScheduleExpression at(2026-12-01T08:00:00) runs once, which FF's schedules don't: rate(…) or cron(…)"),
            ("Twin/Properties", "event Twin's schedule Once is event Once's too: a function's schedule has a name of its own"),
            ("Typed/Properties/BatchSize", "event Typed's BatchSize \"5\": a number, as SAM's transform takes it, not text"),
        ]
        .map(|(at, message)| (format!("{events}/{at}"), format!("Orders: {message}")));
        assert_eq!(problems, expected);
    }

    /// A template's queues and a function using them, a fixture `sam validate --lint` takes.
    const WITH_QUEUES: &str = include_str!("testdata/queues.yaml");

    #[test]
    fn makes_a_templates_queues_each_dead_letter_queue_first_its_functions_reaching_them_inside_the_cluster() {
        let plan = planned(WITH_QUEUES, &[], &[]).unwrap();

        let arn = |name: &str| format!("arn:aws:sqs:tn-tunis-1:000000000001:{name}");
        let jobs = "shop-Jobs-SUFFIX000001";
        let kept = Policies { deletion: DeletionPolicy::Retain, update_replace: DeletionPolicy::Retain };
        assert_eq!(
            plan.queues,
            [
                Queue {
                    id: "JobsFailed".into(),
                    name: "jobs-failed".into(),
                    // SQS's defaults where the template says nothing.
                    attributes: json!({
                        "visibilityTimeout": 30,
                        "messageRetentionPeriod": 1_209_600,
                        "delaySeconds": 0,
                        "maximumMessageSize": 1_048_576,
                        "receiveMessageWaitTimeSeconds": 0,
                        "redrivePolicy": null,
                    }),
                    tags: BTreeMap::new(),
                    policies: kept,
                },
                Queue {
                    id: "Jobs".into(),
                    name: jobs.into(),
                    attributes: json!({
                        "visibilityTimeout": 60,
                        "messageRetentionPeriod": 345_600,
                        "delaySeconds": 0,
                        "maximumMessageSize": 1_048_576,
                        "receiveMessageWaitTimeSeconds": 20,
                        "redrivePolicy": { "deadLetterTargetArn": arn("jobs-failed"), "maxReceiveCount": 5 },
                    }),
                    tags: [("team".to_owned(), "shop".to_owned())].into(),
                    policies: Policies::default(),
                },
            ]
        );
        let [worker] = &plan.functions[..] else { panic!("{plan:?}") };
        let inside = "http://10.43.0.251:3003/000000000001";
        let variables = [
            ("FAILED_NAME", "jobs-failed".to_owned()),
            ("FAILED_URL", format!("{inside}/jobs-failed")),
            ("JOBS_URL", format!("{inside}/{jobs}")),
        ];
        assert_eq!(worker.environment, variables.map(|(name, value)| (name.to_owned(), value)).into());
        assert_eq!(worker.dead_letter, Some(arn("jobs-failed")));
        let queues_read: Vec<&str> = worker.mappings.iter().map(|mapping| mapping.queue_arn.as_str()).collect();
        assert_eq!(queues_read, [arn(jobs)]);
        assert_eq!(
            plan.resources(),
            [
                resource("Worker", FUNCTION, Some("worker")),
                resource("WorkerJobs", MAPPING, Some(&format!("worker:{jobs}"))),
                retained("JobsFailed", QUEUE, Some("jobs-failed")),
                resource("Jobs", QUEUE, Some(jobs)),
                resource("JobsPolicy", QUEUE_POLICY, None),
            ]
        );
        // An output gives a queue's public URL, which a client outside the cluster sends to.
        let values = BTreeMap::new();
        let known = Known {
            queues: plan.queues.iter().map(|queue| (queue.id.clone(), queue.name.clone())).collect(),
            ..Known::new(&PLACE, &values, PLACE.sqs_endpoint)
        };
        assert_eq!(
            outputs(&read(WITH_QUEUES).unwrap(), &known),
            [
                Output {
                    name: "JobsUrl".into(),
                    value: format!("https://sqs.ffunc.cloud/000000000001/{jobs}").into(),
                    description: Some("Where the jobs are sent".into()),
                },
                Output { name: "JobsArn".into(), value: arn(jobs).into(), description: None },
            ]
        );
    }

    #[test]
    fn says_what_ff_cant_make_of_a_queue_at_its_property() {
        let template = "\
Transform: AWS::Serverless-2016-10-31
Resources:
  Named:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs.fifo
  Twin:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs
  Again:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs
  Bounds:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 50000
      MaximumMessageSize: 100
      Tags: {team: shop}
  Tagged:
    Type: AWS::SQS::Queue
    Properties:
      Tags:
        - Key: team
  Elsewhere:
    Type: AWS::SQS::Queue
    Properties:
      RedrivePolicy:
        deadLetterTargetArn: arn:aws:sqs:eu-west-3:123456789012:failed
        maxReceiveCount: 2000
  Itself:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: itself
      RedrivePolicy:
        deadLetterTargetArn: arn:aws:sqs:tn-tunis-1:000000000001:itself
  Ping:
    Type: AWS::SQS::Queue
    Properties:
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt Pong.Arn
        maxReceiveCount: 3
  Pong:
    Type: AWS::SQS::Queue
    Properties:
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt Ping.Arn
        maxReceiveCount: 3
";
        let problems = planned(template, &[], &[]).unwrap_err();

        let expected = [
            ("Named/Properties/QueueName", "Named: QueueName jobs.fifo: 1 to 80 letters, digits, hyphens or underscores, as SQS's, known before the deploy"),
            ("Again/Properties/QueueName", "Again: QueueName jobs is Twin's too: a queue's name is its own"),
            ("Bounds/Properties/VisibilityTimeout", "Bounds: VisibilityTimeout 50000: a whole number of seconds from 0 to 43200"),
            ("Bounds/Properties/MaximumMessageSize", "Bounds: MaximumMessageSize 100: a whole number of bytes from 1024 to 1048576"),
            ("Bounds/Properties/Tags", "Bounds: Tags is a list of a Key and a Value each"),
            ("Tagged/Properties/Tags/0", "Tagged: Tags 0 is a Key and a Value, both text"),
            ("Elsewhere/Properties/RedrivePolicy/maxReceiveCount", "Elsewhere: RedrivePolicy.maxReceiveCount 2000: a whole number of receives from 1 to 1000"),
            ("Elsewhere/Properties/RedrivePolicy/deadLetterTargetArn", "Elsewhere: RedrivePolicy.deadLetterTargetArn arn:aws:sqs:eu-west-3:123456789012:failed: the ARN of a queue of the account, arn:aws:sqs:tn-tunis-1:000000000001:<name>"),
            ("Itself/Properties/RedrivePolicy/maxReceiveCount", "Itself: RedrivePolicy needs its maxReceiveCount: the receives a message has before it goes there, 1 to 1000"),
            ("Itself/Properties/RedrivePolicy/deadLetterTargetArn", "Itself: RedrivePolicy.deadLetterTargetArn names the queue itself: its dead-letter queue is another, as SQS's"),
            ("Ping/Properties/RedrivePolicy", "Ping: RedrivePolicy's dead-letter queues go round in a circle, which CloudFormation refuses"),
            ("Pong/Properties/RedrivePolicy", "Pong: RedrivePolicy's dead-letter queues go round in a circle, which CloudFormation refuses"),
        ]
        .map(|(at, message)| (format!("/Resources/{at}"), message.to_owned()));
        assert_eq!(problems, expected);
    }

    #[test]
    fn deletes_a_templates_queues_after_its_functions_and_leaves_those_it_retains() {
        // A queue of a deleted function's name is a queue still, deleted on its own.
        let last = [
            resource("Worker", FUNCTION, Some("jobs")),
            resource("WorkerJobs", MAPPING, Some("jobs:jobs")),
            resource("JobsFailed", QUEUE, Some("jobs-failed")),
            resource("Jobs", QUEUE, Some("jobs")),
            retained("Kept", QUEUE, Some("kept")),
            resource("JobsPolicy", QUEUE_POLICY, None),
        ];

        let removed = removed(&last, &[], &BTreeMap::new());

        let deleted = [
            resource("Worker", FUNCTION, Some("jobs")),
            resource("JobsFailed", QUEUE, Some("jobs-failed")),
            resource("Jobs", QUEUE, Some("jobs")),
        ];
        assert_eq!(removed, Removed { deleted: deleted.into(), kept: [retained("Kept", QUEUE, Some("kept"))].into() });
    }

    /// A template's buckets, a fixture `sam validate --lint` takes.
    const WITH_BUCKETS: &str = include_str!("testdata/buckets.yaml");

    #[test]
    fn makes_a_templates_buckets_their_sites_and_their_notifications_their_functions_s3_events_among_them() {
        let plan = planned(WITH_BUCKETS, &[], &[]).unwrap();

        // Named in the template's order: the function, the queue, then the bucket, in lower case as CloudFormation's.
        let (resizer, removed_queue, photos) =
            ("shop-Resizer-SUFFIX000001", "shop-Removed-SUFFIX000002", "shop-photos-suffix000003");
        let queue_arn = format!("arn:aws:sqs:tn-tunis-1:000000000001:{removed_queue}");
        let configurations = "/Resources/Photos/Properties/NotificationConfiguration/QueueConfigurations";
        let rule = |name: &str, value: &str| json!({ "name": name, "value": value });
        assert_eq!(
            plan.buckets,
            [
                Bucket {
                    id: "Site".into(),
                    name: "shop-site".into(),
                    tags: BTreeMap::new(),
                    notifications: Vec::new(),
                    website: Some(Website {
                        index_document: "index.html".into(),
                        error_document: Some("404.html".into())
                    }),
                    policies: Policies::default(),
                },
                Bucket {
                    id: "Photos".into(),
                    name: photos.into(),
                    tags: [("team".to_owned(), "shop".to_owned())].into(),
                    notifications: vec![
                        // Two configurations of one queue and no filter: one configuration of two events.
                        Notification {
                            id: "PhotosQueue1".into(),
                            target: Target::Queue,
                            arn: queue_arn.clone(),
                            events: vec![
                                "s3:ObjectRemoved:Delete".into(),
                                "s3:ObjectRemoved:DeleteMarkerCreated".into()
                            ],
                            prefix: None,
                            suffix: None,
                            at: format!("{configurations}/0"),
                        },
                        Notification {
                            id: "PhotosQueue2".into(),
                            target: Target::Queue,
                            arn: queue_arn.clone(),
                            events: vec!["s3:ObjectCreated:*".into()],
                            prefix: None,
                            suffix: Some(".tmp".into()),
                            at: format!("{configurations}/2"),
                        },
                        // The function's S3 event calls its alias, as SAM's.
                        Notification {
                            id: "ResizerUpload".into(),
                            target: Target::Function,
                            arn: format!("arn:aws:lambda:tn-tunis-1:000000000001:function:{resizer}:live"),
                            events: vec!["s3:ObjectCreated:*".into()],
                            prefix: Some("uploads/".into()),
                            suffix: Some(".jpg".into()),
                            at: "/Resources/Resizer/Properties/Events/Upload/Properties".into(),
                        },
                    ],
                    website: None,
                    policies: Policies::default(),
                },
            ]
        );
        assert_eq!(plan.buckets[1].notifications[2].destination(), resizer);
        assert_eq!(
            plan.buckets[1].notification_configuration(),
            json!({
                "lambdaFunctionConfigurations": [{
                    "id": "ResizerUpload",
                    "lambdaFunctionArn": format!("arn:aws:lambda:tn-tunis-1:000000000001:function:{resizer}:live"),
                    "events": ["s3:ObjectCreated:*"],
                    "filter": { "key": { "filterRules": [rule("prefix", "uploads/"), rule("suffix", ".jpg")] } },
                }],
                "queueConfigurations": [
                    {
                        "id": "PhotosQueue1",
                        "queueArn": queue_arn,
                        "events": ["s3:ObjectRemoved:Delete", "s3:ObjectRemoved:DeleteMarkerCreated"],
                    },
                    {
                        "id": "PhotosQueue2",
                        "queueArn": queue_arn,
                        "events": ["s3:ObjectCreated:*"],
                        "filter": { "key": { "filterRules": [rule("suffix", ".tmp")] } },
                    },
                ],
            })
        );
        let [function] = &plan.functions[..] else { panic!("{plan:?}") };
        let variables = [("SITE", "shop-site"), ("SITE_DOMAIN", "shop-site.s3.ffunc.cloud")];
        assert_eq!(function.environment, variables.map(|(name, value)| (name.to_owned(), value.to_owned())).into());
        assert_eq!(
            plan.resources(),
            [
                resource("Resizer", FUNCTION, Some(resizer)),
                resource("ResizerAliaslive", ALIAS, Some(&format!("{resizer}:live"))),
                resource("Removed", QUEUE, Some(removed_queue)),
                resource("Site", BUCKET, Some("shop-site")),
                resource("Photos", BUCKET, Some(photos)),
                resource("RemovedPolicy", QUEUE_POLICY, None),
                resource("SitePolicy", BUCKET_POLICY, None),
            ]
        );
        // The site's address is FF's API's, once the deploy made it.
        let values = BTreeMap::new();
        let known = Known {
            buckets: plan.buckets.iter().map(|bucket| (bucket.id.clone(), bucket.name.clone())).collect(),
            sites: [("Site".to_owned(), "https://shop-site.site.ffunc.cloud".to_owned())].into(),
            ..Known::new(&PLACE, &values, PLACE.sqs_endpoint)
        };
        assert_eq!(
            outputs(&read(WITH_BUCKETS).unwrap(), &known),
            [
                Output {
                    name: "SiteUrl".into(),
                    value: "https://shop-site.site.ffunc.cloud".into(),
                    description: Some("Where the site answers".into()),
                },
                Output { name: "PhotosArn".into(), value: format!("arn:aws:s3:::{photos}").into(), description: None },
                Output {
                    name: "PhotosDomain".into(),
                    value: format!("{photos}.s3.ffunc.cloud").into(),
                    description: None
                },
            ]
        );
    }

    #[test]
    fn says_what_ff_cant_make_of_a_bucket_at_its_property_and_which_of_its_notifications_overlap() {
        let template = "\
Transform: AWS::Serverless-2016-10-31
Resources:
  Dotted:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: shop.site
  Photos:
    Type: AWS::S3::Bucket
    Properties:
      NotificationConfiguration:
        LambdaConfigurations:
          - Event: s3:ObjectRestore:Post
            Function: arn:aws:lambda:us-east-1:123456789012:function:elsewhere
        QueueConfigurations:
          - Event: s3:ObjectCreated:*
            Queue: arn:aws:sqs:tn-tunis-1:000000000001:jobs
            Filter:
              S3Key:
                Rules:
                  - Name: prefix
                    Value: a/
                  - Name: prefix
                    Value: b/
                  - Name: middle
                    Value: x
      WebsiteConfiguration:
        IndexDocument: pages/index.html
  Uploads:
    Type: AWS::S3::Bucket
    Properties:
      NotificationConfiguration:
        QueueConfigurations:
          - Event: s3:ObjectCreated:Put
            Queue: arn:aws:sqs:tn-tunis-1:000000000001:jobs
            Filter: {S3Key: {Rules: [{Name: prefix, Value: uploads/}]}}
  Resizer:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: resizer
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
      Events:
        Upload:
          Type: S3
          Properties:
            Bucket: !Ref Uploads
            Events: [s3:ObjectCreated:*]
            Filter: {S3Key: {Rules: [{Name: Prefix, Value: uploads/photos/}]}}
        Gone:
          Type: S3
          Properties:
            Bucket: !Ref Uploads
            Events: s3:ObjectGone
";
        let problems = planned(template, &[], &[]).unwrap_err();

        let sent = EVENT_TYPES.join(", ");
        let photos = "/Resources/Photos/Properties";
        let lambda = format!("{photos}/NotificationConfiguration/LambdaConfigurations/0");
        let queue = format!("{photos}/NotificationConfiguration/QueueConfigurations/0");
        assert_eq!(
            problems,
            [
                ("/Resources/Dotted/Properties/BucketName".to_owned(), "Dotted: BucketName shop.site: 3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as S3's, without dots on FF, known before the deploy".to_owned()),
                ("/Resources/Resizer/Properties/Events/Gone/Properties/Events".to_owned(), format!("Resizer: event Gone's Events s3:ObjectGone: an event FF's buckets send: {sent}")),
                (format!("{lambda}/Event"), format!("Photos: NotificationConfiguration.LambdaConfigurations[0].Event s3:ObjectRestore:Post: an event FF's buckets send: {sent}")),
                (format!("{lambda}/Function"), "Photos: NotificationConfiguration.LambdaConfigurations[0].Function arn:aws:lambda:us-east-1:123456789012:function:elsewhere: the ARN of a function of the account, arn:aws:lambda:tn-tunis-1:000000000001:function:<name>".to_owned()),
                (format!("{queue}/Filter/S3Key/Rules/1"), "Photos: NotificationConfiguration.QueueConfigurations[0].Filter.S3Key.Rules[1] is a second prefix: S3 takes one of each".to_owned()),
                (format!("{queue}/Filter/S3Key/Rules/2"), "Photos: NotificationConfiguration.QueueConfigurations[0].Filter.S3Key.Rules[2] is a Name, prefix or suffix, and its Value, as S3's".to_owned()),
                (format!("{photos}/WebsiteConfiguration/IndexDocument"), "Photos: WebsiteConfiguration.IndexDocument pages/index.html: a name of 1 to 1024 characters without a slash, such as index.html, as S3's".to_owned()),
                // A prefix that starts with another's, and a wildcard of the other's event: both take uploads/photos/a.jpg.
                ("/Resources/Resizer/Properties/Events/Upload/Properties".to_owned(), "Uploads: the notifications UploadsQueue1 and ResizerUpload could both take one event, which S3 refuses as ambiguous: give them events, prefixes or suffixes that don't overlap".to_owned()),
            ]
        );
    }

    #[test]
    fn deletes_a_templates_buckets_after_its_functions_and_before_its_queues() {
        let last = [
            resource("Photos", BUCKET, Some("photos")),
            resource("Removed", QUEUE, Some("removed")),
            resource("Resizer", FUNCTION, Some("resizer")),
            retained("Site", BUCKET, Some("site")),
            resource("SitePolicy", BUCKET_POLICY, None),
        ];

        let removed = removed(&last, &[], &BTreeMap::new());

        let deleted = [
            resource("Resizer", FUNCTION, Some("resizer")),
            resource("Photos", BUCKET, Some("photos")),
            resource("Removed", QUEUE, Some("removed")),
        ];
        assert_eq!(removed, Removed { deleted: deleted.into(), kept: [retained("Site", BUCKET, Some("site"))].into() });
        assert_eq!(in_words(&removed.deleted[1]), "the bucket photos (Photos)");
    }

    /// The way back: the template ff export's tests write from their account, planned as a deploy under another account
    /// plans it, makes that account's resources, but for what MIGRATION.md says changes on the way.
    #[test]
    fn plans_the_template_ff_export_writes_as_the_account_it_read() {
        let values = [("SendReceiptsLogLevel", "info"), ("SendReceiptsDatabaseUrl", "postgresql://shop@db/shop")];
        let plan = planned(include_str!("../commands/export/testdata/shop-template.yaml"), &[], &values).unwrap();

        let functions: Vec<_> = plan
            .functions
            .iter()
            .map(|function| {
                let settings =
                    (function.runtime.as_str(), function.handler.as_str(), function.memory, function.timeout);
                (function.name.as_str(), settings, function.instances(), function.alias.as_deref())
            })
            .collect();
        assert_eq!(
            functions,
            [
                // Its alias beta names a version, which no template holds: live, which its warm instance keeps warm.
                ("make-thumbnail", ("python", "app.handler", 512, 30), (1, 10), Some("live")),
                // Lambda's name for report.v1, as it would be named on AWS.
                ("report_v1", ("nodejs", "function.handler", 128, 3), (0, DEFAULT_MAX_INSTANCES), None),
                ("send-receipts", ("nodejs", "function.handler", 256, 60), (0, DEFAULT_MAX_INSTANCES), Some("live")),
            ]
        );
        let receipts = &plan.functions[2];
        // Its variable, and its secret as a variable, as Lambda has no other.
        assert_eq!(
            receipts.environment,
            BTreeMap::from([
                ("DATABASE_URL".to_owned(), "postgresql://shop@db/shop".to_owned()),
                ("LOG_LEVEL".to_owned(), "info".to_owned())
            ])
        );
        let url = receipts.url.as_ref().unwrap();
        assert_eq!(
            (url.auth_type.as_str(), url.cors.clone()),
            ("AWS_IAM", Some(json!({ "allowOrigins": ["https://shop.tn"], "allowMethods": ["POST"], "maxAge": 300 })))
        );
        assert_eq!(
            receipts.event_invoke_config,
            Some(json!({ "maximumRetryAttempts": 1, "destinationConfig": {
                "onSuccess": { "destination": "arn:aws:lambda:tn-tunis-1:000000000001:function:audit" },
                "onFailure": { "destination": "arn:aws:sqs:tn-tunis-1:000000000001:failed-receipts" } } }))
        );
        // Both schedules off, nightly until ScheduleState says the move is done, so that none runs twice.
        let schedules: Vec<_> = receipts
            .schedules
            .iter()
            .map(|schedule| {
                (schedule.name.as_str(), schedule.expression.as_str(), schedule.input.clone(), schedule.enabled)
            })
            .collect();
        assert_eq!(
            schedules,
            [
                ("Nightly", "cron(0 2 * * ? *)", Some(json!({ "report": true })), false),
                ("Weekly", "rate(7 days)", None, false)
            ]
        );
        let mapping = &receipts.mappings[0];
        assert_eq!(
            (mapping.queue(), mapping.batch_size, mapping.batching_window, mapping.report_batch_item_failures),
            ("orders", 10, 2, true)
        );
        assert_eq!((mapping.max_concurrency, mapping.enabled), (Some(5), true));

        let queues: Vec<_> = plan
            .queues
            .iter()
            .map(|queue| (queue.name.as_str(), queue.attributes["visibilityTimeout"].clone(), queue.dead_letter()))
            .collect();
        // Each dead-letter queue before the queues that use it, as the deploy makes them.
        assert_eq!(
            queues,
            [
                ("failed-receipts", json!(30), None),
                ("orders-dlq", json!(30), None),
                ("orders", json!(60), Some("orders-dlq"))
            ]
        );
        // The bucket's own notification, its two events one configuration as S3 keeps them, and the function's, on its
        // alias; the site is left to data/s3-website.md's own template.
        let photos = &plan.buckets[0];
        let notifications: Vec<_> = photos
            .notifications
            .iter()
            .map(|notification| {
                let filter = (notification.prefix.as_deref(), notification.suffix.as_deref());
                (notification.arn.as_str(), notification.events.join(","), filter)
            })
            .collect();
        assert_eq!((plan.buckets.len(), photos.name.as_str(), photos.website.is_none()), (1, "photos", true));
        assert_eq!(
            notifications,
            [
                (
                    "arn:aws:sqs:tn-tunis-1:000000000001:orders",
                    "s3:ObjectRemoved:Delete,s3:ObjectRemoved:DeleteMarkerCreated".to_owned(),
                    (None, None)
                ),
                (
                    "arn:aws:lambda:tn-tunis-1:000000000001:function:make-thumbnail:live",
                    "s3:ObjectCreated:*".to_owned(),
                    (Some("in/"), Some(".jpg"))
                ),
            ]
        );
    }

    /// The small app as one template, examples/orders-app's, planned in the stack its samconfig.toml names: its three
    /// functions named after the stack, the queue's name in the API's variables, the receipts' bucket in each one's, the
    /// page's bucket a site and its policy kept without effect.
    #[test]
    fn plans_the_small_app_as_one_template() {
        let values = [
            ("ReceiptsBucketName", "shop-receipts"),
            ("SiteBucketName", "shop-site"),
            ("SiteOrigin", "http://shop-site.site.localhost:3004"),
        ];
        let plan = planned(include_str!("../../../examples/orders-app/template.yaml"), &[], &values).unwrap();

        let functions: Vec<_> = plan
            .functions
            .iter()
            .map(|function| {
                let settings =
                    (function.runtime.as_str(), function.handler.as_str(), function.memory, function.timeout);
                let variables: Vec<String> =
                    function.environment.iter().map(|(name, value)| format!("{name}={value}")).collect();
                (function.name.as_str(), settings, variables.join(" "))
            })
            .collect();
        assert_eq!(
            functions,
            [
                (
                    "shop-api",
                    ("nodejs", "index.http", 128, 5),
                    "RECEIPTS_BUCKET=shop-receipts RECEIPTS_QUEUE=shop-new-orders".to_owned()
                ),
                (
                    "shop-receipts",
                    ("nodejs", "index.receipts", 128, 5),
                    "RECEIPTS_BUCKET=shop-receipts RECEIPTS_FROM=".to_owned()
                ),
                ("shop-nightly", ("nodejs", "index.nightly", 128, 5), "RECEIPTS_BUCKET=shop-receipts".to_owned()),
            ]
        );
        let url = plan.functions[0].url.as_ref().unwrap();
        assert_eq!(
            (url.auth_type.as_str(), url.cors.clone()),
            (
                "NONE",
                Some(
                    json!({ "allowOrigins": ["http://shop-site.site.localhost:3004"], "allowMethods": ["GET", "POST"],
                    "allowHeaders": ["content-type"] })
                )
            )
        );
        let schedules: Vec<_> = plan.functions[2]
            .schedules
            .iter()
            .map(|schedule| (schedule.name.as_str(), schedule.expression.as_str(), schedule.enabled))
            .collect();
        assert_eq!(schedules, [("EveryNight", "cron(0 2 * * ? *)", true)]);
        let mapping = &plan.functions[1].mappings[0];
        assert_eq!(
            (mapping.queue(), mapping.batch_size, mapping.report_batch_item_failures),
            ("shop-new-orders", 10, true)
        );

        let queues: Vec<_> = plan.queues.iter().map(|queue| queue.name.as_str()).collect();
        assert_eq!(queues, ["shop-new-orders"]);
        let buckets: Vec<_> =
            plan.buckets.iter().map(|bucket| (bucket.name.as_str(), bucket.website.as_ref())).collect();
        assert_eq!(
            buckets,
            [
                ("shop-receipts", None),
                (
                    "shop-site",
                    Some(&Website { index_document: "index.html".into(), error_document: Some("404.html".into()) })
                )
            ]
        );
        let kept: Vec<_> =
            plan.without_effect.iter().map(|resource| (resource.logical_id.as_str(), resource.kind.as_str())).collect();
        assert_eq!(kept, [("SitePolicy", "AWS::S3::BucketPolicy")]);
    }

    #[test]
    fn deletes_what_the_last_deploy_made_and_this_one_doesnt_a_url_first_a_function_last_with_its_own() {
        let last = [
            resource("Orders", FUNCTION, Some("orders")),
            resource("OrdersUrl", URL, Some("orders")),
            resource("OrdersAliaslive", ALIAS, Some("orders:live")),
            resource("OrdersNightly", RULE, Some("orders:nightly")),
            resource("OrdersJobs", MAPPING, Some("orders:jobs")),
            resource("Old", FUNCTION, Some("old")),
            resource("OldUrl", URL, Some("old")),
            resource("OldHourly", SCHEDULE, Some("old:hourly")),
            resource("Allow", PERMISSION, None),
        ];
        // The Schedule event made a ScheduleV2 one of the same name: the same schedule on FF, kept.
        let next = [
            resource("Orders", FUNCTION, Some("orders")),
            resource("OrdersUrl", URL, Some("orders:live")),
            resource("OrdersAliaslive", ALIAS, Some("orders:live")),
            resource("OrdersNightly", SCHEDULE, Some("orders:nightly")),
        ];

        let removed = removed(&last, &next, &BTreeMap::new());

        assert_eq!(
            removed.deleted,
            [
                resource("OrdersUrl", URL, Some("orders")),
                resource("OrdersJobs", MAPPING, Some("orders:jobs")),
                resource("Old", FUNCTION, Some("old")),
            ]
        );
        assert_eq!(removed.kept, []);
        assert_eq!(
            removed.deleted.iter().map(in_words).collect::<Vec<_>>(),
            ["orders's URL (OrdersUrl)", "orders's reading of the queue jobs (OrdersJobs)", "the function old (Old)"]
        );
        assert_eq!(
            in_words(&resource("OrdersNightly", RULE, Some("orders:nightly"))),
            "orders's schedule nightly (OrdersNightly)"
        );
    }

    #[test]
    fn a_functions_resources_have_its_deletion_policy_and_what_they_replace_its_update_replace_policy() {
        let template = "Transform: AWS::Serverless-2016-10-31
Resources:
  Orders:
    Type: AWS::Serverless::Function
    DeletionPolicy: Retain
    Properties:
      FunctionName: orders
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
      AutoPublishAlias: live
      FunctionUrlConfig:
        AuthType: NONE
  Api:
    Type: AWS::Serverless::Function
    UpdateReplacePolicy: Retain
    Properties:
      FunctionName: api
      CodeUri: orders
      Handler: index.handler
      Runtime: nodejs24.x
";

        let plan = planned(template, &[], &[]).unwrap();

        assert_eq!(
            plan.resources(),
            [
                retained("Orders", FUNCTION, Some("orders")),
                retained("OrdersUrl", URL, Some("orders:live")),
                retained("OrdersAliaslive", ALIAS, Some("orders:live")),
                resource("Api", FUNCTION, Some("api")),
            ]
        );
        let (delete, retain) = (DeletionPolicy::Delete, DeletionPolicy::Retain);
        assert_eq!(
            plan.replace_policies(),
            by_logical_id(&[("Orders", delete), ("OrdersUrl", delete), ("OrdersAliaslive", delete), ("Api", retain)])
        );
    }

    #[test]
    fn leaves_in_the_account_what_the_template_said_to_retain_when_removed_or_replaced_by_a_new_name() {
        let last = [
            retained("Orders", FUNCTION, Some("orders")),
            retained("OrdersUrl", URL, Some("orders")),
            resource("Api", FUNCTION, Some("api")),
            resource("Reports", FUNCTION, Some("reports")),
            retained("Old", FUNCTION, Some("old")),
            retained("OldUrl", URL, Some("old")),
        ];
        // Orders and Api renamed: the next template's UpdateReplacePolicy decides, Delete for Orders, Retain for Api.
        let next = [
            resource("Orders", FUNCTION, Some("orders-v2")),
            resource("OrdersUrl", URL, Some("orders-v2")),
            resource("Api", FUNCTION, Some("api-v2")),
        ];
        let (delete, retain) = (DeletionPolicy::Delete, DeletionPolicy::Retain);
        let replacing = by_logical_id(&[("Orders", delete), ("OrdersUrl", delete), ("Api", retain)]);

        let updated = removed(&last, &next, &replacing);
        let deleted = removed(&last, &[], &BTreeMap::new());

        assert_eq!(
            updated,
            Removed {
                deleted: vec![
                    retained("Orders", FUNCTION, Some("orders")),
                    resource("Reports", FUNCTION, Some("reports"))
                ],
                kept: vec![resource("Api", FUNCTION, Some("api")), retained("Old", FUNCTION, Some("old"))],
            }
        );
        assert_eq!(
            deleted,
            Removed {
                deleted: vec![resource("Api", FUNCTION, Some("api")), resource("Reports", FUNCTION, Some("reports"))],
                kept: vec![retained("Orders", FUNCTION, Some("orders")), retained("Old", FUNCTION, Some("old"))],
            }
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
        let known = Known {
            functions: [("Orders".to_owned(), made)].into(),
            ..Known::new(&PLACE, &values, PLACE.sqs_endpoint)
        };

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
