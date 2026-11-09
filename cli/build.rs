//! Embeds the commit the binary is built from, for `ff version`: `FF_BUILD_COMMIT` when the build
//! sets it (a container without git), else git's `HEAD`, else "unknown"; and the target it runs on.
//! For the update notice: the release's public key, `release/minisign.pub`'s key line, once the
//! file is there; and the downloads site, `FF_BUILD_DOWNLOADS_URL` as the release's build is given
//! it (a name of its own, so that the address a developer gives ff at run time is never built in).
//! Either empty, ff never checks for a newer version.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim().to_owned()).filter(|text| !text.is_empty())
}

fn main() {
    let commit = std::env::var("FF_BUILD_COMMIT")
        .ok()
        .filter(|commit| !commit.is_empty())
        .or_else(|| git(&["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=FF_COMMIT={commit}");
    println!("cargo:rustc-env=FF_TARGET={}", std::env::var("TARGET").expect("cargo sets TARGET"));
    println!("cargo:rerun-if-env-changed=FF_BUILD_COMMIT");

    let key = std::fs::read_to_string("release/minisign.pub")
        .ok()
        .and_then(|text| text.lines().nth(1).map(|line| line.trim().to_owned()))
        .unwrap_or_default();
    println!("cargo:rustc-env=FF_BUILT_RELEASE_KEY={key}");
    // The folder, which is there, rather than the file, which may not be: cargo runs again when a file in it changes.
    println!("cargo:rerun-if-changed=release");
    let site = std::env::var("FF_BUILD_DOWNLOADS_URL").unwrap_or_default();
    println!("cargo:rustc-env=FF_BUILT_DOWNLOADS_URL={site}");
    println!("cargo:rerun-if-env-changed=FF_BUILD_DOWNLOADS_URL");
    println!("cargo:rerun-if-changed=build.rs");

    // Built again when HEAD moves: a checkout changes HEAD, a commit the branch's ref.
    if let Some(git_dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        println!("cargo:rerun-if-changed={git_dir}/packed-refs");
        if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={git_dir}/{reference}");
        }
    }
}
