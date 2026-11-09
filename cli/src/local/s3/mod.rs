//! S3 at `ff local start`'s front door (ADR 0017): the template's buckets, answered as FF's S3 front door answers them
//! (`BE/src/storage/front-door.ts`), the part of its store played here, the objects files on this machine
//! ([`store`]). Objects put, read whole, by a range or by a part, copied, deleted one by one or in a batch, listed both
//! ways; multipart uploads; presigned URLs; a bucket's region, and the settings FF's buckets don't have, read as S3
//! answers a bucket without them. A request signed with Signature Version 4, in its header or presigned, is checked
//! against the local key, and its body as it streams, as FF checks both; an unsigned one is taken, for `curl`. The
//! buckets are the template's: making one, deleting one, or what FF keeps of one, its tags, notifications, website,
//! policy and public access block, is refused, saying so. Its cases are `BE/src/storage/s3-examples.json`'s, which the
//! backend's tests read too.

pub mod checksums;
pub mod chunked;
pub mod defaults;
pub mod error;
pub mod requests;
pub mod signature;
pub mod store;
pub mod xml;

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Bound;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use self::checksums::ALGORITHMS;
use self::chunked::{
    Checked, ChunkedBody, ChunkedOptions, ExpectedChecksum, PlainBody, STREAMING_SIGNED, STREAMING_SIGNED_TRAILER,
    STREAMING_UNSIGNED_TRAILER,
};
use self::defaults::unset_answer;
use self::error::{
    S3Error, error_document, incomplete_body, internal_error, invalid_access_key_id, invalid_argument, invalid_request,
    malformed_xml, no_such_bucket, no_such_key, no_such_upload, not_implemented, not_implemented_because,
};
use self::requests::{Address, KEPT_SETTINGS, Style, address_of, operation_of, parse_query};
use self::signature::{RequestSignature, UNSIGNED_PAYLOAD, check_signature, read_signature};
use self::store::{Object, Store, Upload, Writing};
use self::xml::{
    child_text, children, document, key_text, list_buckets_document, location_document, root, text_element,
};
use super::http::{Incoming, Reply, Request, Response};
use super::key::Key;
use super::schedule_expression::Millis;
use crate::dates::{http_date, iso_millis, read_http_date};
use crate::md5::{Md5, hex_of};
use crate::sigv4::{Chain, SignedRequest, decode_escapes, uri_encode};

/// The hosts the buckets are reached at, each bucket's virtual-hosted under them: `<bucket>.s3.localhost` and
/// `<bucket>.localhost` from this machine, `<bucket>.host.docker.internal` from a function; path-style at any other.
pub const OWN_HOSTS: [&str; 3] = ["s3.localhost", "localhost", "host.docker.internal"];
/// S3's limit on an object sent in one PUT, and on a part of a multipart upload: 5 GiB.
const MAX_UPLOAD_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// The XML bodies read whole: a batch of deletes, a multipart upload's completion.
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
/// What S3 stores an object as, when its upload gives no type.
const DEFAULT_TYPE: &str = "binary/octet-stream";
/// A multipart upload's parts but its last are 5 MiB at least, and it has 10,000 at most.
const MIN_PART_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PARTS: u32 = 10_000;
/// A listing's most, of keys, of uploads, of parts; and a batch's most deletes.
const MAX_LISTED: usize = 1000;
/// What a body is read by.
const PIECE: usize = 64 * 1024;
/// The headers GetObject's answer takes from its query, by their parameters.
const OVERRIDES: [(&str, &str); 6] = [
    ("response-content-type", "content-type"),
    ("response-content-language", "content-language"),
    ("response-expires", "expires"),
    ("response-cache-control", "cache-control"),
    ("response-content-disposition", "content-disposition"),
    ("response-content-encoding", "content-encoding"),
];

/// The template's buckets, and how they answer.
pub struct Buckets {
    store: Store,
    /// The buckets' names, as ListBuckets lists them.
    names: Vec<String>,
    region: String,
    account: String,
    /// When ff local start began: each bucket's CreationDate.
    created: Millis,
    clock: Arc<dyn Fn() -> Millis + Send + Sync>,
    /// Says what goes wrong on this machine, which a caller learns as S3's InternalError alone.
    say: Arc<dyn Fn(&str) + Send + Sync>,
}

/// A request, as the buckets read it.
struct Exchange<'a> {
    head: &'a Request,
    raw_path: &'a str,
    raw_query: &'a str,
    query: Vec<(String, String)>,
    address: Address,
}

impl Exchange<'_> {
    /// A query parameter's value, decoded.
    fn parameter(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    fn bucket(&self) -> &str {
        &self.address.bucket
    }

    /// The object's key, decoded.
    fn key(&self) -> String {
        decode_escapes(&self.address.raw_key)
    }

    fn head_only(&self) -> bool {
        self.head.method == "HEAD"
    }
}

/// A body's checks, as FF's front door makes them of its request: aws-chunked's, a plain body's, or none.
enum Check {
    Chunked(Box<ChunkedBody>),
    Plain(Box<PlainBody>),
    Unchecked,
}

impl Check {
    /// The data a piece of the body holds, checked so far.
    fn feed<'b>(&mut self, piece: &'b [u8], decoded: &'b mut Vec<u8>) -> Result<&'b [u8], S3Error> {
        match self {
            Check::Chunked(chunked) => {
                decoded.clear();
                chunked.feed(piece, decoded)?;
                Ok(decoded)
            }
            Check::Plain(plain) => {
                plain.feed(piece);
                Ok(piece)
            }
            Check::Unchecked => Ok(piece),
        }
    }

    /// Whether the whole body passed, and the checksum it passed.
    fn finish(self) -> Result<Checked, S3Error> {
        match self {
            Check::Chunked(chunked) => chunked.finish(),
            Check::Plain(plain) => plain.finish(),
            Check::Unchecked => Ok(None),
        }
    }
}

/// A body received: its size, its MD5, and the checksum it passed.
struct Received {
    size: u64,
    md5: [u8; 16],
    checked: Checked,
}

/// What a range of an object's bytes reads: the whole of it, for a range S3 doesn't read; its bytes, first and last;
/// or none, past its end.
#[derive(Debug, PartialEq, Eq)]
enum Ranged {
    Whole,
    Bytes(u64, u64),
    Unsatisfiable,
}

/// A response without a body.
fn empty(status: u16, headers: Vec<(String, String)>) -> Reply {
    Reply::Whole(Response { status, headers, body: Vec::new() })
}

fn precondition_failed() -> S3Error {
    S3Error::new(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold")
}

/// A part number S3 takes: from 1 to 10,000.
fn part_number_error() -> S3Error {
    invalid_argument("Part number must be an integer between 1 and 10000, inclusive")
}

/// What FF keeps of a bucket, and the buckets themselves: the template's here, which ff local doesn't change.
fn the_templates(operation: &str) -> S3Error {
    not_implemented_because(&format!(
        "ff local's buckets are the template's, each made by its AWS::S3::Bucket with its settings and tags: ff local doesn't answer {operation}"
    ))
}

/// The checksum an upload carries in a header, at most one, or announces for its trailer, with the trailer's name.
fn expected_checksum(head: &Request) -> Result<(Option<ExpectedChecksum>, Option<String>), S3Error> {
    let header_of = |algorithm: &checksums::Algorithm| format!("x-amz-checksum-{}", algorithm.name());
    let in_headers: Vec<_> =
        ALGORITHMS.iter().filter(|algorithm| head.header(&header_of(algorithm)).is_some()).collect();
    if in_headers.len() > 1 {
        return Err(invalid_request(
            "Expecting a single x-amz-checksum- header. Multiple checksum Types are not allowed.",
        ));
    }
    if let Some(trailer) =
        head.header("x-amz-trailer").map(|name| name.trim().to_ascii_lowercase()).filter(|name| !name.is_empty())
    {
        let Some(algorithm) = trailer.strip_prefix("x-amz-checksum-").and_then(checksums::Algorithm::named) else {
            return Err(invalid_request(&format!("The trailer {trailer} is not a checksum S3 knows")));
        };
        return Ok((Some(ExpectedChecksum { algorithm, value: None }), Some(trailer)));
    }
    let expected = in_headers.first().map(|algorithm| ExpectedChecksum {
        algorithm: **algorithm,
        value: head.header(&header_of(algorithm)).map(str::to_owned),
    });
    Ok((expected, None))
}

/// An upload of more than S3 takes in one request, refused before it is read.
fn limit(operation: &str, bytes: u64) -> Result<(), S3Error> {
    if matches!(operation, "PutObject" | "UploadPart") && bytes > MAX_UPLOAD_BYTES {
        return Err(S3Error::new(400, "EntityTooLarge", "Your proposed upload exceeds the maximum allowed size"));
    }
    Ok(())
}

/// The MD5 a request's Content-MD5 says its body has, in base64: none without one.
fn content_md5(head: &Request) -> Result<Option<Vec<u8>>, S3Error> {
    let Some(sent) = head.header("content-md5") else { return Ok(None) };
    match STANDARD.decode(sent.trim()) {
        Ok(md5) if md5.len() == 16 => Ok(Some(md5)),
        _ => Err(S3Error::new(400, "InvalidDigest", "The Content-MD5 you specified was invalid.")),
    }
}

fn md5_matches(sent: Option<&Vec<u8>>, received: &Received) -> Result<(), S3Error> {
    match sent {
        Some(sent) if sent.as_slice() != received.md5.as_slice() => {
            Err(S3Error::new(400, "BadDigest", "The Content-MD5 you specified did not match what we received."))
        }
        _ => Ok(()),
    }
}

/// The headers an upload is kept with, which a read answers: the object's own and its metadata, as FF's front door
/// forwards them, its encoding without aws-chunked, and S3's type when it gives none.
fn kept_headers(head: &Request) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = Vec::new();
    for (name, value) in &head.headers {
        let name = name.to_ascii_lowercase();
        let own = matches!(
            name.as_str(),
            "content-type" | "content-language" | "content-disposition" | "cache-control" | "expires"
        ) || name.strip_prefix("x-amz-meta-").is_some_and(|rest| !rest.is_empty());
        if !own {
            continue;
        }
        match kept.iter_mut().find(|(kept_name, _)| *kept_name == name) {
            Some((_, kept_value)) => {
                kept_value.push(',');
                kept_value.push_str(value);
            }
            None => kept.push((name, value.clone())),
        }
    }
    let encodings: Vec<&str> = head
        .header("content-encoding")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|encoding| !encoding.is_empty() && *encoding != "aws-chunked")
        .collect();
    if !encodings.is_empty() {
        kept.push(("content-encoding".into(), encodings.join(",")));
    }
    if !kept.iter().any(|(name, _)| name == "content-type") {
        kept.push(("content-type".into(), DEFAULT_TYPE.into()));
    }
    kept
}

/// Whether an ETag is one of a condition's, `*` any.
fn etag_in(tags: &str, etag: &str) -> bool {
    tags.split(',')
        .map(str::trim)
        .any(|tag| tag == "*" || tag.trim_start_matches("W/").trim_matches('"') == etag.trim_matches('"'))
}

