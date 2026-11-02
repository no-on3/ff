//! `ff sites deploy|get|remove|metrics <bucket>` and `ff sites domains list|add|verify|remove`: a
//! bucket's site, as S3's website hosting serves one. A deploy uploads a built site's folder at the S3
//! endpoint with a deploy's own key to the bucket, for an hour, which it revokes when it is done:
//! the files that changed, each typed and cached by its name, then the bucket's files the folder
//! hasn't deleted; and makes the bucket a site if it isn't one.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Context;
use super::buckets::checked_name;
use super::url::{Domain, encode, records_text};
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::md5;
use crate::progress::Progress;
use crate::s3::{BucketClient, Credentials};
use crate::table::{table, time};

/// The content type a file gets by its name's extension, as FF's website server gives one to a
/// file stored without its own (BE/src/storage/content-types.ts, which a test compares this with).
const CONTENT_TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("htm", "text/html; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("json", "application/json"),
    ("map", "application/json"),
    ("webmanifest", "application/manifest+json"),
    ("xml", "application/xml"),
    ("txt", "text/plain; charset=utf-8"),
    ("md", "text/markdown; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("ico", "image/x-icon"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("wasm", "application/wasm"),
    ("pdf", "application/pdf"),
    ("zip", "application/zip"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
];

/// A year, and never asked again: a file whose name changes with its content.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Kept, but asked again each time, which its ETag answers with 304 when it hasn't changed.
const REVALIDATE: &str = "no-cache";

/// A file's type by its name's extension; application/octet-stream for one not listed.
pub fn content_type(key: &str) -> &'static str {
    let name = key.rsplit('/').next().unwrap_or(key);
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let extension = name[dot + 1..].to_ascii_lowercase();
            CONTENT_TYPES.iter().find(|(known, _)| *known == extension).map_or("application/octet-stream", |(_, t)| t)
        }
        _ => "application/octet-stream",
    }
}

/// Whether a file's name carries a hash of its content, as bundlers name assets
/// (`app-3c9d1a2b.js`, `main.8f3e2b1c.css`): its name's last part before the extension, after a
/// hyphen or a dot, 8 characters at least of letters, digits and underscores, with both letters
/// and digits. Any other file may change under the same name.
pub fn is_hashed(key: &str) -> bool {
    let name = key.rsplit('/').next().unwrap_or(key);
    let Some(stem) = name.rfind('.').filter(|dot| *dot > 0).map(|dot| &name[..dot]) else { return false };
    let Some(cut) = stem.rfind(['-', '.']) else { return false };
    let part = &stem[cut + 1..];
    part.len() >= 8
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && part.chars().any(|c| c.is_ascii_digit())
        && part.chars().any(|c| c.is_ascii_alphabetic())
}

/// How long browsers keep a file: a year for a hashed asset, never without asking for the rest,
/// HTML first, as FF's console serves its own.
pub fn cache_control(key: &str) -> &'static str {
    if is_hashed(key) && !content_type(key).starts_with("text/html") { IMMUTABLE } else { REVALIDATE }
}

/// A bucket's website configuration, as the API answers it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Website {
    index_document: Suffix,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_document: Option<ErrorKey>,
    single_page_app: bool,
    pub(super) url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Suffix {
    suffix: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct ErrorKey {
    key: String,
}

/// A deploy's own key to the bucket, as the API makes one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeployKey {
    access_key_id: String,
    secret_access_key: String,
    endpoint: String,
    region: String,
}

/// What `ff sites deploy` was asked for, besides the bucket and the folder.
pub struct DeployOptions {
    /// Some(true) for a single-page app's, Some(false) for no longer one; None to keep it.
    pub single_page_app: Option<bool>,
    pub index_document: Option<String>,
    pub error_document: Option<String>,
    /// Keep the bucket's files the folder hasn't.
    pub keep: bool,
}

/// What a deploy did, for a script.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Deployed {
    bucket: String,
    url: String,
    uploaded: Vec<String>,
    unchanged: usize,
    deleted: Vec<String>,
    single_page_app: bool,
}

