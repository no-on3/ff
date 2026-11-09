//! HTTP on this machine for `ff local`, from the standard library alone: a thread per connection, one request each, its
//! response closing it. What answers is the caller's: a function's URL, or the front door to a template's app. A body
//! is read whole before the answer, but one the answer reads as it streams, as S3's uploads are; "100 Continue" is
//! sent when the body is first read, so that a request refused before is never sent; and an answer may be a file's
//! bytes, sent as they are read.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// A request, and a response, may hold 6 MB, as on Lambda.
pub const PAYLOAD_LIMIT: usize = 6 * 1024 * 1024;
/// The request's line and its headers together, at most.
const MAX_HEAD: usize = 64 * 1024;
/// A body the answer left unread is read and dropped before the connection closes, so that the client reads the
/// answer rather than the connection's reset, up to this; past it, the connection closes on it.
const MAX_DRAINED: u64 = 1024 * 1024;
/// A connection silent for this long goes, as the backend's front door lets one.
const SILENCE: Duration = Duration::from_secs(120);

/// A request as the server read it.
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

impl Request {
    /// The first value of a header, by its name in any case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

/// A response to send.
#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// What answers the requests a server reads.
pub trait Answers: Send + Sync + 'static {
    /// The response to a request, given its ID, which the response carries as `x-amzn-RequestId`, and the caller's
    /// address.
    fn answer(&self, request: &Request, request_id: &str, source_ip: &str) -> Response;

    /// The response to a request that couldn't be read: over the payload's limit, or not HTTP; its line and its
    /// headers, when they were read.
    fn unreadable(&self, too_large: bool, head: Option<&Request>) -> Response;

    /// The most a request's body may hold, by its line and its headers: the payload's limit, unless a service's is less.
    fn limit(&self, _head: &Request) -> usize {
        PAYLOAD_LIMIT
    }

    /// Whether the answer reads the request's body itself, as it streams, by its line and its headers.
    fn streams(&self, _head: &Request) -> bool {
        false
    }

    /// The answer to a request whose body `streams`, which reads it from `body` as it needs it: its line and its
    /// headers in `head`, its body none.
    fn answer_streaming(&self, head: &Request, _body: &mut Incoming, request_id: &str, source_ip: &str) -> Reply {
        Reply::Whole(self.answer(head, request_id, source_ip))
    }
}

/// An answer: a response whose body is in memory, or `length` bytes of a file, from where it is read, the file none
/// for a HEAD.
pub enum Reply {
    Whole(Response),
    File { response: Response, file: Option<File>, length: u64 },
}

/// How a request's body is framed: by its length, or in chunks.
enum Framing {
    Length(u64),
    Chunked { remaining: u64, finished: bool },
}

/// A request's body, read as it comes: by its length or its chunks, their framing taken off; "100 Continue" sent at
/// its first read, when the client waits for it.
pub struct Incoming<'a> {
    reader: &'a mut dyn BufRead,
    writer: &'a mut dyn Write,
    framing: Framing,
    expects_continue: bool,
}

impl Read for Incoming<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.expects_continue {
            self.expects_continue = false;
            self.writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            self.writer.flush()?;
        }
        let ended = || io::Error::new(io::ErrorKind::UnexpectedEof, "the client went before its body ended");
        let remaining = match &mut self.framing {
            Framing::Length(0) | Framing::Chunked { finished: true, .. } => return Ok(0),
            Framing::Length(remaining) => remaining,
            Framing::Chunked { remaining, finished } => {
                if *remaining == 0 {
                    let line = read_line(self.reader)?;
                    let size = line.split(';').next().unwrap_or_default().trim();
                    *remaining = u64::from_str_radix(size, 16)
                        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a malformed chunk's size"))?;
                    if *remaining == 0 {
                        // The trailer's lines, to the empty one.
                        while !read_line(self.reader)?.is_empty() {}
                        *finished = true;
                        return Ok(0);
                    }
                }
                remaining
            }
        };
        let want = buf.len().min(usize::try_from(*remaining).unwrap_or(usize::MAX));
        let read = self.reader.read(&mut buf[..want])?;
        if read == 0 {
            return Err(ended());
        }
        *remaining -= read as u64;
        if *remaining == 0 && matches!(self.framing, Framing::Chunked { .. }) && !read_line(self.reader)?.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a chunk longer than its size"));
        }
        Ok(read)
    }
}

