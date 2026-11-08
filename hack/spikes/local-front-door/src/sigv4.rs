//! Signature Version 4, read and checked as the backend's front doors check it (BE/src/common/signature-v4.ts): the
//! canonical request, the string to sign, the day's key, the signature over each form of the path a client may have
//! signed. Its problems are named, and each front door says them in its own service's words.

use ring::{digest, hmac};

pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";
/// How far from now a header-signed request's time may be, either way: 15 minutes.
pub const MAX_CLOCK_SKEW_SECONDS: i64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// A session token: the keys have none, so it is one never issued.
    Token,
    /// An Authorization header that isn't AWS4-HMAC-SHA256's.
    Algorithm,
    /// No Credential, SignedHeaders or Signature.
    Parts,
    /// A credential that isn't <access key ID>/<day>/<region>/<service>/aws4_request.
    Credential {
        part: &'static str,
        value: String,
    },
    /// A credential scoped to another service.
    Service {
        named: String,
    },
    NoDate,
    /// A time that isn't YYYYMMDDTHHMMSSZ.
    Date {
        amz_date: String,
    },
    /// A time on another day than the credential's.
    OtherDay {
        date: String,
        amz_date: String,
    },
    /// A time more than 15 minutes from now.
    Skewed {
        amz_date: String,
    },
    /// A header that must be signed and isn't.
    Unsigned {
        header: &'static str,
    },
    /// A signature that isn't the key's.
    Mismatch,
}

/// How a service signs a path: S3's way, each segment encoded once and nothing normalized; or every other
/// service's, normalized and each segment escaped twice.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Paths {
    Once,
    Twice,
}

/// What a signature is checked against: the request as it came, its path and query unparsed, its headers as sent.
pub struct SignedRequest<'a> {
    pub method: &'a str,
    pub raw_path: &'a str,
    pub raw_query: &'a str,
    pub headers: &'a [(String, String)],
}

/// What an Authorization header's signature says, read but not yet checked.
#[derive(Debug, Clone)]
pub struct HeaderSignature {
    pub access_key_id: String,
    /// The scope's day, YYYYMMDD.
    pub date: String,
    pub region: String,
    pub signed_headers: Vec<String>,
    pub signature: String,
    /// The request's time as signed, YYYYMMDDTHHMMSSZ.
    pub amz_date: String,
}

/// What an aws-chunked body's chunk signatures chain from: the day's key, the scope, the time, the request's signature.
#[derive(Clone)]
pub struct Chain {
    pub key: hmac::Key,
    pub scope: String,
    pub amz_date: String,
    pub seed: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    crate::md5::hex(digest::digest(&digest::SHA256, data).as_ref())
}

pub fn hmac_bytes(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes()).as_ref().to_vec()
}

pub fn hmac_hex(key: &hmac::Key, data: &str) -> String {
    crate::md5::hex(hmac::sign(key, data.as_bytes()).as_ref())
}

/// The day's key: the secret, then the day, the region, the service and "aws4_request", each an HMAC of the last.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> hmac::Key {
    let mut key = format!("AWS4{secret}").into_bytes();
    for part in [date, region, service, "aws4_request"] {
        key = hmac_bytes(&key, part);
    }
    hmac::Key::new(hmac::HMAC_SHA256, &key)
}

pub fn scope_of(date: &str, region: &str, service: &str) -> String {
    format!("{date}/{region}/{service}/aws4_request")
}

/// RFC 3986's encoding, as Signature Version 4 wants it: every byte but the unreserved ones, upper-case hex.
pub fn uri_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// %XX escapes decoded, and nothing else: "+" stays "+". Text that isn't valid, as an escape or as UTF-8, stays.
pub fn decode_escapes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = bytes.get(at + 1..at + 3).filter(|pair| pair.iter().all(u8::is_ascii_hexdigit));
            let Some(pair) = pair else { return text.to_string() };
            out.push(u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap());
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// The path as S3 signs it: each segment encoded once, as the client meant it, nothing normalized.
pub fn canonical_uri(raw_path: &str) -> String {
    let path = raw_path.split('/').map(|segment| uri_encode(&decode_escapes(segment), false)).collect::<Vec<_>>();
    let path = path.join("/");
    if path.is_empty() { "/".into() } else { path }
}

