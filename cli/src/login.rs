//! A user's login (ADR 0002): OAuth's device flow (RFC 8628) against the realm's `ff-cli` client, the realm's
//! endpoints read from its discovery document; the tokens kept under the profile in `credentials.toml`; the access
//! token renewed before a call when it is about to end; and the login revoked (RFC 7009) at the logout.

use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use ureq::Agent;
use ureq::http::Response;

use crate::api::agent_config;
use crate::auth::Token;
use crate::config::{ProfileFile, Settings};
use crate::error::{Error, Kind};

/// The realm's client for `ff`: public, with the device flow, its tokens for the API.
pub const CLIENT_ID: &str = "ff-cli";
/// `offline_access`: a login that lasts while it is used. Without it, a login ends with the realm's session, after
/// 30 minutes unused and 10 hours at most.
const SCOPE: &str = "openid offline_access";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// RFC 8628, 3.5: each `slow_down` adds five seconds to the interval.
const SLOW_DOWN: Duration = Duration::from_secs(5);
/// RFC 8628, 3.2: the interval when the realm gives none.
const DEFAULT_INTERVAL: u64 = 5;
/// A call made within this of the access token's end renews it first.
const RENEW_BEFORE: Duration = Duration::from_secs(60);
/// How long a call to the realm waits for its answer.
const TIMEOUT: Duration = Duration::from_secs(30);
/// A login's keys in its profile of credentials.toml.
const KEYS: [&str; 4] = ["issuer", "access_token", "refresh_token", "expires_at"];

/// A login's tokens, as credentials.toml keeps them under the profile.
#[derive(Clone, Debug)]
pub struct Login {
    /// The realm that gave them, where they are renewed and revoked.
    pub issuer: String,
    pub access_token: Token,
    pub refresh_token: Token,
    /// When the access token ends.
    pub expires_at: SystemTime,
}

impl Login {
    /// The profile's login, when it has one.
    pub fn read(file: &ProfileFile, profile: &str) -> Result<Option<Login>, Error> {
        let Some(access_token) = file.string(profile, "access_token")? else { return Ok(None) };
        let broken = |problem: String| {
            Error::new(
                Kind::Failed,
                format!("{} [profiles.{profile}]: {problem}: log in again with `ff login`", file.path.display()),
            )
        };
        let value = |key: &str| {
            file.string(profile, key)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| broken(format!("the login has no {key}")))
        };
        let issuer = value("issuer")?;
        let refresh_token = value("refresh_token")?;
        let expires_at = value("expires_at")?;
        let expires_at = humantime::parse_rfc3339(&expires_at)
            .map_err(|_| broken(format!("expires_at must be a time such as 2026-11-09T12:00:00Z, not {expires_at}")))?;
        let token =
            |text: &str, key: &str| Token::new(text).ok_or_else(|| broken(format!("the login's {key} is empty")));
        Ok(Some(Login {
            issuer,
            access_token: token(&access_token, "access_token")?,
            refresh_token: token(&refresh_token, "refresh_token")?,
            expires_at,
        }))
    }

    /// The realm's tokens, received at `now`: a renewal that gives no refresh token keeps the one it was given.
    pub fn from_tokens(issuer: &str, tokens: Tokens, kept: Option<&Token>, now: SystemTime) -> Result<Login, Error> {
        let missing = |what: &str| Error::new(Kind::Failed, format!("The login at {issuer} gave no {what}"));
        let refresh_token = match tokens.refresh_token.as_deref().and_then(Token::new) {
            Some(token) => token,
            None => kept.cloned().ok_or_else(|| missing("refresh token"))?,
        };
        Ok(Login {
            issuer: issuer.to_owned(),
            access_token: Token::new(&tokens.access_token).ok_or_else(|| missing("access token"))?,
            refresh_token,
            expires_at: now + Duration::from_secs(tokens.expires_in),
        })
    }

    /// Kept under the profile, in place of an earlier login's.
    pub fn write_to(&self, file: &mut ProfileFile, profile: &str) {
        file.set(profile, "issuer", self.issuer.as_str());
        file.set(profile, "access_token", self.access_token.secret());
        file.set(profile, "refresh_token", self.refresh_token.secret());
        file.set(profile, "expires_at", humantime::format_rfc3339_seconds(self.expires_at).to_string());
    }

    /// Removed from the profile: whether it had one.
    pub fn remove_from(file: &mut ProfileFile, profile: &str) -> bool {
        KEYS.iter().fold(false, |removed, key| file.remove(profile, key) || removed)
    }

    /// Whether a call made at `now` renews the access token first.
    pub fn is_due(&self, now: SystemTime) -> bool {
        self.expires_at <= now + RENEW_BEFORE
    }
}

