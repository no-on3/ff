//! The API client: one request at a time, with the caller's token and account, ff's user agent,
//! and timeouts fit for each call.

use std::io::{BufReader, Read};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use ureq::Agent;
use ureq::http::Response;
use ureq::tls::{RootCerts, TlsConfig};

use super::error::{api_error, retry_after};
use super::events::Events;
use crate::auth;
use crate::config::{Endpoint, Settings};
use crate::error::{Error, Kind};

/// How long to wait for a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a call waits for its answer, unless it says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest a read waits on a 429's Retry-After before trying once more.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    /// Only a read is tried again: a write may have happened before its refusal reached us.
    fn is_read(self) -> bool {
        self == Method::Get
    }
}

/// What a call sends: JSON, or bytes of a media type, such as a package's zip.
enum Body {
    Json(serde_json::Value),
    Bytes(Vec<u8>, &'static str),
}

/// One call: its method and path, its query and body, and how long it may take.
pub struct Call {
    method: Method,
    path: String,
    query: Vec<(String, String)>,
    body: Option<Body>,
    timeout: Duration,
    accept: &'static str,
}

impl Call {
    pub fn new(method: Method, path: impl Into<String>) -> Call {
        Call {
            method,
            path: path.into(),
            query: Vec::new(),
            body: None,
            timeout: DEFAULT_TIMEOUT,
            accept: "application/json",
        }
    }

    pub fn get(path: impl Into<String>) -> Call {
        Call::new(Method::Get, path)
    }

    pub fn post(path: impl Into<String>, body: serde_json::Value) -> Call {
        Call { body: Some(Body::Json(body)), ..Call::new(Method::Post, path) }
    }

    /// A post of bytes, sent as `content_type`.
    pub fn post_bytes(path: impl Into<String>, bytes: Vec<u8>, content_type: &'static str) -> Call {
        Call { body: Some(Body::Bytes(bytes, content_type)), ..Call::new(Method::Post, path) }
    }

    pub fn put(path: impl Into<String>, body: serde_json::Value) -> Call {
        Call { body: Some(Body::Json(body)), ..Call::new(Method::Put, path) }
    }

    pub fn patch(path: impl Into<String>, body: serde_json::Value) -> Call {
        Call { body: Some(Body::Json(body)), ..Call::new(Method::Patch, path) }
    }

    pub fn delete(path: impl Into<String>) -> Call {
        Call::new(Method::Delete, path)
    }

    /// A query parameter, encoded as it goes.
    pub fn query(mut self, name: &str, value: impl ToString) -> Call {
        self.query.push((name.to_owned(), value.to_string()));
        self
    }

    /// What the answer should be, when not JSON: the month's usage as CSV.
    pub fn accept(mut self, media_type: &'static str) -> Call {
        self.accept = media_type;
        self
    }

    /// How long the answer may take: a deploy waits for its rollout, an invocation for its function.
    pub fn timeout(mut self, timeout: Duration) -> Call {
        self.timeout = timeout;
        self
    }
}

pub struct Client {
    agent: Agent,
    endpoint: Endpoint,
    headers: Vec<(&'static str, String)>,
    api_key: bool,
}

impl Client {
    /// A client for the settings in effect; refused before any call when there is no token, nor
    /// a development account.
    pub fn new(settings: &Settings) -> Result<Client, Error> {
        auth::require_identity(settings)?;
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .user_agent(format!("ff-cli/{}", env!("CARGO_PKG_VERSION")))
            .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
            .build()
            .into();
        Ok(Client {
            agent,
            endpoint: settings.endpoint.value.clone(),
            headers: auth::identity_headers(settings),
            api_key: settings.token.as_ref().is_some_and(|token| token.value.is_api_key()),
        })
    }

    /// The call's JSON answer.
    pub fn json<T: DeserializeOwned>(&self, call: &Call) -> Result<T, Error> {
        let (status, body) = self.answer(call)?;
        serde_json::from_str(&body).map_err(|error| {
            Error::new(
                Kind::Failed,
                format!("The API at {} answered {status} with what isn't the JSON expected: {error}", self.endpoint),
            )
        })
    }

