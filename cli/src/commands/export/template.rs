//! The export's SAM template: the functions with their roles, URLs, schedules, queues read, buckets'
//! events and settings for calls that don't wait; the queues; the buckets. What AWS takes otherwise
//! than FF has it is written as AWS takes it, and said in the notes `MIGRATION.md` lists.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use super::super::queues::Queue;
use super::account::{Account, AsyncConfig, BucketRecord, Destination, FunctionRecord, Notification};
use super::names::{LogicalIds, lambda_names};
use super::roles::{self, Role, Target};
use super::yaml::Yaml;
use crate::api::types::name_in_arn;

/// The instances a function runs at most unless its owner says otherwise: no cap to carry to AWS.
pub const DEFAULT_MAX_INSTANCES: u32 = 3;
/// The parameter that turns the schedules on at AWS, off until the move, so that none runs twice.
pub const SCHEDULES_STATE: &str = "ScheduleState";

/// A function of the export: its names on FF and on Lambda, its logical ID, its zip, and the
/// stack's output that gives its URL when it has one.
pub struct Exported {
    pub name: String,
    pub lambda_name: String,
    pub logical_id: String,
    pub code: String,
    pub url_output: Option<String>,
}

/// A value the template takes as a parameter and the export doesn't write.
pub struct Parameter {
    pub id: String,
    pub function: String,
    pub name: String,
    pub secret: bool,
}

/// The template, as text, and what an export says about it.
pub struct Template {
    pub text: String,
    /// The same without the buckets' events, for a first deploy before the buckets' files are
    /// copied, which would each call them: none when no bucket has any.
    pub before_copy: Option<String>,
    pub functions: Vec<Exported>,
    pub parameters: Vec<Parameter>,
    /// What changed on the way, or what the template can't carry, for `MIGRATION.md`.
    pub notes: Vec<String>,
}

/// FF's runtimes as Lambda names them: FF runs Node.js 24 and Python 3.13.
pub fn lambda_runtime(runtime: &str) -> &str {
    match runtime {
        "nodejs" => "nodejs24.x",
        "python" => "python3.13",
        other => other,
    }
}

/// The template of what the export read; `with_values` writes the functions' variables' values,
/// where they are parameters otherwise.
pub fn template(account: &Account, with_values: bool, header: &str) -> Template {
    let names: Vec<&str> = account.functions.iter().map(|record| record.function.name.as_str()).collect();
    let mut builder = Builder::new(account, with_values, &lambda_names(&names));
    let has_bucket_events = builder.has_bucket_events();
    let document = builder.document(true);
    let before_copy =
        has_bucket_events.then(|| Builder::new(account, with_values, &lambda_names(&names)).document(false));
    Template {
        text: format!("{header}{}", document.document()),
        before_copy: before_copy.map(|document| format!("{header}{}", document.document())),
        functions: builder.exported,
        parameters: builder.parameters,
        notes: builder.notes,
    }
}

struct Builder<'a> {
    account: &'a Account,
    with_values: bool,
    ids: LogicalIds,
    /// Each function's logical ID and name on Lambda, by its name on FF.
    functions: HashMap<&'a str, (String, String)>,
    queues: HashMap<&'a str, String>,
    buckets: HashMap<&'a str, String>,
    /// Each bucket's parameter for its name on S3: the template's, and the sites' a role uses.
    bucket_names: HashMap<&'a str, String>,
    /// Each function's role, by its name on FF.
    roles: HashMap<&'a str, Role>,
    /// The policy of each queue a bucket sends its events to.
    policies: HashMap<&'a str, String>,
    exported: Vec<Exported>,
    parameters: Vec<Parameter>,
    notes: Vec<String>,
}

