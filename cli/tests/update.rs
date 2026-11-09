//! The update notice: after a command that reached the API and succeeded, once a day at most, the downloads site's
//! latest.json read and verified against the release key (the tests' own, which a development build takes from
//! FF_TEST_RELEASE_KEY), a newer version said on stderr with the line that installs it; an older signing, another key,
//! another file's signature ignored; and off where it should be. The fixtures are cli/tests/fixtures/update/make.sh's.

mod common;

use std::path::Path;

use common::{Reply, Server, ff, with_key};
use serde_json::{Value, json};
use tempfile::TempDir;

const KEY: &str = include_str!("fixtures/update/release.pub");
const NEWER: &[u8] = include_bytes!("fixtures/update/newer.json");
const NEWER_SIGNED: &[u8] = include_bytes!("fixtures/update/newer.json.minisig");
const NEWER_SIGNED_BY_ANOTHER: &[u8] = include_bytes!("fixtures/update/newer.json.other.minisig");
const NEWER_SIGNED_AS_A_BUILD: &[u8] = include_bytes!("fixtures/update/newer.json.binary.minisig");
const REPLAYED: &[u8] = include_bytes!("fixtures/update/replayed.json");
const REPLAYED_SIGNED: &[u8] = include_bytes!("fixtures/update/replayed.json.minisig");
const CURRENT: &[u8] = include_bytes!("fixtures/update/current.json");
const CURRENT_SIGNED: &[u8] = include_bytes!("fixtures/update/current.json.minisig");
/// newer.json's signing time, in its trusted comment.
const NEWER_SIGNED_AT: u64 = 1_800_000_100;

/// The API's answer to `ff list`, then the downloads site's latest.json and its signature.
fn api_then_site(manifest: &[u8], signature: &[u8]) -> Server {
    Server::start(vec![
        Reply::json(200, json!([])),
        Reply::bytes(200, "application/json", manifest.to_vec()),
        Reply::bytes(200, "application/octet-stream", signature.to_vec()),
    ])
}

/// `ff list`, its update check pointed at the server's /get, verified against the tests' key: its stderr.
fn listed(dir: &TempDir, server: &Server, args: &[&str]) -> String {
    let output = ff(dir)
        .env("FF_DOWNLOADS_URL", format!("{}/get", server.url))
        .env("FF_TEST_RELEASE_KEY", KEY.lines().nth(1).unwrap())
        .arg("list")
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stderr).unwrap()
}

fn paths(server: &Server) -> Vec<String> {
    server.requests().into_iter().map(|request| request.path).collect()
}

fn state(dir: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("update-check.json")).unwrap()).unwrap()
}

fn notice(server: &Server, version: &str) -> String {
    let install = if cfg!(windows) {
        format!("irm {}/get/install.ps1 | iex", server.url)
    } else {
        format!("curl -fsSL {}/get/install.sh | sh", server.url)
    };
    format!("notice: ff {version} is out, and this one is {}: {install}\n", env!("CARGO_PKG_VERSION"))
}

#[test]
fn a_newer_version_is_said_after_a_command_that_reached_the_api_then_not_again_that_day() {
    let site = api_then_site(NEWER, NEWER_SIGNED);
    let dir = with_key(&site.url);
    assert_eq!(listed(&dir, &site, &[]), notice(&site, "98.0.0"));
    assert_eq!(paths(&site)[1..], ["/get/latest.json", "/get/latest.json.minisig"]);
    let kept = state(dir.path());
    assert_eq!((kept["signedAt"].as_u64(), kept["latest"].as_str()), (Some(NEWER_SIGNED_AT), Some("98.0.0")));

    // The same day: the API alone.
    let api = Server::start(vec![Reply::json(200, json!([]))]);
    let again = with_key(&api.url);
    std::fs::copy(dir.path().join("update-check.json"), again.path().join("update-check.json")).unwrap();
    assert_eq!(listed(&again, &api, &[]), "");
    assert_eq!(paths(&api).len(), 1);
}

#[test]
fn a_latest_json_signed_before_the_last_one_verified_is_ignored_though_it_names_a_newer_version() {
    let site = api_then_site(REPLAYED, REPLAYED_SIGNED);
    let dir = with_key(&site.url);
    let day_old = json!({ "checkedAt": 0, "signedAt": NEWER_SIGNED_AT, "latest": "98.0.0" });
    std::fs::write(dir.path().join("update-check.json"), day_old.to_string()).unwrap();
    let said = listed(&dir, &site, &["--verbose"]);
    assert!(said.contains("before the last one verified, at 1800000100: an old one, ignored"), "{said}");
    assert!(!said.contains("notice:"), "{said}");
    let kept = state(dir.path());
    assert_eq!((kept["signedAt"].as_u64(), kept["latest"].as_str()), (Some(NEWER_SIGNED_AT), Some("98.0.0")));
    assert_ne!(kept["checkedAt"], 0);
}