/// A read's conditions on the object, its headers' names after `prefix`: an ETag it has or a time it wasn't changed
/// since, else PreconditionFailed; whether it is unchanged by the other two, an ETag it hasn't or a time.
fn conditions(head: &Request, prefix: &str, object: &Object) -> Result<bool, S3Error> {
    let header = |name: &str| head.header(&format!("{prefix}{name}"));
    let date = |name: &str| header(name).and_then(read_http_date).map(|millis| millis.div_euclid(1000));
    let modified = object.modified.div_euclid(1000);
    match header("if-match") {
        Some(tags) if !etag_in(tags, &object.etag) => return Err(precondition_failed()),
        Some(_) => {}
        None if date("if-unmodified-since").is_some_and(|since| modified > since) => {
            return Err(precondition_failed());
        }
        None => {}
    }
    Ok(match header("if-none-match") {
        Some(tags) => etag_in(tags, &object.etag),
        None => date("if-modified-since").is_some_and(|since| modified <= since),
    })
}

/// The bytes a Range header reads of an object of `size` bytes: one range, as S3 reads it; several, or one it can't
/// read, the whole object.
fn byte_range(range: Option<&str>, size: u64) -> Ranged {
    let Some(spec) = range.and_then(|range| range.trim().strip_prefix("bytes=")) else { return Ranged::Whole };
    let Some((first, last)) = spec.split_once('-').filter(|_| !spec.contains(',')) else { return Ranged::Whole };
    let number = |text: &str| {
        text.trim().bytes().all(|byte| byte.is_ascii_digit()).then(|| text.trim().parse::<u64>().ok()).flatten()
    };
    match (first.trim().is_empty(), last.trim().is_empty()) {
        (true, true) => Ranged::Whole,
        (true, false) => match number(last) {
            None => Ranged::Whole,
            Some(0) => Ranged::Unsatisfiable,
            Some(_) if size == 0 => Ranged::Unsatisfiable,
            Some(suffix) => Ranged::Bytes(size.saturating_sub(suffix), size - 1),
        },
        (false, open) => {
            let (Some(start), end) = (number(first), if open { None } else { number(last) }) else {
                return Ranged::Whole;
            };
            if !open && end.is_none_or(|end| end < start) {
                return Ranged::Whole;
            }
            if start >= size {
                return Ranged::Unsatisfiable;
            }
            Ranged::Bytes(start, end.map_or(size - 1, |end| end.min(size - 1)))
        }
    }
}

/// A copy's source, `[/]<bucket>/<key>`, decoded, as FF's front door reads it: a version of it isn't served.
fn copy_source(value: &str) -> Result<(String, String), S3Error> {
    let mut split = value.split('?');
    let (source, versioned) = (split.next().unwrap_or_default(), split.next().unwrap_or_default());
    if versioned.split('&').any(|pair| pair.starts_with("versionId=")) {
        return Err(not_implemented());
    }
    let path = source.strip_prefix('/').unwrap_or(source);
    match path.find('/') {
        Some(slash) if slash > 0 && slash < path.len() - 1 => {
            Ok((decode_escapes(&path[..slash]), decode_escapes(&path[slash + 1..])))
        }
        _ => Err(invalid_request("The x-amz-copy-source header is not <bucket>/<key>")),
    }
}

/// How a listing shows a key or a prefix: as it is, or URL-encoded when it asks; escaped.
#[derive(Clone, Copy)]
struct Shown {
    url: bool,
}

impl Shown {
    fn of(x: &Exchange) -> Result<Self, S3Error> {
        match x.parameter("encoding-type") {
            None => Ok(Self { url: false }),
            Some("url") => Ok(Self { url: true }),
            Some(_) => Err(invalid_argument("Invalid Encoding Method specified in Request")),
        }
    }

    fn element(self, name: &str, text: &str) -> String {
        match self.url {
            true => text_element(name, &uri_encode(text, true)),
            false => text_element(name, text),
        }
    }

    fn encoding_type(self) -> &'static str {
        if self.url { "<EncodingType>url</EncodingType>" } else { "" }
    }
}

/// A listing's most, from its parameter: at most 1,000; a value that isn't a number refused, naming it.
fn most(x: &Exchange, parameter: &str) -> Result<usize, S3Error> {
    match x.parameter(parameter) {
        None => Ok(MAX_LISTED),
        Some(value) => value
            .parse::<usize>()
            .map(|most| most.min(MAX_LISTED))
            .map_err(|_| invalid_argument(&format!("Provided {parameter} not an integer or within integer range"))),
    }
}

/// The prefix a key is listed under, when a delimiter follows the listing's prefix in it.
fn rolled_up(key: &str, prefix: &str, delimiter: Option<&str>) -> Option<String> {
    let delimiter = delimiter?;
    let rest = key.strip_prefix(prefix)?;
    rest.find(delimiter).map(|at| format!("{prefix}{}", &rest[..at + delimiter.len()]))
}

