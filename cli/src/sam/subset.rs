//! FF's subset of SAM (ADR 0016): what `ff deploy` takes of a template, each piece meaning what it means to SAM, and
//! everything outside it, each at its line, for the one refusal that lists them all before any change; `ff doctor`
//! names them too. What CloudFormation or SAM would refuse as well, a name that names nothing or a function written
//! wrong, is told apart: there the template is wrong, not FF short of it.
//!
//! The subset: the Globals of functions; parameters of CloudFormation's own types; `Ref`, `Fn::GetAtt`, `Fn::Sub` and
//! `Fn::Join`, and the pseudo parameters, which are FF's; `AWS::Serverless::Function` and its events of the types
//! `Schedule`, `ScheduleV2`, `SQS`, `S3` and `HttpApi`; `AWS::SQS::Queue`; `AWS::S3::Bucket` with its notifications
//! and its website; and, kept without effect for AWS, `AWS::Lambda::Permission`, the queues' and the buckets' policies
//! and a function's IAM settings; `Outputs`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use super::parameters;
use super::resolve::{self, FUNCTION, Part};
use super::{Template, text_of};
use crate::cli::Runtime;
use crate::table::in_words;

/// SAM's transform, which makes a template's `AWS::Serverless::` resources CloudFormation's.
pub const TRANSFORM: &str = "AWS::Serverless-2016-10-31";

/// The runtimes FF runs, as Lambda names them.
pub const RUNTIMES: [&str; 2] = [Runtime::Nodejs.lambda(), Runtime::Python.lambda()];

/// CloudFormation's pseudo parameters that FF gives: its region, the account's ID, the stack's name, and AWS's
/// partition, which FF's ARNs are in.
pub const PSEUDO_PARAMETERS: [&str; 4] = ["AWS::Region", "AWS::AccountId", "AWS::StackName", "AWS::Partition"];

/// The intrinsic functions FF's subset takes.
const FUNCTIONS: &str = "Ref, Fn::GetAtt, Fn::Sub and Fn::Join";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// What SAM takes and FF's subset doesn't: AWS would deploy it, `ff deploy` doesn't.
    Outside,
    /// What CloudFormation or SAM would refuse too.
    Invalid,
}

/// A piece of the template outside the subset, or wrong: where it is, by JSON pointer and line, and what it is.
#[derive(Debug, PartialEq, Eq)]
pub struct Problem {
    pub pointer: String,
    pub line: Option<usize>,
    pub kind: Kind,
    pub message: String,
}

/// What FF's subset takes at a key.
enum Shape {
    /// A value, its intrinsics checked.
    Value,
    /// A mapping of these keys, each with its shape: another key is outside the subset.
    Keys(&'static [(&'static str, Shape)]),
    /// One of these values, as written or a parameter's, else outside, saying why.
    OneOf(&'static [&'static str], &'static str),
    /// A list of values, each one of these, else outside, saying why.
    EachOf(&'static [&'static str], &'static str),
    /// Read and left for AWS, as an IAM policy is: only the names it refers to are checked.
    Left,
    /// Outside the subset, saying why.
    Outside(&'static str),
    /// A function's code: a folder or a zip on this machine, as `sam build` reads it.
    Code,
    /// A function's events.
    Events,
}

use Shape::{Code, EachOf, Events, Keys, Left, OneOf, Outside, Value as V};

const KMS: &str = "FF seals what it keeps with its own keys: a KMS key has no place here";
const IMAGES: &str = "FF runs .zip packages, not container images";
const IAM: &str = "FF has no IAM: a function's own key reaches its account, and an account's key what it names";
const LAYERS: &str = "FF has no layers: put the libraries in the function's zip";
const TABLES: &str = "FF has no DynamoDB: its databases are PostgreSQL's, made with `ff db create` beside the template";
const API_GATEWAY: &str = "FF has no API Gateway: a function's FunctionUrlConfig gives it a URL";
const CONDITIONS: &str = "FF's subset has no conditions yet: each resource is made, each value as written";
const FIFO: &str = "FF's queues are standard queues: FIFO queues come later";
const STEP_FUNCTIONS: &str = "FF has no Step Functions";
const NESTED: &str = "FF deploys no nested stacks or applications: each template is deployed on its own";
const NO_SCHEDULE_OPTIONS: &str = "FF's schedules run their function, retried as an asynchronous call is";

/// Where an asynchronous call's record goes.
const DESTINATION: Shape = Keys(&[
    ("Type", OneOf(&["SQS", "Lambda"], "FF's destinations are its queues and its functions")),
    ("Destination", V),
]);

/// `AWS::Serverless::Function`'s properties.
const FUNCTION_PROPERTIES: &[(&str, Shape)] = &[
    ("CodeUri", Code),
    ("Handler", V),
    ("Runtime", OneOf(&RUNTIMES, "FF runs nodejs24.x and python3.13, as Lambda names them")),
    ("MemorySize", V),
    ("Timeout", V),
    ("Description", V),
    ("FunctionName", V),
    ("Environment", Keys(&[("Variables", V)])),
    ("Tags", V),
    ("ReservedConcurrentExecutions", V),
    ("ProvisionedConcurrencyConfig", Keys(&[("ProvisionedConcurrentExecutions", V)])),
    ("AutoPublishAlias", V),
    (
        "FunctionUrlConfig",
        Keys(&[
            ("AuthType", V),
            (
                "Cors",
                Keys(&[
                    ("AllowCredentials", V),
                    ("AllowHeaders", V),
                    ("AllowMethods", V),
                    ("AllowOrigins", V),
                    ("ExposeHeaders", V),
                    ("MaxAge", V),
                ]),
            ),
            ("InvokeMode", OneOf(&["BUFFERED"], "FF doesn't stream answers: BUFFERED, Lambda's default, is FF's")),
        ]),
    ),
    (
        "EventInvokeConfig",
        Keys(&[
            ("MaximumEventAgeInSeconds", V),
            ("MaximumRetryAttempts", V),
            ("DestinationConfig", Keys(&[("OnSuccess", DESTINATION), ("OnFailure", DESTINATION)])),
        ]),
    ),
    (
        "DeadLetterQueue",
        Keys(&[
            ("Type", OneOf(&["SQS"], "FF's dead-letter queues are its queues: it has no SNS topics")),
            ("TargetArn", V),
        ]),
    ),
    ("Architectures", EachOf(&["x86_64"], "FF runs x86_64 alone")),
    ("Tracing", OneOf(&["PassThrough", "Disabled"], "FF traces no calls with X-Ray")),
    ("PackageType", OneOf(&["Zip"], IMAGES)),
    ("Events", Events),
    // IAM's, read and left for AWS: on FF a function's own key stands for its role.
    ("Policies", Left),
    ("Role", Left),
    ("PermissionsBoundary", Left),
    ("RolePath", Left),
    ("AssumeRolePolicyDocument", Left),
    ("Layers", Outside(LAYERS)),
    (
        "VpcConfig",
        Outside("FF's functions need no VPC: each one reaches its account's buckets, queues and databases without one"),
    ),
    ("KmsKeyArn", Outside(KMS)),
    ("FileSystemConfigs", Outside("FF mounts no file system: a function has FF's 512 MB of /tmp")),
    ("ImageUri", Outside(IMAGES)),
    ("ImageConfig", Outside(IMAGES)),
    ("CodeSigningConfigArn", Outside("FF signs no code")),
    ("InlineCode", Outside("FF builds a function from its folder: the code in a file, the folder its CodeUri")),
    ("DeploymentPreference", Outside("FF moves an alias at once: it has no CodeDeploy to move its calls by steps")),
    ("SnapStart", Outside("FF starts a function's instances without snapshots")),
    ("EphemeralStorage", Outside("a function has FF's 512 MB of /tmp, Lambda's default")),
    ("LoggingConfig", Outside("FF keeps a function's log as its code writes it, which `ff logs` reads")),
];

