//! The local key: the one access key of a project's app on this machine, which its functions sign with and the front
//! door checks a signed request against, as FF checks its keys. Made at the first start and kept in
//! `.ff/local/credentials`, as AWS's shared credentials file holds a profile, readable by its owner alone, for the
//! shells and tools that read AWS's files.

use std::io;
use std::path::Path;

use crate::config::write_whole;
use crate::error::{Error, Kind};

/// The profile the file names the key in: the one AWS's tools read unless told another.
const PROFILE: &str = "default";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub id: String,
    pub secret: String,
}

impl Key {
    /// A key as FF's keys are: an ID, `AKFF` and 16 of base32's letters, and a secret of 40 of base64's.
    pub fn made() -> Result<Key, Error> {
        const ID: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const SECRET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut random = [0u8; 56];
        getrandom::fill(&mut random)
            .map_err(|error| Error::new(Kind::Failed, format!("No randomness for the local key: {error}")))?;
        let pick = |alphabet: &[u8], bytes: &[u8]| -> String {
            bytes.iter().map(|byte| alphabet[usize::from(*byte) % alphabet.len()] as char).collect()
        };
        Ok(Key { id: format!("AKFF{}", pick(ID, &random[..16])), secret: pick(SECRET, &random[16..]) })
    }

    /// The key the file holds; None when there is no file.
    pub fn read(path: &Path) -> Result<Option<Key>, Error> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(Error::new(Kind::Failed, format!("Couldn't read {}: {error}", path.display())));
            }
        };
        Key::of(&text).map(Some).ok_or_else(|| {
            Error::new(
                Kind::Failed,
                format!(
                    "{} holds no key: no aws_access_key_id and aws_secret_access_key under [{PROFILE}]. Remove it, and ff local start makes another",
                    path.display()
                ),
            )
        })
    }

    /// The key in a credentials file's text, as AWS's tools read it: `name = value` lines under `[default]`.
    fn of(text: &str) -> Option<Key> {
        let (mut id, mut secret, mut section) = (None, None, String::new());
        for line in text.lines().map(str::trim) {
            if let Some(name) = line.strip_prefix('[').and_then(|line| line.strip_suffix(']')) {
                section = name.trim().to_owned();
            } else if let Some((name, value)) = line.split_once('=')
                && section == PROFILE
            {
                let value = Some(value.trim().to_owned()).filter(|value| !value.is_empty());
                match name.trim() {
                    "aws_access_key_id" => id = value,
                    "aws_secret_access_key" => secret = value,
                    _ => {}
                }
            }
        }
        Some(Key { id: id?, secret: secret? })
    }

    /// Written to the file, which its owner alone may read.
    pub fn write(&self, path: &Path) -> Result<(), Error> {
        let text = format!(
            "# ff local's key: its front door takes requests signed with it, and the functions sign with it.\n[{PROFILE}]\naws_access_key_id = {}\naws_secret_access_key = {}\n",
            self.id, self.secret
        );
        write_whole(path, &text, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_made_as_ffs_are_and_kept_where_awss_tools_read_it() {
        let made = Key::made().unwrap();
        assert!(made.id.starts_with("AKFF") && made.id.len() == 20, "{}", made.id);
        assert_eq!(made.secret.len(), 40);
        assert_ne!(Key::made().unwrap(), made);

        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join(".ff/local/credentials");
        assert_eq!(Key::read(&path).unwrap(), None);
        made.write(&path).unwrap();
        assert_eq!(Key::read(&path).unwrap(), Some(made.clone()));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("[default]\naws_access_key_id = {}\n", made.id)), "{text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_files_key_is_read_from_its_default_profile_alone() {
        let key = Key::of(
            "[other]\naws_access_key_id = AKFFOTHER\n\n[default]\n aws_access_key_id=AKFFONE \naws_secret_access_key = s/e+cret\nregion = tn-tunis-1\n",
        );
        assert_eq!(key, Some(Key { id: "AKFFONE".into(), secret: "s/e+cret".into() }));
        assert_eq!(Key::of("[other]\naws_access_key_id = A\naws_secret_access_key = B\n"), None);
        assert_eq!(Key::of("[default]\naws_access_key_id = A\naws_secret_access_key =\n"), None);

        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("credentials");
        std::fs::write(&path, "[default]\n").unwrap();
        let error = Key::read(&path).unwrap_err();
        assert!(error.message.contains("holds no key") && error.message.contains("ff local start makes another"));
    }
}