/// A folder's files, by their keys: the paths under it, with slashes. Names starting with a dot
/// are left out, `.well-known` apart, as no built site needs `.git` or `.DS_Store` served.
fn files_of(folder: &Path) -> Result<BTreeMap<String, PathBuf>, Error> {
    fn walk(dir: &Path, prefix: &str, files: &mut BTreeMap<String, PathBuf>) -> Result<(), Error> {
        let entries =
            fs::read_dir(dir).map_err(|error| Error::usage(format!("can't read {}: {error}", dir.display())))?;
        for entry in entries {
            let entry = entry.map_err(|error| Error::usage(format!("can't read {}: {error}", dir.display())))?;
            let name = entry.file_name().into_string().map_err(|name| {
                Error::usage(format!("{} is no UTF-8 name, which S3's keys are", Path::new(&name).display()))
            })?;
            if name.starts_with('.') && name != ".well-known" {
                continue;
            }
            let path = entry.path();
            let key = format!("{prefix}{name}");
            if path.is_dir() {
                walk(&path, &format!("{key}/"), files)?;
            } else if path.is_file() {
                files.insert(key, path);
            }
        }
        Ok(())
    }
    if !folder.is_dir() {
        return Err(Error::usage(format!("{} is no folder: give the built site's, such as ./dist", folder.display())));
    }
    let mut files = BTreeMap::new();
    walk(folder, "", &mut files)?;
    if files.is_empty() {
        return Err(Error::usage(format!("{} has no file to deploy", folder.display())));
    }
    Ok(files)
}

fn read(path: &Path) -> Result<Vec<u8>, Error> {
    fs::read(path).map_err(|error| Error::usage(format!("can't read {}: {error}", path.display())))
}

/// The bucket's website configuration; None when it is no site.
fn website_of(client: &Client, bucket: &str) -> Result<Option<Website>, Error> {
    match client.json::<Website>(&Call::get(format!("/buckets/{bucket}/website"))) {
        Ok(website) => Ok(Some(website)),
        Err(error) if error.status == Some(404) && error.message.contains("no site") => Ok(None),
        Err(error) => Err(error),
    }
}

/// The configuration a deploy leaves: the bucket's as it is, with what the deploy says changed; a
/// new site's with the index document, the folder's 404.html as its error document when it has one.
fn configuration(current: Option<&Website>, options: &DeployOptions, files: &BTreeMap<String, PathBuf>) -> Value {
    let index = options
        .index_document
        .clone()
        .or_else(|| current.map(|site| site.index_document.suffix.clone()))
        .unwrap_or_else(|| "index.html".to_owned());
    let error = match (&options.error_document, current) {
        (Some(key), _) => Some(key.clone()),
        (None, Some(site)) => site.error_document.as_ref().map(|error| error.key.clone()),
        (None, None) => files.contains_key("404.html").then(|| "404.html".to_owned()),
    };
    let single_page_app = options.single_page_app.or(current.map(|site| site.single_page_app)).unwrap_or(false);
    let mut body = json!({ "indexDocument": { "suffix": index }, "singlePageApp": single_page_app });
    if let Some(error) = error {
        body["errorDocument"] = json!({ "key": error });
    }
    body
}

/// Whether a configuration says what the bucket's says already.
fn unchanged(current: &Website, wanted: &Value) -> bool {
    wanted["indexDocument"]["suffix"] == current.index_document.suffix.as_str()
        && wanted["errorDocument"]["key"].as_str() == current.error_document.as_ref().map(|error| error.key.as_str())
        && wanted["singlePageApp"] == current.single_page_app
}

