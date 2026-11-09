//! A function's URL on this machine, as FF's gateway serves one (`BE/src/function-urls/`): each HTTP request becomes
//! AWS Lambda's event for function URLs (API Gateway's payload 2.0, `url-event.ts`), the function's answer becomes the
//! response by Lambda's rules (`url-response.ts`), and a URL's CORS is applied as Lambda applies it (`url-cors.ts`).
//! What the gateway answers itself, it answers here the same way: a JSON `Message`. Its cases are
//! `BE/src/function-urls/function-url-examples.json`'s, which the backend's tests read too. `ff local start --url`
//! serves one function's URL; the front door serves those of a template's functions.

use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::SystemTime;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::http::{self, Answers, PAYLOAD_LIMIT, percent_decode};
pub use super::http::{Request, Response};

/// Headers that belong to one connection, never passed on (RFC 9110, §7.6.1).
const HOP_BY_HOP: [&str; 7] =
    ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/// Headers the server sets itself: never the function's.
const SERVER_HEADERS: [&str; 8] =
    ["connection", "content-length", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/// The methods a URL's CORS may allow, as FF takes them; "*" is any.
const CORS_METHODS: [&str; 7] = ["GET", "PUT", "HEAD", "POST", "PATCH", "DELETE", "*"];
/// How many origins, and headers, a URL's CORS may name, and how long each may be, as FF takes them.
const CORS_ITEMS: usize = 100;
const ORIGIN_LENGTH: usize = 253;
const HEADER_LENGTH: usize = 1024;
/// How long a browser may keep a preflight's answer, at most: a day.
const CORS_MAX_AGE: u64 = 86_400;

/// An answer the front gives itself, as the gateway does: a status, and a JSON Message.
pub fn message(status: u16, message: &str) -> Response {
    Response {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: json!({ "Message": message }).to_string().into_bytes(),
    }
}

/// A request over Lambda's 6 MB, or whose event would be.
pub fn too_large() -> Response {
    message(413, "Request Entity Too Large")
}

/// API Gateway's request time, `12/Mar/2020:19:03:58 +0000`, in UTC.
pub fn request_time(time: SystemTime) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let rfc3339 = humantime::format_rfc3339_seconds(time).to_string(); // 2026-10-21T08:00:00Z
    let month = rfc3339[5..7].parse::<usize>().map(|month| MONTHS[month - 1]).unwrap_or("Jan");
    format!("{}/{month}/{}:{} +0000", &rfc3339[8..10], &rfc3339[..4], &rfc3339[11..19])
}

/// The host a request names, in lower case, without its port or a final dot; none without one, or for an address in
/// brackets.
pub fn host_name(host: Option<&str>) -> Option<String> {
    let host = host.filter(|host| !host.starts_with('['))?;
    let name = match host.rsplit_once(':') {
        Some((name, port)) if port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => host,
    };
    let name = name.to_ascii_lowercase();
    let name = name.strip_suffix('.').unwrap_or(&name);
    (!name.is_empty()).then(|| name.to_owned())
}

/// Who called a URL that takes the account's credentials, as its event names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    pub access_key: String,
    pub account_id: String,
    pub user_id: String,
}

/// A request, and what its event says of it besides, as the gateway knows them.
pub struct UrlRequest<'a> {
    pub request: &'a Request,
    pub source_ip: &'a str,
    /// The host the request named, without its port.
    pub domain_name: &'a str,
    /// The URL's ID: the host's first label.
    pub domain_prefix: &'a str,
    pub url_id: &'a str,
    /// The call's ID, which the function's context has too.
    pub request_id: &'a str,
    pub time: SystemTime,
    /// `anonymous` for a URL anyone may call; the account for one that takes its credentials.
    pub account_id: &'a str,
    pub caller: Option<&'a Caller>,
    /// Headers not passed on, by lower-case name: the credentials that let the caller in.
    pub without_headers: &'a [&'a str],
}

/// The path and the query string of a request's target: the query without its "?", "" when there is none.
fn split_target(target: &str) -> (&str, &str) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    (if path.is_empty() { "/" } else { path }, query)
}