/// The token a call carries: the settings', or a login's renewed first when it ends within a minute, the renewed
/// tokens kept for the next commands. A renewal refused says to log in again, and nothing else is tried.
pub fn token_for_call(settings: &Settings) -> Result<Option<Token>, Error> {
    let Some(login) = &settings.login else {
        return Ok(settings.token.as_ref().map(|token| token.value.clone()));
    };
    if !login.is_due(SystemTime::now()) {
        return Ok(Some(login.access_token.clone()));
    }
    let tokens = Issuer::discover(&login.issuer)?.renew(&login.refresh_token)?;
    let renewed = Login::from_tokens(&login.issuer, tokens, Some(&login.refresh_token), SystemTime::now())?;
    let mut file = ProfileFile::read(settings.files.credentials())?;
    renewed.write_to(&mut file, &settings.profile.value);
    file.write(true)?;
    Ok(Some(renewed.access_token))
}

/// The endpoints the login uses, as the realm's discovery document names them.
#[derive(Debug, Deserialize)]
struct Endpoints {
    issuer: String,
    device_authorization_endpoint: Option<String>,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
}

/// What the device endpoint answers: the code the user checks, where, and how long it lasts.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// The address with the code in it, so that the page doesn't ask for it.
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    DEFAULT_INTERVAL
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    /// The access token's life, in seconds.
    pub expires_in: u64,
    pub refresh_token: Option<String>,
}

/// One poll's answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    /// Not approved yet: poll again after the interval.
    Pending,
    /// Polled too often: the interval grows by five seconds.
    SlowDown,
    /// The code ran out of time.
    Expired,
    /// The user said no.
    Denied,
    Approved(Tokens),
}

/// Why the realm's answer isn't the one asked for.
enum Failure {
    /// OAuth's error: its code and description.
    Refused { code: String, description: Option<String> },
    /// No answer, or one that isn't OAuth's.
    Broken(String),
}

impl Failure {
    fn text(&self) -> String {
        match self {
            Failure::Refused { code, description: Some(description) } => format!("{code}, {description}"),
            Failure::Refused { code, description: None } => code.clone(),
            Failure::Broken(problem) => problem.clone(),
        }
    }
}

/// The realm, at its issuer's address, such as `https://login.ff.example/realms/ff`.
pub struct Issuer {
    agent: Agent,
    url: String,
    endpoints: Endpoints,
}

