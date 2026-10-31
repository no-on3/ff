//! A bucket as AWS's tools reach it: S3's REST API at FF's S3 endpoint, path-style, each request
//! signed with Signature Version 4, for `ff sites deploy`: the bucket's objects listed, files put
//! and deleted. FF's S3 front door checks the signature, the key's reach and the account, as it
//! does for any client.

use std::time::{Duration, SystemTime};

use ring::{digest, hmac};
use ureq::Agent;
use ureq::tls::{RootCerts, TlsConfig};

use crate::error::{Error, Kind};

/// The SHA-256 of nothing: a request without a body signs it.
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// An access key, and the region it signs for.
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
}

/// An object as ListObjectsV2 lists it: its key, its ETag without its quotes, its size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub key: String,
    pub etag: String,
    pub size: u64,
}

/// `text` as Signature Version 4 encodes it: RFC 3986's unreserved characters as they are, every
/// other byte as %XX; a slash too, unless it separates a path's segments.
pub fn uri_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, data).as_ref())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data).as_ref().to_vec()
}

/// The query as the canonical request has it, and as the URL sends it: each name and value
/// encoded, sorted by name, then value.
pub fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> =
        query.iter().map(|(name, value)| (uri_encode(name, false), uri_encode(value, false))).collect();
    pairs.sort();
    pairs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&")
}

/// A request as Signature Version 4 signs it: its method, its path already encoded, its query as
/// given, the headers to sign, and its payload's SHA-256.
pub struct Signable<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, String)],
    pub payload_sha256: &'a str,
}

/// The time as x-amz-date says it: 20130524T000000Z.
pub fn amz_date(at: SystemTime) -> String {
    humantime::format_rfc3339_seconds(at).to_string().chars().filter(|c| *c != '-' && *c != ':').collect()
}

/// The Authorization header for the request, signed at `amz_date`, which its x-amz-date header
/// must say, for S3 in the key's region.
pub fn authorization(credentials: &Credentials, request: &Signable, amz_date: &str) -> String {
    let mut headers: Vec<(String, String)> =
        request.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned())).collect();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();
    let signed_headers = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        request.method,
        request.path,
        canonical_query(request.query),
        request.payload_sha256
    );
    let date = &amz_date[..8];
    let scope = format!("{date}/{}/s3/aws4_request", credentials.region);
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let mut key = hmac_sha256(format!("AWS4{}", credentials.secret_access_key).as_bytes(), date.as_bytes());
    for part in [credentials.region.as_str(), "s3", "aws4_request"] {
        key = hmac_sha256(&key, part.as_bytes());
    }
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={}",
        credentials.access_key_id,
        hex(&hmac_sha256(&key, string_to_sign.as_bytes()))
    )
}

/// The text of the first `<name>` element in `xml`, its entities decoded.
fn element(xml: &str, name: &str) -> Option<String> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    Some(unescape(&xml[start..end]))
}

/// XML's five entities and its character references, decoded; anything else kept as it is.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else { break };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .map(|code| u32::from_str_radix(code, 16))
                .or_else(|| entity.strip_prefix('#').map(str::parse))
                .and_then(Result::ok)
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The objects of a ListObjectsV2 page.
fn objects_of(page: &str) -> Vec<Object> {
    page.split("<Contents>")
        .skip(1)
        .filter_map(|part| {
            let part = &part[..part.find("</Contents>")?];
            Some(Object {
                key: element(part, "Key")?,
                etag: element(part, "ETag").unwrap_or_default().trim_matches('"').to_owned(),
                size: element(part, "Size")?.parse().ok()?,
            })
        })
        .collect()
}

/// One bucket at an S3 endpoint, reached with a key.
pub struct BucketClient {
    agent: Agent,
    /// scheme://host[:port], without a final slash.
    endpoint: String,
    /// What the Host header says, which the signature covers: the endpoint's host[:port].
    host: String,
    /// Where the requests go: the endpoint, or 127.0.0.1 for a host under .localhost, which not every system
    /// resolves, as `ff invoke --http` reaches a function's URL there; the Host header the endpoint's all the same.
    connect: String,
    bucket: String,
    credentials: Credentials,
}