/// The event the request becomes: payload format 2.0, as a function URL sends it.
pub fn event(url: &UrlRequest) -> Value {
    let request = url.request;
    let (raw_path, raw_query) = split_target(&request.target);
    let mut headers = Map::new();
    let mut cookies = Vec::new();
    for (name, value) in &request.headers {
        let name = name.to_ascii_lowercase();
        if name == "cookie" {
            cookies.extend(
                value
                    .split(';')
                    .map(str::trim)
                    .filter(|cookie| !cookie.is_empty())
                    .map(|cookie| Value::from(cookie.to_owned())),
            );
        } else if !HOP_BY_HOP.contains(&name.as_str()) && !url.without_headers.contains(&name.as_str()) {
            // Repeated headers are joined with commas, as API Gateway's payload 2.0 does.
            let joined = match headers.get(&name).and_then(Value::as_str) {
                Some(before) => format!("{before},{value}"),
                None => value.clone(),
            };
            headers.insert(name, Value::from(joined));
        }
    }
    let mut query = Map::new();
    for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let (name, value) = (percent_decode(name), percent_decode(value));
        let joined = match query.get(&name).and_then(Value::as_str) {
            Some(before) => format!("{before},{value}"),
            None => value,
        };
        query.insert(name, Value::from(joined));
    }
    let header = |name: &str| headers.get(name).and_then(Value::as_str).unwrap_or("").to_owned();
    let epoch_ms = url.time.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64);

    let mut event = json!({
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": raw_path,
        "rawQueryString": raw_query,
        "headers": Value::Object(headers.clone()),
        "requestContext": {
            "accountId": url.account_id,
            "apiId": url.url_id,
            "authentication": null,
            "domainName": url.domain_name,
            "domainPrefix": url.domain_prefix,
            "http": { "method": request.method, "path": raw_path, "protocol": request.protocol, "sourceIp": url.source_ip, "userAgent": header("user-agent") },
            "requestId": url.request_id,
            "routeKey": "$default",
            "stage": "$default",
            "time": request_time(url.time),
            "timeEpoch": epoch_ms
        },
        "isBase64Encoded": false
    });
    if let Some(caller) = url.caller {
        event["requestContext"]["authorizer"] = json!({ "iam": {
            "accessKey": caller.access_key,
            "accountId": caller.account_id,
            "callerId": caller.user_id,
            "cognitoIdentity": null,
            "principalOrgId": null,
            "userArn": null,
            "userId": caller.user_id,
        } });
    }
    if !cookies.is_empty() {
        event["cookies"] = Value::from(cookies);
    }
    if !raw_query.is_empty() {
        event["queryStringParameters"] = Value::Object(query);
    }
    // Text when its type says text, JSON or XML and it is UTF-8; anything else base64, as LocalStack emulates AWS.
    if !request.body.is_empty() {
        let content_type = header("content-type").to_ascii_lowercase();
        let textual = ["text", "json", "xml"].iter().any(|kind| content_type.contains(kind));
        match std::str::from_utf8(&request.body) {
            Ok(text) if textual => event["body"] = Value::from(text),
            _ => {
                event["body"] = Value::from(BASE64.encode(&request.body));
                event["isBase64Encoded"] = Value::from(true);
            }
        }
    }
    event
}

/// An HTTP token, as a header's name must be (RFC 9110, §5.6.2).
fn is_token(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
}

/// A final answer's status, from 200 to 599: a whole number, or its digits in a string.
fn status_of(value: &Value) -> Option<u16> {
    let status = match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().filter(|status| status.fract() == 0.0).map(|status| status as u64)),
        Value::String(text) if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => text.parse().ok(),
        _ => None,
    };
    status.filter(|status| (200..=599).contains(status)).map(|status| status as u16)
}

