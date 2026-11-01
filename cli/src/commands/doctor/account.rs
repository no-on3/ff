//! `ff doctor --deployed`: what in the account still points at FF, read as `ff export` reads it: what a move to AWS
//! changes that the code doesn't show, and what stays on FF until it is moved or removed. Warnings each, for a person
//! to act on; `--strict` fails while any is left, as when nothing should point at FF any more.

use std::collections::BTreeMap;

use serde::Serialize;

use super::Level;
use crate::api::Client;
use crate::commands::Context;
use crate::commands::buckets::{self, StorageKey};
use crate::commands::export::account::{self, Account, FunctionRecord};
use crate::commands::export::names::{lambda_names, renamed};
use crate::commands::export::template::WRAPPED_EVENT;
use crate::error::{Error, Kind};
use crate::progress::Progress;
use crate::table::time;

/// The services a function's key reaches through FF's endpoints, as its key uses name them, with AWS's names.
const SERVICES: [(&str, &str); 3] = [("s3", "S3"), ("sqs", "SQS"), ("sesv2", "SES")];

#[derive(Debug, Serialize)]
pub struct AccountFinding {
    /// What it is about: `function orders-api`, `bucket www`, `storage key 3f9a2b1c`.
    pub resource: String,
    pub level: Level,
    pub check: &'static str,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountReport {
    account: String,
    findings: Vec<AccountFinding>,
    warnings: usize,
    /// What this token couldn't read, in words.
    not_checked: Vec<String>,
}

fn warning(resource: String, check: &'static str, message: String) -> AccountFinding {
    AccountFinding { resource, level: Level::Warning, check, message }
}

/// "S3 (photos, www) and SQS (orders)": what a function's key reached, by service, with the resources it named.
fn reached(record: &FunctionRecord) -> Option<(String, &str)> {
    let mut by_service: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for used in &record.uses {
        let Some(at) = SERVICES.iter().position(|(service, _)| *service == used.service) else { continue };
        let resources = by_service.entry(at).or_default();
        if !used.resource.is_empty() && !resources.contains(&used.resource.as_str()) {
            resources.push(&used.resource);
        }
    }
    let last = record.uses.iter().map(|used| used.last_day.as_str()).max()?;
    let services: Vec<String> = by_service
        .into_iter()
        .map(|(at, mut resources)| {
            resources.sort();
            if resources.is_empty() {
                SERVICES[at].1.to_owned()
            } else {
                format!("{} ({})", SERVICES[at].1, resources.join(", "))
            }
        })
        .collect();
    let services = match services.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => return None,
    };
    Some((services, last))
}

fn function_findings(record: &FunctionRecord, lambda_name: &str) -> Vec<AccountFinding> {
    let function = &record.function;
    let resource = || format!("function {}", function.name);
    let mut found = Vec::new();
    if lambda_name != function.name {
        found.push(warning(resource(), "lambda-name", renamed(lambda_name)));
    }
    if function.event_format.as_deref() == Some("wrapped") {
        found.push(warning(resource(), "wrapped-event", WRAPPED_EVENT.to_owned()));
    }
    if function.min_instances > 0 {
        let instances = function.min_instances;
        found.push(warning(
            resource(),
            "warm-instances",
            format!(
                "keeps {instances} instance{} running when idle: AWS bills that as provisioned concurrency, by the \
                 hour, called or not, which the export writes as `ProvisionedConcurrencyConfig`",
                if instances == 1 { "" } else { "s" }
            ),
        ));
    }
    if record.url.as_ref().is_some_and(|url| url.auth_type == "AWS_IAM") {
        found.push(warning(
            resource(),
            "url-keys",
            "its URL takes FF's API keys: on AWS, `AWS_IAM` asks each caller for a request signed with AWS's keys \
             (SigV4) instead"
                .to_owned(),
        ));
    }
    for domain in &record.domains {
        found.push(warning(
            resource(),
            "custom-domain",
            format!(
                "{domain} points at its URL on FF: on AWS, CloudFront in front of the function URL with the domain's \
                 certificate, then its DNS record changed, as `data/lambda.md` says"
            ),
        ));
    }
    if let Some((services, last)) = reached(record) {
        found.push(warning(
            resource(),
            "ff-endpoints",
            format!(
                "reached FF's {services} through the endpoints FF sets in its environment, last on {last}: on AWS, \
                 AWS's own, its role allowing what it used"
            ),
        ));
    }
    found
}

