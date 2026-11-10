//! An upload's body checked as it streams, as the backend's front door checks one (`BE/src/storage/aws-chunked.ts`):
//! aws-chunked framing, each chunk's signature in its chain from the request's, the trailer and its signature, the
//! decoded length; a plain body's signed SHA-256; and the checksum, in a header or the trailer. Fed piece by piece; the
//! data alone comes out, and `finish` says whether the whole body passed, and the checksum it checked, which
//! PutObject's answer gives back. Ported from the local front door's spike (`hack/spikes/local-front-door/`); its tests
//! read the backend's table of AWS's examples.

use ring::digest;

use super::checksums::{Algorithm, Running};
use super::error::{S3Error, bad_digest, incomplete_body, invalid_request, signature_mismatch};
use crate::sigv4::{Chain, hex, hmac_hex, sha256_hex};

pub const STREAMING_SIGNED: &str = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD";
pub const STREAMING_SIGNED_TRAILER: &str = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER";
pub const STREAMING_UNSIGNED_TRAILER: &str = "STREAMING-UNSIGNED-PAYLOAD-TRAILER";
/// The SHA-256 of nothing, which an empty chunk signs.
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// The longest chunk header or trailer line read: anything longer is no aws-chunked body.
const MAX_LINE: usize = 4096;
/// The trailer's lines together, at most.
const MAX_TRAILER: usize = 16 * 1024;

/// The checksum an upload must have: its algorithm, and the header's value, or none when the trailer brings it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedChecksum {
    pub algorithm: Algorithm,
    pub value: Option<String>,
}

/// The checksum a body passed: its algorithm and the value sent, in its header or its trailer.
pub type Checked = Option<(Algorithm, String)>;

#[derive(PartialEq)]
enum State {
    Size,
    Data,
    DataEnd,
    Final,
    Trailer,
    Done,
}

pub struct ChunkedOptions {
    /// The request's signature chain, for a body signed chunk by chunk.
    pub chain: Option<Chain>,
    pub trailer: bool,
    /// x-amz-decoded-content-length: the data's bytes without the framing.
    pub decoded_length: u64,
    pub checksum: Option<ExpectedChecksum>,
    /// The trailer's header, as x-amz-trailer names it.
    pub trailer_name: Option<String>,
}

/// Reads an aws-chunked body: "<hex size>[;chunk-signature=<signature>]\r\n<data>\r\n" for each chunk, a last one of
/// size 0, then the trailer's lines and an empty one.
pub struct ChunkedBody {
    options: ChunkedOptions,
    buffer: Vec<u8>,
    state: State,
    remaining: u64,
    chunk_signature: String,
    chunk_hash: Option<digest::Context>,
    previous: String,
    decoded: u64,
    trailer_bytes: usize,
    trailers: Vec<(String, String)>,
    checksum: Option<Running>,
}

impl ChunkedBody {
    pub fn new(options: ChunkedOptions) -> Self {
        let previous = options.chain.as_ref().map(|chain| chain.seed.clone()).unwrap_or_default();
        let checksum = options.checksum.as_ref().map(|expected| Running::new(expected.algorithm));
        Self {
            options,
            buffer: Vec::new(),
            state: State::Size,
            remaining: 0,
            chunk_signature: String::new(),
            chunk_hash: None,
            previous,
            decoded: 0,
            trailer_bytes: 0,
            trailers: Vec::new(),
            checksum,
        }
    }

    /// Takes the next piece of the body as it came; the data it holds is appended to `out`.
    pub fn feed(&mut self, piece: &[u8], out: &mut Vec<u8>) -> Result<(), S3Error> {
        self.buffer.extend_from_slice(piece);
        let mut at = 0;
        let result = self.consume(&mut at, out);
        self.buffer.drain(..at);
        result
    }