/// SAM's properties a function's Globals don't take, each function's own.
const NOT_GLOBAL: [&str; 5] = ["FunctionName", "Events", "Policies", "Role", "InlineCode"];

const QUEUE_PROPERTIES: &[(&str, Shape)] = &[
    ("QueueName", V),
    ("VisibilityTimeout", V),
    ("MessageRetentionPeriod", V),
    ("DelaySeconds", V),
    ("MaximumMessageSize", V),
    ("ReceiveMessageWaitTimeSeconds", V),
    ("RedrivePolicy", V),
    ("Tags", V),
    ("SqsManagedSseEnabled", V),
    ("FifoQueue", OneOf(&["false"], FIFO)),
    ("ContentBasedDeduplication", Outside(FIFO)),
    ("DeduplicationScope", Outside(FIFO)),
    ("FifoThroughputLimit", Outside(FIFO)),
    ("KmsMasterKeyId", Outside(KMS)),
    ("KmsDataKeyReusePeriodSeconds", Outside(KMS)),
];

const BUCKET_PROPERTIES: &[(&str, Shape)] = &[
    ("BucketName", V),
    (
        "NotificationConfiguration",
        Keys(&[
            ("QueueConfigurations", V),
            ("LambdaConfigurations", V),
            ("TopicConfigurations", Outside("FF has no SNS topics: a bucket tells its queues and its functions")),
        ]),
    ),
    ("WebsiteConfiguration", Keys(&[("IndexDocument", V), ("ErrorDocument", V)])),
    ("Tags", V),
    // Kept without effect, as FF's S3 keeps it: on FF the website configuration alone makes a bucket public.
    ("PublicAccessBlockConfiguration", V),
];

const PERMISSION_PROPERTIES: &[(&str, Shape)] = &[
    ("Action", V),
    ("FunctionName", V),
    ("Principal", V),
    ("SourceArn", V),
    ("SourceAccount", V),
    ("FunctionUrlAuthType", V),
    ("InvokedViaFunctionUrl", V),
    ("PrincipalOrgID", V),
    ("EventSourceToken", V),
];

/// A resource type of the subset: its properties, and the attributes `Fn::GetAtt` takes of it.
struct Type {
    name: &'static str,
    properties: &'static [(&'static str, Shape)],
    attributes: &'static [&'static str],
}

const TYPES: [Type; 6] = [
    Type { name: FUNCTION, properties: FUNCTION_PROPERTIES, attributes: &["Arn"] },
    Type { name: "AWS::SQS::Queue", properties: QUEUE_PROPERTIES, attributes: &["Arn", "QueueName", "QueueUrl"] },
    // Kept without effect, as a function's IAM settings are: on FF a queue's own account sends to it.
    Type { name: "AWS::SQS::QueuePolicy", properties: &[("Queues", V), ("PolicyDocument", Left)], attributes: &[] },
    Type {
        name: "AWS::S3::Bucket",
        properties: BUCKET_PROPERTIES,
        attributes: &["Arn", "DomainName", "RegionalDomainName", "WebsiteURL"],
    },
    Type { name: "AWS::S3::BucketPolicy", properties: &[("Bucket", V), ("PolicyDocument", Left)], attributes: &[] },
    // Kept without effect: on FF a function's URL and its account's buckets and queues call it with no permission.
    Type { name: "AWS::Lambda::Permission", properties: PERMISSION_PROPERTIES, attributes: &[] },
];

/// The types outside the subset that FF has an answer for, a name ending with `::` all of a service's.
const OTHER_TYPES: [(&str, &str); 22] = [
    ("AWS::IAM::", IAM),
    ("AWS::Serverless::LayerVersion", LAYERS),
    ("AWS::Lambda::LayerVersion", LAYERS),
    ("AWS::Serverless::SimpleTable", TABLES),
    ("AWS::DynamoDB::", TABLES),
    ("AWS::Serverless::Api", API_GATEWAY),
    ("AWS::Serverless::HttpApi", API_GATEWAY),
    ("AWS::ApiGateway::", API_GATEWAY),
    ("AWS::ApiGatewayV2::", API_GATEWAY),
    (
        "AWS::Lambda::Function",
        "FF's subset makes a function of AWS::Serverless::Function, its code built from its CodeUri",
    ),
    ("AWS::Lambda::Url", "a function's FunctionUrlConfig gives it its URL"),
    ("AWS::Lambda::Alias", "a function's AutoPublishAlias publishes its versions and moves its alias"),
    ("AWS::Lambda::Version", "a function's AutoPublishAlias publishes its versions and moves its alias"),
    ("AWS::Lambda::EventInvokeConfig", "a function's EventInvokeConfig sets its asynchronous calls"),
    ("AWS::Lambda::EventSourceMapping", "a function's SQS event reads its queue"),
    ("AWS::Events::Rule", "a function's Schedule event makes its schedule"),
    ("AWS::Scheduler::Schedule", "a function's ScheduleV2 event makes its schedule"),
    ("AWS::SNS::", "FF has no SNS topics: a queue and a function's SQS event carry messages"),
    ("AWS::Serverless::StateMachine", STEP_FUNCTIONS),
    ("AWS::StepFunctions::", STEP_FUNCTIONS),
    ("AWS::Serverless::Application", NESTED),
    ("AWS::CloudFormation::Stack", NESTED),
];

