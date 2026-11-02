//! `ff package`'s work: a function's folder as a zip for FF, and for AWS Lambda. The folder
//! is copied, never built in place; its libraries are installed into the copy for the runtimes'
//! platform, on this machine or in a container of the runtime's base; what goes in is zipped the
//! same way each time, so that the same folder gives the same SHA-256 and a deploy can say "no
//! changes".

mod ignore;
mod project;
mod zip;

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::cli::Runtime;
use crate::error::{Error, Kind};
use crate::output::Output;
use crate::progress::Progress;
use ignore::{Ignore, is_env_file};
use project::{Build, Libraries};
pub use project::{Project, default_handler, handler_problem};

/// AWS Lambda's limits on a package uploaded directly, which FF's API applies too.
const MAX_ZIP_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_UNPACKED_BYTES: u64 = 250 * 1024 * 1024;
const MAX_FILES: usize = 20_000;

/// What a container build runs in: the runtimes' own bases, which have npm and pip, on the
/// platform the runtimes run on.
const NODE_BUILD_IMAGE: &str = "node:24-trixie-slim";
const PYTHON_BUILD_IMAGE: &str = "python:3.13-slim";
const BUILD_PLATFORM: &str = "linux/amd64";

pub struct Options {
    pub runtime: Option<Runtime>,
    /// The libraries installed in a container of the runtime's base, rather than on this machine.
    pub container: bool,
    /// The folder as it is, its node_modules included: nothing installed.
    pub no_build: bool,
    /// TypeScript compiled by the project's own tsc, its sources left out, for AWS Lambda.
    pub compile: bool,
    /// A file of the folder not to package: the zip being written.
    pub leave_out: Option<PathBuf>,
}

/// A function's package, made.
pub struct Package {
    pub zip: Vec<u8>,
    /// Its SHA-256 in base64, as AWS Lambda's CodeSha256.
    pub code_sha256: String,
    /// Its files' names, sorted: where a handler is looked for.
    pub files: Vec<String>,
    pub unpacked: u64,
    pub runtime: Runtime,
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Kind::Failed, message)
}

/// A folder of the system's temporary one, removed with what it holds when dropped.
struct Staging(PathBuf);

impl Staging {
    fn new() -> Result<Staging, Error> {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random)
            .map_err(|error| failed(format!("No randomness for a temporary folder: {error}")))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("ff-package-{suffix}"));
        std::fs::create_dir(&path).map_err(|error| failed(format!("Couldn't make {}: {error}", path.display())))?;
        // Its own path, links resolved, as the walks compare paths with it.
        match std::fs::canonicalize(&path) {
            Ok(resolved) => Ok(Staging(resolved)),
            Err(error) => {
                let _ = std::fs::remove_dir(&path);
                Err(failed(format!("Couldn't read {}: {error}", path.display())))
            }
        }
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// What a package left out that one may have meant to put in, said once.
#[derive(Default)]
struct LeftOut {
    env_files: Vec<String>,
    links: Vec<String>,
}

/// The file a link leads to, when it is in `root`; a link out of it, to a folder or to nothing
/// leads nowhere a package goes.
fn link_target(link: &Path, root: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(link).ok().filter(|target| target.starts_with(root) && target.is_file())
}

/// A folder's entries, in the order of their names.
fn entries(folder: &Path) -> io::Result<Vec<std::fs::DirEntry>> {
    let mut entries: Vec<_> = std::fs::read_dir(folder)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

/// The folder copied for its build.
struct Copy<'a> {
    /// The folder, its path's links resolved.
    root: &'a Path,
    /// ff's own rules: what `.ffignore` names may be what the build makes the package from.
    rules: Ignore,
    /// The folder's node_modules, which npm installs again.
    skip_node_modules: bool,
    leave_out: Option<PathBuf>,
}