pub fn deploy(bucket: &str, folder: &Path, options: &DeployOptions, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let files = files_of(folder)?;
    let client = Client::new(&context.settings()?)?;
    let current = website_of(&client, bucket)?;
    let wanted = configuration(current.as_ref(), options, &files);
    let index = wanted["indexDocument"]["suffix"].as_str().unwrap_or("index.html").to_owned();
    if !files.contains_key(&index) {
        context.out.warn(&format!("{} has no {index}: the site's address answers 404 until it has", folder.display()));
    }
    let key: DeployKey = client.json(&Call::post(format!("/buckets/{bucket}/website/deploy-keys"), json!({})))?;
    let progress = Progress::start(context.out, &format!("deploying {} to {bucket}", folder.display()));
    let sent = upload(bucket, &files, &key, options.keep);
    // The key goes whatever happened: its hour would end it anyway.
    let revoked = client.done(&Call::delete(format!("/buckets/{bucket}/website/deploy-keys/{}", key.access_key_id)));
    progress.stop();
    let (uploaded, unchanged_count, deleted) = sent?;
    revoked?;
    let website: Website = match &current {
        Some(site) if unchanged(site, &wanted) => site.clone(),
        _ => client.json(&Call::put(format!("/buckets/{bucket}/website"), wanted))?,
    };
    let deployed = Deployed {
        bucket: bucket.to_owned(),
        url: website.url.clone(),
        uploaded,
        unchanged: unchanged_count,
        deleted,
        single_page_app: website.single_page_app,
    };
    context.out.result(&deployed, || {
        let made = if current.is_none() { ", made a site" } else { "" };
        format!(
            "{} deployed to {bucket}{made}: {} uploaded, {} unchanged, {} deleted\n{}",
            folder.display(),
            files_count(deployed.uploaded.len()),
            files_count(deployed.unchanged),
            files_count(deployed.deleted.len()),
            deployed.url
        )
    })
}

fn files_count(count: usize) -> String {
    if count == 1 { "1 file".to_owned() } else { format!("{count} files") }
}

/// The files that changed sent, the pages last so that none names an asset not there yet; then the
/// bucket's other files deleted, unless kept. What was uploaded, how many were unchanged, and what
/// was deleted.
fn upload(
    bucket: &str,
    files: &BTreeMap<String, PathBuf>,
    key: &DeployKey,
    keep: bool,
) -> Result<(Vec<String>, usize, Vec<String>), Error> {
    let s3 = BucketClient::new(
        &key.endpoint,
        bucket,
        Credentials {
            access_key_id: key.access_key_id.clone(),
            secret_access_key: key.secret_access_key.clone(),
            region: key.region.clone(),
        },
    )?;
    let stored: HashMap<String, (String, u64)> =
        s3.list()?.into_iter().map(|object| (object.key, (object.etag, object.size))).collect();
    let (pages, assets): (Vec<_>, Vec<_>) =
        files.iter().partition(|(key, _)| content_type(key).starts_with("text/html"));
    let (mut uploaded, mut unchanged) = (Vec::new(), 0);
    for (key, path) in assets.into_iter().chain(pages) {
        let body = read(path)?;
        let digest = md5::hex(&body);
        if stored.get(key).is_some_and(|(etag, size)| *etag == digest && *size == body.len() as u64) {
            unchanged += 1;
            continue;
        }
        s3.put(key, &body, content_type(key), cache_control(key))?;
        uploaded.push(key.clone());
    }
    let mut deleted = Vec::new();
    if !keep {
        let mut gone: Vec<&String> = stored.keys().filter(|key| !files.contains_key(*key)).collect();
        gone.sort();
        for key in gone {
            s3.delete(key)?;
            deleted.push(key.clone());
        }
    }
    Ok((uploaded, unchanged, deleted))
}

pub fn get(bucket: &str, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let Some(website) = website_of(&client, bucket)? else {
        return Err(Error::new(
            Kind::Failed,
            format!("{bucket} is no site: `ff sites deploy {bucket} <folder>` makes it one with its files"),
        ));
    };
    context.out.result(&website, || {
        format!(
            "{}\nindex document  {}\nerror document  {}\nsingle-page app {}",
            website.url,
            website.index_document.suffix,
            website.error_document.as_ref().map_or("none: FF's own page, with 404", |error| error.key.as_str()),
            if website.single_page_app { "yes: a path with no file answers the index document" } else { "no" }
        )
    })
}

pub fn remove(bucket: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff sites remove",
        &format!("Make {bucket} no site? Its address stops answering; its files are kept, private again"),
        yes,
    )? {
        return context.out.result(&json!({ "removed": false }), || "Nothing changed".to_owned());
    }
    client.done(&Call::delete(format!("/buckets/{bucket}/website")))?;
    context.out.result(&json!({ "removed": true, "bucket": bucket }), || {
        format!("{bucket} is no site now: its files are kept")
    })
}

/// A site's metric that is counted: each period's total.
#[derive(Deserialize)]
struct Total {
    #[serde(rename = "Sum")]
    sum: Vec<u64>,
}

