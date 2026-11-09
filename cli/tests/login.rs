//! `ff login` and `ff logout`, and a login's token in the commands that follow, against one scripted server that
//! answers as the API and as its realm, at `/realms/ff`, in turn.

mod common;

use common::{Bound, KEY, Reply, Server, ff, settings, unreachable_url};
use predicates::prelude::*;
use serde_json::{Value, json};

fn issuer(url: &str) -> String {
    format!("{url}/realms/ff")
}

/// What the API says of its login.
fn place(url: &str) -> Reply {
    Reply::json(200, json!({ "mode": "oidc", "issuer": issuer(url) }))
}

/// The realm's discovery document, as Keycloak's names the endpoints the login uses.
fn discovery(url: &str) -> Reply {
    let issuer = issuer(url);
    Reply::json(
        200,
        json!({
            "issuer": issuer,
            "device_authorization_endpoint": format!("{issuer}/protocol/openid-connect/auth/device"),
            "token_endpoint": format!("{issuer}/protocol/openid-connect/token"),
            "revocation_endpoint": format!("{issuer}/protocol/openid-connect/revoke"),
        }),
    )
}

/// A code, polled for at once: the tests' polls don't wait.
fn device_code(url: &str) -> Reply {
    Reply::json(
        200,
        json!({
            "device_code": "the-device-code",
            "user_code": "ABCD-EFGH",
            "verification_uri": format!("{}/device", issuer(url)),
            "verification_uri_complete": format!("{}/device?user_code=ABCD-EFGH", issuer(url)),
            "expires_in": 600,
            "interval": 0,
        }),
    )
}

fn oauth_error(error: &str, description: &str) -> Reply {
    Reply::json(400, json!({ "error": error, "error_description": description }))
}

fn tokens(access: &str, refresh: &str) -> Reply {
    Reply::json(
        200,
        json!({ "access_token": access, "expires_in": 300, "refresh_token": refresh, "refresh_expires_in": 0, "token_type": "Bearer", "scope": "openid profile email offline_access" }),
    )
}

fn user_me() -> Value {
    json!({
        "user": { "id": "u1", "email": "salma@ff.test", "name": "Salma", "locale": "en" },
        "key": null,
        "accounts": [{ "id": "123456789012", "name": "Acme", "status": "active", "role": "owner",
                       "plan": { "id": "beta", "name": "Beta", "limits": {} } }]
    })
}

/// A profile calling `url`, with a login whose access token ended at `expires_at`, and maybe an API key.
fn logged_in(url: &str, expires_at: &str, key: bool) -> tempfile::TempDir {
    let key = if key { format!("token = \"{KEY}\"\n") } else { String::new() };
    settings(
        &format!("[profiles.default]\nendpoint = \"{url}\"\n"),
        &format!(
            "[profiles.default]\n{key}issuer = \"{}\"\naccess_token = \"old-access\"\nrefresh_token = \"old-refresh\"\nexpires_at = \"{expires_at}\"\n",
            issuer(url)
        ),
    )
}

fn credentials(dir: &tempfile::TempDir) -> String {
    std::fs::read_to_string(dir.path().join("credentials.toml")).unwrap_or_default()
}

fn profile(bound: &Bound) -> tempfile::TempDir {
    settings(&format!("[profiles.default]\nendpoint = \"{}\"\n", bound.url), "")
}

#[test]
fn a_login_shows_where_to_approve_it_waits_keeps_the_tokens_and_says_who_logged_in() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = profile(&bound);
    let server = bound.serve(vec![
        place(&url),
        discovery(&url),
        device_code(&url),
        oauth_error("authorization_pending", "The authorization request is still pending"),
        tokens("user-access", "user-refresh"),
        Reply::json(200, user_me()),
        Reply::json(200, user_me()),
    ]);

    ff(&dir)
        .arg("login")
        .assert()
        .success()
        .stderr(predicate::str::contains(format!(
            "Open {url}/realms/ff/device?user_code=ABCD-EFGH in a browser: check that it shows the code ABCD-EFGH, then sign in and approve this device."
        )))
        .stdout(format!(
            "Logged in on profile default, as:\nSalma <salma@ff.test>\n* account 123456789012 \"Acme\" (active, plan Beta), as owner\nAPI: {url}\n"
        ));
    ff(&dir).arg("whoami").assert().success();

    let requests = server.requests();
    let route = |index: usize| format!("{} {}", requests[index].method, requests[index].path);
    assert_eq!(
        (0..requests.len()).map(route).collect::<Vec<_>>(),
        [
            "GET /login",
            "GET /realms/ff/.well-known/openid-configuration",
            "POST /realms/ff/protocol/openid-connect/auth/device",
            "POST /realms/ff/protocol/openid-connect/token",
            "POST /realms/ff/protocol/openid-connect/token",
            "GET /me",
            "GET /me",
        ]
    );
    // Asked before there is a token, and the login asked to last while it is used.
    assert_eq!(requests[0].header("authorization"), None);
    assert_eq!(requests[2].body, "client_id=ff-cli&scope=openid+offline_access");
    assert_eq!(
        requests[3].body,
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=the-device-code&client_id=ff-cli"
    );
    // The API takes the new token before it is kept; the next command uses it.
    assert_eq!(requests[5].header("authorization"), Some("Bearer user-access"));
    assert_eq!(requests[6].header("authorization"), Some("Bearer user-access"));
    let kept = credentials(&dir);
    assert!(kept.starts_with(&format!(
        "[profiles.default]\nissuer = \"{url}/realms/ff\"\naccess_token = \"user-access\"\nrefresh_token = \"user-refresh\"\nexpires_at = \"20"
    )));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("credentials.toml")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn as_json_the_login_gives_the_profile_its_file_and_the_apis_answer() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = profile(&bound);
    let _server = bound.serve(vec![
        place(&url),
        discovery(&url),
        device_code(&url),
        tokens("user-access", "user-refresh"),
        Reply::json(200, user_me()),
    ]);

    let output = ff(&dir).args(["login", "--output", "json"]).output().unwrap();

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        document,
        json!({
            "profile": "default",
            "file": dir.path().join("credentials.toml"),
            "issuer": issuer(&url),
            "apiKeyRemoved": false,
            "me": user_me(),
        })
    );
    // The user must see where to approve it, whatever the format.
    assert!(String::from_utf8_lossy(&output.stderr).contains("the code ABCD-EFGH"));
}