impl Copy<'_> {
    /// `from` into `to`: `.env` files left out, and links but those to a file in the folder,
    /// which is copied.
    fn copy(&self, from: &Path, to: &Path, left_out: &mut LeftOut) -> io::Result<()> {
        for entry in entries(from)? {
            let path = entry.path();
            let name = path.strip_prefix(self.root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let file_type = entry.file_type()?;
            if file_type.is_symlink() && link_target(&path, self.root).is_none() {
                left_out.links.push(name);
            } else if file_type.is_dir() {
                let reinstalled = self.skip_node_modules && name == "node_modules";
                if reinstalled || self.rules.excludes(&name, true) {
                    continue;
                }
                let into = to.join(entry.file_name());
                std::fs::create_dir(&into)?;
                self.copy(&path, &into, left_out)?;
            } else if is_env_file(&entry.file_name().to_string_lossy()) {
                left_out.env_files.push(name);
            } else if !self.rules.excludes(&name, false) && self.leave_out.as_deref() != Some(path.as_path()) {
                // Through a link, its file; with its permissions, the executable bit included.
                std::fs::copy(&path, to.join(entry.file_name()))?;
            }
        }
        Ok(())
    }
}

/// The files of the build's copy, as the zip holds them: '/'-separated names; what the
/// package's rules leave out left out, and once compiled, the TypeScript sources outside
/// node_modules; links followed to their files inside the copy, as npm makes them.
fn collect(
    root: &Path,
    at: &Path,
    rules: &Ignore,
    compiled: bool,
    files: &mut Vec<zip::Entry>,
    links: &mut Vec<String>,
) -> io::Result<()> {
    for entry in entries(at)? {
        let path = entry.path();
        let name = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let file_type = entry.file_type()?;
        let source = if file_type.is_symlink() {
            match link_target(&path, root) {
                Some(target) => target,
                None => {
                    links.push(name);
                    continue;
                }
            }
        } else if file_type.is_dir() {
            if !rules.excludes(&name, true) {
                collect(root, &path, rules, compiled, files, links)?;
            }
            continue;
        } else {
            path
        };
        let typescript = compiled
            && !name.starts_with("node_modules/")
            && [".ts", ".mts", ".cts"].iter().any(|extension| name.ends_with(extension));
        if !rules.excludes(&name, false) && !typescript {
            let executable = is_executable(&std::fs::metadata(&source)?);
            files.push(zip::Entry { name, source, executable });
        }
    }
    Ok(())
}

/// A file of a folder as its package holds it: its name in the zip, '/'-separated, where it is,
/// its size.
pub struct FolderFile {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
}

/// The folder's files as its package holds them before a build: what the package's rules leave
/// out left out, `.env` files too, links followed to the folder's own files.
pub fn folder_files(root: &Path) -> Result<Vec<FolderFile>, Error> {
    let unreadable = |error: io::Error| failed(format!("Couldn't read {}: {error}", root.display()));
    let resolved = std::fs::canonicalize(root).map_err(unreadable)?;
    let mut entries = Vec::new();
    collect(&resolved, &resolved, &Ignore::of(&resolved)?, false, &mut entries, &mut Vec::new()).map_err(unreadable)?;
    Ok(entries
        .into_iter()
        .filter(|entry| !is_env_file(entry.name.rsplit('/').next().unwrap_or_default()))
        .map(|entry| FolderFile {
            size: std::fs::metadata(&entry.source).map_or(0, |metadata| metadata.len()),
            name: entry.name,
            path: entry.source,
        })
        .collect())
}

/// package.json, as JSON, when it reads as such.
fn package_json(root: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(root.join("package.json")).ok().and_then(|text| serde_json::from_str(&text).ok())
}

/// `--compile` runs the project's own TypeScript compiler on its tsconfig.json.
fn check_compile(project: &Project) -> Result<(), Error> {
    if project.runtime != Runtime::Nodejs {
        return Err(Error::usage("--compile is for TypeScript, which runs on Node.js"));
    }
    let typescript = package_json(&project.root).is_some_and(|package| {
        ["/devDependencies/typescript", "/dependencies/typescript"].iter().any(|at| package.pointer(at).is_some())
    });
    if project.libraries != Libraries::Npm || !typescript {
        return Err(Error::usage(
            "--compile runs the project's own TypeScript compiler: add typescript to its package.json's devDependencies",
        ));
    }
    if !project.root.join("tsconfig.json").is_file() {
        return Err(Error::usage(format!(
            "--compile runs tsc on the project's tsconfig.json, which {} hasn't",
            project.root.display()
        )));
    }
    Ok(())
}