fn key_finding(key: &StorageKey) -> AccountFinding {
    let resource = format!("storage key {}", key.id);
    let reach = buckets::reaches(key);
    let message = match &key.last_used_at {
        Some(used) => format!(
            "reaches {reach}, used last at {} UTC: on AWS, an IAM user's or role's keys, with AWS's endpoints, for \
             what uses it",
            time(used)
        ),
        None => format!("reaches {reach}, never used: `ff buckets keys revoke {}` once nothing will", key.id),
    };
    warning(resource, "storage-key", message)
}

/// What in the account points at FF: its functions', its sites' and, when the token lists them, its storage keys'.
fn findings(account: &Account, keys: Option<&[StorageKey]>) -> Vec<AccountFinding> {
    let names: Vec<&str> = account.functions.iter().map(|record| record.function.name.as_str()).collect();
    let mut found: Vec<AccountFinding> = account
        .functions
        .iter()
        .zip(lambda_names(&names))
        .flat_map(|(record, lambda_name)| function_findings(record, &lambda_name))
        .collect();
    for bucket in &account.buckets {
        for domain in &bucket.site_domains {
            found.push(warning(
                format!("bucket {}", bucket.name),
                "custom-domain",
                format!(
                    "{domain} points at its site on FF: on AWS, CloudFront in front of the bucket's site with the \
                     domain's certificate, then its DNS record changed, as `data/s3-website.md` says"
                ),
            ));
        }
    }
    found.extend(keys.into_iter().flatten().map(key_finding));
    found
}

/// `resource: warning: message [check]`, a line each, then the summary.
fn text(report: &AccountReport) -> String {
    let mut lines: Vec<String> = report
        .findings
        .iter()
        .map(|finding| format!("{}: warning: {} [{}]", finding.resource, finding.message, finding.check))
        .collect();
    lines.push(summary(report));
    lines.join("\n")
}

fn summary(report: &AccountReport) -> String {
    match report.warnings {
        0 => format!("account {}: nothing found that still points at FF", report.account),
        1 => format!("account {}: 1 warning, what still points at FF", report.account),
        n => format!("account {}: {n} warnings, what still points at FF", report.account),
    }
}

