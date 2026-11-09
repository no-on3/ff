//! What the binary's tests share: `ff` in a folder of its own, with none of the caller's settings,
//! and a scripted API that answers each request with the next reply, in order, and records what
//! it was sent.

#![allow(dead_code, reason = "each test file uses its own part")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
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
        owner_alone(&dir.path().join("credentials.toml"));
    }
    dir
}

/// Makes a file its owner's alone, as ff makes its credentials: mode 0600 on Unix; on Windows, an access list of its
/// own for the user running the tests, inherited from no folder.
pub fn owner_alone(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(windows)]
    {
        let made = std::process::Command::new("icacls")
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("{}:F", windows_user()))
            .output()
            .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
    }
}

/// That only its owner may read the file, as its system says: its mode on Unix; on Windows its access list, which
/// must hold the user running the tests alone, inherited from no folder.
pub fn assert_owner_alone(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600, "{}", path.display());
    }
    #[cfg(windows)]
    {
        let (entries, user) = (access_list(path), windows_user());
        assert!(
            entries.len() == 1 && entries[0].eq_ignore_ascii_case(&format!("{user}:(F)")),
            "{entries:?}, the user being {user}"
        );
    }
}

/// The user running the tests as icacls names it, `DOMAIN\name`.
#[cfg(windows)]
pub fn windows_user() -> String {
    let variable = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("Windows sets {name}"));
    format!("{}\\{}", variable("USERDOMAIN"), variable("USERNAME"))
}

/// A file's access list as icacls lists it: an entry a line, `DOMAIN\name:(rights)`, `(I)` marking an inherited one.
#[cfg(windows)]
pub fn access_list(path: &Path) -> Vec<String> {
    let listed = std::process::Command::new("icacls").arg(path).output().unwrap();
    let text = String::from_utf8_lossy(&listed.stdout).into_owned();
    let shown = path.display().to_string();
    text.lines()
        .take_while(|line| !line.trim().is_empty())
        .map(|line| line.strip_prefix(shown.as_str()).unwrap_or(line).trim().to_owned())
        .collect()
}

/// The realm's issuer, when the scripted server answers as the API and as its realm.
pub fn issuer(url: &str) -> String {
    format!("{url}/realms/ff")
}

/// A profile calling `url`, with a login whose access token ends at `expires_at`, and maybe an API key.
pub fn logged_in(url: &str, expires_at: &str, key: bool) -> TempDir {
    let key = if key { format!("token = \"{KEY}\"\n") } else { String::new() };
    settings(
        &format!("[profiles.default]\nendpoint = \"{url}\"\n"),
        &format!(
            "[profiles.default]\n{key}issuer = \"{}\"\naccess_token = \"old-access\"\nrefresh_token = \"old-refresh\"\nexpires_at = \"{expires_at}\"\n",
            issuer(url)
        ),
    )
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
    /// The body as text, for JSON; `bytes` holds it as sent, for a zip.
    pub body: String,
    pub bytes: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

pub struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, body: serde_json::Value) -> Reply {
        Reply::bytes(status, "application/json", body.to_string().into_bytes())
    }

    /// Text of a media type, such as CSV.
    pub fn text(status: u16, content_type: &str, body: &str) -> Reply {
        Reply::bytes(status, content_type, body.as_bytes().to_vec())
    }

    /// Bytes of a media type, such as a function's zip.
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Reply {
        Reply { status, headers: vec![("content-type".into(), content_type.into())], body }
    }

    /// Server-Sent Events, as the live tail sends them: the stream ends with the reply.
    pub fn events(events: &str) -> Reply {
        Reply::text(200, "text/event-stream", events)
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
        Server::bind().serve(replies)
    }

    /// A server whose address is known before its replies are: for a reply that names it.
    pub fn bind() -> Bound {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        Bound { listener, url }
    }

    /// What it was sent so far.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

/// A server listening, without its replies yet.
pub struct Bound {
    listener: TcpListener,
    pub url: String,
}

impl Bound {
    pub fn port(&self) -> u16 {
        self.listener.local_addr().unwrap().port()
    }

    pub fn serve(self, replies: Vec<Reply>) -> Server {
        let Bound { listener, url } = self;
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
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).unwrap();
    Request { method, path, headers, body: String::from_utf8_lossy(&bytes).into_owned(), bytes }
}

fn write_reply(mut stream: TcpStream, reply: &Reply) {
    let mut head =
        format!("HTTP/1.1 {} Reason\r\ncontent-length: {}\r\nconnection: close\r\n", reply.status, reply.body.len());
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&reply.body);
}

/// An address where nothing listens.
pub fn unreachable_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
}