    /// A stream of Server-Sent Events, as the live tail's, once the API has taken the call.
    pub fn events(&self, call: &Call) -> Result<Events<BufReader<ureq::BodyReader<'static>>>, Error> {
        let mut response = self.send(call)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let request_id =
                response.headers().get("x-ff-request-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
            let body = self.read_body(&mut response)?;
            return Err(api_error(status, &body, request_id, self.api_key));
        }
        Ok(Events::new(BufReader::new(response.into_body().into_reader())))
    }

    /// The call's answer as text, such as CSV.
    pub fn text(&self, call: &Call) -> Result<String, Error> {
        self.answer(call).map(|(_, body)| body)
    }

    /// A call whose answer has nothing to read, such as a delete's.
    pub fn done(&self, call: &Call) -> Result<(), Error> {
        self.answer(call).map(|_| ())
    }

    /// A 2xx answer's status and body, or the API's refusal as ff's error. A read refused with
    /// 429 is tried once more after its Retry-After.
    fn answer(&self, call: &Call) -> Result<(u16, String), Error> {
        let mut response = self.send(call)?;
        if response.status() == 429 && call.method.is_read() {
            let wait = retry_after(response.headers().get("retry-after").and_then(|value| value.to_str().ok()));
            if let Some(wait) = wait.filter(|wait| *wait <= MAX_RETRY_WAIT) {
                thread::sleep(wait);
                response = self.send(call)?;
            }
        }
        let status = response.status().as_u16();
        let request_id =
            response.headers().get("x-ff-request-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
        let body = self.read_body(&mut response)?;
        if !(200..300).contains(&status) {
            return Err(api_error(status, &body, request_id, self.api_key));
        }
        Ok((status, body))
    }

    fn send(&self, call: &Call) -> Result<Response<ureq::Body>, Error> {
        let url = format!("{}{}", self.endpoint, call.path);
        let mut request = match call.method {
            Method::Get => self.agent.get(&url).force_send_body(),
            Method::Post => self.agent.post(&url),
            Method::Put => self.agent.put(&url),
            Method::Patch => self.agent.patch(&url),
            Method::Delete => self.agent.delete(&url).force_send_body(),
        };
        request = request.header("accept", call.accept);
        for (name, value) in &self.headers {
            request = request.header(*name, value);
        }
        for (name, value) in &call.query {
            request = request.query(name, value);
        }
        let request = request.config().timeout_global(Some(call.timeout)).build();
        let sent = match &call.body {
            Some(Body::Json(body)) => request.header("content-type", "application/json").send(body.to_string()),
            Some(Body::Bytes(bytes, content_type)) => {
                request.header("content-type", *content_type).send(bytes.as_slice())
            }
            None => request.send_empty(),
        };
        sent.map_err(|error| self.transport_error(error, call.timeout))
    }

    fn read_body(&self, response: &mut Response<ureq::Body>) -> Result<String, Error> {
        let mut body = String::new();
        response.body_mut().as_reader().read_to_string(&mut body).map_err(|error| {
            Error::new(Kind::Failed, format!("The API at {} stopped answering: {error}", self.endpoint))
        })?;
        Ok(body)
    }

    /// No answer at all: the address and why, so a wrong endpoint shows at once.
    fn transport_error(&self, error: ureq::Error, timeout: Duration) -> Error {
        let reason = match &error {
            ureq::Error::Timeout(_) => {
                return Error::new(
                    Kind::Failed,
                    format!("The API at {} didn't answer within {} s", self.endpoint, timeout.as_secs()),
                );
            }
            ureq::Error::HostNotFound => "its host name isn't known".to_owned(),
            ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
                "the connection was refused".to_owned()
            }
            other => other.to_string(),
        };
        Error::new(Kind::Failed, format!("Couldn't reach the API at {}: {reason}", self.endpoint))
    }
}
