//! S3's XML as FF's front door writes it (`BE/src/storage/xml.ts`): text escaped as the backend escapes it, the
//! documents the front door answers itself, and what it reads of a request's document: a batch of deletes, a multipart
//! upload's parts.

use super::error::{S3Error, malformed_xml};
use crate::s3::{element, unescape};

/// S3's namespace, which its answers declare.
pub const S3_NAMESPACE: &str = "http://s3.amazonaws.com/doc/2006-03-01/";

/// The declaration S3's documents begin with.
pub const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";

/// Text made safe in an XML element or attribute: each of `&<>"'` as its character reference.
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => out.push_str(&format!("&#{};", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

/// A document of S3's namespace: its root element, and what it holds.
pub fn document(root: &str, inner: &str) -> String {
    format!("{XML_DECLARATION}<{root} xmlns=\"{S3_NAMESPACE}\">{inner}</{root}>")
}

/// An element holding text, escaped.
pub fn text_element(name: &str, text: &str) -> String {
    format!("<{name}>{}</{name}>", escape_xml(text))
}

/// ListBuckets' answer: the buckets, each with when it was made, and the account as their owner.
pub fn list_buckets_document(owner: &str, buckets: &[(String, String)], region: &str) -> String {
    let items: String = buckets
        .iter()
        .map(|(name, created_at)| {
            format!(
                "<Bucket>{}<CreationDate>{created_at}</CreationDate>{}</Bucket>",
                text_element("Name", name),
                text_element("BucketRegion", region)
            )
        })
        .collect();
    let owner = format!("{}{}", text_element("ID", owner), text_element("DisplayName", owner));
    document("ListAllMyBucketsResult", &format!("<Owner>{owner}</Owner><Buckets>{items}</Buckets>"))
}

/// GetBucketLocation's answer: the region.
pub fn location_document(region: &str) -> String {
    format!("{XML_DECLARATION}<LocationConstraint xmlns=\"{S3_NAMESPACE}\">{}</LocationConstraint>", escape_xml(region))
}

/// What each `<name>` element of `xml` holds, in order; elements of that name inside them aren't looked for.
pub fn children<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(&format!("<{name}")) {
        let after = &rest[at + name.len() + 1..];
        // `<name>` or `<name attribute="…">`, not `<names>`.
        let Some(open_end) = after.find('>') else { break };
        if !after.starts_with('>') && !after.starts_with(char::is_whitespace) {
            rest = after;
            continue;
        }
        let inner = &after[open_end + 1..];
        let Some(end) = inner.find(&close) else { break };
        found.push(&inner[..end]);
        rest = &inner[end + close.len()..];
    }
    found
}

/// A request's document, its root element as S3 requires: what that element holds; MalformedXML otherwise.
pub fn root<'a>(xml: &'a str, name: &str) -> Result<&'a str, S3Error> {
    children(xml, name).into_iter().next().ok_or_else(malformed_xml)
}

/// The text of an element, its entities decoded: none when it isn't there.
pub fn child_text(xml: &str, name: &str) -> Option<String> {
    element(xml, name).map(|text| text.trim().to_owned()).or_else(|| {
        // An element written empty, `<name/>`, holds the empty text.
        xml.contains(&format!("<{name}/>")).then(String::new)
    })
}

/// A key as a request's document holds it: its entities decoded, nothing trimmed.
pub fn key_text(xml: &str) -> Option<String> {
    let inner = children(xml, "Key").into_iter().next()?;
    Some(unescape(inner))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::local::s3::error::error_document;

    fn documents() -> Value {
        let table: Value = serde_json::from_str(include_str!("../../../../BE/src/storage/s3-examples.json")).unwrap();
        table["documents"].clone()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    #[test]
    fn escapes_text_as_the_backend_does_and_writes_its_error_document() {
        let documents = documents();
        let escaped = &documents["escaped"];
        assert_eq!(escape_xml(text(&escaped["text"])), text(&escaped["xml"]));
        let error = &documents["error"];
        let refusal = S3Error {
            status: error["status"].as_u64().unwrap() as u16,
            code: "NoSuchBucket",
            message: text(&error["message"]).to_owned(),
        };
        assert_eq!(refusal.code, text(&error["code"]));
        assert_eq!(
            error_document(&refusal, text(&error["requestId"]), Some(text(&error["resource"]))),
            text(&error["document"])
        );
    }

    #[test]
    fn writes_list_buckets_and_the_location_as_the_backend_does() {
        let documents = documents();
        let listed = &documents["listBuckets"];
        let buckets: Vec<(String, String)> = listed["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bucket| {
                let at = humantime::parse_rfc3339(text(&bucket["createdAt"])).unwrap();
                (text(&bucket["name"]).to_owned(), humantime::format_rfc3339_millis(at).to_string())
            })
            .collect();
        assert_eq!(
            list_buckets_document(text(&listed["owner"]), &buckets, text(&listed["region"])),
            text(&listed["document"])
        );
        let location = &documents["location"];
        assert_eq!(location_document(text(&location["region"])), text(&location["document"]));
    }

    #[test]
    fn reads_a_requests_document_its_elements_in_order_and_their_text() {
        let xml = "<?xml version=\"1.0\"?><Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Quiet>true</Quiet>\
                   <Object><Key>a &amp; b.txt</Key></Object><Object><Key> spaced </Key><VersionId/></Object><Objects/></Delete>";
        let delete = root(xml, "Delete").unwrap();
        let objects = children(delete, "Object");
        assert_eq!(objects.len(), 2);
        assert_eq!(
            objects.iter().map(|object| key_text(object).unwrap()).collect::<Vec<_>>(),
            ["a & b.txt", " spaced "]
        );
        assert_eq!(child_text(delete, "Quiet").as_deref(), Some("true"));
        assert_eq!(child_text(objects[1], "VersionId").as_deref(), Some(""));
        assert_eq!(root("<Other/>", "Delete").unwrap_err().code, "MalformedXML");
    }
}
