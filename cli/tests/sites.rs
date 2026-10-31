//! `ff sites` against a scripted API, which plays the S3 endpoint too: a deploy with its own key,
//! each request signed for S3, the files that changed sent typed and cached by their names, the
//! pages last, the bucket's other files deleted, the key revoked whatever happened; the site's own
//! domains.

mod common;

use std::fs;
use std::path::Path;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const KEY_ID: &str = "AKFF0123456789ABCDEF";

fn write(dir: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let path = dir.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

fn no_site() -> Reply {
    Reply::json(
        404,
        json!({ "statusCode": 404, "message": "The bucket \"shop\" is no site: it has no website configuration" }),
    )
}

fn deploy_key(endpoint: &str) -> Reply {
    Reply::json(
        201,
        json!({ "bucket": "shop", "accessKeyId": KEY_ID, "secretAccessKey": "s3cr3t", "expiresAt": "2026-10-30T11:00:00.000Z",
                "endpoint": endpoint, "region": "tn-tunis-1" }),
    )
}

/// A ListObjectsV2 page of these keys, ETags and sizes.
fn listing(objects: &[(&str, &str, usize)]) -> Reply {
    let contents: String = objects
        .iter()
        .map(|(key, etag, size)| {
            format!("<Contents><Key>{key}</Key><ETag>&quot;{etag}&quot;</ETag><Size>{size}</Size></Contents>")
        })
        .collect();
    Reply::text(
        200,
        "application/xml",
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>shop</Name><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
        ),
    )
}

fn stored() -> Reply {
    Reply::text(200, "application/xml", "")
}

fn website(spa: bool, error: Option<&str>) -> Value {
    let mut view =
        json!({ "indexDocument": { "suffix": "index.html" }, "singlePageApp": spa, "url": "https://shop.site.ff.tn" });
    if let Some(key) = error {
        view["errorDocument"] = json!({ "key": key });
    }
    view
}

