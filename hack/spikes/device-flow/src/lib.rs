//! OAuth's device flow (RFC 8628) against Keycloak, as `ff login` will run it: the issuer's endpoints read from its
//! discovery document; a device code asked for, with the code the user types and where; the token endpoint polled at
//! the interval it gives, slower when it says so, until the user approves, denies, or the code expires; then the tokens
//! refreshed, until a refresh is refused. With ureq, serde and base64, which `ff` has already.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;
use std::fmt;
use std::time::Duration;
use ureq::Agent;

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// RFC 8628, 3.5: each slow_down adds five seconds to the interval.
const SLOW_DOWN_STEP: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The issuer couldn't be reached, or answered what isn't OAuth's.
    Transport(String),
    /// An OAuth error the flow can't go on from: its code and description.
    Refused { status: u16, error: String, description: Option<String> },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::Transport(message) => f.write_str(message),
            Error::Refused { status, error, description } => {
                write!(f, "{status} {error}")?;
                description.as_ref().map_or(Ok(()), |description| write!(f, ": {description}"))
            }
        }
    }
}

impl std::error::Error for Error {}

/// The endpoints the flow uses, as the issuer's discovery document names them.
#[derive(Debug, Clone, Deserialize)]
pub struct Endpoints {
    pub issuer: String,
    pub device_authorization_endpoint: String,
    pub token_endpoint: String,
    pub end_session_endpoint: Option<String>,
    /// RFC 7009's: where `ff logout` ends a token that outlives the session, an offline one.
    pub revocation_endpoint: Option<String>,
}

/// What the device endpoint answers: the code the user types, where, and how long the device code lasts.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    /// RFC 8628, 3.2: five seconds when the issuer gives none.
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    /// Keycloak's: how long the refresh token lasts; 0 for an offline token, which lasts while it's used.
    pub refresh_expires_in: Option<u64>,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// One poll's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    /// The user hasn't approved yet: poll again after the interval.
    Pending,
    /// Polled too often: the interval grows by five seconds.
    SlowDown,
    /// The device code is spent: its time ran out, or it was used.
    Expired,
    /// The user said no.
    Denied,
    Approved(Tokens),
}

pub struct Issuer {
    agent: Agent,
    client_id: String,
    pub endpoints: Endpoints,
}

impl Issuer {
    /// The issuer at `base` (`https://…/realms/ff`), its endpoints from `/.well-known/openid-configuration`.
    pub fn discover(base: &str, client_id: &str) -> Result<Issuer, Error> {
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent("ff-device-flow-spike")
            .build()
            .into();
        let url = format!("{}/.well-known/openid-configuration", base.trim_end_matches('/'));
        let endpoints: Endpoints = read(agent.get(&url).call())?;
        Ok(Issuer { agent, client_id: client_id.to_string(), endpoints })
    }

    /// Asks for a device code, for the scopes given (space-separated).
    pub fn start(&self, scope: &str) -> Result<DeviceAuthorization, Error> {
        let form = [("client_id", self.client_id.as_str()), ("scope", scope)];
        read(self.agent.post(&self.endpoints.device_authorization_endpoint).send_form(form))
    }

    /// Asks once whether the user has approved.
    pub fn poll(&self, device_code: &str) -> Result<Poll, Error> {
        let form = [("grant_type", DEVICE_GRANT), ("device_code", device_code), ("client_id", self.client_id.as_str())];
        match read::<Tokens>(self.agent.post(&self.endpoints.token_endpoint).send_form(form)) {
            Ok(tokens) => Ok(Poll::Approved(tokens)),
            Err(Error::Refused { error, .. }) if error == "authorization_pending" => Ok(Poll::Pending),
            Err(Error::Refused { error, .. }) if error == "slow_down" => Ok(Poll::SlowDown),
            Err(Error::Refused { error, .. }) if error == "expired_token" => Ok(Poll::Expired),
            Err(Error::Refused { error, .. }) if error == "access_denied" => Ok(Poll::Denied),
            Err(other) => Err(other),
        }
    }

    /// Polls at the interval, slower after each slow_down, until the user decides or the code expires: the tokens,
    /// or the poll that ended it. `sleep` is the wait between polls (the tests' own clock), `seen` each poll's answer.
    pub fn wait(
        &self,
        authorization: &DeviceAuthorization,
        mut sleep: impl FnMut(Duration),
        mut seen: impl FnMut(&Poll, u64),
    ) -> Result<Result<Tokens, Poll>, Error> {
        let mut interval = authorization.interval;
        loop {
            sleep(Duration::from_secs(interval));
            let poll = self.poll(&authorization.device_code)?;
            seen(&poll, interval);
            match poll {
                Poll::Pending => {}
                Poll::SlowDown => interval += SLOW_DOWN_STEP,
                Poll::Approved(tokens) => return Ok(Ok(tokens)),
                ended @ (Poll::Expired | Poll::Denied) => return Ok(Err(ended)),
            }
        }
    }

    /// New tokens for a refresh token; a refusal (Keycloak's invalid_grant once the session ended) as an error.
    pub fn refresh(&self, refresh_token: &str) -> Result<Tokens, Error> {
        let form =
            [("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", self.client_id.as_str())];
        read(self.agent.post(&self.endpoints.token_endpoint).send_form(form))
    }

