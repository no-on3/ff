//! The runtime images `ff local` runs functions in. A release's build pins its two by digest, in the manifest the
//! release job made and built into it (`FF_BUILD_RUNTIME_IMAGES`): for each runtime, the image on its registry
//! (`ghcr.io`), the release's tag of it, its digest there, and its archive on the downloads site, which the release's
//! key signs. `ff local` runs the tag when this machine has it; else pulls the digest and gives it the tag; else, when
//! Docker can't pull it (no registry reached, a company's mirror alone), downloads the archive, verifies its
//! signature, and loads it, which gives the tag too. `FF_RUNTIME_IMAGE_NODEJS` and `FF_RUNTIME_IMAGE_PYTHON` name
//! another image, as a repository's own build; a build without a manifest runs the repository's tags, which
//! `docker build` makes from `runtimes/`.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Output as Ran;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli::Runtime;
use crate::downloads::Source;
use crate::error::{Error, Kind};
use crate::local::{self, NODEJS_IMAGE, PYTHON_IMAGE, stderr_of};
use crate::minisign::{self, Hasher, PublicKey};
use crate::output::Output;
use crate::progress::Progress;

/// More than an image's archive ever weighs; a site sending more is cut there, and the signature then refuses it.
const LARGEST_ARCHIVE: u64 = 4 << 30;
/// More than a signature ever weighs.
const LARGEST_SIGNATURE: u64 = 4096;
const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(30);

/// A release's image of a runtime.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Pinned {
    /// The image's repository, `ghcr.io/<owner>/ff-runtime-nodejs`.
    pub image: String,
    /// The release's tag of it, which `ff local` gives it on this machine too.
    pub tag: String,
    /// Its manifest's digest on the registry, `sha256:<64 hexadecimal digits>`.
    pub digest: String,
    /// Its archive's path on the downloads site, `images/<file>.tar.gz`, its signature beside it.
    pub archive: String,
}

impl Pinned {
    pub fn tagged(&self) -> String {
        format!("{}:{}", self.image, self.tag)
    }

    pub fn by_digest(&self) -> String {
        format!("{}@{}", self.image, self.digest)
    }

    /// The archive's file name, which its signature's trusted comment must name.
    fn archive_file(&self) -> &str {
        self.archive.rsplit('/').next().unwrap_or(&self.archive)
    }

    /// What Docker and the site are given is the manifest's: a name, a digest, a path of the site, nothing else.
    fn check(&self) -> Result<(), String> {
        let name = |text: &str| {
            !text.is_empty()
                && !text.starts_with(['-', '.', '/'])
                && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/:".contains(&b))
        };
        let hex = self.digest.strip_prefix("sha256:").unwrap_or("");
        if !name(&self.image) || self.tag.contains(['/', ':']) || !name(&self.tag) {
            return Err(format!("{:?}:{:?} isn't an image's name and tag", self.image, self.tag));
        }
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err(format!("{:?} isn't a sha256 digest", self.digest));
        }
        if !name(&self.archive) || self.archive.split('/').any(|part| part.is_empty() || part == "..") {
            return Err(format!("{:?} isn't a path of the downloads site", self.archive));
        }
        Ok(())
    }
}

/// Which image runs a runtime's functions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// The one `FF_RUNTIME_IMAGE_<runtime>` names, as it is.
    Named(String),
    /// The repository's own build, in a build without a manifest.
    Repository(&'static str),
    /// The release's, pinned.
    Pinned(Pinned),
}

/// The runtime's image, on this machine once this returns, chosen by the environment `ff` runs in.
pub fn for_runtime(runtime: Runtime, out: &Output) -> Result<String, Error> {
    let env = |name: &str| std::env::var(name).ok();
    ready(&choose(runtime, &env)?, Source::find(&env).as_ref(), out, &local::docker)
}

