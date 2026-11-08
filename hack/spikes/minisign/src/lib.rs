//! minisign's signatures, verified as `minisign -V` verifies them: the file's BLAKE2b-512 signed with Ed25519 by the key
//! whose ID the signature names, then the signature and its trusted comment signed again, so that the comment (the
//! file's name, the time) can't be changed either. Its two formats, from minisign's own documentation:
//!
//! - a public key: `untrusted comment: …`, then base64 of `Ed`, the key's 8-byte ID, its 32-byte Ed25519 key;
//! - a signature: `untrusted comment: …`; base64 of `ED` (prehashed; `Ed`, the legacy format, signed the file itself),
//!   the key's ID, the 64-byte signature; `trusted comment: …`; base64 of the signature of the 64 bytes and the
//!   comment's text.

pub mod blake2b;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::signature::{ED25519, UnparsedPublicKey};
use std::fmt;
use std::io::Read;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// A key or a signature that isn't minisign's: says which part.
    Malformed(&'static str),
    /// A signature in the legacy format, of the file itself: minisign signs a file's hash by default since 0.8.
    Legacy,
    /// Signed by a key other than the one given (their IDs differ).
    OtherKey,
    /// The file isn't the one signed, or the key isn't the one that signed it.
    BadSignature,
    /// The trusted comment isn't the one signed.
    BadComment,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::Malformed(what) => write!(f, "not a minisign {what}"),
            Error::Legacy => {
                write!(f, "a signature in minisign's legacy format, which isn't taken: sign the file's hash")
            }
            Error::OtherKey => write!(f, "signed by another key than the one given"),
            Error::BadSignature => {
                write!(f, "the signature doesn't match the file: it was changed, or another key signed it")
            }
            Error::BadComment => write!(f, "the trusted comment was changed after it was signed"),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    id: [u8; 8],
    key: [u8; 32],
}

impl PublicKey {
    /// A key as `minisign -P` takes it: the base64 line alone.
    pub fn from_base64(line: &str) -> Result<Self, Error> {
        let bytes = STANDARD.decode(line.trim()).map_err(|_| Error::Malformed("public key"))?;
        if bytes.len() != 42 || &bytes[..2] != b"Ed" {
            return Err(Error::Malformed("public key"));
        }
        Ok(PublicKey { id: bytes[2..10].try_into().unwrap(), key: bytes[10..].try_into().unwrap() })
    }

    /// A key as `minisign -G` writes its file: the untrusted comment, then the base64 line.
    pub fn from_file_text(text: &str) -> Result<Self, Error> {
        let mut lines = text.lines();
        match (lines.next(), lines.next()) {
            (Some(comment), Some(line)) if comment.starts_with("untrusted comment: ") => Self::from_base64(line),
            _ => Err(Error::Malformed("public key file")),
        }
    }

    /// The key's ID as minisign prints it: hexadecimal, its bytes in reverse.
    pub fn id(&self) -> String {
        self.id.iter().rev().map(|b| format!("{b:02X}")).collect()
    }
}

/// A signature file, read: what it signs is checked by `verify_digest`.
#[derive(Debug, Clone)]
pub struct Signature {
    key_id: [u8; 8],
    signature: [u8; 64],
    trusted_comment: String,
    comment_signature: [u8; 64],
}

