//! The export's `terraform/`, for AWS's provider, which OpenTofu runs as Terraform does: the
//! functions, queues and buckets of the SAM template as AWS's resources, each function with a role
//! of its own that allows what its keys used, action by action, as Terraform has no policy
//! templates; the schedules off until `schedule_state` says `ENABLED`, and the buckets' events until
//! `bucket_events` says `true`, so that no schedule runs on both and the files' copy calls nothing.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use super::account::{Account, BucketRecord, Destination, FunctionRecord, Notification};
use super::hcl::{Block, Hcl, file, literal};
use super::names::{ResourceNames, lambda_names};
use super::roles::{self, Target};
use super::template::{DEFAULT_MAX_INSTANCES, Parameter, lambda_runtime};
use crate::api::types::name_in_arn;

/// The AWS provider the files take, and OpenTofu's or Terraform's version.
const PROVIDER: &str = "~> 6.0";
const TOOL: &str = ">= 1.6";
/// The managed policy that lets a function write its log, which each role has, as SAM's do.
const LOGS: &str = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
/// What Lambda's poller does with a queue a function reads, which SAM's roles get from
/// `AWSLambdaSQSQueueExecutionRole` and these from a statement on that queue alone.
const QUEUE_READ: [&str; 3] = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"];
/// The alias a function with warm instances is called through, as SAM's `AutoPublishAlias` names it.
const ALIAS: &str = "live";
/// The account's ID and its region, which an ARN of a resource outside the files names.
const ACCOUNT_ID: &str = "${data.aws_caller_identity.current.account_id}";
const REGION: &str = "${var.region}";
/// The document that lets Lambda take each role.
const ASSUME_ROLE: &str = "lambda_assume_role";

/// `terraform/`'s files, by their paths in the export's folder, and the variables the export
/// doesn't fill, which `terraform.tfvars.example` lists.
pub struct Terraform {
    pub files: Vec<(String, String)>,
    pub to_fill: Vec<Parameter>,
}

/// A function's names in the files: its resources', on Lambda, and its alias's when it has warm
/// instances.
#[derive(Clone)]
struct Names {
    name: String,
    lambda_name: String,
    alias: Option<String>,
}

/// The files of what the export read; `with_values` writes the functions' variables' values,
/// where they are variables otherwise.
pub fn terraform(account: &Account, with_values: bool, header: &str) -> Terraform {
    let mut builder = Builder::new(account, with_values);
    let functions: Vec<Block> = account.functions.iter().flat_map(|record| builder.function(record)).collect();
    let queues = builder.queues();
    let buckets = builder.buckets();
    let outputs = builder.outputs();
    let mut files = vec![
        ("terraform/main.tf".to_owned(), format!("{header}{}", file(&main_blocks()))),
        ("terraform/variables.tf".to_owned(), format!("{header}{}", file(&builder.variables()))),
    ];
    for (path, blocks) in [
        ("terraform/functions.tf", functions),
        ("terraform/queues.tf", queues),
        ("terraform/buckets.tf", buckets),
        ("terraform/outputs.tf", outputs),
    ] {
        if !blocks.is_empty() {
            files.push((path.to_owned(), format!("{header}{}", file(&blocks))));
        }
    }
    Terraform { files, to_fill: builder.to_fill }
}

/// `main.tf`: the tool and the provider, the account's ID, and the document that lets Lambda take
/// each role.
fn main_blocks() -> Vec<Block> {
    vec![
        Block::new("terraform", &[]).attribute("required_version", TOOL).block(
            Block::new("required_providers", &[]).attribute(
                "aws",
                Hcl::object([("source", Hcl::from("hashicorp/aws")), ("version", Hcl::from(PROVIDER))]),
            ),
        ),
        Block::new("provider", &["aws"]).attribute("region", Hcl::reference("var.region")),
        Block::new("data", &["aws_caller_identity", "current"]),
        Block::new("data", &["aws_iam_policy_document", ASSUME_ROLE]).block(
            Block::new("statement", &[]).attribute("actions", Hcl::list([Hcl::from("sts:AssumeRole")])).block(
                Block::new("principals", &[])
                    .attribute("type", "Service")
                    .attribute("identifiers", Hcl::list([Hcl::from("lambda.amazonaws.com")])),
            ),
        ),
    ]
}

/// A resource, `resource "<type>" "<name>"`.
fn resource(kind: &str, name: &str) -> Block {
    Block::new("resource", &[kind, name])
}