pub fn choose(runtime: Runtime, env: &dyn Fn(&str) -> Option<String>) -> Result<Choice, Error> {
    let (variable, repository) = match runtime {
        Runtime::Nodejs => ("FF_RUNTIME_IMAGE_NODEJS", NODEJS_IMAGE),
        Runtime::Python => ("FF_RUNTIME_IMAGE_PYTHON", PYTHON_IMAGE),
    };
    if let Some(image) = env(variable).filter(|image| !image.is_empty()) {
        return Ok(Choice::Named(image));
    }
    Ok(match manifest(env)?.and_then(|mut pinned| pinned.remove(runtime.as_str())) {
        Some(pinned) => Choice::Pinned(pinned),
        None => Choice::Repository(repository),
    })
}

/// The release's images, by runtime: the manifest built in, or, in a test build, `FF_TEST_RUNTIME_IMAGES`'s.
pub fn manifest(env: &dyn Fn(&str) -> Option<String>) -> Result<Option<BTreeMap<String, Pinned>>, Error> {
    let tests = if cfg!(debug_assertions) { env("FF_TEST_RUNTIME_IMAGES") } else { None };
    let Some(text) = tests.or_else(|| Some(env!("FF_BUILT_RUNTIME_IMAGES").to_owned())).filter(|text| !text.is_empty())
    else {
        return Ok(None);
    };
    let broken =
        |why: String| Error::new(Kind::Failed, format!("This build's manifest of runtime images is broken: {why}"));
    let pinned: BTreeMap<String, Pinned> = serde_json::from_str(&text).map_err(|error| broken(error.to_string()))?;
    for image in pinned.values() {
        image.check().map_err(broken)?;
    }
    Ok(Some(pinned))
}

/// Runs docker with its arguments: `local::docker`, or the tests' stand-in.
pub type Docker<'a> = &'a dyn Fn(&[String]) -> Result<Ran, Error>;

fn args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

fn on_this_machine(docker: Docker, image: &str) -> Result<bool, Error> {
    Ok(docker(&args(&["image", "inspect", "--format", "{{.Id}}", image]))?.status.success())
}

/// The image to run, on this machine once this returns.
pub fn ready(choice: &Choice, source: Option<&Source>, out: &Output, docker: Docker) -> Result<String, Error> {
    let (image, why) = match choice {
        Choice::Pinned(pinned) => return pinned_ready(pinned, source, out, docker),
        Choice::Named(image) => (image.as_str(), "named by FF_RUNTIME_IMAGE_NODEJS or FF_RUNTIME_IMAGE_PYTHON"),
        Choice::Repository(image) => (*image, "this build's own, as it pins no release's"),
    };
    if !on_this_machine(docker, image)? {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "The runtime image {image}, {why}, isn't on this machine: build it from FF's repository (docker build -t {image} runtimes/<runtime>), or name another with FF_RUNTIME_IMAGE_NODEJS or FF_RUNTIME_IMAGE_PYTHON"
            ),
        ));
    }
    Ok(image.to_owned())
}

/// The release's image: here already, pulled by its digest, or loaded from its archive, verified.
fn pinned_ready(pinned: &Pinned, source: Option<&Source>, out: &Output, docker: Docker) -> Result<String, Error> {
    let tagged = pinned.tagged();
    if on_this_machine(docker, &tagged)? {
        return Ok(tagged);
    }
    let progress = Progress::start(out, &format!("pulling the runtime image {}", pinned.by_digest()));
    let pulled = docker(&args(&["pull", "--quiet", &pinned.by_digest()]))?;
    progress.stop();
    if pulled.status.success() {
        let tag = docker(&args(&["tag", &pinned.by_digest(), &tagged]))?;
        if !tag.status.success() {
            return Err(Error::new(Kind::Failed, format!("Docker couldn't tag {tagged}: {}", stderr_of(&tag))));
        }
        return Ok(tagged);
    }
    let pull_failed = format!("Docker couldn't pull the runtime image {} ({})", pinned.by_digest(), stderr_of(&pulled));
    let Some(source) = source else {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "{pull_failed}, and this build knows no downloads site to load its archive from: give FF_DOWNLOADS_URL"
            ),
        ));
    };
    out.warn(&format!("{pull_failed}: its archive instead, from {}", source.url(&pinned.archive)));
    load_archive(pinned, source, out, docker)?;
    if !on_this_machine(docker, &tagged)? {
        return Err(Error::new(
            Kind::Failed,
            format!("The archive {} was loaded, but it held no {tagged}", source.url(&pinned.archive)),
        ));
    }
    Ok(tagged)
}

