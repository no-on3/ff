//! `ff version`: the version, the commit it was built from, and the platform it was built for,
//! which a bug report needs.

use serde::Serialize;

use crate::error::Error;
use crate::output::Output;

#[derive(Serialize)]
struct Version {
    version: &'static str,
    commit: &'static str,
    target: &'static str,
}

pub fn run(out: &Output) -> Result<(), Error> {
    let version = Version { version: env!("CARGO_PKG_VERSION"), commit: env!("FF_COMMIT"), target: env!("FF_TARGET") };
    out.result(&version, || {
        let text = format!("ff {}", crate::cli::VERSION_TEXT);
        if out.verbose { format!("{text}\nbuilt for {}", version.target) } else { text }
    })
}