/// A permission's ID in a function's policy, of the characters Lambda takes.
fn statement_id(text: &str) -> String {
    text.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(100).collect()
}

/// A key's name in Terraform's: `allowOrigins` is `allow_origins`.
fn snake_key(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// A variable, its type, its default when it has one, and what it is.
fn variable(name: &str, kind: &str, default: Option<Hcl>, sensitive: bool, description: &str) -> Block {
    let mut block = Block::new("variable", &[name]).attribute("type", Hcl::reference(kind));
    if let Some(default) = default {
        block = block.attribute("default", default);
    }
    if sensitive {
        block = block.attribute("sensitive", true);
    }
    block.attribute("description", description)
}

/// A notification's prefix and suffix, as the provider names them.
fn key_filter(mut block: Block, notification: &Notification) -> Block {
    let rules = notification.filter.iter().flat_map(|filter| &filter.key.filter_rules);
    for rule in rules {
        block = block.attribute(&format!("filter_{}", rule.name.to_ascii_lowercase()), rule.value.as_str());
    }
    block
}

struct Builder<'a> {
    account: &'a Account,
    with_values: bool,
    names: ResourceNames,
    /// Each function's names, by its name on FF.
    functions: HashMap<&'a str, Names>,
    queues: HashMap<&'a str, String>,
    buckets: HashMap<&'a str, String>,
    /// The variable of each bucket's name on S3: the files', and the sites' a role uses.
    bucket_variables: HashMap<&'a str, String>,
    /// The mail identities the account proved, which SES sends as.
    proved: Vec<&'a str>,
    variables: Vec<Block>,
    to_fill: Vec<Parameter>,
}