/// The last lines a failed step wrote, for its error.
fn tail(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

/// Runs a step of the build: its error says what it was doing, what it wrote last, and when
/// its program isn't there, what to install.
fn run(mut command: Command, doing: &str, missing: &str, out: &Output) -> Result<(), Error> {
    let progress = Progress::start(out, doing);
    let output = command.stdin(Stdio::null()).output();
    progress.stop();
    let output = output.map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => failed(format!("{doing}: {missing}")),
        _ => failed(format!("{doing}: {error}")),
    })?;
    if !output.status.success() {
        let said =
            [tail(&output.stderr), tail(&output.stdout)].into_iter().find(|text| !text.is_empty()).unwrap_or_default();
        return Err(failed(format!("{doing} failed ({}):\n{said}", output.status)));
    }
    if let Some(skipped) = skipped_scripts(&String::from_utf8_lossy(&output.stderr)) {
        out.warn(&skipped);
    }
    Ok(())
}

/// npm's notice of the dependencies' install scripts it didn't run, as the folder's package.json
/// doesn't allow them (`allowScripts`, which npm 11.19 reads), said again: ff shows what npm
/// writes only when it fails, and a library that builds itself when installed may not work.
fn skipped_scripts(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr
        .lines()
        .filter_map(|line| line.strip_prefix("npm warn install-scripts"))
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    // The packages are the indented lines, between npm's count of them and its advice.
    let packages: Vec<&str> = lines.iter().filter(|line| line.starts_with("  ")).map(|line| line.trim()).collect();
    if packages.is_empty() {
        return Some(format!("npm: {}", lines.iter().map(|line| line.trim()).collect::<Vec<_>>().join("\n")));
    }
    Some(format!(
        "npm didn't run the install scripts of {}, which the folder's package.json doesn't allow (allowScripts): a library that builds itself when installed may not work; `npm install-scripts approve <package>` in the folder allows one",
        packages.join(", ")
    ))
}