/// Each segment escaped twice, for a client of a service but S3 that sent it unescaped.
fn canonical_uri_twice(raw_path: &str) -> String {
    let path = raw_path
        .split('/')
        .map(|segment| uri_encode(&uri_encode(&decode_escapes(segment), false), false))
        .collect::<Vec<_>>()
        .join("/");
    if path.is_empty() { "/".into() } else { path }
}

/// A path as AWS normalizes it for every service but S3: empty and "." segments gone, ".." taking the one before.
pub fn normalized_path(raw_path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in raw_path.split('/') {
        match segment {
            ".." => {
                segments.pop();
            }
            "" | "." => {}
            _ => segments.push(segment),
        }
    }
    let trailing = if !segments.is_empty() && raw_path.ends_with('/') { "/" } else { "" };
    format!("/{}{trailing}", segments.join("/"))
}

pub fn canonical_path(raw_path: &str, paths: Paths) -> String {
    match paths {
        Paths::Once => canonical_uri(raw_path),
        Paths::Twice => uri_encode(&normalized_path(raw_path), true),
    }
}

/// The query as signed: each name and value encoded, sorted by name then value; `exclude` left out.
pub fn canonical_query(raw_query: &str, exclude: Option<&str>) -> String {
    let mut pairs: Vec<(String, String)> = raw_query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            let name = decode_escapes(name);
            if Some(name.as_str()) == exclude {
                return None;
            }
            Some((uri_encode(&name, false), uri_encode(&decode_escapes(value), false)))
        })
        .collect();
    pairs.sort();
    pairs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&")
}

/// A header's values as joined for signing: each trimmed, inner spaces collapsed, joined by ",".
pub fn canonical_header_value(headers: &[(String, String)], name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .iter()
        .filter(|(header, _)| header.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    (!values.is_empty()).then(|| values.join(","))
}

pub fn canonical_request(
    request: &SignedRequest,
    path: &str,
    signed_headers: &[String],
    payload: &str,
    unsigned_query: Option<&str>,
) -> String {
    let headers: String = signed_headers
        .iter()
        .map(|name| format!("{name}:{}\n", canonical_header_value(request.headers, name).unwrap_or_default()))
        .collect();
    [
        request.method,
        path,
        &canonical_query(request.raw_query, unsigned_query),
        &headers,
        &signed_headers.join(";"),
        payload,
    ]
    .join("\n")
}

pub fn string_to_sign(amz_date: &str, scope: &str, canonical: &str) -> String {
    format!("{ALGORITHM}\n{amz_date}\n{scope}\n{}", sha256_hex(canonical.as_bytes()))
}

/// The first value of a header, by its name in any case.
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(header, _)| header.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim())
}

/// A credential's parts, scoped to the service.
pub fn read_credential(credential: &str, service: &str) -> Result<(String, String, String), Problem> {
    let parts: Vec<&str> = credential.split('/').collect();
    if parts.len() != 5 || parts[0].is_empty() || parts[2].is_empty() {
        return Err(Problem::Credential { part: "shape", value: credential.into() });
    }
    if parts[1].len() != 8 || !parts[1].bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Problem::Credential { part: "date", value: parts[1].into() });
    }
    if parts[3] != service {
        return Err(Problem::Service { named: parts[3].into() });
    }
    if parts[4] != "aws4_request" {
        return Err(Problem::Credential { part: "terminal", value: parts[4].into() });
    }
    Ok((parts[0].into(), parts[1].into(), parts[2].into()))
}