pub fn run(strict: bool, context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let me = crate::commands::account::me(&client)?;
    let current = crate::commands::account::current(&me, &settings)?;
    let progress = Progress::start(context.out, &format!("reading account {}", current.id));
    let read = account::read(&client, current, &[]);
    let keys = read.as_ref().ok().map(|_| buckets::storage_keys(&client));
    progress.stop();
    let read = read?;
    let mut not_checked = Vec::new();
    let keys = match keys.transpose() {
        Ok(keys) => keys,
        // Owners list them; a developer's token sees the rest.
        Err(error) if error.status == Some(403) => {
            not_checked.push(format!("the account's storage keys: {}", error.message));
            None
        }
        Err(error) => return Err(error),
    };
    for what in &not_checked {
        context.out.warn(&format!("not checked, {what}"));
    }
    let findings = findings(&read, keys.as_deref());
    let report = AccountReport { account: read.id.clone(), warnings: findings.len(), findings, not_checked };
    context.out.result(&report, || text(&report))?;
    if strict && report.warnings > 0 {
        return Err(Error::new(Kind::Findings, format!("{}: --strict fails on warnings", summary(&report))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::export::fixtures::shop;

    fn key(id: &str, buckets: Option<&[&str]>, last_used_at: Option<&str>) -> StorageKey {
        StorageKey {
            id: id.to_owned(),
            buckets: buckets.map(|names| names.iter().map(|name| name.to_string()).collect()),
            queues: None,
            read_only: false,
            created_at: "2026-10-01T09:00:00.000Z".to_owned(),
            last_used_at: last_used_at.map(str::to_owned),
        }
    }

    #[test]
    fn the_shops_functions_sites_and_keys_each_say_what_still_points_at_ff() {
        let keys = [key("AKFF0001", None, Some("2026-10-30T18:04:11.000Z")), key("AKFF0002", Some(&["photos"]), None)];
        let found: Vec<(String, &str)> =
            findings(&shop(), Some(&keys)).into_iter().map(|finding| (finding.resource, finding.check)).collect();
        let expected = [
            ("function make-thumbnail", "warm-instances"),
            ("function make-thumbnail", "ff-endpoints"),
            ("function report.v1", "lambda-name"),
            ("function report.v1", "wrapped-event"),
            ("function send-receipts", "url-keys"),
            ("function send-receipts", "custom-domain"),
            ("function send-receipts", "ff-endpoints"),
            ("bucket www", "custom-domain"),
            ("storage key AKFF0001", "storage-key"),
            ("storage key AKFF0002", "storage-key"),
        ];
        assert_eq!(found, expected.map(|(resource, check)| (resource.to_owned(), check)));
    }

    #[test]
    fn each_message_says_what_aws_does_instead() {
        let keys = [key("AKFF0001", None, Some("2026-10-30T18:04:11.000Z")), key("AKFF0002", Some(&["photos"]), None)];
        let messages: BTreeMap<(String, &str), String> = findings(&shop(), Some(&keys))
            .into_iter()
            .map(|finding| ((finding.resource, finding.check), finding.message))
            .collect();
        let message = |resource: &str, check: &str| messages[&(resource.to_owned(), check)].clone();
        assert_eq!(
            message("function send-receipts", "ff-endpoints"),
            "reached FF's S3 (archive, photos, www), SQS (failed-receipts, invoices, orders) and SES (receipts@shop.tn) \
             through the endpoints FF sets in its environment, last on 2026-10-31: on AWS, AWS's own, its role allowing \
             what it used"
        );
        assert_eq!(
            message("function make-thumbnail", "ff-endpoints"),
            "reached FF's S3 (photos) through the endpoints FF sets in its environment, last on 2026-10-31: on AWS, \
             AWS's own, its role allowing what it used"
        );
        assert_eq!(
            message("function report.v1", "lambda-name"),
            "is `report_v1` on Lambda, whose rule for names it is outside of: its callers name it so there"
        );
        assert!(message("function make-thumbnail", "warm-instances").starts_with("keeps 1 instance running when idle"));
        assert!(message("function send-receipts", "custom-domain").starts_with("api.shop.tn points at its URL on FF"));
        assert!(message("bucket www", "custom-domain").starts_with("shop.tn points at its site on FF"));
        assert_eq!(
            message("storage key AKFF0001", "storage-key"),
            "reaches every bucket and queue of the account, used last at 2026-10-30 18:04:11 UTC: on AWS, an IAM \
             user's or role's keys, with AWS's endpoints, for what uses it"
        );
        assert_eq!(
            message("storage key AKFF0002", "storage-key"),
            "reaches the bucket photos, never used: `ff buckets keys revoke AKFF0002` once nothing will"
        );
    }

    #[test]
    fn an_account_with_nothing_of_ffs_says_so() {
        let mut account = shop();
        account.functions.clear();
        account.buckets.clear();
        let report = AccountReport {
            account: account.id.clone(),
            findings: findings(&account, None),
            warnings: 0,
            not_checked: Vec::new(),
        };
        assert_eq!(text(&report), "account 123456789012: nothing found that still points at FF");
    }
}
