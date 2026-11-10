//! A bucket's site at `ff local start`'s front door, `http://<bucket>.site.localhost:<port>`, answered as FF's site
//! server answers one (`BE/src/storage/website-server.ts`): a bucket whose WebsiteConfiguration makes it a site, its
//! files to a browser, nothing signed, GET and HEAD alone. A folder's path answers its index document, and a folder
//! named without its slash is redirected to it; a path with no file answers the error document with 404, else a page of
//! the site's own naming the key. A browser's conditions and range are read as S3 reads them; a file kept without a
//! type gets one by its name; no answer may be sniffed. Given `--site <bucket>=<folder>`, the site answers a folder's
//! files instead of the bucket's objects, as `ff sites deploy` would upload them, without a copy: each typed and kept
//! by its name, those named with a dot first left out, `.well-known` apart. Its cases are
//! `BE/src/storage/website-examples.json`'s, which the backend's tests read too.

use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::error::S3Error;
use super::store::Object;
use super::xml::{S3_NAMESPACE, XML_DECLARATION, escape_xml};
use super::{Buckets, LocalBucket};
use crate::local::http::{Reply, Request, Response};
use crate::local::url::host_name;
use crate::site_files::{cache_control, content_type};

/// The host the sites are under, each at `<bucket>.site.localhost`, which a browser reaches on this machine.
pub const SITES_HOST: &str = "site.localhost";

/// The store's answer headers a browser gets: the object's own, its validators and its range. Its length is the
/// answer's, which the front door writes.
const ANSWERED: [&str; 9] = [
    "content-range",
    "content-encoding",
    "content-language",
    "content-disposition",
    "cache-control",
    "expires",
    "etag",
    "last-modified",
    "accept-ranges",
];

/// What a store gives an object uploaded without a type: the file's name says more.
const UNTYPED: [&str; 3] = ["", "binary/octet-stream", "application/octet-stream"];

/// A bucket's site, as its WebsiteConfiguration says: what a folder's path answers, and what a path with no file does.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct Website {
    pub index_document: String,
    pub error_document: Option<String>,
}

/// GetBucketWebsite's answer, in S3's XML.
pub fn website_xml(website: &Website) -> String {
    let error = website
        .error_document
        .as_deref()
        .map_or_else(String::new, |key| format!("<ErrorDocument><Key>{}</Key></ErrorDocument>", escape_xml(key)));
    format!(
        "{XML_DECLARATION}<WebsiteConfiguration xmlns=\"{S3_NAMESPACE}\"><IndexDocument><Suffix>{}</Suffix></IndexDocument>{error}</WebsiteConfiguration>",
        escape_xml(&website.index_document)
    )
}

/// S3's answer to GetBucketWebsite for a bucket that is no site.
pub fn no_such_website_configuration() -> S3Error {
    S3Error::new(404, "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration")
}

/// Whether a request's host is under the sites' host, whatever bucket it names.
pub fn is_site(host: Option<&str>) -> bool {
    host_name(host).is_some_and(|name| name == SITES_HOST || name.ends_with(&format!(".{SITES_HOST}")))
}

/// The bucket a host names: the label before the sites' host; none for any other host.
fn bucket_named(host: Option<&str>) -> Option<String> {
    let name = host_name(host)?;
    let bucket = name.strip_suffix(SITES_HOST)?.strip_suffix('.')?;
    (!bucket.is_empty() && !bucket.contains('.')).then(|| bucket.to_owned())
}

/// A site's answer of its own, as S3's website endpoint writes its errors: a small HTML page naming the code.
#[derive(Debug)]
pub struct SiteError {
    status: u16,
    code: &'static str,
    message: &'static str,
    key: Option<String>,
}

impl SiteError {
    const fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self { status, code, message, key: None }
    }

    fn invalid_uri() -> Self {
        Self::new(400, "InvalidURI", "Couldn't parse the specified URI.")
    }
}

/// The HTML page of a site's error, as S3's website endpoint writes one.
fn error_page(error: &SiteError, request_id: &str) -> String {
    let reason = match error.status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let title = format!("{} {reason}", error.status);
    let mut items = vec![format!("Code: {}", error.code), format!("Message: {}", error.message)];
    items.extend(error.key.iter().map(|key| format!("Key: {key}")));
    items.push(format!("RequestId: {request_id}"));
    let items: Vec<String> = items.iter().map(|item| format!("<li>{}</li>", escape_xml(item))).collect();
    format!(
        "<html>\n<head><title>{title}</title></head>\n<body>\n<h1>{title}</h1>\n<ul>\n{}\n</ul>\n<hr/>\n</body>\n</html>\n",
        items.join("\n")
    )
}

