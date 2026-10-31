//! Each function's role in the export: what its keys used of the account's buckets, queues and mail
//! on FF (`GET /functions/:id/key-uses`), as IAM's actions. One of SAM's policy templates allows them
//! where the function did what the template is for, on its one bucket or queue; statements of the
//! role's own allow the rest, so that the role allows what the function did, and little more.

use std::collections::BTreeMap;

use serde::Deserialize;

/// What a function's keys used, as `GET /functions/:id/key-uses` answers.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct KeyUses {
    pub uses: Vec<KeyUse>,
}

/// One thing the keys used by one of the service's operations, and the first and the last day FF
/// saw it, UTC.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUse {
    /// `s3`, `sqs` or `sesv2`, as AWS's configuration names the service's endpoint.
    pub service: String,
    /// A bucket's or a queue's name, an e-mail identity or a sender's address; '' for the account's
    /// own, such as its list of buckets.
    pub resource: String,
    /// The operation, as the service names it: `GetObject`, `SendMessageBatch`, `SendEmail`.
    pub operation: String,
    pub first_day: String,
    pub last_day: String,
}

/// One of SAM's policy templates, with the bucket or the queue it takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Template {
    Bucket(&'static str, String),
    Queue(&'static str, String),
}

/// What a statement of the role's own allows its actions on.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    /// The bucket itself, `arn:aws:s3:::<bucket>`.
    Bucket(String),
    /// The bucket's objects, `arn:aws:s3:::<bucket>/*`.
    Objects(String),
    Queue(String),
    /// A function another's calls' records go to: Terraform's roles allow it, SAM adding it itself.
    Function(String),
    /// The domain or the address SES sends as.
    Identity(String),
    /// What is the account's own rather than a resource's, such as its list of buckets: `*`.
    Account,
}

/// A function's role: SAM's templates, statements for the rest, and the operations the export
/// knows no IAM action of, for its notes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Role {
    pub templates: Vec<Template>,
    pub statements: Vec<(Target, Vec<String>)>,
    pub unknown: Vec<String>,
}

impl Role {
    /// The buckets the role allows, each once, by name.
    pub fn buckets(&self) -> Vec<&str> {
        let templates = self.templates.iter().filter_map(|template| match template {
            Template::Bucket(_, bucket) => Some(bucket.as_str()),
            Template::Queue(..) => None,
        });
        let statements = self.statements.iter().filter_map(|(target, _)| match target {
            Target::Bucket(bucket) | Target::Objects(bucket) => Some(bucket.as_str()),
            _ => None,
        });
        once_each(templates.chain(statements))
    }

    /// The queues the role allows, each once, by name.
    pub fn queues(&self) -> Vec<&str> {
        let templates = self.templates.iter().filter_map(|template| match template {
            Template::Queue(_, queue) => Some(queue.as_str()),
            Template::Bucket(..) => None,
        });
        let statements = self.statements.iter().filter_map(|(target, _)| match target {
            Target::Queue(queue) => Some(queue.as_str()),
            _ => None,
        });
        once_each(templates.chain(statements))
    }
}

fn once_each<'a>(names: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut names: Vec<&str> = names.collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// Where an S3 action applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    Bucket,
    Objects,
    Account,
}

/// The IAM action that allows an S3 operation FF's front door takes, and where it applies, as S3's
/// documentation of each operation says: a copy's source is noted apart, as a `GetObject` of it.
fn s3_action(operation: &str) -> Option<(&'static str, Scope)> {
    Some(match operation {
        "GetObject" | "HeadObject" => ("s3:GetObject", Scope::Objects),
        "PutObject"
        | "CopyObject"
        | "CreateMultipartUpload"
        | "UploadPart"
        | "UploadPartCopy"
        | "CompleteMultipartUpload" => ("s3:PutObject", Scope::Objects),
        "DeleteObject" | "DeleteObjects" => ("s3:DeleteObject", Scope::Objects),
        "AbortMultipartUpload" => ("s3:AbortMultipartUpload", Scope::Objects),
        "ListParts" => ("s3:ListMultipartUploadParts", Scope::Objects),
        "ListObjects" | "ListObjectsV2" | "HeadBucket" => ("s3:ListBucket", Scope::Bucket),
        "GetBucketLocation" => ("s3:GetBucketLocation", Scope::Bucket),
        "ListMultipartUploads" => ("s3:ListBucketMultipartUploads", Scope::Bucket),
        "GetBucketNotificationConfiguration" => ("s3:GetBucketNotification", Scope::Bucket),
        "PutBucketNotificationConfiguration" => ("s3:PutBucketNotification", Scope::Bucket),
        "GetBucketWebsite" => ("s3:GetBucketWebsite", Scope::Bucket),
        "PutBucketWebsite" => ("s3:PutBucketWebsite", Scope::Bucket),
        "DeleteBucketWebsite" => ("s3:DeleteBucketWebsite", Scope::Bucket),
        "ListBuckets" => ("s3:ListAllMyBuckets", Scope::Account),
        _ => return None,
    })
}