impl Issuer {
    /// Its endpoints, from `/.well-known/openid-configuration`, which must name the issuer it is at.
    pub fn discover(url: &str) -> Result<Issuer, Error> {
        let agent: Agent = agent_config().timeout_global(Some(TIMEOUT)).build().into();
        let document = format!("{url}/.well-known/openid-configuration");
        let endpoints: Endpoints = read(agent.get(&document).call()).map_err(|failure| {
            Error::new(Kind::Failed, format!("Couldn't read the login's settings at {document}: {}", failure.text()))
        })?;
        if endpoints.issuer != url {
            return Err(Error::new(
                Kind::Failed,
                format!("The login at {url} calls itself {}: its tokens wouldn't be the API's", endpoints.issuer),
            ));
        }
        Ok(Issuer { agent, url: url.to_owned(), endpoints })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// A code for this device, which the user approves in a browser.
    pub fn start(&self) -> Result<DeviceAuthorization, Error> {
        let endpoint = self.endpoints.device_authorization_endpoint.as_deref().ok_or_else(|| {
            Error::new(
                Kind::Failed,
                format!("The login at {} offers no device flow: its settings name no device endpoint", self.url),
            )
        })?;
        read(self.agent.post(endpoint).send_form([("client_id", CLIENT_ID), ("scope", SCOPE)]))
            .map_err(|failure| self.failed("refused to start the login", &failure))
    }

    /// Asks once whether the user has approved.
    pub fn poll(&self, device_code: &str) -> Result<Poll, Error> {
        let form = [("grant_type", DEVICE_GRANT), ("device_code", device_code), ("client_id", CLIENT_ID)];
        match read(self.agent.post(&self.endpoints.token_endpoint).send_form(form)) {
            Ok(tokens) => Ok(Poll::Approved(tokens)),
            Err(Failure::Refused { code, .. }) if code == "authorization_pending" => Ok(Poll::Pending),
            Err(Failure::Refused { code, .. }) if code == "slow_down" => Ok(Poll::SlowDown),
            Err(Failure::Refused { code, .. }) if code == "expired_token" => Ok(Poll::Expired),
            Err(Failure::Refused { code, .. }) if code == "access_denied" => Ok(Poll::Denied),
            Err(failure) => Err(self.failed("refused the login", &failure)),
        }
    }

    /// New tokens for the refresh token. Refused, the login has ended: the realm's session or the offline token
    /// expired unused, or was revoked.
    pub fn renew(&self, refresh_token: &Token) -> Result<Tokens, Error> {
        let form =
            [("grant_type", "refresh_token"), ("refresh_token", refresh_token.secret()), ("client_id", CLIENT_ID)];
        read(self.agent.post(&self.endpoints.token_endpoint).send_form(form)).map_err(|failure| match failure {
            Failure::Refused { .. } => Error::new(
                Kind::Failed,
                format!(
                    "Your login has ended (the login at {} answered {}): log in again with `ff login`",
                    self.url,
                    failure.text()
                ),
            ),
            Failure::Broken(_) => self.failed("couldn't renew your token", &failure),
        })
    }

    /// The login revoked, so that its refresh token renews nothing again, wherever a copy of it is: the realm's
    /// session's end leaves an offline token valid. The realm answers 200, even for a token it didn't know.
    pub fn revoke(&self, refresh_token: &Token) -> Result<(), Error> {
        let endpoint = self.endpoints.revocation_endpoint.as_deref().ok_or_else(|| {
            Error::new(Kind::Failed, format!("The login at {} names no revocation endpoint in its settings", self.url))
        })?;
        let form = [("token", refresh_token.secret()), ("token_type_hint", "refresh_token"), ("client_id", CLIENT_ID)];
        let mut response = self
            .agent
            .post(endpoint)
            .send_form(form)
            .map_err(|error| self.failed("couldn't revoke the login", &Failure::Broken(error.to_string())))?;
        let status = response.status().as_u16();
        if status == 200 {
            return Ok(());
        }
        let body = response.body_mut().read_to_string().unwrap_or_default();
        Err(self.failed("couldn't revoke the login", &failure_of(status, &body)))
    }

    fn failed(&self, what: &str, failure: &Failure) -> Error {
        Error::new(Kind::Failed, format!("The login at {} {what}: {}", self.url, failure.text()))
    }
}

/// Polls at the interval, slower after each `slow_down`, until the user approves, denies, or the code runs out of
/// time: `poll` asks once, `sleep` waits, which the tests do on a clock of their own.
pub fn wait(
    authorization: &DeviceAuthorization,
    mut poll: impl FnMut() -> Result<Poll, Error>,
    mut sleep: impl FnMut(Duration),
) -> Result<Tokens, Error> {
    let lifetime = Duration::from_secs(authorization.expires_in);
    let expired = || {
        Error::new(
            Kind::Failed,
            format!(
                "The code wasn't approved within its {}: nothing was saved, and `ff login` starts again",
                humantime::format_duration(lifetime)
            ),
        )
    };
    let mut interval = Duration::from_secs(authorization.interval);
    let mut waited = Duration::ZERO;
    loop {
        if waited >= lifetime {
            return Err(expired());
        }
        sleep(interval);
        waited += interval;
        match poll()? {
            Poll::Pending => {}
            Poll::SlowDown => interval += SLOW_DOWN,
            Poll::Approved(tokens) => return Ok(tokens),
            Poll::Expired => return Err(expired()),
            Poll::Denied => {
                return Err(Error::new(Kind::Failed, "The login was denied in the browser: nothing was saved"));
            }
        }
    }
}

/// A 2xx answer's JSON, or the OAuth error it holds.
fn read<T: DeserializeOwned>(answer: Result<Response<ureq::Body>, ureq::Error>) -> Result<T, Failure> {
    let mut response = answer.map_err(|error| Failure::Broken(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|error| Failure::Broken(error.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(failure_of(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|error| Failure::Broken(format!("it answered {status} with what isn't the JSON expected: {error}")))
}

/// An answer outside 2xx: OAuth's error, or its status and its first words.
fn failure_of(status: u16, body: &str) -> Failure {
    #[derive(Deserialize)]
    struct OAuthError {
        error: String,
        error_description: Option<String>,
    }
    match serde_json::from_str::<OAuthError>(body) {
        Ok(error) => Failure::Refused { code: error.error, description: error.error_description },
        Err(_) => {
            Failure::Broken(format!("it answered {status}: {}", body.trim().chars().take(200).collect::<String>()))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;

    use super::*;

    fn authorization(expires_in: u64, interval: u64) -> DeviceAuthorization {
        DeviceAuthorization {
            device_code: "dc".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://login.ff.example/realms/ff/device".into(),
            verification_uri_complete: None,
            expires_in,
            interval,
        }
    }

    fn tokens(refresh_token: Option<&str>) -> Tokens {
        Tokens { access_token: "access".into(), expires_in: 300, refresh_token: refresh_token.map(str::to_owned) }
    }

    /// The waits between polls, and the answer that ended them.
    fn waited(answers: Vec<Poll>, authorization: &DeviceAuthorization) -> (Vec<u64>, Result<Tokens, Error>) {
        let answers = RefCell::new(answers.into_iter());
        let mut slept = Vec::new();
        let ended = wait(
            authorization,
            || Ok(answers.borrow_mut().next().expect("no poll after the last answer")),
            |wait| slept.push(wait.as_secs()),
        );
        (slept, ended)
    }

    #[test]
    fn it_polls_at_the_interval_five_seconds_slower_after_each_slow_down_until_approved() {
        let answers =
            vec![Poll::Pending, Poll::SlowDown, Poll::Pending, Poll::SlowDown, Poll::Approved(tokens(Some("r")))];

        let (slept, ended) = waited(answers, &authorization(600, 5));

        assert_eq!(slept, [5, 5, 10, 10, 15]);
        assert_eq!(ended.unwrap(), tokens(Some("r")));
    }

    #[test]
    fn a_denial_or_an_expiry_ends_the_wait_saying_so() {
        let (_, denied) = waited(vec![Poll::Pending, Poll::Denied], &authorization(600, 5));
        let (_, expired) = waited(vec![Poll::Expired], &authorization(600, 5));

        assert_eq!(denied.unwrap_err().message, "The login was denied in the browser: nothing was saved");
        assert_eq!(
            expired.unwrap_err().message,
            "The code wasn't approved within its 10m: nothing was saved, and `ff login` starts again"
        );
    }

    #[test]
    fn it_stops_by_itself_once_the_code_has_had_its_time() {
        let (slept, ended) = waited(vec![Poll::Pending, Poll::SlowDown, Poll::Pending], &authorization(20, 5));

        assert_eq!(slept, [5, 5, 10]);
        assert_eq!(ended.unwrap_err().exit_code(), 3);
    }

    #[test]
    fn the_interval_is_five_seconds_when_none_is_given() {
        let given: DeviceAuthorization = serde_json::from_str(
            r#"{"device_code":"d","user_code":"u","verification_uri":"https://login/device","expires_in":600}"#,
        )
        .unwrap();

        assert_eq!(given.interval, 5);
    }

    #[test]
    fn a_login_is_kept_under_its_profile_and_read_back_to_the_second() {
        let at = humantime::parse_rfc3339("2026-11-09T12:00:00Z").unwrap();
        let login = Login::from_tokens("https://login.ff.example/realms/ff", tokens(Some("r")), None, at).unwrap();
        let mut file = ProfileFile::read(PathBuf::from("/nowhere/credentials.toml")).unwrap();

        login.write_to(&mut file, "staging");
        let read = Login::read(&file, "staging").unwrap().unwrap();

        assert_eq!(read.issuer, "https://login.ff.example/realms/ff");
        assert_eq!((read.access_token.secret(), read.refresh_token.secret()), ("access", "r"));
        assert_eq!(humantime::format_rfc3339_seconds(read.expires_at).to_string(), "2026-11-09T12:05:00Z");
        assert!(Login::read(&file, "default").unwrap().is_none());
        assert!(Login::remove_from(&mut file, "staging"));
        assert!(Login::read(&file, "staging").unwrap().is_none());
        assert!(!Login::remove_from(&mut file, "staging"));
    }

    #[test]
    fn a_renewal_without_a_refresh_token_keeps_the_one_it_was_given() {
        let kept = Token::new("offline").unwrap();

        let renewed = Login::from_tokens("https://id", tokens(None), Some(&kept), SystemTime::now()).unwrap();

        assert_eq!(renewed.refresh_token.secret(), "offline");
        assert_eq!(
            Login::from_tokens("https://id", tokens(None), None, SystemTime::now()).unwrap_err().message,
            "The login at https://id gave no refresh token"
        );
    }

    #[test]
    fn the_access_token_is_renewed_within_a_minute_of_its_end() {
        let now = SystemTime::now();
        let login = |seconds: u64| Login {
            issuer: "https://id".into(),
            access_token: Token::new("a").unwrap(),
            refresh_token: Token::new("r").unwrap(),
            expires_at: now + Duration::from_secs(seconds),
        };

        assert!(!login(61).is_due(now));
        assert!(login(60).is_due(now));
        assert!(login(0).is_due(now));
    }
}
