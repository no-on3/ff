//! HTTP/1.1 as AWS's clients speak it, with the standard library alone, as `ff local start`'s function URLs are served
//! (cli/src/local_url.rs): a thread per connection, kept alive; a body by its length or chunked, read by the handler as
//! it needs it, "100 Continue" sent when it starts to; an answer from bytes or from a file.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

/// The request line and the headers together, at most.
const MAX_HEAD: usize = 64 * 1024;
/// A body left unread that is read and dropped before the next request; a longer one closes the connection.
const MAX_DRAINED: u64 = 1024 * 1024;

pub struct Request {
    pub method: String,
    pub raw_path: String,
    pub raw_query: String,
    /// The headers as sent, their names' case kept, values trimmed.
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        crate::sigv4::header(&self.headers, name)
    }
}

pub enum Body {
    Bytes(Vec<u8>),
    File(File, u64),
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, headers: vec![("Content-Type".into(), content_type.into())], body: Body::Bytes(body.into()) }
    }

    pub fn with(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

enum Framing {
    Length(u64),
    Chunked { remaining: u64, finished: bool },
}

/// A request's body, read by the handler as it needs it.
pub struct Incoming<'a> {
    pub request: Request,
    reader: &'a mut BufReader<TcpStream>,
    writer: &'a TcpStream,
    framing: Framing,
    expects_continue: bool,
}

impl Read for Incoming<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.expects_continue {
            self.expects_continue = false;
            (&*self.writer).write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        }
        match &mut self.framing {
            Framing::Length(remaining) => {
                if *remaining == 0 {
                    return Ok(0);
                }
                let want = buf.len().min(*remaining as usize);
                let read = self.reader.read(&mut buf[..want])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the client went before its body ended"));
                }
                *remaining -= read as u64;
                Ok(read)
            }
            Framing::Chunked { remaining, finished } => {
                if *finished {
                    return Ok(0);
                }
                if *remaining == 0 {
                    let line = read_line(self.reader)?;
                    let size = line.split(';').next().unwrap_or_default().trim();
                    *remaining = u64::from_str_radix(size, 16)
                        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a malformed chunk size"))?;
                    if *remaining == 0 {
                        while !read_line(self.reader)?.is_empty() {}
                        *finished = true;
                        return Ok(0);
                    }
                }
                let want = buf.len().min(*remaining as usize);
                let read = self.reader.read(&mut buf[..want])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the client went before its body ended"));
                }
                *remaining -= read as u64;
                if *remaining == 0 {
                    read_line(self.reader)?;
                }
                Ok(read)
            }
        }
    }
}

impl Incoming<'_> {
    /// The whole body, at most `limit` bytes; None past it.
    pub fn read_whole(&mut self, limit: u64) -> io::Result<Option<Vec<u8>>> {
        let mut body = Vec::new();
        (&mut *self).take(limit + 1).read_to_end(&mut body)?;
        Ok((body.len() as u64 <= limit).then_some(body))
    }

    /// Whether the body was all read, or read now when short, so that the connection can take the next request.
    fn drained(&mut self) -> bool {
        if self.expects_continue {
            // The client waits for a "100 Continue" never sent: it sends no body, and the connection can't go on.
            return false;
        }
        let left = match self.framing {
            Framing::Length(remaining) => remaining,
            Framing::Chunked { finished: true, .. } => 0,
            Framing::Chunked { .. } => MAX_DRAINED,
        };
        left < MAX_DRAINED && io::copy(&mut (&mut *self).take(MAX_DRAINED), &mut io::sink()).is_ok()
    }
}

fn read_line(reader: &mut impl BufRead) -> io::Result<String> {
    let mut line = Vec::new();
    reader.by_ref().take(MAX_HEAD as u64).read_until(b'\n', &mut line)?;
    if !line.ends_with(b"\n") {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a line without its end"));
    }
    while line.last().is_some_and(|byte| *byte == b'\n' || *byte == b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a line that isn't UTF-8"))
}

/// The next request's line and headers; None when the client closed the connection between requests.
fn read_head(reader: &mut BufReader<TcpStream>) -> io::Result<Option<Request>> {
    if reader.fill_buf()?.is_empty() {
        return Ok(None);
    }
    let line = read_line(reader)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(_version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "a malformed request line"));
    };
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers = Vec::new();
    let mut size = line.len();
    loop {
        let line = read_line(reader)?;
        size += line.len();
        if size > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "headers too large"));
        }
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a malformed header"));
        };
        headers.push((name.to_string(), value.trim().to_string()));
    }
    Ok(Some(Request { method: method.into(), raw_path: raw_path.into(), raw_query: raw_query.into(), headers }))
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "Unknown",
    }
}

fn write_response(stream: &mut TcpStream, response: Response, head_only: bool, close: bool) -> io::Result<()> {
    let length = match &response.body {
        Body::Bytes(bytes) => bytes.len() as u64,
        Body::File(_, length) => *length,
    };
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason(response.status));
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {length}\r\n"));
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    let mut out = io::BufWriter::with_capacity(64 * 1024, stream);
    out.write_all(head.as_bytes())?;
    if !head_only {
        match response.body {
            Body::Bytes(bytes) => out.write_all(&bytes)?,
            Body::File(file, length) => {
                io::copy(&mut file.take(length), &mut out)?;
            }
        }
    }
    out.flush()
}

pub type Handler = dyn Fn(&mut Incoming) -> Response + Send + Sync;

/// Answers every connection on its own thread, until the process ends.
pub fn serve(listener: TcpListener, handler: Arc<Handler>) {
    for stream in listener.incoming().flatten() {
        let handler = Arc::clone(&handler);
        std::thread::spawn(move || {
            let _ = connection(stream, &*handler);
        });
    }
}

fn connection(stream: TcpStream, handler: &Handler) -> io::Result<()> {
    stream.set_nodelay(true)?;
    // A connection silent for two minutes goes, as the backend's front door lets one.
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    let mut reader = BufReader::with_capacity(64 * 1024, stream.try_clone()?);
    let mut writer = stream;
    loop {
        let Some(request) = read_head(&mut reader)? else { return Ok(()) };
        let chunked = request.header("transfer-encoding").is_some_and(|value| value.eq_ignore_ascii_case("chunked"));
        let length = request.header("content-length").map(|value| value.parse::<u64>());
        let framing = match (chunked, length) {
            (true, _) => Framing::Chunked { remaining: 0, finished: false },
            (false, Some(Ok(length))) => Framing::Length(length),
            (false, None) => Framing::Length(0),
            (false, Some(Err(_))) => return write_response(&mut writer, bad_request(), false, true),
        };
        let expects_continue = request.header("expect").is_some_and(|value| value.eq_ignore_ascii_case("100-continue"));
        let wants_close = request.header("connection").is_some_and(|value| value.eq_ignore_ascii_case("close"));
        let head_only = request.method == "HEAD";
        let mut incoming = Incoming { request, reader: &mut reader, writer: &writer, framing, expects_continue };
        let response = handler(&mut incoming);
        let close = wants_close || !incoming.drained();
        write_response(&mut writer, response, head_only, close)?;
        if close {
            return Ok(());
        }
    }
}

fn bad_request() -> Response {
    Response::new(400, "text/plain", "a malformed request")
}
