//! `ff version`: the version, the commit it was built from, and the platform it was built for,
//! which a bug report needs; and the ID of the release key it trusts, to compare with the downloads
//! site's.

use serde::Serialize;

use crate::error::Error;
use crate::output::Output;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    version: &'static str,
    commit: &'static str,
    target: &'static str,
    /// None in a build without it, as a development build.
    release_key: Option<String>,
}

pub fn run(out: &Output) -> Result<(), Error> {
    let version = Version {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("FF_COMMIT"),
        target: env!("FF_TARGET"),
        release_key: crate::update::release_key_id(),
    };
    out.result(&version, || {
        let text = format!("ff {}", crate::cli::VERSION_TEXT);
        if !out.verbose {
            return text;
        }
        let key = version.release_key.as_deref().unwrap_or("none, in this build: it checks for no newer version");
        format!("{text}\nbuilt for {}\nrelease key {key}", version.target)
    })
}