impl BucketClient {
    pub fn new(endpoint: &str, bucket: &str, credentials: Credentials) -> Result<BucketClient, Error> {
        let endpoint = endpoint.trim_end_matches('/').to_owned();
        let host = endpoint
            .split_once("://")
            .map(|(_, host)| host)
            .filter(|host| !host.is_empty() && !host.contains('/'))
            .ok_or_else(|| Error::new(Kind::Failed, format!("\"{endpoint}\" is no S3 endpoint ff can reach")))?
            .to_owned();
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(5)))
            // A large file, slowly sent, may take a while; a request that hangs doesn't.
            .timeout_global(Some(Duration::from_secs(600)))
            .user_agent(format!("ff-cli/{}", env!("CARGO_PKG_VERSION")))
            .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
            .build()
            .into();
        let connect = match host.rsplit_once(':') {
            Some((name, port)) if name.ends_with(".localhost") => {
                endpoint.replacen(&host, &format!("127.0.0.1:{port}"), 1)
            }
            None if host.ends_with(".localhost") => endpoint.replacen(&host, "127.0.0.1", 1),
            _ => endpoint.clone(),
        };
        Ok(BucketClient { agent, endpoint, host, connect, bucket: bucket.to_owned(), credentials })
    }

    /// Every object of the bucket, page by page, as ListObjectsV2 gives them.
    pub fn list(&self) -> Result<Vec<Object>, Error> {
        let mut objects = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![("list-type".to_owned(), "2".to_owned()), ("max-keys".to_owned(), "1000".to_owned())];
            if let Some(token) = &token {
                query.push(("continuation-token".to_owned(), token.clone()));
            }
            let page = self.send("GET", "", &query, &[], &[])?;
            objects.extend(objects_of(&page));
            match (element(&page, "IsTruncated").as_deref(), element(&page, "NextContinuationToken")) {
                (Some("true"), Some(next)) => token = Some(next),
                _ => return Ok(objects),
            }
        }
    }

    /// Puts a file, of its type, with how long browsers may keep it.
    pub fn put(&self, key: &str, body: &[u8], content_type: &str, cache_control: &str) -> Result<(), Error> {
        self.send("PUT", key, &[], &[("content-type", content_type), ("cache-control", cache_control)], body)
            .map(|_| ())
    }

    pub fn delete(&self, key: &str) -> Result<(), Error> {
        self.send("DELETE", key, &[], &[], &[]).map(|_| ())
    }

    /// One request, signed; the answer's body, or S3's refusal as an error.
    fn send(
        &self,
        method: &str,
        key: &str,
        query: &[(String, String)],
        extra: &[(&str, &str)],
        body: &[u8],
    ) -> Result<String, Error> {
        let bucket = uri_encode(&self.bucket, false);
        let path = if key.is_empty() { format!("/{bucket}") } else { format!("/{bucket}/{}", uri_encode(key, true)) };
        let payload = if body.is_empty() { EMPTY_SHA256.to_owned() } else { sha256_hex(body) };
        let date = amz_date(SystemTime::now());
        let mut headers = vec![
            ("host".to_owned(), self.host.clone()),
            ("x-amz-content-sha256".to_owned(), payload.clone()),
            ("x-amz-date".to_owned(), date.clone()),
        ];
        headers.extend(extra.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())));
        let signed = Signable { method, path: &path, query, headers: &headers, payload_sha256: &payload };
        let authorization = authorization(&self.credentials, &signed, &date);
        let query = canonical_query(query);
        let url = if query.is_empty() {
            format!("{}{path}", self.connect)
        } else {
            format!("{}{path}?{query}", self.connect)
        };
        // ureq sends the Host header itself, from the URL: the one signed, unless the URL names 127.0.0.1 instead.
        let local = self.connect != self.endpoint;
        let sent = headers.iter().filter(|(name, _)| local || name != "host");
        let answer = match method {
            "GET" => sent
                .fold(self.agent.get(&url), |r, (n, v)| r.header(n, v))
                .header("authorization", &authorization)
                .call(),
            "DELETE" => sent
                .fold(self.agent.delete(&url), |r, (n, v)| r.header(n, v))
                .header("authorization", &authorization)
                .call(),
            _ => sent
                .fold(self.agent.put(&url), |r, (n, v)| r.header(n, v))
                .header("authorization", &authorization)
                .send(body),
        };
        let what = if key.is_empty() { format!("the listing of {}", self.bucket) } else { key.to_owned() };
        let mut answer = answer.map_err(|error| {
            Error::new(Kind::Failed, format!("could not reach the S3 endpoint {}: {error}", self.endpoint))
        })?;
        let status = answer.status().as_u16();
        let text = answer.body_mut().read_to_string().unwrap_or_default();
        if status < 300 {
            return Ok(text);
        }
        let code = element(&text, "Code").unwrap_or_else(|| format!("HTTP {status}"));
        let message = element(&text, "Message").unwrap_or_default();
        let kind = if matches!(code.as_str(), "AccessDenied" | "AccountProblem" | "QuotaExceeded") {
            Kind::RefusedByAccount
        } else {
            Kind::Failed
        };
        let mut error = Error::new(kind, format!("S3 refused {method} {what}: {code}: {message}"));
        error.status = Some(status);
        error.request_id = answer.headers().get("x-amz-request-id").and_then(|id| id.to_str().ok()).map(str::to_owned);
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The key of AWS's examples of Signature Version 4 for S3.
    fn example() -> Credentials {
        Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            region: "us-east-1".into(),
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect()
    }

    fn signature(header: &str) -> &str {
        header.rsplit("Signature=").next().unwrap()
    }

    #[test]
    fn signs_aws_s_example_get_object_with_a_range() {
        let headers = headers(&[
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("Range", "bytes=0-9"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let request =
            Signable { method: "GET", path: "/test.txt", query: &[], headers: &headers, payload_sha256: EMPTY_SHA256 };
        let header = authorization(&example(), &request, "20130524T000000Z");

        assert_eq!(
            header.split(", Signature=").next().unwrap(),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"
        );
        assert_eq!(signature(&header), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn signs_aws_s_example_put_object_whose_key_needs_encoding() {
        let payload = sha256_hex(b"Welcome to Amazon S3.");
        assert_eq!(payload, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
        let headers = headers(&[
            ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-content-sha256", &payload),
            ("x-amz-date", "20130524T000000Z"),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
        ]);
        let path = format!("/{}", uri_encode("test$file.text", true));
        let request = Signable { method: "PUT", path: &path, query: &[], headers: &headers, payload_sha256: &payload };

        assert_eq!(path, "/test%24file.text");
        assert_eq!(
            signature(&authorization(&example(), &request, "20130524T000000Z")),
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn signs_aws_s_example_list_objects_with_its_query_sorted() {
        let headers = headers(&[
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let query = vec![("prefix".to_owned(), "J".to_owned()), ("max-keys".to_owned(), "2".to_owned())];
        let request =
            Signable { method: "GET", path: "/", query: &query, headers: &headers, payload_sha256: EMPTY_SHA256 };

        assert_eq!(canonical_query(&query), "max-keys=2&prefix=J");
        assert_eq!(
            signature(&authorization(&example(), &request, "20130524T000000Z")),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    #[test]
    fn encodes_as_signature_version_4_does() {
        assert_eq!(uri_encode("assets/app-3c9d.js", true), "assets/app-3c9d.js");
        assert_eq!(uri_encode("a b+c/é~_.", true), "a%20b%2Bc/%C3%A9~_.");
        assert_eq!(uri_encode("a/b=c", false), "a%2Fb%3Dc");
        assert_eq!(amz_date(SystemTime::UNIX_EPOCH + Duration::from_secs(1_369_353_600)), "20130524T000000Z");
    }

    #[test]
    fn reads_a_listing_page_its_keys_decoded_and_its_etags_unquoted() {
        let page = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>shop</Name><IsTruncated>true</IsTruncated>
<Contents><Key>index.html</Key><LastModified>2026-10-30T10:00:00.000Z</LastModified><ETag>&quot;900150983cd24fb0d6963f7d28e17f72&quot;</ETag><Size>3</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>docs/a&amp;b &#233;.html</Key><ETag>"abc"</ETag><Size>12</Size></Contents>
<NextContinuationToken>MmM=</NextContinuationToken></ListBucketResult>"#;

        assert_eq!(
            objects_of(page),
            vec![
                Object { key: "index.html".into(), etag: "900150983cd24fb0d6963f7d28e17f72".into(), size: 3 },
                Object { key: "docs/a&b é.html".into(), etag: "abc".into(), size: 12 },
            ]
        );
        assert_eq!(element(page, "IsTruncated").as_deref(), Some("true"));
        assert_eq!(element(page, "NextContinuationToken").as_deref(), Some("MmM="));
        assert_eq!(unescape("a &unknown; & b &#x41;"), "a &unknown; & b A");
    }

    #[test]
    fn reaches_a_host_under_localhost_at_127_0_0_1_its_host_header_the_endpoints() {
        let client = |endpoint: &str| BucketClient::new(endpoint, "shop", example()).unwrap();
        let local = client("http://s3.localhost:9003/");
        assert_eq!([local.host.as_str(), local.connect.as_str()], ["s3.localhost:9003", "http://127.0.0.1:9003"]);
        let remote = client("https://s3.dev.ffunc.cloud");
        assert_eq!(
            [remote.host.as_str(), remote.connect.as_str()],
            ["s3.dev.ffunc.cloud", "https://s3.dev.ffunc.cloud"]
        );
        assert!(BucketClient::new("s3.example.tn", "shop", example()).is_err());
    }
}
