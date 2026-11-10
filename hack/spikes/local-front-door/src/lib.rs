//! The spike's front doors, S3's and SQS's, as `ff local` would serve them: the backend's checks ported, its tables
//! read by the tests.
pub mod checksums;
pub mod chunked;
pub mod http;
pub mod md5;
pub mod s3;
pub mod sigv4;
pub mod sqs;
pub mod time;

use ring::rand::{SecureRandom, SystemRandom};

/// The one access key the front doors take, as `ff local` would make one for a run.
#[derive(Clone)]
pub struct Key {
    pub id: String,
    pub secret: String,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    SystemRandom::new().fill(&mut bytes).expect("the system's random numbers");
    bytes
}

/// `count` random bytes in hex.
pub fn random_hex(count: usize) -> String {
    (0..count).map(|_| format!("{:02x}", random_bytes::<1>()[0])).collect()
}

/// An S3 request's ID, as S3's: 16 upper-case hex digits.
pub fn request_id() -> String {
    md5::hex(&random_bytes::<8>()).to_uppercase()
}

/// A random UUID (version 4), as SQS's message and request IDs are.
pub fn uuid() -> String {
    let mut bytes = random_bytes::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = md5::hex(&bytes);
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}
