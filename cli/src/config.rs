//! Where ff finds the API, the account and the token (ADR 0002): a flag first, then an
//! environment variable, then the profile in ff's files, then the default.
//!
//! The files are `config.toml`, the profiles' settings, and `credentials.toml`, their tokens,
//! readable by their owner only. Both hold `[profiles.<name>]` tables, and are rewritten keeping
//! the comments and order of what is already there.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Serialize, Serializer};
use toml_edit::{DocumentMut, Item, Table};
use ureq::http::Uri;

use crate::auth::Token;
use crate::cli::ConnectionArgs;
use crate::error::{Error, Kind};

pub const DEFAULT_ENDPOINT: &str = "http://localhost:3000";
pub const DEFAULT_PROFILE: &str = "default";

/// An account ID: 12 digits.
pub fn is_account_id(text: &str) -> bool {
    text.len() == 12 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// A profile's name: letters, digits, `-` and `_`, so it is a plain key in the files.
pub fn is_profile_name(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The API's address: `https://`, or `http://` for a development stack, a host, maybe a port and
/// a path, without a final slash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    url: String,
    host: String,
    https: bool,
}

impl Endpoint {
    pub fn parse(text: &str) -> Result<Endpoint, String> {
        let text = text.trim();
        let uri: Uri = text.parse().map_err(|_| format!("{text} isn't a URL, such as https://api.ff.example"))?;
        let https = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => return Err(format!("{text} must start with https://, or http:// for a development stack")),
        };
        let (Some(authority), Some(host)) = (uri.authority(), uri.host()) else {
            return Err(format!("{text} has no host"));
        };
        if authority.as_str().contains('@') {
            return Err(format!("{text} must not hold a user or password: the token says who you are"));
        }
        if uri.query().is_some() {
            return Err(format!("{text} must not have a query"));
        }
        let scheme = if https { "https" } else { "http" };
        let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        Ok(Endpoint { url: format!("{scheme}://{authority}{}", uri.path().trim_end_matches('/')), host, https })
    }

    pub fn as_str(&self) -> &str {
        &self.url
    }

    /// This machine: where plain http stays on the machine.
    pub fn is_local(&self) -> bool {
        matches!(self.host.as_str(), "localhost" | "127.0.0.1" | "::1")
    }

    /// Plain http would send the token in clear, so only to this machine, unless allowed.
    pub fn check_tls(&self, allow_http: bool) -> Result<(), String> {
        if self.https || allow_http || self.is_local() {
            return Ok(());
        }
        Err(format!(
            "{} is plain http, which would send your token unencrypted: use https://, or for a development stack, \
             --allow-http or `ff config set allow_http true`",
            self.url
        ))
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.url)
    }
}

/// Where a setting comes from, as `ff config show` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Flag(&'static str),
    Environment(&'static str),
    ConfigFile,
    CredentialsFile,
    Default,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Source::Flag(name) | Source::Environment(name) => f.write_str(name),
            Source::ConfigFile => f.write_str("config.toml"),
            Source::CredentialsFile => f.write_str("credentials.toml"),
            Source::Default => f.write_str("default"),
        }
    }
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Setting<T> {
    pub value: T,
    pub source: Source,
}

/// ff's folder: `FF_CONFIG_DIR`, else the system's configuration folder (`~/.config/ff` on
/// Linux, `~/Library/Application Support/ff` on macOS, `%APPDATA%\ff` on Windows).
#[derive(Clone, Debug)]
pub struct Files {
    pub dir: PathBuf,
}

impl Files {
    pub fn locate(env: &dyn Fn(&str) -> Option<String>) -> Result<Files, Error> {
        if let Some(dir) = env("FF_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
            return Ok(Files { dir: PathBuf::from(dir) });
        }
        let base = directories::BaseDirs::new().ok_or_else(|| {
            Error::new(Kind::Failed, "There is no home folder to keep ff's settings in: set FF_CONFIG_DIR")
        })?;
        Ok(Files { dir: base.config_dir().join("ff") })
    }

    pub fn config(&self) -> PathBuf {
        self.dir.join("config.toml")
    }

    pub fn credentials(&self) -> PathBuf {
        self.dir.join("credentials.toml")
    }
}

