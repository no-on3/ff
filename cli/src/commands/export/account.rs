//! What an export reads of the account through FF's API: each function with its settings, the
//! queues and buckets, and the names of the databases, caches and mail it has.

use serde::Deserialize;

use super::super::buckets::Bucket;
use super::super::caches::Cache;
use super::super::db::Database;
use super::super::email::Identity;
use super::super::event_sources::EventSource;
use super::super::queues::Queue;
use super::super::schedule::Schedule;
use super::super::secrets::Secrets;
use super::super::sites::Website;
use super::super::url::{Domain, FunctionUrl};
use super::roles::{KeyUse, KeyUses};
use crate::api::types::{Function, MeAccount, name_in_arn};
use crate::api::{Call, Client};
use crate::error::{Error, Kind};

/// A function's settings for its calls that don't wait, as Lambda's EventInvokeConfig: null for
/// Lambda's defaults.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncConfig {
    pub maximum_retry_attempts: Option<u32>,
    pub maximum_event_age_in_seconds: Option<u32>,
    #[serde(default)]
    pub destination_config: Destinations,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destinations {
    #[serde(default)]
    pub on_success: Destination,
    #[serde(default)]
    pub on_failure: Destination,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Destination {
    /// The function's or the queue's ARN; none when there is none.
    pub destination: Option<String>,
}

/// A bucket's notifications, as S3's NotificationConfiguration in the API's JSON names.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notifications {
    #[serde(default)]
    pub lambda_function_configurations: Vec<Notification>,
    #[serde(default)]
    pub queue_configurations: Vec<Notification>,
}

