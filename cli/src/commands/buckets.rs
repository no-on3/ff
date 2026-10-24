//! `ff buckets create|list|get|delete <name>` and `ff buckets keys list|create|revoke`: the account's
//! buckets, as AWS S3 gives them, and its access keys to them and to its queues. AWS's SDKs and CLI
//! reach them at FF's S3 and SQS endpoints with one of those keys: a key's secret is shown once, when
//! it is made, as the five variables AWS's tools read.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// A bucket, as `GET /buckets` and `GET /buckets/:name` answer it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    name: String,
    status: String,
    region: String,
    endpoint: String,
    url: String,
    /// What it held at its last hourly measure, and its objects then; none before its first.
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    objects: Option<u64>,
    /// The hour of that measure.
    #[serde(default)]
    measured_at: Option<String>,
    created_at: String,
}

/// What a bucket held at its last measure, in words.
fn held(bucket: &Bucket) -> String {
    match (&bucket.measured_at, bucket.objects) {
        (Some(at), Some(objects)) => format!(
            "{}, {objects} object{}, as measured at {} UTC",
            super::db::size(bucket.size_bytes),
            if objects == 1 { "" } else { "s" },
            &time(at)[..16]
        ),
        _ => "not measured yet: within the hour".to_owned(),
    }
}

/// An access key, as `GET /storage-keys` lists it: never its secret. Naming neither buckets nor queues, it reaches
/// all the account's; naming some, those alone.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageKey {
    id: String,
    buckets: Option<Vec<String>>,
    #[serde(default)]
    queues: Option<Vec<String>>,
    read_only: bool,
    created_at: String,
    last_used_at: Option<String>,
}

/// A key just made: its secret this once, and where to use it.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedKey {
    #[serde(flatten)]
    key: StorageKey,
    secret_access_key: String,
    endpoint: String,
    /// The SQS endpoint, AWS_ENDPOINT_URL_SQS, for the account's queues.
    #[serde(default)]
    sqs_endpoint: Option<String>,
    region: String,
}

/// AWS's prefixes and suffixes that no bucket of AWS's may have, and so no bucket of FF's.
const RESERVED_PREFIXES: [&str; 3] = ["xn--", "sthree-", "amzn-s3-demo-"];
const RESERVED_SUFFIXES: [&str; 4] = ["-s3alias", "--ol-s3", "--x-s3", "--table-s3"];

/// AWS's rule for a bucket's name, as the API's, without dots: 3 to 63 lower-case letters, digits
/// and hyphens, a letter or a digit first and last, none of the names AWS keeps.
pub fn is_bucket_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    (3..=63).contains(&bytes.len())
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|byte| edge(byte) || *byte == b'-')
        && !RESERVED_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
        && !RESERVED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

pub fn checked_name(name: &str) -> Result<&str, Error> {
    if is_bucket_name(name) {
        Ok(name)
    } else {
        Err(Error::new(
            Kind::Usage,
            format!(
                "\"{name}\" can't be a bucket's name: 3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as AWS names buckets (without dots on FF)"
            ),
        ))
    }
}

/// An access key ID as FF makes them: AKFF and 16 characters of base32.
pub fn is_key_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("AKFF")
        && id[4..].bytes().all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
}

/// What the account's buckets are reached with: the endpoint and the region, as AWS's tools take them.
fn reach(bucket: &Bucket) -> String {
    format!(
        "endpoint  {}\naddress   {} (and {}/{} path-style)\nregion    {}",
        bucket.endpoint, bucket.url, bucket.endpoint, bucket.name, bucket.region
    )
}

pub fn create(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    let bucket: Bucket = client.json(&Call::post("/buckets", json!({ "name": name })))?;
    context.out.result(&bucket, || {
        format!(
            "{} made\n{}\n`ff buckets keys create` makes an access key for AWS's SDKs and CLI\n\
             FF keeps no copy of its files at a second site: keep your own of those that matter (`aws s3 sync`)",
            bucket.name,
            reach(&bucket)
        )
    })
}