/// A path's escapes decoded, as a browser's are read: each `%` two hexadecimal digits, the bytes UTF-8.
fn decoded(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let (mut out, mut at) = (Vec::with_capacity(bytes.len()), 0);
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(pair, 16).ok().filter(|_| pair.bytes().all(|b| b.is_ascii_hexdigit()))?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The key a site's path names, as S3's website endpoint reads one: its escapes decoded, a folder's path (one ending in
/// `/`) its index document. A path that climbs out of the site (`.` or `..` as a segment) or names a control character
/// is refused: no browser sends one, and no key outside the bucket may be read.
pub fn key_of(raw_path: &str, index_document: &str) -> Result<String, SiteError> {
    let path = decoded(raw_path).ok_or_else(SiteError::invalid_uri)?;
    if path.split('/').any(|segment| segment == "." || segment == "..") || path.chars().any(char::is_control) {
        return Err(SiteError::invalid_uri());
    }
    let index = if path.ends_with('/') { index_document } else { "" };
    Ok(format!("{}{index}", path.strip_prefix('/').unwrap_or(&path)))
}

/// The type a site answers a file with: the one it was kept with, else the one its name gives.
fn served_content_type(kept: Option<&str>, key: &str) -> String {
    match kept {
        Some(kept)
            if !UNTYPED.contains(&kept.split(';').next().unwrap_or_default().trim().to_ascii_lowercase().as_str()) =>
        {
            kept.to_owned()
        }
        _ => content_type(key).to_owned(),
    }
}

/// The file a key names in a site's folder: each of its segments a name, none empty, none Windows's separator or
/// drive, none named with a dot first but `.well-known`, as `ff sites deploy` uploads none of them; none for any other
/// key, which no file of the folder is.
fn file_in(folder: &Path, key: &str) -> Option<PathBuf> {
    let mut path = folder.to_path_buf();
    for segment in key.split('/') {
        let one_name = matches!(Path::new(segment).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)]);
        let hidden = segment.starts_with('.') && segment != ".well-known";
        if segment.is_empty() || segment.contains(['\\', ':']) || hidden || !one_name {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

impl Buckets {
    /// A visit to a site: its answer, never an S3 error, as a browser reads it.
    pub fn site(&self, head: &Request, request_id: &str) -> Reply {
        self.site_answer(head, request_id).unwrap_or_else(|error| {
            let body = if head.method == "HEAD" { Vec::new() } else { error_page(&error, request_id).into_bytes() };
            let mut headers = vec![
                ("content-type".to_owned(), "text/html; charset=utf-8".to_owned()),
                ("x-content-type-options".to_owned(), "nosniff".to_owned()),
                ("x-amz-request-id".to_owned(), request_id.to_owned()),
            ];
            if error.status == 405 {
                headers.push(("allow".into(), "GET, HEAD".into()));
            }
            Reply::Whole(Response { status: error.status, headers, body })
        })
    }

    /// A site's answer to a request it couldn't read as HTTP.
    pub fn site_unreadable(&self, request_id: &str) -> Response {
        let refused = SiteError::new(400, "BadRequest", "The request couldn't be read as HTTP.");
        Response {
            status: 400,
            headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
            body: error_page(&refused, request_id).into_bytes(),
        }
    }

    fn site_answer(&self, head: &Request, request_id: &str) -> Result<Reply, SiteError> {
        if head.method != "GET" && head.method != "HEAD" {
            return Err(SiteError::new(
                405,
                "MethodNotAllowed",
                "The specified method is not allowed against this resource: a site answers GET and HEAD",
            ));
        }
        let no_such_bucket = || SiteError::new(404, "NoSuchBucket", "The specified bucket does not exist");
        let name = bucket_named(head.header("host")).ok_or_else(no_such_bucket)?;
        let bucket = self.bucket(&name).ok_or_else(no_such_bucket)?;
        let Some(website) = &bucket.website else {
            return Err(SiteError::new(
                404,
                "NoSuchWebsiteConfiguration",
                "The specified bucket does not have a website configuration",
            ));
        };
        let (raw_path, raw_query) = head.target.split_once('?').unwrap_or((head.target.as_str(), ""));
        let key = key_of(raw_path, &website.index_document)?;
        if let Some(found) = self.site_object(bucket, &key)? {
            return self.relayed(head, found, &key, None, request_id);
        }
        // A folder named without its slash, as S3's website endpoint answers it: redirected to the folder, when it has
        // an index document.
        if !raw_path.ends_with('/') && self.site_object(bucket, &format!("{key}/{}", website.index_document))?.is_some()
        {
            let query = if raw_query.is_empty() { String::new() } else { format!("?{raw_query}") };
            let headers = vec![
                ("location".to_owned(), format!("{raw_path}/{query}")),
                ("x-amz-request-id".into(), request_id.into()),
            ];
            return Ok(Reply::Whole(Response { status: 302, headers, body: Vec::new() }));
        }
        if let Some(error_document) = &website.error_document
            && let Some(found) = self.site_object(bucket, error_document)?
        {
            // The error document whole, whatever the browser's conditions and range for the file it didn't find.
            let plain = Request { method: head.method.clone(), ..Request::default() };
            return self.relayed(&plain, found, error_document, Some(404), request_id);
        }
        Err(SiteError { key: Some(key), ..SiteError::new(404, "NoSuchKey", "The specified key does not exist.") })
    }

    /// The site's file of that key: the bucket's object, or the `--site` folder's file, as `ff sites deploy` would
    /// keep it; none when it has none.
    fn site_object(&self, bucket: &LocalBucket, key: &str) -> Result<Option<(Object, File)>, SiteError> {
        let what = format!("read {}'s site's {key}", bucket.name);
        let failed = |error: std::io::Error| {
            (self.say)(&format!("ff local couldn't {what}: {error}"));
            SiteError::new(502, "BadGateway", "The site's file couldn't be read: try again in a moment")
        };
        let Some(folder) = &bucket.site_folder else {
            return self.store.open_object(&bucket.name, key).map_err(failed);
        };
        let Some(path) = file_in(folder, key) else { return Ok(None) };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return Ok(None),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
                return Ok(None);
            }
            Err(error) => return Err(failed(error)),
        };
        let file = File::open(&path).map_err(failed)?;
        let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok());
        let modified = modified.map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX));
        let object = Object {
            key: key.to_owned(),
            file: path.display().to_string(),
            size: metadata.len(),
            // Its time and its size, as web servers tag a file, which change when it does.
            etag: format!("\"{modified:x}-{:x}\"", metadata.len()),
            modified,
            headers: vec![
                ("content-type".into(), content_type(key).into()),
                ("cache-control".into(), cache_control(key).into()),
            ],
            parts: Vec::new(),
        };
        Ok(Some((object, file)))
    }

    /// A file's answer to the browser, read as S3 reads an object, its conditions and range first, with the status
    /// given or its own: its headers a browser gets, its type, never to be sniffed. A condition that doesn't hold, or a
    /// range past the file, is answered without a body.
    fn relayed(
        &self,
        head: &Request,
        found: (Object, File),
        key: &str,
        status: Option<u16>,
        request_id: &str,
    ) -> Result<Reply, SiteError> {
        let kept_type = crate::sigv4::header(&found.0.headers, "content-type").map(str::to_owned);
        let what = format!("read {key} for a site");
        let own = [("x-content-type-options", "nosniff"), ("x-amz-request-id", request_id)];
        let own = own.map(|(name, value)| (name.to_owned(), value.to_owned()));
        let reply = match self.read_object(head, found, None, &what) {
            Ok(reply) => reply,
            Err(S3Error { status: refused @ (412 | 416), .. }) => {
                return Ok(Reply::Whole(Response { status: refused, headers: own.to_vec(), body: Vec::new() }));
            }
            Err(_) => {
                return Err(SiteError::new(
                    502,
                    "BadGateway",
                    "The site's file couldn't be read: try again in a moment",
                ));
            }
        };
        let answered = |headers: Vec<(String, String)>, read: u16| {
            let mut kept: Vec<(String, String)> = headers
                .into_iter()
                .filter(|(name, _)| ANSWERED.contains(&name.to_ascii_lowercase().as_str()))
                .collect();
            if read == 200 || read == 206 {
                kept.push(("content-type".into(), served_content_type(kept_type.as_deref(), key)));
            }
            kept.extend(own.iter().cloned());
            kept
        };
        Ok(match reply {
            Reply::Whole(response) => Reply::Whole(Response {
                status: status.unwrap_or(response.status),
                headers: answered(response.headers, response.status),
                body: response.body,
            }),
            Reply::File { response, file, length } => Reply::File {
                response: Response {
                    status: status.unwrap_or(response.status),
                    headers: answered(response.headers, response.status),
                    body: Vec::new(),
                },
                file,
                length,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Write as _;
    use std::sync::Arc;

    use serde::Deserialize;

    use super::*;
    use crate::local::http::write_reply;

    #[derive(Deserialize)]
    struct Table {
        objects: BTreeMap<String, Stored>,
        website: Website,
        visits: Vec<Group>,
        keys: Vec<KeyCase>,
        documents: Vec<DocumentCase>,
    }

    #[derive(Deserialize)]
    struct Stored {
        body: String,
        #[serde(rename = "type")]
        content_type: String,
    }

    #[derive(Deserialize)]
    struct Group {
        group: String,
        visits: Vec<Visit>,
    }

    /// A visit of the table's, and what its answer has; the store's requests it made are the backend's alone.
    #[derive(Deserialize)]
    struct Visit {
        name: String,
        host: Option<String>,
        method: Option<String>,
        path: String,
        #[serde(default)]
        request: BTreeMap<String, String>,
        #[serde(default)]
        revisit: bool,
        #[serde(default)]
        website: serde_json::Map<String, serde_json::Value>,
        status: u16,
        body: Option<String>,
        #[serde(default)]
        includes: Vec<String>,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        present: Vec<String>,
        #[serde(default)]
        absent: Vec<String>,
    }

    #[derive(Deserialize)]
    struct KeyCase {
        path: String,
        key: String,
    }

    #[derive(Deserialize)]
    struct DocumentCase {
        name: String,
        website: Website,
        xml: String,
    }

    fn table() -> Table {
        serde_json::from_str(include_str!("../../../../BE/src/storage/website-examples.json")).unwrap()
    }

    /// An answer as a browser reads it off the wire.
    #[derive(Debug)]
    struct Seen {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            crate::sigv4::header(&self.headers, name)
        }
    }

    /// The buckets `shop`, a site whose configuration is `website`, served from `folder` when one is given, and
    /// `private`, which is no site, their objects kept under `root`.
    fn buckets(root: &Path, website: Website, folder: Option<&Path>) -> Buckets {
        let shop = LocalBucket {
            website: Some(website),
            site_folder: folder.map(Path::to_path_buf),
            ..LocalBucket::named("shop")
        };
        Buckets::open(
            root,
            vec![shop, LocalBucket::named("private")],
            "tn-tunis-1",
            "000000000000",
            Arc::new(|| 0),
            Arc::new(|_: &str| {}),
        )
        .unwrap()
    }

    fn visit(buckets: &Buckets, host: &str, method: &str, path: &str, headers: &[(String, String)]) -> Seen {
        let mut sent = vec![("Host".to_owned(), host.to_owned())];
        sent.extend(headers.iter().cloned());
        let head = Request {
            method: method.into(),
            target: path.into(),
            protocol: "HTTP/1.1".into(),
            headers: sent,
            body: Vec::new(),
        };
        let mut wire = Vec::new();
        write_reply(&mut wire, buckets.site(&head, "the-request"), "the-request", method == "HEAD").unwrap();
        let text = String::from_utf8(wire).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect();
        Seen { status, headers, body: body.to_owned() }
    }

    /// Each visit of the table's but a single-page app's, which a template's WebsiteConfiguration can't say, made and
    /// its answer compared with the table's; the content type, when `typed_by_name`, the one its name gives instead.
    fn play(root: &Path, folder: Option<&Path>, typed_by_name: bool) -> usize {
        let table = table();
        let mut played = 0;
        for group in table.visits.iter().filter(|group| group.group != "a single-page app") {
            for example in &group.visits {
                let mut website = table.website.clone();
                if let Some(error_document) = example.website.get("errorDocument") {
                    website.error_document = error_document.as_str().map(str::to_owned);
                }
                let buckets = buckets(root, website, folder);
                let host = example.host.as_deref().unwrap_or("shop.{sites}").replace("{sites}", SITES_HOST);
                let method = example.method.as_deref().unwrap_or("GET");
                let mut headers: Vec<(String, String)> =
                    example.request.iter().map(|(name, value)| (name.clone(), value.clone())).collect();
                if example.revisit {
                    let first = visit(&buckets, &host, "GET", &example.path, &[]);
                    headers.push(("If-None-Match".into(), first.header("etag").unwrap().to_owned()));
                }
                let seen = visit(&buckets, &host, method, &example.path, &headers);
                let title = format!("{}: {}", group.group, example.name);
                assert_eq!(seen.status, example.status, "{title}: {seen:?}");
                if let Some(body) = &example.body {
                    assert_eq!(&seen.body, body, "{title}");
                }
                for text in &example.includes {
                    assert!(seen.body.contains(text), "{title}: {text} in {}", seen.body);
                }
                for (name, value) in &example.headers {
                    let value = match name.as_str() {
                        "content-type" if typed_by_name && seen.status < 300 => {
                            content_type(&key_of(&example.path, "index.html").unwrap()).to_owned()
                        }
                        _ => value.clone(),
                    };
                    assert_eq!(seen.header(name), Some(value.as_str()), "{title}: {name}");
                }
                for name in &example.present {
                    assert!(seen.header(name).is_some(), "{title}: {name} in {seen:?}");
                }
                for name in &example.absent {
                    assert!(seen.header(name).is_none(), "{title}: no {name} in {seen:?}");
                }
                played += 1;
            }
        }
        played
    }

    /// The table's objects, each kept with its type, as a template's bucket keeps one put with it.
    fn keep_objects(root: &Path) {
        let buckets = buckets(root, table().website, None);
        for (key, stored) in table().objects {
            let mut writing = buckets.store.writing("shop", &key).unwrap();
            writing.write_all(stored.body.as_bytes()).unwrap();
            let object = Object {
                key: key.clone(),
                file: String::new(),
                size: stored.body.len() as u64,
                etag: format!("\"{}\"", crate::md5::hex(stored.body.as_bytes())),
                modified: 1_792_735_200_000,
                headers: vec![("content-type".into(), stored.content_type)],
                parts: Vec::new(),
            };
            buckets.store.keep("shop", writing, object).unwrap();
        }
    }

    #[test]
    fn answers_the_tables_visits_from_the_buckets_objects_as_ffs_site_server_does() {
        let root = tempfile::tempdir().unwrap();
        keep_objects(root.path());

        assert_eq!(play(root.path(), None, false), 23);
    }

    #[test]
    fn answers_the_same_visits_from_a_folder_its_files_typed_and_kept_as_ff_sites_deploy_uploads_them() {
        let (root, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for (key, stored) in table().objects {
            let path = folder.path().join(&key);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, stored.body).unwrap();
        }
        std::fs::write(folder.path().join(".env"), "SECRET=1").unwrap();
        std::fs::create_dir_all(folder.path().join(".well-known")).unwrap();
        std::fs::write(folder.path().join(".well-known/security.txt"), "Contact: x").unwrap();

        assert_eq!(play(root.path(), Some(folder.path()), true), 23);
        let buckets = buckets(root.path(), table().website, Some(folder.path()));
        let page = visit(&buckets, "shop.site.localhost:3700", "GET", "/", &[]);
        assert_eq!(
            [page.header("content-type"), page.header("cache-control")],
            [Some("text/html; charset=utf-8"), Some("no-cache")]
        );
        let hidden = visit(&buckets, "shop.site.localhost", "GET", "/.env", &[]);
        assert_eq!((hidden.status, hidden.body.as_str()), (404, "<title>error page</title>"), "named with a dot first");
        assert_eq!(visit(&buckets, "shop.site.localhost", "GET", "/.well-known/security.txt", &[]).body, "Contact: x");
        for path in ["//etc/passwd", "/a%5C..%5C..%5Cx", "/C:/x", "/docs"] {
            assert_ne!(visit(&buckets, "shop.site.localhost", "GET", path, &[]).status, 200, "{path}");
        }
        assert_eq!(visit(&buckets, "shop.site.localhost", "GET", "/missing", &[]).status, 404);
    }

    #[test]
    fn reads_a_paths_key_as_s3s_website_endpoint_does() {
        let table = table();

        let keys: Vec<String> = table.keys.iter().map(|case| key_of(&case.path, "index.html").unwrap()).collect();
        assert_eq!(keys, table.keys.iter().map(|case| case.key.clone()).collect::<Vec<_>>());
        assert_eq!(key_of("/%E2%82%AC.txt", "index.html").unwrap(), "€.txt");
        assert!(key_of("/%C3", "index.html").is_err(), "an escape that isn't UTF-8");
        assert_eq!(key_of("/a+b", "index.html").unwrap(), "a+b", "a plus is a plus in a path");
    }

    #[test]
    fn answers_get_bucket_website_in_s3s_xml_as_the_backend_does() {
        for case in table().documents {
            assert_eq!(website_xml(&case.website), case.xml, "{}", case.name);
        }
    }

    #[test]
    fn knows_a_sites_host_whatever_bucket_it_names() {
        assert!(is_site(Some("shop.site.localhost:3700")));
        assert!(is_site(Some("Shop.Site.Localhost.")));
        assert!(is_site(Some("site.localhost")));
        assert!(!is_site(Some("shop.localhost:3700")));
        assert!(!is_site(Some("shop.fn.localhost")));
        assert!(!is_site(None));
        assert_eq!(bucket_named(Some("shop.site.localhost:3700")).as_deref(), Some("shop"));
        assert_eq!(bucket_named(Some("a.shop.site.localhost")), None);
        assert_eq!(bucket_named(Some("site.localhost")), None);
    }
}
