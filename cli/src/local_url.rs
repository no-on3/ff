//! A function served on this machine as its URL serves it on FF: each HTTP request becomes AWS
//! Lambda's event for function URLs (API Gateway's payload 2.0), the function's answer becomes the
//! response by Lambda's rules, as the backend's gateway does (`BE/src/function-urls/url-event.ts`
//! and `url-response.ts`). What the gateway answers itself, it answers here the same way: a JSON
//! `Message`.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value, json};

/// A request, and a response, may hold 6 MB, as on Lambda.
const PAYLOAD_LIMIT: usize = 6 * 1024 * 1024;
/// Headers that belong to one connection, never passed on (RFC 9110, §7.6.1).
const HOP_BY_HOP: [&str; 7] =
    ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/// Headers the server sets itself: never the function's.
const SERVER_HEADERS: [&str; 8] =
    ["connection", "content-length", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

/// A request as the front read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// The path and query string, as the request line has them.
    pub target: String,
    pub protocol: String,
    /// In order, as sent.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// A response to send.
#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// An answer the front gives itself, as the gateway does: a status, and a JSON Message.
pub fn message(status: u16, message: &str) -> Response {
    Response {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: json!({ "Message": message }).to_string().into_bytes(),
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                match hex {
                    Some(byte) => {
                        decoded.push(byte);
                        index += 2;
                    }
                    None => decoded.push(b'%'),
                }
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// API Gateway's request time, `12/Mar/2020:19:03:58 +0000`, in UTC.
pub fn request_time(time: SystemTime) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let rfc3339 = humantime::format_rfc3339_seconds(time).to_string(); // 2026-10-21T08:00:00Z
    let month = rfc3339[5..7].parse::<usize>().map(|month| MONTHS[month - 1]).unwrap_or("Jan");
    format!("{}/{month}/{}:{} +0000", &rfc3339[8..10], &rfc3339[..4], &rfc3339[11..19])
}

/// A random UUID, version 4, for each call's request ID.
pub fn request_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
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

/// Reads one request: its line, its headers, and its body by its length or its chunks.
pub fn read_request(stream: &mut impl BufRead) -> io::Result<Option<Request>> {
    let mut line = String::new();
    if stream.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let (method, target, protocol) =
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("HTTP/1.1"));
    let mut request = Request {
        method: method.to_owned(),
        target: target.to_owned(),
        protocol: protocol.to_owned(),
        ..Default::default()
    };
    loop {
        let mut line = String::new();
        stream.read_line(&mut line)?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            request.headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    let header = |name: &str| {
        request.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.clone())
    };
    if header("transfer-encoding").is_some_and(|encoding| encoding.eq_ignore_ascii_case("chunked")) {
        loop {
            let mut size = String::new();
            stream.read_line(&mut size)?;
            let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
            if request.body.len() + size > PAYLOAD_LIMIT {
                return Err(io::Error::new(io::ErrorKind::FileTooLarge, "over 6 MB"));
            }
            let mut chunk = vec![0; size + 2];
            stream.read_exact(&mut chunk)?;
            if size == 0 {
                break;
            }
            request.body.extend_from_slice(&chunk[..size]);
        }
    } else if let Some(length) = header("content-length").and_then(|length| length.parse::<usize>().ok()) {
        if length > PAYLOAD_LIMIT {
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "over 6 MB"));
        }
        request.body = vec![0; length];
        stream.read_exact(&mut request.body)?;
    }
    Ok(Some(request))
}