/// A function's events of each type the subset takes, with their properties.
const EVENTS: [(&str, &[(&str, Shape)]); 5] = [
    (
        "Schedule",
        &[
            ("Schedule", V),
            ("Input", V),
            ("State", V),
            ("Enabled", V),
            ("Name", V),
            ("Description", V),
            ("RetryPolicy", Outside(NO_SCHEDULE_OPTIONS)),
            ("DeadLetterConfig", Outside(NO_SCHEDULE_OPTIONS)),
        ],
    ),
    (
        "ScheduleV2",
        &[
            ("ScheduleExpression", V),
            ("ScheduleExpressionTimezone", OneOf(&["UTC", "Etc/UTC"], "FF's schedules run in UTC")),
            ("Input", V),
            ("State", V),
            ("Name", V),
            ("Description", V),
            ("RetryPolicy", Outside(NO_SCHEDULE_OPTIONS)),
            ("DeadLetterConfig", Outside(NO_SCHEDULE_OPTIONS)),
        ],
    ),
    (
        "SQS",
        &[
            ("Queue", V),
            ("BatchSize", V),
            ("MaximumBatchingWindowInSeconds", V),
            ("FunctionResponseTypes", V),
            ("Enabled", V),
            ("ScalingConfig", Keys(&[("MaximumConcurrency", V)])),
            ("FilterCriteria", Outside("FF doesn't filter a queue's messages yet: the function gets each one")),
        ],
    ),
    ("S3", &[("Bucket", V), ("Events", V), ("Filter", Keys(&[("S3Key", Keys(&[("Rules", V)]))]))]),
    (
        "HttpApi",
        &[
            ("Path", V),
            ("Method", V),
            (
                "PayloadFormatVersion",
                OneOf(&["2.0"], "a function's URL sends the event of version 2.0, which an HttpApi's routes become"),
            ),
            ("TimeoutInMillis", V),
        ],
    ),
];

const API_EVENT: &str = "an Api event makes an API Gateway REST API, which FF hasn't: the function's FunctionUrlConfig \
                         gives it a URL, and HttpApi events, all of one function, go to that URL";

/// The template's top-level sections, but those checked on their own.
const SECTIONS: [(&str, Shape); 6] = [
    ("AWSTemplateFormatVersion", V),
    ("Description", V),
    ("Metadata", Left),
    ("Conditions", Outside(CONDITIONS)),
    ("Mappings", Outside("FF's subset has no mappings, which Fn::FindInMap reads: a parameter gives a value instead")),
    ("Rules", Outside("FF's subset has no rules: a parameter's AllowedValues check its value")),
];

/// The keys of a parameter.
const PARAMETER_KEYS: [&str; 11] = [
    "Type",
    "Default",
    "AllowedValues",
    "AllowedPattern",
    "MinLength",
    "MaxLength",
    "MinValue",
    "MaxValue",
    "NoEcho",
    "Description",
    "ConstraintDescription",
];

/// A key in a JSON pointer.
fn at(pointer: &str, key: &str) -> String {
    format!("{pointer}/{}", super::pointer_key(key))
}

/// "Orders' Runtime", "HelloWorldFunction's Runtime": a key of what owns it.
fn of(owner: &str, path: &str) -> String {
    format!("{owner}{} {path}", if owner.ends_with('s') { "'" } else { "'s" })
}

/// "an AWS::IAM::Role", "a Custom::Thing".
fn with_article(kind: &str) -> String {
    format!("{} {kind}", if kind.starts_with(['A', 'E', 'I', 'O', 'U']) { "an" } else { "a" })
}

/// What a name refers to, as a `Ref` or a `Fn::GetAtt` finds it.
enum Named {
    Parameter,
    Pseudo,
    /// A resource of the template, or one SAM makes, of the subset: its type's attributes.
    Resource(&'static [&'static str]),
    /// One outside the subset, already named for it.
    Elsewhere,
    /// One SAM makes that FF hasn't, saying why.
    Outside(String),
    /// Nothing CloudFormation or SAM has, saying so.
    Nothing(String),
}

struct Checker<'a> {
    template: &'a Template,
    /// The template with its Globals merged into each function, as SAM does.
    merged: Value,
    parameters: &'a Map<String, Value>,
    resources: &'a Map<String, Value>,
    /// Each parameter's value known.
    values: &'a BTreeMap<String, Value>,
    /// Where each function's HttpApi events are.
    http_events: Vec<(String, String)>,
    problems: Vec<Problem>,
}

