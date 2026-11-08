//! S3's PutObject, GetObject (HeadObject with it) and ListObjectsV2, as the backend's front door answers them
//! (BE/src/storage/front-door.ts), its objects kept in files rather than sent to a store. Each request signed with
//! Signature Version 4 in its Authorization header by the one key; an upload checked as it streams, kept only once
//! it passed.

use crate::checksums::{ALGORITHMS, Algorithm};
use crate::chunked::{
    BodyProblem, ChunkedBody, ChunkedOptions, ExpectedChecksum, PlainBody, STREAMING_SIGNED, STREAMING_SIGNED_TRAILER,
    STREAMING_UNSIGNED_TRAILER,
};
use crate::http::{Body, Incoming, Response};
use crate::md5::{Md5, hex};
use crate::sigv4::{self, Paths, Problem, SignedRequest, decode_escapes, uri_encode};
use crate::{Key, request_id, time};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::ops::Bound;
use std::path::PathBuf;
use std::sync::Mutex;

/// S3's limit on an object sent in one PUT: 5 GiB.
const MAX_UPLOAD_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
/// What S3 stores an object as when its upload gives no type.
const DEFAULT_TYPE: &str = "binary/octet-stream";
/// The upload's headers kept with the object and answered with it, as the backend forwards them to the store.
fn kept_header(name: &str) -> bool {
    matches!(name, "content-type" | "content-language" | "content-disposition" | "cache-control" | "expires")
        || name.starts_with("x-amz-meta-")
}

pub struct S3Error {
    status: u16,
    code: &'static str,
    message: String,
}

fn error(status: u16, code: &'static str, message: impl Into<String>) -> S3Error {
    S3Error { status, code, message: message.into() }
}

fn invalid_request(message: impl Into<String>) -> S3Error {
    error(400, "InvalidRequest", message)
}

fn not_implemented(what: &str) -> S3Error {
    error(501, "NotImplemented", format!("{what} is not one of the operations this spike serves"))
}

/// S3's words for a signature's problems, as the backend's s3-signature.ts says them.
fn refused(problem: Problem) -> S3Error {
    let malformed = |detail: String| {
        error(400, "AuthorizationHeaderMalformed", format!("The authorization header is malformed; {detail}"))
    };
    match problem {
        Problem::Token => error(400, "InvalidToken", "The provided token is malformed or otherwise invalid."),
        Problem::Algorithm => invalid_request(
            "The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.",
        ),
        Problem::Parts => malformed("it needs a Credential, SignedHeaders and a Signature".into()),
        Problem::Credential { part: "date", value } => malformed(format!("incorrect date \"{value}\"")),
        Problem::Credential { part: "terminal", value } => {
            malformed(format!("incorrect terminal \"{value}\". This endpoint uses \"aws4_request\"."))
        }
        Problem::Credential { .. } => malformed("the Credential is not <key>/<date>/<region>/s3/aws4_request".into()),
        Problem::Service { named } => {
            malformed(format!("incorrect service \"{named}\". This endpoint belongs to \"s3\"."))
        }
        Problem::NoDate => malformed("the request has no x-amz-date header".into()),
        Problem::Date { amz_date } => malformed(format!("the date \"{amz_date}\" is not YYYYMMDDTHHMMSSZ")),
        Problem::OtherDay { date, .. } => malformed(format!("the credential's date \"{date}\" is not the request's")),
        Problem::Skewed { .. } => error(
            403,
            "RequestTimeTooSkewed",
            "The difference between the request time and the current time is too large.",
        ),
        Problem::Unsigned { header } => malformed(format!("the {header} header must be signed")),
        Problem::Mismatch => signature_mismatch(),
    }
}

fn signature_mismatch() -> S3Error {
    error(
        403,
        "SignatureDoesNotMatch",
        "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
    )
}