impl<'a> Incoming<'a> {
    /// The body of a request by its headers: by its length, or chunked; an unreadable length an error.
    pub fn of(head: &Request, reader: &'a mut dyn BufRead, writer: &'a mut dyn Write) -> io::Result<Self> {
        let chunked = head.header("transfer-encoding").is_some_and(|encoding| encoding.eq_ignore_ascii_case("chunked"));
        let framing = match head.header("content-length") {
            _ if chunked => Framing::Chunked { remaining: 0, finished: false },
            Some(length) => Framing::Length(
                length.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a malformed length"))?,
            ),
            None => Framing::Length(0),
        };
        let expects_continue = head.header("expect").is_some_and(|expect| expect.eq_ignore_ascii_case("100-continue"));
        Ok(Self { reader, writer, framing, expects_continue })
    }

    /// The whole body, up to `limit` bytes; past it, an error of the kind `FileTooLarge`.
    pub fn read_whole(&mut self, limit: usize) -> io::Result<Vec<u8>> {
        if let Framing::Length(length) = self.framing
            && length > limit as u64
        {
            return Err(too_large());
        }
        let mut body = Vec::new();
        (&mut *self).take(limit as u64 + 1).read_to_end(&mut body)?;
        if body.len() > limit {
            return Err(too_large());
        }
        Ok(body)
    }

    /// The body the answer left unread, read and dropped when it is short.
    fn drain(&mut self) {
        let left = match self.framing {
            // The client waits for a "100 Continue" never sent: it sends no body.
            _ if self.expects_continue => 0,
            Framing::Length(remaining) => remaining,
            Framing::Chunked { finished: true, .. } => 0,
            Framing::Chunked { .. } => MAX_DRAINED,
        };
        if left > 0 && left < MAX_DRAINED {
            let _ = io::copy(&mut (&mut *self).take(MAX_DRAINED), &mut io::sink());
        }
    }
}

fn too_large() -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, "over the limit")
}