    fn consume(&mut self, at: &mut usize, out: &mut Vec<u8>) -> Result<(), S3Error> {
        loop {
            let rest = &self.buffer[*at..];
            match self.state {
                State::Size | State::Trailer => {
                    let Some(end) = rest.windows(2).position(|pair| pair == b"\r\n") else {
                        if rest.len() > MAX_LINE {
                            return Err(incomplete_body(Some(
                                "A chunk header or trailer line of the aws-chunked body is too long",
                            )));
                        }
                        return Ok(());
                    };
                    let line = String::from_utf8_lossy(&rest[..end]).into_owned();
                    *at += end + 2;
                    if self.state == State::Trailer { self.trailer_line(&line)? } else { self.chunk_header(&line)? }
                }
                State::Data => {
                    if rest.is_empty() {
                        return Ok(());
                    }
                    let take = (self.remaining as usize).min(rest.len());
                    let data = &self.buffer[*at..*at + take];
                    self.remaining -= take as u64;
                    self.decoded += take as u64;
                    if self.decoded > self.options.decoded_length {
                        return Err(incomplete_body(Some(&format!(
                            "The body has more than the {} bytes x-amz-decoded-content-length says",
                            self.options.decoded_length
                        ))));
                    }
                    if let Some(hash) = &mut self.chunk_hash {
                        hash.update(data);
                    }
                    if let Some(checksum) = &mut self.checksum {
                        checksum.update(data);
                    }
                    out.extend_from_slice(data);
                    *at += take;
                    if self.remaining == 0 {
                        self.state = State::DataEnd;
                    }
                }
                State::DataEnd | State::Final => {
                    if rest.len() < 2 {
                        return Ok(());
                    }
                    if &rest[..2] != b"\r\n" {
                        return Err(incomplete_body(Some("A chunk of the aws-chunked body does not end with CRLF")));
                    }
                    *at += 2;
                    if self.state == State::Final {
                        self.state = State::Done;
                        continue;
                    }
                    if self.options.chain.is_some() {
                        let hash = self.chunk_hash.take().map(|hash| hex(hash.finish().as_ref()));
                        self.chunk_signed(&hash.unwrap_or_else(|| EMPTY_SHA256.into()))?;
                    }
                    self.state = State::Size;
                }
                State::Done => {
                    *at = self.buffer.len();
                    return Ok(());
                }
            }
        }
    }

    fn chunk_header(&mut self, line: &str) -> Result<(), S3Error> {
        let mut parts = line.split(';');
        let size = parts.next().unwrap_or_default();
        if size.is_empty() || size.len() > 16 || !size.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(incomplete_body(Some(&format!(
                "A chunk's size is malformed: {}",
                serde_json::Value::from(&line[..line.len().min(40)])
            ))));
        }
        self.remaining =
            u64::from_str_radix(size, 16).map_err(|_| incomplete_body(Some("A chunk's size is too large")))?;
        self.chunk_signature =
            parts.find_map(|extension| extension.strip_prefix("chunk-signature=")).unwrap_or_default().into();
        let signed = self.options.chain.is_some();
        if signed
            && !(self.chunk_signature.len() == 64
                && self.chunk_signature.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
        {
            return Err(signature_mismatch());
        }
        self.chunk_hash = signed.then(|| digest::Context::new(&digest::SHA256));
        if self.remaining > 0 {
            self.state = State::Data;
            return Ok(());
        }
        if signed {
            self.chunk_signed(EMPTY_SHA256)?;
        }
        self.state = if self.options.trailer { State::Trailer } else { State::Final };
        Ok(())
    }

    /// The chunk's signature: the previous one's, chained, over the hash of its data.
    fn chunk_signed(&mut self, hash: &str) -> Result<(), S3Error> {
        let chain = self.options.chain.as_ref().unwrap();
        let text =
            ["AWS4-HMAC-SHA256-PAYLOAD", &chain.amz_date, &chain.scope, &self.previous, EMPTY_SHA256, hash].join("\n");
        let expected = hmac_hex(&chain.key, &text);
        if expected != self.chunk_signature {
            return Err(signature_mismatch());
        }
        self.previous = expected;
        Ok(())
    }

    fn trailer_line(&mut self, line: &str) -> Result<(), S3Error> {
        if line.is_empty() {
            self.state = State::Done;
            return Ok(());
        }
        self.trailer_bytes += line.len() + 2;
        if self.trailer_bytes > MAX_TRAILER {
            return Err(invalid_request("The trailer of the aws-chunked body is too large"));
        }
        match line.split_once(':') {
            Some((name, value)) if !name.is_empty() => {
                self.trailers.push((name.trim().to_ascii_lowercase(), value.trim().into()));
                Ok(())
            }
            _ => Err(invalid_request(&format!(
                "A trailer line is malformed: {}",
                serde_json::Value::from(&line[..line.len().min(40)])
            ))),
        }
    }

    fn trailer(&self, name: &str) -> Option<&str> {
        self.trailers.iter().rev().find(|(trailer, _)| trailer == name).map(|(_, value)| value.as_str())
    }

