//! A request's bucket and key, and the operation it is, as FF's S3 front door tells them apart
//! (`BE/src/storage/s3-requests.ts`); its tests read the backend's table.

use super::defaults::UNSET_SETTINGS;
use crate::sigv4::decode_escapes;

/// How a request names its bucket: by its host's first label, or its path's first segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    VirtualHosted,
    Path,
}

/// A request's bucket and key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub style: Style,
    /// The bucket's name; empty for a request to the service itself, such as ListBuckets.
    pub bucket: String,
    /// The key as the client sent it in the path, still encoded; empty for the bucket itself.
    pub raw_key: String,
}

/// The bucket and key a request names. `<bucket>.<host>`, for one of `hosts`, is virtual-hosted; anything else is
/// path-style, `<host>/<bucket>/<key>`, as AWS's SDKs address an IP address, and boto3 and the CLI any endpoint. Bucket
/// names have no dots, so a host with one more label than one of these is a bucket's; one of them is none, though it
/// is a label more than another.
pub fn address_of(host: Option<&str>, raw_path: &str, hosts: &[&str]) -> Address {
    let host = host.unwrap_or_default().to_ascii_lowercase();
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => &host,
    };
    let name = name.strip_suffix('.').unwrap_or(name);
    for own in hosts.iter().filter(|_| !hosts.contains(&name)) {
        if let Some(bucket) = name.strip_suffix(&format!(".{own}"))
            && !bucket.contains('.')
        {
            let raw_key = raw_path.strip_prefix('/').unwrap_or(raw_path);
            return Address { style: Style::VirtualHosted, bucket: bucket.to_owned(), raw_key: raw_key.to_owned() };
        }
    }
    let mut segments = raw_path.split('/').skip(1);
    let bucket = decode_escapes(segments.next().unwrap_or_default());
    Address { style: Style::Path, bucket, raw_key: segments.collect::<Vec<_>>().join("/") }
}

/// How AWS bills a request: its first class (PUT, COPY, POST, LIST), its second (GET, HEAD and the rest), or free
/// (DELETE, an upload aborted).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Tier1,
    Tier2,
    Free,
}

/// An operation the front door serves, as S3 names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operation {
    pub name: &'static str,
    pub class: Class,
    /// Whether it changes the bucket.
    pub writes: bool,
}

const fn op(name: &'static str, class: Class) -> Operation {
    Operation { name, class, writes: false }
}

const fn writes(name: &'static str, class: Class) -> Operation {
    Operation { name, class, writes: true }
}

pub const NOT_IMPLEMENTED: Operation = op("NotImplemented", Class::Tier2);

