//! What the binary's tests share: `ff` in a folder of its own, with none of the caller's settings,
//! and a scripted API that answers each request with the next reply, in order, and records what
//! it was sent.

#![allow(dead_code, reason = "each test file uses its own part")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use assert_cmd::Command;
use tempfile::TempDir;

pub const KEY: &str = "ffk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe";

/// `ff` with its settings in `dir`, and none of the environment's: no token, endpoint, account,
/// profile or proxy.
pub fn ff(dir: &TempDir) -> Command {
    let mut command = Command::cargo_bin("ff").expect("the ff binary is built");
    command.env("FF_CONFIG_DIR", dir.path());
    for name in [
        "FF_TOKEN",
        "FF_ENDPOINT",
        "FF_ACCOUNT",
        "FF_PROFILE",
        "NO_COLOR",
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env_remove(name);
    }
    command
}

/// A folder of settings with `config.toml` and `credentials.toml` as given, when given.
pub fn settings(config: &str, credentials: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    if !config.is_empty() {
        std::fs::write(dir.path().join("config.toml"), config).unwrap();
    }
    if !credentials.is_empty() {
        std::fs::write(dir.path().join("credentials.toml"), credentials).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path().join("credentials.toml"), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
    }
    dir
}

/// A profile that calls `url` with the test key.
pub fn with_key(url: &str) -> TempDir {
    settings(
        &format!("[profiles.default]\nendpoint = \"{url}\"\n"),
        &format!("[profiles.default]\ntoken = \"{KEY}\"\n"),
    )
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

pub struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    pub fn json(status: u16, body: serde_json::Value) -> Reply {
        Reply { status, headers: vec![("content-type".into(), "application/json".into())], body: body.to_string() }
    }

    /// Text of a media type, such as CSV.
    pub fn text(status: u16, content_type: &str, body: &str) -> Reply {
        Reply { status, headers: vec![("content-type".into(), content_type.into())], body: body.to_owned() }
    }

    /// Server-Sent Events, as the live tail sends them: the stream ends with the reply.
    pub fn events(events: &str) -> Reply {
        Reply {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: events.to_owned(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.into(), value.into()));
        self
    }
}

pub struct Server {
    pub url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    /// Answers each connection's request with the next reply, then closes it; then stops
    /// listening, so that a request too many finds nobody.
    pub fn start(replies: Vec<Reply>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        thread::spawn(move || {
            for reply in replies {
                let Ok((stream, _)) = listener.accept() else { return };
                let request = read_request(&stream);
                recorded.lock().unwrap().push(request);
                write_reply(stream, &reply);
            }
        });
        Server { url, requests }
    }

    /// What it was sent so far.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_request(stream: &TcpStream) -> Request {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    Request { method, path, headers, body: String::from_utf8(body).unwrap() }
}

fn write_reply(mut stream: TcpStream, reply: &Reply) {
    let mut head =
        format!("HTTP/1.1 {} Reason\r\ncontent-length: {}\r\nconnection: close\r\n", reply.status, reply.body.len());
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(reply.body.as_bytes());
}

/// An address where nothing listens.
pub fn unreachable_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
}