/// The response for a function's return value, by Lambda's rules for function URLs; why it can't
/// be one, otherwise.
pub fn answer(output: &Value) -> Result<Response, String> {
    let Some(response) = output.as_object().filter(|object| object.contains_key("statusCode")) else {
        return Ok(Response {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: output.to_string().into_bytes(),
        });
    };
    let status = status_of(&response["statusCode"])
        .ok_or_else(|| format!("statusCode must be a whole number from 200 to 599; got {}", response["statusCode"]))?;
    let unsafe_text = |text: &str| text.contains(['\r', '\n', '\0']);
    let mut headers = Vec::new();
    match response.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(given)) => {
            for (name, value) in given {
                if !is_token(name) {
                    return Err(format!("{name:?} is not a header name"));
                }
                let text = match value {
                    Value::Null => continue,
                    Value::String(text) => text.clone(),
                    Value::Number(number) => number.to_string(),
                    Value::Bool(flag) => flag.to_string(),
                    _ => return Err(format!("the header {name}'s value must be a string, a number or a boolean")),
                };
                if unsafe_text(&text) {
                    return Err(format!("the header {name}'s value holds a line break or NUL"));
                }
                if !SERVER_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                    headers.push((name.clone(), text));
                }
            }
        }
        Some(_) => return Err("headers must be an object of names to values".to_owned()),
    }
    match response.get("cookies") {
        None | Some(Value::Null) => {}
        Some(Value::Array(cookies)) if cookies.iter().all(Value::is_string) => {
            for cookie in cookies.iter().filter_map(Value::as_str) {
                if unsafe_text(cookie) {
                    return Err("a cookie holds a line break or NUL".to_owned());
                }
                headers.push(("set-cookie".into(), cookie.to_owned()));
            }
        }
        Some(_) => return Err("cookies must be a list of strings".to_owned()),
    }
    if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
        headers.push(("content-type".into(), "application/json".into()));
    }
    let body = match response.get("body") {
        None | Some(Value::Null) => Vec::new(),
        Some(body) => {
            let text = body.as_str().map(str::to_owned).unwrap_or_else(|| body.to_string());
            if response.get("isBase64Encoded") == Some(&Value::Bool(true)) {
                BASE64
                    .decode(text.trim())
                    .map_err(|error| format!("isBase64Encoded, but the body isn't base64: {error}"))?
            } else {
                text.into_bytes()
            }
        }
    };
    Ok(Response { status, headers, body })
}

/// A URL's CORS, as FF takes it and AWS Lambda applies it: with one, the URL answers a browser's preflight itself, and
/// adds its headers to every answer, in place of any the function sends; without one, it adds nothing, and a
/// preflight is a request like any other, for the function to answer.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cors {
    pub allow_origins: Option<Vec<String>>,
    pub allow_methods: Option<Vec<String>>,
    pub allow_headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub max_age: Option<u64>,
    pub allow_credentials: Option<bool>,
}

/// A browser's preflight: OPTIONS, from an origin, asking for a method.
pub fn is_preflight(request: &Request) -> bool {
    request.method == "OPTIONS"
        && request.header("origin").is_some()
        && request.header("access-control-request-method").is_some()
}

/// The function's own CORS headers, which a configuration replaces.
pub fn is_cors_header(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("access-control-")
}

impl Cors {
    fn listed(list: &Option<Vec<String>>) -> &[String] {
        list.as_deref().unwrap_or_default()
    }

    fn credentials(&self) -> bool {
        self.allow_credentials == Some(true)
    }

    /// Whether it lets this origin in: one of its origins, compared without case, or "*".
    pub fn allows_origin(&self, origin: Option<&str>) -> bool {
        let Some(origin) = origin.filter(|origin| !origin.is_empty()) else { return false };
        Cors::listed(&self.allow_origins).iter().any(|allowed| allowed == "*" || allowed.eq_ignore_ascii_case(origin))
    }

    /// The origin an answer names: "*" when any origin may read it without credentials, else the caller's own, which
    /// then varies.
    fn origin_headers(&self, origin: &str) -> Vec<(String, String)> {
        if Cors::listed(&self.allow_origins).iter().any(|allowed| allowed == "*") && !self.credentials() {
            return vec![("access-control-allow-origin".into(), "*".into())];
        }
        vec![("access-control-allow-origin".into(), origin.into()), ("vary".into(), "Origin".into())]
    }

    /// What a preflight is answered with: its own, for an origin it lets in; nothing for another, which the browser
    /// then refuses.
    pub fn preflight_headers(&self, origin: Option<&str>) -> Vec<(String, String)> {
        let Some(origin) = origin.filter(|_| self.allows_origin(origin)) else { return Vec::new() };
        let mut headers = self.origin_headers(origin);
        let methods = Cors::listed(&self.allow_methods);
        if !methods.is_empty() {
            headers.push(("access-control-allow-methods".into(), methods.join(",")));
        }
        let allowed = Cors::listed(&self.allow_headers);
        if !allowed.is_empty() {
            headers.push(("access-control-allow-headers".into(), allowed.join(",")));
        }
        if self.credentials() {
            headers.push(("access-control-allow-credentials".into(), "true".into()));
        }
        if let Some(max_age) = self.max_age {
            headers.push(("access-control-max-age".into(), max_age.to_string()));
        }
        headers
    }