/// Runs the build's steps in the copy: here, or in a container of the runtime's base, the copy
/// mounted, as this user, so that what it writes stays this user's.
fn run_steps(
    project: &Project,
    steps: &[Vec<String>],
    staging: &Path,
    container: bool,
    out: &Output,
) -> Result<(), Error> {
    if container {
        let image = match project.runtime {
            Runtime::Nodejs => NODE_BUILD_IMAGE,
            Runtime::Python => PYTHON_BUILD_IMAGE,
        };
        let script = steps.iter().map(|step| step.join(" ")).collect::<Vec<_>>().join(" && ");
        let mut command = Command::new("docker");
        command.args(["run", "--rm", "--platform", BUILD_PLATFORM, "-v"]);
        command.arg(format!("{}:/build", staging.display())).args(["-w", "/build", "-e", "HOME=/tmp"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let owner = std::fs::metadata(staging)
                .map_err(|error| failed(format!("Couldn't read {}: {error}", staging.display())))?;
            command.arg("--user").arg(format!("{}:{}", owner.uid(), owner.gid()));
        }
        command.args([image, "sh", "-c", &script]);
        let missing = "Docker isn't installed here, or isn't on the PATH: --container builds in it";
        return run(command, &format!("installing the libraries in {image}"), missing, out);
    }
    for step in steps {
        let mut command = Command::new(&step[0]);
        command.args(&step[1..]).current_dir(staging);
        let missing = match step[0].as_str() {
            "python3" => {
                "Python 3 isn't installed here, or isn't on the PATH: install it, with pip, or package with --container, which needs Docker"
            }
            _ => {
                "Node.js and npm aren't installed here, or aren't on the PATH: install them, or package with --container, which needs Docker"
            }
        };
        run(command, &format!("running {}", step.join(" ")), missing, out).map_err(|mut error| {
            if step[0] == "python3" && error.message.contains("No matching distribution") {
                error.message.push_str(
                    "\nHere pip takes wheels for Linux x86_64 alone: a library published as source alone needs --container",
                );
            }
            error
        })?;
    }
    Ok(())
}

/// A file's path with its folder's links resolved, whether or not the file is there yet.
fn resolved(file: &Path) -> Option<PathBuf> {
    let name = file.file_name()?;
    let folder = match file.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    Some(std::fs::canonicalize(folder).ok()?.join(name))
}

/// The function in `root` as a package: copied, its libraries installed, zipped, within
/// Lambda's limits. Warns about what it left out that one may have meant to put in.
pub fn build(root: &Path, options: &Options, out: &Output) -> Result<Package, Error> {
    let project = Project::detect(root, options.runtime)?;
    if options.compile {
        check_compile(&project)?;
    }
    let rules = Ignore::of(root)?;
    let building = !options.no_build && project.libraries != Libraries::None;
    let native = cfg!(all(target_os = "linux", target_arch = "x86_64"));
    if building && !options.container && project.libraries == Libraries::Npm && !native {
        out.warn(&format!(
            "npm installs libraries for this machine, {}-{}: FF runs them on Linux x86_64, where a library with native code needs --container",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }

    let root =
        std::fs::canonicalize(root).map_err(|error| failed(format!("Couldn't read {}: {error}", root.display())))?;
    let staging = Staging::new()?;
    let mut left_out = LeftOut::default();
    let copy = Copy {
        root: &root,
        rules: Ignore::always(),
        skip_node_modules: building && project.libraries == Libraries::Npm,
        leave_out: options.leave_out.as_deref().and_then(resolved),
    };
    copy.copy(&root, &staging.0, &mut left_out)
        .map_err(|error| failed(format!("Couldn't copy {}: {error}", root.display())))?;
    if !left_out.env_files.is_empty() {
        out.warn(&format!(
            "not packaged: {}, which usually hold secrets: `ff secrets set` gives a function its secrets",
            left_out.env_files.join(", ")
        ));
    }

    if building {
        let requirements = staging.0.join("requirements.txt");
        if let Libraries::Pyproject(dependencies) = &project.libraries {
            std::fs::write(&requirements, dependencies.join("\n") + "\n")
                .map_err(|error| failed(format!("Couldn't write pyproject.toml's dependencies for pip: {error}")))?;
        }
        let build = Build {
            lockfile: root.join("package-lock.json").is_file() || root.join("npm-shrinkwrap.json").is_file(),
            build_script: package_json(&root).is_some_and(|package| package.pointer("/scripts/build").is_some()),
            compile: options.compile,
            container: options.container,
        };
        run_steps(&project, &project::build_steps(&project, build), &staging.0, options.container, out)?;
        if matches!(project.libraries, Libraries::Pyproject(_)) {
            // pip's list, which the folder hasn't: the package is its files and their libraries.
            let _ = std::fs::remove_file(&requirements);
        }
    }

    let mut entries = Vec::new();
    collect(&staging.0, &staging.0, &rules, options.compile, &mut entries, &mut left_out.links)
        .map_err(|error| failed(format!("Couldn't read the build's copy: {error}")))?;
    if !left_out.links.is_empty() {
        left_out.links.sort();
        out.warn(&format!(
            "not packaged: {} link(s) out of the package, to a folder or to nothing, such as {}",
            left_out.links.len(),
            left_out.links[0]
        ));
    }
    if entries.is_empty() {
        return Err(Error::usage(format!("{} has no file to package", root.display())));
    }
    if entries.len() > MAX_FILES {
        return Err(Error::usage(format!("The package has {} files: 20,000 at most, as FF takes one", entries.len())));
    }
    let mut unpacked = 0;
    for entry in &entries {
        unpacked += std::fs::metadata(&entry.source).map(|metadata| metadata.len()).unwrap_or(0);
    }
    if unpacked > MAX_UNPACKED_BYTES {
        return Err(Error::usage(format!(
            "The package is {unpacked} bytes unpacked: 250 MB (262,144,000 bytes) at most, as AWS Lambda takes one"
        )));
    }
    let mut files: Vec<String> = entries.iter().map(|entry| entry.name.clone()).collect();
    files.sort();
    let progress = Progress::start(out, &format!("zipping {} files", files.len()));
    let zip = zip::write(entries);
    progress.stop();
    let zip = zip.map_err(|error| failed(format!("Couldn't zip the package: {error}")))?;
    if zip.len() as u64 > MAX_ZIP_BYTES {
        return Err(Error::usage(format!(
            "The package's zip is {} bytes: 50 MB (52,428,800 bytes) at most, as AWS Lambda takes one uploaded directly",
            zip.len()
        )));
    }
    let code_sha256 = STANDARD.encode(ring::digest::digest(&ring::digest::SHA256, &zip));
    Ok(Package { zip, code_sha256, files, unpacked, runtime: project.runtime })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    const AS_IT_IS: Options =
        Options { runtime: None, container: false, no_build: true, compile: false, leave_out: None };

    #[test]
    fn packages_a_folder_the_same_twice_leaving_out_secrets_version_control_and_what_ffignore_names() {
        let packaged = [
            ("index.js", "exports.handler = async () => require('./lib/greet')('FF');\n"),
            ("lib/greet.js", "module.exports = (name) => `Hello ${name}`;\n"),
            ("node_modules/ms/index.js", "module.exports = () => 1;\n"),
            ("package.json", "{}"),
        ];
        let left_out = [
            (".env", "DB_PASSWORD=hunter2\n"),
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("test/greet.test.js", "test()\n"),
            (".ffignore", "test/\n"),
            (".ff/orders.zip", "PK"),
        ];
        let dir = folder(&[&packaged[..], &left_out[..]].concat());

        let first = build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap();
        let again = build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap();

        assert_eq!(first.files, packaged.map(|(name, _)| name));
        assert_eq!(first.unpacked, packaged.iter().map(|(_, text)| text.len() as u64).sum::<u64>());
        assert_eq!(first.runtime, Runtime::Nodejs);
        assert_eq!(first.zip, again.zip);
        assert_eq!(first.code_sha256, STANDARD.encode(ring::digest::digest(&ring::digest::SHA256, &first.zip)));
    }

    #[test]
    fn leaves_out_the_zip_being_written_into_the_folder() {
        let dir = folder(&[("index.js", "exports.handler = 1;\n"), ("orders.zip", "PK")]);
        let options = Options { leave_out: Some(dir.path().join("orders.zip")), ..AS_IT_IS };

        assert_eq!(build(dir.path(), &options, &Output::quiet()).unwrap().files, ["index.js"]);
        assert_eq!(build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap().files, ["index.js", "orders.zip"]);
    }

    #[cfg(unix)]
    #[test]
    fn follows_links_to_files_inside_the_package_and_leaves_out_the_others() {
        let dir = folder(&[("index.js", "exports.handler = 1;\n"), ("lib/real.js", "x\n")]);
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret"), "hunter2").unwrap();
        std::os::unix::fs::symlink("lib/real.js", dir.path().join("alias.js")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("leak")).unwrap();
        std::os::unix::fs::symlink("lib", dir.path().join("lib-again")).unwrap();
        std::os::unix::fs::symlink("gone.js", dir.path().join("broken.js")).unwrap();

        let package = build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap();

        assert_eq!(package.files, ["alias.js", "index.js", "lib/real.js"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_what_runs_runnable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = folder(&[("index.js", "exports.handler = 1;\n"), ("bin/tool", "#!/bin/sh\n")]);
        std::fs::set_permissions(dir.path().join("bin/tool"), std::fs::Permissions::from_mode(0o755)).unwrap();

        let package = build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap();

        // The central directory's external attributes for bin/tool, its first entry: 0o100755 << 16.
        let directory = package.zip.windows(4).position(|window| window == [0x50, 0x4b, 0x01, 0x02]).unwrap();
        let attributes = u32::from_le_bytes(package.zip[directory + 38..directory + 42].try_into().unwrap());
        assert_eq!(attributes >> 16, 0o100755);
    }

    #[test]
    fn ffignore_leaves_files_out_of_the_package_not_out_of_the_build() {
        let dir =
            folder(&[("index.js", "exports.handler = 1;\n"), ("src/app.ts", "export {}\n"), (".ffignore", "src/\n")]);
        let staging = Staging::new().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let copy = Copy { root: &root, rules: Ignore::always(), skip_node_modules: false, leave_out: None };

        copy.copy(&root, &staging.0, &mut LeftOut::default()).unwrap();

        assert!(staging.0.join("src/app.ts").is_file(), "the build reads it");
        assert_eq!(build(dir.path(), &AS_IT_IS, &Output::quiet()).unwrap().files, ["index.js"]);
    }

    #[test]
    fn compiles_only_a_project_with_its_own_typescript_and_tsconfig() {
        let refusal = |files: &[(&str, &str)]| {
            let dir = folder(files);
            let options = Options { compile: true, no_build: false, ..AS_IT_IS };
            build(dir.path(), &options, &Output::quiet()).map(|_| ()).unwrap_err().message
        };
        let no_typescript = "--compile runs the project's own TypeScript compiler: add typescript to its package.json's devDependencies";

        assert_eq!(refusal(&[("app.py", "")]), "--compile is for TypeScript, which runs on Node.js");
        assert_eq!(refusal(&[("index.ts", "")]), no_typescript);
        assert_eq!(refusal(&[("index.ts", ""), ("package.json", r#"{"devDependencies": {}}"#)]), no_typescript);
        let no_tsconfig =
            refusal(&[("index.ts", ""), ("package.json", r#"{"devDependencies": {"typescript": "6.0.3"}}"#)]);
        assert!(
            no_tsconfig.starts_with("--compile runs tsc on the project's tsconfig.json, which ")
                && no_tsconfig.ends_with(" hasn't"),
            "{no_tsconfig}"
        );
    }

    #[test]
    fn says_again_which_install_scripts_npm_didnt_run() {
        let npm = "npm warn deprecated inflight@1.0.6: This module is not supported\n\
            npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:\n\
            npm warn install-scripts   bcrypt@6.0.0 (install: node-gyp-build)\n\
            npm warn install-scripts   esbuild@0.25.0 (postinstall: node install.js)\n\
            npm warn install-scripts\n\
            npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.\n";

        assert_eq!(
            skipped_scripts(npm).unwrap(),
            "npm didn't run the install scripts of bcrypt@6.0.0 (install: node-gyp-build), esbuild@0.25.0 (postinstall: node install.js), which the folder's package.json doesn't allow (allowScripts): a library that builds itself when installed may not work; `npm install-scripts approve <package>` in the folder allows one"
        );
        assert_eq!(skipped_scripts("npm warn deprecated inflight@1.0.6\nadded 3 packages in 229ms\n"), None);
        // Said another way by another npm: its lines as they are.
        assert_eq!(
            skipped_scripts("npm warn install-scripts some scripts were skipped\n").unwrap(),
            "npm: some scripts were skipped"
        );
    }

    #[test]
    fn says_so_when_there_is_nothing_to_package() {
        let dir = folder(&[(".env", "A=1\n")]);

        let error = build(dir.path(), &Options { runtime: Some(Runtime::Nodejs), ..AS_IT_IS }, &Output::quiet())
            .map(|_| ())
            .unwrap_err();
        assert!(error.message.ends_with("has no file to package"), "{}", error.message);
    }
}