#[test]
fn a_denial_or_an_expired_code_ends_the_login_keeping_nothing() {
    for (answer, said) in [
        (
            oauth_error("access_denied", "Consent denied for connecting the device"),
            "The login was denied in the browser: nothing was saved",
        ),
        (
            oauth_error("expired_token", "Device code is expired"),
            "The code wasn't approved within its 10m: nothing was saved",
        ),
    ] {
        let bound = Server::bind();
        let url = bound.url.clone();
        let dir = profile(&bound);
        let server = bound.serve(vec![place(&url), discovery(&url), device_code(&url), answer]);

        ff(&dir).arg("login").assert().code(3).stderr(predicate::str::contains(format!("error: {said}")));

        assert_eq!(server.requests().len(), 4);
        assert_eq!(credentials(&dir), "");
    }
}

#[test]
fn an_access_token_about_to_end_is_renewed_before_the_call_and_kept() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = logged_in(&url, "2026-01-01T00:00:00Z", false);
    let server =
        bound.serve(vec![discovery(&url), tokens("renewed-access", "renewed-refresh"), Reply::json(200, user_me())]);

    ff(&dir).arg("whoami").assert().success();

    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].body, "grant_type=refresh_token&refresh_token=old-refresh&client_id=ff-cli");
    assert_eq!(requests[2].header("authorization"), Some("Bearer renewed-access"));
    let kept = credentials(&dir);
    assert!(kept.contains("access_token = \"renewed-access\"\nrefresh_token = \"renewed-refresh\"\n"), "{kept}");
    assert!(!kept.contains("2026-01-01T00:00:00Z"), "{kept}");
}

#[test]
fn a_token_far_from_its_end_is_used_as_it_is() {
    let api = Server::start(vec![Reply::json(200, user_me())]);
    let dir = logged_in(&api.url, "2999-01-01T00:00:00Z", false);

    ff(&dir).arg("whoami").assert().success();

    let requests = api.requests();
    assert_eq!((requests.len(), requests[0].header("authorization")), (1, Some("Bearer old-access")));
}

#[test]
fn a_renewal_refused_says_to_log_in_again_and_calls_nothing_else() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = logged_in(&url, "2026-01-01T00:00:00Z", false);
    let server = bound.serve(vec![
        discovery(&url),
        oauth_error("invalid_grant", "Offline user session not found"),
        Reply::json(200, user_me()),
    ]);

    ff(&dir).arg("whoami").assert().code(3).stderr(format!(
        "error: Your login has ended (the login at {url}/realms/ff answered invalid_grant, Offline user session not found): log in again with `ff login`\n"
    ));

    assert_eq!(server.requests().len(), 2);
}

#[test]
fn a_key_comes_before_the_login_so_a_login_on_a_profile_with_one_asks_to_replace_it() {
    let api = Server::start(vec![Reply::json(200, user_me())]);
    let dir = logged_in(&api.url, "2026-01-01T00:00:00Z", true);

    // The key is used, and the login, though ended, isn't renewed.
    ff(&dir).arg("whoami").assert().success();
    assert_eq!(api.requests()[0].header("authorization"), Some(format!("Bearer {KEY}").as_str()));

    ff(&dir).arg("login").assert().code(3).stderr(
        "error: Profile default holds an API key (ffk_0123456789ab_…), which ff uses before a login: `ff login --replace` \
         removes the key and logs in, or `ff login --profile <name>` logs in on another profile\n",
    );
    assert_eq!(api.requests().len(), 1);
}

