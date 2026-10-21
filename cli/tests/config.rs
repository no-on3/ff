//! `ff config`: the profiles' settings and tokens in ff's files, and which one is in effect.

mod common;

use common::{KEY, ff, settings};
use predicates::prelude::*;

#[test]
fn a_setting_saved_in_the_profile_yields_to_the_environment_and_then_to_a_flag() {
    let dir = settings("", "");
    ff(&dir).args(["config", "set", "endpoint", "https://api.ff.example/"]).assert().success().stdout(format!(
        "endpoint = https://api.ff.example in profile default ({})\n",
        dir.path().join("config.toml").display()
    ));

    let endpoint_line = |output: std::process::Output| {
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .find(|line| line.starts_with("endpoint"))
            .unwrap()
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_eq!(
        endpoint_line(ff(&dir).args(["config", "show"]).output().unwrap()),
        "https://api.ff.example config.toml"
    );
    assert_eq!(
        endpoint_line(ff(&dir).args(["config", "show"]).env("FF_ENDPOINT", "https://env.ff.example").output().unwrap()),
        "https://env.ff.example FF_ENDPOINT"
    );
    assert_eq!(
        endpoint_line(
            ff(&dir)
                .args(["config", "show", "--endpoint", "http://localhost:3000"])
                .env("FF_ENDPOINT", "https://env.ff.example")
                .output()
                .unwrap()
        ),
        "http://localhost:3000 --endpoint"
    );
}

#[test]
fn plain_http_to_another_machine_is_refused_unless_allowed() {
    let dir = settings("", "");
    ff(&dir)
        .args(["config", "set", "endpoint", "http://ff.lan:3000"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("http://ff.lan:3000 is plain http, which would send your token unencrypted"));

    ff(&dir).args(["config", "set", "allow_http", "true"]).assert().success();
    ff(&dir).args(["config", "set", "endpoint", "http://ff.lan:3000"]).assert().success();
    ff(&dir).args(["config", "show"]).assert().success().stdout(predicate::str::contains("allow_http   true"));
}

#[test]
fn a_saved_key_is_read_from_stdin_kept_for_its_owner_only_and_never_shown_whole() {
    // A folder ff makes itself, as on a first run.
    let home = settings("", "");
    let dir = home.path().join("ff");
    let ff = || {
        let mut command = ff(&home);
        command.env("FF_CONFIG_DIR", &dir);
        command
    };
    ff().args(["config", "set-token"]).write_stdin(format!("{KEY}\n")).assert().success().stdout(format!(
        "Saved the API key ffk_0123456789ab_… for profile default ({})\n",
        dir.join("credentials.toml").display()
    ));

    let show = ff().args(["config", "show"]).output().unwrap();
    let text = String::from_utf8(show.stdout).unwrap();
    assert!(text.contains("token        ffk_0123456789ab_…"), "{text}");
    assert!(!text.contains(KEY));
    let saved = std::fs::read_to_string(dir.join("credentials.toml")).unwrap();
    assert_eq!(saved, format!("[profiles.default]\ntoken = \"{KEY}\"\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&dir.join("credentials.toml")), mode(&dir)), (0o600, 0o700));
    }
}

#[test]
fn what_isnt_a_key_and_a_token_on_the_command_line_are_refused() {
    let dir = settings("", "");
    ff(&dir)
        .args(["config", "set-token"])
        .write_stdin("eyJhbGciOiJSUzI1NiJ9.x.y\n")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("That isn't an API key: a key reads ffk_<key ID>_<secret>"));
    ff(&dir)
        .args(["config", "set", "token", KEY])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("would stay in your shell's history"));
    assert!(!dir.path().join("credentials.toml").exists());
}

#[test]
fn a_profile_is_made_by_its_first_setting_and_must_exist_once_named() {
    let dir = settings("", "");
    ff(&dir)
        .args(["whoami", "--profile", "staging"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("There is no profile staging in"));

    ff(&dir).args(["config", "set", "account", "123456789012", "--profile", "staging"]).assert().success();
    ff(&dir).args(["config", "show"]).env("FF_PROFILE", "staging").assert().success().stdout(
        predicate::str::contains("profile      staging").and(predicate::str::contains("account      123456789012")),
    );
    ff(&dir)
        .args(["config", "set", "account", "acme"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("account must be an account ID, 12 digits: acme"));
}

#[test]
fn unset_removes_a_setting_or_says_there_was_none() {
    let dir = settings(
        "[profiles.default]\naccount = \"123456789012\"\n",
        &format!("[profiles.default]\ntoken = \"{KEY}\"\n"),
    );
    ff(&dir)
        .args(["config", "unset", "account"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("account removed from profile default"));
    ff(&dir)
        .args(["config", "unset", "account"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("Profile default has no account"));
    ff(&dir)
        .args(["config", "unset", "token"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("token removed from profile default"));
    assert_eq!(std::fs::read_to_string(dir.path().join("credentials.toml")).unwrap(), "[profiles.default]\n");
}

#[test]
fn a_change_keeps_the_files_comments_and_other_profiles() {
    let dir = settings("# my settings\n[profiles.staging] # theirs\nendpoint = \"https://staging.ff.example\"\n", "");
    ff(&dir).args(["config", "set", "dev_account", "123456789012"]).assert().success();

    assert_eq!(
        std::fs::read_to_string(dir.path().join("config.toml")).unwrap(),
        "# my settings\n[profiles.staging] # theirs\nendpoint = \"https://staging.ff.example\"\n\n[profiles.default]\ndev_account = \"123456789012\"\n"
    );
}

#[test]
fn show_as_json_gives_each_setting_with_its_source() {
    let dir = settings("[profiles.default]\ndev_account = \"123456789012\"\n", "");
    let output = ff(&dir).args(["config", "show", "--output", "json"]).env("FF_TOKEN", KEY).output().unwrap();
    let document: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(document["endpoint"], serde_json::json!({ "value": "http://localhost:3000", "source": "default" }));
    assert_eq!(document["devAccount"], serde_json::json!({ "value": "123456789012", "source": "config.toml" }));
    assert_eq!(document["token"], serde_json::json!({ "value": "ffk_0123456789ab_…", "source": "FF_TOKEN" }));
    assert_eq!(document["account"], serde_json::Value::Null);
    assert_eq!(document["configFile"], dir.path().join("config.toml").display().to_string());
}

#[test]
fn credentials_others_can_read_are_used_with_a_warning() {
    let dir = settings("", &format!("[profiles.default]\ntoken = \"{KEY}\"\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path().join("credentials.toml"), std::fs::Permissions::from_mode(0o644)).unwrap();
        ff(&dir).args(["config", "show"]).assert().success().stderr(predicate::str::contains(format!(
            "warning: {} can be read by others than you (mode 644): chmod 600",
            dir.path().join("credentials.toml").display()
        )));
    }
}