/// The archive downloaded into a file of its own, verified, then loaded; the file removed however it ends.
fn load_archive(pinned: &Pinned, source: &Source, out: &Output, docker: Docker) -> Result<(), Error> {
    let url = source.url(&pinned.archive);
    let failed = |why: String| Error::new(Kind::Failed, format!("The runtime image's archive, {url}: {why}"));
    let file = Removed(std::env::temp_dir().join(format!("ff-{}-{}", std::process::id(), pinned.archive_file())));
    let mut written = Hashing {
        file: File::create_new(&file.0).map_err(|error| failed(error.to_string()))?,
        hasher: Hasher::default(),
    };
    let progress = Progress::start(out, &format!("downloading {url}"));
    let downloaded = source.download(&pinned.archive, &mut written, LARGEST_ARCHIVE);
    progress.stop();
    downloaded.map_err(failed)?;
    written.file.flush().map_err(|error| failed(error.to_string()))?;
    let signature = source
        .fetch(&format!("{}.minisig", pinned.archive), LARGEST_SIGNATURE, SIGNATURE_TIMEOUT)
        .map_err(|why| failed(format!("its signature: {why}")))?;
    verified(&source.key, &signature, written.hasher.finalize(), pinned.archive_file())
        .map_err(|why| failed(format!("{why}; nothing was loaded")))?;
    let progress = Progress::start(out, &format!("loading {}", pinned.tagged()));
    let loaded = docker(&args(&["load", "--quiet", "--input", &file.0.to_string_lossy()]))?;
    progress.stop();
    if !loaded.status.success() {
        return Err(failed(format!("Docker couldn't load it: {}", stderr_of(&loaded))));
    }
    Ok(())
}

/// That the release's key signed the file of that name with that BLAKE2b-512.
fn verified(key: &PublicKey, signature: &[u8], digest: [u8; 64], file: &str) -> Result<(), String> {
    let signature = std::str::from_utf8(signature).map_err(|_| "its signature isn't text".to_owned())?;
    let comment =
        minisign::verify_prehashed(key, signature, &digest).map_err(|refusal| format!("its signature: {refusal}"))?;
    if !minisign::names_file(&comment, file) {
        return Err(format!("its signature is another file's, by its trusted comment, {comment:?}"));
    }
    Ok(())
}

/// A file being written, its BLAKE2b-512 made of the same bytes.
struct Hashing {
    file: File,
    hasher: Hasher,
}