/// One of ff's files, `[profiles.<name>]` tables of settings.
pub struct ProfileFile {
    pub path: PathBuf,
    document: DocumentMut,
}

impl ProfileFile {
    /// The file, or an empty one when there is none yet.
    pub fn read(path: PathBuf) -> Result<ProfileFile, Error> {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(Error::new(Kind::Failed, format!("Couldn't read {}: {error}", path.display()))),
        };
        let document = text
            .parse::<DocumentMut>()
            .map_err(|error| Error::new(Kind::Failed, format!("{} isn't valid TOML: {error}", path.display())))?;
        Ok(ProfileFile { path, document })
    }

    fn profile(&self, name: &str) -> Option<&Table> {
        self.document.get("profiles")?.as_table()?.get(name)?.as_table()
    }

    pub fn has_profile(&self, name: &str) -> bool {
        self.profile(name).is_some()
    }

    pub fn string(&self, profile: &str, key: &str) -> Result<Option<String>, Error> {
        match self.profile(profile).and_then(|table| table.get(key)) {
            None => Ok(None),
            Some(item) => {
                item.as_str().map(|text| Some(text.to_owned())).ok_or_else(|| self.wrong_type(profile, key, "a string"))
            }
        }
    }

    pub fn boolean(&self, profile: &str, key: &str) -> Result<Option<bool>, Error> {
        match self.profile(profile).and_then(|table| table.get(key)) {
            None => Ok(None),
            Some(item) => item.as_bool().map(Some).ok_or_else(|| self.wrong_type(profile, key, "true or false")),
        }
    }

    fn wrong_type(&self, profile: &str, key: &str, expected: &str) -> Error {
        Error::new(Kind::Failed, format!("{} [profiles.{profile}]: {key} must be {expected}", self.path.display()))
    }

    pub fn set(&mut self, profile: &str, key: &str, value: impl Into<toml_edit::Value>) {
        let profiles = self.document.entry("profiles").or_insert_with(|| {
            let mut table = Table::new();
            table.set_implicit(true);
            Item::Table(table)
        });
        let table = profiles.as_table_mut().expect("profiles is a table, as read");
        let profile = table.entry(profile).or_insert_with(|| Item::Table(Table::new()));
        profile.as_table_mut().expect("a profile is a table, as read")[key] = Item::Value(value.into());
    }

    /// Whether the key was there.
    pub fn remove(&mut self, profile: &str, key: &str) -> bool {
        let table = self.document.get_mut("profiles").and_then(Item::as_table_mut);
        let profile = table.and_then(|table| table.get_mut(profile)).and_then(Item::as_table_mut);
        profile.is_some_and(|profile| profile.remove(key).is_some())
    }

    /// Written whole, through a file next to it renamed over it: never half written. A private
    /// file, the credentials, is readable by its owner only, in a folder only its owner opens.
    pub fn write(&self, private: bool) -> Result<(), Error> {
        let failed =
            |error: io::Error| Error::new(Kind::Failed, format!("Couldn't write {}: {error}", self.path.display()));
        let dir = self.path.parent().expect("a file in a folder");
        create_private_dir(dir).map_err(failed)?;
        let temporary = self.path.with_extension("toml.new");
        let mut file = new_file(&temporary, private).map_err(failed)?;
        file.write_all(self.document.to_string().as_bytes()).map_err(failed)?;
        file.sync_all().map_err(failed)?;
        fs::rename(&temporary, &self.path).map_err(failed)
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn new_file(path: &Path, private: bool) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(if private { 0o600 } else { 0o644 }).open(path)
}

#[cfg(not(unix))]
fn new_file(path: &Path, _private: bool) -> io::Result<fs::File> {
    fs::File::create(path)
}