impl Buckets {
    /// The template's buckets, under `root`, a folder each, their objects read back from what an earlier start kept.
    pub fn open(
        root: &Path,
        names: Vec<String>,
        region: &str,
        account: &str,
        clock: Arc<dyn Fn() -> Millis + Send + Sync>,
        say: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> io::Result<Self> {
        let store = Store::open(root, &names, &*say)?;
        let created = clock();
        Ok(Self { store, names, region: region.into(), account: account.into(), created, clock, say })
    }

    /// No buckets, as a template without one has: nothing on disk.
    #[cfg(test)]
    pub fn none() -> Self {
        let (region, account) = ("tn-tunis-1", "000000000000");
        Self::open(Path::new("no-buckets"), Vec::new(), region, account, Arc::new(|| 0), Arc::new(|_: &str| {}))
            .expect("no buckets")
    }

    /// Whether a bucket of that name is the template's.
    pub fn has(&self, bucket: &str) -> bool {
        self.store.has(bucket)
    }

    /// The answer to a request, its body read from `body` as it streams, signed with `key` or unsigned; a key that
    /// isn't it given to `other_key`, which says it, as no caller learns which key ff local has.
    pub fn answer(
        &self,
        head: &Request,
        body: &mut Incoming,
        key: &Key,
        request_id: &str,
        other_key: impl Fn(&str),
    ) -> Reply {
        let (raw_path, raw_query) = head.target.split_once('?').unwrap_or((head.target.as_str(), ""));
        let x = Exchange {
            head,
            raw_path,
            raw_query,
            query: parse_query(raw_query),
            address: address_of(head.header("host"), raw_path, &OWN_HOSTS),
        };
        let mut reply =
            self.served(&x, body, key, &other_key).unwrap_or_else(|error| self.refusal(&x, &error, request_id));
        let headers = match &mut reply {
            Reply::Whole(response) | Reply::File { response, .. } => &mut response.headers,
        };
        headers.push(("x-amz-request-id".into(), request_id.into()));
        reply
    }

    /// S3's answer to a request it couldn't read as HTTP.
    pub fn unreadable(&self, request_id: &str) -> Response {
        let refused = incomplete_body(Some("The request couldn't be read as HTTP."));
        Response {
            status: refused.status,
            headers: vec![("content-type".into(), "application/xml".into())],
            body: error_document(&refused, request_id, None).into_bytes(),
        }
    }

    /// The error's document, the resource asked for in it when it names a bucket; nothing for a HEAD.
    fn refusal(&self, x: &Exchange, error: &S3Error, request_id: &str) -> Reply {
        let resource = (!x.bucket().is_empty()).then(|| decode_escapes(x.raw_path));
        let body = match x.head_only() {
            true => Vec::new(),
            false => error_document(error, request_id, resource.as_deref()).into_bytes(),
        };
        Reply::Whole(Response {
            status: error.status,
            headers: vec![("content-type".into(), "application/xml".into())],
            body,
        })
    }

    fn now(&self) -> Millis {
        (self.clock)()
    }

    /// Says what went wrong on this machine: a caller learns S3's InternalError alone.
    fn failed(&self, what: &str, error: &io::Error) -> S3Error {
        (self.say)(&format!("ff local couldn't {what}: {error}"));
        internal_error()
    }

    /// A document of S3's, as the front door answers it.
    fn document(&self, document: String) -> Reply {
        Reply::Whole(Response {
            status: 200,
            headers: vec![("content-type".into(), "application/xml".into())],
            body: document.into_bytes(),
        })
    }

    /// The request's signature, checked against the local key, as FF checks one against its keys; none for an
    /// unsigned request, which is taken. What its body's chunks chain from, with it.
    fn signed(
        &self,
        x: &Exchange,
        key: &Key,
        other_key: &dyn Fn(&str),
    ) -> Result<Option<(RequestSignature, Chain)>, S3Error> {
        let Some(signature) = read_signature(&x.head.headers, &x.query)? else { return Ok(None) };
        if signature.signed.access_key_id != key.id {
            other_key(&signature.signed.access_key_id);
            return Err(invalid_access_key_id());
        }
        let request = SignedRequest {
            method: &x.head.method,
            raw_path: x.raw_path,
            raw_query: x.raw_query,
            headers: &x.head.headers,
        };
        let chain = check_signature(&request, &signature, &key.secret, self.now())?;
        Ok(Some((signature, chain)))
    }

    fn served(&self, x: &Exchange, body: &mut Incoming, key: &Key, other_key: &dyn Fn(&str)) -> Result<Reply, S3Error> {
        let signed = self.signed(x, key, other_key)?;
        let operation =
            operation_of(&x.head.method, &x.address, &x.query, x.head.header("x-amz-copy-source").is_some());
        let name = operation.name;
        match name {
            "NotImplemented" => return Err(not_implemented()),
            "ListBuckets" => {
                let created = iso_millis(self.created);
                let buckets: Vec<(String, String)> =
                    self.names.iter().map(|name| (name.clone(), created.clone())).collect();
                return Ok(self.document(list_buckets_document(&self.account, &buckets, &self.region)));
            }
            "CreateBucket" => return Err(the_templates(name)),
            _ => {}
        }
        if !self.store.has(x.bucket()) {
            return Err(no_such_bucket());
        }
        let kept =
            KEPT_SETTINGS.iter().any(|(_, get, put, delete)| *get == name || *put == name || *delete == Some(name));
        if kept || name == "DeleteBucket" {
            return Err(the_templates(name));
        }
        if name == "GetBucketLocation" {
            return Ok(self.document(location_document(&self.region)));
        }
        if let Some(answer) = unset_answer(name, &self.account) {
            return answer.map(|answer| self.document(answer));
        }
        if name == "HeadBucket" {
            return Ok(empty(200, vec![("x-amz-bucket-region".into(), self.region.clone())]));
        }
        let check = match x.head.method.as_str() {
            "PUT" | "POST" => self.checks(x, signed, name)?,
            _ => Check::Unchecked,
        };
        match name {
            "ListObjects" => self.list(x, false),
            "ListObjectsV2" => self.list(x, true),
            "GetObject" | "HeadObject" => self.get(x),
            "PutObject" => self.put(x, body, check),
            "CopyObject" => self.copy(x, body, check),
            "DeleteObject" => {
                self.store.remove(x.bucket(), &x.key());
                Ok(empty(204, Vec::new()))
            }
            "DeleteObjects" => self.delete_objects(x, body, check),
            "CreateMultipartUpload" => self.create_upload(x, body, check),
            "UploadPart" => self.upload_part(x, body, check),
            "UploadPartCopy" => self.upload_part_copy(x, body, check),
            "CompleteMultipartUpload" => self.complete_upload(x, body, check),
            "AbortMultipartUpload" => {
                let (id, _) = self.upload_of(x)?;
                if self.store.end_upload(&id).is_some() {
                    self.store.remove_parts(x.bucket(), &id);
                }
                Ok(empty(204, Vec::new()))
            }
            "ListParts" => self.list_parts(x),
            "ListMultipartUploads" => self.list_uploads(x),
            _ => Err(not_implemented()),
        }
    }

    /// The body's checks, from the request, in FF's front door's order: aws-chunked's reader, with its decoded length;
    /// else a plain body's length, then its SHA-256 and checksum. A presigned URL signs no body, nor does an unsigned
    /// request: its body is taken as it comes.
    fn checks(
        &self,
        x: &Exchange,
        signed: Option<(RequestSignature, Chain)>,
        operation: &str,
    ) -> Result<Check, S3Error> {
        let head = x.head;
        if let Some((signature, chain)) =
            signed.as_ref().filter(|(signature, _)| signature.payload.starts_with("STREAMING-"))
        {
            let payload = signature.payload.as_str();
            if ![STREAMING_SIGNED, STREAMING_SIGNED_TRAILER, STREAMING_UNSIGNED_TRAILER].contains(&payload) {
                return Err(not_implemented());
            }
            let Some(decoded_length) =
                head.header("x-amz-decoded-content-length").and_then(|length| length.parse().ok())
            else {
                return Err(S3Error::new(
                    411,
                    "MissingContentLength",
                    "You must provide the x-amz-decoded-content-length HTTP header.",
                ));
            };
            limit(operation, decoded_length)?;
            let (checksum, trailer_name) = expected_checksum(head)?;
            return Ok(Check::Chunked(Box::new(ChunkedBody::new(ChunkedOptions {
                chain: (payload != STREAMING_UNSIGNED_TRAILER).then(|| chain.clone()),
                trailer: payload.ends_with("-TRAILER"),
                decoded_length,
                checksum,
                trailer_name,
            }))));
        }
        let Some(length) = head.header("content-length").and_then(|length| length.parse::<u64>().ok()) else {
            return Err(S3Error::new(411, "MissingContentLength", "You must provide the Content-Length HTTP header."));
        };
        limit(operation, length)?;
        let Some((signature, _)) = signed.filter(|(signature, _)| !signature.presigned) else {
            return Ok(Check::Unchecked);
        };
        let (checksum, _) = expected_checksum(head)?;
        let sha256 = (signature.payload != UNSIGNED_PAYLOAD).then_some(signature.payload);
        if sha256.as_ref().is_some_and(|sha256| {
            sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(invalid_request(
                "x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a STREAMING- payload, or a SHA-256 in hexadecimal",
            ));
        }
        Ok(match (sha256, checksum) {
            (None, None) => Check::Unchecked,
            (sha256, checksum) => Check::Plain(Box::new(PlainBody::new(sha256, checksum))),
        })
    }

    /// The body, through its checks, given to `out` as it comes; its Content-MD5 checked at its end.
    fn receive(
        &self,
        x: &Exchange,
        body: &mut Incoming,
        mut check: Check,
        out: &mut dyn FnMut(&[u8]) -> Result<(), S3Error>,
    ) -> Result<Received, S3Error> {
        let sent_md5 = content_md5(x.head)?;
        let (mut piece, mut decoded) = (vec![0; PIECE], Vec::with_capacity(PIECE));
        let (mut size, mut md5) = (0u64, Md5::default());
        loop {
            let read = body.read(&mut piece).map_err(|_| incomplete_body(None))?;
            if read == 0 {
                break;
            }
            let data = check.feed(&piece[..read], &mut decoded)?;
            size += data.len() as u64;
            md5.update(data);
            out(data)?;
        }
        let received = Received { size, md5: md5.finish(), checked: check.finish()? };
        md5_matches(sent_md5.as_ref(), &received)?;
        Ok(received)
    }

    /// A request's small document, read whole through its checks: 2 MiB at most.
    fn read_document(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<String, S3Error> {
        let mut document = Vec::new();
        self.receive(x, body, check, &mut |data| {
            if document.len() + data.len() > MAX_DOCUMENT_BYTES {
                return Err(S3Error::new(400, "MaxMessageLengthExceeded", "Your request was too big."));
            }
            document.extend_from_slice(data);
            Ok(())
        })?;
        String::from_utf8(document).map_err(|_| malformed_xml())
    }

    /// The body received into a new file, discarded unless it passed its checks.
    fn receive_into(
        &self,
        x: &Exchange,
        body: &mut Incoming,
        check: Check,
        mut writing: Writing,
    ) -> Result<(Writing, Received), S3Error> {
        let what = format!("write {}/{}", x.bucket(), x.key());
        let received = self
            .receive(x, body, check, &mut |data| writing.write_all(data).map_err(|error| self.failed(&what, &error)));
        match received {
            Ok(received) => Ok((writing, received)),
            Err(error) => {
                writing.discard();
                Err(error)
            }
        }
    }

    /// `length` bytes of a file from `start`, into a new file: their MD5.
    fn copy_bytes(
        &self,
        what: &str,
        file: &mut File,
        start: u64,
        length: u64,
        writing: &mut Writing,
    ) -> Result<[u8; 16], S3Error> {
        let failed = |error: io::Error| self.failed(what, &error);
        file.seek(SeekFrom::Start(start)).map_err(failed)?;
        let (mut piece, mut md5, mut left) = (vec![0; PIECE], Md5::default(), length);
        while left > 0 {
            let want = piece.len().min(usize::try_from(left).unwrap_or(usize::MAX));
            let read = file.read(&mut piece[..want]).map_err(failed)?;
            if read == 0 {
                return Err(failed(io::Error::new(io::ErrorKind::UnexpectedEof, "a file shorter than its object")));
            }
            md5.update(&piece[..read]);
            writing.write_all(&piece[..read]).map_err(failed)?;
            left -= read as u64;
        }
        Ok(md5.finish())
    }

    /// PutObject: the body streamed to a file of its own, which takes the key's place once it passed its checks; its
    /// ETag, and the checksum it passed, as FF's front door gives it back.
    fn put(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        let key = x.key();
        let writing = self
            .store
            .writing(x.bucket(), &key)
            .map_err(|error| self.failed(&format!("write {}/{key}", x.bucket()), &error))?;
        let (writing, received) = self.receive_into(x, body, check, writing)?;
        let etag = format!("\"{}\"", hex_of(&received.md5));
        let object = Object {
            key,
            file: String::new(),
            size: received.size,
            etag: etag.clone(),
            modified: self.now(),
            headers: kept_headers(x.head),
            parts: Vec::new(),
        };
        self.store
            .keep(x.bucket(), writing, object)
            .map_err(|error| self.failed(&format!("keep {}/{}", x.bucket(), x.key()), &error))?;
        let mut headers = vec![("etag".to_owned(), etag)];
        if let Some((algorithm, value)) = received.checked {
            headers.push((format!("x-amz-checksum-{}", algorithm.name()), value));
            headers.push(("x-amz-checksum-type".into(), "FULL_OBJECT".into()));
        }
        Ok(empty(200, headers))
    }

    /// GetObject and HeadObject: the object's bytes, whole, by a range or by a part, from its file as it is read; the
    /// headers it was written with, those its query overrides, and its own; its conditions first. No checksum, as FF's
    /// front door answers none.
    fn get(&self, x: &Exchange) -> Result<Reply, S3Error> {
        let key = x.key();
        let opened = self
            .store
            .open_object(x.bucket(), &key)
            .map_err(|error| self.failed(&format!("read {}/{key}", x.bucket()), &error))?;
        let Some((object, mut file)) = opened else { return Err(no_such_key()) };
        let mut headers = object.headers.clone();
        if conditions(x.head, "", &object)? {
            let own = [("etag", object.etag.clone()), ("last-modified", http_date(object.modified))];
            return Ok(empty(304, own.into_iter().map(|(name, value)| (name.into(), value)).collect()));
        }
        let range = x.head.header("range");
        let (status, start, length, parts_count) = match x.parameter("partNumber") {
            Some(_) if range.is_some() => {
                return Err(invalid_request("Cannot specify both Range header and partNumber query parameter"));
            }
            Some(number) => {
                let number = number.parse::<usize>().ok().filter(|number| (1..=MAX_PARTS as usize).contains(number));
                let number = number.ok_or_else(part_number_error)?;
                let sizes = if object.parts.is_empty() { vec![object.size] } else { object.parts.clone() };
                let Some(size) = sizes.get(number - 1) else {
                    return Err(S3Error::new(416, "InvalidPartNumber", "The requested partnumber is not satisfiable"));
                };
                let parts_count = (!object.parts.is_empty()).then_some(object.parts.len());
                (if *size > 0 { 206 } else { 200 }, sizes[..number - 1].iter().sum(), *size, parts_count)
            }
            None => match byte_range(range, object.size) {
                Ranged::Whole => (200, 0, object.size, None),
                Ranged::Bytes(start, end) => (206, start, end - start + 1, None),
                Ranged::Unsatisfiable => {
                    return Err(S3Error::new(416, "InvalidRange", "The requested range is not satisfiable"));
                }
            },
        };
        for (parameter, header) in OVERRIDES {
            if let Some(value) = x.parameter(parameter) {
                headers.retain(|(name, _)| name != header);
                headers.push((header.into(), value.into()));
            }
        }
        headers.push(("etag".into(), object.etag.clone()));
        headers.push(("last-modified".into(), http_date(object.modified)));
        headers.push(("accept-ranges".into(), "bytes".into()));
        if status == 206 {
            headers.push(("content-range".into(), format!("bytes {start}-{}/{}", start + length - 1, object.size)));
        }
        if let Some(count) = parts_count {
            headers.push(("x-amz-mp-parts-count".into(), count.to_string()));
        }
        let file = match x.head_only() {
            true => None,
            false => {
                file.seek(SeekFrom::Start(start))
                    .map_err(|error| self.failed(&format!("read {}/{key}", x.bucket()), &error))?;
                Some(file)
            }
        };
        Ok(Reply::File { response: Response { status, headers, body: Vec::new() }, file, length })
    }

    /// The object a copy reads, its source's conditions held: a bucket of the template's, as FF's front door reads it.
    fn source(&self, x: &Exchange) -> Result<(String, Object, File), S3Error> {
        let (bucket, key) = copy_source(x.head.header("x-amz-copy-source").unwrap_or_default())?;
        if !self.store.has(&bucket) {
            return Err(no_such_bucket());
        }
        let opened = self
            .store
            .open_object(&bucket, &key)
            .map_err(|error| self.failed(&format!("read {bucket}/{key}"), &error))?;
        let Some((object, file)) = opened else { return Err(no_such_key()) };
        // A copy's condition that doesn't hold is PreconditionFailed, one that says it is unchanged too.
        if conditions(x.head, "x-amz-copy-source-", &object)? {
            return Err(precondition_failed());
        }
        Ok((format!("{bucket}/{key}"), object, file))
    }

    /// CopyObject: the source's bytes, into an object of their own; its headers, unless the request replaces them.
    fn copy(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        self.read_document(x, body, check)?;
        let replace = match x.head.header("x-amz-metadata-directive").map(str::to_ascii_uppercase).as_deref() {
            None | Some("COPY") => false,
            Some("REPLACE") => true,
            Some(_) => return Err(invalid_argument("Unknown metadata directive.")),
        };
        let key = x.key();
        let (source_name, source, mut file) = self.source(x)?;
        if !replace && source_name == format!("{}/{key}", x.bucket()) {
            return Err(invalid_request(
                "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, storage class, website redirect location or encryption attributes.",
            ));
        }
        let what = format!("copy {source_name} to {}/{key}", x.bucket());
        let mut writing = self.store.writing(x.bucket(), &key).map_err(|error| self.failed(&what, &error))?;
        let md5 = match self.copy_bytes(&what, &mut file, 0, source.size, &mut writing) {
            Ok(md5) => md5,
            Err(error) => {
                writing.discard();
                return Err(error);
            }
        };
        let object = Object {
            key,
            file: String::new(),
            size: source.size,
            etag: format!("\"{}\"", hex_of(&md5)),
            modified: self.now(),
            headers: if replace { kept_headers(x.head) } else { source.headers },
            parts: Vec::new(),
        };
        let result = format!(
            "{}{}",
            text_element("LastModified", &iso_millis(object.modified)),
            text_element("ETag", &object.etag)
        );
        self.store.keep(x.bucket(), writing, object).map_err(|error| self.failed(&what, &error))?;
        Ok(self.document(document("CopyObjectResult", &result)))
    }

    /// DeleteObjects: each key of the document deleted, as S3 deletes one that isn't there too; each named in the
    /// answer, unless it is quiet.
    fn delete_objects(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        let text = self.read_document(x, body, check)?;
        let delete = root(&text, "Delete")?;
        let quiet = child_text(delete, "Quiet").is_some_and(|quiet| quiet.eq_ignore_ascii_case("true"));
        let objects = children(delete, "Object");
        if objects.is_empty() || objects.len() > MAX_LISTED {
            return Err(malformed_xml());
        }
        let mut result = String::new();
        for object in objects {
            let key = key_text(object).ok_or_else(malformed_xml)?;
            if child_text(object, "VersionId").is_some_and(|version| version != "null") {
                result.push_str(&format!(
                    "<Error>{}<Code>NoSuchVersion</Code><Message>The specified version does not exist.</Message></Error>",
                    text_element("Key", &key)
                ));
                continue;
            }
            self.store.remove(x.bucket(), &key);
            if !quiet {
                result.push_str(&format!("<Deleted>{}</Deleted>", text_element("Key", &key)));
            }
        }
        Ok(self.document(document("DeleteResult", &result)))
    }

    /// The upload a request names, of its bucket and key.
    fn upload_of(&self, x: &Exchange) -> Result<(String, Upload), S3Error> {
        let id = x.parameter("uploadId").unwrap_or_default();
        match self.store.upload(id) {
            Some(upload) if upload.bucket == x.bucket() && upload.key == x.key() => Ok((id.to_owned(), upload)),
            _ => Err(no_such_upload()),
        }
    }

    fn part_number(x: &Exchange) -> Result<u32, S3Error> {
        let number = x.parameter("partNumber").and_then(|number| number.parse::<u32>().ok());
        number.filter(|number| (1..=MAX_PARTS).contains(number)).ok_or_else(part_number_error)
    }

    /// CreateMultipartUpload: an upload begun, the headers its object takes kept with it.
    fn create_upload(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        self.read_document(x, body, check)?;
        let key = x.key();
        let id = self
            .store
            .begin_upload(x.bucket(), &key, kept_headers(x.head), self.now())
            .map_err(|error| self.failed(&format!("begin an upload of {}/{key}", x.bucket()), &error))?;
        let result = [("Bucket", x.bucket()), ("Key", key.as_str()), ("UploadId", id.as_str())];
        let result: String = result.iter().map(|(name, text)| text_element(name, text)).collect();
        Ok(self.document(document("InitiateMultipartUploadResult", &result)))
    }

    /// UploadPart: the body, checked as PutObject's is, kept as the upload's part of its number; its ETag.
    fn upload_part(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        let number = Self::part_number(x)?;
        let (id, _) = self.upload_of(x)?;
        let what = format!("write a part of {}/{}", x.bucket(), x.key());
        let writing = self.store.writing_part(x.bucket(), &id, number).map_err(|error| self.failed(&what, &error))?;
        let (writing, received) = self.receive_into(x, body, check, writing)?;
        if !self.store.keep_part(&id, number, writing, received.size, received.md5, self.now()) {
            return Err(no_such_upload());
        }
        Ok(empty(200, vec![("etag".into(), format!("\"{}\"", hex_of(&received.md5)))]))
    }

    /// UploadPartCopy: a range of the source's bytes, or all of them, as the upload's part of its number.
    fn upload_part_copy(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        self.read_document(x, body, check)?;
        let number = Self::part_number(x)?;
        let (id, _) = self.upload_of(x)?;
        let (source_name, source, mut file) = self.source(x)?;
        let (start, length) = match x.head.header("x-amz-copy-source-range") {
            None => (0, source.size),
            Some(range) => {
                let bytes = range.trim().strip_prefix("bytes=").and_then(|bytes| bytes.split_once('-'));
                let bytes =
                    bytes.and_then(|(first, last)| Some((first.parse::<u64>().ok()?, last.parse::<u64>().ok()?)));
                let Some((first, last)) = bytes.filter(|(first, last)| first <= last) else {
                    return Err(invalid_argument(
                        "The x-amz-copy-source-range value must be of the form bytes=first-last where first and last are the zero-based offsets of the first and last bytes to copy",
                    ));
                };
                if last >= source.size {
                    return Err(S3Error::new(416, "InvalidRange", "The requested range is not satisfiable"));
                }
                (first, last - first + 1)
            }
        };
        let what = format!("copy {source_name} to a part of {}/{}", x.bucket(), x.key());
        let mut writing =
            self.store.writing_part(x.bucket(), &id, number).map_err(|error| self.failed(&what, &error))?;
        let md5 = match self.copy_bytes(&what, &mut file, start, length, &mut writing) {
            Ok(md5) => md5,
            Err(error) => {
                writing.discard();
                return Err(error);
            }
        };
        let now = self.now();
        if !self.store.keep_part(&id, number, writing, length, md5, now) {
            return Err(no_such_upload());
        }
        let result = format!(
            "{}{}",
            text_element("LastModified", &iso_millis(now)),
            text_element("ETag", &format!("\"{}\"", hex_of(&md5)))
        );
        Ok(self.document(document("CopyPartResult", &result)))
    }

    /// CompleteMultipartUpload: the parts the document names, in order, each with its ETag, all but the last of 5 MiB
    /// at least, made one object; its ETag S3's of a multipart upload, the MD5 of the parts' MD5s and their number;
    /// its address as the client reached it.
    fn complete_upload(&self, x: &Exchange, body: &mut Incoming, check: Check) -> Result<Reply, S3Error> {
        let text = self.read_document(x, body, check)?;
        let (id, upload) = self.upload_of(x)?;
        let mut named = Vec::new();
        for part in children(root(&text, "CompleteMultipartUpload")?, "Part") {
            let number = child_text(part, "PartNumber").and_then(|number| number.parse::<u32>().ok());
            let (Some(number), Some(etag)) = (number, child_text(part, "ETag")) else { return Err(malformed_xml()) };
            named.push((number, etag));
        }
        if named.is_empty() {
            return Err(malformed_xml());
        }
        if named.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return Err(S3Error::new(
                400,
                "InvalidPartOrder",
                "The list of parts was not in ascending order. The parts list must be specified in order by part number.",
            ));
        }
        let mut parts = Vec::new();
        for (number, etag) in &named {
            match upload.parts.get(number) {
                Some(part) if etag_in(etag, &part.etag()) && etag != "*" => parts.push(part),
                _ => {
                    return Err(S3Error::new(
                        400,
                        "InvalidPart",
                        "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.",
                    ));
                }
            }
        }
        if parts[..parts.len() - 1].iter().any(|part| part.size < MIN_PART_BYTES) {
            return Err(S3Error::new(
                400,
                "EntityTooSmall",
                "Your proposed upload is smaller than the minimum allowed object size.",
            ));
        }
        let key = x.key();
        let what = format!("complete an upload of {}/{key}", x.bucket());
        let mut writing = self.store.writing(x.bucket(), &key).map_err(|error| self.failed(&what, &error))?;
        let mut md5s = Md5::default();
        for part in &parts {
            md5s.update(&part.md5);
            let copied = File::open(&part.file).and_then(|mut file| io::copy(&mut file, &mut writing));
            if let Err(error) = copied {
                writing.discard();
                return Err(self.failed(&what, &error));
            }
        }
        if self.store.end_upload(&id).is_none() {
            writing.discard();
            return Err(no_such_upload());
        }
        let etag = format!("\"{}-{}\"", hex_of(&md5s.finish()), parts.len());
        let object = Object {
            key: key.clone(),
            file: String::new(),
            size: parts.iter().map(|part| part.size).sum(),
            etag: etag.clone(),
            modified: self.now(),
            headers: upload.headers,
            parts: parts.iter().map(|part| part.size).collect(),
        };
        let kept = self.store.keep(x.bucket(), writing, object);
        self.store.remove_parts(x.bucket(), &id);
        kept.map_err(|error| self.failed(&what, &error))?;
        let host = x.head.header("host").unwrap_or("localhost");
        let location = match x.address.style {
            Style::VirtualHosted => format!("http://{host}/{}", x.address.raw_key),
            Style::Path => format!("http://{host}/{}/{}", x.bucket(), x.address.raw_key),
        };
        let result =
            [("Location", location.as_str()), ("Bucket", x.bucket()), ("Key", key.as_str()), ("ETag", etag.as_str())];
        let result: String = result.iter().map(|(name, text)| text_element(name, text)).collect();
        Ok(self.document(document("CompleteMultipartUploadResult", &result)))
    }

    /// The account, as the owner and the initiator of everything here.
    fn owner(&self, element: &str) -> String {
        format!(
            "<{element}>{}{}</{element}>",
            text_element("ID", &self.account),
            text_element("DisplayName", &self.account)
        )
    }

    /// ListParts: an upload's parts, by their numbers, after a marker.
    fn list_parts(&self, x: &Exchange) -> Result<Reply, S3Error> {
        let (id, upload) = self.upload_of(x)?;
        let shown = Shown::of(x)?;
        let most = most(x, "max-parts")?;
        let marker = match x.parameter("part-number-marker") {
            None => 0,
            Some(marker) => marker
                .parse::<u32>()
                .map_err(|_| invalid_argument("Provided part-number-marker not an integer or within integer range"))?,
        };
        let listed: Vec<_> = upload.parts.range((Bound::Excluded(marker), Bound::Unbounded)).take(most + 1).collect();
        let truncated = listed.len() > most;
        let listed = &listed[..listed.len().min(most)];
        let mut result = format!(
            "{}{}{}<PartNumberMarker>{marker}</PartNumberMarker>",
            text_element("Bucket", x.bucket()),
            shown.element("Key", &upload.key),
            text_element("UploadId", &id)
        );
        if let Some((last, _)) = listed.last() {
            result.push_str(&format!("<NextPartNumberMarker>{last}</NextPartNumberMarker>"));
        }
        result.push_str(&format!(
            "<MaxParts>{most}</MaxParts><IsTruncated>{truncated}</IsTruncated>{}{}<StorageClass>STANDARD</StorageClass>{}",
            self.owner("Initiator"),
            self.owner("Owner"),
            shown.encoding_type()
        ));
        for (number, part) in listed {
            result.push_str(&format!(
                "<Part><PartNumber>{number}</PartNumber>{}{}<Size>{}</Size></Part>",
                text_element("LastModified", &iso_millis(part.modified)),
                text_element("ETag", &part.etag()),
                part.size
            ));
        }
        Ok(self.document(document("ListPartsResult", &result)))
    }

    /// ListMultipartUploads: the bucket's uploads under way, by their keys, then their IDs, after the markers; those
    /// under a prefix the delimiter ends rolled up into it.
    fn list_uploads(&self, x: &Exchange) -> Result<Reply, S3Error> {
        let shown = Shown::of(x)?;
        let most = most(x, "max-uploads")?;
        let prefix = x.parameter("prefix").unwrap_or_default();
        let delimiter = x.parameter("delimiter").filter(|delimiter| !delimiter.is_empty());
        let key_marker = x.parameter("key-marker").unwrap_or_default();
        let id_marker = x.parameter("upload-id-marker").filter(|_| !key_marker.is_empty());
        let after = |key: &str, id: &str| match id_marker {
            Some(id_marker) => (key, id) > (key_marker, id_marker),
            None => key > key_marker,
        };
        let (mut uploads, mut prefixes, mut count, mut truncated) = (String::new(), Vec::<String>::new(), 0, false);
        let mut last: Option<(String, String)> = None;
        for (id, upload) in self.store.uploads_of(x.bucket()) {
            if !upload.key.starts_with(prefix) || !after(&upload.key, &id) {
                continue;
            }
            let rolled = rolled_up(&upload.key, prefix, delimiter);
            if rolled.is_some() && prefixes.last() == rolled.as_ref() {
                continue;
            }
            if count == most {
                truncated = true;
                break;
            }
            count += 1;
            match rolled {
                Some(rolled) => {
                    last = Some((rolled.clone(), String::new()));
                    prefixes.push(rolled);
                }
                None => {
                    uploads.push_str(&format!(
                        "<Upload>{}{}{}{}<StorageClass>STANDARD</StorageClass>{}</Upload>",
                        shown.element("Key", &upload.key),
                        text_element("UploadId", &id),
                        self.owner("Initiator"),
                        self.owner("Owner"),
                        text_element("Initiated", &iso_millis(upload.initiated))
                    ));
                    last = Some((upload.key, id));
                }
            }
        }
        let mut result = format!(
            "{}{}{}",
            text_element("Bucket", x.bucket()),
            shown.element("KeyMarker", key_marker),
            text_element("UploadIdMarker", id_marker.unwrap_or_default())
        );
        if let (true, Some((key, id))) = (truncated, &last) {
            result.push_str(&format!(
                "{}{}",
                shown.element("NextKeyMarker", key),
                text_element("NextUploadIdMarker", id)
            ));
        }
        result.push_str(&shown.element("Prefix", prefix));
        if let Some(delimiter) = delimiter {
            result.push_str(&shown.element("Delimiter", delimiter));
        }
        result.push_str(&format!(
            "<MaxUploads>{most}</MaxUploads><IsTruncated>{truncated}</IsTruncated>{}{uploads}",
            shown.encoding_type()
        ));
        for prefix in &prefixes {
            result.push_str(&format!("<CommonPrefixes>{}</CommonPrefixes>", shown.element("Prefix", prefix)));
        }
        Ok(self.document(document("ListMultipartUploadsResult", &result)))
    }

    /// ListObjects, and its second version: the keys under a prefix, in order, after a marker, a start or where the
    /// last page ended; those under a prefix the delimiter ends rolled up into it, which a page resumed after it
    /// passes over.
    fn list(&self, x: &Exchange, v2: bool) -> Result<Reply, S3Error> {
        let shown = Shown::of(x)?;
        let most = most(x, "max-keys")?;
        let prefix = x.parameter("prefix").unwrap_or_default();
        let delimiter = x.parameter("delimiter").filter(|delimiter| !delimiter.is_empty());
        let token = x.parameter("continuation-token").filter(|_| v2);
        let start_after = x.parameter("start-after").filter(|_| v2).unwrap_or_default();
        let marker = x.parameter("marker").filter(|_| !v2).unwrap_or_default();
        let incorrect = || invalid_argument("The continuation token provided is incorrect");
        let (after, resumed) = match token {
            Some(token) => {
                let decoded = STANDARD.decode(token).map_err(|_| incorrect())?;
                (String::from_utf8(decoded).map_err(|_| incorrect())?, true)
            }
            None if v2 => (start_after.to_owned(), false),
            None => (marker.to_owned(), !marker.is_empty()),
        };
        let owned = !v2 || x.parameter("fetch-owner") == Some("true");
        let lower =
            if after.as_str() >= prefix { Bound::Excluded(after.clone()) } else { Bound::Included(prefix.to_owned()) };
        let listed = self.store.read(x.bucket(), |objects| {
            let (mut contents, mut prefixes, mut count, mut truncated) =
                (String::new(), Vec::<String>::new(), 0, false);
            let mut last = None;
            for (key, object) in objects.range((lower, Bound::Unbounded)) {
                if !key.starts_with(prefix) {
                    break;
                }
                // A page resumed after a prefix the delimiter ends passes over the keys rolled up into it.
                if resumed
                    && delimiter.is_some_and(|delimiter| after.ends_with(delimiter))
                    && key.starts_with(after.as_str())
                {
                    continue;
                }
                let rolled = rolled_up(key, prefix, delimiter);
                if rolled.is_some() && prefixes.last() == rolled.as_ref() {
                    continue;
                }
                if count == most {
                    truncated = true;
                    break;
                }
                count += 1;
                match rolled {
                    Some(rolled) => {
                        last = Some(rolled.clone());
                        prefixes.push(rolled);
                    }
                    None => {
                        contents.push_str(&format!(
                            "<Contents>{}{}{}<Size>{}</Size>{}<StorageClass>STANDARD</StorageClass></Contents>",
                            shown.element("Key", key),
                            text_element("LastModified", &iso_millis(object.modified)),
                            text_element("ETag", &object.etag),
                            object.size,
                            if owned { self.owner("Owner") } else { String::new() }
                        ));
                        last = Some(key.clone());
                    }
                }
            }
            (contents, prefixes, count, truncated, last)
        });
        let Some((contents, prefixes, count, truncated, last)) = listed else { return Err(no_such_bucket()) };
        let mut result = format!("{}{}", text_element("Name", x.bucket()), shown.element("Prefix", prefix));
        if v2 {
            if let Some(token) = token {
                result.push_str(&text_element("ContinuationToken", token));
            }
            if let (true, Some(last)) = (truncated, &last) {
                result.push_str(&text_element("NextContinuationToken", &STANDARD.encode(last)));
            }
            if !start_after.is_empty() {
                result.push_str(&shown.element("StartAfter", start_after));
            }
            result.push_str(&format!("<KeyCount>{count}</KeyCount>"));
        } else {
            result.push_str(&shown.element("Marker", marker));
            // S3 says where the next page starts when a delimiter rolls keys up; a client takes the last key otherwise.
            if let (true, Some(_), Some(last)) = (truncated, delimiter, &last) {
                result.push_str(&shown.element("NextMarker", last));
            }
        }
        if let Some(delimiter) = delimiter {
            result.push_str(&shown.element("Delimiter", delimiter));
        }
        result.push_str(&format!(
            "<MaxKeys>{most}</MaxKeys><IsTruncated>{truncated}</IsTruncated>{}{contents}",
            shown.encoding_type()
        ));
        for prefix in &prefixes {
            result.push_str(&format!("<CommonPrefixes>{}</CommonPrefixes>", shown.element("Prefix", prefix)));
        }
        Ok(self.document(document("ListBucketResult", &result)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::Value;

    use super::xml::escape_xml;
    use super::*;
    use crate::s3::element;
    use crate::sigv4::{
        Credentials, Signable, amz_date, authorization, canonical_uri, encoded_query, hmac_hex, scope_of, sha256_hex,
        signing_key, string_to_sign,
    };

    const REGION: &str = "tn-tunis-1";
    const ACCOUNT: &str = "000000000000";
    const HOST: &str = "127.0.0.1:3700";
    /// 2026-10-23T06:00:00Z, when the buckets were made, in milliseconds.
    const AT: Millis = 1_792_735_200_000;
    const MIB: usize = 1024 * 1024;

    fn table() -> Value {
        serde_json::from_str(include_str!("../../../../BE/src/storage/s3-examples.json")).unwrap()
    }

    fn key() -> Key {
        Key { id: "AKFFLOCALKEY0000TEST".into(), secret: "a-secret".into() }
    }

    /// The table's buckets, `photos` and `exports`, their clock at `AT` until a test moves it.
    struct Fixture {
        buckets: Buckets,
        now: Arc<AtomicI64>,
        said: Arc<Mutex<Vec<String>>>,
        _folder: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let folder = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(AT));
        let said = Arc::new(Mutex::new(Vec::new()));
        let (read_now, say_to) = (Arc::clone(&now), Arc::clone(&said));
        let buckets = Buckets::open(
            folder.path(),
            vec!["photos".into(), "exports".into()],
            REGION,
            ACCOUNT,
            Arc::new(move || read_now.load(Ordering::SeqCst)),
            Arc::new(move |line: &str| say_to.lock().unwrap().push(line.to_owned())),
        )
        .unwrap();
        Fixture { buckets, now, said, _folder: folder }
    }

    /// An answer as the client reads it.
    #[derive(Debug)]
    struct Sent {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        /// What the client got before the answer: "100 Continue", when it waited for it.
        continued: Vec<u8>,
    }

    impl Sent {
        fn header(&self, name: &str) -> Option<&str> {
            crate::sigv4::header(&self.headers, name)
        }

        fn text(&self) -> String {
            String::from_utf8(self.body.clone()).unwrap()
        }

        /// The error's code and message, from its document.
        fn refused(&self) -> (u16, String, String) {
            let text = self.text();
            (self.status, element(&text, "Code").unwrap_or_default(), element(&text, "Message").unwrap_or_default())
        }
    }

    /// A request, before it is signed.
    struct Asked<'a> {
        method: &'a str,
        target: &'a str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    fn asked<'a>(method: &'a str, target: &'a str) -> Asked<'a> {
        Asked { method, target, headers: Vec::new(), body: Vec::new() }
    }

    impl Asked<'_> {
        fn with(mut self, name: &str, value: &str) -> Self {
            self.headers.push((name.into(), value.into()));
            self
        }

        fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
            self.body = body.into();
            self
        }

        /// Its head as sent unsigned: its host, and its body's length.
        fn unsigned(&self) -> Request {
            let mut headers = vec![("Host".to_owned(), HOST.to_owned())];
            headers.extend(self.headers.iter().cloned());
            if !self.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-length")) {
                headers.push(("Content-Length".into(), self.body.len().to_string()));
            }
            Request {
                method: self.method.into(),
                target: self.target.into(),
                protocol: "HTTP/1.1".into(),
                headers,
                body: Vec::new(),
            }
        }

        /// Its head as AWS's SDKs sign it, with `key`'s ID and `secret` at `at`: its host, its time, its body's SHA-256
        /// and its own headers signed.
        fn signed_with(&self, key_id: &str, secret: &str, at: Millis) -> Request {
            let amz = amz_date(UNIX_EPOCH + Duration::from_millis(at as u64));
            let payload = crate::sigv4::header(&self.headers, "x-amz-content-sha256")
                .map_or_else(|| sha256_hex(&self.body), str::to_owned);
            let mut headers = vec![
                ("Host".to_owned(), HOST.to_owned()),
                ("X-Amz-Date".to_owned(), amz.clone()),
                ("X-Amz-Content-Sha256".to_owned(), payload.clone()),
            ];
            headers.extend(
                self.headers.iter().filter(|(name, _)| !name.eq_ignore_ascii_case("x-amz-content-sha256")).cloned(),
            );
            let (path, query) = self.target.split_once('?').unwrap_or((self.target, ""));
            let credentials =
                Credentials { access_key_id: key_id.into(), secret_access_key: secret.into(), region: REGION.into() };
            let query = parse_query(query);
            let path = canonical_uri(path);
            let signable = Signable {
                method: self.method,
                path: &path,
                query: &query,
                headers: &headers,
                payload_sha256: &payload,
            };
            headers.push(("Authorization".into(), authorization(&credentials, &signable, &amz, "s3")));
            if !self.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-length")) {
                headers.push(("Content-Length".into(), self.body.len().to_string()));
            }
            Request {
                method: self.method.into(),
                target: self.target.into(),
                protocol: "HTTP/1.1".into(),
                headers,
                body: Vec::new(),
            }
        }

