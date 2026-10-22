//! `ff package [folder]`: a function's folder as a zip with its libraries, as AWS Lambda takes
//! one, written to the folder's `.ff/` unless named; `ff deploy <folder>` makes the same zip.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::Context;
use crate::cli::PackageArgs;
use crate::error::{Error, Kind};
use crate::package::{self, Options, Package};

/// A size as the console says it: bytes, KB or MB, by thousands.
pub fn size(bytes: u64) -> String {
    match bytes {
        0..1000 => format!("{bytes} bytes"),
        1000..1_000_000 => format!("{:.1} KB", bytes as f64 / 1000.0),
        _ => format!("{:.1} MB", bytes as f64 / 1_000_000.0),
    }
}

/// A folder's name, its path's links and dots resolved: `.` is the folder it names.
pub fn folder_name(folder: &Path) -> Result<String, Error> {
    let resolved = std::fs::canonicalize(folder)
        .map_err(|error| Error::new(Kind::Usage, format!("Couldn't read {}: {error}", folder.display())))?;
    if !resolved.is_dir() {
        return Err(Error::new(Kind::Usage, format!("{} isn't a folder", folder.display())));
    }
    Ok(resolved.file_name().and_then(|name| name.to_str()).unwrap_or("function").to_owned())
}

/// The handler: the one named, checked against the package's files, or the one its files say.
pub fn handler_of(package: &Package, named: Option<&str>) -> Result<Option<String>, Error> {
    match named {
        Some(handler) => match package::handler_problem(&package.files, handler, package.runtime) {
            Some(problem) => Err(Error::new(Kind::Usage, format!("{problem}: name another with --handler"))),
            None => Ok(Some(handler.to_owned())),
        },
        None => Ok(package::default_handler(&package.files, package.runtime)),
    }
}

/// Writes the zip, making its folder; ff's `.ff/` gets a `.gitignore`, as what it holds is made.
fn write(zip: &Path, bytes: &[u8]) -> Result<(), Error> {
    let failed = |error: std::io::Error| Error::new(Kind::Failed, format!("Couldn't write {}: {error}", zip.display()));
    if let Some(folder) = zip.parent().filter(|folder| !folder.as_os_str().is_empty()) {
        let made = !folder.exists();
        std::fs::create_dir_all(folder).map_err(failed)?;
        if made && folder.file_name().is_some_and(|name| name == ".ff") {
            std::fs::write(folder.join(".gitignore"), "# ff's own: the zips ff package makes\n*\n").map_err(failed)?;
        }
    }
    std::fs::write(zip, bytes).map_err(failed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Packaged<'a> {
    zip: PathBuf,
    runtime: &'a str,
    /// None when the files say none and none was named.
    handler: Option<String>,
    code_sha256: &'a str,
    code_size: u64,
    unpacked_size: u64,
    file_count: usize,
}

pub fn run(args: PackageArgs, context: &Context) -> Result<(), Error> {
    let name = folder_name(&args.folder)?;
    let zip = args.zip.unwrap_or_else(|| args.folder.join(".ff").join(format!("{name}.zip")));
    let options = Options {
        runtime: args.runtime,
        container: args.build.container,
        no_build: args.build.no_build,
        compile: args.compile,
        leave_out: Some(zip.clone()),
    };
    let package = package::build(&args.folder, &options, context.out)?;
    let handler = handler_of(&package, args.handler.as_deref())?;
    write(&zip, &package.zip)?;

    let packaged = Packaged {
        zip,
        runtime: package.runtime.as_str(),
        handler,
        code_sha256: &package.code_sha256,
        code_size: package.zip.len() as u64,
        unpacked_size: package.unpacked,
        file_count: package.files.len(),
    };
    context.out.result(&packaged, || {
        format!(
            "packaged {} as {}: {}, {} files, {} ({} unpacked)\nhandler: {}\nSHA-256: {}",
            args.folder.display(),
            packaged.zip.display(),
            packaged.runtime,
            packaged.file_count,
            size(packaged.code_size),
            size(packaged.unpacked_size),
            packaged
                .handler
                .as_deref()
                .unwrap_or("none of its files is ff's or AWS Lambda's default: --handler names it"),
            packaged.code_sha256
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_sizes_as_the_console_does() {
        assert_eq!(
            [size(41), size(999), size(1000), size(4_400_000), size(52_428_800)],
            ["41 bytes", "999 bytes", "1.0 KB", "4.4 MB", "52.4 MB"]
        );
    }

    #[test]
    fn a_folder_is_named_by_its_path_resolved_and_must_be_there() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("orders-api")).unwrap();

        assert_eq!(folder_name(&dir.path().join("orders-api/.")).unwrap(), "orders-api");
        assert_eq!(folder_name(&dir.path().join("orders-api/sub/..")).map_err(|error| error.kind), Err(Kind::Usage));
    }
}