    /// What an answer to an origin it lets in carries: the origin, the headers it may read, and credentials.
    pub fn response_headers(&self, origin: Option<&str>) -> Vec<(String, String)> {
        let Some(origin) = origin.filter(|_| self.allows_origin(origin)) else { return Vec::new() };
        let mut headers = self.origin_headers(origin);
        let exposed = Cors::listed(&self.expose_headers);
        if !exposed.is_empty() {
            headers.push(("access-control-expose-headers".into(), exposed.join(",")));
        }
        if self.credentials() {
            headers.push(("access-control-allow-credentials".into(), "true".into()));
        }
        headers
    }

    /// The answer with its headers in place of any the function sent.
    pub fn applied(&self, mut response: Response, origin: Option<&str>) -> Response {
        response.headers.retain(|(name, _)| !is_cors_header(name));
        response.headers.extend(self.response_headers(origin));
        response
    }
}

/// An origin as a browser sends it: a scheme, "://", and a host with its port if any, nothing after; or "*", any.
fn is_origin(origin: &str) -> bool {
    if origin == "*" {
        return true;
    }
    let Some((scheme, host)) = origin.split_once("://") else { return false };
    let mut scheme = scheme.bytes();
    scheme.next().is_some_and(|first| first.is_ascii_alphabetic())
        && scheme.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
        && !host.is_empty()
        && !host.chars().any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#'))
}

/// What FF refuses of a URL's CORS, as its API takes one: each property, by the template's name for it, and why.
pub fn cors_refusals(cors: &Value) -> Vec<(&'static str, String)> {
    let mut refused = Vec::new();
    let mut list = |field: &str, property: &'static str, most: usize, rule: &str, fits: &dyn Fn(&str) -> bool| {
        let Some(given) = cors.get(field).filter(|value| !value.is_null()) else { return };
        let wrong = match given.as_array() {
            Some(items) if items.len() <= most => items.iter().find(|item| !item.as_str().is_some_and(fits)),
            _ => Some(given),
        };
        if let Some(wrong) = wrong {
            refused.push((
                property,
                format!("{property} is a list of at most {most} {rule}, as FF takes it, not {wrong}"),
            ));
        }
    };
    let header = |name: &str| name.len() <= HEADER_LENGTH && is_token(name);
    list("allowOrigins", "AllowOrigins", CORS_ITEMS, "origins, such as https://www.example.tn, or *", &|origin| {
        origin.len() <= ORIGIN_LENGTH && is_origin(origin)
    });
    list(
        "allowMethods",
        "AllowMethods",
        CORS_METHODS.len() - 1,
        "of GET, PUT, HEAD, POST, PATCH, DELETE and *",
        &|method| CORS_METHODS.contains(&method),
    );
    list("allowHeaders", "AllowHeaders", CORS_ITEMS, "header names, or *", &header);
    list("exposeHeaders", "ExposeHeaders", CORS_ITEMS, "header names", &header);
    if let Some(given) = cors.get("allowCredentials").filter(|value| !value.is_null() && !value.is_boolean()) {
        refused.push(("AllowCredentials", format!("AllowCredentials is true or false, not {given}")));
    }
    if let Some(given) = cors.get("maxAge").filter(|value| !value.is_null())
        && given.as_u64().is_none_or(|seconds| seconds > CORS_MAX_AGE)
    {
        refused.push((
            "MaxAge",
            format!("MaxAge is a whole number of seconds from 0 to {CORS_MAX_AGE}, as FF takes it, not {given}"),
        ));
    }
    refused
}

/// How a URL's call ended.
pub enum Ran {
    /// The function's return value.
    Output(Value),
    /// No instance was free in time: the caller may try again.
    Throttled,
    /// The function failed, or the call couldn't be made: its error is for its log, never its caller.
    Failed,
}

/// What a URL answers for its call: the function's return value as the response, by Lambda's rules; 429 for a
/// throttle; 502 for a failure, or for a return value that can't be a response, whose reason `say` gives.
pub fn response_of(ran: Ran, say: &dyn Fn(&str)) -> Response {
    let output = match ran {
        Ran::Output(output) => output,
        Ran::Throttled => return message(429, "Too Many Requests"),
        Ran::Failed => return message(502, "Internal Server Error"),
    };
    match answer(&output) {
        Ok(response) if response.body.len() > PAYLOAD_LIMIT => {
            say(&format!("the function answered {} bytes, over the 6 MB limit: 502", response.body.len()));
            message(502, "Internal Server Error")
        }
        Ok(response) => response,
        Err(reason) => {
            say(&format!("the function's answer can't be a response ({reason}): 502"));
            message(502, "Internal Server Error")
        }
    }
}