/// The IAM action of an SQS operation: a batch is allowed by its single operation's.
fn sqs_action(operation: &str) -> String {
    format!("sqs:{}", operation.strip_suffix("Batch").unwrap_or(operation))
}

/// One of SAM's policy templates: the actions the function must have used for it, and those of the
/// front doors' it allows. It allows more than these, such as an object's versions, which FF has not.
struct PolicyTemplate {
    name: &'static str,
    needs: &'static [&'static str],
    allows: &'static [&'static str],
}

/// The bucket's templates, in the order they are weighed: all of it, else reading, writing.
const S3_TEMPLATES: [PolicyTemplate; 3] = [
    PolicyTemplate {
        name: "S3CrudPolicy",
        needs: &["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        allows: &["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:PutObject", "s3:DeleteObject"],
    },
    PolicyTemplate {
        name: "S3ReadPolicy",
        needs: &["s3:GetObject"],
        allows: &["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
    },
    PolicyTemplate { name: "S3WritePolicy", needs: &["s3:PutObject"], allows: &["s3:PutObject"] },
];

/// The queue's: a sender's, a reader's.
const SQS_TEMPLATES: [PolicyTemplate; 2] = [
    PolicyTemplate { name: "SQSSendMessagePolicy", needs: &["sqs:SendMessage"], allows: &["sqs:SendMessage"] },
    PolicyTemplate {
        name: "SQSPollerPolicy",
        needs: &["sqs:ReceiveMessage"],
        allows: &["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
    },
];

/// The templates for what was used, each whose needs were all used and none allowed by one before
/// it, and what they allow together.
fn templates_for(used: &[&str], templates: &[PolicyTemplate]) -> (Vec<&'static str>, Vec<&'static str>) {
    let mut chosen = Vec::new();
    let mut allowed: Vec<&'static str> = Vec::new();
    for template in templates {
        if template.needs.iter().all(|action| used.contains(action) && !allowed.contains(action)) {
            chosen.push(template.name);
            allowed.extend(template.allows);
        }
    }
    (chosen, allowed)
}

/// The identity SES sends an address's mail as, as FF does: the address when the account proved it,
/// else its domain when proved; the address otherwise, which neither sends as.
fn sender_identity<'a>(address: &'a str, proved: &[&str]) -> &'a str {
    match address.rsplit_once('@') {
        Some((_, domain)) if !proved.contains(&address) && proved.contains(&domain) => domain,
        _ => address,
    }
}

/// Each resource of a service, with the operations used on it, by name.
fn by_resource<'a>(uses: &'a [KeyUse], service: &str) -> BTreeMap<&'a str, Vec<&'a str>> {
    let mut by: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for used in uses.iter().filter(|used| used.service == service) {
        by.entry(used.resource.as_str()).or_default().push(used.operation.as_str());
    }
    by
}

/// The role of a function whose keys used these, for SAM, its mail sent as the account's proved
/// identities: the templates by bucket, then by queue; a statement for each bucket's, its objects',
/// each queue's and each identity's other actions, then the account's own.
pub fn role(uses: &[KeyUse], proved: &[&str]) -> Role {
    role_with(uses, proved, &S3_TEMPLATES, &SQS_TEMPLATES)
}

/// The same role in statements alone, each action used on its resource, for Terraform, which has
/// no policy templates.
pub fn statements(uses: &[KeyUse], proved: &[&str]) -> Role {
    role_with(uses, proved, &[], &[])
}

