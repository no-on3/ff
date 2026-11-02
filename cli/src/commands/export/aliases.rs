//! A function's aliases in the export, as Lambda's. The files publish one alias, the one that names `$LATEST`, as
//! SAM's `AutoPublishAlias` and Terraform's `aws_lambda_alias`, which each deploy points at a new version of the
//! code; the function's URL, events and warm instances go through it, as SAM attaches them to it. What the files
//! can't hold, the runbook says, with the AWS CLI's commands that make it there: an alias naming a version, whose
//! code the export hasn't, another alias's URL, and what calls a version or an alias the files don't publish.

use super::account::{Account, AliasUrl, FunctionRecord};
use super::kit::listed;
use crate::api::types::{LATEST, name_in_arn, percent, qualified_name_in_arn, split_qualified};

/// The alias of a function's warm instances, which Lambda keeps on an alias, when none of its aliases names
/// `$LATEST`: the first name none of its aliases has.
const WARM_ALIASES: [&str; 2] = ["live", "warm"];

/// The alias the files publish: the function's alias naming `$LATEST`, the first by name; else, for a function
/// with warm instances, `live`, or `warm` when an alias of the function has that name already.
pub fn published(record: &FunctionRecord) -> Option<&str> {
    let latest =
        record.aliases.iter().filter(|alias| alias.function_version == LATEST).map(|alias| alias.name.as_str()).min();
    latest.or_else(|| {
        (record.function.min_instances > 0).then(|| {
            WARM_ALIASES
                .into_iter()
                .find(|name| !record.aliases.iter().any(|alias| alias.name == *name))
                .unwrap_or(WARM_ALIASES[0])
        })
    })
}

/// Whether an alias's own URL is the files' on AWS: the published alias's, while `$LATEST` has one, as SAM puts
/// the function's URL on the alias it publishes.
pub fn is_the_files_url(record: &FunctionRecord, alias_url: &AliasUrl) -> bool {
    record.url.is_some() && Some(alias_url.alias.as_str()) == published(record)
}

/// The version or the alias a qualified ARN names, `$LATEST` as none.
fn qualifier_in_arn(arn: &str) -> Option<&str> {
    split_qualified(qualified_name_in_arn(arn)).1
}

/// A version or an alias a caller names that the files don't publish: what the runbook says it calls on FF.
fn left_out<'a>(qualifier: Option<&'a str>, published: Option<&str>) -> Option<&'a str> {
    qualifier.filter(|qualifier| *qualifier != LATEST && Some(*qualifier) != published)
}

/// A version or an alias, in words: `version 3`, ``the alias `beta` ``.
fn qualifier_text(qualifier: &str) -> String {
    if qualifier.bytes().all(|byte| byte.is_ascii_digit()) {
        format!("version {qualifier}")
    } else {
        format!("the alias `{qualifier}`")
    }
}

