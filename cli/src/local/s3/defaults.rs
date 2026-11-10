//! S3's reads of a bucket's settings that FF's buckets don't have, answered as S3 answers a bucket that has none
//! (`BE/src/storage/bucket-defaults.ts`), so that a tool reading every one of them, as Terraform's provider does at
//! each plan, reads what is so: no CORS, lifecycle, replication, Object Lock or encryption of its own; versioning,
//! acceleration and logging never turned on; the owner paying for requests, and owning every object, without ACLs.

use super::error::S3Error;
use super::xml::{S3_NAMESPACE, XML_DECLARATION, escape_xml};

/// S3's answer for a bucket without the setting, its owner given: a document, or an error.
type Answer = fn(&str) -> Result<String, S3Error>;

/// Each setting by S3's name for its read, its query parameter, and S3's answer for a bucket without it.
pub const UNSET_SETTINGS: [(&str, &str, Answer); 11] = [
    ("GetBucketAcl", "acl", owner_only_acl),
    ("GetBucketCors", "cors", |_| missing("NoSuchCORSConfiguration", "The CORS configuration does not exist")),
    ("GetBucketVersioning", "versioning", |_| Ok(empty("VersioningConfiguration"))),
    ("GetBucketAccelerateConfiguration", "accelerate", |_| Ok(empty("AccelerateConfiguration"))),
    ("GetBucketRequestPayment", "requestPayment", |_| {
        Ok(format!(
            "{XML_DECLARATION}<RequestPaymentConfiguration xmlns=\"{S3_NAMESPACE}\"><Payer>BucketOwner</Payer></RequestPaymentConfiguration>"
        ))
    }),
    ("GetBucketLogging", "logging", |_| Ok(empty("BucketLoggingStatus"))),
    ("GetBucketLifecycleConfiguration", "lifecycle", |_| {
        missing("NoSuchLifecycleConfiguration", "The lifecycle configuration does not exist")
    }),
    ("GetBucketReplication", "replication", |_| {
        missing("ReplicationConfigurationNotFoundError", "The replication configuration was not found")
    }),
    ("GetBucketEncryption", "encryption", |_| {
        missing(
            "ServerSideEncryptionConfigurationNotFoundError",
            "The server side encryption configuration was not found",
        )
    }),
    ("GetObjectLockConfiguration", "object-lock", |_| {
        missing("ObjectLockConfigurationNotFoundError", "Object Lock configuration does not exist for this bucket")
    }),
    ("GetBucketOwnershipControls", "ownershipControls", |_| {
        Ok(format!(
            "{XML_DECLARATION}<OwnershipControls xmlns=\"{S3_NAMESPACE}\"><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>"
        ))
    }),
];

/// The setting's empty document, as S3 gives one never turned on.
fn empty(root: &str) -> String {
    format!("{XML_DECLARATION}<{root} xmlns=\"{S3_NAMESPACE}\"/>")
}

fn missing(code: &'static str, message: &str) -> Result<String, S3Error> {
    Err(S3Error::new(404, code, message))
}

/// The owner's full control, the one grant of a bucket whose owner owns every object, as S3's are since 2023.
fn owner_only_acl(owner: &str) -> Result<String, S3Error> {
    let id = format!("<ID>{owner}</ID><DisplayName>{owner}</DisplayName>", owner = escape_xml(owner));
    Ok(format!(
        "{XML_DECLARATION}<AccessControlPolicy xmlns=\"{S3_NAMESPACE}\"><Owner>{id}</Owner><AccessControlList>\
         <Grant><Grantee xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"CanonicalUser\">{id}</Grantee><Permission>FULL_CONTROL</Permission></Grant>\
         </AccessControlList></AccessControlPolicy>"
    ))
}

/// S3's answer for a bucket without the setting its read names, when that read is one of these.
pub fn unset_answer(operation: &str, owner: &str) -> Option<Result<String, S3Error>> {
    UNSET_SETTINGS.iter().find(|(name, ..)| *name == operation).map(|(_, _, answer)| answer(owner))
}
