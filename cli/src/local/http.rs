//! HTTP on this machine for `ff local`, from the standard library alone: a thread per connection, one request each, its
//! response closing it. What answers is the caller's: a function's URL, or the front door to a template's app.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;

/// A request, and a response, may hold 6 MB, as on Lambda.
pub const PAYLOAD_LIMIT: usize = 6 * 1024 * 1024;

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
    read_body(stream, &mut request)?;
    Ok(Some(request))
}

/// Reads a request's line and its headers; none when the connection closed first.
fn read_head(stream: &mut impl BufRead) -> io::Result<Option<Request>> {
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
    Ok(Some(request))
}

/// Reads a request's body, by its length or its chunks, up to the payload's limit.
fn read_body(stream: &mut impl BufRead, request: &mut Request) -> io::Result<()> {
    if request.header("transfer-encoding").is_some_and(|encoding| encoding.eq_ignore_ascii_case("chunked")) {
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
    } else if let Some(length) = request.header("content-length").and_then(|length| length.parse::<usize>().ok()) {
        if length > PAYLOAD_LIMIT {
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "over 6 MB"));
        }
        request.body = vec![0; length];
        stream.read_exact(&mut request.body)?;
    }
    Ok(())
}

/// Writes the response, its request's ID with it, as HTTP/1.1 closing the connection; its head alone for HEAD.
pub fn write_response(
    stream: &mut impl Write,
    response: &Response,
    request_id: &str,
    head_only: bool,
) -> io::Result<()> {
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

/// Serves the listener, each request on a thread of its own, answered by `answers`.
pub fn serve(listener: TcpListener, answers: Arc<dyn Answers>) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let answers = Arc::clone(&answers);
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
                let mut request = match read_head(&mut reader) {
                    Ok(Some(request)) => request,
                    Ok(None) => return,
                    Err(_) => {
                        let _ = write_response(&mut stream, &answers.unreadable(false, None), &request_id, false);
                        return;
                    }
                };
                let response = match read_body(&mut reader, &mut request) {
                    Ok(()) => answers.answer(&request, &request_id, &source_ip),
                    Err(error) => answers.unreadable(error.kind() == io::ErrorKind::FileTooLarge, Some(&request)),
                };
                let head_only = request.method == "HEAD";
                let _ = write_response(&mut stream, &response, &request_id, head_only);
            });
        }
    });
}

#[cfg(test)]
mod tests {
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
    }
}