/// The notes on the function's aliases and on what names one of them or a version, for the runbook.
pub fn notes(account: &Account, record: &FunctionRecord, lambda_name: &str) -> Vec<String> {
    let function = record.function.name.as_str();
    let published = published(record);
    let mut notes = Vec::new();
    for alias in record.aliases.iter().filter(|alias| alias.function_version == LATEST) {
        if Some(alias.name.as_str()) == published {
            notes.push(format!(
                "**{function}**'s alias `{}` names `$LATEST` on FF: on AWS, it is the template's `AutoPublishAlias` and Terraform's `aws_lambda_alias`, which each deploy points at a new version of the code, and the function's URL, events and settings for calls that don't wait go through it.",
                alias.name
            ));
        } else {
            notes.push(format!(
                "**{function}**'s alias `{}` names `$LATEST` on FF too, where the files publish `{}`: on AWS, `aws lambda create-alias --function-name {lambda_name} --name {} --function-version '$LATEST'` makes it.",
                alias.name,
                published.unwrap_or_default(),
                alias.name
            ));
        }
    }
    for alias in record.aliases.iter().filter(|alias| alias.function_version != LATEST) {
        let (share, routing) = match alias.share() {
            Some((version, weight)) => (
                format!(", {} of its calls to version {version}", percent(weight)),
                format!(" --routing-config 'AdditionalVersionWeights={{\"<the other's number>\"={weight}}}'"),
            ),
            None => (String::new(), String::new()),
        };
        notes.push(format!(
            "**{function}**'s alias `{}` names version {}{share} on FF, whose code the export hasn't: it has `$LATEST`'s alone. On AWS, deploy each version's code and publish it (`aws lambda publish-version --function-name {lambda_name}`), then `aws lambda create-alias --function-name {lambda_name} --name {} --function-version <its number on AWS>{routing}`.",
            alias.name, alias.function_version, alias.name
        ));
    }
    for alias_url in record.alias_urls.iter().filter(|alias_url| !is_the_files_url(record, alias_url)) {
        let (alias, url) = (&alias_url.alias, &alias_url.url);
        let domains = match alias_url.domains.as_slice() {
            [] => String::new(),
            [domain] => format!("; `{domain}` reaches it through a CloudFront distribution, as `data/lambda.md` says"),
            domains => {
                format!("; {} reach it through a CloudFront distribution, as `data/lambda.md` says", listed(domains))
            }
        };
        notes.push(format!(
            "**{function}**'s alias `{alias}` has a URL of its own on FF, `{}`: on AWS, `aws lambda create-function-url-config --function-name {lambda_name} --qualifier {alias} --auth-type {}` gives it one, at an address of AWS's, once the alias is there{domains}.",
            url.function_url, url.auth_type
        ));
    }
    let called = match published {
        Some(alias) => format!("the alias `{alias}`"),
        None => "the function as it is".to_owned(),
    };
    for schedule in &record.schedules {
        if let Some(qualifier) = left_out(schedule.qualifier.as_deref(), published) {
            notes.push(format!(
                "**{function}**'s schedule `{}` runs {} on FF: the files have it call {called}; on AWS, point its target at `{lambda_name}:{qualifier}` once that is there.",
                schedule.name,
                qualifier_text(qualifier)
            ));
        }
    }
    for mapping in &record.event_sources {
        if let Some(qualifier) = left_out(qualifier_in_arn(&mapping.function_arn), published) {
            notes.push(format!(
                "**{function}** reads the queue `{}` through {} on FF: the files have {called} read it; on AWS, `aws lambda update-event-source-mapping --uuid <its UUID> --function-name {lambda_name}:{qualifier}` once that is there.",
                name_in_arn(&mapping.event_source_arn),
                qualifier_text(qualifier)
            ));
        }
    }
    for bucket in &account.buckets {
        for notification in &bucket.notifications.lambda_function_configurations {
            let Some(arn) = notification.lambda_function_arn.as_deref() else { continue };
            if name_in_arn(arn) != function {
                continue;
            }
            if let Some(qualifier) = left_out(qualifier_in_arn(arn), published) {
                notes.push(format!(
                    "The bucket `{}`'s notification `{}` calls **{function}** through {} on FF: the files have it call {called}; on AWS, point it at `{lambda_name}:{qualifier}` once that is there.",
                    bucket.name,
                    notification.id.as_deref().unwrap_or("events"),
                    qualifier_text(qualifier)
                ));
            }
        }
    }
    let destinations = record.async_config.iter().flat_map(|config| {
        [("succeeds", &config.destination_config.on_success), ("fails for good", &config.destination_config.on_failure)]
    });
    for (when, destination) in destinations {
        let Some(arn) = destination.destination.as_deref().filter(|arn| arn.starts_with("arn:aws:lambda:")) else {
            continue;
        };
        if let Some(qualifier) = qualifier_in_arn(arn) {
            let target = name_in_arn(arn);
            notes.push(format!(
                "**{function}** sends the record of each call that doesn't wait and {when} to `{target}:{qualifier}` on FF: the files send it to `{target}` as it is; on AWS, give its destination that qualifier (`aws lambda update-function-event-invoke-config`) once that is there."
            ));
        }
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::*;

    #[test]
    fn the_alias_naming_latest_is_published_else_a_warm_functions_own() {
        let account = shop();
        let published: Vec<(&str, Option<&str>)> =
            account.functions.iter().map(|record| (record.function.name.as_str(), published(record))).collect();
        assert_eq!(published, [("make-thumbnail", Some("live")), ("report.v1", None), ("send-receipts", Some("live"))]);

        // A warm function whose alias `live` names a version keeps its warm instances on another.
        let mut warm = shop().functions.remove(0);
        warm.aliases[0].name = "live".to_owned();
        assert_eq!(super::published(&warm), Some("warm"));
    }

    #[test]
    fn the_published_aliases_own_url_is_the_files_while_latest_has_one() {
        let account = shop();
        let own_url = |record: &FunctionRecord| {
            notes(&account, record, "send-receipts").iter().any(|note| note.contains("`live` has a URL of its own"))
        };
        let mut record = shop().functions.remove(2);
        record.alias_urls[0].alias = "live".to_owned();
        assert!(is_the_files_url(&record, &record.alias_urls[0]));
        assert!(!own_url(&record));

        // Without `$LATEST`'s, the files have no URL, and the alias's is made on AWS as any other's.
        record.url = None;
        assert!(!is_the_files_url(&record, &record.alias_urls[0]));
        assert!(own_url(&record));
    }

    #[test]
    fn what_names_a_version_or_another_alias_is_said_with_the_commands_that_make_it_on_aws() {
        let account = shop();
        let notes: Vec<String> = account
            .functions
            .iter()
            .flat_map(|record| notes(&account, record, &record.function.name.replace('.', "_")))
            .collect();
        let starts: Vec<&str> =
            notes.iter().map(|note| note.split_once(" on FF").map_or(note.as_str(), |(start, _)| start)).collect();
        assert_eq!(
            starts,
            [
                "**make-thumbnail**'s alias `beta` names version 2, 10% of its calls to version 3",
                "The bucket `photos`'s notification `thumbnails` calls **make-thumbnail** through the alias `beta`",
                "**send-receipts**'s alias `live` names `$LATEST`",
                "**send-receipts**'s alias `next` names `$LATEST`",
                "**send-receipts**'s alias `stable` names version 4",
                "**send-receipts**'s alias `stable` has a URL of its own",
                "**send-receipts**'s schedule `weekly` runs the alias `stable`",
                "**send-receipts** reads the queue `orders` through version 4",
                "**send-receipts** sends the record of each call that doesn't wait and succeeds to `audit:live`",
            ]
        );
        assert!(notes[0].ends_with(
            "`aws lambda create-alias --function-name make-thumbnail --name beta --function-version <its number on AWS> --routing-config 'AdditionalVersionWeights={\"<the other's number>\"=0.1}'`."
        ));
        assert!(notes[1].ends_with(
            "the files have it call the alias `live`; on AWS, point it at `make-thumbnail:beta` once that is there."
        ));
        assert!(notes[3].ends_with(
            "where the files publish `live`: on AWS, `aws lambda create-alias --function-name send-receipts --name next --function-version '$LATEST'` makes it."
        ));
        assert!(notes[5].ends_with(
            "`aws lambda create-function-url-config --function-name send-receipts --qualifier stable --auth-type NONE` gives it one, at an address of AWS's, once the alias is there; `stable.shop.tn` reaches it through a CloudFront distribution, as `data/lambda.md` says."
        ));
    }
}