/// A warning when others than its owner may read the credentials, as ssh gives for a key.
#[cfg(unix)]
fn exposed(path: &Path) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path).ok()?.permissions().mode();
    (mode & 0o077 != 0).then(|| {
        format!(
            "{} can be read by others than you (mode {:o}): chmod 600 {}",
            path.display(),
            mode & 0o777,
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn exposed(_path: &Path) -> Option<String> {
    None
}

/// The settings in effect, each with where it comes from.
#[derive(Debug)]
pub struct Settings {
    pub profile: Setting<String>,
    pub endpoint: Setting<Endpoint>,
    pub account: Option<Setting<String>>,
    pub dev_account: Option<Setting<String>>,
    pub token: Option<Setting<Token>>,
    pub allow_http: Setting<bool>,
    pub files: Files,
    /// What the files' owner should fix, printed before the command's output.
    pub warnings: Vec<String>,
}

/// The first of a flag, an environment variable, and the profile's value.
fn first(
    flag: Option<(&str, &'static str)>,
    env: &dyn Fn(&str) -> Option<String>,
    variable: &'static str,
    profile: Option<String>,
) -> Option<Setting<String>> {
    if let Some((value, name)) = flag {
        return Some(Setting { value: value.to_owned(), source: Source::Flag(name) });
    }
    if let Some(value) = env(variable).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()) {
        return Some(Setting { value, source: Source::Environment(variable) });
    }
    profile.map(|value| Setting { value, source: Source::ConfigFile })
}

fn account_setting(setting: Option<Setting<String>>, what: &str) -> Result<Option<Setting<String>>, Error> {
    match setting {
        Some(setting) if !is_account_id(&setting.value) => Err(Error::new(
            Kind::Failed,
            format!("The {what} from {} must be an account ID, 12 digits: {}", setting.source, setting.value),
        )),
        setting => Ok(setting),
    }
}

/// The settings from the flags, the environment and the files, in that order.
pub fn resolve(
    flags: &ConnectionArgs,
    env: &dyn Fn(&str) -> Option<String>,
    config: &ProfileFile,
    credentials: &ProfileFile,
    files: Files,
) -> Result<Settings, Error> {
    let profile = first(flags.profile.as_deref().map(|value| (value, "--profile")), env, "FF_PROFILE", None)
        .unwrap_or(Setting { value: DEFAULT_PROFILE.to_owned(), source: Source::Default });
    if !is_profile_name(&profile.value) {
        return Err(Error::new(
            Kind::Failed,
            format!("The profile from {} must be letters, digits, '-' and '_': {}", profile.source, profile.value),
        ));
    }
    let name = profile.value.as_str();
    if profile.source != Source::Default && !config.has_profile(name) && !credentials.has_profile(name) {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "There is no profile {name} in {}: `ff config set endpoint <URL> --profile {name}` makes one",
                config.path.display()
            ),
        ));
    }

    let endpoint = first(
        flags.endpoint.as_deref().map(|value| (value, "--endpoint")),
        env,
        "FF_ENDPOINT",
        config.string(name, "endpoint")?,
    )
    .unwrap_or(Setting { value: DEFAULT_ENDPOINT.to_owned(), source: Source::Default });
    let endpoint = Setting {
        value: Endpoint::parse(&endpoint.value)
            .map_err(|problem| Error::new(Kind::Failed, format!("The endpoint from {}: {problem}", endpoint.source)))?,
        source: endpoint.source,
    };

    let allow_http = if flags.allow_http {
        Setting { value: true, source: Source::Flag("--allow-http") }
    } else {
        match config.boolean(name, "allow_http")? {
            Some(value) => Setting { value, source: Source::ConfigFile },
            None => Setting { value: false, source: Source::Default },
        }
    };
    endpoint.value.check_tls(allow_http.value).map_err(|problem| Error::new(Kind::Failed, problem))?;

    let account = account_setting(
        first(
            flags.account.as_deref().map(|value| (value, "--account")),
            env,
            "FF_ACCOUNT",
            config.string(name, "account")?,
        ),
        "account",
    )?;
    let dev_account = account_setting(
        config.string(name, "dev_account")?.map(|value| Setting { value, source: Source::ConfigFile }),
        "dev_account",
    )?;

    let mut warnings = Vec::new();
    let token = match env("FF_TOKEN").and_then(|value| Token::new(&value)) {
        Some(token) => Some(Setting { value: token, source: Source::Environment("FF_TOKEN") }),
        None => match credentials.string(name, "token")? {
            Some(value) => {
                warnings.extend(exposed(&credentials.path));
                Token::new(&value).map(|token| Setting { value: token, source: Source::CredentialsFile })
            }
            None => None,
        },
    };

    Ok(Settings { profile, endpoint, account, dev_account, token, allow_http, files, warnings })
}