impl Checker<'_> {
    fn problem(&mut self, pointer: &str, kind: Kind, message: String) {
        let line = self.template.line(pointer);
        self.problems.push(Problem { pointer: pointer.to_owned(), line, kind, message });
    }

    fn outside(&mut self, pointer: &str, message: String) {
        self.problem(pointer, Kind::Outside, message);
    }

    fn invalid(&mut self, pointer: &str, message: String) {
        self.problem(pointer, Kind::Invalid, message);
    }

    /// A function's property, its own or its Globals'.
    fn property(&self, id: &str, name: &str) -> Option<&Value> {
        self.merged.pointer(&format!("/Resources/{}/Properties/{}", super::pointer_key(id), super::pointer_key(name)))
    }

    fn functions(&self) -> impl Iterator<Item = &String> {
        self.resources
            .iter()
            .filter(|(_, resource)| resource.get("Type").and_then(Value::as_str) == Some(FUNCTION))
            .map(|(id, _)| id)
    }

    /// What a name refers to: a parameter, a pseudo parameter, a resource, or one SAM makes of a function.
    fn named(&self, name: &str) -> Named {
        if self.parameters.contains_key(name) {
            return Named::Parameter;
        }
        if PSEUDO_PARAMETERS.contains(&name) {
            return Named::Pseudo;
        }
        match name {
            "AWS::NoValue" => {
                return Named::Outside(format!("AWS::NoValue takes a value away under Fn::If: {CONDITIONS}"));
            }
            "AWS::URLSuffix" => {
                return Named::Outside(
                    "AWS::URLSuffix, the domain of AWS's endpoints, which FF's aren't on".to_owned(),
                );
            }
            "AWS::NotificationARNs" => {
                return Named::Outside("AWS::NotificationARNs, the stack's SNS topics: FF has none".to_owned());
            }
            _ => {}
        }
        if name.contains('.') && !self.functions().any(|id| name.starts_with(&format!("{id}."))) {
            return Named::Nothing(format!("{name} names no parameter or resource of the template"));
        }
        if let Some(resource) = self.resources.get(name) {
            let kind = resource.get("Type").and_then(Value::as_str).unwrap_or("");
            return match TYPES.iter().find(|of| of.name == kind) {
                Some(of) => Named::Resource(of.attributes),
                None => Named::Elsewhere,
            };
        }
        if name.starts_with("ServerlessRestApi") {
            return Named::Outside(format!("{name}, the API SAM makes of a template's Api events: {API_EVENT}"));
        }
        if name.starts_with("ServerlessHttpApi") {
            return Named::Outside(format!(
                "{name}, the API SAM makes of a template's HttpApi events: on FF their routes go to the function's \
                 URL, which `!GetAtt <function>Url.FunctionUrl` gives with its FunctionUrlConfig"
            ));
        }
        // The resources SAM makes of a function, named after it: the longest function's name that starts this one.
        let function = self.functions().filter(|id| name.starts_with(id.as_str())).max_by_key(|id| id.len());
        let nothing = || Named::Nothing(format!("{name} names no parameter or resource of the template"));
        let Some(function) = function else { return nothing() };
        let rest = &name[function.len()..];
        let alias = self.property(function, "AutoPublishAlias").and_then(Value::as_str);
        match rest {
            "Role" if self.property(function, "Role").is_none() => {
                Named::Outside(format!("{name}, the IAM role SAM makes for {function}: {IAM}"))
            }
            "Url" if self.property(function, "FunctionUrlConfig").is_some() => {
                Named::Resource(&["FunctionUrl", "FunctionArn"])
            }
            // What SAM makes only with the function's own Role, or with its FunctionUrlConfig.
            "Role" | "Url" => nothing(),
            ".Alias" | ".Version" if alias.is_some() => Named::Resource(&[]),
            ".Alias" | ".Version" => {
                Named::Nothing(format!("{function} has no AutoPublishAlias, which makes its alias and its versions"))
            }
            _ if alias.is_some_and(|alias| rest == format!("Alias{alias}")) => Named::Resource(&[]),
            _ => Named::Outside(format!("{name}, a resource SAM makes for {function}, which FF's subset doesn't name")),
        }
    }

    /// A `Ref` of a name, or with an attribute a `Fn::GetAtt`.
    fn reference(&mut self, pointer: &str, owner: &str, name: &str, attribute: Option<&str>) {
        let what = match attribute {
            None => format!("{owner}: Ref {name}"),
            Some(attribute) => format!("{owner}: Fn::GetAtt {name}.{attribute}"),
        };
        match (self.named(name), attribute) {
            (Named::Parameter | Named::Pseudo, None) | (Named::Elsewhere, _) => {}
            (Named::Parameter | Named::Pseudo, Some(_)) => {
                self.invalid(pointer, format!("{what}: Fn::GetAtt takes a resource's attribute, and {name} isn't one"));
            }
            (Named::Resource(_), None) => {}
            (Named::Resource(attributes), Some(attribute)) => {
                if !attributes.contains(&attribute) {
                    let gives = match attributes {
                        [] => "no attribute".to_owned(),
                        _ => in_words(attributes),
                    };
                    self.outside(pointer, format!("{what}: of {name}, FF gives {gives}"));
                }
            }
            (Named::Outside(why), _) => self.outside(pointer, format!("{what}: {why}")),
            (Named::Nothing(why), _) => self.invalid(pointer, format!("{what}: {why}")),
        }
    }

    /// The names a value refers to, checked, and in a value FF reads, its intrinsics: those outside the subset named.
    fn value(&mut self, pointer: &str, owner: &str, value: &Value, read: bool) {
        match value {
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    self.value(&at(pointer, &index.to_string()), owner, item, read);
                }
            }
            Value::Object(map) => match resolve::intrinsic(map) {
                Some((name, args)) => self.intrinsic(&at(pointer, name), owner, name, args, read),
                None => {
                    for (key, value) in map {
                        self.value(&at(pointer, key), owner, value, read);
                    }
                }
            },
            _ => {}
        }
    }

    fn intrinsic(&mut self, pointer: &str, owner: &str, name: &str, args: &Value, read: bool) {
        match (name, args) {
            ("Ref", Value::String(target)) => self.reference(pointer, owner, target, None),
            ("Ref", _) => self.invalid(pointer, format!("{owner}: Ref takes a name")),
            ("Fn::GetAtt", Value::Array(args)) if args.len() == 2 && args[0].is_string() => match &args[1] {
                Value::String(attribute) => {
                    self.reference(pointer, owner, args[0].as_str().unwrap_or(""), Some(attribute));
                }
                _ if read => self.outside(
                    pointer,
                    format!("{owner}: Fn::GetAtt of an attribute a function gives, where FF's subset takes its name"),
                ),
                _ => {}
            },
            ("Fn::GetAtt", _) => {
                self.invalid(
                    pointer,
                    format!("{owner}: Fn::GetAtt takes a resource and its attribute, [Resource, Attribute]"),
                );
            }
            ("Fn::Sub", _) => {
                let (text, values) = match args {
                    Value::String(text) => (text.as_str(), None),
                    Value::Array(args) => match args.as_slice() {
                        [Value::String(text), Value::Object(values)] => (text.as_str(), Some(values)),
                        _ => {
                            return self
                                .invalid(pointer, format!("{owner}: Fn::Sub takes its text, or [text, values]"));
                        }
                    },
                    _ => return self.invalid(pointer, format!("{owner}: Fn::Sub takes its text, or [text, values]")),
                };
                let given: BTreeSet<&str> = values.into_iter().flatten().map(|(name, _)| name.as_str()).collect();
                for part in resolve::sub_parts(text) {
                    let Part::Name(name) = part else { continue };
                    if given.contains(name) {
                        continue;
                    }
                    let is_function = |id: &str| {
                        self.resources.get(id).and_then(|resource| resource.get("Type")) == Some(&Value::from(FUNCTION))
                    };
                    match name.split_once('.') {
                        // SAM's `${Function.Alias}` and `${Function.Version}`, as its `!Ref Function.Alias`.
                        Some((function, "Alias" | "Version")) if is_function(function) => {
                            self.reference(pointer, owner, name, None);
                        }
                        // A parameter's name and a pseudo parameter's have no dot: `${Stage}`, `${AWS::Region}`.
                        Some((resource, attribute)) => self.reference(pointer, owner, resource, Some(attribute)),
                        None => self.reference(pointer, owner, name, None),
                    }
                }
                for (name, value) in values.into_iter().flatten() {
                    self.value(&at(&at(pointer, "1"), name), owner, value, read);
                }
            }
            ("Fn::Join", Value::Array(args)) if args.len() == 2 && args[0].is_string() => {
                self.value(&at(pointer, "1"), owner, &args[1], read);
            }
            ("Fn::Join", _) => self.invalid(pointer, format!("{owner}: Fn::Join takes [delimiter, [values]]")),
            ("Condition" | "Fn::If" | "Fn::Equals" | "Fn::And" | "Fn::Or" | "Fn::Not", _) if read => {
                self.outside(pointer, format!("{owner}: {name}: {CONDITIONS}"));
            }
            _ if read => self.outside(pointer, format!("{owner}: {name}, where FF's subset takes {FUNCTIONS}")),
            // Left for AWS: the names it refers to are still checked.
            _ => self.value(pointer, owner, args, read),
        }
    }

    /// A value at a key, as its shape takes it.
    fn shape(&mut self, pointer: &str, owner: &str, path: &str, value: &Value, shape: &Shape) {
        let subject = if path.is_empty() { owner.to_owned() } else { of(owner, path) };
        match shape {
            V => self.value(pointer, &subject, value, true),
            Left => self.value(pointer, &subject, value, false),
            Outside(why) => self.outside(pointer, format!("{subject}: {why}")),
            Keys(keys) => match value {
                Value::Object(map) if resolve::intrinsic(map).is_none() => self.keys(pointer, owner, path, map, keys),
                _ => self.value(pointer, &subject, value, true),
            },
            OneOf(allowed, why) => self.one_of(pointer, &subject, value, allowed, why),
            EachOf(allowed, why) => match value {
                Value::Array(items) => {
                    for (index, item) in items.iter().enumerate() {
                        self.one_of(&at(pointer, &index.to_string()), &subject, item, allowed, why);
                    }
                }
                _ => self.value(pointer, &subject, value, true),
            },
            Code => match value {
                Value::String(path) if path.starts_with("s3://") => self.outside(
                    pointer,
                    format!("{subject} {path}: FF builds a function from a folder or a .zip on this machine"),
                ),
                Value::Object(map) if resolve::intrinsic(map).is_none() => self.outside(
                    pointer,
                    format!(
                        "{subject}: an S3 location, where FF builds a function from a folder or a .zip on this machine"
                    ),
                ),
                _ => self.value(pointer, &subject, value, true),
            },
            Events => match value {
                Value::Object(events) => {
                    for (name, event) in events {
                        self.event(&at(pointer, name), owner, name, event);
                    }
                }
                _ => self.invalid(pointer, format!("{subject}: a function's events are a mapping, each by its name")),
            },
        }
    }

    /// A value that must be one of a list, or a parameter whose value is.
    fn one_of(&mut self, pointer: &str, subject: &str, value: &Value, allowed: &[&str], why: &str) {
        let parameter = value.as_object().and_then(|map| map.get("Ref")).and_then(Value::as_str);
        let text = match parameter {
            Some(name) => self.values.get(name).and_then(text_of),
            None => text_of(value),
        };
        match text {
            Some(text) if !allowed.contains(&text.as_str()) => {
                self.outside(pointer, format!("{subject} {text}: {why}"))
            }
            Some(_) => {}
            // A value FF reads at the deploy: its names checked.
            None => self.value(pointer, subject, value, true),
        }
    }

    /// A mapping's keys, each as its shape takes it; one the subset hasn't outside it.
    fn keys(&mut self, pointer: &str, owner: &str, path: &str, map: &Map<String, Value>, keys: &[(&str, Shape)]) {
        for (key, value) in map {
            let pointer = at(pointer, key);
            let path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
            match keys.iter().find(|(name, _)| name == key) {
                Some((_, shape)) => self.shape(&pointer, owner, &path, value, shape),
                None => self.outside(&pointer, format!("{}: not in FF's subset", of(owner, &path))),
            }
        }
    }

    /// A function's event.
    fn event(&mut self, pointer: &str, function: &str, name: &str, event: &Value) {
        let subject = format!("{} {name}", of(function, "event"));
        let Some(event) = event.as_object() else {
            return self.invalid(pointer, format!("{subject}: an event is a mapping, its Type and its Properties"));
        };
        let Some(kind) = event.get("Type").and_then(Value::as_str) else {
            return self.invalid(pointer, format!("{subject}: an event needs its Type"));
        };
        let type_at = at(pointer, "Type");
        if kind == "Api" {
            return self.outside(&type_at, format!("{subject}: {API_EVENT}"));
        }
        let Some((_, properties)) = EVENTS.iter().find(|(name, _)| *name == kind) else {
            return self.outside(
                &type_at,
                format!(
                    "{subject}, of type {kind}: FF's subset takes {} events",
                    in_words(&EVENTS.iter().map(|(name, _)| *name).collect::<Vec<_>>())
                ),
            );
        };
        for key in event.keys().filter(|key| *key != "Type" && *key != "Properties") {
            self.outside(&at(pointer, key), format!("{}: not in FF's subset", of(&subject, key)));
        }
        let properties_at = at(pointer, "Properties");
        match event.get("Properties") {
            Some(Value::Object(map)) => self.keys(&properties_at, &subject, "", map, properties),
            None if kind == "HttpApi" => {}
            _ => self.invalid(pointer, format!("{subject}: a {kind} event needs its Properties")),
        }
        if kind == "HttpApi" {
            self.http_events.push((function.to_owned(), pointer.to_owned()));
        }
        // SAM takes an S3 event's bucket as a `Ref` of one of the template's.
        let bucket = event.get("Properties").and_then(|properties| properties.get("Bucket"));
        if kind == "S3" {
            let named = bucket.and_then(|bucket| bucket.get("Ref")).and_then(Value::as_str);
            let is_bucket = named.and_then(|name| self.resources.get(name)).and_then(|resource| resource.get("Type"))
                == Some(&Value::from("AWS::S3::Bucket"));
            if !is_bucket {
                self.invalid(
                    &at(&properties_at, "Bucket"),
                    format!("{subject}: SAM takes an S3 event's Bucket as !Ref of an AWS::S3::Bucket of the template"),
                );
            }
        }
    }

    /// A resource: its type, its attributes, its properties.
    fn resource(&mut self, id: &str, resource: &Value) {
        let pointer = at("/Resources", id);
        let Some(resource) = resource.as_object() else {
            return self.invalid(&pointer, format!("{id}: a resource is a mapping, with its Type"));
        };
        let Some(kind) = resource.get("Type").and_then(Value::as_str) else {
            return self.invalid(&pointer, format!("{id}: a resource needs its Type"));
        };
        let Some(kind_of) = TYPES.iter().find(|of| of.name == kind) else {
            let why = OTHER_TYPES
                .iter()
                .find(|(name, _)| if name.ends_with("::") { kind.starts_with(name) } else { kind == *name })
                .map(|(_, why)| (*why).to_owned())
                .unwrap_or_else(|| {
                    format!(
                        "a type outside FF's subset, which takes {}",
                        in_words(&TYPES.iter().map(|of| of.name).collect::<Vec<_>>())
                    )
                });
            return self.outside(&at(&pointer, "Type"), format!("{id}, {}: {why}", with_article(kind)));
        };
        for (key, value) in resource {
            let key_at = at(&pointer, key);
            match key.as_str() {
                "Type" => {}
                "Properties" => match value {
                    Value::Object(properties) => self.keys(&key_at, id, "", properties, kind_of.properties),
                    _ => self.invalid(&key_at, format!("{}: a mapping", of(id, "Properties"))),
                },
                "Metadata" => self.value(&key_at, id, value, false),
                "DependsOn" => {
                    let names: Vec<&Value> = match value {
                        Value::Array(names) => names.iter().collect(),
                        name => vec![name],
                    };
                    for name in names {
                        if !name.as_str().is_some_and(|name| self.resources.contains_key(name)) {
                            let named = name.as_str().unwrap_or("a value that isn't a name");
                            let subject = of(id, "DependsOn");
                            self.invalid(&key_at, format!("{subject}: {named} names no resource of the template"));
                        }
                    }
                }
                "DeletionPolicy" | "UpdateReplacePolicy" => {
                    let why = "FF deletes what it made of a template, at `ff delete-stack` and once the template has \
                               it no more, or keeps it";
                    self.shape(&key_at, id, key, value, &OneOf(&["Delete", "Retain"], why));
                }
                "Condition" => self.outside(&key_at, format!("{}: {CONDITIONS}", of(id, "Condition"))),
                "UpdatePolicy" | "CreationPolicy" => {
                    let subject = of(id, key);
                    self.outside(&key_at, format!("{subject}: CloudFormation's, which FF's deploys have no use for"));
                }
                _ => self.invalid(&key_at, format!("{}: not one of CloudFormation's keys of a resource", of(id, key))),
            }
        }
        if kind == FUNCTION {
            self.function(id);
        }
    }

    /// What a function needs, its own or in the Globals: its code, its handler, its runtime.
    fn function(&mut self, id: &str) {
        if ["InlineCode", "ImageUri", "PackageType"].iter().any(|name| self.property(id, name).is_some()) {
            return;
        }
        for name in ["CodeUri", "Handler", "Runtime"] {
            if self.property(id, name).is_none() {
                let pointer = at("/Resources", id);
                self.invalid(
                    &pointer,
                    format!("{id}: no {name}, which a function's zip needs, its own or the Globals'"),
                );
            }
        }
    }

    fn globals(&mut self, globals: &Value) {
        let Some(globals) = globals.as_object() else {
            return self.invalid("/Globals", "Globals: a mapping, by the type of resource".to_owned());
        };
        for (section, value) in globals {
            let pointer = at("/Globals", section);
            if section != "Function" {
                self.outside(&pointer, format!("Globals' {section}: FF's subset takes the Globals of functions alone"));
                continue;
            }
            let Some(properties) = value.as_object() else {
                self.invalid(&pointer, "Globals' Function: a mapping of a function's properties".to_owned());
                continue;
            };
            for (key, value) in properties {
                let key_at = at(&pointer, key);
                if NOT_GLOBAL.contains(&key.as_str()) {
                    self.invalid(
                        &key_at,
                        format!("Globals' Function.{key}: each function's own, which SAM's Globals don't take"),
                    );
                    continue;
                }
                match FUNCTION_PROPERTIES.iter().find(|(name, _)| name == key) {
                    Some((_, shape)) => self.shape(&key_at, "Globals", &format!("Function.{key}"), value, shape),
                    None => self.outside(&key_at, format!("Globals' Function.{key}: not in FF's subset")),
                }
            }
        }
    }

    fn parameter(&mut self, name: &str, parameter: &Value) {
        let pointer = at("/Parameters", name);
        let subject = format!("the parameter {name}");
        let key_of = |key: &str| of(&subject, key);
        let Some(parameter) = parameter.as_object() else {
            return self.invalid(&pointer, format!("{subject}: a mapping, with its Type"));
        };
        match parameter.get("Type").and_then(Value::as_str) {
            None => self.invalid(&pointer, format!("{subject}: a parameter needs its Type")),
            Some(kind) if !parameters::TYPES.contains(&kind) => self.outside(
                &at(&pointer, "Type"),
                format!(
                    "{} {kind}: one that CloudFormation checks against the account's resources on AWS, where FF's \
                     subset takes {}",
                    key_of("Type"),
                    in_words(&parameters::TYPES)
                ),
            ),
            Some(_) => {}
        }
        for key in parameter.keys().filter(|key| !PARAMETER_KEYS.contains(&key.as_str())) {
            self.invalid(
                &at(&pointer, key),
                format!("{}: not one of CloudFormation's keys of a parameter", key_of(key)),
            );
        }
    }

    fn output(&mut self, name: &str, output: &Value) {
        let pointer = at("/Outputs", name);
        let subject = format!("the output {name}");
        let Some(output) = output.as_object() else {
            return self.invalid(&pointer, format!("{subject}: a mapping, with its Value"));
        };
        if !output.contains_key("Value") {
            self.invalid(&pointer, format!("{subject}: an output needs its Value"));
        }
        for (key, value) in output {
            let key_at = at(&pointer, key);
            match key.as_str() {
                "Value" => self.value(&key_at, &of(&subject, "Value"), value, true),
                "Description" => self.value(&key_at, &subject, value, true),
                "Export" => self.outside(
                    &key_at,
                    format!(
                        "{}, which Fn::ImportValue reads in another stack: FF's stacks share no values",
                        of(&subject, "Export")
                    ),
                ),
                "Condition" => self.outside(&key_at, format!("{}: {CONDITIONS}", of(&subject, "Condition"))),
                _ => self
                    .invalid(&key_at, format!("{}: not one of CloudFormation's keys of an output", of(&subject, key))),
            }
        }
    }

    fn transform(&mut self, transform: Option<&Value>) {
        match transform {
            Some(Value::String(name)) if name == TRANSFORM => {}
            None => {
                if self.functions().next().is_some() {
                    self.invalid(
                        "",
                        format!("the template has AWS::Serverless resources, which need Transform: {TRANSFORM}"),
                    );
                }
            }
            Some(other) => {
                let other = text_of(other).unwrap_or_else(|| other.to_string());
                self.outside("/Transform", format!("Transform {other}: FF's subset takes SAM's alone, {TRANSFORM}"));
            }
        }
    }

    /// HttpApi events of more than one function: FF's routes go to one function's URL.
    fn http_apis(&mut self) {
        let template = self.template;
        self.http_events.sort_by_key(|(_, pointer)| template.line(pointer));
        let Some((first, _)) = self.http_events.first().cloned() else { return };
        let others: Vec<(String, String)> =
            self.http_events.iter().filter(|(function, _)| *function != first).cloned().collect();
        for (function, pointer) in others {
            self.outside(
                &pointer,
                format!(
                    "{}: FF puts an HttpApi's routes on one function's URL, and {first} has some",
                    of(&function, "HttpApi event")
                ),
            );
        }
    }
}