    /// A refresh token revoked (RFC 7009), so that no refresh works with it again: what `ff logout` does to an offline
    /// token, which the session's end leaves valid. The issuer answers 200 with nothing, even for a token it didn't know.
    pub fn revoke(&self, refresh_token: &str) -> Result<(), Error> {
        let endpoint = self
            .endpoints
            .revocation_endpoint
            .as_ref()
            .ok_or_else(|| Error::Transport(format!("{} names no revocation endpoint", self.endpoints.issuer)))?;
        let form =
            [("token", refresh_token), ("token_type_hint", "refresh_token"), ("client_id", self.client_id.as_str())];
        let mut response =
            self.agent.post(endpoint).send_form(form).map_err(|error| Error::Transport(error.to_string()))?;
        match response.status().as_u16() {
            200 => Ok(()),
            status => {
                let body = response.body_mut().read_to_string().unwrap_or_default();
                Err(Error::Transport(format!("{status}: {body}")))
            }
        }
    }
}

/// An answer's JSON, or the OAuth error it holds.
fn read<T: serde::de::DeserializeOwned>(
    answer: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<T, Error> {
    let mut response = answer.map_err(|error| Error::Transport(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|error| Error::Transport(error.to_string()))?;
    if (200..300).contains(&status) {
        return serde_json::from_str(&body).map_err(|error| Error::Transport(format!("{status}: {error}: {body}")));
    }
    let error: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    match error["error"].as_str() {
        Some(code) => Err(Error::Refused {
            status,
            error: code.to_string(),
            description: error["error_description"].as_str().map(str::to_string),
        }),
        None => Err(Error::Transport(format!("{status}: {body}"))),
    }
}

/// A token's claims, read without checking its signature: what the spike reports of it, never trusted.
pub fn claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// A stand-in issuer: answers each request with the next of `answers` (status, JSON), and keeps the requests' bodies.
    fn issuer(answers: Vec<(u16, &'static str)>) -> (Issuer, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let discovery = format!(
            r#"{{"issuer":"{base}","device_authorization_endpoint":"{base}/device","token_endpoint":"{base}/token","revocation_endpoint":"{base}/revoke"}}"#
        );
        let mut answers: Vec<(u16, String)> = answers.into_iter().map(|(s, b)| (s, b.to_string())).collect();
        answers.insert(0, (200, discovery));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        thread::spawn(move || {
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut request = vec![0; length];
                reader.read_exact(&mut request).unwrap();
                kept.lock().unwrap().push(String::from_utf8(request).unwrap());
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        (Issuer::discover(&base, "ff-cli").unwrap(), seen)
    }

    const AUTHORIZATION: &str = r#"{"device_code":"dc","user_code":"ABCD-EFGH","verification_uri":"https://id/device","expires_in":600,"interval":5}"#;
    const TOKENS: &str =
        r#"{"access_token":"a","expires_in":300,"refresh_token":"r","refresh_expires_in":1800,"token_type":"Bearer"}"#;

    #[test]
    fn polls_at_the_interval_slower_after_slow_down_until_approved() {
        let (issuer, requests) = issuer(vec![
            (200, AUTHORIZATION),
            (400, r#"{"error":"authorization_pending"}"#),
            (400, r#"{"error":"slow_down"}"#),
            (400, r#"{"error":"authorization_pending"}"#),
            (200, TOKENS),
        ]);
        let authorization = issuer.start("openid").unwrap();
        assert_eq!(authorization.user_code, "ABCD-EFGH");
        let mut slept = Vec::new();
        let tokens = issuer.wait(&authorization, |wait| slept.push(wait.as_secs()), |_, _| {}).unwrap().unwrap();
        assert_eq!(slept, [5, 5, 10, 10]);
        assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
        // The discovery's GET first, with no body; then the device code asked for; then the four polls.
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert_eq!(requests[1], "client_id=ff-cli&scope=openid");
        assert!(
            requests[2].starts_with("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc")
        );
    }

    #[test]
    fn a_denial_and_an_expiry_end_the_wait() {
        for (error, ended) in [("access_denied", Poll::Denied), ("expired_token", Poll::Expired)] {
            let body: &'static str = Box::leak(format!(r#"{{"error":"{error}"}}"#).into_boxed_str());
            let (issuer, _) = issuer(vec![(200, AUTHORIZATION), (400, body)]);
            let authorization = issuer.start("openid").unwrap();
            assert_eq!(issuer.wait(&authorization, |_| {}, |_, _| {}).unwrap(), Err(ended));
        }
    }

    #[test]
    fn a_refused_refresh_says_why() {
        let (issuer, _) = issuer(vec![(400, r#"{"error":"invalid_grant","error_description":"Session not active"}"#)]);
        let refused = issuer.refresh("r").unwrap_err();
        assert_eq!(refused.to_string(), "400 invalid_grant: Session not active");
    }

    #[test]
    fn a_revocation_names_the_token_and_takes_an_empty_answer() {
        let (issuer, requests) = issuer(vec![(200, "")]);
        issuer.revoke("r").unwrap();
        assert_eq!(requests.lock().unwrap()[1], "token=r&token_type_hint=refresh_token&client_id=ff-cli");
    }

    #[test]
    fn the_interval_is_five_seconds_when_none_is_given() {
        let authorization: DeviceAuthorization =
            serde_json::from_str(r#"{"device_code":"d","user_code":"u","verification_uri":"v","expires_in":600}"#)
                .unwrap();
        assert_eq!(authorization.interval, 5);
    }
}