fn write_response(stream: &mut TcpStream, response: &Response, request_id: &str, head_only: bool) -> io::Result<()> {
    let reason = ureq::http::StatusCode::from_u16(response.status)
        .ok()
        .and_then(|status| status.canonical_reason())
        .unwrap_or("");
    let mut head =
        format!("HTTP/1.1 {} {reason}\r\nx-amzn-RequestId: {request_id}\r\nconnection: close\r\n", response.status);
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let bodiless = matches!(response.status, 204 | 304);
    if !bodiless {
        head.push_str(&format!("content-length: {}\r\n", response.body.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if !bodiless && !head_only {
        stream.write_all(&response.body)?;
    }
    stream.flush()
}

/// Calls the function's container with the event, as the backend calls a pod; the response.
fn call(runtime_port: u16, event: &Value, request_id: &str, timeout: u32) -> Response {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(u64::from(timeout) + 10)))
        .proxy(None)
        .build()
        .into();
    let sent = agent
        .post(format!("http://127.0.0.1:{runtime_port}/invoke"))
        .header("content-type", "application/json")
        .header("x-ff-request-id", request_id)
        .send(event.to_string());
    let mut reply = match sent {
        Ok(reply) => reply,
        Err(error) => {
            eprintln!("ff local: the function's container didn't answer ({error})");
            return message(502, "Internal Server Error");
        }
    };
    let status = reply.status().as_u16();
    let mut text = String::new();
    let _ = reply.body_mut().as_reader().read_to_string(&mut text);
    match status {
        200 => {}
        // No instance was free in time: the caller may try again.
        429 => return message(429, "Too Many Requests"),
        // The function's own error, which the log has: the caller gets 502, as from the gateway.
        _ => return message(502, "Internal Server Error"),
    }
    let output: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
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

/// Serves the function's URL on the listener, each request on a thread of its own, calling the
/// container on the port the shared value names (a restart, with `--watch`, changes it).
pub fn serve(listener: TcpListener, runtime_port: Arc<AtomicU16>, timeout: u32) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let runtime_port = Arc::clone(&runtime_port);
            thread::spawn(move || {
                let mut stream = stream;
                let source_ip = stream
                    .peer_addr()
                    .map(|address| address.ip().to_string())
                    .unwrap_or_else(|_| "127.0.0.1".to_owned());
                let request_id = request_id();
                let read =
                    BufReader::new(stream.try_clone().expect("a socket clones")).take(PAYLOAD_LIMIT as u64 + 64 * 1024);
                let mut reader = BufReader::new(read);
                let (response, head_only) = match read_request(&mut reader) {
                    Ok(Some(request)) => {
                        let event = event(&request, &request_id, SystemTime::now(), &source_ip);
                        (
                            call(runtime_port.load(Ordering::SeqCst), &event, &request_id, timeout),
                            request.method == "HEAD",
                        )
                    }
                    Ok(None) => return,
                    Err(error) if error.kind() == io::ErrorKind::FileTooLarge => {
                        (message(413, "Request Entity Too Large"), false)
                    }
                    Err(_) => (message(400, "Bad Request"), false),
                };
                let _ = write_response(&mut stream, &response, &request_id, head_only);
            });
        }
    });
}

#[cfg(test)]
mod tests {
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
    fn a_request_is_read_by_its_length_or_its_chunks() {
        let by_length = b"POST /a?b=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhelloEXTRA";
        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";

        let first = read_request(&mut &by_length[..]).unwrap().unwrap();
        let second = read_request(&mut &chunked[..]).unwrap().unwrap();

        assert_eq!(
            (first.method.as_str(), first.target.as_str(), first.body.as_slice()),
            ("POST", "/a?b=1", &b"hello"[..])
        );
        assert_eq!(second.body, b"hello world");
        let too_large = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", PAYLOAD_LIMIT + 1);
        assert_eq!(read_request(&mut too_large.as_bytes()).unwrap_err().kind(), io::ErrorKind::FileTooLarge);
    }

    #[test]
    fn times_and_ids_are_as_api_gateways() {
        assert_eq!(request_time(at()), "21/Oct/2026:08:00:00 +0000");
        let id = request_id();
        assert!(id.len() == 36 && id.as_bytes()[14] == b'4', "{id}");
        assert_ne!(request_id(), id);
    }
}