#[test]
fn a_signature_by_another_key_or_of_another_file_is_ignored() {
    for (signature, why) in [
        (NEWER_SIGNED_BY_ANOTHER, "latest.json's signature: signed by another key than the one given"),
        (
            NEWER_SIGNED_AS_A_BUILD,
            "latest.json's trusted comment, \"timestamp:1800000100\\tfile:ff-linux-x86_64\\thashed\"",
        ),
    ] {
        let site = api_then_site(NEWER, signature);
        let dir = with_key(&site.url);
        let said = listed(&dir, &site, &["--verbose"]);
        assert!(said.contains(why) && !said.contains("notice:"), "{said}");
        assert_eq!(state(dir.path())["signedAt"], 0);
    }
}

#[test]
fn the_version_running_or_an_older_one_is_no_news() {
    let site = api_then_site(CURRENT, CURRENT_SIGNED);
    let dir = with_key(&site.url);
    assert_eq!(listed(&dir, &site, &[]), "");
    assert_eq!(state(dir.path())["latest"], "0.0.1");
}

#[test]
fn no_check_when_turned_off_never_shown_or_after_a_command_that_didnt_reach_the_api_or_failed() {
    let api_alone = || Server::start(vec![Reply::json(200, json!([]))]);
    let checks = |dir: &TempDir, server: &Server, args: &[&str], set: &[(&str, &str)]| {
        let mut command = ff(dir);
        command
            .env("FF_DOWNLOADS_URL", format!("{}/get", server.url))
            .env("FF_TEST_RELEASE_KEY", KEY.lines().nth(1).unwrap());
        for (name, value) in set {
            command.env(name, value);
        }
        command.arg("list").args(args).assert().success();
        (paths(server).len(), dir.path().join("update-check.json").exists())
    };

    let api = api_alone();
    assert_eq!(checks(&with_key(&api.url), &api, &[], &[("FF_NO_UPDATE_CHECK", "1")]), (1, false));
    let api = api_alone();
    let dir = with_key(&api.url);
    ff(&dir).args(["config", "set", "update_check", "false"]).assert().success();
    assert_eq!(checks(&dir, &api, &[], &[]), (1, false));
    for shown_never in [["--output", "json"], ["--quiet", "--quiet"]] {
        let api = api_alone();
        let args = if shown_never[0] == "--quiet" { &shown_never[..1] } else { &shown_never[..] };
        assert_eq!(checks(&with_key(&api.url), &api, args, &[]), (1, false), "{args:?}");
    }
    // Where ff keeps no folder, as in a CI given FF_TOKEN alone.
    let api = api_alone();
    let dir = TempDir::new().unwrap();
    let none = dir.path().join("none");
    let set = [("FF_CONFIG_DIR", none.to_str().unwrap()), ("FF_TOKEN", common::KEY), ("FF_ENDPOINT", &api.url)];
    assert_eq!(checks(&dir, &api, &[], &set), (1, false));
    assert!(!none.exists());

    // A command that reached no API, and one the API refused.
    let site = api_then_site(NEWER, NEWER_SIGNED);
    let dir = with_key(&site.url);
    ff(&dir).env("FF_DOWNLOADS_URL", format!("{}/get", site.url)).args(["config", "show"]).assert().success();
    assert!(paths(&site).is_empty() && !dir.path().join("update-check.json").exists());
    let refused =
        Server::start(vec![Reply::json(500, json!({ "statusCode": 500, "message": "Internal server error" }))]);
    let dir = with_key(&refused.url);
    ff(&dir)
        .env("FF_DOWNLOADS_URL", format!("{}/get", refused.url))
        .env("FF_TEST_RELEASE_KEY", KEY.lines().nth(1).unwrap())
        .arg("list")
        .assert()
        .failure();
    assert_eq!(paths(&refused).len(), 1);
}

#[test]
fn a_build_given_no_site_never_checks() {
    let api = Server::start(vec![Reply::json(200, json!([]))]);
    let dir = with_key(&api.url);
    ff(&dir).env("FF_TEST_RELEASE_KEY", KEY.lines().nth(1).unwrap()).arg("list").assert().success().stderr("");
    assert_eq!(paths(&api).len(), 1);
}