fn body_refused(problem: BodyProblem) -> S3Error {
    match problem {
        BodyProblem::Incomplete(message) => error(400, "IncompleteBody", message),
        BodyProblem::Mismatch => signature_mismatch(),
        BodyProblem::Invalid(message) => invalid_request(message),
        BodyProblem::BadDigest(algorithm) => error(
            400,
            "BadDigest",
            format!("The {} you specified did not match the calculated checksum.", algorithm.name().to_uppercase()),
        ),
        BodyProblem::Sha256Mismatch => error(
            400,
            "XAmzContentSHA256Mismatch",
            "The provided 'x-amz-content-sha256' header does not match what was computed.",
        ),
    }
}

pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// An object as kept: its file, and what S3 answers of it.
#[derive(Clone)]
struct Object {
    file: String,
    size: u64,
    etag: String,
    modified: i64,
    headers: Vec<(String, String)>,
    checksum: Option<(Algorithm, String)>,
}

impl Object {
    fn to_json(&self, key: &str) -> Value {
        json!({
            "key": key, "file": self.file, "size": self.size, "etag": self.etag, "modified": self.modified,
            "headers": self.headers, "checksum": self.checksum.as_ref().map(|(algorithm, value)| [algorithm.name(), value]),
        })
    }

    fn from_json(value: &Value) -> Option<(String, Self)> {
        let text = |name: &str| value[name].as_str().map(String::from);
        let headers = value["headers"]
            .as_array()?
            .iter()
            .filter_map(|pair| Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string())));
        let checksum = value["checksum"]
            .as_array()
            .and_then(|pair| Some((Algorithm::named(pair[0].as_str()?)?, pair[1].as_str()?.to_string())));
        let object = Self {
            file: text("file")?,
            size: value["size"].as_u64()?,
            etag: text("etag")?,
            modified: value["modified"].as_i64()?,
            headers: headers.collect(),
            checksum,
        };
        Some((text("key")?, object))
    }
}

/// The address S3 reads from a request: path-style, /<bucket>/<key>, or virtual-hosted, <bucket>.<host>.
struct Address {
    bucket: String,
    key: String,
}

pub struct S3 {
    key: Key,
    host: String,
    root: PathBuf,
    buckets: Mutex<HashMap<String, BTreeMap<String, Object>>>,
}

impl S3 {
    /// The buckets under `root`, one folder each, their objects read back from what an earlier run kept.
    pub fn new(key: Key, host: &str, root: PathBuf, buckets: &[String]) -> std::io::Result<Self> {
        let mut kept = HashMap::new();
        for bucket in buckets {
            let folder = root.join(bucket);
            fs::create_dir_all(&folder)?;
            let mut objects = BTreeMap::new();
            for entry in fs::read_dir(&folder)?.flatten() {
                if entry.path().extension().is_some_and(|extension| extension == "json") {
                    let read = fs::read_to_string(entry.path()).ok().and_then(|text| serde_json::from_str(&text).ok());
                    if let Some((key, object)) = read.as_ref().and_then(Object::from_json) {
                        objects.insert(key, object);
                    }
                }
            }
            kept.insert(bucket.clone(), objects);
        }
        Ok(Self { key, host: host.to_ascii_lowercase(), root, buckets: Mutex::new(kept) })
    }

    pub fn handle(&self, incoming: &mut Incoming) -> Response {
        let id = request_id();
        let resource = incoming.request.raw_path.clone();
        match self.answer(incoming) {
            Ok(response) => response.with("x-amz-request-id", id),
            Err(refusal) => {
                let body = if incoming.request.method == "HEAD" {
                    String::new()
                } else {
                    format!(
                        "{XML_DECLARATION}<Error><Code>{}</Code><Message>{}</Message><Resource>{}</Resource><RequestId>{id}</RequestId></Error>",
                        refusal.code,
                        escape_xml(&refusal.message),
                        escape_xml(&decode_escapes(&resource))
                    )
                };
                Response::new(refusal.status, "application/xml", body).with("x-amz-request-id", id)
            }
        }
    }

