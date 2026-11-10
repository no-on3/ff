//! The update notice (ADR 0018): once a day at most, after a command that reached the API and succeeded, ff reads the
//! downloads site's `latest.json` and its signature, verifies it against the release's public key built into ff, and
//! says on stderr when a newer version is out, with the line that installs it. A `latest.json` signed before the last
//! one verified is ignored, by its trusted comment's time, so that an old one served again can't hide a newer release.
//! What it finds never fails the command; `--verbose` says what went wrong.
//!
//! It is off with `FF_NO_UPDATE_CHECK` or `ff config set update_check false` (the setting), never shown with
//! `--output json` or `--quiet`, and off where ff keeps no folder of settings, as in a CI given `FF_TOKEN` alone, since
//! the check's time is kept there. A build that knows no site or no key, as a development build, never checks.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::cli::Format;
use crate::config::Settings;
use crate::downloads::Source;
use crate::minisign;
use crate::output::Output;

const DAY: u64 = 24 * 60 * 60;
/// The check's two downloads, together: a site slower than this is skipped, and asked again a day later.
const TIMEOUT: Duration = Duration::from_secs(4);
/// More than `latest.json` and its signature ever weigh, a few hundred bytes each.
const LARGEST: u64 = 64 * 1024;
/// The file the check's time and its last findings are kept in, in ff's folder.
const STATE_FILE: &str = "update-check.json";

/// After a command that succeeded: the notice, when a check is due and finds a newer version.
pub fn after_command(out: &Output, settings: &Settings) {
    if out.quiet || out.format == Format::Json || !settings.update_check.value || !settings.files.dir.is_dir() {
        return;
    }
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let Some(source) = Source::find(&env) else { return };
    let path = settings.files.dir.join(STATE_FILE);
    let mut state = State::read(&path);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
    if !state.due(now) {
        return;
    }
    state.checked_at = now;
    let found = latest(&source, state.signed_at);
    match &found {
        Ok(latest) => {
            state.signed_at = latest.signed_at;
            state.latest = Some(latest.version.clone());
        }
        Err(why) => out.detail(&format!("the update check: {why}")),
    }
    if let Err(why) = state.write(&path) {
        out.detail(&format!("the update check: {} couldn't be written: {why}", path.display()));
    }
    if let Ok(latest) = found
        && is_newer(&latest.version, env!("CARGO_PKG_VERSION"))
    {
        out.notice(&format!(
            "ff {} is out, and this one is {}: {}",
            latest.version,
            env!("CARGO_PKG_VERSION"),
            source.install_line()
        ));
    }
}

/// The site's `latest.json`, verified, and signed no earlier than `signed_at`: both downloads within `TIMEOUT`.
fn latest(source: &Source, signed_at: u64) -> Result<Latest, String> {
    let deadline = Instant::now() + TIMEOUT;
    let fetch = |name: &str| source.fetch(name, LARGEST, deadline.saturating_duration_since(Instant::now()));
    let manifest = fetch("latest.json")?;
    let signature =
        String::from_utf8(fetch("latest.json.minisig")?).map_err(|_| "latest.json.minisig isn't text".to_owned())?;
    let comment = minisign::verify(&source.key, &signature, &manifest)
        .map_err(|refusal| format!("latest.json's signature: {refusal}"))?;
    let signed = signing_time(&comment).ok_or_else(|| format!("latest.json's trusted comment, {comment:?}"))?;
    if signed < signed_at {
        return Err(format!(
            "latest.json was signed at {signed}, before the last one verified, at {signed_at}: an old one, ignored"
        ));
    }
    let version = serde_json::from_slice::<Manifest>(&manifest)
        .map_err(|error| format!("latest.json isn't the manifest expected: {error}"))?
        .version;
    Ok(Latest { version, signed_at: signed })
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
}

struct Latest {
    version: String,
    /// When it was signed, from its trusted comment.
    signed_at: u64,
}

/// The signing time minisign's default trusted comment holds, `timestamp:<seconds>\tfile:latest.json\thashed`, for
/// a `latest.json` alone: another file's signature, served beside it, isn't taken.
fn signing_time(comment: &str) -> Option<u64> {
    if !minisign::names_file(comment, "latest.json") {
        return None;
    }
    comment.split('\t').find_map(|field| field.strip_prefix("timestamp:")).and_then(|time| time.parse().ok())
}

/// Whether `latest`, `<major>.<minor>.<patch>`, is a newer version than `current`; nothing else is.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |version: &str| -> Option<(u64, u64, u64)> {
        let mut parts = version.split('.').map(|part| part.parse::<u64>().ok());
        let parsed = (parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(parsed)
    };
    matches!((parse(latest), parse(current)), (Some(latest), Some(current)) if latest > current)
}

/// What the last check found, kept in ff's folder.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct State {
    /// When the site was last asked, in seconds since 1970.
    checked_at: u64,
    /// When the last `latest.json` verified was signed: one signed before it is ignored.
    signed_at: u64,
    /// The version it named.
    latest: Option<String>,
}

impl State {
    /// The file's, or none for one that isn't there or can't be read: a check is then due.
    fn read(path: &Path) -> State {
        fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// A day after the last check, or at once when the clock went back before it.
    fn due(&self, now: u64) -> bool {
        now < self.checked_at || now - self.checked_at >= DAY
    }

    /// Written whole, through a file next to it renamed over it.
    fn write(&self, path: &Path) -> std::io::Result<()> {
        let temporary = path.with_extension("json.new");
        fs::write(&temporary, serde_json::to_vec_pretty(self).expect("the state serializes"))?;
        fs::rename(&temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_version_is_one_of_three_numbers_greater_in_order() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        for odd in ["0.2", "0.2.0.1", "0.2.0-rc.1", "v0.2.0", ""] {
            assert!(!is_newer(odd, "0.1.0"), "{odd}");
        }
    }

    #[test]
    fn the_signing_time_is_a_latest_jsons_alone() {
        assert_eq!(signing_time("timestamp:1794172983\tfile:latest.json\thashed"), Some(1794172983));
        assert_eq!(signing_time("timestamp:1794172983\tfile:ff-linux-x86_64\thashed"), None);
        assert_eq!(signing_time("file:latest.json\thashed"), None);
        assert_eq!(signing_time("timestamp:soon\tfile:latest.json"), None);
    }

    #[test]
    fn a_check_is_due_a_day_after_the_last_and_when_the_clock_went_back() {
        let state = State { checked_at: 1_000_000, ..State::default() };
        assert!(!state.due(1_000_000));
        assert!(!state.due(1_000_000 + DAY - 1));
        assert!(state.due(1_000_000 + DAY));
        assert!(state.due(999_999));
        // Never checked: due at any time since.
        assert!(State::default().due(1_800_000_000));
    }

    #[test]
    fn the_state_is_kept_and_read_back_and_none_is_a_check_due() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(STATE_FILE);
        assert_eq!(State::read(&path), State::default());
        let state = State { checked_at: 5, signed_at: 4, latest: Some("0.2.0".into()) };
        state.write(&path).unwrap();
        assert_eq!(State::read(&path), state);
        fs::write(&path, "not JSON").unwrap();
        assert_eq!(State::read(&path), State::default());
    }
}
