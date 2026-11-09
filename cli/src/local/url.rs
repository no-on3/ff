//! A function served on this machine as its URL serves it on FF: each HTTP request becomes AWS
//! Lambda's event for function URLs (API Gateway's payload 2.0), the function's answer becomes the
//! response by Lambda's rules, as the backend's gateway does (`BE/src/function-urls/url-event.ts`
//! and `url-response.ts`). What the gateway answers itself, it answers here the same way: a JSON
//! `Message`.

use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::SystemTime;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value, json};

use super::http::{self, Answers, PAYLOAD_LIMIT, percent_decode};
pub use super::http::{Request, Response};

/// Headers that belong to one connection, never passed on (RFC 9110, §7.6.1).
const HOP_BY_HOP: [&str; 7] =
    ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/// Headers the server sets itself: never the function's.
const SERVER_HEADERS: [&str; 8] =
    ["connection", "content-length", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

/// An answer the front gives itself, as the gateway does: a status, and a JSON Message.
pub fn message(status: u16, message: &str) -> Response {
    Response {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: json!({ "Message": message }).to_string().into_bytes(),
    }
}

/// API Gateway's request time, `12/Mar/2020:19:03:58 +0000`, in UTC.
pub fn request_time(time: SystemTime) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let rfc3339 = humantime::format_rfc3339_seconds(time).to_string(); // 2026-10-21T08:00:00Z
    let month = rfc3339[5..7].parse::<usize>().map(|month| MONTHS[month - 1]).unwrap_or("Jan");
    format!("{}/{month}/{}:{} +0000", &rfc3339[8..10], &rfc3339[..4], &rfc3339[11..19])
}

/// The event the request becomes: payload format 2.0, as a function URL sends it.
pub fn event(request: &Request, request_id: &str, time: SystemTime, source_ip: &str) -> Value {
    let (raw_path, raw_query) = match request.target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (request.target.as_str(), ""),
    };
    let raw_path = if raw_path.is_empty() { "/" } else { raw_path };
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
        } else if !HOP_BY_HOP.contains(&name.as_str()) {
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
    let host = header("host");
    let domain_name = host.rsplit_once(':').map(|(name, _)| name.to_owned()).unwrap_or(host);
    let domain_name = if domain_name.is_empty() { "127.0.0.1".to_owned() } else { domain_name };
    let domain_prefix = domain_name.split('.').next().unwrap_or("").to_owned();
    let epoch_ms = time.duration_since(SystemTime::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);

    let mut event = json!({
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": raw_path,
        "rawQueryString": raw_query,
        "headers": Value::Object(headers.clone()),
        "requestContext": {
            "accountId": "anonymous",
            "apiId": "local",
            "authentication": null,
            "domainName": domain_name,
            "domainPrefix": domain_prefix,
            "http": { "method": request.method, "path": raw_path, "protocol": request.protocol, "sourceIp": source_ip, "userAgent": header("user-agent") },
            "requestId": request_id,
            "routeKey": "$default",
            "stage": "$default",
            "time": request_time(time),
            "timeEpoch": epoch_ms
        },
        "isBase64Encoded": false
    });
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

fn is_token(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
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
    let status = match &response["statusCode"] {
        Value::Number(number) => number.as_u64(),
        Value::String(text) if text.bytes().all(|byte| byte.is_ascii_digit()) && !text.is_empty() => text.parse().ok(),
        _ => None,
    }
    .filter(|status| (200..=599).contains(status))
    .ok_or_else(|| format!("statusCode must be a whole number from 200 to 599; got {}", response["statusCode"]))?
        as u16;
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
        Some(Value::Array(cookies)) => {
            for cookie in cookies {
                let cookie = cookie.as_str().ok_or("cookies must be a list of strings")?;
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

/// Calls the function's container with the event, as the backend calls a pod; the response.
fn call(runtime_port: u16, event: &Value, request_id: &str, timeout: u32) -> Response {
    let ran = match super::call(runtime_port, event, Some(request_id), &super::Asks::default(), timeout) {
        Ok(ran) => ran,
        Err(error) => {
            eprintln!("ff local: {}", error.message);
            return message(502, "Internal Server Error");
        }
    };
    match ran.status {
        200 => {}
        // No instance was free in time: the caller may try again.
        429 => return message(429, "Too Many Requests"),
        // The function's own error, which the log has: the caller gets 502, as from the gateway.
        _ => return message(502, "Internal Server Error"),
    }
    let output: Value = serde_json::from_str(&ran.body).unwrap_or(Value::Null);
    match answer(&output) {
        Ok(response) if response.body.len() > PAYLOAD_LIMIT => {
            eprintln!("ff local: the function answered {} bytes, over the 6 MB limit: 502", response.body.len());
            message(502, "Internal Server Error")
        }
        Ok(response) => response,
        Err(reason) => {
            eprintln!("ff local: the function's answer can't be a response ({reason}): 502");
            message(502, "Internal Server Error")
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
        let event = event(request, request_id, SystemTime::now(), source_ip);
        call(self.runtime_port.load(Ordering::SeqCst), &event, request_id, self.timeout)
    }

    fn unreadable(&self, too_large: bool) -> Response {
        match too_large {
            true => message(413, "Request Entity Too Large"),
            false => message(400, "Bad Request"),
        }
    }
}

/// Serves the function's URL on the listener.
pub fn serve(listener: TcpListener, runtime_port: Arc<AtomicU16>, timeout: u32) {
    http::serve(listener, Arc::new(Front { runtime_port, timeout }));
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn request(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Request {
        Request {
            method: method.into(),
            target: target.into(),
            protocol: "HTTP/1.1".into(),
            headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            body: body.to_vec(),
        }
    }

    fn at() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(1_792_569_600_123) // 2026-10-21T08:00:00.123Z
    }

    #[test]
    fn a_request_becomes_lambdas_url_event() {
        let event = event(
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
            "req-1",
            at(),
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
            event(&request("PUT", "/", &[("Content-Type", "image/png")], &[0x89, b'P', b'N', b'G']), "r", at(), "::1");
        let empty = event(&request("GET", "", &[], b""), "r", at(), "::1");

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
    }

    #[test]
    fn times_and_ids_are_as_api_gateways() {
        assert_eq!(request_time(at()), "21/Oct/2026:08:00:00 +0000");
        let id = http::request_id();
        assert!(id.len() == 36 && id.as_bytes()[14] == b'4', "{id}");
        assert_ne!(http::request_id(), id);
    }
}