/// A request's signature, from its Authorization header; None when it has none. A session token is refused.
pub fn read_authorization(headers: &[(String, String)], service: &str) -> Result<Option<HeaderSignature>, Problem> {
    let Some(authorization) = header(headers, "authorization") else { return Ok(None) };
    if header(headers, "x-amz-security-token").is_some() {
        return Err(Problem::Token);
    }
    let Some(fields) = authorization.strip_prefix(&format!("{ALGORITHM} ")) else { return Err(Problem::Algorithm) };
    let field = |name: &str| {
        fields.split(',').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key.trim() == name).then(|| value.trim().to_string())
        })
    };
    let (Some(credential), Some(signed_headers), Some(signature)) =
        (field("Credential"), field("SignedHeaders"), field("Signature"))
    else {
        return Err(Problem::Parts);
    };
    let (access_key_id, date, region) = read_credential(&credential, service)?;
    let Some(amz_date) = header(headers, "x-amz-date") else { return Err(Problem::NoDate) };
    Ok(Some(HeaderSignature {
        access_key_id,
        date,
        region,
        signed_headers: signed_headers.split(';').map(String::from).collect(),
        signature,
        amz_date: amz_date.into(),
    }))
}

/// Days since 1970-01-01 of a day in the proleptic Gregorian calendar (Howard Hinnant's days_from_civil).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// A signed time, YYYYMMDDTHHMMSSZ, in seconds since the epoch; None when malformed.
pub fn signed_time(amz_date: &str) -> Option<i64> {
    let bytes = amz_date.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = amz_date.get(range)?;
        part.bytes().all(|byte| byte.is_ascii_digit()).then(|| part.parse().ok())?
    };
    if bytes.len() != 16 || bytes[8] != b'T' || bytes[15] != b'Z' {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(4..6)?, digits(6..8)?);
    let (hour, minute, second) = (digits(9..11)?, digits(11..13)?, digits(13..15)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

/// The time a request was signed at: well formed, and on the credential's day.
pub fn signed_at(date: &str, amz_date: &str) -> Result<i64, Problem> {
    let at = signed_time(amz_date).ok_or_else(|| Problem::Date { amz_date: amz_date.into() })?;
    if !amz_date.starts_with(date) {
        return Err(Problem::OtherDay { date: date.into(), amz_date: amz_date.into() });
    }
    Ok(at)
}

pub fn check_skew(at: i64, amz_date: &str, now: i64) -> Result<(), Problem> {
    if (now - at).abs() > MAX_CLOCK_SKEW_SECONDS {
        return Err(Problem::Skewed { amz_date: amz_date.into() });
    }
    Ok(())
}

pub fn require_signed(signed_headers: &[String], header: &'static str) -> Result<(), Problem> {
    if !signed_headers.iter().any(|name| name == header) {
        return Err(Problem::Unsigned { header });
    }
    Ok(())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The signature checked with the key's secret, over each form of the path the service's clients may have signed:
/// its own, then for S3 the path as sent, for every other service each segment escaped twice.
pub fn match_signature(
    request: &SignedRequest,
    signature: &HeaderSignature,
    payload: &str,
    secret: &str,
    service: &str,
    paths: Paths,
    unsigned_query: Option<&str>,
) -> Result<Chain, Problem> {
    let scope = scope_of(&signature.date, &signature.region, service);
    let key = signing_key(secret, &signature.date, &signature.region, service);
    let own = canonical_path(request.raw_path, paths);
    let other = match paths {
        Paths::Once if request.raw_path.is_empty() => "/".to_string(),
        Paths::Once => request.raw_path.to_string(),
        Paths::Twice => canonical_uri_twice(request.raw_path),
    };
    let forms = if other == own { vec![own] } else { vec![own, other] };
    for path in forms {
        let canonical = canonical_request(request, &path, &signature.signed_headers, payload, unsigned_query);
        if same(&hmac_hex(&key, &string_to_sign(&signature.amz_date, &scope, &canonical)), &signature.signature) {
            return Ok(Chain { key, scope, amz_date: signature.amz_date.clone(), seed: signature.signature.clone() });
        }
    }
    Err(Problem::Mismatch)
}

/// An Authorization header's signature checked as every service but S3 checks it: the time, the host signed, then
/// the signature over the request and the SHA-256 of its body.
pub fn check_authorization(
    request: &SignedRequest,
    body: &[u8],
    signature: &HeaderSignature,
    secret: &str,
    now: i64,
    service: &str,
) -> Result<(), Problem> {
    check_skew(signed_at(&signature.date, &signature.amz_date)?, &signature.amz_date, now)?;
    require_signed(&signature.signed_headers, "host")?;
    match_signature(request, signature, &sha256_hex(body), secret, service, Paths::Twice, None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// AWS's test suite, as the backend's tests read it (BE/src/common/signature-v4-suite).
    fn suite() -> Vec<Value> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../BE/src/common/signature-v4-suite/cases.json");
        let suite: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        suite["cases"].as_array().unwrap().clone()
    }

    struct Parsed {
        method: String,
        raw_path: String,
        raw_query: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Parsed {
        fn request(&self) -> SignedRequest<'_> {
            SignedRequest {
                method: &self.method,
                raw_path: &self.raw_path,
                raw_query: &self.raw_query,
                headers: &self.headers,
            }
        }
    }

    /// A request as the suite writes it, read as a front door gets it: a folded value kept whole.
    fn parse(text: &str) -> Parsed {
        let (head, body) = text.split_once("\n\n").unwrap_or((text, ""));
        let mut lines = head.split('\n');
        let request_line = lines.next().unwrap();
        let method = &request_line[..request_line.find(' ').unwrap()];
        let target = &request_line[method.len() + 1..request_line.rfind(" HTTP/").unwrap()];
        let mut headers: Vec<(String, String)> = Vec::new();
        for line in lines {
            if line.starts_with(char::is_whitespace) {
                headers.last_mut().unwrap().1.push_str(&format!("\n{line}"));
            } else {
                let (name, value) = line.split_once(':').unwrap();
                headers.push((name.into(), value.into()));
            }
        }
        let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
        Parsed {
            method: method.into(),
            raw_path: raw_path.into(),
            raw_query: raw_query.into(),
            headers,
            body: body.into(),
        }
    }

    fn paths_of(case: &Value) -> Paths {
        if case["context"]["normalize"].as_bool().unwrap() { Paths::Twice } else { Paths::Once }
    }

    #[test]
    fn awss_suite_signed_in_a_header_canonical_request_string_to_sign_and_signature() {
        let cases = suite();
        assert_eq!(cases.len(), 38);
        for case in &cases {
            let context = &case["context"];
            let service = context["service"].as_str().unwrap();
            let sent = parse(case["header"]["signedRequest"].as_str().unwrap());
            let without_token: Vec<(String, String)> = sent
                .headers
                .iter()
                .filter(|(name, _)| !name.eq_ignore_ascii_case("x-amz-security-token"))
                .cloned()
                .collect();
            let read = read_authorization(&without_token, service).unwrap().unwrap();
            let canonical = canonical_request(
                &sent.request(),
                &canonical_path(&sent.raw_path, paths_of(case)),
                &read.signed_headers,
                &sha256_hex(&sent.body),
                None,
            );
            let signed = string_to_sign(&read.amz_date, &scope_of(&read.date, &read.region, service), &canonical);
            assert_eq!(canonical, case["header"]["canonicalRequest"].as_str().unwrap(), "{}", case["name"]);
            assert_eq!(signed, case["header"]["stringToSign"].as_str().unwrap(), "{}", case["name"]);
            let secret = context["credentials"]["secret_access_key"].as_str().unwrap();
            let key = signing_key(secret, &read.date, &read.region, service);
            assert_eq!(hmac_hex(&key, &signed), case["header"]["signature"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    #[test]
    fn awss_suite_signed_in_a_header_checked_whole_refused_changed_or_with_a_token() {
        for case in suite() {
            let context = &case["context"];
            let service = context["service"].as_str().unwrap();
            let sent = parse(case["header"]["signedRequest"].as_str().unwrap());
            if context["credentials"]["token"].is_string() {
                assert_eq!(read_authorization(&sent.headers, service).unwrap_err(), Problem::Token, "{}", case["name"]);
                continue;
            }
            let read = read_authorization(&sent.headers, service).unwrap().unwrap();
            assert_eq!(read.access_key_id, context["credentials"]["access_key_id"].as_str().unwrap());
            let secret = context["credentials"]["secret_access_key"].as_str().unwrap();
            let at = signed_time(&read.amz_date).unwrap();
            let paths = paths_of(&case);
            let check = |request: &SignedRequest, secret: &str| -> Result<(), Problem> {
                check_skew(signed_at(&read.date, &read.amz_date)?, &read.amz_date, at)?;
                require_signed(&read.signed_headers, "host")?;
                match_signature(request, &read, &sha256_hex(&sent.body), secret, service, paths, None).map(|_| ())
            };
            assert_eq!(check(&sent.request(), secret), Ok(()), "{}", case["name"]);
            let deleted = SignedRequest { method: "DELETE", ..sent.request() };
            assert_eq!(check(&deleted, secret), Err(Problem::Mismatch), "{}", case["name"]);
            assert_eq!(check(&sent.request(), &format!("{secret}x")), Err(Problem::Mismatch), "{}", case["name"]);
        }
    }

    #[test]
    fn awss_suite_presigned_in_a_query_canonical_request_without_the_signature_and_the_signature_matched() {
        for case in suite() {
            let context = &case["context"];
            let service = context["service"].as_str().unwrap();
            let mut sent = parse(case["query"]["signedRequest"].as_str().unwrap());
            if context["omit_session_token"].as_bool() == Some(true) {
                sent.raw_query = sent
                    .raw_query
                    .split('&')
                    .filter(|pair| !pair.starts_with("X-Amz-Security-Token="))
                    .collect::<Vec<_>>()
                    .join("&");
            }
            let query = |name: &str| {
                sent.raw_query.split('&').find_map(|pair| {
                    let (key, value) = pair.split_once('=')?;
                    (key == name).then(|| decode_escapes(value))
                })
            };
            let credential = query("X-Amz-Credential").unwrap();
            let (_, date, region) = read_credential(&credential, service).unwrap();
            let presigned = HeaderSignature {
                access_key_id: String::new(),
                date: date.clone(),
                region: region.clone(),
                signed_headers: query("X-Amz-SignedHeaders").unwrap().split(';').map(String::from).collect(),
                signature: query("X-Amz-Signature").unwrap(),
                amz_date: query("X-Amz-Date").unwrap(),
            };
            let paths = paths_of(&case);
            let payload = sha256_hex(&sent.body);
            let canonical = canonical_request(
                &sent.request(),
                &canonical_path(&sent.raw_path, paths),
                &presigned.signed_headers,
                &payload,
                Some("X-Amz-Signature"),
            );
            assert_eq!(canonical, case["query"]["canonicalRequest"].as_str().unwrap(), "{}", case["name"]);
            let signed = string_to_sign(&presigned.amz_date, &scope_of(&date, &region, service), &canonical);
            assert_eq!(signed, case["query"]["stringToSign"].as_str().unwrap(), "{}", case["name"]);
            assert_eq!(presigned.signature, case["query"]["signature"].as_str().unwrap());
            let secret = context["credentials"]["secret_access_key"].as_str().unwrap();
            let matched =
                match_signature(&sent.request(), &presigned, &payload, secret, service, paths, Some("X-Amz-Signature"));
            assert!(matched.is_ok(), "{}", case["name"]);
            let extra = format!("{}&extra=1", sent.raw_query);
            let changed = SignedRequest { raw_query: &extra, ..sent.request() };
            let refused =
                match_signature(&changed, &presigned, &payload, secret, service, paths, Some("X-Amz-Signature"));
            assert_eq!(refused.err(), Some(Problem::Mismatch), "{}", case["name"]);
        }
    }

    #[test]
    fn reads_a_signed_time_and_refuses_a_malformed_one() {
        assert_eq!(signed_time("20150830T123600Z"), Some(1_440_938_160));
        assert_eq!(signed_time("19700101T000000Z"), Some(0));
        for malformed in ["20150830T123600", "2015-08-30T12:36:00Z", "20151330T123600Z", "2015083xT123600Z"] {
            assert_eq!(signed_time(malformed), None, "{malformed}");
        }
    }
}