/// The event, unless it is over Lambda's 6 MB, as a request's body in base64 may be.
pub fn sized(event: Value) -> Result<Value, Response> {
    match serde_json::to_vec(&event).map_or(0, |json| json.len()) > PAYLOAD_LIMIT {
        true => Err(too_large()),
        false => Ok(event),
    }
}

/// Calls the function's container with the event, as the backend calls a pod.
fn call(runtime_port: u16, event: &Value, request_id: &str, timeout: u32) -> Ran {
    match super::call(runtime_port, event, Some(request_id), &super::Asks::default(), timeout) {
        Ok(ran) if ran.status == 200 => Ran::Output(serde_json::from_str(&ran.body).unwrap_or(Value::Null)),
        Ok(ran) if ran.status == 429 => Ran::Throttled,
        // The function's own error, which its log has.
        Ok(_) => Ran::Failed,
        Err(error) => {
            eprintln!("ff local: {}", error.message);
            Ran::Failed
        }
    }
}

/// A function's URL on this machine: each request calls the container on the port the shared value names, which a
/// restart, with `--watch`, changes.
struct Front {
    runtime_port: Arc<AtomicU16>,
    timeout: u32,
}

impl Answers for Front {
    fn answer(&self, request: &Request, request_id: &str, source_ip: &str) -> Response {
        let domain_name = host_name(request.header("host")).unwrap_or_else(|| "127.0.0.1".to_owned());
        let event = event(&UrlRequest {
            request,
            source_ip,
            domain_name: &domain_name,
            domain_prefix: domain_name.split('.').next().unwrap_or_default(),
            url_id: "local",
            request_id,
            time: SystemTime::now(),
            account_id: "anonymous",
            caller: None,
            without_headers: &[],
        });
        let event = match sized(event) {
            Ok(event) => event,
            Err(refused) => return refused,
        };
        let ran = call(self.runtime_port.load(Ordering::SeqCst), &event, request_id, self.timeout);
        response_of(ran, &|line| eprintln!("ff local: {line}"))
    }

    fn unreadable(&self, too_large: bool, _: Option<&Request>) -> Response {
        match too_large {
            true => self::too_large(),
            false => message(400, "Bad Request"),
        }
    }
}

/// Serves the function's URL on the listener.
pub fn serve(listener: TcpListener, runtime_port: Arc<AtomicU16>, timeout: u32) {
    http::serve(listener, Arc::new(Front { runtime_port, timeout }));
}

#[cfg(test)]
pub mod tests {
    use std::time::Duration;

    use super::*;

    /// The backend's cases of function URLs.
    pub fn table() -> Value {
        serde_json::from_str(include_str!("../../../BE/src/function-urls/function-url-examples.json")).unwrap()
    }