    /// Once the body has ended: its framing complete, its length, the trailer's signature and the checksum.
    pub fn finish(self) -> Result<Checked, S3Error> {
        if self.state != State::Done {
            return Err(incomplete_body(None));
        }
        if self.decoded != self.options.decoded_length {
            return Err(incomplete_body(Some(&format!(
                "The body has {} bytes, not the {} x-amz-decoded-content-length says",
                self.decoded, self.options.decoded_length
            ))));
        }
        if let (true, Some(chain)) = (self.options.trailer, &self.options.chain) {
            let lines: String = self
                .trailers
                .iter()
                .filter(|(name, _)| name != "x-amz-trailer-signature")
                .map(|(name, value)| format!("{name}:{value}\n"))
                .collect();
            let text = [
                "AWS4-HMAC-SHA256-TRAILER",
                &chain.amz_date,
                &chain.scope,
                &self.previous,
                &sha256_hex(lines.as_bytes()),
            ]
            .join("\n");
            if Some(hmac_hex(&chain.key, &text).as_str()) != self.trailer("x-amz-trailer-signature") {
                return Err(signature_mismatch());
            }
        }
        if let Some(name) = &self.options.trailer_name
            && self.trailer(name).is_none()
        {
            return Err(invalid_request(&format!("The body's trailer has no {name}, which x-amz-trailer announced")));
        }
        let trailers = self.trailers;
        let trailer =
            |name: &str| trailers.iter().rev().find(|(trailer, _)| trailer == name).map(|(_, value)| value.clone());
        check_checksum(self.options.checksum.as_ref(), self.checksum, trailer)
    }
}

/// The checksum sent, in its header or the trailer, against the one computed: the value checked when they match.
fn check_checksum(
    expected: Option<&ExpectedChecksum>,
    computed: Option<Running>,
    trailer: impl Fn(&str) -> Option<String>,
) -> Result<Checked, S3Error> {
    let (Some(expected), Some(computed)) = (expected, computed) else { return Ok(None) };
    let sent = expected.value.clone().or_else(|| trailer(&format!("x-amz-checksum-{}", expected.algorithm.name())));
    let Some(sent) = sent else {
        return Err(invalid_request(&format!("The x-amz-checksum-{} value is missing", expected.algorithm.name())));
    };
    if sent != computed.finish_base64() {
        return Err(bad_digest(expected.algorithm));
    }
    Ok(Some((expected.algorithm, sent)))
}

/// A plain body: its signed SHA-256, when one was signed, and its checksum from a header, checked at its end.
pub struct PlainBody {
    sha256: Option<(String, digest::Context)>,
    checksum: Option<(ExpectedChecksum, Running)>,
}

impl PlainBody {
    pub fn new(sha256: Option<String>, checksum: Option<ExpectedChecksum>) -> Self {
        Self {
            sha256: sha256.map(|hex| (hex, digest::Context::new(&digest::SHA256))),
            checksum: checksum.map(|expected| {
                let running = Running::new(expected.algorithm);
                (expected, running)
            }),
        }
    }

    pub fn feed(&mut self, piece: &[u8]) {
        if let Some((_, context)) = &mut self.sha256 {
            context.update(piece);
        }
        if let Some((_, running)) = &mut self.checksum {
            running.update(piece);
        }
    }

