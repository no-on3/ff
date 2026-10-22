//! Embeds the commit the binary is built from, for `ff version`: `FF_BUILD_COMMIT` when the build
//! sets it (a container without git), else git's `HEAD`, else "unknown"; and the target it runs on.

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