/// A site's share of its visits: each period's, in percent, none in a period without a visit.
#[derive(Deserialize)]
struct Share {
    #[serde(rename = "Average")]
    average: Vec<Option<f64>>,
}

/// The site's metrics a table shows, as CloudWatch names a CloudFront distribution's.
#[derive(Deserialize)]
struct SiteSeries {
    #[serde(rename = "Requests")]
    requests: Total,
    #[serde(rename = "BytesDownloaded")]
    bytes_downloaded: Total,
    #[serde(rename = "4xxErrorRate")]
    client_errors: Share,
    #[serde(rename = "5xxErrorRate")]
    server_errors: Share,
}

#[derive(Deserialize)]
struct SiteMetrics {
    period: u64,
    timestamps: Vec<String>,
    metrics: SiteSeries,
}

/// A share as a row shows it: `-` for a period without a visit.
fn share(value: Option<f64>) -> String {
    value.map_or_else(|| "-".to_owned(), |value| format!("{value:.1}%"))
}

/// A site's visits over the last `since`, a row per period: its requests, the bytes they were sent, and the share
/// answered 4xx and 5xx.
pub fn metrics(bucket: &str, period: u32, since: &str, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let start = super::account::start_of(since, SystemTime::now())?;
    let client = Client::new(&context.settings()?)?;
    let answer: Value = client.json(
        &Call::get(format!("/buckets/{bucket}/website/metrics")).query("period", period).query("start", &start),
    )?;
    let metrics: SiteMetrics = serde_json::from_value(answer.clone())
        .map_err(|error| Error::new(Kind::Failed, format!("the API answered metrics ff can't read: {error}")))?;
    let series = &metrics.metrics;
    let rows: Vec<Vec<String>> = metrics
        .timestamps
        .iter()
        .enumerate()
        .map(|(index, timestamp)| {
            vec![
                time(timestamp),
                series.requests.sum[index].to_string(),
                super::package::size(series.bytes_downloaded.sum[index]),
                share(series.client_errors.average[index]),
                share(series.server_errors.average[index]),
            ]
        })
        .collect();
    let visits: u64 = series.requests.sum.iter().sum();
    let summary = format!(
        "{bucket}'s site for {}, a point each {}: {visits} visit{}, {} sent",
        humantime::format_duration(Duration::from_secs(u64::from(period) * metrics.timestamps.len() as u64)),
        humantime::format_duration(Duration::from_secs(metrics.period)),
        if visits == 1 { "" } else { "s" },
        super::package::size(series.bytes_downloaded.sum.iter().sum())
    );
    context
        .out
        .result(&answer, || format!("{}\n{summary}", table(&["TIME (UTC)", "VISITS", "SENT", "4XX", "5XX"], &rows)))
}

pub fn domains_list(bucket: &str, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let domains: Vec<Domain> = client.json(&Call::get(format!("/buckets/{bucket}/website/domains")))?;
    context.out.result(&domains, || {
        if domains.is_empty() {
            return format!(
                "{bucket}'s site has no domain of its own: `ff sites domains add {bucket} <domain>` adds one"
            );
        }
        let rows: Vec<Vec<String>> = domains
            .iter()
            .map(|domain| {
                vec![
                    domain.domain.clone(),
                    domain.status.clone(),
                    domain.checked_at.as_deref().map(time).unwrap_or_default(),
                    domain.check_error.clone().unwrap_or_default(),
                ]
            })
            .collect();
        table(&["DOMAIN", "STATUS", "CHECKED (UTC)", "LAST CHECK'S PROBLEM"], &rows)
    })
}

pub fn domains_add(bucket: &str, domain: &str, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let added: Domain =
        client.json(&Call::post(format!("/buckets/{bucket}/website/domains"), json!({ "domain": domain })))?;
    context
        .out
        .result(&added, || format!("{}\nthen: ff sites domains verify {bucket} {}", records_text(&added), added.domain))
}

pub fn domains_verify(bucket: &str, domain: &str, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let checked: Domain =
        client.json(&Call::post(format!("/buckets/{bucket}/website/domains/{}/verify", encode(domain)), json!({})))?;
    context.out.result(&checked, || records_text(&checked))
}