    fn address(&self, incoming: &Incoming) -> Address {
        let request = &incoming.request;
        let host = request.header("host").unwrap_or_default().to_ascii_lowercase();
        let host = host.rsplit_once(':').map_or(host.as_str(), |(name, port)| {
            if port.bytes().all(|byte| byte.is_ascii_digit()) { name } else { &host }
        });
        let path = request.raw_path.strip_prefix('/').unwrap_or(&request.raw_path);
        if let Some(bucket) = host.strip_suffix(&format!(".{}", self.host)) {
            return Address { bucket: bucket.into(), key: decode_escapes(path) };
        }
        let (bucket, key) = path.split_once('/').unwrap_or((path, ""));
        Address { bucket: decode_escapes(bucket), key: decode_escapes(key) }
    }

    fn answer(&self, incoming: &mut Incoming) -> Result<Response, S3Error> {
        let request = &incoming.request;
        let query = parse_query(&request.raw_query);
        if query.iter().any(|(name, _)| name == "X-Amz-Signature" || name == "X-Amz-Credential") {
            return Err(not_implemented("A presigned URL"));
        }
        let Some(signature) = sigv4::read_authorization(&request.headers, "s3").map_err(refused)? else {
            return Err(error(403, "AccessDenied", "Access Denied"));
        };
        let Some(payload) = request.header("x-amz-content-sha256").map(String::from) else {
            return Err(invalid_request("Missing required header for this request: x-amz-content-sha256"));
        };
        if signature.access_key_id != self.key.id {
            return Err(error(
                403,
                "InvalidAccessKeyId",
                "The AWS Access Key Id you provided does not exist in our records.",
            ));
        }
        let at = sigv4::signed_at(&signature.date, &signature.amz_date).map_err(refused)?;
        sigv4::check_skew(at, &signature.amz_date, time::now_millis() / 1000).map_err(refused)?;
        sigv4::require_signed(&signature.signed_headers, "host").map_err(refused)?;
        sigv4::require_signed(&signature.signed_headers, "x-amz-content-sha256").map_err(refused)?;
        let signed = SignedRequest {
            method: &request.method,
            raw_path: &request.raw_path,
            raw_query: &request.raw_query,
            headers: &request.headers,
        };
        let chain = sigv4::match_signature(&signed, &signature, &payload, &self.key.secret, "s3", Paths::Once, None)
            .map_err(refused)?;

        let address = self.address(incoming);
        if address.bucket.is_empty() {
            return Err(not_implemented("ListBuckets"));
        }
        if !self.buckets.lock().unwrap().contains_key(&address.bucket) {
            return Err(error(404, "NoSuchBucket", "The specified bucket does not exist"));
        }
        let method = incoming.request.method.clone();
        let named = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        match (method.as_str(), address.key.is_empty()) {
            ("GET", true) if named("list-type") == Some("2") => self.list(&address.bucket, &query),
            ("PUT", false)
                if incoming.request.header("x-amz-copy-source").is_none()
                    && query.iter().all(|(name, _)| name == "x-id") =>
            {
                self.put(incoming, &address, &payload, chain)
            }
            ("GET" | "HEAD", false) if query.iter().all(|(name, _)| name == "x-id" || name == "partNumber") => {
                self.get(&incoming.request, &address)
            }
            _ => Err(not_implemented(&format!("{method} {}", incoming.request.raw_path))),
        }
    }