/// The settings in effect for this process: its flags, its environment, its files.
pub fn load(flags: &ConnectionArgs) -> Result<Settings, Error> {
    let env = |name: &str| std::env::var(name).ok();
    let files = Files::locate(&env)?;
    let config = ProfileFile::read(files.config())?;
    let credentials = ProfileFile::read(files.credentials())?;
    resolve(flags, &env, &config, &credentials, files)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const KEY: &str = "ffk_0123456789ab_sssssssssssssssssssssssssssssssssssssssssss";

    fn file(text: &str) -> ProfileFile {
        ProfileFile { path: PathBuf::from("/home/me/.config/ff/config.toml"), document: text.parse().unwrap() }
    }

    fn resolve_with(
        flags: ConnectionArgs,
        env: &[(&str, &str)],
        config: &str,
        credentials: &str,
    ) -> Result<Settings, Error> {
        let env: HashMap<String, String> =
            env.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        let lookup = move |name: &str| env.get(name).cloned();
        resolve(&flags, &lookup, &file(config), &file(credentials), Files { dir: PathBuf::from("/home/me/.config/ff") })
    }

    const PROFILES: &str = "[profiles.default]\nendpoint = \"https://api.ff.example\"\naccount = \"111111111111\"\n\n\
        [profiles.staging]\nendpoint = \"https://staging.ff.example/api/\"\n";

    #[test]
    fn a_flag_wins_over_the_environment_which_wins_over_the_profile_then_the_default() {
        let flags = ConnectionArgs { endpoint: Some("https://flag.ff.example".into()), ..Default::default() };
        let env = [("FF_ENDPOINT", "https://env.ff.example"), ("FF_ACCOUNT", "222222222222")];

        let from_flag = resolve_with(flags, &env, PROFILES, "").unwrap();
        let from_env = resolve_with(ConnectionArgs::default(), &env, PROFILES, "").unwrap();
        let from_profile = resolve_with(ConnectionArgs::default(), &[], PROFILES, "").unwrap();
        let default = resolve_with(ConnectionArgs::default(), &[], "", "").unwrap();

        let endpoint = |settings: &Settings| (settings.endpoint.value.to_string(), settings.endpoint.source);
        assert_eq!(endpoint(&from_flag), ("https://flag.ff.example".into(), Source::Flag("--endpoint")));
        assert_eq!(endpoint(&from_env), ("https://env.ff.example".into(), Source::Environment("FF_ENDPOINT")));
        assert_eq!(endpoint(&from_profile), ("https://api.ff.example".into(), Source::ConfigFile));
        assert_eq!(endpoint(&default), ("http://localhost:3000".into(), Source::Default));
        assert_eq!(from_env.account.map(|account| account.value), Some("222222222222".into()));
        assert_eq!(
            from_profile.account.map(|account| (account.value, account.source)),
            Some(("111111111111".into(), Source::ConfigFile))
        );
        assert_eq!(default.account, None);
    }

    #[test]
    fn the_profile_comes_from_the_flag_or_ff_profile_and_must_exist_once_named() {
        let named = resolve_with(ConnectionArgs::default(), &[("FF_PROFILE", "staging")], PROFILES, "").unwrap();
        assert_eq!(
            (named.profile.value.as_str(), named.profile.source),
            ("staging", Source::Environment("FF_PROFILE"))
        );
        assert_eq!(named.endpoint.value.as_str(), "https://staging.ff.example/api");

        let flags = ConnectionArgs { profile: Some("prod".into()), ..Default::default() };
        let missing = resolve_with(flags, &[], PROFILES, "").unwrap_err();
        assert_eq!(
            missing.message,
            "There is no profile prod in /home/me/.config/ff/config.toml: `ff config set endpoint <URL> --profile prod` makes one"
        );
        assert_eq!(missing.exit_code(), 3);
    }

    #[test]
    fn the_token_comes_from_ff_token_or_the_profiles_credentials_never_from_a_flag() {
        let credentials = format!("[profiles.default]\ntoken = \"{KEY}\"\n");

        let saved = resolve_with(ConnectionArgs::default(), &[], "", &credentials).unwrap().token.unwrap();
        let from_env =
            resolve_with(ConnectionArgs::default(), &[("FF_TOKEN", " eyJhbGciOi.user.token \n")], "", &credentials)
                .unwrap()
                .token
                .unwrap();

        assert_eq!((saved.value.secret(), saved.source), (KEY, Source::CredentialsFile));
        assert_eq!(
            (from_env.value.secret(), from_env.source),
            ("eyJhbGciOi.user.token", Source::Environment("FF_TOKEN"))
        );
        assert!(resolve_with(ConnectionArgs::default(), &[], "", "").unwrap().token.is_none());
    }

    #[test]
    fn plain_http_goes_only_to_this_machine_unless_allowed() {
        for local in ["http://localhost:3000", "http://127.0.0.1:3000/", "http://[::1]:3000"] {
            let flags = ConnectionArgs { endpoint: Some(local.into()), ..Default::default() };
            assert!(resolve_with(flags, &[], "", "").is_ok(), "{local}");
        }

        let remote = || ConnectionArgs { endpoint: Some("http://ff.lan:3000".into()), ..Default::default() };
        let refused = resolve_with(remote(), &[], "", "").unwrap_err();
        assert!(
            refused.message.starts_with("http://ff.lan:3000 is plain http, which would send your token unencrypted")
        );
        assert!(resolve_with(ConnectionArgs { allow_http: true, ..remote() }, &[], "", "").is_ok());
        assert!(resolve_with(remote(), &[], "[profiles.default]\nallow_http = true\n", "").is_ok());
    }

    #[test]
    fn an_endpoint_is_an_http_or_https_url_with_a_host_and_no_user_or_query() {
        assert_eq!(
            Endpoint::parse("https://API.ff.example:8443/v1/").unwrap().as_str(),
            "https://API.ff.example:8443/v1"
        );
        assert_eq!(
            Endpoint::parse("ff.example").unwrap_err(),
            "ff.example must start with https://, or http:// for a development stack"
        );
        assert_eq!(
            Endpoint::parse("ftp://ff.example").unwrap_err(),
            "ftp://ff.example must start with https://, or http:// for a development stack"
        );
        assert!(
            Endpoint::parse("https://me:secret@ff.example").unwrap_err().contains("must not hold a user or password")
        );
        assert!(Endpoint::parse("https://ff.example/?x=1").unwrap_err().contains("must not have a query"));
        assert!(Endpoint::parse("https://").is_err());
    }

    #[test]
    fn accounts_from_the_environment_or_a_profile_must_be_account_ids() {
        let refused = resolve_with(ConnectionArgs::default(), &[("FF_ACCOUNT", "acme")], "", "").unwrap_err();
        assert_eq!(refused.message, "The account from FF_ACCOUNT must be an account ID, 12 digits: acme");

        let dev =
            resolve_with(ConnectionArgs::default(), &[], "[profiles.default]\ndev_account = \"123456789012\"\n", "")
                .unwrap();
        assert_eq!(dev.dev_account.map(|account| account.value), Some("123456789012".into()));
        let wrong =
            resolve_with(ConnectionArgs::default(), &[], "[profiles.default]\ndev_account = 12\n", "").unwrap_err();
        assert_eq!(wrong.message, "/home/me/.config/ff/config.toml [profiles.default]: dev_account must be a string");
    }

    #[test]
    fn a_file_is_changed_keeping_its_comments_and_other_profiles() {
        let mut config =
            file("# my settings\n[profiles.staging]\nendpoint = \"https://staging.ff.example\" # theirs\n");

        config.set("default", "endpoint", "https://api.ff.example");
        config.set("default", "allow_http", false);
        assert!(config.remove("staging", "endpoint"));
        assert!(!config.remove("staging", "endpoint"));

        assert_eq!(
            config.document.to_string(),
            "# my settings\n[profiles.staging]\n\n[profiles.default]\nendpoint = \"https://api.ff.example\"\nallow_http = false\n"
        );
        assert_eq!(file("").document.to_string(), "");
        let mut empty = file("");
        empty.set("default", "account", "123456789012");
        assert_eq!(empty.document.to_string(), "[profiles.default]\naccount = \"123456789012\"\n");
    }
}