/// Query parameters every request may carry: the signature's, the checksum's a presigned URL signs, and the "x-id"
/// AWS's SDKs add.
fn always(name: &str) -> bool {
    let tail_of = |prefix: &str| name.strip_prefix(prefix).filter(|tail| !tail.is_empty());
    tail_of("X-Amz-").is_some_and(|tail| tail.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
        || tail_of("x-amz-checksum-")
            .is_some_and(|tail| tail.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
        || name == "x-amz-sdk-checksum-algorithm"
        || name == "x-id"
}

const LISTING: [&str; 9] = [
    "list-type",
    "prefix",
    "delimiter",
    "max-keys",
    "marker",
    "continuation-token",
    "start-after",
    "encoding-type",
    "fetch-owner",
];
const UPLOADS_LISTING: [&str; 7] =
    ["uploads", "prefix", "delimiter", "max-uploads", "key-marker", "upload-id-marker", "encoding-type"];
const PARTS_LISTING: [&str; 4] = ["uploadId", "max-parts", "part-number-marker", "encoding-type"];
/// GetObject's parameters: a part of a multipart upload's object, and the headers its answer takes from the query.
pub const GET_OBJECT: [&str; 7] = [
    "partNumber",
    "response-content-type",
    "response-content-language",
    "response-expires",
    "response-cache-control",
    "response-content-disposition",
    "response-content-encoding",
];

/// A bucket's settings FF keeps, by S3's query parameter for each: the operations that read it, set it whole, and
/// remove it, where S3 has one.
pub const KEPT_SETTINGS: [(&str, &str, &str, Option<&str>); 5] = [
    ("notification", "GetBucketNotificationConfiguration", "PutBucketNotificationConfiguration", None),
    ("website", "GetBucketWebsite", "PutBucketWebsite", Some("DeleteBucketWebsite")),
    ("tagging", "GetBucketTagging", "PutBucketTagging", Some("DeleteBucketTagging")),
    ("policy", "GetBucketPolicy", "PutBucketPolicy", Some("DeleteBucketPolicy")),
    ("publicAccessBlock", "GetPublicAccessBlock", "PutPublicAccessBlock", Some("DeletePublicAccessBlock")),
];

/// The operation on a setting FF keeps that a request with its one parameter is: a read, a change, or a removal,
/// free as S3's are.
fn kept_setting(method: &str, parameter: &str) -> Option<Operation> {
    let (_, get, put, delete) = KEPT_SETTINGS.into_iter().find(|(name, ..)| *name == parameter)?;
    match method {
        "GET" => Some(op(get, Class::Tier2)),
        "PUT" => Some(writes(put, Class::Tier1)),
        "DELETE" => delete.map(|delete| writes(delete, Class::Free)),
        _ => None,
    }
}

/// The operation a request is, from its method, its address, its query's parameters, decoded, and whether it names a
/// copy's source, as S3 tells them apart; anything else, a bucket's CORS set or an object's tags among them, is
/// NotImplemented. Its parameters must all be the operation's.
pub fn operation_of(method: &str, address: &Address, query: &[(String, String)], copy_source: bool) -> Operation {
    let mut names: Vec<&str> = Vec::new();
    for (name, _) in query {
        if !always(name) && !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    let only = |allowed: &[&str]| names.iter().all(|name| allowed.contains(name));
    let has = |name: &str| names.contains(&name);

    if address.bucket.is_empty() {
        return if method == "GET" && names.is_empty() { op("ListBuckets", Class::Tier1) } else { NOT_IMPLEMENTED };
    }
    if address.raw_key.is_empty() {
        if method == "GET" && has("location") && only(&["location"]) {
            return op("GetBucketLocation", Class::Tier2);
        }
        if let [parameter] = names.as_slice()
            && let Some(kept) = kept_setting(method, parameter)
        {
            return kept;
        }
        if method == "GET"
            && let [parameter] = names.as_slice()
            && let Some((name, ..)) = UNSET_SETTINGS.iter().find(|(_, unset, _)| unset == parameter)
        {
            return op(name, Class::Tier2);
        }
        return match method {
            "GET" if has("uploads") && only(&UPLOADS_LISTING) => op("ListMultipartUploads", Class::Tier1),
            "GET" if only(&LISTING) => {
                let v2 = query.iter().any(|(name, value)| name == "list-type" && value == "2");
                op(if v2 { "ListObjectsV2" } else { "ListObjects" }, Class::Tier1)
            }
            "HEAD" if names.is_empty() => op("HeadBucket", Class::Tier2),
            "POST" if has("delete") && only(&["delete"]) => writes("DeleteObjects", Class::Free),
            "PUT" if names.is_empty() => writes("CreateBucket", Class::Tier1),
            "DELETE" if names.is_empty() => writes("DeleteBucket", Class::Free),
            _ => NOT_IMPLEMENTED,
        };
    }
    match method {
        "PUT" if has("partNumber") || has("uploadId") => {
            match only(&["partNumber", "uploadId"]) && has("partNumber") && has("uploadId") {
                true => writes(if copy_source { "UploadPartCopy" } else { "UploadPart" }, Class::Tier1),
                false => NOT_IMPLEMENTED,
            }
        }
        "PUT" if names.is_empty() => writes(if copy_source { "CopyObject" } else { "PutObject" }, Class::Tier1),
        "POST" if has("uploads") && only(&["uploads"]) => writes("CreateMultipartUpload", Class::Tier1),
        "POST" if has("uploadId") && only(&["uploadId"]) => writes("CompleteMultipartUpload", Class::Tier1),
        "GET" if has("uploadId") => {
            if only(&PARTS_LISTING) {
                op("ListParts", Class::Tier1)
            } else {
                NOT_IMPLEMENTED
            }
        }
        "GET" if only(&GET_OBJECT) => op("GetObject", Class::Tier2),
        "HEAD" if only(&["partNumber"]) => op("HeadObject", Class::Tier2),
        "DELETE" if has("uploadId") => {
            if only(&["uploadId"]) {
                writes("AbortMultipartUpload", Class::Free)
            } else {
                NOT_IMPLEMENTED
            }
        }
        "DELETE" if names.is_empty() => writes("DeleteObject", Class::Free),
        _ => NOT_IMPLEMENTED,
    }
}

/// The service a request is signed for, as its credential's scope names it, in its Authorization header or a
/// presigned URL's query: none for a request unsigned, or signed otherwise than with Signature Version 4.
pub fn signed_service(authorization: Option<&str>, raw_query: &str) -> Option<String> {
    let credential = match authorization {
        Some(authorization) => {
            authorization.split([' ', ',']).find_map(|part| part.strip_prefix("Credential=")).map(str::to_owned)
        }
        None => parse_query(raw_query).into_iter().find(|(name, _)| name == "X-Amz-Credential").map(|(_, value)| value),
    }?;
    credential.split('/').nth(3).map(str::to_owned)
}

/// A query's pairs, decoded as URLSearchParams decodes them: `%XX` its byte, `+` a space.
pub fn parse_query(raw_query: &str) -> Vec<(String, String)> {
    let decoded = |text: &str| decode_escapes(&text.replace('+', " "));
    raw_query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decoded(name), decoded(value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// The table the backend's tests read: requests' addresses, and the operations they are.
    fn table() -> Value {
        serde_json::from_str(include_str!("../../../../BE/src/storage/s3-examples.json")).unwrap()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    /// Each case of the table's group, as the front door reads it.
    fn addresses_of(group: &str) {
        let table = table();
        let cases = table["addresses"][group].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let (host, path) = (text(&case["host"]), text(&case["path"]));
            let read = address_of(Some(host), path, &[text(&table["host"])]);
            let style = match read.style {
                Style::VirtualHosted => "virtual-hosted",
                Style::Path => "path",
            };
            let expected = &case["address"];
            assert_eq!(
                (host, path, style, read.bucket.as_str(), read.raw_key.as_str()),
                (host, path, text(&expected["style"]), text(&expected["bucket"]), text(&expected["rawKey"]))
            );
        }
    }

    fn operations_of(group: &str) {
        let table = table();
        let cases = table["operations"][group].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let (method, on, query) = (text(&case["method"]), text(&case["on"]), text(&case["query"]));
            let (bucket, raw_key) = match on {
                "service" => ("", ""),
                "bucket" => ("photos", ""),
                _ => ("photos", "a.jpg"),
            };
            let address = Address { style: Style::Path, bucket: bucket.into(), raw_key: raw_key.into() };
            let copy_source = case["headers"].get("x-amz-copy-source").is_some();
            let operation = operation_of(method, &address, &parse_query(query), copy_source);
            let class = match operation.class {
                Class::Tier1 => "tier1",
                Class::Tier2 => "tier2",
                Class::Free => "free",
            };
            let is = format!("{} {class}{}", operation.name, if operation.writes { " writes" } else { "" });
            assert_eq!(format!("{method} {on} {query}: {is}"), format!("{method} {on} {query}: {}", text(&case["is"])));
        }
    }

    #[test]
    fn a_requests_bucket_and_key_virtual_hosted_as_the_sdk_for_javascript_addresses_a_host_name() {
        addresses_of("virtualHosted");
    }

    #[test]
    fn a_requests_bucket_and_key_path_style_as_boto3_and_the_cli_address_any_endpoint() {
        addresses_of("pathStyle");
    }

    #[test]
    fn a_host_two_labels_deeper_is_no_buckets_path_style_so_its_path_names_the_bucket() {
        addresses_of("deeperHost");
    }

    #[test]
    fn the_operation_a_request_is_each_of_the_tables_groups() {
        let table = table();
        let groups = table["operations"].as_object().unwrap();
        assert_eq!(groups.len(), 9);
        for group in groups.keys() {
            operations_of(group);
        }
    }

    #[test]
    fn a_host_of_its_own_is_path_style_though_it_is_under_another() {
        let hosts = ["s3.localhost", "localhost"];

        let own = address_of(Some("s3.localhost:3700"), "/photos/a.jpg", &hosts);
        let under = address_of(Some("photos.s3.localhost:3700"), "/a.jpg", &hosts);
        let under_another = address_of(Some("Photos.localhost"), "/a.jpg", &hosts);

        assert_eq!((own.style, own.bucket.as_str(), own.raw_key.as_str()), (Style::Path, "photos", "a.jpg"));
        assert_eq!(
            (under.style, under.bucket.as_str(), under.raw_key.as_str()),
            (Style::VirtualHosted, "photos", "a.jpg")
        );
        assert_eq!((under_another.style, under_another.bucket.as_str()), (Style::VirtualHosted, "photos"));
    }

    #[test]
    fn a_request_is_signed_for_the_service_its_credentials_scope_names() {
        let header =
            "AWS4-HMAC-SHA256 Credential=AKFF/20261023/tn-tunis-1/s3/aws4_request, SignedHeaders=host, Signature=0";
        let query = "X-Amz-Credential=AKFF%2F20261023%2Ftn-tunis-1%2Fsqs%2Faws4_request&X-Amz-Signature=0";

        assert_eq!(signed_service(Some(header), "").as_deref(), Some("s3"));
        assert_eq!(signed_service(None, query).as_deref(), Some("sqs"));
        assert_eq!(signed_service(Some("AWS AKFF:c2lnbmVk"), query), None, "a header of another scheme");
        assert_eq!(signed_service(None, "prefix=a"), None);
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
