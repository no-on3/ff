//! `ff config set|unset|show|set-token`: the profile's settings in `config.toml`, its token in
//! `credentials.toml`.

use std::io::{self, IsTerminal, Read};

use serde::Serialize;
use serde_json::json;

use super::Context;
use crate::auth::Token;
use crate::cli::{ConfigCommand, ConfigKey};
use crate::config::{self, Endpoint, Files, ProfileFile, Setting, Source};
use crate::error::{Error, Kind};

pub fn run(command: ConfigCommand, context: &Context) -> Result<(), Error> {
    match command {
        ConfigCommand::Set { key, value } => set(context, key, &value),
        ConfigCommand::Unset { key } => unset(context, key),
        ConfigCommand::Show => show(context),
        ConfigCommand::SetToken => set_token(context),
    }
}

/// The profile a change goes to, and ff's folder: a new profile is made by its first setting.
fn target(context: &Context) -> Result<(String, Files), Error> {
    let env = |name: &str| std::env::var(name).ok();
    let profile = match &context.connection.profile {
        Some(profile) => profile.clone(),
        None => env("FF_PROFILE")
            .filter(|profile| !profile.is_empty())
            .unwrap_or_else(|| config::DEFAULT_PROFILE.to_owned()),
    };
    if !config::is_profile_name(&profile) {
        return Err(Error::new(Kind::Usage, format!("FF_PROFILE must be letters, digits, '-' and '_': {profile}")));
    }
    Ok((profile, Files::locate(&env)?))
}

fn usage(message: impl Into<String>) -> Error {
    Error::new(Kind::Usage, message)
}

fn set(context: &Context, key: ConfigKey, value: &str) -> Result<(), Error> {
    let (profile, files) = target(context)?;
    let mut file = ProfileFile::read(files.config())?;
    let value = value.trim();
    let saved = match key {
        ConfigKey::Endpoint => {
            let endpoint = Endpoint::parse(value).map_err(usage)?;
            let allowed = context.connection.allow_http || file.boolean(&profile, "allow_http")?.unwrap_or(false);
            endpoint.check_tls(allowed).map_err(usage)?;
            file.set(&profile, "endpoint", endpoint.as_str());
            serde_json::Value::from(endpoint.as_str())
        }
        ConfigKey::Account | ConfigKey::DevAccount => {
            if !config::is_account_id(value) {
                return Err(usage(format!("{} must be an account ID, 12 digits: {value}", key.name())));
            }
            file.set(&profile, key.name(), value);
            serde_json::Value::from(value)
        }
        ConfigKey::AllowHttp => {
            let allowed = match value {
                "true" => true,
                "false" => false,
                _ => return Err(usage(format!("allow_http is true or false: {value}"))),
            };
            file.set(&profile, "allow_http", allowed);
            serde_json::Value::from(allowed)
        }
        ConfigKey::Token => {
            return Err(usage(
                "A token on the command line would stay in your shell's history: `ff config set-token` reads it from a prompt or stdin",
            ));
        }
    };
    file.write(false)?;
    let document = json!({ "profile": profile, "key": key.name(), "value": saved, "file": file.path });
    let shown = saved.as_str().map(str::to_owned).unwrap_or_else(|| saved.to_string());
    context.out.result(&document, || format!("{} = {shown} in profile {profile} ({})", key.name(), file.path.display()))
}

fn unset(context: &Context, key: ConfigKey) -> Result<(), Error> {
    let (profile, files) = target(context)?;
    let (path, private) = if key == ConfigKey::Token { (files.credentials(), true) } else { (files.config(), false) };
    let mut file = ProfileFile::read(path)?;
    let removed = file.remove(&profile, key.name());
    if removed {
        file.write(private)?;
    }
    let document = json!({ "profile": profile, "key": key.name(), "removed": removed, "file": file.path });
    context.out.result(&document, || {
        if removed {
            format!("{} removed from profile {profile} ({})", key.name(), file.path.display())
        } else {
            format!("Profile {profile} has no {} ({})", key.name(), file.path.display())
        }
    })
}

/// A setting as `ff config show` gives it: its value and where it comes from.
#[derive(Serialize)]
struct Shown<T: Serialize> {
    value: T,
    source: Source,
}

fn shown<T, U: Serialize>(setting: &Option<Setting<T>>, value: impl Fn(&T) -> U) -> Option<Shown<U>> {
    setting.as_ref().map(|setting| Shown { value: value(&setting.value), source: setting.source })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Show {
    profile: Shown<String>,
    endpoint: Shown<String>,
    account: Option<Shown<String>>,
    dev_account: Option<Shown<String>>,
    token: Option<Shown<String>>,
    allow_http: Shown<bool>,
    config_file: String,
    credentials_file: String,
}

fn show(context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let show = Show {
        profile: Shown { value: settings.profile.value.clone(), source: settings.profile.source },
        endpoint: Shown { value: settings.endpoint.value.to_string(), source: settings.endpoint.source },
        account: shown(&settings.account, String::clone),
        dev_account: shown(&settings.dev_account, String::clone),
        token: shown(&settings.token, Token::masked),
        allow_http: Shown { value: settings.allow_http.value, source: settings.allow_http.source },
        config_file: settings.files.config().display().to_string(),
        credentials_file: settings.files.credentials().display().to_string(),
    };
    context.out.result(&show, || {
        let line = |name: &str, value: Option<(String, Source)>| match value {
            Some((value, source)) => format!("{name:<12} {value:<44} {source}"),
            None => format!("{name:<12} -"),
        };
        [
            line("profile", Some((show.profile.value.clone(), show.profile.source))),
            line("endpoint", Some((show.endpoint.value.clone(), show.endpoint.source))),
            line("account", show.account.as_ref().map(|shown| (shown.value.clone(), shown.source))),
            line("dev_account", show.dev_account.as_ref().map(|shown| (shown.value.clone(), shown.source))),
            line("token", show.token.as_ref().map(|shown| (shown.value.clone(), shown.source))),
            line("allow_http", Some((show.allow_http.value.to_string(), show.allow_http.source))),
            format!("{:<12} {}", "files", show.config_file),
            format!("{:<12} {}", "", show.credentials_file),
        ]
        .join("\n")
    })
}

/// The key from a prompt that doesn't echo it in a terminal, else the first line of stdin.
fn read_key() -> Result<String, Error> {
    if io::stdin().is_terminal() {
        return rpassword::prompt_password("API key (not shown as you type or paste it): ")
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read the key: {error}")));
    }
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't read the key from stdin: {error}")))?;
    Ok(text.lines().next().unwrap_or("").to_owned())
}

fn set_token(context: &Context) -> Result<(), Error> {
    let (profile, files) = target(context)?;
    let key = Token::api_key(&read_key()?).map_err(usage)?;
    let mut file = ProfileFile::read(files.credentials())?;
    file.set(&profile, "token", key.secret());
    file.write(true)?;
    let document = json!({ "profile": profile, "token": key.masked(), "file": file.path });
    context.out.result(&document, || {
        format!("Saved the API key {} for profile {profile} ({})", key.masked(), file.path.display())
    })
}