    pub fn finish(self) -> Result<Checked, S3Error> {
        if let Some((expected, context)) = self.sha256
            && hex(context.finish().as_ref()) != expected
        {
            return Err(S3Error::new(
                400,
                "XAmzContentSHA256Mismatch",
                "The provided 'x-amz-content-sha256' header does not match what was computed.",
            ));
        }
        let (expected, running) = match self.checksum {
            Some((expected, running)) => (Some(expected), Some(running)),
            None => (None, None),
        };
        check_checksum(expected.as_ref(), running, |_| None)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::local::s3::error::incomplete_body;
    use crate::sigv4::{Paths, SignedRequest, match_signature, read_authorization, signing_key};

    /// AWS's documented aws-chunked uploads, the table the backend's tests read.
    fn examples() -> Value {
        serde_json::from_str(include_str!("../../../../BE/src/storage/aws-chunked-examples.json")).unwrap()
    }

    fn data(examples: &Value) -> Vec<u8> {
        vec![
            examples["data"]["byte"].as_str().unwrap().as_bytes()[0];
            examples["data"]["length"].as_u64().unwrap() as usize
        ]
    }

    fn chain(examples: &Value, seed: &str) -> Chain {
        let text = |name: &str| examples[name].as_str().unwrap().to_string();
        Chain {
            key: signing_key(&text("secret"), &text("date"), &text("region"), &text("service")),
            scope: format!("{}/{}/{}/aws4_request", text("date"), text("region"), text("service")),
            amz_date: text("amzDate"),
            seed: seed.into(),
        }
    }

    /// The body as a client frames it: each chunk's header with its signature, its data, CRLF; then `after`.
    fn framed(data: &[u8], chunks: &[Value], after: &str) -> Vec<u8> {
        let mut body = Vec::new();
        let mut at = 0;
        for (n, chunk) in chunks.iter().enumerate() {
            let size = chunk["size"].as_u64().unwrap() as usize;
            body.extend_from_slice(
                format!("{size:x};chunk-signature={}\r\n", chunk["signature"].as_str().unwrap()).as_bytes(),
            );
            body.extend_from_slice(&data[at..at + size]);
            at += size;
            if n < chunks.len() - 1 || size > 0 {
                body.extend_from_slice(b"\r\n");
            }
        }
        body.extend_from_slice(after.as_bytes());
        body
    }

    /// The body through a reader in pieces of `size`: the data passed on, and the end's verdict.
    fn through(mut reader: ChunkedBody, body: &[u8], size: usize) -> (Vec<u8>, Result<Checked, S3Error>) {
        let mut out = Vec::new();
        for piece in body.chunks(size) {
            if let Err(problem) = reader.feed(piece, &mut out) {
                return (out, Err(problem));
            }
        }
        (out, reader.finish())
    }

    #[test]
    fn awss_example_the_requests_signature_then_each_chunks_in_its_chain() {
        let examples = examples();
        let data = data(&examples);
        let signed = &examples["signed"];
        let mut headers: Vec<(String, String)> = signed["request"]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| (pair[0].as_str().unwrap().into(), pair[1].as_str().unwrap().into()))
            .collect();
        let mut names: Vec<String> = headers.iter().map(|(name, _)| name.to_ascii_lowercase()).collect();
        names.sort();
        let seed = signed["seed"].as_str().unwrap();
        let credential = format!("{}/{}", examples["accessKeyId"].as_str().unwrap(), chain(&examples, "").scope);
        let authorization =
            format!("AWS4-HMAC-SHA256 Credential={credential},SignedHeaders={},Signature={seed}", names.join(";"));
        headers.push(("Authorization".into(), authorization));
        let read = read_authorization(&headers, "s3").unwrap().unwrap();
        let request = SignedRequest {
            method: signed["request"]["method"].as_str().unwrap(),
            raw_path: signed["request"]["rawPath"].as_str().unwrap(),
            raw_query: "",
            headers: &headers,
        };
        let secret = examples["secret"].as_str().unwrap();
        let checked = match_signature(&request, &read, STREAMING_SIGNED, secret, "s3", Paths::Once, None);
        let chain = checked.expect("the request's own signature");
        let body = framed(&data, signed["chunks"].as_array().unwrap(), "\r\n");
        assert_eq!(body.len() as u64, signed["encodedLength"].as_u64().unwrap());
        for size in [1, 7_919, body.len()] {
            let options = ChunkedOptions {
                chain: Some(chain.clone()),
                trailer: false,
                decoded_length: data.len() as u64,
                checksum: None,
                trailer_name: None,
            };
            let (out, verdict) = through(ChunkedBody::new(options), &body, size);
            assert_eq!(verdict, Ok(None), "pieces of {size}");
            assert!(out == data, "pieces of {size}");
        }
    }

    #[test]
    fn a_chunk_signed_wrong_or_changed_is_refused() {
        let examples = examples();
        let data = data(&examples);
        let signed = &examples["signed"];
        let options = || ChunkedOptions {
            chain: Some(chain(&examples, signed["seed"].as_str().unwrap())),
            trailer: false,
            decoded_length: data.len() as u64,
            checksum: None,
            trailer_name: None,
        };
        let mut wrong = signed["chunks"].as_array().unwrap().clone();
        wrong[1]["signature"] = Value::from("1".repeat(64));
        let (_, verdict) = through(ChunkedBody::new(options()), &framed(&data, &wrong, "\r\n"), 7_919);
        assert_eq!(verdict, Err(signature_mismatch()));
        let mut changed = data.clone();
        changed[0] = b'b';
        let (_, verdict) = through(
            ChunkedBody::new(options()),
            &framed(&changed, signed["chunks"].as_array().unwrap(), "\r\n"),
            7_919,
        );
        assert_eq!(verdict, Err(signature_mismatch()));
        let cut = framed(&data, signed["chunks"].as_array().unwrap(), "\r\n");
        let (_, verdict) = through(ChunkedBody::new(options()), &cut[..cut.len() - 10], 7_919);
        assert_eq!(verdict, Err(incomplete_body(None)));
    }