fn role_with(uses: &[KeyUse], proved: &[&str], s3: &[PolicyTemplate], sqs: &[PolicyTemplate]) -> Role {
    let mut role = Role::default();
    let mut statements: BTreeMap<Target, Vec<String>> = BTreeMap::new();
    let mut allow = |target: Target, action: &str| {
        let actions = statements.entry(target).or_default();
        if !actions.iter().any(|had| had == action) {
            actions.push(action.to_owned());
        }
    };
    for (bucket, operations) in by_resource(uses, "s3") {
        let mut actions: Vec<(&str, Scope)> = Vec::new();
        for operation in operations {
            match s3_action(operation) {
                Some(action) if !actions.contains(&action) => actions.push(action),
                Some(_) => {}
                None => role.unknown.push(format!("S3's {operation}")),
            }
        }
        let used: Vec<&str> = actions.iter().map(|(action, _)| *action).collect();
        let (templates, allowed) = if bucket.is_empty() { (Vec::new(), Vec::new()) } else { templates_for(&used, s3) };
        role.templates.extend(templates.into_iter().map(|name| Template::Bucket(name, bucket.to_owned())));
        for (action, scope) in actions.into_iter().filter(|(action, _)| !allowed.contains(action)) {
            let target = match scope {
                Scope::Account => Target::Account,
                _ if bucket.is_empty() => Target::Account,
                Scope::Bucket => Target::Bucket(bucket.to_owned()),
                Scope::Objects => Target::Objects(bucket.to_owned()),
            };
            allow(target, action);
        }
    }
    for (queue, operations) in by_resource(uses, "sqs") {
        let mut used: Vec<String> = operations.iter().map(|operation| sqs_action(operation)).collect();
        used.sort_unstable();
        used.dedup();
        let names: Vec<&str> = used.iter().map(String::as_str).collect();
        let (templates, allowed) = if queue.is_empty() { (Vec::new(), Vec::new()) } else { templates_for(&names, sqs) };
        role.templates.extend(templates.into_iter().map(|name| Template::Queue(name, queue.to_owned())));
        for action in names.into_iter().filter(|action| !allowed.contains(action)) {
            let target = if queue.is_empty() { Target::Account } else { Target::Queue(queue.to_owned()) };
            allow(target, action);
        }
    }
    for (resource, operations) in by_resource(uses, "sesv2") {
        for operation in operations {
            // A message is sent as its sender's identity; an identity's own operations name it.
            let target = match resource {
                "" => Target::Account,
                address if operation == "SendEmail" => Target::Identity(sender_identity(address, proved).to_owned()),
                identity => Target::Identity(identity.to_owned()),
            };
            allow(target, &format!("ses:{operation}"));
        }
    }
    for used in uses.iter().filter(|used| !matches!(used.service.as_str(), "s3" | "sqs" | "sesv2")) {
        role.unknown.push(format!("{}'s {}", used.service, used.operation));
    }
    role.statements = statements
        .into_iter()
        .map(|(target, mut actions)| {
            actions.sort_unstable();
            (target, actions)
        })
        .collect();
    role
}