impl Signature {
    pub fn parse(text: &str) -> Result<Self, Error> {
        let lines: Vec<&str> = text.lines().collect();
        let [untrusted, signature, trusted, comment_signature] = lines[..] else {
            return Err(Error::Malformed("signature: four lines"));
        };
        if !untrusted.starts_with("untrusted comment: ") {
            return Err(Error::Malformed("signature: its untrusted comment"));
        }
        let trusted_comment =
            trusted.strip_prefix("trusted comment: ").ok_or(Error::Malformed("signature: its trusted comment"))?;
        let signature = STANDARD.decode(signature.trim()).map_err(|_| Error::Malformed("signature"))?;
        if signature.len() != 74 {
            return Err(Error::Malformed("signature"));
        }
        match &signature[..2] {
            b"ED" => {}
            b"Ed" => return Err(Error::Legacy),
            _ => return Err(Error::Malformed("signature: its algorithm")),
        }
        let comment_signature = STANDARD
            .decode(comment_signature.trim())
            .ok()
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .ok_or(Error::Malformed("signature: its comment's signature"))?;
        Ok(Signature {
            key_id: signature[2..10].try_into().unwrap(),
            signature: signature[10..].try_into().unwrap(),
            trusted_comment: trusted_comment.to_string(),
            comment_signature,
        })
    }

    /// Checks the signature against a file's BLAKE2b-512, then its trusted comment, which it gives back.
    pub fn verify_digest(&self, key: &PublicKey, digest: &[u8; 64]) -> Result<&str, Error> {
        if self.key_id != key.id {
            return Err(Error::OtherKey);
        }
        let ed25519 = UnparsedPublicKey::new(&ED25519, &key.key);
        ed25519.verify(digest, &self.signature).map_err(|_| Error::BadSignature)?;
        let mut signed = self.signature.to_vec();
        signed.extend_from_slice(self.trusted_comment.as_bytes());
        ed25519.verify(&signed, &self.comment_signature).map_err(|_| Error::BadComment)?;
        Ok(&self.trusted_comment)
    }
}

/// Which BLAKE2b computes the prehash: the one written here, or the blake2 crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hasher {
    ByHand,
    #[cfg(feature = "blake2-crate")]
    Crate,
}

/// A file's BLAKE2b-512, read in pieces, as an image's archive of hundreds of MB is: never whole in memory.
pub fn digest_reader(mut reader: impl Read, hasher: Hasher) -> std::io::Result<[u8; 64]> {
    let mut buffer = vec![0u8; 64 * 1024];
    match hasher {
        Hasher::ByHand => {
            let mut state = blake2b::Blake2b512::default();
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    return Ok(state.finalize());
                }
                state.update(&buffer[..read]);
            }
        }
        #[cfg(feature = "blake2-crate")]
        Hasher::Crate => {
            use blake2::Digest;
            let mut state = blake2::Blake2b512::new();
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    return Ok(state.finalize().as_slice().try_into().unwrap());
                }
                state.update(&buffer[..read]);
            }
        }
    }
}

