//! The checksums S3 checks uploads against, as AWS's SDKs send them: CRC-32 (crc32fast, which ff has), CRC-32C and
//! CRC-64/NVME (written here, a table each), SHA-1 and SHA-256 (ring). Each in base64, as S3 carries it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::digest;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Crc32,
    Crc32c,
    Crc64Nvme,
    Sha1,
    Sha256,
}

pub const ALGORITHMS: [Algorithm; 5] =
    [Algorithm::Crc32, Algorithm::Crc32c, Algorithm::Crc64Nvme, Algorithm::Sha1, Algorithm::Sha256];

impl Algorithm {
    /// By S3's name for it, as in x-amz-checksum-<name>.
    pub fn named(name: &str) -> Option<Self> {
        ALGORITHMS.into_iter().find(|algorithm| algorithm.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Crc32 => "crc32",
            Self::Crc32c => "crc32c",
            Self::Crc64Nvme => "crc64nvme",
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
        }
    }
}

/// A reflected CRC's table, for a polynomial in its reflected form.
const fn crc_table(polynomial: u64) -> [u64; 256] {
    let mut table = [0; 256];
    let mut byte = 0;
    while byte < 256 {
        let mut crc = byte as u64;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ polynomial } else { crc >> 1 };
            bit += 1;
        }
        table[byte] = crc;
        byte += 1;
    }
    table
}

/// CRC-32C (Castagnoli), reflected: 0x1EDC6F41 reversed.
const CRC32C: [u64; 256] = crc_table(0x82F6_3B78);
/// CRC-64/NVME, reflected: 0xAD93D23594C93659 reversed.
const CRC64_NVME: [u64; 256] = crc_table(0x9A6C_9329_AC4B_C9B5);

fn crc_update(table: &[u64; 256], mut crc: u64, data: &[u8]) -> u64 {
    for &byte in data {
        crc = table[((crc ^ byte as u64) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

enum State {
    Crc32(crc32fast::Hasher),
    Crc32c(u32),
    Crc64Nvme(u64),
    Digest(Box<digest::Context>),
}

/// A checksum computed as the body streams.
pub struct Running {
    state: State,
}

impl Running {
    pub fn new(algorithm: Algorithm) -> Self {
        let state = match algorithm {
            Algorithm::Crc32 => State::Crc32(crc32fast::Hasher::new()),
            Algorithm::Crc32c => State::Crc32c(!0),
            Algorithm::Crc64Nvme => State::Crc64Nvme(!0),
            Algorithm::Sha1 => State::Digest(Box::new(digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY))),
            Algorithm::Sha256 => State::Digest(Box::new(digest::Context::new(&digest::SHA256))),
        };
        Self { state }
    }

    pub fn update(&mut self, data: &[u8]) {
        match &mut self.state {
            State::Crc32(hasher) => hasher.update(data),
            State::Crc32c(crc) => *crc = crc_update(&CRC32C, *crc as u64, data) as u32,
            State::Crc64Nvme(crc) => *crc = crc_update(&CRC64_NVME, *crc, data),
            State::Digest(context) => context.update(data),
        }
    }

    /// The checksum's bytes, big-endian for the CRCs, as S3 encodes them.
    pub fn finish(self) -> Vec<u8> {
        match self.state {
            State::Crc32(hasher) => hasher.finalize().to_be_bytes().to_vec(),
            State::Crc32c(crc) => (!crc).to_be_bytes().to_vec(),
            State::Crc64Nvme(crc) => (!crc).to_be_bytes().to_vec(),
            State::Digest(context) => context.finish().as_ref().to_vec(),
        }
    }

    pub fn finish_base64(self) -> String {
        STANDARD.encode(self.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::md5::hex;
    use serde_json::Value;

    /// The check values and AWS's examples, the table the backend's tests read (BE/src/storage).
    fn table() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../BE/src/storage/checksum-check-values.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn each_gives_the_backends_check_value_the_input_in_any_pieces() {
        let table = table();
        let input = table["checkInput"].as_str().unwrap().as_bytes();
        let values = table["checkValues"].as_object().unwrap();
        assert_eq!(values.len(), ALGORITHMS.len());
        for (name, expected) in values {
            let algorithm = Algorithm::named(name).unwrap();
            for size in [1, 2, 7, input.len()] {
                let mut running = Running::new(algorithm);
                input.chunks(size).for_each(|piece| running.update(piece));
                assert_eq!(hex(&running.finish()), expected.as_str().unwrap(), "{name}, pieces of {size}");
            }
        }
    }

    #[test]
    fn gives_awss_examples_in_base64() {
        for example in table()["examples"].as_array().unwrap() {
            let mut running = Running::new(Algorithm::named(example["algorithm"].as_str().unwrap()).unwrap());
            let byte = example["byte"].as_str().unwrap().as_bytes()[0];
            running.update(&vec![byte; example["length"].as_u64().unwrap() as usize]);
            assert_eq!(running.finish_base64(), example["base64"].as_str().unwrap(), "{}", example["title"]);
        }
    }
}
