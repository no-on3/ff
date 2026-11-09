//! minisign's signatures, verified as `minisign -V` verifies them: the file's BLAKE2b-512 signed with Ed25519 by the key
//! whose ID the signature names, then the signature and its trusted comment signed again, so that the comment (the
//! file's name, the time) can't be changed either. Ed25519 is `ring`'s, which ff has for TLS already; BLAKE2b is
//! written here (ADR 0018). Its two formats, from minisign's own documentation:
//!
//! - a public key: `untrusted comment: …`, then base64 of `Ed`, the key's 8-byte ID, its 32-byte Ed25519 key;
//! - a signature: `untrusted comment: …`; base64 of `ED` (prehashed; `Ed`, the legacy format, signed the file itself),
//!   the key's ID, the 64-byte signature; `trusted comment: …`; base64 of the signature of the 64 bytes and the
//!   comment's text.
//!
//! Windows's line ends read as Unix's, as a file saved through PowerShell has them.

mod blake2b;

use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::signature::{ED25519, UnparsedPublicKey};

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
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

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Refusal::Malformed(what) => write!(f, "not a minisign {what}"),
            Refusal::Legacy => {
                write!(f, "a signature in minisign's legacy format, which isn't taken: sign the file's hash")
            }
            Refusal::OtherKey => write!(f, "signed by another key than the one given"),
            Refusal::BadSignature => {
                write!(f, "the signature doesn't match the file: it was changed, or another key signed it")
            }
            Refusal::BadComment => write!(f, "the trusted comment was changed after it was signed"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    id: [u8; 8],
    key: [u8; 32],
}

impl PublicKey {
    /// A key as `minisign -P` takes it: the base64 line alone.
    pub fn from_base64(line: &str) -> Result<Self, Refusal> {
        let bytes = STANDARD.decode(line.trim()).map_err(|_| Refusal::Malformed("public key"))?;
        if bytes.len() != 42 || &bytes[..2] != b"Ed" {
            return Err(Refusal::Malformed("public key"));
        }
        Ok(PublicKey { id: bytes[2..10].try_into().expect("8 bytes"), key: bytes[10..].try_into().expect("32 bytes") })
    }

    /// The key's ID as minisign prints it: hexadecimal, its bytes in reverse.
    pub fn id(&self) -> String {
        self.id.iter().rev().map(|b| format!("{b:02X}")).collect()
    }
}

/// A signature file, read: what it signs is checked by `verify`.
#[derive(Debug, Clone)]
struct Signature {
    key_id: [u8; 8],
    signature: [u8; 64],
    trusted_comment: String,
    comment_signature: [u8; 64],
}

impl Signature {
    fn parse(text: &str) -> Result<Self, Refusal> {
        let lines: Vec<&str> = text.lines().collect();
        let [untrusted, signature, trusted, comment_signature] = lines[..] else {
            return Err(Refusal::Malformed("signature: four lines"));
        };
        if !untrusted.starts_with("untrusted comment: ") {
            return Err(Refusal::Malformed("signature: its untrusted comment"));
        }
        let trusted_comment =
            trusted.strip_prefix("trusted comment: ").ok_or(Refusal::Malformed("signature: its trusted comment"))?;
        let signature = STANDARD.decode(signature.trim()).map_err(|_| Refusal::Malformed("signature"))?;
        if signature.len() != 74 {
            return Err(Refusal::Malformed("signature"));
        }
        match &signature[..2] {
            b"ED" => {}
            b"Ed" => return Err(Refusal::Legacy),
            _ => return Err(Refusal::Malformed("signature: its algorithm")),
        }
        let comment_signature = STANDARD
            .decode(comment_signature.trim())
            .ok()
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .ok_or(Refusal::Malformed("signature: its comment's signature"))?;
        Ok(Signature {
            key_id: signature[2..10].try_into().expect("8 bytes"),
            signature: signature[10..].try_into().expect("64 bytes"),
            trusted_comment: trusted_comment.to_owned(),
            comment_signature,
        })
    }
}