pub fn list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let buckets: Vec<Bucket> = client.json(&Call::get("/buckets"))?;
    context.out.result(&buckets, || {
        if buckets.is_empty() {
            return "The account has no bucket: `ff buckets create <name>` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = buckets
            .iter()
            .map(|bucket| {
                vec![
                    bucket.name.clone(),
                    bucket.status.clone(),
                    super::db::size(bucket.size_bytes),
                    bucket.url.clone(),
                    time(&bucket.created_at),
                ]
            })
            .collect();
        table(&["NAME", "STATUS", "SIZE", "ADDRESS", "CREATED (UTC)"], &rows)
    })
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    let bucket: Bucket = client.json(&Call::get(format!("/buckets/{name}")))?;
    context.out.result(&bucket, || {
        format!(
            "{}\nstatus    {}\nheld      {}\n{}\ncreated   {} UTC",
            bucket.name,
            bucket.status,
            held(&bucket),
            reach(&bucket),
            time(&bucket.created_at)
        )
    })
}

pub fn delete(name: &str, force: bool, yes: bool, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    let question = if force {
        format!("Delete the bucket {name}, with every file in it? Nothing can bring them back")
    } else {
        format!("Delete the bucket {name}? It must be empty: --force deletes its files too")
    };
    if !super::functions::confirmed("ff buckets delete", &question, yes)? {
        return context.out.result(&json!({ "deleted": false, "name": name }), || "Nothing deleted".to_owned());
    }
    let path = if force { format!("/buckets/{name}?force=true") } else { format!("/buckets/{name}") };
    client.done(&Call::delete(path))?;
    context.out.result(&json!({ "deleted": true, "name": name }), || {
        if force { format!("deleted the bucket {name}, with its files") } else { format!("deleted the bucket {name}") }
    })
}

/// The buckets or the queues a key reaches, for a column: all, those it names, or none when it names the others alone.
fn column(names: Option<&Vec<String>>, others: Option<&Vec<String>>) -> String {
    match (names, others) {
        (Some(names), _) => names.join(","),
        (None, Some(_)) => "-".to_owned(),
        (None, None) => "all".to_owned(),
    }
}

/// What a key reaches, in words.
fn reaches(key: &StorageKey) -> String {
    let named = |kind: &str, names: &[String]| {
        format!("the {kind}{} {}", if names.len() == 1 { "" } else { "s" }, names.join(", "))
    };
    let reach = match (&key.buckets, &key.queues) {
        (None, None) => "every bucket and queue of the account".to_owned(),
        (Some(buckets), None) => named("bucket", buckets),
        (None, Some(queues)) => named("queue", queues),
        (Some(buckets), Some(queues)) => format!("{} and {}", named("bucket", buckets), named("queue", queues)),
    };
    if key.read_only { format!("{reach}, read-only") } else { reach }
}

pub fn keys_list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let keys: Vec<StorageKey> = client.json(&Call::get("/storage-keys"))?;
    context.out.result(&keys, || {
        if keys.is_empty() {
            return "The account has no access key to its buckets and queues: `ff buckets keys create` makes one"
                .to_owned();
        }
        let rows: Vec<Vec<String>> = keys
            .iter()
            .map(|key| {
                vec![
                    key.id.clone(),
                    column(key.buckets.as_ref(), key.queues.as_ref()),
                    column(key.queues.as_ref(), key.buckets.as_ref()),
                    if key.read_only { "read-only" } else { "read-write" }.to_owned(),
                    key.last_used_at.as_deref().map(time).unwrap_or_else(|| "never".to_owned()),
                    time(&key.created_at),
                ]
            })
            .collect();
        table(&["ID", "BUCKETS", "QUEUES", "ACCESS", "LAST USED (UTC)", "CREATED (UTC)"], &rows)
    })
}

pub fn keys_create(buckets: &[String], queues: &[String], read_only: bool, context: &Context) -> Result<(), Error> {
    for bucket in buckets {
        checked_name(bucket)?;
    }
    for queue in queues {
        super::queues::checked_name(queue)?;
    }
    let client = Client::new(&context.settings()?)?;
    let mut body = json!({ "readOnly": read_only });
    if !buckets.is_empty() {
        body["buckets"] = json!(buckets);
    }
    if !queues.is_empty() {
        body["queues"] = json!(queues);
    }
    let made: CreatedKey = client.json(&Call::post("/storage-keys", body))?;
    context.out.result(&made, || {
        let mut text = format!(
            "{} made, reaching {}: its secret, shown this once (FF keeps it sealed; `ff buckets keys revoke {}` stops it):\n\
             export AWS_ACCESS_KEY_ID={}\nexport AWS_SECRET_ACCESS_KEY={}\nexport AWS_REGION={}\nexport AWS_ENDPOINT_URL_S3={}",
            made.key.id,
            reaches(&made.key),
            made.key.id,
            made.key.id,
            made.secret_access_key,
            made.region,
            made.endpoint
        );
        if let Some(sqs) = &made.sqs_endpoint {
            text.push_str(&format!("\nexport AWS_ENDPOINT_URL_SQS={sqs}"));
        }
        text
    })
}

