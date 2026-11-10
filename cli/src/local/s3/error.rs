//! S3's errors as FF's front door gives them (`BE/src/storage/s3-error.ts`): a status, a code and a message, which
//! AWS's SDKs and CLI read from the XML error document.

use super::checksums::Algorithm;
use super::xml::{XML_DECLARATION, escape_xml};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct S3Error {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl S3Error {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }
}

pub fn access_denied(message: &str) -> S3Error {
    S3Error::new(403, "AccessDenied", message)
}

pub fn invalid_access_key_id() -> S3Error {
    S3Error::new(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.")
}

pub fn signature_mismatch() -> S3Error {
    S3Error::new(
        403,
        "SignatureDoesNotMatch",
        "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
    )
}

pub fn malformed_authorization(detail: &str) -> S3Error {
    S3Error::new(400, "AuthorizationHeaderMalformed", format!("The authorization header is malformed; {detail}"))
}

pub fn malformed_query_authorization(detail: &str) -> S3Error {
    S3Error::new(400, "AuthorizationQueryParametersError", detail)
}

pub fn invalid_request(message: &str) -> S3Error {
    S3Error::new(400, "InvalidRequest", message)
}

pub fn no_such_bucket() -> S3Error {
    S3Error::new(404, "NoSuchBucket", "The specified bucket does not exist")
}

pub fn no_such_key() -> S3Error {
    S3Error::new(404, "NoSuchKey", "The specified key does not exist.")
}

pub fn no_such_upload() -> S3Error {
    S3Error::new(
        404,
        "NoSuchUpload",
        "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
    )
}

/// S3's answer to what it doesn't do, in its words.
pub fn not_implemented() -> S3Error {
    not_implemented_because("A header you provided implies functionality that is not implemented")
}

/// What isn't done, in FF's words, saying why.
pub fn not_implemented_because(message: &str) -> S3Error {
    S3Error::new(501, "NotImplemented", message)
}

pub fn invalid_argument(message: &str) -> S3Error {
    S3Error::new(400, "InvalidArgument", message)
}

pub fn malformed_xml() -> S3Error {
    S3Error::new(
        400,
        "MalformedXML",
        "The XML you provided was not well-formed or did not validate against our published schema",
    )
}

/// The body ended before its length, or its framing is wrong: `None` says the first, in S3's words.
pub fn incomplete_body(message: Option<&str>) -> S3Error {
    let message =
        message.unwrap_or("You did not provide the number of bytes specified by the Content-Length HTTP header.");
    S3Error::new(400, "IncompleteBody", message)
}

pub fn bad_digest(algorithm: Algorithm) -> S3Error {
    S3Error::new(
        400,
        "BadDigest",
        format!("The {} you specified did not match the calculated checksum.", algorithm.name().to_uppercase()),
    )
}

pub fn internal_error() -> S3Error {
    S3Error::new(500, "InternalError", "We encountered an internal error. Please try again.")
}

/// S3's error document: its code and message, the resource asked for, and the request's ID.
pub fn error_document(error: &S3Error, request_id: &str, resource: Option<&str>) -> String {
    let resource =
        resource.map(|resource| format!("<Resource>{}</Resource>", escape_xml(resource))).unwrap_or_default();
    format!(
        "{XML_DECLARATION}<Error><Code>{}</Code><Message>{}</Message>{resource}<RequestId>{}</RequestId></Error>",
        escape_xml(error.code),
        escape_xml(&error.message),
        escape_xml(request_id)
    )
}