impl<'a> Builder<'a> {
    fn new(account: &'a Account, with_values: bool, lambda_names: &[String]) -> Builder<'a> {
        let mut ids = LogicalIds::default();
        let mut functions = HashMap::new();
        let mut exported = Vec::new();
        for (record, lambda_name) in account.functions.iter().zip(lambda_names) {
            let id = ids.give(&record.function.name, "Function");
            functions.insert(record.function.name.as_str(), (id.clone(), lambda_name.clone()));
            exported.push(Exported {
                name: record.function.name.clone(),
                lambda_name: lambda_name.clone(),
                logical_id: id,
                code: format!("code/{lambda_name}.zip"),
                url_output: record.url.as_ref().map(|_| ids.give(&record.function.name, "Url")),
            });
        }
        let queues = account.queues.iter().map(|queue| (queue.name.as_str(), ids.give(&queue.name, "Queue"))).collect();
        let buckets: HashMap<&str, String> = account
            .buckets
            .iter()
            .filter(|bucket| bucket.website.is_none())
            .map(|bucket| (bucket.name.as_str(), ids.give(&bucket.name, "Bucket")))
            .collect();
        let proved: Vec<&str> = account
            .identities
            .iter()
            .filter(|identity| identity.status == "SUCCESS")
            .map(|identity| identity.identity.as_str())
            .collect();
        let roles: HashMap<&str, Role> = account
            .functions
            .iter()
            .map(|record| (record.function.name.as_str(), roles::role(&record.uses, &proved)))
            .collect();
        let bucket_names = account
            .buckets
            .iter()
            .filter(|bucket| {
                buckets.contains_key(bucket.name.as_str())
                    || roles.values().any(|role| role.buckets().contains(&bucket.name.as_str()))
            })
            .map(|bucket| (bucket.name.as_str(), ids.give(&bucket.name, "BucketName")))
            .collect();
        let mut policies: HashMap<&str, String> = HashMap::new();
        for bucket in account.buckets.iter().filter(|bucket| buckets.contains_key(bucket.name.as_str())) {
            for queue in bucket
                .notifications
                .queue_configurations
                .iter()
                .filter_map(|notification| notification.queue_arn.as_deref())
            {
                let queue = name_in_arn(queue);
                if !policies.contains_key(queue) {
                    policies.insert(queue, ids.give(queue, "QueuePolicy"));
                }
            }
        }
        Builder {
            account,
            with_values,
            ids,
            functions,
            queues,
            buckets,
            bucket_names,
            roles,
            policies,
            exported,
            parameters: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Whether a bucket of the template sends its events to a function or a queue of it.
    fn has_bucket_events(&self) -> bool {
        self.account.buckets.iter().filter(|bucket| self.buckets.contains_key(bucket.name.as_str())).any(|bucket| {
            bucket
                .notifications
                .lambda_function_configurations
                .iter()
                .any(|notification| self.calls_exported(notification))
                || !bucket.notifications.queue_configurations.is_empty()
        })
    }

    fn calls_exported(&self, notification: &Notification) -> bool {
        notification.lambda_function_arn.as_deref().is_some_and(|arn| self.functions.contains_key(name_in_arn(arn)))
    }

    fn document(&mut self, bucket_events: bool) -> Yaml {
        let mut parameters = Vec::new();
        let mut resources = Vec::new();
        let mut outputs = Vec::new();
        let account = self.account;
        if account.functions.iter().any(|record| record.schedules.iter().any(|schedule| schedule.enabled)) {
            parameters.push((
                SCHEDULES_STATE.to_owned(),
                Yaml::map([
                    ("Type", Yaml::from("String")),
                    ("AllowedValues", Yaml::list([Yaml::from("ENABLED"), Yaml::from("DISABLED")])),
                    ("Default", Yaml::from("DISABLED")),
                    (
                        "Description",
                        Yaml::from("ENABLED once FF's schedules are off, so that no schedule runs on both: MIGRATION.md says when"),
                    ),
                ]),
            ));
        }
        for bucket in &account.buckets {
            let Some(parameter) = self.bucket_names.get(bucket.name.as_str()) else { continue };
            let description = if bucket.website.is_some() {
                format!(
                    "The site {}'s bucket on S3, for the roles that use it: the output Bucket of data/s3-website.md's stack, FF's name until it is made",
                    bucket.name
                )
            } else {
                format!(
                    "The bucket {}'s name on S3, which names a bucket for all of S3: FF's may be taken there",
                    bucket.name
                )
            };
            parameters.push((
                parameter.clone(),
                Yaml::map([
                    ("Type", Yaml::from("String")),
                    ("Default", Yaml::from(bucket.name.as_str())),
                    ("Description", Yaml::from(description)),
                ]),
            ));
        }
        for record in &account.functions {
            let (id, lambda_name) = self.functions[record.function.name.as_str()].clone();
            let (function, function_parameters) = self.function(record, &lambda_name, bucket_events);
            parameters.extend(function_parameters);
            let url_output = self
                .exported
                .iter()
                .find(|exported| exported.name == record.function.name)
                .and_then(|exported| exported.url_output.clone());
            if let Some(output) = url_output {
                outputs.push((
                    output,
                    Yaml::map([
                        ("Description", Yaml::from(format!("{}'s URL", record.function.name))),
                        ("Value", Yaml::attribute(&format!("{id}Url"), "FunctionUrl")),
                    ]),
                ));
            }
            resources.push((id, function));
        }
        let visibility = self.visibility_needed();
        for queue in &account.queues {
            resources.push((
                self.queues[queue.name.as_str()].clone(),
                self.queue(queue, visibility.get(queue.name.as_str()).copied()),
            ));
        }
        for bucket in account.buckets.iter().filter(|bucket| self.buckets.contains_key(bucket.name.as_str())) {
            resources.push((self.buckets[bucket.name.as_str()].clone(), self.bucket(bucket, bucket_events)));
        }
        if bucket_events {
            resources.extend(self.queue_policies());
        }
        self.site_notes();
        let mut document = vec![
            ("AWSTemplateFormatVersion".to_owned(), Yaml::from("2010-09-09")),
            ("Transform".to_owned(), Yaml::from("AWS::Serverless-2016-10-31")),
            (
                "Description".to_owned(),
                Yaml::from(format!("{} ({}), from FF: written by ff export", account.name, account.id)),
            ),
        ];
        if !parameters.is_empty() {
            document.push(("Parameters".to_owned(), Yaml::Map(parameters)));
        }
        document.push(("Resources".to_owned(), Yaml::Map(resources)));
        if !outputs.is_empty() {
            document.push(("Outputs".to_owned(), Yaml::Map(outputs)));
        }
        Yaml::Map(document)
    }

    /// The function's resource, and the parameters its environment takes.
    fn function(
        &mut self,
        record: &FunctionRecord,
        lambda_name: &str,
        bucket_events: bool,
    ) -> (Yaml, Vec<(String, Yaml)>) {
        let function = &record.function;
        let mut parameters = Vec::new();
        let mut properties = vec![
            ("FunctionName".to_owned(), Yaml::from(lambda_name)),
            ("CodeUri".to_owned(), Yaml::from(format!("code/{lambda_name}.zip"))),
            ("Handler".to_owned(), Yaml::from(function.handler.as_deref().unwrap_or("function.handler"))),
            ("Runtime".to_owned(), Yaml::from(lambda_runtime(&function.runtime))),
            ("MemorySize".to_owned(), Yaml::from(function.memory)),
            ("Timeout".to_owned(), Yaml::from(function.timeout)),
        ];
        if lambda_name != function.name {
            self.notes.push(format!(
                "**{}** is `{lambda_name}` on Lambda, whose rule for names it is outside of: its callers name it so there.",
                function.name
            ));
        }
        if function.event_format.as_deref() == Some("wrapped") {
            self.notes.push(format!(
                "**{}** gets FF's original event, its input in `event.body`: move it to Lambda's event on FF first, its handler reading `event` and its `eventFormat` set to `lambda` together, as the guide says, so that it runs as it will on Lambda.",
                function.name
            ));
        }
        let mut variables = Vec::new();
        let environment = function.environment.iter().flatten();
        for (name, value) in environment {
            if self.with_values {
                variables
                    .push((name.clone(), Yaml::from(value.as_str().map_or_else(|| value.to_string(), str::to_owned))));
            } else {
                let parameter = self.parameter(&function.name, name, false);
                variables.push((name.clone(), Yaml::reference(&parameter.0)));
                parameters.push(parameter);
            }
        }
        for secret in &record.secrets {
            let parameter = self.parameter(&function.name, secret, true);
            variables.push((secret.clone(), Yaml::reference(&parameter.0)));
            parameters.push(parameter);
        }
        if !variables.is_empty() {
            properties.push(("Environment".to_owned(), Yaml::map([("Variables", Yaml::Map(variables))])));
        }
        if let Some(policies) = self.policies(record) {
            properties.push(("Policies".to_owned(), policies));
        }
        if function.min_instances > 0 {
            properties.push(("AutoPublishAlias".to_owned(), Yaml::from("live")));
            properties.push((
                "ProvisionedConcurrencyConfig".to_owned(),
                Yaml::map([("ProvisionedConcurrentExecutions", Yaml::from(function.min_instances))]),
            ));
            self.notes.push(format!(
                "**{}** keeps {} instance(s) warm on FF: on AWS, provisioned concurrency on its alias `live`, billed by the hour while it is set, called or not.",
                function.name, function.min_instances
            ));
        }
        if function.max_instances != DEFAULT_MAX_INSTANCES {
            properties.push(("ReservedConcurrentExecutions".to_owned(), Yaml::from(function.max_instances)));
            self.notes.push(format!(
                "**{}** runs {} instance(s) at most on FF: on AWS, reserved concurrency, which the account's quota must leave room for (Lambda keeps 100 unreserved).",
                function.name, function.max_instances
            ));
        }
        if let Some(url) = &record.url {
            properties.push((
                "FunctionUrlConfig".to_owned(),
                url_config(url.auth_type.as_str(), url.cors.as_ref(), url.invoke_mode.as_deref()),
            ));
            if url.auth_type == "AWS_IAM" {
                self.notes.push(format!(
                    "**{}**'s URL takes FF's API keys on FF: on AWS, `AWS_IAM` takes a request signed by an IAM user or role allowed `lambda:InvokeFunctionUrl`, and no API key.",
                    function.name
                ));
            }
            for domain in &record.domains {
                self.notes.push(format!(
                    "**{}**'s URL answers at `{domain}` on FF: on AWS, a CloudFront distribution in front of the function URL does, as `data/lambda.md` says.",
                    function.name
                ));
            }
        }
        if let Some(config) = record.async_config.as_ref().and_then(|config| self.async_config(config, &function.name))
        {
            properties.push(("EventInvokeConfig".to_owned(), config));
        }
        let events = self.events(record, bucket_events);
        if !events.is_empty() {
            properties.push(("Events".to_owned(), Yaml::Map(events)));
        }
        let resource =
            Yaml::map([("Type", Yaml::from("AWS::Serverless::Function")), ("Properties", Yaml::Map(properties))]);
        (resource, parameters)
    }

    /// A variable's or a secret's parameter, by the function's name and its own, `SendReceiptsDatabaseUrl`:
    /// its ID and its declaration.
    fn parameter(&mut self, function: &str, name: &str, secret: bool) -> (String, Yaml) {
        let id = self.ids.give(&format!("{function} {name}"), "");
        let mut properties = vec![("Type".to_owned(), Yaml::from("String"))];
        if secret {
            properties.push(("NoEcho".to_owned(), Yaml::from(true)));
            properties.push(("Description".to_owned(), Yaml::from(format!("{function}'s secret {name}"))));
        } else {
            properties.push((
                "Description".to_owned(),
                Yaml::from(format!("{function}'s variable {name}, which `ff env list {function} --show` gives")),
            ));
        }
        self.parameters.push(Parameter {
            id: id.clone(),
            function: function.to_owned(),
            name: name.to_owned(),
            secret,
        });
        (id, Yaml::Map(properties))
    }

    /// The function's `Policies`: what its keys used on FF, through SAM's templates and a policy of
    /// statements for the rest; none when they used nothing.
    fn policies(&mut self, record: &FunctionRecord) -> Option<Yaml> {
        let function = &record.function.name;
        if record.uses.is_empty() {
            self.notes.push(format!(
                "**{function}**'s keys used no bucket, queue or mail of the account on FF: its role allows none."
            ));
            return None;
        }
        let role = &self.roles[function.as_str()];
        for operation in &role.unknown {
            self.notes.push(format!(
                "**{function}**'s keys used {operation}, which this export knows no IAM action of: allow it in the function's `Policies`."
            ));
        }
        for bucket in role.buckets() {
            match self.account.buckets.iter().find(|held| held.name == bucket) {
                Some(site) if site.website.is_some() => self.notes.push(format!(
                    "**{function}**'s keys used the site `{bucket}`, whose bucket on AWS `data/s3-website.md`'s stack makes: give its name, that stack's output `Bucket`, as the parameter `{}`, FF's name until then.",
                    self.bucket_names[bucket]
                )),
                Some(_) => {}
                None => self.notes.push(format!(
                    "**{function}**'s keys used the bucket `{bucket}`, which the account no longer has: its role allows it by that name all the same."
                )),
            }
        }
        for queue in role.queues().into_iter().filter(|queue| !self.queues.contains_key(queue)) {
            self.notes.push(format!(
                "**{function}**'s keys used the queue `{queue}`, which the account no longer has: its role allows it by that name all the same, in the stack's account and region."
            ));
        }
        let mut policies: Vec<Yaml> = role
            .templates
            .iter()
            .map(|template| match template {
                roles::Template::Bucket(name, bucket) => {
                    Yaml::map([(*name, Yaml::map([("BucketName", self.bucket_name(bucket))]))])
                }
                roles::Template::Queue(name, queue) => {
                    Yaml::map([(*name, Yaml::map([("QueueName", self.queue_name(queue))]))])
                }
            })
            .collect();
        if !role.statements.is_empty() {
            let statements = role.statements.iter().map(|(target, actions)| {
                Yaml::map([
                    ("Effect", Yaml::from("Allow")),
                    ("Action", Yaml::list(actions.iter().map(|action| Yaml::from(action.as_str())))),
                    ("Resource", self.resource(target)),
                ])
            });
            policies.push(Yaml::map([("Version", Yaml::from("2012-10-17")), ("Statement", Yaml::list(statements))]));
        }
        (!policies.is_empty()).then_some(Yaml::List(policies))
    }

    /// A bucket's name on S3: its parameter's when the template has one, FF's otherwise.
    fn bucket_name(&self, bucket: &str) -> Yaml {
        self.bucket_names.get(bucket).map_or_else(|| Yaml::from(bucket), |parameter| Yaml::reference(parameter))
    }

    /// A queue's name: its attribute when the template holds it, FF's otherwise.
    fn queue_name(&self, queue: &str) -> Yaml {
        self.queues.get(queue).map_or_else(|| Yaml::from(queue), |id| Yaml::attribute(id, "QueueName"))
    }

    /// A queue's ARN: its attribute when the template holds it, else in the stack's account and region.
    fn queue_arn(&self, queue: &str) -> Yaml {
        self.queues.get(queue).map_or_else(
            || Yaml::sub(format!("arn:aws:sqs:${{AWS::Region}}:${{AWS::AccountId}}:{queue}")),
            |id| Yaml::attribute(id, "Arn"),
        )
    }

    /// What a statement of a role allows its actions on, as IAM names it.
    fn resource(&self, target: &Target) -> Yaml {
        match target {
            Target::Bucket(bucket) | Target::Objects(bucket) => {
                let objects = if matches!(target, Target::Objects(_)) { "/*" } else { "" };
                match self.bucket_names.get(bucket.as_str()) {
                    Some(parameter) => Yaml::sub(format!("arn:aws:s3:::${{{parameter}}}{objects}")),
                    None => Yaml::from(format!("arn:aws:s3:::{bucket}{objects}")),
                }
            }
            Target::Queue(queue) => self.queue_arn(queue),
            // `${!` is a `${` that `!Sub` leaves as it is, which an address may hold.
            Target::Identity(identity) => Yaml::sub(format!(
                "arn:aws:ses:${{AWS::Region}}:${{AWS::AccountId}}:identity/{}",
                identity.replace("${", "${!")
            )),
            Target::Function(function) => Yaml::sub(format!(
                "arn:aws:lambda:${{AWS::Region}}:${{AWS::AccountId}}:function:{}",
                self.functions.get(function.as_str()).map_or(function.as_str(), |(_, lambda_name)| lambda_name)
            )),
            Target::Account => Yaml::from("*"),
        }
    }

    fn async_config(&mut self, config: &AsyncConfig, function: &str) -> Option<Yaml> {
        let mut properties = Vec::new();
        if let Some(retries) = config.maximum_retry_attempts {
            properties.push(("MaximumRetryAttempts".to_owned(), Yaml::from(retries)));
        }
        if let Some(age) = config.maximum_event_age_in_seconds {
            properties.push(("MaximumEventAgeInSeconds".to_owned(), Yaml::from(age)));
        }
        let mut destinations = Vec::new();
        for (field, destination) in
            [("OnSuccess", &config.destination_config.on_success), ("OnFailure", &config.destination_config.on_failure)]
        {
            if let Some(destination) = self.destination(destination, function) {
                destinations.push((field.to_owned(), destination));
            }
        }
        if !destinations.is_empty() {
            properties.push(("DestinationConfig".to_owned(), Yaml::Map(destinations)));
        }
        (!properties.is_empty()).then_some(Yaml::Map(properties))
    }

    /// A destination by its type and ARN: a queue of the template by its attribute, a function by
    /// its ARN, written from its name, so that two functions naming each other make no cycle.
    fn destination(&mut self, destination: &Destination, function: &str) -> Option<Yaml> {
        let arn = destination.destination.as_deref()?;
        let name = name_in_arn(arn);
        let (kind, target) = if arn.starts_with("arn:aws:sqs:") {
            if !self.queues.contains_key(name) {
                self.notes.push(format!(
                    "**{function}** sends its calls' records to the queue `{name}`, which this export doesn't hold: it must be in the same AWS account and region."
                ));
            }
            ("SQS", self.queue_arn(name))
        } else {
            let lambda_name = match self.functions.get(name) {
                Some((_, lambda_name)) => lambda_name.clone(),
                None => {
                    self.notes.push(format!(
                        "**{function}** sends its calls' records to the function `{name}`, which this export doesn't hold: it must be in the same AWS account and region."
                    ));
                    name.to_owned()
                }
            };
            ("Lambda", Yaml::sub(format!("arn:aws:lambda:${{AWS::Region}}:${{AWS::AccountId}}:function:{lambda_name}")))
        };
        Some(Yaml::map([("Type", Yaml::from(kind)), ("Destination", target)]))
    }

    /// The function's events: its schedules, the queues it reads, and the buckets' that call it.
    fn events(&mut self, record: &FunctionRecord, bucket_events: bool) -> Vec<(String, Yaml)> {
        let mut ids = LogicalIds::default();
        let mut events = Vec::new();
        for schedule in &record.schedules {
            let mut properties = vec![("Schedule".to_owned(), Yaml::from(schedule.expression.as_str()))];
            if let Some(description) = schedule.description.as_deref().filter(|text| !text.is_empty()) {
                properties.push(("Description".to_owned(), Yaml::from(description)));
            }
            if !schedule.input.is_null() {
                properties.push(("Input".to_owned(), Yaml::from(schedule.input.to_string())));
            }
            let state = if schedule.enabled { Yaml::reference(SCHEDULES_STATE) } else { Yaml::from("DISABLED") };
            properties.push(("State".to_owned(), state));
            events.push((
                ids.give(&schedule.name, ""),
                Yaml::map([("Type", Yaml::from("Schedule")), ("Properties", Yaml::Map(properties))]),
            ));
        }
        for mapping in &record.event_sources {
            let name = name_in_arn(&mapping.event_source_arn);
            let mut properties = vec![
                ("Queue".to_owned(), self.queue_arn(name)),
                ("BatchSize".to_owned(), Yaml::from(mapping.batch_size)),
            ];
            if mapping.maximum_batching_window_in_seconds > 0 {
                properties.push((
                    "MaximumBatchingWindowInSeconds".to_owned(),
                    Yaml::from(mapping.maximum_batching_window_in_seconds),
                ));
            }
            if !mapping.function_response_types.is_empty() {
                properties.push((
                    "FunctionResponseTypes".to_owned(),
                    Yaml::list(mapping.function_response_types.iter().map(|kind| Yaml::from(kind.as_str()))),
                ));
            }
            if let Some(scaling) = &mapping.scaling_config {
                properties.push((
                    "ScalingConfig".to_owned(),
                    Yaml::map([("MaximumConcurrency", Yaml::from(scaling.maximum_concurrency))]),
                ));
            }
            if matches!(mapping.state.as_str(), "Disabled" | "Disabling") {
                properties.push(("Enabled".to_owned(), Yaml::from(false)));
            }
            events.push((
                ids.give(name, "Queue"),
                Yaml::map([("Type", Yaml::from("SQS")), ("Properties", Yaml::Map(properties))]),
            ));
        }
        if bucket_events {
            for bucket in &self.account.buckets {
                let Some(bucket_id) = self.buckets.get(bucket.name.as_str()) else { continue };
                for notification in &bucket.notifications.lambda_function_configurations {
                    if notification.lambda_function_arn.as_deref().map(name_in_arn)
                        != Some(record.function.name.as_str())
                    {
                        continue;
                    }
                    let mut properties = vec![
                        ("Bucket".to_owned(), Yaml::reference(bucket_id)),
                        (
                            "Events".to_owned(),
                            Yaml::list(notification.events.iter().map(|event| Yaml::from(event.as_str()))),
                        ),
                    ];
                    if let Some(filter) = key_filter(notification) {
                        properties.push(("Filter".to_owned(), filter));
                    }
                    let id = format!("{} {}", bucket.name, notification.id.as_deref().unwrap_or("events"));
                    events.push((
                        ids.give(&id, ""),
                        Yaml::map([("Type", Yaml::from("S3")), ("Properties", Yaml::Map(properties))]),
                    ));
                }
            }
        }
        events
    }

    /// The queues' visibility timeouts raised to their readers', said in the notes.
    fn visibility_needed(&mut self) -> BTreeMap<&'a str, u64> {
        let account = self.account;
        let needed = account.raised_visibility();
        for (name, timeout) in &needed {
            let queue = account.queue_named(name).expect("a queue of the account");
            self.notes.push(format!(
                "The queue **{name}** hides a message it gives for {} s on FF, less than its readers' timeout: {timeout} s in the template, as AWS refuses a mapping to a function with a longer timeout than its queue's.",
                queue.visibility_timeout
            ));
        }
        needed
    }

    fn queue(&self, queue: &Queue, visibility: Option<u64>) -> Yaml {
        let mut properties = vec![
            ("QueueName".to_owned(), Yaml::from(queue.name.as_str())),
            ("VisibilityTimeout".to_owned(), Yaml::from(visibility.unwrap_or(queue.visibility_timeout))),
            ("MessageRetentionPeriod".to_owned(), Yaml::from(queue.message_retention_period)),
            ("DelaySeconds".to_owned(), Yaml::from(queue.delay_seconds)),
            ("MaximumMessageSize".to_owned(), Yaml::from(queue.maximum_message_size)),
            ("ReceiveMessageWaitTimeSeconds".to_owned(), Yaml::from(queue.receive_message_wait_time_seconds)),
        ];
        if let Some(policy) = &queue.redrive_policy {
            properties.push((
                "RedrivePolicy".to_owned(),
                Yaml::map([
                    ("deadLetterTargetArn", self.queue_arn(name_in_arn(&policy.dead_letter_target_arn))),
                    ("maxReceiveCount", Yaml::from(policy.max_receive_count)),
                ]),
            ));
        }
        Yaml::map([("Type", Yaml::from("AWS::SQS::Queue")), ("Properties", Yaml::Map(properties))])
    }

    /// A bucket, its name a parameter, with its events to queues: SAM's `S3` events give the functions'.
    fn bucket(&self, bucket: &BucketRecord, bucket_events: bool) -> Yaml {
        let mut properties = vec![("BucketName".to_owned(), Yaml::reference(&self.bucket_names[bucket.name.as_str()]))];
        let mut depends_on: Vec<Yaml> = Vec::new();
        let mut configurations = Vec::new();
        for notification in bucket.notifications.queue_configurations.iter().filter(|_| bucket_events) {
            let name = notification.queue_arn.as_deref().map(name_in_arn).unwrap_or_default();
            let (Some(queue), Some(policy)) = (self.queues.get(name), self.policies.get(name)) else { continue };
            if !depends_on.contains(&Yaml::from(policy.as_str())) {
                depends_on.push(Yaml::from(policy.as_str()));
            }
            // CloudFormation takes one event a configuration, where S3's API takes a list.
            for event in &notification.events {
                let mut configuration = vec![
                    ("Event".to_owned(), Yaml::from(event.as_str())),
                    ("Queue".to_owned(), Yaml::attribute(queue, "Arn")),
                ];
                if let Some(filter) = key_filter(notification) {
                    configuration.push(("Filter".to_owned(), filter));
                }
                configurations.push(Yaml::Map(configuration));
            }
        }
        if !configurations.is_empty() {
            properties.push((
                "NotificationConfiguration".to_owned(),
                Yaml::map([("QueueConfigurations", Yaml::List(configurations))]),
            ));
        }
        let mut resource = vec![("Type".to_owned(), Yaml::from("AWS::S3::Bucket"))];
        if !depends_on.is_empty() {
            resource.push(("DependsOn".to_owned(), Yaml::List(depends_on)));
        }
        resource.push(("Properties".to_owned(), Yaml::Map(properties)));
        Yaml::Map(resource)
    }

    /// For each queue a bucket sends its events to, the policy that lets S3 send them, from those
    /// buckets alone, in the stack's account.
    fn queue_policies(&self) -> Vec<(String, Yaml)> {
        let mut senders: Vec<(&str, Vec<&str>)> = Vec::new();
        for bucket in self.account.buckets.iter().filter(|bucket| self.buckets.contains_key(bucket.name.as_str())) {
            for notification in &bucket.notifications.queue_configurations {
                let Some(queue) = notification.queue_arn.as_deref().map(name_in_arn) else { continue };
                match senders.iter_mut().find(|(name, _)| *name == queue) {
                    Some((_, buckets)) if !buckets.contains(&bucket.name.as_str()) => buckets.push(&bucket.name),
                    Some(_) => {}
                    None => senders.push((queue, vec![&bucket.name])),
                }
            }
        }
        senders
            .into_iter()
            .filter_map(|(queue, buckets)| {
                let (id, policy) = (self.queues.get(queue)?, self.policies.get(queue)?);
                let sources = Yaml::list(
                    buckets.iter().map(|bucket| Yaml::sub(format!("arn:aws:s3:::${{{}}}", self.bucket_names[bucket]))),
                );
                let statement = Yaml::map([
                    ("Effect", Yaml::from("Allow")),
                    ("Principal", Yaml::map([("Service", Yaml::from("s3.amazonaws.com"))])),
                    ("Action", Yaml::from("sqs:SendMessage")),
                    ("Resource", Yaml::attribute(id, "Arn")),
                    (
                        "Condition",
                        Yaml::map([
                            ("ArnLike", Yaml::map([("aws:SourceArn", sources)])),
                            ("StringEquals", Yaml::map([("aws:SourceAccount", Yaml::reference("AWS::AccountId"))])),
                        ]),
                    ),
                ]);
                let properties = Yaml::map([
                    ("Queues", Yaml::list([Yaml::reference(id)])),
                    (
                        "PolicyDocument",
                        Yaml::map([("Version", Yaml::from("2012-10-17")), ("Statement", Yaml::list([statement]))]),
                    ),
                ]);
                Some((
                    policy.clone(),
                    Yaml::map([("Type", Yaml::from("AWS::SQS::QueuePolicy")), ("Properties", properties)]),
                ))
            })
            .collect()
    }

    /// The sites, which `data/s3-website.md`'s own template serves through CloudFront, as FF serves
    /// them over HTTPS, rather than this one.
    fn site_notes(&mut self) {
        for bucket in self.account.buckets.iter().filter(|bucket| bucket.website.is_some()) {
            self.notes.push(format!(
                "The bucket **{}** is a site: `data/s3-website.md` serves it through CloudFront, with a template of its own, rather than this one.",
                bucket.name
            ));
            if !bucket.notifications.lambda_function_configurations.is_empty()
                || !bucket.notifications.queue_configurations.is_empty()
            {
                self.notes.push(format!(
                    "The site **{}** sends its events to functions or queues: give the bucket the site's template makes the same notifications.",
                    bucket.name
                ));
            }
        }
    }
}

/// A function URL's configuration: who may call it, its CORS in Lambda's names, its mode when it streams.
fn url_config(auth_type: &str, cors: Option<&Value>, invoke_mode: Option<&str>) -> Yaml {
    let mut properties = vec![("AuthType".to_owned(), Yaml::from(auth_type))];
    if let Some(Value::Object(cors)) = cors {
        let fields: Vec<(String, Yaml)> = cors
            .iter()
            .filter_map(|(name, value)| {
                let mut chars = name.chars();
                let field: String =
                    chars.next().map(|first| first.to_ascii_uppercase()).into_iter().chain(chars).collect();
                Yaml::json(value).map(|value| (field, value))
            })
            .collect();
        if !fields.is_empty() {
            properties.push(("Cors".to_owned(), Yaml::Map(fields)));
        }
    }
    if let Some(mode) = invoke_mode.filter(|mode| *mode != "BUFFERED") {
        properties.push(("InvokeMode".to_owned(), Yaml::from(mode)));
    }
    Yaml::Map(properties)
}

/// A notification's filter, as CloudFormation names it: `S3Key`'s rules.
fn key_filter(notification: &Notification) -> Option<Yaml> {
    let rules = &notification.filter.as_ref()?.key.filter_rules;
    (!rules.is_empty()).then(|| {
        Yaml::map([(
            "S3Key",
            Yaml::map([(
                "Rules",
                Yaml::list(rules.iter().map(|rule| {
                    Yaml::map([("Name", Yaml::from(rule.name.as_str())), ("Value", Yaml::from(rule.value.as_str()))])
                })),
            )]),
        )])
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::*;

    const HEADER: &str = "# ff export wrote this on 2026-10-31 from FF's account 123456789012.\n";

    #[test]
    fn the_template_declares_the_functions_queues_and_buckets_as_aws_takes_them() {
        let template = template(&shop(), false, HEADER);

        // `sam validate --lint` takes it as it is (the SAM CLI 1.169.0, cfn-lint inside).
        assert_eq!(template.text, include_str!("testdata/shop-template.yaml"));
        let functions: Vec<(&str, &str, &str)> = template
            .functions
            .iter()
            .map(|function| (function.name.as_str(), function.lambda_name.as_str(), function.code.as_str()))
            .collect();
        assert_eq!(
            functions,
            [
                ("make-thumbnail", "make-thumbnail", "code/make-thumbnail.zip"),
                ("report.v1", "report_v1", "code/report_v1.zip"),
                ("send-receipts", "send-receipts", "code/send-receipts.zip"),
            ]
        );
    }

    #[test]
    fn what_the_template_changes_or_leaves_is_said_once_each() {
        let notes = template(&shop(), false, HEADER).notes;

        assert_eq!(
            notes.iter().map(|note| note.split_once(':').map_or(note.as_str(), |(start, _)| start)).collect::<Vec<_>>(),
            [
                "**make-thumbnail** keeps 1 instance(s) warm on FF",
                "**make-thumbnail** runs 10 instance(s) at most on FF",
                "**report.v1** is `report_v1` on Lambda, whose rule for names it is outside of",
                "**report.v1** gets FF's original event, its input in `event.body`",
                "**report.v1**'s keys used no bucket, queue or mail of the account on FF",
                "**send-receipts**'s keys used the bucket `archive`, which the account no longer has",
                "**send-receipts**'s keys used the site `www`, whose bucket on AWS `data/s3-website.md`'s stack makes",
                "**send-receipts**'s keys used the queue `invoices`, which the account no longer has",
                "**send-receipts**'s URL takes FF's API keys on FF",
                "**send-receipts**'s URL answers at `api.shop.tn` on FF",
                "**send-receipts** sends its calls' records to the function `audit`, which this export doesn't hold",
                "The queue **orders** hides a message it gives for 30 s on FF, less than its readers' timeout",
                "The bucket **www** is a site",
            ]
        );
    }

    #[test]
    fn a_first_deploy_leaves_the_buckets_events_out_and_values_go_in_when_asked() {
        let account = shop();
        let template = template(&account, true, HEADER);

        let before_copy = template.before_copy.expect("the buckets have events");
        for gone in ["Type: S3\n", "QueueConfigurations", "AWS::SQS::QueuePolicy", "DependsOn"] {
            assert!(template.text.contains(gone) && !before_copy.contains(gone), "{gone} in the template alone");
        }
        assert!(before_copy.contains(
            "  PhotosBucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Ref PhotosBucketName\n"
        ));
        // The variable's value in the template, the secret still a parameter.
        assert!(
            template.text.contains("          LOG_LEVEL: info\n          DATABASE_URL: !Ref SendReceiptsDatabaseUrl\n")
        );
        assert!(!template.text.contains("SendReceiptsLogLevel"));
        let ids: Vec<&str> = template.parameters.iter().map(|parameter| parameter.id.as_str()).collect();
        assert_eq!(ids, ["SendReceiptsDatabaseUrl"]);

        let mut quiet = shop();
        quiet.buckets.retain(|bucket| bucket.website.is_some());
        assert!(super::template(&quiet, false, HEADER).before_copy.is_none(), "no bucket with events, one template");
    }
}