impl<'a> Builder<'a> {
    fn new(account: &'a Account, with_values: bool) -> Builder<'a> {
        let mut names = ResourceNames::default();
        names.give("aws_iam_policy_document", ASSUME_ROLE);
        for reserved in ["region", "schedule_state", "bucket_events"] {
            names.give("variable", reserved);
        }
        let ff_names: Vec<&str> = account.functions.iter().map(|record| record.function.name.as_str()).collect();
        let mut functions = HashMap::new();
        for (record, lambda_name) in account.functions.iter().zip(lambda_names(&ff_names)) {
            let name = names.give("aws_lambda_function", &record.function.name);
            let alias = (record.function.min_instances > 0).then(|| names.give("aws_lambda_alias", &name));
            functions.insert(record.function.name.as_str(), Names { name, lambda_name, alias });
        }
        let queues = account
            .queues
            .iter()
            .map(|queue| (queue.name.as_str(), names.give("aws_sqs_queue", &queue.name)))
            .collect();
        let buckets: HashMap<&str, String> = account
            .buckets
            .iter()
            .filter(|bucket| bucket.website.is_none())
            .map(|bucket| (bucket.name.as_str(), names.give("aws_s3_bucket", &bucket.name)))
            .collect();
        let proved: Vec<&str> = account
            .identities
            .iter()
            .filter(|identity| identity.status == "SUCCESS")
            .map(|identity| identity.identity.as_str())
            .collect();
        let used = |bucket: &str| {
            account.functions.iter().any(|record| roles::statements(&record.uses, &proved).buckets().contains(&bucket))
        };
        let bucket_variables = account
            .buckets
            .iter()
            .filter(|bucket| buckets.contains_key(bucket.name.as_str()) || used(&bucket.name))
            .map(|bucket| (bucket.name.as_str(), names.give("variable", &format!("{} bucket name", bucket.name))))
            .collect();
        Builder {
            account,
            with_values,
            names,
            functions,
            queues,
            buckets,
            bucket_variables,
            proved,
            variables: Vec::new(),
            to_fill: Vec::new(),
        }
    }

    /// What calls a function: its alias's ARN when it has one, its own otherwise.
    fn invoked(&self, names: &Names) -> Hcl {
        match &names.alias {
            Some(alias) => Hcl::reference(format!("aws_lambda_alias.{alias}.arn")),
            None => Hcl::reference(format!("aws_lambda_function.{}.arn", names.name)),
        }
    }

    /// A resource on a function, its name and its alias's when it has one.
    fn on_function(&self, block: Block, names: &Names) -> Block {
        let block = block
            .attribute("function_name", Hcl::reference(format!("aws_lambda_function.{}.function_name", names.name)));
        match &names.alias {
            Some(alias) => block.attribute("qualifier", Hcl::reference(format!("aws_lambda_alias.{alias}.name"))),
            None => block,
        }
    }

    /// A permission that lets a service call the function, from the source named, and its name.
    fn permission(&mut self, names: &Names, id: &str, principal: &str, source: Hcl) -> (String, Block) {
        let name = self.names.give("aws_lambda_permission", &format!("{} {id}", names.name));
        let block = resource("aws_lambda_permission", &name).attribute("statement_id", statement_id(id));
        let block = self
            .on_function(block.attribute("action", "lambda:InvokeFunction"), names)
            .attribute("principal", principal)
            .attribute("source_arn", source);
        (name, block)
    }

    fn queue_arn(&self, queue: &str) -> Hcl {
        match self.queues.get(queue) {
            Some(name) => Hcl::reference(format!("aws_sqs_queue.{name}.arn")),
            None => Hcl::template(&format!("arn:aws:sqs:{REGION}:{ACCOUNT_ID}:{}", literal(queue))),
        }
    }

    fn function_arn(&self, function: &str) -> Hcl {
        match self.functions.get(function) {
            Some(names) => Hcl::reference(format!("aws_lambda_function.{}.arn", names.name)),
            None => Hcl::template(&format!("arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:{}", literal(function))),
        }
    }

    /// What a statement of a role allows its actions on.
    fn resources(&self, target: &Target) -> Hcl {
        match target {
            Target::Bucket(bucket) | Target::Objects(bucket) => {
                let objects = if matches!(target, Target::Objects(_)) { "/*" } else { "" };
                match (self.buckets.get(bucket.as_str()), self.bucket_variables.get(bucket.as_str())) {
                    (Some(name), _) if objects.is_empty() => Hcl::reference(format!("aws_s3_bucket.{name}.arn")),
                    (Some(name), _) => Hcl::template(&format!("${{aws_s3_bucket.{name}.arn}}/*")),
                    (None, Some(variable)) => Hcl::template(&format!("arn:aws:s3:::${{var.{variable}}}{objects}")),
                    (None, None) => Hcl::from(format!("arn:aws:s3:::{bucket}{objects}")),
                }
            }
            Target::Queue(queue) => self.queue_arn(queue),
            Target::Function(function) => self.function_arn(function),
            Target::Identity(identity) => {
                Hcl::template(&format!("arn:aws:ses:{REGION}:{ACCOUNT_ID}:identity/{}", literal(identity)))
            }
            Target::Account => Hcl::from("*"),
        }
    }

    /// The function's role's statements: what its keys used, then what Lambda does for it, the
    /// queues it reads and where its calls' records go.
    fn statements(&self, record: &FunctionRecord) -> Vec<Block> {
        let mut allowed: BTreeMap<Target, Vec<String>> =
            roles::statements(&record.uses, &self.proved).statements.into_iter().collect();
        let mut allow = |target: Target, actions: &[&str]| {
            let had = allowed.entry(target).or_default();
            had.extend(actions.iter().map(|action| (*action).to_owned()));
            had.sort_unstable();
            had.dedup();
        };
        for mapping in &record.event_sources {
            allow(Target::Queue(name_in_arn(&mapping.event_source_arn).to_owned()), &QUEUE_READ);
        }
        let destinations = record.async_config.iter().flat_map(|config| {
            [&config.destination_config.on_success, &config.destination_config.on_failure]
                .into_iter()
                .filter_map(|destination| destination.destination.as_deref())
        });
        for arn in destinations {
            let name = name_in_arn(arn).to_owned();
            if arn.starts_with("arn:aws:sqs:") {
                allow(Target::Queue(name), &["sqs:SendMessage"]);
            } else {
                allow(Target::Function(name), &["lambda:InvokeFunction"]);
            }
        }
        allowed
            .iter()
            .map(|(target, actions)| {
                Block::new("statement", &[])
                    .attribute("actions", Hcl::list(actions.iter().map(|action| Hcl::from(action.as_str()))))
                    .attribute("resources", Hcl::list([self.resources(target)]))
            })
            .collect()
    }

    /// A variable's or a secret's variable, by the function's name and its own,
    /// `send_receipts_database_url`.
    fn value(&mut self, function: &str, name: &str, secret: bool) -> String {
        let id = self.names.give("variable", &format!("{function} {name}"));
        let description = if secret {
            format!("{function}'s secret {name}")
        } else {
            format!("{function}'s variable {name}, which `ff env list {function} --show` gives")
        };
        self.variables.push(variable(&id, "string", None, secret, &description));
        self.to_fill.push(Parameter { id: id.clone(), function: function.to_owned(), name: name.to_owned(), secret });
        id
    }

    /// The function's resources: its role, the function, its alias, its URL, its schedules, the
    /// queues it reads and its settings for calls that don't wait.
    fn function(&mut self, record: &FunctionRecord) -> Vec<Block> {
        let function = &record.function;
        let names = self.functions[function.name.as_str()].clone();
        let name = names.name.as_str();
        let mut blocks = Vec::new();
        let role = self.names.give("aws_iam_role", name);
        // A role's name is 64 characters at most, 26 of which its prefix leaves for the provider's.
        let prefix: String = names.lambda_name.chars().take(37).collect();
        blocks.push(resource("aws_iam_role", &role).attribute("name_prefix", format!("{prefix}-")).attribute(
            "assume_role_policy",
            Hcl::reference(format!("data.aws_iam_policy_document.{ASSUME_ROLE}.json")),
        ));
        let logs = self.names.give("aws_iam_role_policy_attachment", &format!("{name} logs"));
        blocks.push(
            resource("aws_iam_role_policy_attachment", &logs)
                .attribute("role", Hcl::reference(format!("aws_iam_role.{role}.name")))
                .attribute("policy_arn", LOGS),
        );
        let statements = self.statements(record);
        if !statements.is_empty() {
            let document = self.names.give("aws_iam_policy_document", name);
            let mut data = Block::new("data", &["aws_iam_policy_document", &document]);
            for statement in statements {
                data = data.block(statement);
            }
            blocks.push(data);
            let policy = self.names.give("aws_iam_role_policy", name);
            blocks.push(
                resource("aws_iam_role_policy", &policy)
                    .attribute("name", "uses")
                    .attribute("role", Hcl::reference(format!("aws_iam_role.{role}.id")))
                    .attribute("policy", Hcl::reference(format!("data.aws_iam_policy_document.{document}.json"))),
            );
        }
        let code = format!("${{path.module}}/../code/{}.zip", names.lambda_name);
        let mut lambda = resource("aws_lambda_function", name)
            .attribute("function_name", names.lambda_name.as_str())
            .attribute("role", Hcl::reference(format!("aws_iam_role.{role}.arn")))
            .attribute("filename", Hcl::template(&code))
            .attribute("source_code_hash", Hcl::call("filebase64sha256", Hcl::template(&code)))
            .attribute("handler", function.handler.as_deref().unwrap_or("function.handler"))
            .attribute("runtime", lambda_runtime(&function.runtime))
            .attribute("memory_size", function.memory)
            .attribute("timeout", function.timeout);
        if function.max_instances != DEFAULT_MAX_INSTANCES {
            lambda = lambda.attribute("reserved_concurrent_executions", function.max_instances);
        }
        if names.alias.is_some() {
            lambda = lambda.attribute("publish", true);
        }
        let mut variables = Vec::new();
        for (key, value) in function.environment.iter().flatten() {
            let value = if self.with_values {
                Hcl::from(value.as_str().map_or_else(|| value.to_string(), str::to_owned))
            } else {
                Hcl::reference(format!("var.{}", self.value(&function.name, key, false)))
            };
            variables.push((key.clone(), value));
        }
        for secret in &record.secrets {
            variables
                .push((secret.clone(), Hcl::reference(format!("var.{}", self.value(&function.name, secret, true)))));
        }
        if !variables.is_empty() {
            lambda = lambda.block(Block::new("environment", &[]).attribute("variables", Hcl::Object(variables)));
        }
        blocks.push(lambda);
        if let Some(alias) = &names.alias {
            blocks.push(
                resource("aws_lambda_alias", alias)
                    .attribute("name", ALIAS)
                    .attribute("function_name", Hcl::reference(format!("aws_lambda_function.{name}.function_name")))
                    .attribute("function_version", Hcl::reference(format!("aws_lambda_function.{name}.version"))),
            );
            let warm = self.names.give("aws_lambda_provisioned_concurrency_config", name);
            blocks.push(
                resource("aws_lambda_provisioned_concurrency_config", &warm)
                    .attribute("function_name", Hcl::reference(format!("aws_lambda_alias.{alias}.function_name")))
                    .attribute("qualifier", Hcl::reference(format!("aws_lambda_alias.{alias}.name")))
                    .attribute("provisioned_concurrent_executions", function.min_instances),
            );
        }
        if let Some(url) = &record.url {
            let id = self.names.give("aws_lambda_function_url", name);
            let mut block = self
                .on_function(resource("aws_lambda_function_url", &id), &names)
                .attribute("authorization_type", url.auth_type.as_str());
            if let Some(mode) = url.invoke_mode.as_deref().filter(|mode| *mode != "BUFFERED") {
                block = block.attribute("invoke_mode", mode);
            }
            if let Some(Value::Object(cors)) = &url.cors {
                let mut fields = Block::new("cors", &[]);
                for (key, value) in cors {
                    if let Some(value) = Hcl::json(value) {
                        fields = fields.attribute(&snake_key(key), value);
                    }
                }
                block = block.block(fields);
            }
            blocks.push(block);
            if url.auth_type == "NONE" {
                // A URL that takes anyone's call needs the function's leave, which SAM gives it itself.
                let open = self.names.give("aws_lambda_permission", &format!("{name} url"));
                blocks.push(
                    self.on_function(
                        resource("aws_lambda_permission", &open)
                            .attribute("statement_id", "FunctionURLAllowPublicAccess")
                            .attribute("action", "lambda:InvokeFunctionUrl"),
                        &names,
                    )
                    .attribute("principal", "*")
                    .attribute("function_url_auth_type", "NONE"),
                );
            }
        }
        for schedule in &record.schedules {
            let id = self.names.give("aws_cloudwatch_event_rule", &format!("{name} {}", schedule.name));
            let rule_name: String = format!("{}-{}", names.lambda_name, schedule.name)
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
                .take(64)
                .collect();
            let mut rule = resource("aws_cloudwatch_event_rule", &id).attribute("name", rule_name);
            if let Some(description) = schedule.description.as_deref().filter(|text| !text.is_empty()) {
                rule = rule.attribute("description", description);
            }
            let state = if schedule.enabled { Hcl::reference("var.schedule_state") } else { Hcl::from("DISABLED") };
            blocks.push(rule.attribute("schedule_expression", schedule.expression.as_str()).attribute("state", state));
            let mut target = resource("aws_cloudwatch_event_target", &id)
                .attribute("rule", Hcl::reference(format!("aws_cloudwatch_event_rule.{id}.name")))
                .attribute("arn", self.invoked(&names));
            if let Some(input) = Hcl::json(&schedule.input) {
                target = target.attribute("input", Hcl::call("jsonencode", input));
            }
            blocks.push(target);
            let source = Hcl::reference(format!("aws_cloudwatch_event_rule.{id}.arn"));
            blocks.push(
                self.permission(&names, &format!("schedule-{}", schedule.name), "events.amazonaws.com", source).1,
            );
        }
        for mapping in &record.event_sources {
            let queue = name_in_arn(&mapping.event_source_arn);
            let id = self.names.give("aws_lambda_event_source_mapping", &format!("{name} {queue}"));
            let mut block = resource("aws_lambda_event_source_mapping", &id)
                .attribute("event_source_arn", self.queue_arn(queue))
                .attribute("function_name", self.invoked(&names))
                .attribute("batch_size", mapping.batch_size);
            if mapping.maximum_batching_window_in_seconds > 0 {
                block =
                    block.attribute("maximum_batching_window_in_seconds", mapping.maximum_batching_window_in_seconds);
            }
            if !mapping.function_response_types.is_empty() {
                block = block.attribute(
                    "function_response_types",
                    Hcl::list(mapping.function_response_types.iter().map(|kind| Hcl::from(kind.as_str()))),
                );
            }
            if matches!(mapping.state.as_str(), "Disabled" | "Disabling") {
                block = block.attribute("enabled", false);
            }
            if let Some(scaling) = &mapping.scaling_config {
                block = block.block(
                    Block::new("scaling_config", &[]).attribute("maximum_concurrency", scaling.maximum_concurrency),
                );
            }
            blocks.push(block);
        }
        if let Some(config) = &record.async_config {
            let mut block = self.on_function(resource("aws_lambda_function_event_invoke_config", name), &names);
            let mut set = false;
            if let Some(retries) = config.maximum_retry_attempts {
                block = block.attribute("maximum_retry_attempts", retries);
                set = true;
            }
            if let Some(age) = config.maximum_event_age_in_seconds {
                block = block.attribute("maximum_event_age_in_seconds", age);
                set = true;
            }
            let mut destinations = Block::new("destination_config", &[]);
            let mut any = false;
            for (field, destination) in [
                ("on_success", &config.destination_config.on_success),
                ("on_failure", &config.destination_config.on_failure),
            ] {
                if let Some(arn) = self.destination(destination) {
                    destinations = destinations.block(Block::new(field, &[]).attribute("destination", arn));
                    any = true;
                }
            }
            if any {
                block = block.block(destinations);
            }
            if set || any {
                blocks.push(block);
            }
        }
        blocks
    }

    /// A destination's ARN: a queue's or a function's of the files by its attribute, another's in the
    /// account and region.
    fn destination(&self, destination: &Destination) -> Option<Hcl> {
        let arn = destination.destination.as_deref()?;
        let name = name_in_arn(arn);
        Some(if arn.starts_with("arn:aws:sqs:") { self.queue_arn(name) } else { self.function_arn(name) })
    }

    /// The queues, and the policy of each one a bucket sends its events to, which lets S3 send them
    /// from those buckets alone, in the account.
    fn queues(&mut self) -> Vec<Block> {
        let raised = self.account.raised_visibility();
        let mut blocks = Vec::new();
        for queue in &self.account.queues {
            let name = &self.queues[queue.name.as_str()];
            let mut block = resource("aws_sqs_queue", name)
                .attribute("name", queue.name.as_str())
                .attribute(
                    "visibility_timeout_seconds",
                    raised.get(queue.name.as_str()).copied().unwrap_or(queue.visibility_timeout),
                )
                .attribute("message_retention_seconds", queue.message_retention_period)
                .attribute("delay_seconds", queue.delay_seconds)
                .attribute("max_message_size", queue.maximum_message_size)
                .attribute("receive_wait_time_seconds", queue.receive_message_wait_time_seconds);
            if let Some(policy) = &queue.redrive_policy {
                block = block.attribute(
                    "redrive_policy",
                    Hcl::call(
                        "jsonencode",
                        Hcl::object([
                            ("deadLetterTargetArn", self.queue_arn(name_in_arn(&policy.dead_letter_target_arn))),
                            ("maxReceiveCount", Hcl::from(policy.max_receive_count)),
                        ]),
                    ),
                );
            }
            blocks.push(block);
        }
        for (queue, buckets) in self.senders() {
            let name = self.queues[queue].clone();
            let document = self.names.give("aws_iam_policy_document", &format!("{queue} from buckets"));
            let sources = Hcl::list(
                buckets.iter().map(|bucket| Hcl::reference(format!("aws_s3_bucket.{}.arn", self.buckets[bucket]))),
            );
            blocks.push(
                Block::new("data", &["aws_iam_policy_document", &document]).block(
                    Block::new("statement", &[])
                        .attribute("actions", Hcl::list([Hcl::from("sqs:SendMessage")]))
                        .attribute("resources", Hcl::list([Hcl::reference(format!("aws_sqs_queue.{name}.arn"))]))
                        .block(
                            Block::new("principals", &[])
                                .attribute("type", "Service")
                                .attribute("identifiers", Hcl::list([Hcl::from("s3.amazonaws.com")])),
                        )
                        .block(
                            Block::new("condition", &[])
                                .attribute("test", "ArnLike")
                                .attribute("variable", "aws:SourceArn")
                                .attribute("values", sources),
                        )
                        .block(
                            Block::new("condition", &[])
                                .attribute("test", "StringEquals")
                                .attribute("variable", "aws:SourceAccount")
                                .attribute(
                                    "values",
                                    Hcl::list([Hcl::reference("data.aws_caller_identity.current.account_id")]),
                                ),
                        ),
                ),
            );
            let policy = self.names.give("aws_sqs_queue_policy", &name);
            blocks.push(
                resource("aws_sqs_queue_policy", &policy)
                    .attribute("queue_url", Hcl::reference(format!("aws_sqs_queue.{name}.id")))
                    .attribute("policy", Hcl::reference(format!("data.aws_iam_policy_document.{document}.json"))),
            );
        }
        blocks
    }

    /// Each queue of the files a bucket of them sends its events to, with those buckets.
    fn senders(&self) -> Vec<(&'a str, Vec<&'a str>)> {
        let mut senders: Vec<(&str, Vec<&str>)> = Vec::new();
        for bucket in self.held_buckets() {
            for queue in bucket
                .notifications
                .queue_configurations
                .iter()
                .filter_map(|notification| notification.queue_arn.as_deref())
            {
                let queue = name_in_arn(queue);
                if !self.queues.contains_key(queue) {
                    continue;
                }
                match senders.iter_mut().find(|(name, _)| *name == queue) {
                    Some((_, buckets)) if !buckets.contains(&bucket.name.as_str()) => buckets.push(&bucket.name),
                    Some(_) => {}
                    None => senders.push((queue, vec![&bucket.name])),
                }
            }
        }
        senders
    }

    fn held_buckets(&self) -> impl Iterator<Item = &'a BucketRecord> + '_ {
        self.account.buckets.iter().filter(|bucket| self.buckets.contains_key(bucket.name.as_str()))
    }

    /// The function of the files a notification calls.
    fn called(&self, notification: &Notification) -> Option<Names> {
        notification.lambda_function_arn.as_deref().and_then(|arn| self.functions.get(name_in_arn(arn))).cloned()
    }

    /// Whether a bucket of the files sends its events to a function or a queue of them.
    fn has_bucket_events(&self) -> bool {
        self.held_buckets().any(|bucket| {
            bucket
                .notifications
                .lambda_function_configurations
                .iter()
                .any(|notification| self.called(notification).is_some())
                || bucket.notifications.queue_configurations.iter().any(|notification| {
                    notification.queue_arn.as_deref().is_some_and(|arn| self.queues.contains_key(name_in_arn(arn)))
                })
        })
    }

    /// The buckets, the permissions that let each call its functions, and its events, made once
    /// `bucket_events` is true.
    fn buckets(&mut self) -> Vec<Block> {
        let mut blocks = Vec::new();
        let held: Vec<&BucketRecord> = self.held_buckets().collect();
        for bucket in held {
            let name = self.buckets[bucket.name.as_str()].clone();
            blocks.push(
                resource("aws_s3_bucket", &name).attribute(
                    "bucket",
                    Hcl::reference(format!("var.{}", self.bucket_variables[bucket.name.as_str()])),
                ),
            );
            let mut notification = resource("aws_s3_bucket_notification", &name)
                .attribute("count", Hcl::reference("var.bucket_events ? 1 : 0"))
                .attribute("bucket", Hcl::reference(format!("aws_s3_bucket.{name}.id")));
            let mut depends_on = Vec::new();
            for configuration in &bucket.notifications.lambda_function_configurations {
                let Some(called) = self.called(configuration) else { continue };
                let source = Hcl::reference(format!("aws_s3_bucket.{name}.arn"));
                let (permission, block) =
                    self.permission(&called, &format!("s3-{}", bucket.name), "s3.amazonaws.com", source);
                depends_on.push(Hcl::reference(format!("aws_lambda_permission.{permission}")));
                blocks.push(
                    block.attribute("source_account", Hcl::reference("data.aws_caller_identity.current.account_id")),
                );
                let mut block = Block::new("lambda_function", &[]);
                if let Some(id) = &configuration.id {
                    block = block.attribute("id", id.as_str());
                }
                block = block
                    .attribute("lambda_function_arn", self.invoked(&called))
                    .attribute("events", Hcl::list(configuration.events.iter().map(|event| Hcl::from(event.as_str()))));
                notification = notification.block(key_filter(block, configuration));
            }
            for configuration in &bucket.notifications.queue_configurations {
                let queue = configuration.queue_arn.as_deref().map(name_in_arn).unwrap_or_default();
                let Some(queue_name) = self.queues.get(queue) else { continue };
                let policy = format!("aws_sqs_queue_policy.{queue_name}");
                if !depends_on.contains(&Hcl::reference(policy.clone())) {
                    depends_on.push(Hcl::reference(policy));
                }
                let mut block = Block::new("queue", &[]);
                if let Some(id) = &configuration.id {
                    block = block.attribute("id", id.as_str());
                }
                block = block
                    .attribute("queue_arn", Hcl::reference(format!("aws_sqs_queue.{queue_name}.arn")))
                    .attribute("events", Hcl::list(configuration.events.iter().map(|event| Hcl::from(event.as_str()))));
                notification = notification.block(key_filter(block, configuration));
            }
            if !depends_on.is_empty() {
                blocks.push(notification.attribute("depends_on", Hcl::List(depends_on)));
            }
        }
        blocks
    }

    /// The variables: the region, the schedules' state and the buckets' events when there are
    /// any, the buckets' names, then the functions' values.
    fn variables(&self) -> Vec<Block> {
        let account = self.account;
        let mut blocks =
            vec![variable("region", "string", None, false, "The AWS region to move to, such as eu-west-3")];
        if account.functions.iter().any(|record| record.schedules.iter().any(|schedule| schedule.enabled)) {
            blocks.push(
                variable(
                    "schedule_state",
                    "string",
                    Some(Hcl::from("DISABLED")),
                    false,
                    "ENABLED once FF's schedules are off, so that no schedule runs on both: MIGRATION.md says when",
                )
                .block(
                    Block::new("validation", &[])
                        .attribute(
                            "condition",
                            Hcl::reference("contains([\"ENABLED\", \"DISABLED\"], var.schedule_state)"),
                        )
                        .attribute("error_message", "ENABLED or DISABLED."),
                ),
            );
        }
        if self.has_bucket_events() {
            blocks.push(variable(
                "bucket_events",
                "bool",
                Some(Hcl::Bool(false)),
                false,
                "true once the buckets' files are copied, so that the copy calls nothing: MIGRATION.md says when",
            ));
        }
        for bucket in &account.buckets {
            let Some(name) = self.bucket_variables.get(bucket.name.as_str()) else { continue };
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
            blocks.push(variable(name, "string", Some(Hcl::from(bucket.name.as_str())), false, &description));
        }
        blocks.extend(self.variables.iter().cloned());
        blocks
    }

    /// Each URL's address.
    fn outputs(&mut self) -> Vec<Block> {
        let mut blocks = Vec::new();
        for record in self.account.functions.iter().filter(|record| record.url.is_some()) {
            let names = &self.functions[record.function.name.as_str()];
            let url = names.name.clone();
            let output = self.names.give("output", &format!("{url} url"));
            blocks.push(
                Block::new("output", &[&output])
                    .attribute("description", format!("{}'s URL", record.function.name))
                    .attribute("value", Hcl::reference(format!("aws_lambda_function_url.{url}.function_url"))),
            );
        }
        blocks
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::*;

    const HEADER: &str = "# ff export wrote this on 2026-10-31 from FF's account 123456789012.\n";

    #[test]
    fn the_terraform_declares_what_the_template_does_each_role_action_by_action() {
        let terraform = terraform(&shop(), false, HEADER);

        // `tofu fmt -check` and `tofu validate` take them as they are (OpenTofu 1.13.1, AWS's provider 6.71.0).
        let expected = [
            ("terraform/main.tf", include_str!("testdata/shop-terraform/main.tf")),
            ("terraform/variables.tf", include_str!("testdata/shop-terraform/variables.tf")),
            ("terraform/functions.tf", include_str!("testdata/shop-terraform/functions.tf")),
            ("terraform/queues.tf", include_str!("testdata/shop-terraform/queues.tf")),
            ("terraform/buckets.tf", include_str!("testdata/shop-terraform/buckets.tf")),
            ("terraform/outputs.tf", include_str!("testdata/shop-terraform/outputs.tf")),
        ];
        assert_eq!(terraform.files.len(), expected.len());
        for ((path, text), (expected_path, expected_text)) in terraform.files.iter().zip(expected) {
            assert_eq!(path, expected_path);
            assert_eq!(text, expected_text, "{path}");
        }
        let ids: Vec<&str> = terraform.to_fill.iter().map(|parameter| parameter.id.as_str()).collect();
        assert_eq!(ids, ["send_receipts_log_level", "send_receipts_database_url"]);
    }

    #[test]
    fn values_go_in_when_asked_and_an_account_without_queues_buckets_or_urls_has_fewer_files() {
        let mut account = shop();
        let with_values = terraform(&account, true, "");
        let functions =
            &with_values.files.iter().find(|(path, _)| path == "terraform/functions.tf").expect("functions.tf").1;
        assert!(
            functions.contains("      LOG_LEVEL    = \"info\"\n      DATABASE_URL = var.send_receipts_database_url\n"),
            "{functions}"
        );
        assert_eq!(with_values.to_fill.len(), 1);

        account.queues.clear();
        account.buckets.clear();
        for record in &mut account.functions {
            record.url = None;
        }
        let paths: Vec<String> = terraform(&account, false, "").files.into_iter().map(|(path, _)| path).collect();
        assert_eq!(paths, ["terraform/main.tf", "terraform/variables.tf", "terraform/functions.tf"]);
        account.functions.clear();
        let paths: Vec<String> = terraform(&account, false, "").files.into_iter().map(|(path, _)| path).collect();
        assert_eq!(paths, ["terraform/main.tf", "terraform/variables.tf"]);
    }
}