/// A line of the request's head, or of a chunk's framing, without its end: at most the head's limit.
fn read_line(reader: &mut dyn BufRead) -> io::Result<String> {
    let mut line = Vec::new();
    reader.take(MAX_HEAD as u64).read_until(b'\n', &mut line)?;
    if !line.ends_with(b"\n") {
        let kind = if line.len() >= MAX_HEAD { io::ErrorKind::InvalidData } else { io::ErrorKind::UnexpectedEof };
        return Err(io::Error::new(kind, "a line without its end"));
    }
    while line.last().is_some_and(|byte| *byte == b'\n' || *byte == b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a line that isn't UTF-8"))
}

/// A random UUID, version 4, for each request's ID.
pub fn request_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// A query's part, or a path's, decoded as a form's: `%XX` its byte, `+` a space.
pub fn percent_decode(text: &str) -> String {
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

/// Reads one request: its line, its headers, and its body by its length or its chunks.
#[cfg(test)]
pub fn read_request(stream: &mut impl BufRead) -> io::Result<Option<Request>> {
    let Some(mut request) = read_head(stream)? else { return Ok(None) };
    request.body = Incoming::of(&request, stream, &mut io::sink())?.read_whole(PAYLOAD_LIMIT)?;
    Ok(Some(request))
}

/// Reads a request's line and its headers, at most the head's limit together; none when the connection closed first.
fn read_head(stream: &mut dyn BufRead) -> io::Result<Option<Request>> {
    if stream.fill_buf()?.is_empty() {
        return Ok(None);
    }
    let line = read_line(stream)?;
    let mut size = line.len();
    let mut parts = line.splitn(3, ' ');
    let (method, target, protocol) =
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("HTTP/1.1"));
    let mut request = Request {
        method: method.to_owned(),
        target: target.to_owned(),
        protocol: protocol.to_owned(),
        ..Default::default()
    };
    loop {
        let line = read_line(stream)?;
        size += line.len();
        if size > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a head over its limit"));
        }
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            request.headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    Ok(Some(request))
}

/// Writes the response, its request's ID with it, as HTTP/1.1 closing the connection; its head alone for HEAD.
pub fn write_response(
    stream: &mut impl Write,
    response: &Response,
    request_id: &str,
    head_only: bool,
) -> io::Result<()> {
    let bodiless = write_head(stream, response, response.body.len() as u64, request_id)?;
    if !bodiless && !head_only {
        stream.write_all(&response.body)?;
    }
    stream.flush()
}

/// Writes the response's line and headers, its body's length among them, but for a status that has no body: whether
/// it has none.
fn write_head(stream: &mut impl Write, response: &Response, length: u64, request_id: &str) -> io::Result<bool> {
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
        head.push_str(&format!("content-length: {length}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    Ok(bodiless)
}

/// Writes an answer, as `write_response` writes a response; a file's bytes as they are read.
fn write_reply(stream: &mut impl Write, reply: Reply, request_id: &str, head_only: bool) -> io::Result<()> {
    match reply {
        Reply::Whole(response) => write_response(stream, &response, request_id, head_only),
        Reply::File { response, file, length } => {
            let mut out = io::BufWriter::with_capacity(64 * 1024, stream);
            let bodiless = write_head(&mut out, &response, length, request_id)?;
            if let (false, false, Some(file)) = (bodiless, head_only, file) {
                let sent = io::copy(&mut file.take(length), &mut out)?;
                if sent < length {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a file shorter than its answer"));
                }
            }
            out.flush()
        }
    }
}

/// Serves the listener, each request on a thread of its own, answered by `answers`.
pub fn serve(listener: TcpListener, answers: Arc<dyn Answers>) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let answers = Arc::clone(&answers);
            thread::spawn(move || {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(SILENCE));
                let source_ip = stream
                    .peer_addr()
                    .map(|address| address.ip().to_string())
                    .unwrap_or_else(|_| "127.0.0.1".to_owned());
                let request_id = request_id();
                let Ok(read) = stream.try_clone() else { return };
                let mut reader = BufReader::with_capacity(64 * 1024, read);
                let mut request = match read_head(&mut reader) {
                    Ok(Some(request)) => request,
                    Ok(None) => return,
                    Err(_) => {
                        let _ = write_response(&mut stream, &answers.unreadable(false, None), &request_id, false);
                        return;
                    }
                };
                let head_only = request.method == "HEAD";
                let mut writer = stream.try_clone().ok();
                let mut sink = io::sink();
                let continued: &mut dyn Write = match &mut writer {
                    Some(writer) => writer,
                    None => &mut sink,
                };
                let mut body = match Incoming::of(&request, &mut reader, continued) {
                    Ok(body) => body,
                    Err(_) => {
                        let _ =
                            write_response(&mut stream, &answers.unreadable(false, Some(&request)), &request_id, false);
                        return;
                    }
                };
                let reply = if answers.streams(&request) {
                    let reply = answers.answer_streaming(&request, &mut body, &request_id, &source_ip);
                    body.drain();
                    reply
                } else {
                    Reply::Whole(match body.read_whole(answers.limit(&request)) {
                        Ok(read) => {
                            request.body = read;
                            answers.answer(&request, &request_id, &source_ip)
                        }
                        Err(error) => answers.unreadable(error.kind() == io::ErrorKind::FileTooLarge, Some(&request)),
                    })
                };
                let _ = write_reply(&mut stream, reply, &request_id, head_only);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use std::io::Seek;

    use super::*;

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
        assert_eq!((first.header("HOST"), first.header("accept")), (Some("x"), None));
        assert_eq!(second.body, b"hello world");
        let too_large = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", PAYLOAD_LIMIT + 1);
        assert_eq!(read_request(&mut too_large.as_bytes()).unwrap_err().kind(), io::ErrorKind::FileTooLarge);
        let long_head = format!("GET / HTTP/1.1\r\nX-Long: {}\r\n\r\n", "x".repeat(MAX_HEAD));
        assert_eq!(read_request(&mut long_head.as_bytes()).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    fn head(headers: &[(&str, &str)]) -> Request {
        let headers = headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        Request { method: "PUT".into(), target: "/".into(), protocol: "HTTP/1.1".into(), headers, body: Vec::new() }
    }

    /// What `read` makes of a body sent as `sent` with these headers, what the client got meanwhile, and what is left
    /// of `sent`.
    fn reading<T>(
        headers: &[(&str, &str)],
        sent: &[u8],
        read: impl FnOnce(&mut Incoming) -> T,
    ) -> (T, Vec<u8>, Vec<u8>) {
        let (mut reader, mut written) = (sent, Vec::new());
        let head = head(headers);
        let read = read(&mut Incoming::of(&head, &mut reader, &mut written).unwrap());
        (read, written, reader.to_vec())
    }

    #[test]
    fn a_body_is_read_as_it_comes_100_continue_sent_at_its_first_read_alone() {
        let chunked = b"5;name=value\r\nhello\r\n6\r\n world\r\n0\r\nx-trailer: 1\r\n\r\nNEXT";
        let waiting = [("Transfer-Encoding", "chunked"), ("Expect", "100-continue")];

        let (whole, continued, left) = reading(&waiting, chunked, |body| body.read_whole(100).unwrap());
        let (_, never, _) = reading(&waiting, chunked, |_| ());
        let (sized, nothing, rest) =
            reading(&[("Content-Length", "5")], b"helloEXTRA", |body| body.read_whole(5).unwrap());

        assert_eq!(
            (whole.as_slice(), continued.as_slice(), left.as_slice()),
            (&b"hello world"[..], &b"HTTP/1.1 100 Continue\r\n\r\n"[..], &b"NEXT"[..])
        );
        assert!(never.is_empty(), "a request answered before its body is read");
        assert_eq!((sized.as_slice(), nothing.as_slice(), rest.as_slice()), (&b"hello"[..], &b""[..], &b"EXTRA"[..]));
        let kind = |headers: &[(&str, &str)], sent: &[u8]| {
            reading(headers, sent, |body| body.read_whole(5).unwrap_err().kind()).0
        };
        assert_eq!(kind(&[("Content-Length", "6")], b"sixsix"), io::ErrorKind::FileTooLarge);
        assert_eq!(kind(&[("Transfer-Encoding", "chunked")], b"6\r\nsixsix\r\n0\r\n\r\n"), io::ErrorKind::FileTooLarge);
        assert_eq!(kind(&[("Transfer-Encoding", "chunked")], b"3\r\nhello\r\n0\r\n\r\n"), io::ErrorKind::InvalidData);
        assert_eq!(kind(&[("Content-Length", "5")], b"hel"), io::ErrorKind::UnexpectedEof);
        let (mut reader, mut written) = (&b""[..], Vec::new());
        assert!(Incoming::of(&head(&[("Content-Length", "five")]), &mut reader, &mut written).is_err());
        let (_, _, drained) = reading(&[("Content-Length", "10")], b"0123456789NEXT", |body| body.drain());
        assert_eq!(drained, b"NEXT");
    }

    #[test]
    fn a_file_is_answered_its_length_its_bytes_as_they_are_read_and_none_for_a_head() {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"0123456789").unwrap();
        file.seek(io::SeekFrom::Start(2)).unwrap();
        let response =
            || Response { status: 206, headers: vec![("x-amz-request-id".into(), "an-id".into())], body: Vec::new() };
        let (mut sent, mut head_only) = (Vec::new(), Vec::new());

        write_reply(&mut sent, Reply::File { response: response(), file: Some(file), length: 5 }, "an-id", false)
            .unwrap();
        write_reply(&mut head_only, Reply::File { response: response(), file: None, length: 10 }, "an-id", true)
            .unwrap();

        let sent = String::from_utf8(sent).unwrap();
        assert!(
            sent.starts_with("HTTP/1.1 206 Partial Content\r\n") && sent.contains("\r\ncontent-length: 5\r\n"),
            "{sent}"
        );
        assert!(sent.ends_with("\r\n\r\n23456"), "{sent}");
        let head_only = String::from_utf8(head_only).unwrap();
        assert!(head_only.contains("\r\ncontent-length: 10\r\n") && head_only.ends_with("\r\n\r\n"), "{head_only}");
    }
}