    fn put(
        &self,
        incoming: &mut Incoming,
        address: &Address,
        payload: &str,
        chain: sigv4::Chain,
    ) -> Result<Response, S3Error> {
        let request = &incoming.request;
        let checksum = expected_checksum(request)?;
        let streaming = payload.starts_with("STREAMING-");
        enum Check {
            Plain(Box<PlainBody>),
            Chunked(Box<ChunkedBody>),
        }
        let mut check = if streaming {
            let (signed, trailer) = match payload {
                STREAMING_SIGNED => (true, false),
                STREAMING_SIGNED_TRAILER => (true, true),
                STREAMING_UNSIGNED_TRAILER => (false, true),
                _ => return Err(invalid_request(format!("x-amz-content-sha256 {payload} is not one S3 knows"))),
            };
            let decoded = request.header("x-amz-decoded-content-length").and_then(|value| value.parse::<u64>().ok());
            let Some(decoded_length) = decoded else {
                return Err(error(
                    411,
                    "MissingContentLength",
                    "You must provide the x-amz-decoded-content-length HTTP header.",
                ));
            };
            if decoded_length > MAX_UPLOAD_BYTES {
                return Err(error(
                    400,
                    "EntityTooLarge",
                    "Your proposed upload exceeds the maximum allowed object size.",
                ));
            }
            let trailer_name = request.header("x-amz-trailer").map(|name| name.to_ascii_lowercase());
            Check::Chunked(Box::new(ChunkedBody::new(ChunkedOptions {
                chain: signed.then_some(chain),
                trailer,
                decoded_length,
                checksum: checksum
                    .as_ref()
                    .map(|(algorithm, value)| ExpectedChecksum { algorithm: *algorithm, value: value.clone() }),
                trailer_name,
            })))
        } else {
            let sha256 = (payload != UNSIGNED_PAYLOAD).then(|| payload.to_string());
            if sha256.as_ref().is_some_and(|hex| hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())) {
                return Err(invalid_request(
                    "x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a SHA-256 in hex or an aws-chunked form",
                ));
            }
            Check::Plain(Box::new(PlainBody::new(
                sha256,
                checksum
                    .as_ref()
                    .map(|(algorithm, value)| ExpectedChecksum { algorithm: *algorithm, value: value.clone() }),
            )))
        };
        let content_md5 = request.header("content-md5").map(String::from);
        let mut headers: Vec<(String, String)> = request
            .headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
            .filter(|(name, _)| kept_header(name))
            .collect();
        if !headers.iter().any(|(name, _)| name == "content-type") {
            headers.push(("content-type".into(), DEFAULT_TYPE.into()));
        }
        let encoding: Vec<&str> = request
            .header("content-encoding")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|coding| !coding.is_empty() && *coding != "aws-chunked")
            .collect();
        if !encoding.is_empty() {
            headers.push(("content-encoding".into(), encoding.join(", ")));
        }

        let folder = self.root.join(&address.bucket);
        let file = crate::random_hex(16);
        let temporary = folder.join(format!(".{file}.part"));
        let mut out = File::create(&temporary).map_err(|_| internal())?;
        let mut md5 = Md5::default();
        let mut size = 0u64;
        let mut buffer = vec![0; 64 * 1024];
        let mut decoded = Vec::with_capacity(64 * 1024);
        let streamed: Result<(), S3Error> = (|| {
            loop {
                let read = incoming.read(&mut buffer).map_err(|_| {
                    body_refused(BodyProblem::Incomplete(
                        "You did not provide the number of bytes specified by the Content-Length HTTP header.".into(),
                    ))
                })?;
                if read == 0 {
                    break;
                }
                let data = match &mut check {
                    Check::Plain(plain) => {
                        plain.feed(&buffer[..read]);
                        &buffer[..read]
                    }
                    Check::Chunked(chunked) => {
                        decoded.clear();
                        chunked.feed(&buffer[..read], &mut decoded).map_err(body_refused)?;
                        &decoded[..]
                    }
                };
                size += data.len() as u64;
                if size > MAX_UPLOAD_BYTES {
                    return Err(error(
                        400,
                        "EntityTooLarge",
                        "Your proposed upload exceeds the maximum allowed object size.",
                    ));
                }
                md5.update(data);
                out.write_all(data).map_err(|_| internal())?;
            }
            match check {
                Check::Plain(plain) => plain.finish(),
                Check::Chunked(chunked) => chunked.finish(),
            }
            .map_err(body_refused)
        })();
        let digest = md5.finish();
        let streamed = streamed.and_then(|()| match content_md5 {
            Some(sent) if sent != STANDARD.encode(digest) => {
                Err(error(400, "BadDigest", "The Content-MD5 you specified did not match what we received."))
            }
            _ => Ok(()),
        });
        if let Err(refusal) = streamed {
            let _ = fs::remove_file(&temporary);
            return Err(refusal);
        }
        drop(out);
        let object = Object {
            file: file.clone(),
            size,
            etag: format!("\"{}\"", hex(&digest)),
            modified: time::now_millis(),
            headers,
            checksum: None,
        };
        let object = match checksum {
            Some((algorithm, value)) => {
                // The value checked: the header's, or the trailer's, which is the computed one once it passed.
                let value = value.unwrap_or_else(|| {
                    let mut running = crate::checksums::Running::new(algorithm);
                    let mut file = File::open(&temporary).expect("the upload just written");
                    let mut piece = vec![0; 64 * 1024];
                    while let Ok(read @ 1..) = file.read(&mut piece) {
                        running.update(&piece[..read]);
                    }
                    running.finish_base64()
                });
                Object { checksum: Some((algorithm, value)), ..object }
            }
            None => object,
        };
        fs::rename(&temporary, folder.join(&file)).map_err(|_| internal())?;
        fs::write(folder.join(format!("{file}.json")), object.to_json(&address.key).to_string())
            .map_err(|_| internal())?;
        let replaced =
            self.buckets.lock().unwrap().get_mut(&address.bucket).unwrap().insert(address.key.clone(), object.clone());
        if let Some(old) = replaced {
            let _ = fs::remove_file(folder.join(&old.file));
            let _ = fs::remove_file(folder.join(format!("{}.json", old.file)));
        }
        let mut response = Response::new(200, "application/xml", Vec::new()).with("ETag", object.etag);
        response.headers.retain(|(name, _)| name != "Content-Type");
        if let Some((algorithm, value)) = object.checksum {
            response = response
                .with(&format!("x-amz-checksum-{}", algorithm.name()), value)
                .with("x-amz-checksum-type", "FULL_OBJECT");
        }
        Ok(response)
    }

    fn get(&self, request: &crate::http::Request, address: &Address) -> Result<Response, S3Error> {
        let object = self.buckets.lock().unwrap()[&address.bucket].get(&address.key).cloned();
        let Some(object) = object else {
            return Err(error(404, "NoSuchKey", "The specified key does not exist."));
        };
        let mut file = File::open(self.root.join(&address.bucket).join(&object.file)).map_err(|_| internal())?;
        let range = match request.header("range") {
            Some(range) => Some(byte_range(range, object.size)?),
            None => None,
        };
        let (status, start, length) = match range {
            Some((start, end)) => (206, start, end - start + 1),
            None => (200, 0, object.size),
        };
        if start > 0 {
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(start)).map_err(|_| internal())?;
        }
        let mut response = Response { status, headers: Vec::new(), body: Body::File(file, length) };
        for (name, value) in &object.headers {
            response = response.with(name, value.clone());
        }
        response = response
            .with("ETag", object.etag.clone())
            .with("Last-Modified", time::http_date(object.modified))
            .with("Accept-Ranges", "bytes");
        if status == 206 {
            response = response.with("Content-Range", format!("bytes {start}-{}/{}", start + length - 1, object.size));
        }
        let wants_checksum =
            request.header("x-amz-checksum-mode").is_some_and(|mode| mode.eq_ignore_ascii_case("enabled"));
        if let (true, 200, Some((algorithm, value))) = (wants_checksum, status, &object.checksum) {
            response = response
                .with(&format!("x-amz-checksum-{}", algorithm.name()), value.clone())
                .with("x-amz-checksum-type", "FULL_OBJECT");
        }
        Ok(response)
    }

    fn list(&self, bucket: &str, query: &[(String, String)]) -> Result<Response, S3Error> {
        let named = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        let prefix = named("prefix").unwrap_or_default();
        let delimiter = named("delimiter").filter(|delimiter| !delimiter.is_empty());
        let max_keys = match named("max-keys") {
            Some(value) => value.parse::<usize>().map_err(|_| {
                error(400, "InvalidArgument", "Provided max-keys not an integer or within integer range")
            })?,
            None => 1000,
        }
        .min(1000);
        let start_after = named("start-after").unwrap_or_default();
        let token = named("continuation-token");
        let after = match &token {
            Some(token) => String::from_utf8(
                STANDARD
                    .decode(token)
                    .map_err(|_| error(400, "InvalidArgument", "The continuation token provided is incorrect"))?,
            )
            .map_err(|_| error(400, "InvalidArgument", "The continuation token provided is incorrect"))?,
            None => start_after.clone(),
        };
        let url = named("encoding-type").as_deref() == Some("url");
        let shown = |text: &str| escape_xml(&if url { uri_encode(text, true) } else { text.to_string() });

        let buckets = self.buckets.lock().unwrap();
        let objects = &buckets[bucket];
        let lower = if after.as_str() > prefix.as_str() {
            Bound::Excluded(after.clone())
        } else {
            Bound::Included(prefix.clone())
        };
        let mut contents = String::new();
        let mut common: Vec<String> = Vec::new();
        let mut count = 0;
        let mut last = None;
        let mut truncated = false;
        for (key, object) in objects.range((lower, Bound::Unbounded)) {
            if !key.starts_with(&prefix) {
                break;
            }
            // A resumed listing skips the common prefix it ended on.
            if token.is_some()
                && delimiter.as_ref().is_some_and(|delimiter| after.ends_with(delimiter.as_str()))
                && key.starts_with(&after)
            {
                continue;
            }
            let rolled = delimiter.as_ref().and_then(|delimiter| {
                let rest = &key[prefix.len()..];
                rest.find(delimiter.as_str()).map(|at| format!("{prefix}{}", &rest[..at + delimiter.len()]))
            });
            if let Some(rolled) = &rolled
                && common.last() == Some(rolled)
            {
                continue;
            }
            if count == max_keys {
                truncated = true;
                break;
            }
            count += 1;
            match rolled {
                Some(rolled) => {
                    last = Some(rolled.clone());
                    common.push(rolled);
                }
                None => {
                    last = Some(key.clone());
                    contents.push_str(&format!(
                        "<Contents><Key>{}</Key><LastModified>{}</LastModified><ETag>{}</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                        shown(key),
                        time::iso8601(object.modified),
                        escape_xml(&object.etag),
                        object.size
                    ));
                }
            }
        }
        let mut xml = format!(
            "{XML_DECLARATION}<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{}</Name><Prefix>{}</Prefix>",
            escape_xml(bucket),
            shown(&prefix)
        );
        if let Some(delimiter) = &delimiter {
            xml.push_str(&format!("<Delimiter>{}</Delimiter>", shown(delimiter)));
        }
        xml.push_str(&format!(
            "<MaxKeys>{max_keys}</MaxKeys><KeyCount>{count}</KeyCount><IsTruncated>{truncated}</IsTruncated>"
        ));
        if let Some(token) = &token {
            xml.push_str(&format!("<ContinuationToken>{}</ContinuationToken>", escape_xml(token)));
        }
        if let (true, Some(last)) = (truncated, &last) {
            xml.push_str(&format!("<NextContinuationToken>{}</NextContinuationToken>", STANDARD.encode(last)));
        }
        if !start_after.is_empty() {
            xml.push_str(&format!("<StartAfter>{}</StartAfter>", shown(&start_after)));
        }
        if url {
            xml.push_str("<EncodingType>url</EncodingType>");
        }
        xml.push_str(&contents);
        for prefix in &common {
            xml.push_str(&format!("<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>", shown(prefix)));
        }
        xml.push_str("</ListBucketResult>");
        Ok(Response::new(200, "application/xml", xml))
    }
}