    #[test]
    fn awss_example_with_a_trailer_the_crc32c_and_the_trailers_own_signature() {
        let examples = examples();
        let data = data(&examples);
        let example = &examples["signedWithTrailer"];
        let (name, value) =
            (example["trailer"]["name"].as_str().unwrap(), example["trailer"]["value"].as_str().unwrap());
        let signature = example["trailerSignature"].as_str().unwrap();
        let options = || ChunkedOptions {
            chain: Some(chain(&examples, example["seed"].as_str().unwrap())),
            trailer: true,
            decoded_length: data.len() as u64,
            checksum: Some(ExpectedChecksum { algorithm: Algorithm::Crc32c, value: None }),
            trailer_name: Some(name.into()),
        };
        let chunks = example["chunks"].as_array().unwrap();
        let body = |trailer: String| framed(&data, chunks, &trailer);
        let (out, verdict) = through(
            ChunkedBody::new(options()),
            &body(format!("{name}:{value}\r\nx-amz-trailer-signature:{signature}\r\n\r\n")),
            7_919,
        );
        assert_eq!(verdict, Ok(Some((Algorithm::Crc32c, value.to_owned()))));
        assert!(out == data);
        for wrong in [
            format!("{name}:AAAAAA==\r\nx-amz-trailer-signature:{signature}\r\n\r\n"),
            format!("{name}:{value}\r\nx-amz-trailer-signature:{}\r\n\r\n", "0".repeat(64)),
            format!("x-amz-trailer-signature:{signature}\r\n\r\n"),
        ] {
            assert_eq!(
                through(ChunkedBody::new(options()), &body(wrong.clone()), 7_919).1,
                Err(signature_mismatch()),
                "{wrong}"
            );
        }
    }

    #[test]
    fn unsigned_with_a_trailing_crc32_as_awss_sdk_for_javascript_streams() {
        let data = vec![b'a'; 66_560];
        let crc = |bytes: &[u8]| {
            let mut running = Running::new(Algorithm::Crc32);
            running.update(bytes);
            running.finish_base64()
        };
        let body = |checksum: &str| {
            let mut body = format!("{:x}\r\n", 8192).into_bytes();
            body.extend_from_slice(&data[..8192]);
            body.extend_from_slice(format!("\r\n{:x}\r\n", data.len() - 8192).as_bytes());
            body.extend_from_slice(&data[8192..]);
            body.extend_from_slice(format!("\r\n0\r\nx-amz-checksum-crc32:{checksum}\r\n\r\n").as_bytes());
            body
        };
        let options = || ChunkedOptions {
            chain: None,
            trailer: true,
            decoded_length: data.len() as u64,
            checksum: Some(ExpectedChecksum { algorithm: Algorithm::Crc32, value: None }),
            trailer_name: Some("x-amz-checksum-crc32".into()),
        };
        let (out, verdict) = through(ChunkedBody::new(options()), &body(&crc(&data)), 1000);
        assert_eq!(verdict, Ok(Some((Algorithm::Crc32, crc(&data)))));
        assert!(out == data);
        assert_eq!(
            through(ChunkedBody::new(options()), &body(&crc(b"other")), 1000).1,
            Err(bad_digest(Algorithm::Crc32))
        );
    }

    #[test]
    fn a_plain_body_its_sha256_and_its_checksum_checked_at_its_end() {
        let data = vec![b'a'; 66_560];
        let mut plain = PlainBody::new(
            Some(sha256_hex(&data)),
            Some(ExpectedChecksum { algorithm: Algorithm::Crc32c, value: Some("sOO8/Q==".into()) }),
        );
        plain.feed(&data);
        assert_eq!(plain.finish(), Ok(Some((Algorithm::Crc32c, "sOO8/Q==".to_owned()))));
        let mut changed = PlainBody::new(Some(sha256_hex(b"other")), None);
        changed.feed(&data);
        assert_eq!(changed.finish().unwrap_err().code, "XAmzContentSHA256Mismatch");
        let mut wrong = PlainBody::new(
            None,
            Some(ExpectedChecksum { algorithm: Algorithm::Crc32c, value: Some("AAAAAA==".into()) }),
        );
        wrong.feed(&data);
        assert_eq!(wrong.finish(), Err(bad_digest(Algorithm::Crc32c)));
    }
}