/// A file's signature checked, as `minisign -Vm <file> -x <signature> -P <key>`: the trusted comment when it holds.
pub fn verify(key: &PublicKey, signature: &str, data: &[u8]) -> Result<String, Refusal> {
    let signature = Signature::parse(signature)?;
    if signature.key_id != key.id {
        return Err(Refusal::OtherKey);
    }
    let ed25519 = UnparsedPublicKey::new(&ED25519, &key.key);
    ed25519.verify(&blake2b::digest(data), &signature.signature).map_err(|_| Refusal::BadSignature)?;
    let mut signed = signature.signature.to_vec();
    signed.extend_from_slice(signature.trusted_comment.as_bytes());
    ed25519.verify(&signed, &signature.comment_signature).map_err(|_| Refusal::BadComment)?;
    Ok(signature.trusted_comment)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Made by the minisign hack/install-tools.sh pins (`minisign -G -W`, `minisign -S`, and `-l` for the legacy
    // format), the keys' secret halves thrown away: two keys, a manifest as the update notice reads one.
    const KEY: &str = include_str!("fixtures/release.pub");
    const OTHER_KEY: &str = include_str!("fixtures/other.pub");
    const MANIFEST: &[u8] = include_bytes!("fixtures/latest.json");
    const SIGNATURE: &str = include_str!("fixtures/latest.json.minisig");
    const LEGACY: &str = include_str!("fixtures/latest.json.legacy.minisig");

    /// A key as `minisign -G` writes its file: the untrusted comment, then the base64 line.
    fn key_of(text: &str) -> PublicKey {
        let mut lines = text.lines();
        assert!(lines.next().unwrap().starts_with("untrusted comment: "));
        PublicKey::from_base64(lines.next().unwrap()).unwrap()
    }

    fn key() -> PublicKey {
        key_of(KEY)
    }

    #[test]
    fn a_file_minisign_signed_is_taken_with_its_trusted_comment() {
        let comment = verify(&key(), SIGNATURE, MANIFEST).unwrap();
        assert!(comment.starts_with("timestamp:") && comment.ends_with("\tfile:latest.json\thashed"), "{comment}");
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
        assert_eq!(verify(&key(), SIGNATURE, &changed), Err(Refusal::BadSignature));
        let mut longer = MANIFEST.to_vec();
        longer.push(b'\n');
        assert_eq!(verify(&key(), SIGNATURE, &longer), Err(Refusal::BadSignature));
    }

    #[test]
    fn another_key_is_refused() {
        let other = key_of(OTHER_KEY);
        assert_eq!(verify(&other, SIGNATURE, MANIFEST), Err(Refusal::OtherKey));
        // Another key under the same ID, as a forged key would claim it: the signature itself fails.
        let forged = PublicKey { key: other.key, ..key() };
        assert_eq!(verify(&forged, SIGNATURE, MANIFEST), Err(Refusal::BadSignature));
    }

    #[test]
    fn a_changed_trusted_comment_is_refused() {
        let changed = SIGNATURE.replace("file:latest.json", "file:latest.jsoN");
        assert_ne!(changed, SIGNATURE);
        assert_eq!(verify(&key(), &changed, MANIFEST), Err(Refusal::BadComment));
    }

    #[test]
    fn a_cut_signature_is_refused() {
        let lines: Vec<&str> = SIGNATURE.lines().collect();
        let cut_line = format!("{}\n{}\n{}\n{}\n", lines[0], &lines[1][..60], lines[2], lines[3]);
        assert_eq!(verify(&key(), &cut_line, MANIFEST), Err(Refusal::Malformed("signature")));
        let three_lines = lines[..3].join("\n");
        assert_eq!(verify(&key(), &three_lines, MANIFEST), Err(Refusal::Malformed("signature: four lines")));
        let cut_comment_signature = format!("{}\n{}\n{}\n{}\n", lines[0], lines[1], lines[2], &lines[3][..40]);
        assert_eq!(
            verify(&key(), &cut_comment_signature, MANIFEST),
            Err(Refusal::Malformed("signature: its comment's signature"))
        );
    }

    #[test]
    fn the_legacy_format_is_refused_saying_so() {
        assert_eq!(verify(&key(), LEGACY, MANIFEST), Err(Refusal::Legacy));
    }

    #[test]
    fn a_key_that_isnt_minisigns_is_refused() {
        assert_eq!(PublicKey::from_base64("not base64!"), Err(Refusal::Malformed("public key")));
        let signature_line = SIGNATURE.lines().nth(1).unwrap();
        assert_eq!(PublicKey::from_base64(signature_line), Err(Refusal::Malformed("public key")));
    }

    #[test]
    fn windows_line_ends_read_as_unixs() {
        let crlf = SIGNATURE.replace('\n', "\r\n");
        assert_eq!(verify(&key(), &crlf, MANIFEST), verify(&key(), SIGNATURE, MANIFEST));
        assert_eq!(key_of(&KEY.replace('\n', "\r\n")), key());
    }
}