    /// A value of the table by its path, `a.b.c`.
    pub fn at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
        value.pointer(&format!("/{}", path.replace('.', "/")))
    }

    /// Headers as the table lists them, a name and its value each.
    pub fn pairs(value: &Value) -> Vec<(String, String)> {
        let pair = |pair: &Value| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned());
        value.as_array().map(|pairs| pairs.iter().map(pair).collect()).unwrap_or_default()
    }

    fn request(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Request {
        Request {
            method: method.into(),
            target: target.into(),
            protocol: "HTTP/1.1".into(),
            headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            body: body.to_vec(),
        }
    }

    fn at_time() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(1_792_569_600_123) // 2026-10-21T08:00:00.123Z
    }

    /// The event of a request to `ff local start --url`'s URL, at 127.0.0.1.
    fn local_event(request: &Request, source_ip: &str) -> Value {
        event(&UrlRequest {
            request,
            source_ip,
            domain_name: "127.0.0.1",
            domain_prefix: "127",
            url_id: "local",
            request_id: "req-1",
            time: at_time(),
            account_id: "anonymous",
            caller: None,
            without_headers: &[],
        })
    }

    #[test]
    fn a_request_becomes_lambdas_url_event() {
        let event = local_event(
            &request(
                "POST",
                "/orders/7?rush=1&tag=a&tag=b+c&x=%C3%A9",
                &[
                    ("Host", "127.0.0.1:9000"),
                    ("User-Agent", "curl/8"),
                    ("Content-Type", "application/json"),
                    ("X-Many", "1"),
                    ("x-many", "2"),
                    ("Cookie", "a=1; b=2"),
                    ("Connection", "close"),
                ],
                br#"{"item": 7}"#,
            ),
            "127.0.0.1",
        );

        assert_eq!(
            event,
            json!({
                "version": "2.0", "routeKey": "$default", "rawPath": "/orders/7", "rawQueryString": "rush=1&tag=a&tag=b+c&x=%C3%A9",
                "cookies": ["a=1", "b=2"],
                "headers": { "host": "127.0.0.1:9000", "user-agent": "curl/8", "content-type": "application/json", "x-many": "1,2" },
                "queryStringParameters": { "rush": "1", "tag": "a,b c", "x": "é" },
                "requestContext": {
                    "accountId": "anonymous", "apiId": "local", "authentication": null, "domainName": "127.0.0.1", "domainPrefix": "127",
                    "http": { "method": "POST", "path": "/orders/7", "protocol": "HTTP/1.1", "sourceIp": "127.0.0.1", "userAgent": "curl/8" },
                    "requestId": "req-1", "routeKey": "$default", "stage": "$default", "time": "21/Oct/2026:08:00:00 +0000", "timeEpoch": 1_792_569_600_123u64
                },
                "body": "{\"item\": 7}", "isBase64Encoded": false
            })
        );
    }

    #[test]
    fn a_body_that_isnt_text_is_base64_and_an_empty_one_is_none() {
        let binary =
            local_event(&request("PUT", "/", &[("Content-Type", "image/png")], &[0x89, b'P', b'N', b'G']), "::1");
        let empty = local_event(&request("GET", "", &[], b""), "::1");

        assert_eq!((binary["body"].as_str(), binary["isBase64Encoded"].as_bool()), (Some("iVBORw=="), Some(true)));
        assert_eq!(
            (empty.get("body"), empty["rawPath"].as_str(), empty.get("queryStringParameters")),
            (None, Some("/"), None)
        );
    }

    #[test]
    fn an_answer_is_a_response_by_lambdas_rules() {
        assert_eq!(
            answer(&json!({ "message": "hi" })).unwrap(),
            Response {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: b"{\"message\":\"hi\"}".to_vec()
            }
        );
        assert_eq!(answer(&json!("text")).unwrap().body, b"\"text\"");
        let response = answer(&json!({ "statusCode": "201", "headers": { "Content-Type": "text/plain", "X-Count": 3, "Content-Length": "9" }, "cookies": ["a=1"], "body": "made" })).unwrap();
        assert_eq!(
            response,
            Response {
                status: 201,
                headers: vec![
                    ("Content-Type".into(), "text/plain".into()),
                    ("X-Count".into(), "3".into()),
                    ("set-cookie".into(), "a=1".into())
                ],
                body: b"made".to_vec()
            }
        );
        assert_eq!(answer(&json!({ "statusCode": 200, "body": "aGk=", "isBase64Encoded": true })).unwrap().body, b"hi");
        assert_eq!(answer(&json!({ "statusCode": 204 })).unwrap().body, b"");
    }

    #[test]
    fn an_answer_that_cant_be_a_response_says_why() {
        assert_eq!(
            answer(&json!({ "statusCode": 99 })).unwrap_err(),
            "statusCode must be a whole number from 200 to 599; got 99"
        );
        assert_eq!(
            answer(&json!({ "statusCode": 200, "headers": { "bad name": "x" } })).unwrap_err(),
            "\"bad name\" is not a header name"
        );
        assert_eq!(
            answer(&json!({ "statusCode": 200, "headers": { "X": "a\nb" } })).unwrap_err(),
            "the header X's value holds a line break or NUL"
        );
        assert_eq!(
            answer(&json!({ "statusCode": 200, "cookies": [1] })).unwrap_err(),
            "cookies must be a list of strings"
        );
        assert_eq!(
            answer(&json!({ "statusCode": 200, "cookies": ["a\nb", 1] })).unwrap_err(),
            "cookies must be a list of strings"
        );
    }

    #[test]
    fn a_request_becomes_the_event_the_backends_cases_say() {
        let table = table();
        let base = table["request"].as_object().unwrap();
        let mut checked = 0;
        for (group, cases) in table["events"].as_object().unwrap() {
            for case in cases.as_array().unwrap() {
                let title = format!("{group}: {}", case["title"]);
                let given = case["request"].as_object().unwrap();
                let mut fields = base.clone();
                fields.extend(given.clone());
                let text = |name: &str| fields.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
                let body = match (given.get("body"), given.get("bodyBase64")) {
                    (None, Some(base64)) => BASE64.decode(base64.as_str().unwrap()).unwrap(),
                    _ => text("body").into_bytes(),
                };
                let request = Request {
                    method: text("method"),
                    target: text("target"),
                    protocol: text("protocol"),
                    headers: pairs(&fields["headers"]),
                    body,
                };
                let caller = fields.get("caller").map(|caller| Caller {
                    access_key: caller["accessKey"].as_str().unwrap().into(),
                    account_id: caller["accountId"].as_str().unwrap().into(),
                    user_id: caller["userId"].as_str().unwrap().into(),
                });
                let without: Vec<&str> = fields
                    .get("withoutHeaders")
                    .and_then(Value::as_array)
                    .map(|names| names.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let event = event(&UrlRequest {
                    request: &request,
                    source_ip: &text("sourceIp"),
                    domain_name: &text("domainName"),
                    domain_prefix: &text("domainPrefix"),
                    url_id: &text("urlId"),
                    request_id: &text("requestId"),
                    time: humantime::parse_rfc3339(&text("time")).unwrap(),
                    account_id: &text("accountId"),
                    caller: caller.as_ref(),
                    without_headers: &without,
                });

                if let Some(whole) = case.get("event") {
                    assert_eq!(&event, whole, "{title}");
                }
                for (path, value) in case.get("has").and_then(Value::as_object).into_iter().flatten() {
                    assert_eq!(at(&event, path), Some(value), "{title}: {path}");
                }
                for key in case.get("lacks").and_then(Value::as_array).into_iter().flatten() {
                    assert_eq!(event.get(key.as_str().unwrap()), None, "{title}: {key}");
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 15, "every request of the table");
    }

    #[test]
    fn a_return_value_answers_as_the_backends_cases_say() {
        let table = table();
        let mut checked = 0;
        for (group, cases) in table["answers"].as_object().unwrap() {
            for case in cases.as_array().unwrap() {
                let title = format!("{group}: {}", case["title"]);
                let answered = answer(&case["output"]);
                if let Some(reason) = case.get("refused") {
                    assert_eq!(answered.as_ref().err().map(String::as_str), reason.as_str(), "{title}");
                } else {
                    let expected = &case["answer"];
                    let response = answered.unwrap_or_else(|reason| panic!("{title}: {reason}"));
                    // serde_json's objects keep their names in order: headers of different names compare in any
                    // order, Set-Cookie's in theirs.
                    let sorted = |mut headers: Vec<(String, String)>| {
                        headers.sort_by_key(|(name, _)| name.to_ascii_lowercase());
                        headers
                    };
                    let body = match expected.get("bodyBase64") {
                        Some(base64) => BASE64.decode(base64.as_str().unwrap()).unwrap(),
                        None => expected["body"].as_str().unwrap_or_default().as_bytes().to_vec(),
                    };
                    assert_eq!(response.status, expected["status"].as_u64().unwrap() as u16, "{title}");
                    assert_eq!(sorted(response.headers), sorted(pairs(&expected["headers"])), "{title}");
                    assert_eq!(response.body, body, "{title}");
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 19, "every return value of the table");
    }

    #[test]
    fn cors_answers_as_the_backends_cases_say() {
        let table = table();
        let cors = &table["cors"];
        let configuration: Cors = serde_json::from_value(cors["configuration"].clone()).unwrap();
        let mut checked = 0;
        for (group, cases) in cors.as_object().unwrap().iter().filter(|(group, _)| *group != "configuration") {
            for case in cases.as_array().unwrap() {
                let given = case.get("cors").map(|cors| serde_json::from_value::<Cors>(cors.clone()).unwrap());
                let cors = given.as_ref().unwrap_or(&configuration);
                let origin = case.get("origin").and_then(Value::as_str);
                let listed = |list: Vec<(String, String)>| json!(list.iter().map(|(n, v)| [n, v]).collect::<Vec<_>>());
                let answered = match case["ask"].as_str().unwrap() {
                    "isPreflight" => {
                        let headers: Vec<(String, String)> = case["headers"]
                            .as_object()
                            .unwrap()
                            .iter()
                            .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned()))
                            .collect();
                        let request =
                            Request { method: case["method"].as_str().unwrap().into(), headers, ..Request::default() };
                        json!(is_preflight(&request))
                    }
                    "allowsOrigin" => json!(cors.allows_origin(origin)),
                    "preflightHeaders" => listed(cors.preflight_headers(origin)),
                    "responseCorsHeaders" => listed(cors.response_headers(origin)),
                    "isCorsHeader" => json!(is_cors_header(case["name"].as_str().unwrap())),
                    other => panic!("{group}: no question {other}"),
                };
                assert_eq!(answered, case["is"], "{group}: {case}");
                checked += 1;
            }
        }
        assert_eq!(checked, 15, "every question of the table");
    }

    #[test]
    fn cors_is_refused_as_ff_refuses_it() {
        let ok = json!({ "allowOrigins": ["https://shop.example.tn:8443", "*"], "allowMethods": ["GET", "*"], "allowHeaders": ["*", "x-id"], "exposeHeaders": ["x-total"], "maxAge": 86400, "allowCredentials": null });
        assert_eq!(cors_refusals(&ok), []);
        let bad = json!({
            "allowOrigins": ["https://shop.example.tn/path"],
            "allowMethods": ["OPTIONS"],
            "allowHeaders": "content-type",
            "exposeHeaders": ["bad name"],
            "maxAge": 86401,
            "allowCredentials": "yes"
        });
        let refused: Vec<&str> = cors_refusals(&bad).iter().map(|(property, _)| *property).collect();
        assert_eq!(
            refused,
            ["AllowOrigins", "AllowMethods", "AllowHeaders", "ExposeHeaders", "AllowCredentials", "MaxAge"]
        );
        assert_eq!(
            cors_refusals(&json!({ "allowMethods": ["OPTIONS"] }))[0].1,
            "AllowMethods is a list of at most 6 of GET, PUT, HEAD, POST, PATCH, DELETE and *, as FF takes it, not \"OPTIONS\""
        );
        let seven = json!({ "allowMethods": ["GET", "PUT", "HEAD", "POST", "PATCH", "DELETE", "*"] });
        assert_eq!(cors_refusals(&seven).len(), 1);
        assert!(["https://a", "http://localhost:3000", "*"].iter().all(|origin| is_origin(origin)));
        assert!(
            ["https://", "://a", "1x://a", "https://a b", "https://a?b", "app.example.tn"]
                .iter()
                .all(|origin| !is_origin(origin))
        );
    }

    #[test]
    fn a_host_is_named_as_the_gateway_names_it() {
        assert_eq!(host_name(Some("Greeter.FN.localhost:3700")).as_deref(), Some("greeter.fn.localhost"));
        assert_eq!(host_name(Some("example.tn.")).as_deref(), Some("example.tn"));
        assert_eq!(host_name(Some("127.0.0.1:")).as_deref(), Some("127.0.0.1"));
        assert_eq!(host_name(Some("[::1]:3700")), None);
        assert_eq!(host_name(Some(":3700")), None);
        assert_eq!(host_name(None), None);
    }

    #[test]
    fn a_call_ends_in_its_answer_a_throttle_or_a_failure() {
        let said = std::sync::Mutex::new(Vec::new());
        let say = |line: &str| said.lock().unwrap().push(line.to_owned());
        assert_eq!(response_of(Ran::Output(json!({ "statusCode": 201 })), &say).status, 201);
        assert_eq!(response_of(Ran::Throttled, &say), message(429, "Too Many Requests"));
        assert_eq!(response_of(Ran::Failed, &say), message(502, "Internal Server Error"));
        assert_eq!(response_of(Ran::Output(json!({ "statusCode": 99 })), &say).status, 502);
        assert_eq!(
            said.into_inner().unwrap(),
            [
                "the function's answer can't be a response (statusCode must be a whole number from 200 to 599; got 99): 502"
            ]
        );
        assert_eq!(answer(&json!({ "statusCode": 201.0 })).unwrap().status, 201);
        let big = json!({ "body": "a".repeat(PAYLOAD_LIMIT) });
        assert_eq!(sized(big).unwrap_err(), too_large());
    }

    #[test]
    fn times_and_ids_are_as_api_gateways() {
        assert_eq!(request_time(at_time()), "21/Oct/2026:08:00:00 +0000");
        let id = http::request_id();
        assert!(id.len() == 36 && id.as_bytes()[14] == b'4', "{id}");
        assert_ne!(http::request_id(), id);
    }
}