pub fn domains_remove(bucket: &str, domain: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let bucket = checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff sites domains remove",
        &format!("Remove {domain} from {bucket}'s site? It stops answering there"),
        yes,
    )? {
        return context.out.result(&json!({ "removed": false }), || "Nothing removed".to_owned());
    }
    client.done(&Call::delete(format!("/buckets/{bucket}/website/domains/{}", encode(domain))))?;
    context
        .out
        .result(&json!({ "removed": true, "domain": domain }), || format!("{domain} removed from {bucket}'s site"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_files_as_the_website_server_does() {
        // The website server's list, in the backend: the same names, the same types, in the same order.
        let source = include_str!("../../../BE/src/storage/content-types.ts");
        let theirs: Vec<(String, String)> = source
            .lines()
            .filter_map(|line| {
                let (name, rest) = line.trim().split_once(": '")?;
                let value = rest.strip_suffix("',")?;
                name.chars().all(|c| c.is_ascii_alphanumeric()).then(|| (name.to_owned(), value.to_owned()))
            })
            .collect();
        let ours: Vec<(String, String)> =
            CONTENT_TYPES.iter().map(|(n, t)| ((*n).to_owned(), (*t).to_owned())).collect();
        assert_eq!(ours, theirs);
        assert_eq!(content_type("assets/App.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("docs/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
        assert_eq!(content_type(".htaccess"), "application/octet-stream");
    }

    #[test]
    fn caches_hashed_assets_a_year_and_the_rest_never_without_asking() {
        for key in [
            "assets/app-3c9d1a2b.js",
            "assets/index-B4x9Qa1f.css",
            "static/js/main.8f3e2b1c.js",
            "img/logo-a1b2c3d4e5.svg",
        ] {
            assert_eq!(cache_control(key), IMMUTABLE, "{key}");
        }
        for key in [
            "index.html",
            "docs/page-1a2b3c4d.html",
            "favicon-32x32.png",
            "report-2026.pdf",
            "my-component.js",
            "robots.txt",
            "assets/index-DiwrgTda.js",
        ] {
            assert_eq!(cache_control(key), REVALIDATE, "{key}");
        }
    }

    fn site(spa: bool, error: Option<&str>) -> Website {
        Website {
            index_document: Suffix { suffix: "index.html".into() },
            error_document: error.map(|key| ErrorKey { key: key.into() }),
            single_page_app: spa,
            url: "https://shop.site.example.tn".into(),
        }
    }

    fn options() -> DeployOptions {
        DeployOptions { single_page_app: None, index_document: None, error_document: None, keep: false }
    }

    #[test]
    fn makes_a_new_site_with_the_folder_s_404_page_and_keeps_a_site_s_settings_unless_told() {
        let mut files = BTreeMap::new();
        files.insert("index.html".to_owned(), PathBuf::from("index.html"));
        assert_eq!(
            configuration(None, &options(), &files),
            json!({ "indexDocument": { "suffix": "index.html" }, "singlePageApp": false })
        );
        files.insert("404.html".to_owned(), PathBuf::from("404.html"));
        assert_eq!(
            configuration(None, &DeployOptions { single_page_app: Some(true), ..options() }, &files),
            json!({ "indexDocument": { "suffix": "index.html" }, "errorDocument": { "key": "404.html" }, "singlePageApp": true })
        );

        let current = site(true, Some("missing.html"));
        let kept = configuration(Some(&current), &options(), &files);
        assert!(unchanged(&current, &kept));
        let changed =
            configuration(Some(&current), &DeployOptions { single_page_app: Some(false), ..options() }, &files);
        assert!(!unchanged(&current, &changed));
        assert_eq!(changed["errorDocument"]["key"], "missing.html");
        assert!(!unchanged(
            &site(false, None),
            &configuration(
                Some(&site(false, None)),
                &DeployOptions { error_document: Some("e.html".into()), ..options() },
                &files
            )
        ));
    }

    #[test]
    fn takes_a_folder_s_files_by_their_keys_but_dot_files() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["index.html", "assets/app.js", ".git/config", ".DS_Store", ".well-known/security.txt", "a b/é.txt"]
        {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }

        let keys: Vec<String> = files_of(dir.path()).unwrap().into_keys().collect();
        assert_eq!(keys, [".well-known/security.txt", "a b/é.txt", "assets/app.js", "index.html"]);
        assert!(files_of(&dir.path().join("index.html")).is_err());
    }
}
