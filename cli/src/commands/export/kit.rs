//! The kit's other files: the values the template takes, the pages of `data/` for what the account
//! has, and `MIGRATION.md`, the account's own runbook.

use super::account::Account;
use super::template::{SCHEDULES_STATE, Template};
use crate::api::types::name_in_arn;

const LAMBDA: &str = include_str!("../../../templates/export/data/lambda.md");
const POSTGRES: &str = include_str!("../../../templates/export/data/postgres.md");
const ELASTICACHE: &str = include_str!("../../../templates/export/data/elasticache.md");
const SES: &str = include_str!("../../../templates/export/data/ses.md");
const SQS: &str = include_str!("../../../templates/export/data/sqs.md");
const S3_WEBSITE: &str = include_str!("../../../templates/export/data/s3-website.md");
const S3_SYNC: &str = include_str!("../../../templates/export/data/s3-sync.sh");

/// A file of the kit, by its path in the folder: `executable` for a script.
pub struct File {
    pub path: String,
    pub text: String,
    pub executable: bool,
}

impl File {
    fn new(path: &str, text: String) -> File {
        File { path: path.to_owned(), text, executable: false }
    }
}

/// Items in a sentence: `a`, `a and b`, `a, b and c`.
fn joined(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [first @ .., last] => format!("{} and {last}", first.join(", ")),
    }
}

/// Names in a sentence, each in backquotes.
fn listed(names: &[String]) -> String {
    joined(&names.iter().map(|name| format!("`{name}`")).collect::<Vec<_>>())
}

/// What the account has of a kind: the database `shop`, the databases `shop` and `blog`.
fn named(one: &str, many: &str, names: &[String]) -> String {
    format!("the {} {}", if names.len() == 1 { one } else { many }, listed(names))
}

/// The text with a capital first, to begin a sentence.
fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A page with what the account has of it said under its title.
fn page(text: &str, in_account: &str) -> String {
    let (title, rest) = text.split_once('\n').unwrap_or((text, ""));
    format!("{title}\n\n> **In this account:** {in_account}\n{rest}")
}

/// The kit's files but the code: the template, the values it takes, `data/` and `MIGRATION.md`.
pub fn files(account: &Account, template: &Template, read_on: &str) -> Vec<File> {
    let mut files = vec![File::new("template.yaml", template.text.clone())];
    if let Some(before_copy) = &template.before_copy {
        files.push(File::new("template-before-copy.yaml", before_copy.clone()));
    }
    files.push(File::new("secrets.template.env", secrets(template)));
    files.extend(data_pages(account));
    files.push(File::new("MIGRATION.md", migration(account, template, read_on)));
    files
}

/// Each parameter the template takes and the export doesn't fill, a line each, with what it is.
fn secrets(template: &Template) -> String {
    let mut text = String::from(
        "# The values template.yaml takes as parameters and ff export doesn't write. Copy this file to secrets.env,\n\
         # keep that one out of every repository, and fill it: sam deploy --guided asks for each, or give them as\n\
         # --parameter-overrides Name=value, one pair each.\n",
    );
    if template.parameters.is_empty() {
        text.push_str("#\n# None: the functions have no secrets, and their variables are in the template.\n");
    }
    for parameter in &template.parameters {
        let hint = if parameter.secret {
            format!(
                "{}'s secret {}: FF never shows a secret back, so from where you keep it, or a new one",
                parameter.function, parameter.name
            )
        } else {
            format!("{}'s variable {}: ff env list {} --show", parameter.function, parameter.name, parameter.function)
        };
        text.push_str(&format!("#\n# {hint}\n{}=\n", parameter.id));
    }
    text
}

