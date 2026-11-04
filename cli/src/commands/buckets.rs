//! `ff buckets create|list|get|delete <name>`: the account's buckets, as AWS S3 gives them. AWS's
//! SDKs and CLI reach them at FF's S3 endpoint with one of the account's access keys, which
//! `ff keys` makes (`ff buckets keys` another name for it).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use crate::api::{Call, Client};
use crate::config::is_bucket_name;
use crate::error::Error;
use crate::table::{table, time};

/// A bucket, as `GET /buckets` and `GET /buckets/:name` answer it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Bucket {
    pub(super) name: String,
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
    /// Its tags, in a bucket's own answer alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<BTreeMap<String, String>>,
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

pub fn checked_name(name: &str) -> Result<&str, Error> {
    if is_bucket_name(name) {
        Ok(name)
    } else {
        Err(Error::usage(format!(
            "\"{name}\" can't be a bucket's name: 3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as AWS names buckets (without dots on FF)"
        )))
    }
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
            "{} made\n{}\n`ff keys create` makes an access key for AWS's SDKs and CLI\n\
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
        let tags = match bucket.tags.as_ref().filter(|tags| !tags.is_empty()) {
            Some(tags) => format!("tags      {}\n", crate::table::tags(tags)),
            None => String::new(),
        };
        format!(
            "{}\nstatus    {}\nheld      {}\n{tags}{}\ncreated   {} UTC",
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
}
