//! `ff login` and `ff logout`: a user's login with the browser, kept for the profile in credentials.toml after its
//! API key, if it has one, so that a key given to a script or a CI keeps working.

use std::io::{self, IsTerminal};
use std::process::{Command, Stdio};
use std::thread;
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::json;

use super::{Context, whoami};
use crate::api::{Call, Client};
use crate::auth::Token;
use crate::config::{Endpoint, ProfileFile, Source};
use crate::error::{Error, Kind};
use crate::login::{self, Issuer, Login};
use crate::progress::Progress;

/// Where the API's login is, as `GET /login` says.
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum Place {
    Oidc { issuer: String },
    Dev,
}

pub fn login(replace: bool, no_browser: bool, context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let profile = settings.profile.value.clone();
    let mut credentials = ProfileFile::read(settings.files.credentials())?;
    if let Some(key) = credentials.string(&profile, "token")?
        && !replace
    {
        let key = Token::new(&key).map(|key| key.masked()).unwrap_or_default();
        return Err(Error::new(
            Kind::Failed,
            format!(
                "Profile {profile} holds an API key ({key}), which ff uses before a login: `ff login --replace` removes \
                 the key and logs in, or `ff login --profile <name>` logs in on another profile"
            ),
        ));
    }

    let issuer = Issuer::discover(&issuer_of(&settings)?)?;
    let authorization = issuer.start()?;
    let address = authorization.verification_uri_complete.as_deref().unwrap_or(&authorization.verification_uri);
    let opened = !no_browser && can_open_browser() && open_browser(address);
    // Said whatever the output's format: the login can't go on without the user.
    let code = &authorization.user_code;
    eprintln!(
        "{}",
        match (opened, authorization.verification_uri_complete.is_some()) {
            (true, _) => format!(
                "Your browser opened {address}: check that it shows the code {code}, then sign in and approve this device."
            ),
            (false, true) => format!(
                "Open {address} in a browser: check that it shows the code {code}, then sign in and approve this device."
            ),
            (false, false) => {
                format!("Open {address} in a browser, type the code {code}, then sign in and approve this device.")
            }
        }
    );
    let progress = Progress::start(context.out, "Waiting for your approval");
    let tokens = login::wait(&authorization, || issuer.poll(&authorization.device_code), thread::sleep);
    progress.stop();
    let login = Login::from_tokens(issuer.url(), tokens?, None, SystemTime::now())?;

    // The API takes the new token before it is kept.
    let (answer, me) = whoami::ask(&Client::with_token(&settings, Some(&login.access_token)))?;
    let key_removed = replace && credentials.remove(&profile, "token");
    login.write_to(&mut credentials, &profile);
    credentials.write(true)?;
    if settings.token.as_ref().is_some_and(|token| matches!(token.source, Source::Environment(_))) {
        context.out.warn("FF_TOKEN is set, and ff uses it before the login: unset it for ff to use the login");
    }
    let document = json!({
        "profile": profile,
        "file": credentials.path,
        "issuer": login.issuer,
        "apiKeyRemoved": key_removed,
        "me": answer,
    });
    context.out.result(&document, || {
        let removed = if key_removed { ", in place of its API key" } else { "" };
        format!("Logged in on profile {profile}{removed}, as:\n{}", whoami::text(&me, &settings))
    })
}

/// The realm the API takes tokens from, as it says: its address checked as the API's is, https unless allowed.
fn issuer_of(settings: &crate::config::Settings) -> Result<String, Error> {
    let api = &settings.endpoint.value;
    let place = Client::with_token(settings, None).json::<Place>(&Call::get("/login")).map_err(|error| {
        if error.status == Some(404) {
            Error::new(
                Kind::Failed,
                format!(
                    "The API at {api} doesn't say where to log in: it is older than this ff. An API key works with \
                     it: `ff config set-token`"
                ),
            )
        } else {
            error
        }
    })?;
    let issuer = match place {
        Place::Oidc { issuer } => issuer,
        Place::Dev => {
            return Err(Error::new(
                Kind::Failed,
                format!(
                    "The API at {api} runs in development mode, with no login: name the account to act as with \
                     `ff config set dev_account <12 digits>`"
                ),
            ));
        }
    };
    let issuer = Endpoint::parse(&issuer)
        .map_err(|problem| Error::new(Kind::Failed, format!("The API names a login ff can't use: {problem}")))?;
    issuer.check_tls(settings.allow_http.value).map_err(|problem| Error::new(Kind::Failed, problem))?;
    Ok(issuer.as_str().to_owned())
}

pub fn logout(no_revoke: bool, context: &Context) -> Result<(), Error> {
    let (profile, files) = super::config::target(context)?;
    let mut credentials = ProfileFile::read(files.credentials())?;
    let login = match Login::read(&credentials, &profile) {
        Ok(Some(login)) => Some(login),
        Ok(None) => {
            let document =
                json!({ "profile": profile, "file": credentials.path, "loggedOut": false, "revoked": false });
            return context
                .out
                .result(&document, || format!("Profile {profile} has no login ({})", credentials.path.display()));
        }
        // What can't be read can't be revoked: it is removed.
        Err(broken) => {
            context.out.warn(&broken.message);
            None
        }
    };
    let revoked = match &login {
        Some(login) if !no_revoke => {
            Issuer::discover(&login.issuer).and_then(|issuer| issuer.revoke(&login.refresh_token)).map_err(|error| {
                Error::new(
                    error.kind,
                    format!(
                        "{}. The login stays, for `ff logout` to try again; `ff logout --no-revoke` removes it without \
                         revoking it",
                        error.message
                    ),
                )
            })?;
            true
        }
        _ => false,
    };
    Login::remove_from(&mut credentials, &profile);
    credentials.write(true)?;
    let key_kept = credentials.string(&profile, "token")?.is_some();
    let document = json!({
        "profile": profile,
        "file": credentials.path,
        "loggedOut": true,
        "revoked": revoked,
        "issuer": login.as_ref().map(|login| &login.issuer),
    });
    context.out.result(&document, || {
        let file = credentials.path.display();
        let mut text = match &login {
            Some(login) if revoked => {
                format!("Logged out of profile {profile}: the login revoked at {}, its tokens removed from {file}", login.issuer)
            }
            _ => format!(
                "Logged out of profile {profile}: its tokens removed from {file}, without revoking the login, so a copy \
                 of them works until it goes unused for as long as its server allows"
            ),
        };
        if key_kept {
            text.push_str(&format!("\nProfile {profile} still holds an API key, which ff goes on using"));
        }
        text
    })
}

/// Whether a browser can show the address here: a person at the terminal, and on Linux and the BSDs, a display.
fn can_open_browser() -> bool {
    if !io::stdin().is_terminal() {
        return false;
    }
    cfg!(any(target_os = "macos", windows))
        || ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// The address opened in the default browser by the system's own command, given it as one argument and through no
/// shell, since the realm chose it: whether the command started.
fn open_browser(address: &str) -> bool {
    let web = address.starts_with("https://") || address.starts_with("http://");
    if !web || address.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        Command::new("xdg-open")
    };
    match command.arg(address).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(mut child) => {
            // Waited for aside, so that it ends while the login waits for the user.
            thread::spawn(move || child.wait());
            true
        }
        Err(_) => false,
    }
}