/// One configuration: its ID, its events, its filter, and the function or the queue it goes to.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    #[serde(default)]
    pub id: Option<String>,
    pub events: Vec<String>,
    #[serde(default)]
    pub filter: Option<KeyFilter>,
    #[serde(default)]
    pub lambda_function_arn: Option<String>,
    #[serde(default)]
    pub queue_arn: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct KeyFilter {
    pub key: FilterRules,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterRules {
    pub filter_rules: Vec<FilterRule>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct FilterRule {
    pub name: String,
    pub value: String,
}

/// A function, and what calls it or what it calls.
pub struct FunctionRecord {
    pub function: Function,
    /// Its secrets' names, never a value.
    pub secrets: Vec<String>,
    pub url: Option<FunctionUrl>,
    /// The account's domains on its URL.
    pub domains: Vec<String>,
    pub schedules: Vec<Schedule>,
    pub event_sources: Vec<EventSource>,
    pub async_config: Option<AsyncConfig>,
    /// What its keys used of the account's buckets, queues and mail, which its role allows.
    pub uses: Vec<KeyUse>,
}

/// A bucket, its notifications, and its site when it is one, with the site's domains.
pub struct BucketRecord {
    pub name: String,
    pub notifications: Notifications,
    pub website: Option<Website>,
    pub site_domains: Vec<String>,
}

/// What the export read: the account's, or what the functions named reach.
pub struct Account {
    pub id: String,
    pub name: String,
    pub functions: Vec<FunctionRecord>,
    pub queues: Vec<Queue>,
    pub buckets: Vec<BucketRecord>,
    pub databases: Vec<Database>,
    pub caches: Vec<Cache>,
    pub identities: Vec<Identity>,
}

fn function_record(client: &Client, listed: &Function) -> Result<FunctionRecord, Error> {
    let path = format!("/functions/{}", listed.id);
    let function: Function = client.json(&Call::get(&path))?;
    let secrets: Secrets = client.json(&Call::get(format!("{path}/secrets")))?;
    let url: Option<FunctionUrl> = client.json_if_any(&Call::get(format!("{path}/url")))?;
    let domains: Vec<Domain> = match url {
        Some(_) => client.json(&Call::get(format!("{path}/url/domains")))?,
        None => Vec::new(),
    };
    Ok(FunctionRecord {
        secrets: secrets.secrets.into_iter().map(|secret| secret.name).collect(),
        url,
        domains: domains.into_iter().map(|domain| domain.domain).collect(),
        schedules: client.json(&Call::get(format!("{path}/schedules")))?,
        event_sources: client.json(&Call::get(format!("{path}/event-sources")))?,
        async_config: client.json_if_any(&Call::get(format!("{path}/event-invoke-config")))?,
        uses: client.json::<KeyUses>(&Call::get(format!("{path}/key-uses")))?.uses,
        function,
    })
}

fn bucket_record(client: &Client, bucket: Bucket) -> Result<BucketRecord, Error> {
    let path = format!("/buckets/{}", bucket.name);
    let website: Option<Website> = client.json_if_any(&Call::get(format!("{path}/website")))?;
    let site_domains: Vec<Domain> = match website {
        Some(_) => client.json(&Call::get(format!("{path}/website/domains")))?,
        None => Vec::new(),
    };
    Ok(BucketRecord {
        notifications: client.json(&Call::get(format!("{path}/notifications")))?,
        website,
        site_domains: site_domains.into_iter().map(|domain| domain.domain).collect(),
        name: bucket.name,
    })
}

/// Reads the account, every function in it or those named, each named one there first.
pub fn read(client: &Client, account: &MeAccount, only: &[String]) -> Result<Account, Error> {
    let mut functions: Vec<Function> = client.json(&Call::get("/functions"))?;
    if let Some(missing) = only.iter().find(|name| !functions.iter().any(|function| &function.name == *name)) {
        return Err(Error::new(
            Kind::Failed,
            format!("There is no function named \"{missing}\" in the account: `ff list` shows its functions"),
        ));
    }
    if !only.is_empty() {
        functions.retain(|function| only.contains(&function.name));
    }
    functions.sort_by(|a, b| a.name.cmp(&b.name));
    let functions =
        functions.iter().map(|function| function_record(client, function)).collect::<Result<Vec<_>, _>>()?;
    let queues: Vec<Queue> = client.json(&Call::get("/queues"))?;
    let buckets: Vec<Bucket> = client.json(&Call::get("/buckets"))?;
    let buckets = buckets.into_iter().map(|bucket| bucket_record(client, bucket)).collect::<Result<Vec<_>, _>>()?;
    let mut read = Account {
        id: account.id.clone(),
        name: account.name.clone(),
        functions,
        queues,
        buckets,
        databases: client.json(&Call::get("/databases"))?,
        caches: client.json(&Call::get("/caches"))?,
        identities: client.json(&Call::get("/email/identities"))?,
    };
    if !only.is_empty() {
        read.keep_what_the_functions_reach();
    }
    Ok(read)
}

impl Account {
    pub fn queue_named(&self, name: &str) -> Option<&Queue> {
        self.queues.iter().find(|queue| queue.name == name)
    }

    /// The buckets that call the functions or that their keys use, and the queues the functions
    /// read, use, send their calls' records to or have their buckets' events sent to, with these
    /// queues' dead-letter queues.
    fn keep_what_the_functions_reach(&mut self) {
        let functions: Vec<&str> = self.functions.iter().map(|record| record.function.name.as_str()).collect();
        let used = |service: &str| -> Vec<String> {
            self.functions
                .iter()
                .flat_map(|record| &record.uses)
                .filter(|used| used.service == service && !used.resource.is_empty())
                .map(|used| used.resource.clone())
                .collect()
        };
        let (used_buckets, used_queues) = (used("s3"), used("sqs"));
        self.buckets.retain(|bucket| {
            used_buckets.contains(&bucket.name)
                || bucket.notifications.lambda_function_configurations.iter().any(|notification| {
                    notification.lambda_function_arn.as_deref().is_some_and(|arn| functions.contains(&name_in_arn(arn)))
                })
        });
        let mut queues: Vec<String> = self
            .functions
            .iter()
            .flat_map(|record| {
                let read = record.event_sources.iter().map(|mapping| mapping.event_source_arn.as_str());
                let destinations = record.async_config.iter().flat_map(|config| {
                    [&config.destination_config.on_success, &config.destination_config.on_failure]
                        .into_iter()
                        .filter_map(|destination| destination.destination.as_deref())
                });
                read.chain(destinations).collect::<Vec<_>>()
            })
            .chain(self.buckets.iter().flat_map(|bucket| {
                bucket
                    .notifications
                    .queue_configurations
                    .iter()
                    .filter_map(|notification| notification.queue_arn.as_deref())
            }))
            .filter(|arn| arn.starts_with("arn:aws:sqs:"))
            .map(|arn| name_in_arn(arn).to_owned())
            .chain(used_queues)
            .collect();
        // A queue's dead-letter queue, and that one's, as far as they go.
        let mut next = 0;
        while next < queues.len() {
            let dead_letters = self
                .queue_named(&queues[next])
                .and_then(|queue| queue.redrive_policy.as_ref())
                .map(|policy| name_in_arn(&policy.dead_letter_target_arn).to_owned());
            if let Some(dead_letters) = dead_letters.filter(|name| !queues.contains(name)) {
                queues.push(dead_letters);
            }
            next += 1;
        }
        self.queues.retain(|queue| queues.contains(&queue.name));
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::shop;

    #[test]
    fn the_functions_named_keep_the_buckets_that_call_them_or_that_they_use_and_the_queues_they_reach_with_their_dead_letters()
     {
        let mut account = shop();
        account.functions.retain(|record| record.function.name == "make-thumbnail");

        account.keep_what_the_functions_reach();

        let buckets: Vec<&str> = account.buckets.iter().map(|bucket| bucket.name.as_str()).collect();
        let queues: Vec<&str> = account.queues.iter().map(|queue| queue.name.as_str()).collect();
        // photos calls make-thumbnail, and sends its deletions to orders, whose dead letters go to orders-dlq.
        assert_eq!(buckets, ["photos"]);
        assert_eq!(queues, ["orders", "orders-dlq"]);

        let mut account = shop();
        account.functions.retain(|record| record.function.name == "send-receipts");
        account.keep_what_the_functions_reach();
        // No bucket calls send-receipts: its keys use photos and the site www, and send to invoices, gone since.
        let buckets: Vec<&str> = account.buckets.iter().map(|bucket| bucket.name.as_str()).collect();
        assert_eq!(buckets, ["photos", "www"]);
        let queues: Vec<&str> = account.queues.iter().map(|queue| queue.name.as_str()).collect();
        assert_eq!(queues, ["failed-receipts", "orders", "orders-dlq"]);
    }
}
