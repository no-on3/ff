//! FF's downloads site, as a release names it, and the release's public key, which signs what the site serves: the
//! update notice reads `latest.json` there, and `ff local` a runtime image's archive when Docker can't pull the image.

use std::io::{Read, Write};
use std::time::Duration;

use crate::api::agent_config;
use crate::minisign::PublicKey;

/// The time a large file's answer may take to begin; its body then takes what it takes.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);

/// The site and the key that signs what it serves.
pub struct Source {
    pub site: String,
    pub key: PublicKey,
}

impl Source {
    /// The site `FF_DOWNLOADS_URL` names, else the one the release's build was given (`FF_BUILD_DOWNLOADS_URL`); the
    /// release's public key, built in from `cli/release/minisign.pub`, which a test build takes from
    /// `FF_TEST_RELEASE_KEY`, as `ff`'s tests and the `ff` suite's build do.
    pub fn find(env: &dyn Fn(&str) -> Option<String>) -> Option<Source> {
        let built = |value: &'static str| Some(value.to_owned()).filter(|value| !value.is_empty());
        let tests_key = if cfg!(debug_assertions) { env("FF_TEST_RELEASE_KEY") } else { None };
        Source::of(
            env("FF_DOWNLOADS_URL").or_else(|| built(env!("FF_BUILT_DOWNLOADS_URL"))),
            tests_key.or_else(|| built(env!("FF_BUILT_RELEASE_KEY"))),
        )
    }

    /// The site and the key, when both are known and the key is minisign's.
    pub fn of(site: Option<String>, key: Option<String>) -> Option<Source> {
        Some(Source { site: site?.trim_end_matches('/').to_owned(), key: PublicKey::from_base64(&key?).ok()? })
    }

    pub fn url(&self, name: &str) -> String {
        format!("{}/{name}", self.site)
    }

    /// A small file of the site, `largest` bytes at most, all of it within `timeout`.
    pub fn fetch(&self, name: &str, largest: u64, timeout: Duration) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        self.get(name, Some(timeout), &mut body, largest)?;
        Ok(body)
    }

    /// A file of the site written to `to` as it comes, `largest` bytes at most: its size.
    pub fn download(&self, name: &str, to: &mut dyn Write, largest: u64) -> Result<u64, String> {
        self.get(name, None, to, largest)
    }

    fn get(&self, name: &str, timeout: Option<Duration>, to: &mut dyn Write, largest: u64) -> Result<u64, String> {
        let url = self.url(name);
        let agent: ureq::Agent =
            agent_config().timeout_global(timeout).timeout_recv_response(Some(ANSWER_TIMEOUT)).build().into();
        let mut response = agent.get(&url).call().map_err(|error| format!("{url}: {error}"))?;
        if response.status() != 200 {
            return Err(format!("{url} answered {}", response.status()));
        }
        let mut body = response.body_mut().as_reader().take(largest);
        std::io::copy(&mut body, to).map_err(|error| format!("{url}: {error}"))
    }

    /// The line that installs the newest release on this system.
    pub fn install_line(&self) -> String {
        if cfg!(windows) {
            format!("irm {} | iex", self.url("install.ps1"))
        } else {
            format!("curl -fsSL {} | sh", self.url("install.sh"))
        }
    }
}

/// The ID of the release's public key built in, as minisign prints it: none in a build without it.
pub fn release_key_id() -> Option<String> {
    PublicKey::from_base64(env!("FF_BUILT_RELEASE_KEY")).ok().map(|key| key.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_and_a_key_both_known_or_none() {
        let key = || Some(include_str!("minisign/fixtures/release.pub").lines().nth(1).unwrap().to_owned());
        let site = || Some("https://get.ff.example/".to_owned());
        assert!(Source::of(None, key()).is_none());
        assert!(Source::of(site(), None).is_none());
        assert!(Source::of(site(), Some("not a key".into())).is_none());
        let source = Source::of(site(), key()).unwrap();
        assert_eq!(source.url("latest.json"), "https://get.ff.example/latest.json");
        let line = source.install_line();
        if cfg!(windows) {
            assert_eq!(line, "irm https://get.ff.example/install.ps1 | iex");
        } else {
            assert_eq!(line, "curl -fsSL https://get.ff.example/install.sh | sh");
        }
    }
}