fn internal() -> S3Error {
    error(500, "InternalError", "We encountered an internal error. Please try again.")
}

/// The query's pairs, decoded.
pub fn parse_query(raw_query: &str) -> Vec<(String, String)> {
    raw_query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_escapes(&name.replace('+', " ")), decode_escapes(&value.replace('+', " ")))
        })
        .collect()
}

/// The checksum an upload carries in a header, at most one, or announces for its trailer.
fn expected_checksum(request: &crate::http::Request) -> Result<Option<(Algorithm, Option<String>)>, S3Error> {
    let in_headers: Vec<Algorithm> = ALGORITHMS
        .into_iter()
        .filter(|algorithm| request.header(&format!("x-amz-checksum-{}", algorithm.name())).is_some())
        .collect();
    if in_headers.len() > 1 {
        return Err(invalid_request(
            "Expecting a single x-amz-checksum- header. Multiple checksum Types are not allowed.",
        ));
    }
    if let Some(trailer) = request.header("x-amz-trailer").map(|name| name.trim().to_ascii_lowercase()) {
        let algorithm = trailer.strip_prefix("x-amz-checksum-").and_then(Algorithm::named);
        let Some(algorithm) = algorithm else {
            return Err(invalid_request(format!("The trailer {trailer} is not a checksum S3 knows")));
        };
        return Ok(Some((algorithm, None)));
    }
    Ok(in_headers.first().map(|algorithm| {
        let value = request.header(&format!("x-amz-checksum-{}", algorithm.name())).unwrap_or_default().to_string();
        (*algorithm, Some(value))
    }))
}