pub fn keys_revoke(id: &str, yes: bool, context: &Context) -> Result<(), Error> {
    if !is_key_id(id) {
        return Err(Error::new(
            Kind::Usage,
            format!("\"{id}\" is no access key ID of FF's: AKFF and 16 letters and digits"),
        ));
    }
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff buckets keys revoke",
        &format!("Revoke the access key {id}? Whatever uses it is refused at once"),
        yes,
    )? {
        return context.out.result(&json!({ "revoked": false, "id": id }), || "Nothing revoked".to_owned());
    }
    client.done(&Call::delete(format!("/storage-keys/{id}")))?;
    context.out.result(&json!({ "revoked": true, "id": id }), || format!("revoked the access key {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_aws_without_dots_as_the_api_does() {
        for name in ["photos", "abc", "my-app-2026", "123", &format!("a{}c", "b".repeat(61))] {
            assert!(is_bucket_name(name), "{name}");
        }
        for name in [
            "ab",
            "Photos",
            "my.photos",
            "-photos",
            "photos-",
            "my_photos",
            "xn--photos",
            "photos-s3alias",
            &format!("a{}c", "b".repeat(62)),
        ] {
            assert!(!is_bucket_name(name), "{name}");
        }
        assert_eq!(checked_name("my.photos").unwrap_err().exit_code(), 2);
    }

    fn key(buckets: Option<&[&str]>, queues: Option<&[&str]>, read_only: bool) -> StorageKey {
        let names = |names: Option<&[&str]>| names.map(|names| names.iter().map(|name| name.to_string()).collect());
        StorageKey {
            id: "AKFF7Q2MLKX4RTZB3W5N".into(),
            buckets: names(buckets),
            queues: names(queues),
            read_only,
            created_at: "2026-10-24T08:00:00.000Z".into(),
            last_used_at: None,
        }
    }

    #[test]
    fn a_key_reaches_every_bucket_and_queue_or_those_it_names_alone() {
        let all = key(None, None, false);
        let photos = key(Some(&["photos"]), None, true);
        let orders = key(None, Some(&["orders", "orders-dlq"]), false);
        let both = key(Some(&["photos"]), Some(&["orders"]), false);
        assert_eq!(
            [reaches(&all), reaches(&photos), reaches(&orders), reaches(&both)],
            [
                "every bucket and queue of the account",
                "the bucket photos, read-only",
                "the queues orders, orders-dlq",
                "the bucket photos and the queue orders"
            ]
        );
        let columns = |key: &StorageKey| {
            (column(key.buckets.as_ref(), key.queues.as_ref()), column(key.queues.as_ref(), key.buckets.as_ref()))
        };
        assert_eq!(columns(&all), ("all".into(), "all".into()));
        assert_eq!(columns(&photos), ("photos".into(), "-".into()));
        assert_eq!(columns(&orders), ("-".into(), "orders,orders-dlq".into()));
        // An API before queues says nothing of them: such a key reaches what its buckets say.
        let older: StorageKey = serde_json::from_value(json!({ "id": "AKFF7Q2MLKX4RTZB3W5N", "buckets": null, "readOnly": false, "createdAt": "x", "lastUsedAt": null })).unwrap();
        assert_eq!(reaches(&older), "every bucket and queue of the account");
    }

    #[test]
    fn key_ids_are_ffs() {
        assert!(is_key_id("AKFF7Q2MLKX4RTZB3W5N"));
        for id in ["AKIA7Q2MLKX4RTZB3W5N", "AKFF7Q2MLKX4RTZB3W5", "AKFF7Q2MLKX4RTZB3W51", "akff7q2mlkx4rtzb3w5n"] {
            assert!(!is_key_id(id), "{id}");
        }
    }
}