impl Write for Hashing {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let written = self.file.write(data)?;
        self.hasher.update(&data[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// A path whose file is removed when this goes.
struct Removed(PathBuf);

impl Drop for Removed {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::process::ExitStatus;

    use super::*;

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn pinned() -> Pinned {
        Pinned {
            image: "ghcr.io/ff/ff-runtime-python".into(),
            tag: "3.13-v3-ff-0.2.0".into(),
            digest: DIGEST.into(),
            archive: "images/ff-runtime-python-3.13-v3-ff-0.2.0.tar.gz".into(),
        }
    }

    fn env_of(pairs: &[(&str, String)]) -> impl Fn(&str) -> Option<String> + use<> {
        let pairs: Vec<(String, String)> =
            pairs.iter().map(|(name, value)| ((*name).to_owned(), value.clone())).collect();
        move |name| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

    fn manifest_of(pinned: &Pinned) -> String {
        serde_json::json!({ "python": pinned }).to_string()
    }

    #[cfg(unix)]
    fn status(ok: bool) -> ExitStatus {
        std::os::unix::process::ExitStatusExt::from_raw(if ok { 0 } else { 256 })
    }

    #[cfg(windows)]
    fn status(ok: bool) -> ExitStatus {
        std::os::windows::process::ExitStatusExt::from_raw(if ok { 0 } else { 1 })
    }

    /// A stand-in for docker: each command's success by its first two words, every command kept.
    struct Stand {
        ran: RefCell<Vec<String>>,
        succeeds: fn(&str) -> bool,
    }

    impl Stand {
        fn new(succeeds: fn(&str) -> bool) -> Stand {
            Stand { ran: RefCell::new(Vec::new()), succeeds }
        }

        fn run(&self, args: &[String]) -> Result<Ran, Error> {
            let line = args.join(" ");
            self.ran.borrow_mut().push(line.clone());
            let ok = (self.succeeds)(&line);
            Ok(Ran {
                status: status(ok),
                stdout: Vec::new(),
                stderr: if ok { Vec::new() } else { b"refused here".to_vec() },
            })
        }
    }

    #[test]
    fn the_variable_then_the_release_then_the_repository() {
        let pinned = pinned();
        let named =
            env_of(&[("FF_RUNTIME_IMAGE_PYTHON", "mine:1".into()), ("FF_TEST_RUNTIME_IMAGES", manifest_of(&pinned))]);
        assert_eq!(choose(Runtime::Python, &named).unwrap(), Choice::Named("mine:1".into()));
        let released = env_of(&[("FF_TEST_RUNTIME_IMAGES", manifest_of(&pinned))]);
        assert_eq!(choose(Runtime::Python, &released).unwrap(), Choice::Pinned(pinned));
        assert_eq!(choose(Runtime::Nodejs, &released).unwrap(), Choice::Repository(NODEJS_IMAGE));
        assert_eq!(choose(Runtime::Python, &env_of(&[])).unwrap(), Choice::Repository(PYTHON_IMAGE));
    }

    #[test]
    fn a_manifest_holds_names_digests_and_paths_alone() {
        let refused = |change: fn(&mut Pinned)| {
            let mut pinned = pinned();
            change(&mut pinned);
            let env = env_of(&[("FF_TEST_RUNTIME_IMAGES", manifest_of(&pinned))]);
            choose(Runtime::Python, &env).unwrap_err().message
        };
        assert!(refused(|pinned| pinned.image = "--privileged".into()).contains("isn't an image's name"));
        assert!(refused(|pinned| pinned.tag = "3.13:v3".into()).contains("isn't an image's name"));
        assert!(refused(|pinned| pinned.digest = "sha256:0123".into()).contains("isn't a sha256 digest"));
        assert!(refused(|pinned| pinned.digest = DIGEST.to_uppercase().replace("SHA256", "sha256")).contains("digest"));
        assert!(refused(|pinned| pinned.archive = "images/../../etc/passwd".into()).contains("isn't a path"));
        assert!(refused(|pinned| pinned.archive = "/images/a.tar.gz".into()).contains("isn't a path"));
        let env = env_of(&[("FF_TEST_RUNTIME_IMAGES", "{\"python\": 1}".into())]);
        assert!(
            choose(Runtime::Python, &env)
                .unwrap_err()
                .message
                .starts_with("This build's manifest of runtime images is broken")
        );
    }

    #[test]
    fn the_release_tag_here_already_is_run_as_it_is() {
        let stand = Stand::new(|_| true);
        let image = ready(&Choice::Pinned(pinned()), None, &Output::quiet(), &|args| stand.run(args)).unwrap();
        assert_eq!(image, "ghcr.io/ff/ff-runtime-python:3.13-v3-ff-0.2.0");
        assert_eq!(stand.ran.borrow().len(), 1, "{:?}", stand.ran.borrow());
    }

    #[test]
    fn otherwise_its_digest_is_pulled_then_tagged() {
        let stand = Stand::new(|line| !line.starts_with("image inspect"));
        let image = ready(&Choice::Pinned(pinned()), None, &Output::quiet(), &|args| stand.run(args)).unwrap();
        assert_eq!(image, "ghcr.io/ff/ff-runtime-python:3.13-v3-ff-0.2.0");
        let by_digest = format!("ghcr.io/ff/ff-runtime-python@{DIGEST}");
        assert_eq!(
            stand.ran.borrow()[1..],
            [
                format!("pull --quiet {by_digest}"),
                format!("tag {by_digest} ghcr.io/ff/ff-runtime-python:3.13-v3-ff-0.2.0")
            ]
        );
    }

    #[test]
    fn a_pull_refused_without_a_downloads_site_says_both() {
        let stand = Stand::new(|line| !line.starts_with("image inspect") && !line.starts_with("pull"));
        let error = ready(&Choice::Pinned(pinned()), None, &Output::quiet(), &|args| stand.run(args)).unwrap_err();
        assert!(
            error.message.contains("couldn't pull the runtime image ghcr.io/ff/ff-runtime-python@sha256:"),
            "{}",
            error.message
        );
        assert!(error.message.contains("(refused here), and this build knows no downloads site"), "{}", error.message);
    }

    #[test]
    fn the_repositorys_or_a_named_image_missing_says_how_to_build_it() {
        let stand = Stand::new(|_| false);
        let error =
            ready(&Choice::Repository(PYTHON_IMAGE), None, &Output::quiet(), &|args| stand.run(args)).unwrap_err();
        assert!(
            error.message.contains("docker build -t ff-runtime-python:3.13-v3 runtimes/<runtime>"),
            "{}",
            error.message
        );
        assert_eq!(stand.ran.borrow().len(), 1, "never pulled: {:?}", stand.ran.borrow());
        let named = Choice::Named("mine:1".into());
        assert!(
            ready(&named, None, &Output::quiet(), &|args| stand.run(args))
                .unwrap_err()
                .message
                .contains("mine:1, named by")
        );
    }

    // The minisign fixtures stand in for an archive: a file, its signature by the tests' key, the file's name in it.
    const KEY: &str = include_str!("minisign/fixtures/release.pub");
    const FILE: &[u8] = include_bytes!("minisign/fixtures/latest.json");
    const SIGNATURE: &[u8] = include_bytes!("minisign/fixtures/latest.json.minisig");

    fn key() -> PublicKey {
        PublicKey::from_base64(KEY.lines().nth(1).unwrap()).unwrap()
    }

    #[test]
    fn an_archive_written_as_it_comes_is_hashed_as_written_and_verified() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut written =
            Hashing { file: File::create_new(dir.path().join("latest.json")).unwrap(), hasher: Hasher::default() };
        for piece in FILE.chunks(5) {
            written.write_all(piece).unwrap();
        }
        let digest = written.hasher.finalize();
        assert_eq!(std::fs::read(dir.path().join("latest.json")).unwrap(), FILE);
        assert_eq!(verified(&key(), SIGNATURE, digest, "latest.json"), Ok(()));
        assert!(
            verified(&key(), SIGNATURE, digest, "ff-runtime-python.tar.gz").unwrap_err().contains("another file's")
        );
        let mut changed = Hasher::default();
        changed.update(&FILE[1..]);
        assert!(
            verified(&key(), SIGNATURE, changed.finalize(), "latest.json").unwrap_err().starts_with("its signature:")
        );
    }

    #[test]
    fn the_downloaded_file_goes_however_it_ends() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("archive");
        std::fs::write(&path, b"x").unwrap();
        drop(Removed(path.clone()));
        assert!(!path.exists());
    }
}