        fn signed(&self, at: Millis) -> Request {
            self.signed_with(&key().id, &key().secret, at)
        }
    }

    impl Fixture {
        fn now(&self) -> Millis {
            self.now.load(Ordering::SeqCst)
        }

        /// The answer to a request, its body sent as `body`.
        fn exchange(&self, head: &Request, body: &[u8]) -> Sent {
            let (mut reader, mut continued) = (body, Vec::new());
            let reply = {
                let mut incoming = Incoming::of(head, &mut reader, &mut continued).unwrap();
                self.buckets.answer(head, &mut incoming, &key(), "the-request", |key_id| {
                    self.said.lock().unwrap().push(format!("signed with {key_id}"))
                })
            };
            let (response, body) = match reply {
                Reply::Whole(response) => {
                    let body = response.body.clone();
                    (response, body)
                }
                Reply::File { response, file, length } => {
                    let mut body = Vec::new();
                    if let Some(file) = file {
                        file.take(length).read_to_end(&mut body).unwrap();
                        assert_eq!(body.len() as u64, length);
                    }
                    (response, body)
                }
            };
            Sent { status: response.status, headers: response.headers, body, continued }
        }

        /// A request signed with the local key, now.
        fn send(&self, asked: Asked) -> Sent {
            self.exchange(&asked.signed(self.now()), &asked.body)
        }

        fn put(&self, target: &str, body: &[u8]) -> Sent {
            let sent = self.send(asked("PUT", target).body(body));
            assert_eq!(sent.status, 200, "{}", sent.text());
            sent
        }

        fn get(&self, target: &str) -> Sent {
            self.send(asked("GET", target))
        }

        fn said(&self) -> Vec<String> {
            self.said.lock().unwrap().clone()
        }
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap_or_default()
    }

    /// A table's request: its target, headers and body, a body of `repeat` `times` over among them.
    fn asked_of(request: &Value) -> Asked<'_> {
        let target = match text(&request["query"]) {
            "" => text(&request["path"]).to_owned(),
            query => format!("{}?{query}", text(&request["path"])),
        };
        let mut asked = asked(text(&request["method"]), Box::leak(target.into_boxed_str()));
        for (name, value) in request["headers"].as_object().into_iter().flatten() {
            asked = asked.with(name, text(value));
        }
        match &request["body"] {
            Value::String(body) => asked.body(body.as_bytes()),
            Value::Object(repeat) => {
                asked.body(text(&repeat["repeat"]).repeat(repeat["times"].as_u64().unwrap() as usize))
            }
            _ => asked,
        }
    }

    /// The table's text, its account and region filled in.
    fn filled(text: &str) -> String {
        text.replace("{account}", ACCOUNT).replace("{region}", REGION)
    }

    /// An answer as the table has it: its status, its headers, and its document.
    fn assert_answers(sent: &Sent, answer: &Value, title: &str) {
        assert_eq!(sent.status, answer["status"].as_u64().unwrap() as u16, "{title}: {}", sent.text());
        for (name, value) in answer["headers"].as_object().into_iter().flatten() {
            assert_eq!(sent.header(name), Some(filled(text(value)).as_str()), "{title}: {name}");
        }
        if let Some(document) = answer["document"].as_str() {
            assert_eq!(sent.text(), filled(document), "{title}");
        }
        assert_eq!(sent.header("x-amz-request-id"), Some("the-request"), "{title}");
    }

    /// A refusal as the table has it: its status, code and message, and the resource asked for.
    fn assert_refuses(sent: &Sent, refused: &Value, title: &str) {
        let expected = (
            refused["status"].as_u64().unwrap() as u16,
            text(&refused["code"]).to_owned(),
            text(&refused["message"]).to_owned(),
        );
        assert_eq!(sent.refused(), expected, "{title}");
        assert_eq!(element(&sent.text(), "Resource").as_deref(), refused["resource"].as_str(), "{title}");
        assert_eq!(element(&sent.text(), "RequestId").as_deref(), Some("the-request"), "{title}");
    }

    #[test]
    fn answers_the_tables_own_answers_and_unset_settings_as_ffs_front_door_does() {
        let fixture = fixture();
        let table = table();
        let front_door = &table["frontDoor"];
        let names: Vec<&str> =
            front_door["buckets"].as_array().unwrap().iter().map(|bucket| text(&bucket["name"])).collect();
        assert_eq!(names, ["photos", "exports"]);
        assert_eq!(iso_millis(AT), text(&front_door["buckets"][0]["createdAt"]));

        let own = front_door["ownAnswers"].as_array().unwrap();
        let unset = &front_door["unsetSettings"];
        let (none, as_new) = (unset["none"].as_array().unwrap(), unset["asNew"].as_array().unwrap());
        assert_eq!((own.len(), none.len(), as_new.len()), (3, 5, 6));
        for case in own.iter().chain(as_new) {
            let title = case["title"].as_str().unwrap_or(text(&case["request"]["query"]));
            assert_answers(&fixture.send(asked_of(&case["request"])), &case["answer"], title);
        }
        for case in none {
            assert_refuses(
                &fixture.send(asked_of(&case["request"])),
                &case["refused"],
                text(&case["request"]["query"]),
            );
        }
    }

    #[test]
    fn refuses_as_the_tables_refusals_say_another_key_said_here() {
        let fixture = fixture();
        let table = table();
        let refusals = table["frontDoor"]["refusals"].as_array().unwrap();
        assert_eq!(refusals.len(), 4);
        for case in refusals {
            let asked = asked_of(&case["request"]);
            let head = match text(&case["signedWith"]) {
                "anotherSecret" => asked.signed_with(&key().id, "another-secret", AT),
                "unknownKey" => asked.signed_with(text(&table["frontDoor"]["unknownKey"]), &key().secret, AT),
                _ => asked.signed(AT),
            };
            assert_refuses(&fixture.exchange(&head, &asked.body), &case["refused"], text(&case["title"]));
        }
        assert_eq!(fixture.said(), ["signed with AKFFZZZZZZZZZZZZZZZZ"]);
    }

    #[test]
    fn puts_with_the_tables_checksums_given_back_or_refused_and_nothing_kept() {
        let fixture = fixture();
        let table = table();
        let checksums = table["frontDoor"]["checksums"].as_array().unwrap();
        assert_eq!(checksums.len(), 2);
        for case in checksums {
            let sent = fixture.send(asked_of(&case["request"]));
            match case.get("answer") {
                Some(answer) => assert_answers(&sent, answer, text(&case["title"])),
                None => assert_refuses(&sent, &case["refused"], text(&case["title"])),
            }
        }
        assert_eq!(fixture.get("/photos/2026/a%20b.txt").text(), "Hello, Tunis");
        assert_eq!(fixture.get("/photos/checked.bin").refused().1, "NoSuchKey", "a body that failed is never kept");
    }

    #[test]
    fn the_buckets_are_the_templates_and_what_ff_keeps_of_one_refused_saying_so() {
        let fixture = fixture();
        let refused = |method: &str, target: &str| fixture.send(asked(method, target)).refused();
        let the_templates = |operation: &str| {
            (
                501,
                "NotImplemented".to_owned(),
                format!(
                    "ff local's buckets are the template's, each made by its AWS::S3::Bucket with its settings and tags: ff local doesn't answer {operation}"
                ),
            )
        };

        assert_eq!(refused("PUT", "/another"), the_templates("CreateBucket"));
        assert_eq!(refused("PUT", "/photos"), the_templates("CreateBucket"));
        assert_eq!(refused("DELETE", "/photos"), the_templates("DeleteBucket"));
        assert_eq!(refused("GET", "/photos?tagging"), the_templates("GetBucketTagging"));
        assert_eq!(refused("PUT", "/photos?website"), the_templates("PutBucketWebsite"));
        assert_eq!(refused("DELETE", "/photos?policy"), the_templates("DeleteBucketPolicy"));
        assert_eq!(refused("GET", "/nowhere?tagging").1, "NoSuchBucket", "a bucket that isn't the template's first");
        assert_eq!(refused("GET", "/photos/a.jpg?tagging").1, "NotImplemented");
    }

    #[test]
    fn an_object_is_read_whole_by_a_range_or_its_conditions_with_the_headers_it_was_written_with() {
        let fixture = fixture();
        let put = fixture.send(
            asked("PUT", "/photos/notes/a%20b.txt")
                .with("Content-Type", "text/plain")
                .with("x-amz-meta-Author", "rami")
                .with("Content-Encoding", "gzip,aws-chunked")
                .with("Cache-Control", "no-cache")
                .body("0123456789abcdef"),
        );
        let etag = format!("\"{}\"", crate::md5::hex(b"0123456789abcdef"));
        assert_eq!((put.status, put.header("etag")), (200, Some(etag.as_str())));
        assert_eq!(put.header("x-amz-checksum-type"), None, "no checksum was sent");

        let whole = fixture.get("/photos/notes/a%20b.txt");
        assert_eq!((whole.status, whole.text().as_str()), (200, "0123456789abcdef"));
        let headers = [
            "content-type",
            "x-amz-meta-author",
            "content-encoding",
            "cache-control",
            "etag",
            "last-modified",
            "accept-ranges",
        ];
        let answered: Vec<Option<&str>> = headers.iter().map(|name| whole.header(name)).collect();
        assert_eq!(
            answered,
            [
                Some("text/plain"),
                Some("rami"),
                Some("gzip"),
                Some("no-cache"),
                Some(etag.as_str()),
                Some("Fri, 23 Oct 2026 06:00:00 GMT"),
                Some("bytes")
            ]
        );
        assert_eq!(whole.header("x-amz-checksum-crc32"), None);

        let ranged = |range: &str| {
            let sent = fixture.send(asked("GET", "/photos/notes/a%20b.txt").with("Range", range));
            (sent.status, sent.header("content-range").map(str::to_owned), sent.text())
        };
        assert_eq!(ranged("bytes=0-9"), (206, Some("bytes 0-9/16".into()), "0123456789".into()));
        assert_eq!(ranged("bytes=10-"), (206, Some("bytes 10-15/16".into()), "abcdef".into()));
        assert_eq!(ranged("bytes=-3"), (206, Some("bytes 13-15/16".into()), "def".into()));
        assert_eq!(ranged("bytes=12-100"), (206, Some("bytes 12-15/16".into()), "cdef".into()));
        assert_eq!(ranged("bytes=5-2"), (200, None, "0123456789abcdef".into()), "a range S3 doesn't read");
        assert_eq!(ranged("bytes=16-").0, 416);

        let head = fixture.send(asked("HEAD", "/photos/notes/a%20b.txt"));
        assert_eq!((head.status, head.body.len(), head.header("etag")), (200, 0, Some(etag.as_str())));
        let overridden = fixture
            .get("/photos/notes/a%20b.txt?response-content-type=image%2Fpng&response-content-disposition=attachment");
        assert_eq!(
            (overridden.header("content-type"), overridden.header("content-disposition")),
            (Some("image/png"), Some("attachment"))
        );

        let conditional =
            |name: &str, value: &str| fixture.send(asked("GET", "/photos/notes/a%20b.txt").with(name, value)).status;
        assert_eq!(conditional("If-None-Match", &etag), 304);
        assert_eq!(conditional("If-None-Match", "\"other\""), 200);
        assert_eq!(conditional("If-Match", "\"other\""), 412);
        assert_eq!(conditional("If-Match", &etag), 200);
        assert_eq!(conditional("If-Modified-Since", "Fri, 23 Oct 2026 06:00:00 GMT"), 304);
        assert_eq!(conditional("If-Modified-Since", "Thu, 22 Oct 2026 06:00:00 GMT"), 200);
        assert_eq!(conditional("If-Unmodified-Since", "Thu, 22 Oct 2026 06:00:00 GMT"), 412);

        let untyped = fixture.put("/photos/untyped", b"?");
        assert_eq!(untyped.status, 200);
        assert_eq!(fixture.get("/photos/untyped").header("content-type"), Some(DEFAULT_TYPE));
        let missing = fixture.send(asked("HEAD", "/photos/missing"));
        assert_eq!((missing.status, missing.body.len()), (404, 0));
        assert_eq!(fixture.get("/photos/missing").refused().1, "NoSuchKey");
    }

    #[test]
    fn an_upload_is_checked_as_it_streams_and_kept_only_once_it_passed() {
        let fixture = fixture();
        let wrong_sha = fixture
            .send(asked("PUT", "/photos/a.txt").with("x-amz-content-sha256", &sha256_hex(b"other")).body("data"));
        assert_eq!(wrong_sha.refused().1, "XAmzContentSHA256Mismatch");
        let malformed_sha =
            fixture.send(asked("PUT", "/photos/a.txt").with("x-amz-content-sha256", "nope").body("data"));
        assert_eq!(malformed_sha.refused().1, "InvalidRequest");
        let md5 = |data: &[u8]| STANDARD.encode(crate::md5::digest(data));
        let wrong_md5 = fixture.send(asked("PUT", "/photos/a.txt").with("Content-MD5", &md5(b"other")).body("data"));
        assert_eq!(
            wrong_md5.refused(),
            (400, "BadDigest".into(), "The Content-MD5 you specified did not match what we received.".into())
        );
        assert_eq!(
            fixture.send(asked("PUT", "/photos/a.txt").with("Content-MD5", &md5(b"data")).body("data")).status,
            200
        );
        let short = asked("PUT", "/photos/short.txt").with("Content-Length", "10").body("data");
        assert_eq!(fixture.exchange(&short.signed(AT), b"data").refused().1, "IncompleteBody");
        let unlengthed = asked("PUT", "/photos/b.txt").with("Transfer-Encoding", "chunked");
        let mut head = unlengthed.signed(AT);
        head.headers.retain(|(name, _)| name != "Content-Length");
        assert_eq!(fixture.exchange(&head, b"0\r\n\r\n").refused().0, 411);
        let too_large = asked("PUT", "/photos/huge.bin").with("Content-Length", "5368709121");
        assert_eq!(fixture.exchange(&too_large.signed(AT), b"").refused().1, "EntityTooLarge");

        // An aws-chunked body, its checksum in its trailer, as AWS's SDKs send one unsigned.
        let chunked = asked("PUT", "/photos/chunked.txt")
            .with("x-amz-content-sha256", STREAMING_UNSIGNED_TRAILER)
            .with("Content-Encoding", "aws-chunked")
            .with("x-amz-decoded-content-length", "12")
            .with("x-amz-trailer", "x-amz-checksum-crc32")
            .body("c\r\nHello, Tunis\r\n0\r\nx-amz-checksum-crc32:tcdgew==\r\n\r\n");
        let sent = fixture.send(chunked);
        assert_eq!((sent.status, sent.header("x-amz-checksum-crc32")), (200, Some("tcdgew==")), "{}", sent.text());
        let read = fixture.get("/photos/chunked.txt");
        assert_eq!((read.text().as_str(), read.header("content-encoding")), ("Hello, Tunis", None));

        // Refused before its body: the client waiting for "100 Continue" never sends it.
        let waiting =
            asked("PUT", "/photos/a.txt").with("Expect", "100-continue").with("Content-MD5", "not-base64").body("data");
        let refused = fixture.send(waiting);
        assert_eq!((refused.refused().1.as_str(), refused.continued.as_slice()), ("InvalidDigest", &b""[..]));
        let let_in = fixture.send(asked("PUT", "/photos/a.txt").with("Expect", "100-continue").body("data"));
        assert_eq!((let_in.status, let_in.continued.as_slice()), (200, &b"HTTP/1.1 100 Continue\r\n\r\n"[..]));
    }

    #[test]
    fn a_request_unsigned_is_taken_a_presigned_url_until_it_expires() {
        let fixture = fixture();
        let unsigned = asked("PUT", "/photos/open.txt").body("for curl");
        assert_eq!(fixture.exchange(&unsigned.unsigned(), &unsigned.body).status, 200);
        assert_eq!(fixture.exchange(&asked("GET", "/photos/open.txt").unsigned(), b"").text(), "for curl");

        let presigned = |method: &str, path: &str, expires: u64| {
            let amz = amz_date(UNIX_EPOCH + Duration::from_millis(AT as u64));
            let scope = scope_of(&amz[..8], REGION, "s3");
            let query = [
                ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_owned()),
                ("X-Amz-Credential", format!("{}/{scope}", key().id)),
                ("X-Amz-Date", amz.clone()),
                ("X-Amz-Expires", expires.to_string()),
                ("X-Amz-SignedHeaders", "host".to_owned()),
            ];
            let query = encoded_query(&query.map(|(name, value)| (name.to_owned(), value)));
            let canonical =
                format!("{method}\n{}\n{query}\nhost:{HOST}\n\nhost\nUNSIGNED-PAYLOAD", canonical_uri(path));
            let signature = hmac_hex(
                &signing_key(&key().secret, &amz[..8], REGION, "s3"),
                &string_to_sign(&amz, &scope, &canonical),
            );
            format!("{path}?{query}&X-Amz-Signature={signature}")
        };
        let get = presigned("GET", "/photos/open.txt", 60);
        let put = presigned("PUT", "/photos/up.txt", 60);
        let read = |target: &str| fixture.exchange(&asked("GET", target).unsigned(), b"");

        assert_eq!(read(&get).text(), "for curl");
        let upload = asked("PUT", &put).body("presigned");
        assert_eq!(
            fixture.exchange(&upload.unsigned(), &upload.body).status,
            200,
            "a body a presigned URL doesn't sign"
        );
        assert_eq!(fixture.get("/photos/up.txt").text(), "presigned");
        fixture.now.store(AT + 61_000, Ordering::SeqCst);
        assert_eq!(read(&get).refused(), (403, "AccessDenied".into(), "Request has expired".into()));
        assert_eq!(read(&get.replace("/open.txt", "/up.txt")).refused().1, "AccessDenied", "the clock first");
        fixture.now.store(AT, Ordering::SeqCst);
        assert_eq!(read(&get.replace("/open.txt", "/up.txt")).refused().1, "SignatureDoesNotMatch");
    }

    #[test]
    fn a_copy_takes_its_sources_bytes_and_headers_unless_it_replaces_them() {
        let fixture = fixture();
        fixture.send(
            asked("PUT", "/photos/a.txt")
                .with("Content-Type", "text/plain")
                .with("x-amz-meta-from", "a")
                .body("source"),
        );
        let copy = |target: &str, source: &str, extra: &[(&str, &str)]| {
            let mut copied = asked("PUT", target).with("x-amz-copy-source", source);
            for (name, value) in extra {
                copied = copied.with(name, value);
            }
            fixture.send(copied)
        };

        let copied = copy("/exports/b.txt", "photos/a.txt", &[]);
        assert_eq!(copied.status, 200, "{}", copied.text());
        let etag = format!("\"{}\"", crate::md5::hex(b"source"));
        assert_eq!(element(&copied.text(), "ETag").as_deref(), Some(etag.as_str()));
        let read = fixture.get("/exports/b.txt");
        assert_eq!(
            (read.text().as_str(), read.header("content-type"), read.header("x-amz-meta-from")),
            ("source", Some("text/plain"), Some("a"))
        );
        let replaced = copy(
            "/photos/a.txt",
            "/photos/a%2Etxt",
            &[("x-amz-metadata-directive", "REPLACE"), ("x-amz-meta-to", "b")],
        );
        assert_eq!(replaced.status, 200, "{}", replaced.text());
        let read = fixture.get("/photos/a.txt");
        assert_eq!(
            (read.header("content-type"), read.header("x-amz-meta-from"), read.header("x-amz-meta-to")),
            (Some(DEFAULT_TYPE), None, Some("b"))
        );

        assert_eq!(copy("/photos/a.txt", "photos/a.txt", &[]).refused().1, "InvalidRequest", "to itself, unchanged");
        assert_eq!(copy("/photos/c.txt", "photos/missing", &[]).refused().1, "NoSuchKey");
        assert_eq!(copy("/photos/c.txt", "nowhere/a.txt", &[]).refused().1, "NoSuchBucket");
        assert_eq!(
            copy("/photos/c.txt", "photos/", &[]).refused(),
            (400, "InvalidRequest".into(), "The x-amz-copy-source header is not <bucket>/<key>".into())
        );
        assert_eq!(copy("/photos/c.txt", "photos/a.txt?versionId=1", &[]).refused().1, "NotImplemented");
        assert_eq!(copy("/photos/c.txt", "photos/a.txt", &[("x-amz-copy-source-if-match", "\"other\"")]).status, 412);
        assert_eq!(
            copy("/photos/c.txt", "photos/a.txt", &[("x-amz-metadata-directive", "MERGE")]).refused().1,
            "InvalidArgument"
        );
    }

    #[test]
    fn deletes_one_by_one_or_in_a_batch_as_s3_deletes_a_key_that_isnt_there_too() {
        let fixture = fixture();
        for key in ["a", "b", "c"] {
            fixture.put(&format!("/photos/{key}"), b"x");
        }

        assert_eq!(fixture.send(asked("DELETE", "/photos/a")).status, 204);
        assert_eq!(fixture.send(asked("DELETE", "/photos/a")).status, 204);
        let batch = "<Delete><Object><Key>b</Key></Object><Object><Key>missing &amp; gone</Key></Object><Object><Key>c</Key><VersionId>3</VersionId></Object></Delete>";
        let sent = fixture.send(asked("POST", "/photos?delete").body(batch));
        assert_eq!(sent.status, 200, "{}", sent.text());
        assert_eq!(
            sent.text(),
            document(
                "DeleteResult",
                "<Deleted><Key>b</Key></Deleted><Deleted><Key>missing &#38; gone</Key></Deleted><Error><Key>c</Key><Code>NoSuchVersion</Code><Message>The specified version does not exist.</Message></Error>"
            )
        );
        let quiet = fixture.send(
            asked("POST", "/photos?delete").body("<Delete><Quiet>true</Quiet><Object><Key>c</Key></Object></Delete>"),
        );
        assert_eq!(quiet.text(), document("DeleteResult", ""));
        assert_eq!(fixture.get("/photos?list-type=2").text().matches("<Contents>").count(), 0);
        assert_eq!(fixture.send(asked("POST", "/photos?delete").body("<Delete></Delete>")).refused().1, "MalformedXML");
        let too_big =
            format!("<Delete>{}</Delete>", "<Object><Key>k</Key></Object>".repeat(MAX_DOCUMENT_BYTES / 29 + 1));
        assert_eq!(fixture.send(asked("POST", "/photos?delete").body(too_big)).refused().1, "MaxMessageLengthExceeded");
    }

    /// The keys and prefixes a listing's page shows, and where the next starts.
    fn page(sent: &Sent) -> (Vec<String>, Vec<String>, bool, Option<String>) {
        let text = sent.text();
        let keys = children(&text, "Contents").iter().map(|contents| element(contents, "Key").unwrap()).collect();
        let prefixes =
            children(&text, "CommonPrefixes").iter().map(|prefix| element(prefix, "Prefix").unwrap()).collect();
        let next = element(&text, "NextContinuationToken").or_else(|| element(&text, "NextMarker"));
        (keys, prefixes, element(&text, "IsTruncated").as_deref() == Some("true"), next)
    }

    #[test]
    fn lists_both_ways_rolled_up_by_a_delimiter_page_by_page() {
        let fixture = fixture();
        for key in ["a.txt", "docs/1.txt", "docs/2.txt", "docs/deep/3.txt", "e f.txt", "zoo/1"] {
            fixture.put(&format!("/photos/{}", uri_encode(key, true)), b"x");
        }
        let strings = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();

        let all = fixture.get("/photos?list-type=2");
        assert_eq!(
            page(&all).0,
            strings(&["a.txt", "docs/1.txt", "docs/2.txt", "docs/deep/3.txt", "e f.txt", "zoo/1"])
        );
        assert!(all.text().contains("<KeyCount>6</KeyCount>") && !all.text().contains("<Owner>"));
        let rolled = fixture.get("/photos?list-type=2&delimiter=%2F");
        assert_eq!(page(&rolled), (strings(&["a.txt", "e f.txt"]), strings(&["docs/", "zoo/"]), false, None));
        let under = fixture.get("/photos?list-type=2&delimiter=%2F&prefix=docs%2F");
        assert_eq!(page(&under), (strings(&["docs/1.txt", "docs/2.txt"]), strings(&["docs/deep/"]), false, None));

        let (mut seen, mut token) = (Vec::new(), None::<String>);
        loop {
            let target = match &token {
                Some(token) => format!(
                    "/photos?list-type=2&delimiter=%2F&max-keys=1&continuation-token={}",
                    uri_encode(token, false)
                ),
                None => "/photos?list-type=2&delimiter=%2F&max-keys=1".to_owned(),
            };
            let (keys, prefixes, truncated, next) = page(&fixture.get(&target));
            seen.extend(keys.into_iter().chain(prefixes));
            if !truncated {
                break;
            }
            token = next;
        }
        assert_eq!(
            seen,
            strings(&["a.txt", "docs/", "e f.txt", "zoo/"]),
            "a page resumed after a prefix passes over its keys"
        );

        let v1 = fixture.get("/photos?delimiter=%2F&max-keys=2");
        assert_eq!(page(&v1), (strings(&["a.txt"]), strings(&["docs/"]), true, Some("docs/".into())));
        assert!(v1.text().contains("<Owner><ID>000000000000</ID>"));
        let next = fixture.get("/photos?delimiter=%2F&max-keys=2&marker=docs%2F");
        assert_eq!(page(&next), (strings(&["e f.txt"]), strings(&["zoo/"]), false, None));
        let encoded = fixture.get("/photos?list-type=2&prefix=e&encoding-type=url&fetch-owner=true");
        assert_eq!(page(&encoded).0, strings(&["e%20f.txt"]));
        assert!(encoded.text().contains("<EncodingType>url</EncodingType>") && encoded.text().contains("<Owner>"));
        assert_eq!(
            fixture.get("/photos?list-type=2&start-after=docs%2Fdeep%2F3.txt").text().matches("<Key>").count(),
            2
        );
        assert_eq!(fixture.get("/photos?list-type=2&max-keys=many").refused().1, "InvalidArgument");
        assert_eq!(fixture.get("/photos?list-type=2&encoding-type=base64").refused().1, "InvalidArgument");
        assert_eq!(fixture.get("/photos?list-type=2&continuation-token=%25").refused().1, "InvalidArgument");
    }

    #[test]
    fn a_multipart_upload_makes_one_object_of_its_parts_in_order() {
        let fixture = fixture();
        let created = fixture.send(asked("POST", "/photos/big.bin?uploads").with("Content-Type", "application/zip"));
        let id = element(&created.text(), "UploadId").unwrap();
        let first = vec![b'a'; 5 * MIB];
        let part = |number: u32, body: &[u8]| {
            fixture.send(asked("PUT", &format!("/photos/big.bin?partNumber={number}&uploadId={id}")).body(body))
        };
        let tags: Vec<String> = [(1, &first[..]), (2, b"tail")]
            .iter()
            .map(|(number, body)| part(*number, body).header("etag").unwrap().to_owned())
            .collect();
        assert_eq!(tags[1], format!("\"{}\"", crate::md5::hex(b"tail")));
        assert_eq!(
            part(0, b"x").refused(),
            (400, "InvalidArgument".into(), "Part number must be an integer between 1 and 10000, inclusive".into())
        );
        assert_eq!(
            fixture.send(asked("PUT", "/photos/big.bin?partNumber=1&uploadId=other").body("x")).refused().1,
            "NoSuchUpload"
        );

        let parts = fixture.get(&format!("/photos/big.bin?uploadId={id}"));
        assert_eq!(
            children(&parts.text(), "Part").iter().map(|part| element(part, "Size").unwrap()).collect::<Vec<_>>(),
            [(5 * MIB).to_string(), "4".into()]
        );
        let uploads = fixture.get("/photos?uploads");
        assert_eq!(element(&uploads.text(), "UploadId"), Some(id.clone()));

        let complete = |parts: &[(u32, &str)]| {
            let listed: String = parts
                .iter()
                .map(|(number, etag)| {
                    format!("<Part><PartNumber>{number}</PartNumber><ETag>{}</ETag></Part>", escape_xml(etag))
                })
                .collect();
            fixture.send(
                asked("POST", &format!("/photos/big.bin?uploadId={id}"))
                    .body(format!("<CompleteMultipartUpload>{listed}</CompleteMultipartUpload>")),
            )
        };
        assert_eq!(complete(&[(2, &tags[1]), (1, &tags[0])]).refused().1, "InvalidPartOrder");
        assert_eq!(complete(&[(1, &tags[1])]).refused().1, "InvalidPart");
        assert_eq!(complete(&[(2, &tags[1]), (3, &tags[1])]).refused().1, "InvalidPart");
        part(3, b"more");
        assert_eq!(
            complete(&[(2, &tags[1]), (3, "more")]).refused().1,
            "InvalidPart",
            "an ETag in quotes or not, but the part's"
        );
        assert_eq!(
            complete(&[(2, &tags[1]), (3, &format!("\"{}\"", crate::md5::hex(b"more")))]).refused().1,
            "EntityTooSmall"
        );

        let completed = complete(&[(1, &tags[0]), (2, &tags[1])]);
        assert_eq!(completed.status, 200, "{}", completed.text());
        let mut md5s = Md5::default();
        md5s.update(&crate::md5::digest(&first));
        md5s.update(&crate::md5::digest(b"tail"));
        let etag = format!("\"{}-2\"", hex_of(&md5s.finish()));
        assert_eq!(element(&completed.text(), "ETag"), Some(etag.clone()));
        assert_eq!(element(&completed.text(), "Location").as_deref(), Some("http://127.0.0.1:3700/photos/big.bin"));

        let whole = fixture.get("/photos/big.bin");
        assert_eq!(
            (whole.body.len(), whole.header("etag"), whole.header("content-type")),
            (5 * MIB + 4, Some(etag.as_str()), Some("application/zip"))
        );
        let second = fixture.get("/photos/big.bin?partNumber=2");
        assert_eq!(
            (second.status, second.text().as_str(), second.header("x-amz-mp-parts-count")),
            (206, "tail", Some("2"))
        );
        assert_eq!(fixture.get("/photos/big.bin?partNumber=3").refused().1, "InvalidPartNumber");
        assert_eq!(fixture.get(&format!("/photos/big.bin?uploadId={id}")).refused().1, "NoSuchUpload", "it ended");
        assert!(!fixture.get("/photos?uploads").text().contains("<Upload>"));

        let aborted = element(&fixture.send(asked("POST", "/photos/gone.bin?uploads")).text(), "UploadId").unwrap();
        assert_eq!(fixture.send(asked("DELETE", &format!("/photos/gone.bin?uploadId={aborted}"))).status, 204);
        assert_eq!(
            fixture.send(asked("DELETE", &format!("/photos/gone.bin?uploadId={aborted}"))).refused().1,
            "NoSuchUpload"
        );
    }

    #[test]
    fn a_part_is_copied_from_an_object_whole_or_a_range_of_it() {
        let fixture = fixture();
        fixture.put("/photos/source.bin", &vec![b's'; 5 * MIB + 10]);
        let id = element(&fixture.send(asked("POST", "/exports/copy.bin?uploads")).text(), "UploadId").unwrap();
        let copy_part = |number: u32, range: Option<&str>| {
            let target = format!("/exports/copy.bin?partNumber={number}&uploadId={id}");
            let mut copied = asked("PUT", &target).with("x-amz-copy-source", "photos/source.bin");
            if let Some(range) = range {
                copied = copied.with("x-amz-copy-source-range", range);
            }
            fixture.send(copied)
        };

        let whole = copy_part(1, None);
        let range = copy_part(2, Some("bytes=0-9"));
        assert_eq!(copy_part(3, Some("bytes=0-")).refused().1, "InvalidArgument");
        assert_eq!(copy_part(3, Some(&format!("bytes=0-{}", 5 * MIB + 10))).refused().1, "InvalidRange");

        let tags: Vec<String> = [&whole, &range].iter().map(|sent| element(&sent.text(), "ETag").unwrap()).collect();
        assert_eq!(tags[1], format!("\"{}\"", crate::md5::hex(b"ssssssssss")));
        let listed: String = tags
            .iter()
            .enumerate()
            .map(|(at, etag)| format!("<Part><PartNumber>{}</PartNumber><ETag>{etag}</ETag></Part>", at + 1))
            .collect();
        let completed = fixture.send(
            asked("POST", &format!("/exports/copy.bin?uploadId={id}"))
                .body(format!("<CompleteMultipartUpload>{listed}</CompleteMultipartUpload>")),
        );
        assert_eq!(completed.status, 200, "{}", completed.text());
        assert_eq!(fixture.get("/exports/copy.bin").body.len(), 5 * MIB + 20);
    }

    #[test]
    fn what_goes_wrong_on_this_machine_is_said_and_answered_as_an_internal_error() {
        let fixture = fixture();
        std::fs::remove_dir_all(fixture._folder.path().join("photos")).unwrap();

        let sent = fixture.send(asked("PUT", "/photos/a.txt").body("x"));

        assert_eq!(
            sent.refused(),
            (500, "InternalError".into(), "We encountered an internal error. Please try again.".into())
        );
        let said = fixture.said();
        assert!(said.len() == 1 && said[0].starts_with("ff local couldn't write photos/a.txt: "), "{said:?}");
    }

    #[test]
    fn reads_a_range_as_s3_does() {
        let ranges = [
            ("bytes=0-9", Ranged::Bytes(0, 9)),
            ("bytes=5-", Ranged::Bytes(5, 99)),
            ("bytes=-10", Ranged::Bytes(90, 99)),
            ("bytes=90-200", Ranged::Bytes(90, 99)),
            ("bytes=100-", Ranged::Unsatisfiable),
            ("bytes=-0", Ranged::Unsatisfiable),
            ("bytes=5-2", Ranged::Whole),
            ("bytes=0-1,5-6", Ranged::Whole),
            ("items=0-1", Ranged::Whole),
            ("bytes=a-b", Ranged::Whole),
        ];
        for (range, expected) in ranges {
            assert_eq!(byte_range(Some(range), 100), expected, "{range}");
        }
        assert_eq!(byte_range(Some("bytes=0-"), 0), Ranged::Unsatisfiable);
        assert_eq!(byte_range(None, 100), Ranged::Whole);
    }
}