fn data_pages(account: &Account) -> Vec<File> {
    let mut pages = Vec::new();
    let functions: Vec<String> = account.functions.iter().map(|record| record.function.name.clone()).collect();
    if !functions.is_empty() {
        pages.push(File::new(
            "data/lambda.md",
            page(LAMBDA, &format!("{}.", named("function", "functions", &functions))),
        ));
    }
    if !account.databases.is_empty() {
        let databases: Vec<String> = account
            .databases
            .iter()
            .map(|database| match database.size_bytes {
                Some(_) => format!("`{}` ({})", database.name, super::super::db::size(database.size_bytes)),
                None => format!("`{}`", database.name),
            })
            .collect();
        let kind = if databases.len() == 1 { "database" } else { "databases" };
        pages.push(File::new("data/postgres.md", page(POSTGRES, &format!("the {kind} {}.", joined(&databases)))));
    }
    if !account.caches.is_empty() {
        let caches: Vec<String> = account.caches.iter().map(|cache| cache.name.clone()).collect();
        pages.push(File::new(
            "data/elasticache.md",
            page(ELASTICACHE, &format!("{}.", named("cache", "caches", &caches))),
        ));
    }
    if !account.identities.is_empty() {
        let identities: Vec<String> = account.identities.iter().map(|identity| identity.identity.clone()).collect();
        pages.push(File::new("data/ses.md", page(SES, &format!("mail from {}.", listed(&identities)))));
    }
    let queues: Vec<String> = account.queues.iter().map(|queue| queue.name.clone()).collect();
    if !queues.is_empty() {
        pages.push(File::new("data/sqs.md", page(SQS, &format!("{}.", named("queue", "queues", &queues)))));
    }
    let sites: Vec<String> = account
        .buckets
        .iter()
        .filter_map(|bucket| {
            let website = bucket.website.as_ref()?;
            let domains = if bucket.site_domains.is_empty() {
                String::new()
            } else {
                format!(" and {}", listed(&bucket.site_domains))
            };
            Some(format!("`{}`, at {}{domains}", bucket.name, website.url))
        })
        .collect();
    if !sites.is_empty() {
        let kind = if sites.len() == 1 { "site" } else { "sites" };
        pages.push(File::new("data/s3-website.md", page(S3_WEBSITE, &format!("the {kind} {}.", sites.join("; ")))));
    }
    if !account.buckets.is_empty() {
        pages.push(File { path: "data/s3-sync.sh".to_owned(), text: S3_SYNC.to_owned(), executable: true });
    }
    pages
}