/// The first and the last day FF saw any of these used, UTC: none for none.
pub fn seen_between<'a>(uses: impl Iterator<Item = &'a KeyUse>) -> Option<(&'a str, &'a str)> {
    uses.fold(None, |seen, used| {
        let (first, last) = seen.unwrap_or((used.first_day.as_str(), used.last_day.as_str()));
        Some((first.min(used.first_day.as_str()), last.max(used.last_day.as_str())))
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::uses;
    use super::*;

    fn statement(target: Target, actions: &[&str]) -> (Target, Vec<String>) {
        (target, actions.iter().map(|action| (*action).to_owned()).collect())
    }

    #[test]
    fn a_bucket_gets_the_templates_of_what_was_done_to_it_and_statements_for_the_rest() {
        let read_and_listed = role(&uses(&[("s3", "photos", "HeadObject"), ("s3", "photos", "ListObjectsV2")]), &[]);
        // A read allows the listing too.
        assert_eq!(read_and_listed.templates, [Template::Bucket("S3ReadPolicy", "photos".to_owned())]);
        assert!(read_and_listed.statements.is_empty());

        let all_of_it = role(
            &uses(&[
                ("s3", "photos", "CopyObject"),
                ("s3", "photos", "DeleteObjects"),
                ("s3", "photos", "GetObject"),
                ("s3", "photos", "GetBucketNotificationConfiguration"),
                ("s3", "photos", "AbortMultipartUpload"),
                ("s3", "thumbs", "DeleteObject"),
                ("s3", "thumbs", "PutObject"),
            ]),
            &[],
        );
        assert_eq!(
            all_of_it.templates,
            [
                Template::Bucket("S3CrudPolicy", "photos".to_owned()),
                Template::Bucket("S3WritePolicy", "thumbs".to_owned())
            ]
        );
        // thumbs's delete, without a read, is a statement of its own.
        assert_eq!(
            all_of_it.statements,
            [
                statement(Target::Bucket("photos".to_owned()), &["s3:GetBucketNotification"]),
                statement(Target::Objects("photos".to_owned()), &["s3:AbortMultipartUpload"]),
                statement(Target::Objects("thumbs".to_owned()), &["s3:DeleteObject"]),
            ]
        );
        assert_eq!(all_of_it.buckets(), ["photos", "thumbs"]);
    }

    #[test]
    fn a_queue_tells_its_sender_from_its_reader_and_a_batch_is_its_single_operation() {
        let role = role(
            &uses(&[
                ("sqs", "orders", "SendMessageBatch"),
                ("sqs", "orders", "GetQueueUrl"),
                ("sqs", "jobs", "ReceiveMessage"),
                ("sqs", "jobs", "DeleteMessageBatch"),
                ("sqs", "stats", "GetQueueAttributes"),
                ("sqs", "", "ListQueues"),
            ]),
            &[],
        );

        assert_eq!(
            role.templates,
            [
                Template::Queue("SQSPollerPolicy", "jobs".to_owned()),
                Template::Queue("SQSSendMessagePolicy", "orders".to_owned())
            ]
        );
        // Reading a queue's attributes alone doesn't make its reader.
        assert_eq!(
            role.statements,
            [
                statement(Target::Queue("orders".to_owned()), &["sqs:GetQueueUrl"]),
                statement(Target::Queue("stats".to_owned()), &["sqs:GetQueueAttributes"]),
                statement(Target::Account, &["sqs:ListQueues"]),
            ]
        );
        assert_eq!(role.queues(), ["jobs", "orders", "stats"]);
    }

    #[test]
    fn mail_is_sent_as_the_address_or_its_domain_as_proved_and_the_accounts_own_actions_are_on_everything() {
        let proved = ["shop.tn", "ana@blog.tn"];
        let role = role(
            &uses(&[
                ("sesv2", "", "GetAccount"),
                ("sesv2", "ana@blog.tn", "SendEmail"),
                ("sesv2", "news@blog.tn", "SendEmail"),
                ("sesv2", "receipts@shop.tn", "SendEmail"),
                ("sesv2", "shop.tn", "GetEmailIdentity"),
                ("s3", "", "ListBuckets"),
            ]),
            &proved,
        );

        assert!(role.templates.is_empty());
        assert_eq!(
            role.statements,
            [
                statement(Target::Identity("ana@blog.tn".to_owned()), &["ses:SendEmail"]),
                // blog.tn isn't proved: FF refused it, and the address is what AWS would check.
                statement(Target::Identity("news@blog.tn".to_owned()), &["ses:SendEmail"]),
                statement(Target::Identity("shop.tn".to_owned()), &["ses:GetEmailIdentity", "ses:SendEmail"]),
                statement(Target::Account, &["s3:ListAllMyBuckets", "ses:GetAccount"]),
            ]
        );
    }

    #[test]
    fn without_templates_each_action_used_is_a_statement_on_its_resource() {
        let role = statements(
            &uses(&[
                ("s3", "photos", "DeleteObject"),
                ("s3", "photos", "GetObject"),
                ("s3", "photos", "ListObjectsV2"),
                ("s3", "photos", "PutObject"),
                ("sqs", "orders", "SendMessageBatch"),
            ]),
            &[],
        );

        assert!(role.templates.is_empty());
        assert_eq!(
            role.statements,
            [
                statement(Target::Bucket("photos".to_owned()), &["s3:ListBucket"]),
                statement(Target::Objects("photos".to_owned()), &["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]),
                statement(Target::Queue("orders".to_owned()), &["sqs:SendMessage"]),
            ]
        );
    }

    #[test]
    fn an_operation_the_export_knows_no_action_of_is_left_to_the_notes() {
        let role = role(&uses(&[("s3", "photos", "RestoreObject"), ("dynamodb", "orders", "GetItem")]), &[]);

        assert_eq!(
            role,
            Role { unknown: vec!["S3's RestoreObject".to_owned(), "dynamodb's GetItem".to_owned()], ..Role::default() }
        );
    }

    #[test]
    fn the_days_seen_are_the_first_and_the_last_of_all() {
        let mut used = uses(&[("s3", "photos", "GetObject"), ("sqs", "orders", "SendMessage")]);
        used[0].first_day = "2026-10-25".to_owned();
        used[1].first_day = "2026-10-22".to_owned();
        used[1].last_day = "2026-10-29".to_owned();

        assert_eq!(seen_between(used.iter()), Some(("2026-10-22", "2026-10-31")));
        assert_eq!(seen_between([].iter()), None);
    }
}