#[test]
fn deploys_the_files_that_changed_pages_last_deletes_the_rest_and_revokes_its_key() {
    let site = tempfile::tempdir().unwrap();
    write(
        site.path(),
        &[
            ("index.html", "<h1>shop</h1>"),
            ("404.html", "<h1>missing</h1>"),
            ("assets/app-3c9d1a2b.js", "console.log(1)"),
            ("robots.txt", "User-agent: *"),
            (".git/HEAD", "ref: main"),
        ],
    );
    let bound = Server::bind();
    let endpoint = bound.url.clone();
    let server = bound.serve(vec![
        no_site(),
        deploy_key(&endpoint),
        // robots.txt is there as it is; old.html isn't in the folder any more.
        listing(&[("robots.txt", "ca121b5d03245bf82db00d14cee04e22", 13), ("old.html", "abc", 3)]),
        stored(),
        stored(),
        stored(),
        Reply::text(204, "application/xml", ""),
        Reply::text(204, "application/json", ""),
        Reply::json(200, website(false, Some("404.html"))),
    ]);

    let dir = with_key(&server.url);
    ff(&dir)
        .args(["sites", "deploy", "shop"])
        .arg(site.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("made a site: 3 files uploaded, 1 file unchanged, 1 file deleted"))
        .stdout(predicate::str::contains("https://shop.site.ff.tn"));

    let requests = server.requests();
    let seen: Vec<String> = requests.iter().map(|request| format!("{} {}", request.method, request.path)).collect();
    assert_eq!(
        seen,
        [
            "GET /buckets/shop/website",
            "POST /buckets/shop/website/deploy-keys",
            "GET /shop?list-type=2&max-keys=1000",
            "PUT /shop/assets/app-3c9d1a2b.js",
            "PUT /shop/404.html",
            "PUT /shop/index.html",
            "DELETE /shop/old.html",
            &format!("DELETE /buckets/shop/website/deploy-keys/{KEY_ID}"),
            "PUT /buckets/shop/website",
        ]
    );
    // Each S3 request signed with the deploy's key, for S3 in its region, its payload's hash signed too.
    for request in &requests[2..7] {
        let authorization = request.header("authorization").unwrap();
        assert!(
            authorization.starts_with(&format!("AWS4-HMAC-SHA256 Credential={KEY_ID}/"))
                && authorization.contains("/tn-tunis-1/s3/aws4_request, SignedHeaders=")
                && authorization.contains("host;")
                && authorization.contains("x-amz-content-sha256;x-amz-date"),
            "{authorization}"
        );
    }
    let script = &requests[3];
    assert_eq!(script.body, "console.log(1)");
    assert_eq!(script.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(script.header("cache-control"), Some("public, max-age=31536000, immutable"));
    assert_eq!(
        script.header("x-amz-content-sha256"),
        Some("0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393")
    );
    assert_eq!(requests[5].header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(requests[5].header("cache-control"), Some("no-cache"));
    // A new site: the index document, and the folder's 404.html as its error document.
    assert_eq!(
        serde_json::from_str::<Value>(&requests[8].body).unwrap(),
        json!({ "indexDocument": { "suffix": "index.html" }, "errorDocument": { "key": "404.html" }, "singlePageApp": false })
    );
}

#[test]
fn leaves_unchanged_files_and_a_site_s_settings_and_keeps_others_when_told() {
    let site = tempfile::tempdir().unwrap();
    write(site.path(), &[("index.html", "abc")]);
    let bound = Server::bind();
    let endpoint = bound.url.clone();
    let server = bound.serve(vec![
        Reply::json(200, website(true, None)),
        deploy_key(&endpoint),
        // index.html's MD5, as S3's ETag of an object put in one piece.
        listing(&[("index.html", "900150983cd24fb0d6963f7d28e17f72", 3), ("data.json", "x", 2)]),
        Reply::text(204, "application/json", ""),
    ]);

    let dir = with_key(&server.url);
    let output =
        ff(&dir).args(["sites", "deploy", "shop", "--keep", "--output", "json"]).arg(site.path()).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let done: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        (&done["uploaded"], &done["unchanged"], &done["deleted"], &done["singlePageApp"]),
        (&json!([]), &json!(1), &json!([]), &json!(true))
    );
    assert_eq!(server.requests().len(), 4);
}

#[test]
fn says_what_s3_refused_and_revokes_its_key_all_the_same() {
    let site = tempfile::tempdir().unwrap();
    write(site.path(), &[("index.html", "<h1>shop</h1>")]);
    let bound = Server::bind();
    let endpoint = bound.url.clone();
    let server = bound.serve(vec![
        no_site(),
        deploy_key(&endpoint),
        listing(&[]),
        Reply::text(
            403,
            "application/xml",
            "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>The account's storage is turned off</Message></Error>",
        )
        .header("x-amz-request-id", "4442587FB7D0A2F9"),
        Reply::text(204, "application/json", ""),
    ]);

    let dir = with_key(&server.url);
    ff(&dir).args(["sites", "deploy", "shop"]).arg(site.path()).assert().code(6).stderr(predicate::str::contains(
        "S3 refused PUT index.html: AccessDenied: The account's storage is turned off",
    ));
    let requests = server.requests();
    assert_eq!(
        requests.last().map(|r| format!("{} {}", r.method, r.path)),
        Some(format!("DELETE /buckets/shop/website/deploy-keys/{KEY_ID}"))
    );
}

#[test]
fn refuses_a_folder_that_is_no_folder_before_any_call() {
    let dir = with_key(&common::unreachable_url());
    ff(&dir)
        .args(["sites", "deploy", "shop", "no/such/folder"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("no/such/folder is no folder: give the built site's, such as ./dist"));
}

#[test]
fn domains_are_the_site_s_own_with_the_records_to_make() {
    let added = json!({ "domain": "www.shop.tn", "bucket": "shop", "status": "pending",
        "records": { "cname": [{ "type": "CNAME", "name": "www.shop.tn", "value": "shop.site.ff.tn" }],
                     "txt": [{ "type": "TXT", "name": "_ff-verify.www.shop.tn", "value": "ff-verify=t0k3n" }] },
        "checkedAt": null, "checkError": "No CNAME yet", "verifiedAt": null, "createdAt": "2026-10-30T09:20:00.000Z" });
    let server = Server::start(vec![Reply::json(201, added)]);

    let dir = with_key(&server.url);
    ff(&dir)
        .args(["sites", "domains", "add", "shop", "www.shop.tn"])
        .assert()
        .success()
        .stdout(predicate::str::contains("CNAME www.shop.tn shop.site.ff.tn"))
        .stdout(predicate::str::contains("then: ff sites domains verify shop www.shop.tn"));
    let requests = server.requests();
    assert_eq!(format!("{} {}", requests[0].method, requests[0].path), "POST /buckets/shop/website/domains");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), json!({ "domain": "www.shop.tn" }));
}

#[test]
fn metrics_show_a_row_per_period_the_visits_their_bytes_and_the_shares_that_failed() {
    let answer = json!({
        "period": 3600, "start": "2026-10-24T07:00:00.000Z", "end": "2026-10-24T09:00:00.000Z",
        "timestamps": ["2026-10-24T07:00:00.000Z", "2026-10-24T08:00:00.000Z"],
        "metrics": {
            "Requests": { "Sum": [12, 0] },
            "BytesDownloaded": { "Sum": [48_000, 0] },
            "4xxErrorRate": { "Average": [25.0, null] },
            "5xxErrorRate": { "Average": [8.333, null] },
            "TotalErrorRate": { "Average": [33.333, null] }
        }
    });
    let api = Server::start(vec![Reply::json(200, answer.clone()), Reply::json(200, answer)]);
    let dir = with_key(&api.url);

    ff(&dir).args(["sites", "metrics", "shop", "--period", "3600", "--since", "2h"]).assert().success().stdout(
        "TIME (UTC)           VISITS  SENT     4XX    5XX\n\
         2026-10-24 07:00:00  12      48.0 KB  25.0%  8.3%\n\
         2026-10-24 08:00:00  0       0 bytes  -      -\n\
         shop's site for 2h, a point each 1h: 12 visits, 48.0 KB sent\n",
    );
    let path = &api.requests()[0].path;
    assert!(path.starts_with("/buckets/shop/website/metrics?period=3600&start=20"), "{path}");
    // JSON is the API's answer, the series the table leaves out included.
    ff(&dir)
        .args(["sites", "metrics", "shop", "--output", "json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"TotalErrorRate\""));
    ff(&dir).args(["sites", "metrics", "Shop"]).assert().code(2);
    ff(&dir).args(["sites", "metrics", "shop", "--period", "120"]).assert().code(2);
    assert_eq!(api.requests().len(), 2);
}