/// The parent plan's runbook with the account's own resources, in the order that works: the data,
/// then the queues, then the functions, each served by FF until its callers move.
fn migration(account: &Account, template: &Template, read_on: &str) -> String {
    let stored: Vec<String> =
        account.buckets.iter().filter(|bucket| bucket.website.is_none()).map(|bucket| bucket.name.clone()).collect();
    let sites: Vec<String> =
        account.buckets.iter().filter(|bucket| bucket.website.is_some()).map(|bucket| bucket.name.clone()).collect();
    let count = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut held = vec![count(account.functions.len(), "function", "functions")];
    for (n, one, many) in [
        (account.queues.len(), "queue", "queues"),
        (stored.len(), "bucket", "buckets"),
        (sites.len(), "site", "sites"),
        (account.databases.len(), "database", "databases"),
        (account.caches.len(), "cache", "caches"),
        (account.identities.len(), "mail identity", "mail identities"),
    ] {
        if n > 0 {
            held.push(count(n, one, many));
        }
    }
    let mut text = format!(
        "# Moving {} from FF to AWS\n\n\
         `ff export` wrote this folder on {read_on} from FF's account {}: {}. It holds:\n\n\
         - `template.yaml`, for AWS SAM: the functions with their URLs, schedules, queues read and settings for calls that don't wait, the queues and the buckets with their events;\n",
        account.name,
        account.id,
        held.join(", ")
    );
    if template.before_copy.is_some() {
        text.push_str("- `template-before-copy.yaml`, the same without the buckets' events, for the first deploy, before the buckets' files are copied;\n");
    }
    text.push_str(
        "- `code/`, each function's zip as Lambda runs it;\n\
         - `secrets.template.env`, the values the template takes and this export doesn't write;\n\
         - `data/`, how each kind of resource moves, a page each.\n\n\
         The steps go in the order that works: the data first, then the queues, then the functions, each still served by FF until its callers move.\n",
    );
    if !template.notes.is_empty() {
        text.push_str("\n## What the template changes, or leaves to you\n\n");
        for note in &template.notes {
            text.push_str(&format!("- {note}\n"));
        }
    }
    let warm: u32 = account.functions.iter().map(|record| record.function.min_instances).sum();
    let most: u32 = account.functions.iter().map(|record| record.function.max_instances).sum();
    text.push_str(&format!(
        "\n## 1. Before the move\n\n\
         1. **An AWS account,** with a billing alarm (AWS Budgets), the AWS CLI and the SAM CLI.\n\
         2. **Lambda's quotas:** a new account's concurrency can start at 10 for all its functions together, in Service Quotas. These functions run up to {most} instances together on FF{}: ask for more before you move, as AWS takes days to answer.\n\
         3. **The template's values:** copy `secrets.template.env` to `secrets.env`, outside any repository, and fill it ({}).\n\
         4. **A staging account first,** if you can: the same steps there, your app's own tests against it.\n",
        if warm > 0 { format!(", {warm} kept warm as provisioned concurrency, which comes from the same quota") } else { String::new() },
        if template.parameters.is_empty() {
            "nothing to fill this time".to_owned()
        } else {
            count(template.parameters.len(), "value", "values")
        }
    ));
    let first = if template.before_copy.is_some() { " --template-file template-before-copy.yaml" } else { "" };
    text.push_str(&format!(
        "\n## 2. The stack, called by nobody yet\n\n\
         1. **Check it:** `sam validate --lint --region <your region>` in this folder.\n\
         2. **Deploy it:** `sam deploy --guided{first}`: the stack's name, your region, the parameters{}. The functions are made and nothing calls them yet: FF still serves everyone.\n\
         3. **Call each function there** (`data/lambda.md`'s third step) before anything moves to it.\n",
        if account.functions.iter().any(|record| record.schedules.iter().any(|schedule| schedule.enabled)) {
            format!(", `{SCHEDULES_STATE}` left `DISABLED` so that no schedule runs on both")
        } else {
            String::new()
        }
    ));
    text.push_str("\n## 3. The data\n\n");
    let mut step = 1;
    let mut item = |text: &mut String, line: String| {
        text.push_str(&format!("{step}. {line}\n"));
        step += 1;
    };
    if !account.databases.is_empty() {
        let names: Vec<String> = account.databases.iter().map(|database| database.name.clone()).collect();
        item(
            &mut text,
            format!(
                "**{}:** `pg_dump` from FF and `pg_restore` into RDS, your app's writes stopped for the copy, as `data/postgres.md` says; then each function's `DATABASE_URL`, or the secret you named, the new one.",
                capital(&named("database", "databases", &names))
            ),
        );
    }
    if !stored.is_empty() {
        item(
            &mut text,
            format!(
                "**{}:** `data/s3-sync.sh <bucket> <its bucket on S3>` copies each to the bucket the stack made, its name the parameter you gave; run it again at the cut-over for what changed since.",
                capital(&named("bucket", "buckets", &stored))
            ),
        );
    }
    if template.before_copy.is_some() {
        item(
            &mut text,
            "**The buckets' events,** once their files are copied: `sam deploy --template-file template.yaml` adds them, so that the copy called nothing.".to_owned(),
        );
    }
    if !sites.is_empty() {
        item(
            &mut text,
            format!(
                "**{}:** `data/s3-website.md`, an S3 bucket behind CloudFront, the files uploaded again.",
                capital(&named("site", "sites", &sites))
            ),
        );
    }
    if !account.caches.is_empty() {
        let names: Vec<String> = account.caches.iter().map(|cache| cache.name.clone()).collect();
        item(
            &mut text,
            format!(
                "**{}:** `data/elasticache.md`; nothing is copied, a cache filling again.",
                capital(&named("cache", "caches", &names))
            ),
        );
    }
    if !account.identities.is_empty() {
        let names: Vec<String> = account.identities.iter().map(|identity| identity.identity.clone()).collect();
        item(
            &mut text,
            format!(
                "**The mail from {}:** `data/ses.md`, SES's keys published beside FF's, so that both sign while you move.",
                listed(&names)
            ),
        );
    }
    if step == 1 {
        text.push_str("Nothing: the account has no database, bucket, site, cache or mail.\n");
    }
    text.push_str("\n## 4. The queues\n\n");
    if account.queues.is_empty() {
        text.push_str("None.\n");
    } else {
        let names: Vec<String> = account.queues.iter().map(|queue| queue.name.clone()).collect();
        text.push_str(&format!(
            "{}: as `data/sqs.md` says, the senders send to AWS's from now on (their environment without `AWS_ENDPOINT_URL_SQS`, and with AWS's credentials), FF's readers empty FF's, then FF's are deleted.\n",
            capital(&named("queue", "queues", &names))
        ));
    }
    text.push_str(
        "\n## 5. The functions\n\n\
         A day before, lower the TTL of the DNS records that will change. Then, for each function, its callers to AWS:\n\n",
    );
    for (record, exported) in account.functions.iter().zip(&template.functions) {
        let function = &record.function;
        let mut moves = Vec::new();
        if exported.lambda_name != function.name {
            moves.push(format!("`{}` on Lambda", exported.lambda_name));
        }
        if let (Some(url), Some(output)) = (&record.url, &exported.url_output) {
            moves.push(format!(
                "its URL's callers from {} to the address in the stack's output `{output}`",
                url.function_url
            ));
        }
        if !record.domains.is_empty() {
            moves.push(format!("{} through CloudFront, as `data/lambda.md` says", listed(&record.domains)));
        }
        let enabled: Vec<String> =
            record.schedules.iter().filter(|schedule| schedule.enabled).map(|schedule| schedule.name.clone()).collect();
        for schedule in &enabled {
            moves.push(format!("`ff schedule disable {} {schedule}`", function.name));
        }
        let read: Vec<String> =
            record.event_sources.iter().map(|mapping| name_in_arn(&mapping.event_source_arn).to_owned()).collect();
        if !read.is_empty() {
            moves.push(format!("reads {} on AWS once the senders send there", listed(&read)));
        }
        let callers: Vec<String> = account
            .buckets
            .iter()
            .filter(|bucket| {
                bucket.notifications.lambda_function_configurations.iter().any(|notification| {
                    notification.lambda_function_arn.as_deref().map(name_in_arn) == Some(function.name.as_str())
                })
            })
            .map(|bucket| bucket.name.clone())
            .collect();
        if !callers.is_empty() {
            moves.push(format!("called by the events of {} on S3 once they are there", listed(&callers)));
        }
        let what = if moves.is_empty() {
            "called by your code alone: point it at Lambda".to_owned()
        } else {
            moves.join("; ")
        };
        text.push_str(&format!("- **{}**: {what}.\n", function.name));
    }
    if account.functions.iter().any(|record| record.schedules.iter().any(|schedule| schedule.enabled)) {
        text.push_str(&format!(
            "\nOnce FF's schedules are disabled, `sam deploy --parameter-overrides {SCHEDULES_STATE}=ENABLED` turns AWS's on, so that each run happens once.\n"
        ));
    }
    text.push_str(
        "\n## 6. Watch, then leave FF\n\n\
         1. **Watch AWS:** each function's `Errors` and `Throttles` in CloudWatch, its log with `sam logs --stack-name <stack> --tail`.\n\
         2. **Watch FF go quiet:** `ff metrics <function> --since 1d` for each, until nothing calls it.\n\
         3. **Then delete on FF** what moved, as each page of `data/` says last: the functions (`ff delete <function>`), the queues, the buckets, the databases, the caches, the mail. Until then, FF bills what it keeps.\n",
    );
    text
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;
    use super::super::template::template;
    use super::*;

    fn text<'a>(files: &'a [File], path: &str) -> &'a str {
        &files.iter().find(|file| file.path == path).unwrap_or_else(|| panic!("{path} in the kit")).text
    }

    #[test]
    fn the_kit_has_a_page_for_each_kind_of_resource_the_account_has_its_names_under_the_title() {
        let account = shop();
        let files = files(&account, &template(&account, false, ""), "2026-10-31");

        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "template.yaml",
                "template-before-copy.yaml",
                "secrets.template.env",
                "data/lambda.md",
                "data/postgres.md",
                "data/elasticache.md",
                "data/ses.md",
                "data/sqs.md",
                "data/s3-website.md",
                "data/s3-sync.sh",
                "MIGRATION.md",
            ]
        );
        assert!(files.iter().all(|file| file.executable == (file.path == "data/s3-sync.sh")));
        assert!(text(&files, "data/lambda.md").starts_with(
            "# Your FF functions, to AWS Lambda\n\n> **In this account:** the functions `make-thumbnail`, `report.v1` and `send-receipts`.\n\n"
        ));
        assert!(text(&files, "data/postgres.md").contains("> **In this account:** the database `shop` (50 MB).\n"));
        assert!(
            text(&files, "data/s3-website.md")
                .contains("> **In this account:** the site `www`, at https://www.site.ff.tn and `shop.tn`.\n")
        );
        assert_eq!(text(&files, "data/s3-sync.sh"), S3_SYNC);

        let mut empty = shop();
        empty.functions.clear();
        empty.queues.clear();
        empty.buckets.clear();
        empty.databases.clear();
        empty.caches.clear();
        empty.identities.clear();
        let paths: Vec<String> = super::files(&empty, &template(&empty, false, ""), "2026-10-31")
            .into_iter()
            .map(|file| file.path)
            .collect();
        assert_eq!(paths, ["template.yaml", "secrets.template.env", "MIGRATION.md"]);
    }

    #[test]
    fn the_values_to_fill_are_each_a_line_with_what_it_is_and_never_a_value() {
        let account = shop();

        let values = secrets(&template(&account, false, ""));
        assert!(values.ends_with(
            "#\n# send-receipts's variable LOG_LEVEL: ff env list send-receipts --show\nSendReceiptsLogLevel=\n\
             #\n# send-receipts's secret DATABASE_URL: FF never shows a secret back, so from where you keep it, or a new one\nSendReceiptsDatabaseUrl=\n"
        ), "{values}");
        // With the variables' values in the template, the secrets alone are left to fill.
        let values = secrets(&template(&account, true, ""));
        assert_eq!(
            values.lines().filter(|line| !line.starts_with('#')).collect::<Vec<_>>(),
            ["SendReceiptsDatabaseUrl="]
        );
    }

    #[test]
    fn the_runbook_moves_the_data_then_the_queues_then_the_functions_with_the_accounts_own_names() {
        let account = shop();
        let template = template(&account, false, "");

        let runbook = migration(&account, &template, "2026-10-31");
        let at = |heading: &str| runbook.find(heading).unwrap_or_else(|| panic!("{heading} in:\n{runbook}"));
        assert!(at("## 3. The data") < at("## 4. The queues") && at("## 4. The queues") < at("## 5. The functions"));
        for line in [
            "`ff export` wrote this folder on 2026-10-31 from FF's account 123456789012: 3 functions, 3 queues, 1 bucket, 1 site, 1 database, 1 cache, 1 mail identity.",
            "2. **Deploy it:** `sam deploy --guided --template-file template-before-copy.yaml`",
            "**The buckets' events,** once their files are copied: `sam deploy --template-file template.yaml` adds them",
            "- **make-thumbnail**: called by the events of `photos` on S3 once they are there.",
            "- **report.v1**: `report_v1` on Lambda.",
            "- **send-receipts**: its URL's callers from https://abc.fn.ff.tn/ to the address in the stack's output `SendReceiptsUrl`; `api.shop.tn` through CloudFront, as `data/lambda.md` says; `ff schedule disable send-receipts nightly`; reads `orders` on AWS once the senders send there.",
            "`sam deploy --parameter-overrides ScheduleState=ENABLED` turns AWS's on",
        ] {
            assert!(runbook.contains(line), "{line:?} in:\n{runbook}");
        }
        for note in &template.notes {
            assert!(runbook.contains(&format!("- {note}\n")), "the note {note:?} in the runbook");
        }
    }
}