#[test]
fn a_login_with_replace_removes_the_profiles_key() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = settings(
        &format!("[profiles.default]\nendpoint = \"{url}\"\n"),
        &format!("# mine\n[profiles.default]\ntoken = \"{KEY}\"\n"),
    );
    let _server = bound.serve(vec![
        place(&url),
        discovery(&url),
        device_code(&url),
        tokens("user-access", "user-refresh"),
        Reply::json(200, user_me()),
    ]);

    ff(&dir)
        .args(["login", "--replace"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("Logged in on profile default, in place of its API key, as:\n"));

    let kept = credentials(&dir);
    assert!(kept.starts_with("# mine\n[profiles.default]\nissuer = "), "{kept}");
    assert!(!kept.contains("ffk_"), "{kept}");
}

#[test]
fn ff_token_comes_before_the_login() {
    let api = Server::start(vec![Reply::json(200, user_me())]);
    let dir = logged_in(&api.url, "2026-01-01T00:00:00Z", false);

    ff(&dir).arg("whoami").env("FF_TOKEN", "from-the-environment").assert().success();

    assert_eq!(api.requests()[0].header("authorization"), Some("Bearer from-the-environment"));
}

#[test]
fn config_show_says_the_token_is_the_logins() {
    let dir = logged_in("https://api.ff.example", "2999-01-01T00:00:00Z", false);

    ff(&dir)
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains(format!("{:<12} {:<44} ff login", "token", "old-…")));
}

#[test]
fn a_development_api_has_no_login_and_an_older_one_doesnt_say() {
    for (answer, said) in [
        (
            Reply::json(200, json!({ "mode": "dev" })),
            "runs in development mode, with no login: name the account to act as with `ff config set dev_account <12 digits>`",
        ),
        (
            Reply::json(404, json!({ "statusCode": 404, "message": "Cannot GET /login" })),
            "doesn't say where to log in: it is older than this ff. An API key works with it: `ff config set-token`",
        ),
    ] {
        let api = Server::start(vec![answer]);
        let dir = settings(&format!("[profiles.default]\nendpoint = \"{}\"\n", api.url), "");

        ff(&dir).arg("login").assert().code(3).stderr(format!("error: The API at {} {said}\n", api.url));
    }
}

#[test]
fn a_login_elsewhere_in_plain_http_or_naming_another_issuer_is_refused() {
    let api = Server::start(vec![Reply::json(200, json!({ "mode": "oidc", "issuer": "http://login.lan/realms/ff" }))]);
    let dir = settings(&format!("[profiles.default]\nendpoint = \"{}\"\n", api.url), "");
    ff(&dir).arg("login").assert().code(3).stderr(predicate::str::starts_with(
        "error: http://login.lan/realms/ff is plain http, which would send your token unencrypted",
    ));

    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = profile(&bound);
    let _server = bound.serve(vec![
        place(&url),
        Reply::json(
            200,
            json!({ "issuer": "https://elsewhere/realms/ff", "token_endpoint": "https://elsewhere/token" }),
        ),
    ]);
    ff(&dir).arg("login").assert().code(3).stderr(format!(
        "error: The login at {url}/realms/ff calls itself https://elsewhere/realms/ff: its tokens wouldn't be the API's\n"
    ));
}

#[test]
fn a_logout_revokes_the_login_then_removes_its_tokens_and_keeps_the_rest() {
    let bound = Server::bind();
    let url = bound.url.clone();
    let dir = logged_in(&url, "2999-01-01T00:00:00Z", false);
    let server = bound.serve(vec![discovery(&url), Reply::text(200, "text/plain", "")]);

    ff(&dir).arg("logout").assert().success().stdout(format!(
        "Logged out of profile default: the login revoked at {url}/realms/ff, its tokens removed from {}\n",
        dir.path().join("credentials.toml").display()
    ));

    let requests = server.requests();
    assert_eq!(requests[1].path, "/realms/ff/protocol/openid-connect/revoke");
    assert_eq!(requests[1].body, "token=old-refresh&token_type_hint=refresh_token&client_id=ff-cli");
    assert_eq!(credentials(&dir), "[profiles.default]\n");
    ff(&dir).arg("logout").assert().success().stdout(predicate::str::starts_with("Profile default has no login ("));
    ff(&dir)
        .arg("whoami")
        .assert()
        .code(3)
        .stderr(predicate::str::contains("`ff login` logs you in with your browser"));
}

#[test]
fn a_logout_that_cant_revoke_keeps_the_login_unless_told_not_to_revoke() {
    let url = unreachable_url();
    let dir = logged_in(&url, "2999-01-01T00:00:00Z", true);
    let before = credentials(&dir);

    ff(&dir).arg("logout").assert().code(3).stderr(
        predicate::str::starts_with(format!(
            "error: Couldn't read the login's settings at {url}/realms/ff/.well-known/openid-configuration: "
        ))
        .and(predicate::str::ends_with(
            ". The login stays, for `ff logout` to try again; `ff logout --no-revoke` removes it without revoking it\n",
        )),
    );
    assert_eq!(credentials(&dir), before);

    ff(&dir).args(["logout", "--no-revoke"]).assert().success().stdout(predicate::str::ends_with(
        "without revoking the login, so a copy of them works until it goes unused for as long as its server allows\n\
         Profile default still holds an API key, which ff goes on using\n",
    ));
    assert_eq!(credentials(&dir), format!("[profiles.default]\ntoken = \"{KEY}\"\n"));
}