/// What of the template is outside FF's subset, or wrong, in the template's order: `values` are the parameters' known,
/// by which a value given as `!Ref` of one is checked.
pub fn check(template: &Template, values: &BTreeMap<String, Value>) -> Vec<Problem> {
    let empty = Map::new();
    let Some(root) = template.value.as_object() else {
        return vec![Problem {
            pointer: String::new(),
            line: Some(1),
            kind: Kind::Invalid,
            message: "a template is a mapping, its Resources among its sections".to_owned(),
        }];
    };
    let section = |name: &str| root.get(name).and_then(Value::as_object).unwrap_or(&empty);
    let mut checker = Checker {
        template,
        merged: resolve::with_globals(&template.value),
        parameters: section("Parameters"),
        resources: section("Resources"),
        values,
        http_events: Vec::new(),
        problems: Vec::new(),
    };
    if checker.resources.is_empty() {
        checker.invalid("", "the template has no Resources, which CloudFormation needs one of at least".to_owned());
    }
    for (key, value) in root {
        let pointer = at("", key);
        match key.as_str() {
            "Transform" => {}
            "Globals" => checker.globals(value),
            "Parameters" | "Resources" | "Outputs" if !value.is_object() => {
                checker.invalid(&pointer, format!("{key}: a mapping, by name"));
            }
            "Parameters" => {
                for (name, parameter) in section("Parameters") {
                    checker.parameter(name, parameter);
                }
            }
            "Resources" => {
                for (id, resource) in section("Resources") {
                    checker.resource(id, resource);
                }
            }
            "Outputs" => {
                for (name, output) in section("Outputs") {
                    checker.output(name, output);
                }
            }
            _ => match SECTIONS.iter().find(|(name, _)| name == key) {
                Some((_, shape)) => checker.shape(&pointer, key, "", value, shape),
                None => checker.invalid(&pointer, format!("{key}: not one of a template's sections")),
            },
        }
    }
    checker.transform(root.get("Transform"));
    checker.http_apis();
    let mut problems = checker.problems;
    problems.sort_by(|a, b| (a.line, &a.pointer).cmp(&(b.line, &b.pointer)));
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sam::read;

    /// The problems of a template, each `line kind: message`.
    fn problems(text: &str) -> Vec<String> {
        problems_with(text, &BTreeMap::new())
    }

    fn problems_with(text: &str, values: &BTreeMap<String, Value>) -> Vec<String> {
        check(&read(text).unwrap(), values)
            .into_iter()
            .map(|problem| {
                let kind = if problem.kind == Kind::Outside { "outside" } else { "invalid" };
                format!("{} {kind}: {}", problem.line.unwrap_or(0), problem.message)
            })
            .collect()
    }

    /// The fixtures: `sam init`'s hello worlds, the small app the SAM spike deployed, `ff export`'s own template.
    const HELLO_NODE: &str = include_str!("testdata/hello-node.yaml");
    const HELLO_PYTHON: &str = include_str!("testdata/hello-python.yaml");
    const SMALL_APP: &str = include_str!("../../../hack/spikes/lambda/sam/template.yaml");
    const EXPORTED: &str = include_str!("../commands/export/testdata/shop-template.yaml");

    #[test]
    fn sam_inits_hello_worlds_are_outside_by_their_api_its_outputs_and_nodes_runtime() {
        let api = "an Api event makes an API Gateway REST API, which FF hasn't: the function's FunctionUrlConfig \
                   gives it a URL, and HttpApi events, all of one function, go to that URL";
        let outputs = |first: usize| {
            [
                format!(
                    "{first} outside: the output HelloWorldApi's Value: Ref ServerlessRestApi: ServerlessRestApi, the \
                     API SAM makes of a template's Api events: {api}"
                ),
                format!(
                    "{first} outside: the output HelloWorldApi's Value: Ref AWS::URLSuffix: AWS::URLSuffix, the domain \
                     of AWS's endpoints, which FF's aren't on"
                ),
                format!(
                    "{} outside: the output HelloWorldFunctionIamRole's Value: Fn::GetAtt HelloWorldFunctionRole.Arn: \
                     HelloWorldFunctionRole, the IAM role SAM makes for HelloWorldFunction: {IAM}",
                    first + 6
                ),
            ]
        };
        let mut node = vec![
            "20 outside: HelloWorldFunction's Runtime nodejs22.x: FF runs nodejs24.x and python3.13, as Lambda names \
             them"
                .to_owned(),
            format!("25 outside: HelloWorldFunction's event HelloWorld: {api}"),
        ];
        node.extend(outputs(36));
        assert_eq!(problems(HELLO_NODE), node);
        let mut python = vec![format!("25 outside: HelloWorldFunction's event HelloWorld: {api}")];
        python.extend(outputs(36));
        assert_eq!(problems(HELLO_PYTHON), python);
    }

    #[test]
    fn the_small_app_is_outside_by_its_runtime_alone_and_the_exports_template_is_in_it() {
        assert_eq!(
            problems(SMALL_APP),
            [
                "9 outside: Globals' Function.Runtime nodejs22.x: FF runs nodejs24.x and python3.13, as Lambda names them"
            ]
        );
        assert_eq!(problems(&SMALL_APP.replace("nodejs22.x", "nodejs24.x")), Vec::<String>::new());
        assert_eq!(problems(EXPORTED), Vec::<String>::new());
    }

    #[test]
    fn each_refusal_is_named_once_at_its_line_and_what_refers_to_it_is_left_be() {
        assert_eq!(
            problems(include_str!("testdata/conditions.yaml")),
            [
                format!("9 outside: Conditions: {CONDITIONS}"),
                format!("18 outside: Orders' MemorySize: Fn::If: {CONDITIONS}"),
                format!("21 outside: Archive's Condition: {CONDITIONS}"),
            ]
        );
        assert_eq!(
            problems(include_str!("testdata/layers.yaml")),
            [
                format!("5 outside: Libraries, an AWS::Serverless::LayerVersion: {LAYERS}"),
                format!("15 outside: Report's Layers: {LAYERS}"),
            ]
        );
        assert_eq!(
            problems(include_str!("testdata/tables.yaml")),
            [
                format!("5 outside: Orders, an AWS::Serverless::SimpleTable: {TABLES}"),
                format!("7 outside: Sessions, an AWS::DynamoDB::Table: {TABLES}"),
            ]
        );
        assert_eq!(
            problems(include_str!("testdata/iam.yaml")),
            [
                format!("5 outside: WorkerRole, an AWS::IAM::Role: {IAM}"),
                format!(
                    "30 outside: the output ReaderRole's Value: Fn::GetAtt ReaderRole.Arn: ReaderRole, the IAM role SAM \
                     makes for Reader: {IAM}"
                ),
            ]
        );
    }

    #[test]
    fn what_cloudformation_or_sam_would_refuse_is_told_apart_from_what_ff_hasnt() {
        let text = "\
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: !Ref Runtime
    Events: {}
  Api:
    Cors: '*'
Parameters:
  Runtime:
    Type: String
    Default: nodejs24.x
  Vpc:
    Type: AWS::EC2::VPC::Id
    Secret: true
Resources:
  Orders:
    Type: AWS::Serverless::Function
    DependsOn: [Queue, Nothing]
    Properties:
      CodeUri: s3://builds/orders.zip
      Architectures: [arm64]
      Environment:
        Variables:
          QUEUE: !GetAtt Queue.Url
          TOPIC: !Ref Topic
          ZONE: !Select [0, !GetAZs '']
          TEXT: !Sub ['${Stage}-${AWS::Region}-${Queue.Arn}-${Orders.Alias}', {Stage: !Ref Runtime}]
      Events:
        Upload:
          Type: S3
          Properties:
            Bucket: photos
            Events: s3:ObjectCreated:*
        Route:
          Type: HttpApi
        Daily:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(1 day)
            ScheduleExpressionTimezone: Africa/Tunis
  Other:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: other/
      Handler: index.handler
      Events:
        Route:
          Type: HttpApi
          Properties:
            PayloadFormatVersion: '1.0'
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      FifoQueue: true
Outputs:
  Arn:
    Value: !GetAtt Orders.Arn
    Export:
      Name: orders
Extra: 1
";
        assert_eq!(
            problems_with(text, &BTreeMap::from([("Runtime".to_owned(), Value::from("nodejs22.x"))])),
            [
                "4 outside: Globals' Function.Runtime nodejs22.x: FF runs nodejs24.x and python3.13, as Lambda names them",
                "5 invalid: Globals' Function.Events: each function's own, which SAM's Globals don't take",
                "6 outside: Globals' Api: FF's subset takes the Globals of functions alone",
                "13 outside: the parameter Vpc's Type AWS::EC2::VPC::Id: one that CloudFormation checks against the \
                 account's resources on AWS, where FF's subset takes String, Number, CommaDelimitedList and List<Number>",
                "14 invalid: the parameter Vpc's Secret: not one of CloudFormation's keys of a parameter",
                "16 invalid: Orders: no Handler, which a function's zip needs, its own or the Globals'",
                "18 invalid: Orders' DependsOn: Nothing names no resource of the template",
                "20 outside: Orders' CodeUri s3://builds/orders.zip: FF builds a function from a folder or a .zip on \
                 this machine",
                "21 outside: Orders' Architectures arm64: FF runs x86_64 alone",
                "24 outside: Orders' Environment.Variables: Fn::GetAtt Queue.Url: of Queue, FF gives Arn, QueueName \
                 and QueueUrl",
                "25 invalid: Orders' Environment.Variables: Ref Topic: Topic names no parameter or resource of the \
                 template",
                "26 outside: Orders' Environment.Variables: Fn::Select, where FF's subset takes Ref, Fn::GetAtt, \
                 Fn::Sub and Fn::Join",
                "27 invalid: Orders' Environment.Variables: Ref Orders.Alias: Orders has no AutoPublishAlias, which \
                 makes its alias and its versions",
                "32 invalid: Orders' event Upload: SAM takes an S3 event's Bucket as !Ref of an AWS::S3::Bucket of the \
                 template",
                "40 outside: Orders' event Daily's ScheduleExpressionTimezone Africa/Tunis: FF's schedules run in UTC",
                "47 outside: Other's HttpApi event: FF puts an HttpApi's routes on one function's URL, and Orders has \
                 some",
                "50 outside: Other's event Route's PayloadFormatVersion 1.0: a function's URL sends the event of \
                 version 2.0, which an HttpApi's routes become",
                "54 outside: Queue's FifoQueue true: FF's queues are standard queues: FIFO queues come later",
                "58 outside: the output Arn's Export, which Fn::ImportValue reads in another stack: FF's stacks share \
                 no values",
                "60 invalid: Extra: not one of a template's sections",
            ]
            .map(str::to_owned)
        );
        assert_eq!(
            problems(
                "Resources:\n  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      CodeUri: f/\n      \
                      Handler: a.b\n      Runtime: python3.13\n"
            ),
            [format!("1 invalid: the template has AWS::Serverless resources, which need Transform: {TRANSFORM}")]
        );
    }
}