/// A Range header's one range of bytes, first and last, within the object.
fn byte_range(range: &str, size: u64) -> Result<(u64, u64), S3Error> {
    let invalid = || error(416, "InvalidRange", "The requested range is not satisfiable");
    let spec = range.strip_prefix("bytes=").ok_or_else(invalid)?;
    let (first, last) = spec.split_once('-').ok_or_else(invalid)?;
    let (start, end) = match (first.trim(), last.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().map_err(|_| invalid())?;
            (size.saturating_sub(suffix), size.checked_sub(1).ok_or_else(invalid)?)
        }
        (first, "") => (first.parse().map_err(|_| invalid())?, size.checked_sub(1).ok_or_else(invalid)?),
        (first, last) => {
            let (first, last): (u64, u64) =
                (first.parse().map_err(|_| invalid())?, last.parse().map_err(|_| invalid())?);
            (first, last.min(size.saturating_sub(1)))
        }
    };
    if start >= size || start > end {
        return Err(invalid());
    }
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_range_as_s3_does() {
        let ranges = [
            ("bytes=0-9", Some((0, 9))),
            ("bytes=5-", Some((5, 99))),
            ("bytes=-10", Some((90, 99))),
            ("bytes=90-200", Some((90, 99))),
        ];
        for (range, expected) in ranges {
            assert_eq!(byte_range(range, 100).ok(), expected, "{range}");
        }
        for range in ["bytes=100-", "bytes=5-2", "items=0-1", "bytes=a-b"] {
            assert!(byte_range(range, 100).is_err(), "{range}");
        }
    }

    #[test]
    fn decodes_a_query_its_plus_signs_as_spaces() {
        assert_eq!(
            parse_query("list-type=2&prefix=a%2Fb+c&delimiter=%2F&x"),
            [("list-type", "2"), ("prefix", "a/b c"), ("delimiter", "/"), ("x", "")]
                .map(|(a, b)| (a.to_string(), b.to_string()))
        );
    }
}