/// A file's signature checked, as `minisign -Vm <file> -x <signature> -P <key>`: the trusted comment when it holds.
pub fn verify(key: &PublicKey, signature: &str, data: &[u8], hasher: Hasher) -> Result<String, Error> {
    let signature = Signature::parse(signature)?;
    let digest = digest_reader(data, hasher).expect("a slice reads without error");
    signature.verify_digest(key, &digest).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Made by run.sh with the minisign hack/install-tools.sh pins (`minisign -G -W`, `minisign -S`), each key's secret
    // half left in hack/.spike-minisign/: two keys, a manifest as the update notice will read one, the same file
    // signed in the legacy format.
    const KEY: &str = include_str!("../fixtures/release.pub");
    const OTHER_KEY: &str = include_str!("../fixtures/other.pub");
    const MANIFEST: &[u8] = include_bytes!("../fixtures/latest.json");
    const SIGNATURE: &str = include_str!("../fixtures/latest.json.minisig");
    const LEGACY: &str = include_str!("../fixtures/latest.json.legacy.minisig");

    fn hashers() -> Vec<Hasher> {
        #[cfg(feature = "blake2-crate")]
        return vec![Hasher::ByHand, Hasher::Crate];
        #[cfg(not(feature = "blake2-crate"))]
        return vec![Hasher::ByHand];
    }

    fn key() -> PublicKey {
        PublicKey::from_file_text(KEY).unwrap()
    }

    #[test]
    fn a_file_minisign_signed_is_taken_with_its_trusted_comment() {
        for hasher in hashers() {
            let comment = verify(&key(), SIGNATURE, MANIFEST, hasher).unwrap();
            assert!(comment.contains("file:latest.json"), "{comment}");
        }
    }

    #[test]
    fn the_keys_id_reads_as_minisign_prints_it() {
        let first_line = KEY.lines().next().unwrap();
        assert_eq!(first_line, format!("untrusted comment: minisign public key {}", key().id()));
    }

    #[test]
    fn a_changed_file_is_refused() {
        let mut changed = MANIFEST.to_vec();
        changed[10] ^= 1;
        for hasher in hashers() {
            assert_eq!(verify(&key(), SIGNATURE, &changed, hasher), Err(Error::BadSignature));
        }
        let mut longer = MANIFEST.to_vec();
        longer.push(b'\n');
        assert_eq!(verify(&key(), SIGNATURE, &longer, Hasher::ByHand), Err(Error::BadSignature));
    }

    #[test]
    fn another_key_is_refused() {
        let other = PublicKey::from_file_text(OTHER_KEY).unwrap();
        assert_eq!(verify(&other, SIGNATURE, MANIFEST, Hasher::ByHand), Err(Error::OtherKey));
        // Another key under the same ID, as a forged key would claim it: the signature itself fails.
        let mut forged = key();
        forged.key = other.key;
        assert_eq!(verify(&forged, SIGNATURE, MANIFEST, Hasher::ByHand), Err(Error::BadSignature));
    }

    #[test]
    fn a_changed_trusted_comment_is_refused() {
        let changed = SIGNATURE.replace("file:latest.json", "file:latest.jsoN");
        assert_ne!(changed, SIGNATURE);
        assert_eq!(verify(&key(), &changed, MANIFEST, Hasher::ByHand), Err(Error::BadComment));
    }

    #[test]
    fn a_cut_signature_is_refused() {
        let lines: Vec<&str> = SIGNATURE.lines().collect();
        let cut_line = format!("{}\n{}\n{}\n{}\n", lines[0], &lines[1][..60], lines[2], lines[3]);
        assert_eq!(verify(&key(), &cut_line, MANIFEST, Hasher::ByHand), Err(Error::Malformed("signature")));
        let three_lines = lines[..3].join("\n");
        assert_eq!(
            verify(&key(), &three_lines, MANIFEST, Hasher::ByHand),
            Err(Error::Malformed("signature: four lines"))
        );
        let cut_comment_signature = format!("{}\n{}\n{}\n{}\n", lines[0], lines[1], lines[2], &lines[3][..40]);
        assert_eq!(
            verify(&key(), &cut_comment_signature, MANIFEST, Hasher::ByHand),
            Err(Error::Malformed("signature: its comment's signature"))
        );
    }

    #[test]
    fn the_legacy_format_is_refused_saying_so() {
        assert_eq!(verify(&key(), LEGACY, MANIFEST, Hasher::ByHand), Err(Error::Legacy));
    }

    #[test]
    fn a_key_that_isnt_minisigns_is_refused() {
        assert_eq!(PublicKey::from_base64("not base64!"), Err(Error::Malformed("public key")));
        let signature_line = SIGNATURE.lines().nth(1).unwrap();
        assert_eq!(PublicKey::from_base64(signature_line), Err(Error::Malformed("public key")));
        assert_eq!(PublicKey::from_file_text(KEY.lines().nth(1).unwrap()), Err(Error::Malformed("public key file")));
    }

    #[test]
    fn windows_line_ends_read_as_unixs() {
        let crlf = SIGNATURE.replace('\n', "\r\n");
        assert!(verify(&key(), &crlf, MANIFEST, Hasher::ByHand).is_ok());
        let key = PublicKey::from_file_text(&KEY.replace('\n', "\r\n")).unwrap();
        assert_eq!(key, self::key());
    }
}
