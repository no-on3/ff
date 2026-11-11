# ADR 0018: `ff`'s releases, built, signed and served by FF

| | |
|---|---|
| **Status** | Accepted: the [developer tools plan](../dev-tools-plan.md)'s D2 and its choices 3 and 4, confirmed on 2026-11-08 (the [decision log](../decisions.md)'s 72 and 73); the builds and the signatures measured by M-01's spikes the same day; the hash written by hand, your choice on 2026-11-09 (84). Built, every part of it, by M-03 and M-04 (below, under each "As built"); the signing key made by you on 2026-11-11, its ID `76C3DA51D8F8D047`, and the downloads site set up the same day on the development server, `https://get.dev.ffunc.cloud`; the first release, `ff-v0.1.0`, made on 2026-11-11 at your go-ahead (the plan's M-15) |
| **Date** | 2026-11-09 |
| **Implementation** | Developer tools plan: decision D2; tasks M-03 (the builds, the release, the downloads site, the update notice) and M-04 (the runtime images, `ff` in a customer's CI), whose last parts record here what was built; the CLI plan's C-41 to C-43. As built: M-03's parts 1, the builds and Windows, 2, the release job, 3, the downloads site and the install scripts, and 4, the update notice; M-04's parts 1, the runtime images, and 2, the CI examples (below); M-14 read them together with the guide |
| **Related** | [ADR 0002](0002-cli.md) (the `ff` command); [ADR 0011](0011-static-sites.md) (the sites that serve the downloads); the spikes, [`hack/spikes/cross-build`](../../hack/spikes/cross-build/README.md) and [`hack/spikes/minisign`](../../hack/spikes/minisign/README.md) |

## Context

`ff` is built today by `hack/build-cli.sh`, for x86_64 Linux alone, static, in an Alpine container. There is no release: a customer builds it from source. The plan's D2 gives five builds, signed files, a downloads site on FF itself, an install script and an update notice. Two things in it needed measuring first.

### The five builds, measured

`hack/spikes/cross-build/`, on this laptop and then on GitHub's runners:
- **Linux and Windows build from Linux with zig alone,** through `cargo-zigbuild`: x86_64 and arm64 Linux static (musl), and x86_64 Windows (GNU's ABI). `ring`'s C code compiles for each target with no other C toolchain, no musl-gcc, MinGW or Visual Studio. Each takes about three minutes.
- **macOS doesn't link from Linux.** The link needs Apple's SDK for three of `ff`'s own needs:
  - Foundation, for the container removed on Ctrl-C;
  - CoreServices, for `--watch`;
  - Security, for the system's certificates.

  Apple's licence allows the SDK on Apple's machines alone. Both macOS builds link on one arm64 macOS runner.
- **Every binary runs on its own system.** A customer's first commands work on each. `ff`'s 467 tests pass on arm64 Linux and on both macOS processors; on Windows, 461 of 463 (4 are Unix's alone). The two others test paths written Unix's way.
- **Windows showed three things more:**
  - Git's checkout with Windows line ends broke 8 tests that compare output with files;
  - a path with `..` is resolved by its text;
  - the credentials file is protected by the profile's inherited permissions, not its own.
- **A run takes about 22 runner-minutes,** 10 of them on macOS.

### minisign's signatures, verified in Rust, measured

`hack/spikes/minisign/`: a verifier with Ed25519 from `ring`, which `ff` has. It verifies minisign 0.12's own release against its author's key, and refuses what minisign refuses:
- a file changed by a byte;
- another key, or a forged key under the right ID;
- a changed trusted comment;
- a cut signature.

The one thing `ff` lacks is BLAKE2b-512, minisign's hash. The `blake2` crate adds 8 crates and 12.5 KB. Written from RFC 7693, it is 148 lines, its tests included, and adds nothing. It hashes 256 MB in 371 ms against the crate's 298 ms.

## Decision

### 1. Five builds, three from Linux and two from macOS

At each release, and by hand:
- **One Linux runner** builds x86_64 and arm64 Linux, static, and x86_64 Windows (`x86_64-pc-windows-gnu`), with `cargo zigbuild`. zig and cargo-zigbuild are pinned in `hack/install-tools.sh` with their checksums, and zig's signature is checked.
- **One arm64 macOS runner** builds both macOS targets.
- **`cargo test` runs on each system:** a Windows runner, both macOS processors and arm64 Linux, and x86_64 Linux at every push, as now.

`hack/build-cli.sh` takes a target, so the same script builds a release and a developer's copy.

### 2. Windows as a system of its own

- **The Unix-only code gets its counterparts:**
  - the credentials file readable by its owner alone, through the file's own permissions;
  - a package keeping Lambda's modes without reading the disk (0755 for what starts with `#!`, 0644 for the rest);
  - a symlink in a package refused, saying why;
  - the exported script's mode.
- **`.gitattributes`** keeps LF in every clone (`* text=auto eol=lf`), so a checkout on Windows passes the tests.
- **The two path tests** are made to hold on Windows: one takes either separator, and the other runs on Unix alone.

### As built (M-03, part 1): the builds and Windows

- **`hack/build-cli.sh [<target>]`** builds one of the five into `cli/target/dist/`, with its SHA-256: `ff-linux-x86_64` (the default), `ff-linux-arm64`, `ff-windows-x86_64.exe`, `ff-macos-arm64`, `ff-macos-x86_64`. Linux's and Windows's go through `cargo zigbuild`, which `hack/install-tools.sh zig cargo-zigbuild` installs: zig 0.17.0 into `hack/.zig/`, its minisign signature checked against zig's key at each install and its SHA-256 against its index's; cargo-zigbuild 0.24.0 against its release's checksum. macOS's are refused anywhere but on a Mac, saying why. `--container` keeps the Alpine image for the development server's x86_64 build; the build with musl-gcc installed is gone, as zig builds the same anywhere.
- **`ci.yml`'s `cli-builds` jobs,** in a run started by hand (`jobs=cli-builds`): the three from Linux and both macOS ones, each runner testing what it built for; then Windows, the Intel Mac and arm64 Linux run their binary (`hack/cli-smoke.sh`, the spike's `smoke.sh`) and `ff`'s tests, Windows's checkout made as Git makes it there, `.gitattributes` keeping LF. The release job of part 2 adds the tag.
- **The credentials on Windows:** the file gets an access list of its own before anything is written in it, Windows's own calls through `windows-sys`, the version the lock held already: its user, with everything, and nobody else, inherited from no folder. ff warns, as on Unix, when others may read it, the system and the administrators aside as OpenSSH sets them aside, with the `icacls` command that makes it its owner's again.
- **A package's modes on Windows:** 0755 for what starts with `#!` and, beyond the decision's word, for a Linux program, ELF's mark, as a build in a container installs (esbuild's, Prisma's engines), which Lambda would refuse to run at 0644.
- **The links, not refused:** Rust reads Windows's links as Unix's, so a package follows a link to a file inside the folder and leaves the others out, with the same warning, on both; the test that proves it runs on Windows too. Refusing them, as §2 said, would have refused what works.
- **The exported script:** Windows has no mark for a program, so `ff export` says there how Git gives `data/s3-sync.sh` one when the folder is committed (`git add --chmod=+x`).

### 3. A release

A tag `ff-v<version>` on `master` starts the release job. `cli/Cargo.toml`'s version must be the tag's, and the binary names its version and its commit. Each file comes with its SHA-256 and its minisign signature, made by the job with the signing key, which is its one secret. `latest.json`, signed too, names the newest version and each file's SHA-256. GitHub's release holds a copy of the files.

### As built (M-03, part 2): the release job

- **`.github/workflows/release.yml`,** at a tag `ff-v*`: the tag is checked first, against `cli/Cargo.toml`'s version and against `master`'s history; then the five builds, each tested on its own system, through `.github/workflows/cli-builds.yml`, the workflow a run by hand calls too; then `hack/release.sh`. It checks each build against its SHA-256, signs each and `latest.json` with minisign's default trusted comment (the signing time, the file's name), writes `SHA256SUMS`, and verifies every signature against `cli/release/minisign.pub` before anything leaves the job, all of it made in a folder of its own so that a refusal leaves nothing signed. GitHub's release holds a copy.
- **`latest.json`** is `{"version", "commit", "files": {"<file>": "<SHA-256>"}}`, the spike's shape with the commit added.
- **The key** is a password's, the password a second secret, so that your copy is protected on your disk. `hack/test-release.sh`, in `static`, makes a throwaway one each run.
- **The verifier goes into `ff` with the update notice** (part 4), its first use, rather than with the release job, so that no code waits unused in between.

### As built (M-03, part 3): the downloads site and the install scripts

- **`cli/release/install.sh`** (POSIX `sh`, for `curl … | sh`, `sh -s -- --prefix <folder>`) and **`cli/release/install.ps1`** (Windows PowerShell 5.1 and PowerShell 7, for `irm … | iex`, `-Prefix` through a script block) each verify `latest.json`'s signature first when `minisign` is on the machine, then the build's SHA-256 against it, then the build's own signature; they install through a temporary name, and say what was checked and what wasn't. They run from their last line, so that a download cut short runs nothing; `install.ps1` refuses with an error rather than an exit, which would close the window `iex` runs in. A Mac with Apple's processor gets its own build even in a shell Rosetta runs; Windows on Arm gets the x86_64 build, which it runs through its emulation.
- **`hack/downloads-site.sh`** makes the site from the signed release: the builds and their signatures, `SHA256SUMS`, `latest.json`, `minisign.pub`, the two scripts with the site's address and the public key put in, and a page with the install lines and the key's ID. **The site holds the latest release alone:** `ff sites deploy` removes what the folder hasn't, and GitHub's releases keep the older ones.
- **The release job** deploys it with the Linux build, `ff sites deploy`, to the bucket the repository's variables name, with an API key of an account that holds that bucket alone (the scopes are a service's, not a bucket's). It checks those settings, the signing key and the public key before building anything.
- **The tests:** `hack/test-install.sh` signs a release with a throwaway key, makes it a site, and runs this system's script as a customer does: installed with and without `minisign`, then refused a changed build, a build's signature and `latest.json`'s by another key, and the repository's copy, which names no site, nothing installed each time. It runs in `static` with stand-in builds; in each build job and on each system with the real builds, the installed `ff` run; and in the `ff` suite's `downloads` section against the site deployed to FF. **`install.ps1` runs on the Windows runner alone,** against a copy of the site Python serves there, not in the `ff` suite: PowerShell isn't on the Linux machines, and Windows is where it runs. **The Intel Mac's runner skips the test:** minisign has no build for an Intel Mac, its macOS one being for Apple's processors alone, so no release can be signed there. Every Linux and macOS machine runs `install.sh` as each machine it knows instead, stand-ins for `uname` and `sysctl` naming it: the Intel Mac's build, and Apple's in a shell Rosetta runs. A customer on an Intel Mac installs with the SHA-256 checked, or with Homebrew's minisign.

### 4. `ff` verifies minisign's signatures itself

The public key, `cli/release/minisign.pub`, is compiled into `ff`. The verifier is the spike's:
- Ed25519 from `ring`;
- **BLAKE2b-512 written from RFC 7693,** not the `blake2` crate (the decision log's 84). It adds no crate to pin or to watch in the nightly's advisories, for a hash that never changes. Its tests are RFC 7693's vectors, openssl's digest of 256 MB, and minisign's real release.
- minisign's hashed format alone, the legacy one refused, saying so;
- Windows line ends read as Unix's.

It checks the update notice's `latest.json` and the images' archives that `ff local` loads. The trusted comment holds the signing time. `ff` keeps the time of the last `latest.json` it verified and ignores an older one, so that a replayed manifest can't hide a newer release. A new key means a new install by the script, which the downloads page says, with the key's fingerprint.

### 5. The downloads, a site of FF's own

The files are served at `get.<domain>`, from a bucket of FF's own account. The release job deploys them with `ff sites deploy` and a key that reaches that bucket alone. The site holds:
- the install scripts;
- the binaries, their checksums and their signatures;
- `latest.json`;
- the runtime images as archives;
- the CI examples.

`install.sh` and `install.ps1` each:
1. name the system and the processor;
2. download the binary;
3. check its SHA-256 against `latest.json`, and its signature when `minisign` is on the machine;
4. install it into `~/.local/bin` or `--prefix`;
5. say what to add to `PATH`.

A checksum that differs is refused, with nothing installed. GitHub's releases and `ghcr.io` hold copies.

### 6. The update notice

Once a day at most, after a command that reached the API, `ff` reads `latest.json` and verifies it. When a newer version exists, it says so on stderr, with the one line that installs it. `FF_NO_UPDATE_CHECK=1` and `ff config set update_check false` turn it off, and `--output json` and `--quiet` never show it.

### As built (M-03, part 4): the update notice

- **The verifier is the spike's, in `cli/src/minisign/`,** its tests and fixtures with it. The spike compared its BLAKE2b with the crate's, which `ff` doesn't have: those tests compare with Python's `hashlib` instead, at the edges of BLAKE2b's 128-byte blocks, beside RFC 7693's vectors.
- **After a command that reached the API and succeeded,** not one the API refused: a failure's message stays the last thing said.
- **What the last check found** is kept in `update-check.json`, in `ff`'s folder of settings: when it ran, the signing time of the `latest.json` it verified, and the version it named. Where there is no folder, there is no check, as in a CI given `FF_TOKEN` alone, rather than a check at every command. A clock gone back before the last check makes one due.
- **The signing time** is read from minisign's default trusted comment, which must name `latest.json`: a build's signature, made by the same key and served beside it, isn't taken for the manifest's.
- **Both downloads take 4 s at most together,** 64 KB each at most; whatever fails is said with `--verbose` and asked again a day later.
- **The site and the key are built in:** the key from `cli/release/minisign.pub`, the site from `FF_BUILD_DOWNLOADS_URL`, which the release job gives the five builds from the repository's `FF_DOWNLOADS_URL`. A name of its own at build time, so that the address a developer gives `ff` at run time is never built into a test build. `FF_DOWNLOADS_URL` at run time points it at another copy of the site, as it does the install scripts. A build without either never checks. The tests' key comes from `FF_TEST_RELEASE_KEY`, which a release build ignores.
- **`ff version --verbose`** prints the ID of the key it trusts (`releaseKey` with `--output json`), to compare with the downloads page's.
- **The line that installs it** is the system's: `install.sh` on Linux and macOS, `install.ps1` on Windows.

### 7. The runtime images

Each release pins its two images by digest in a manifest, in place of the two constants of `local.rs`. They are published to `ghcr.io` under FF's name, and as archives on the downloads site (`docker save`, zstd, signed). `ff local` pulls the digest, and when it can't, loads the archive, verified.

### As built (M-04, part 1): the runtime images

- **The release's own images,** built from `runtimes/` at each release for AWS Lambda's x86_64 (`linux/amd64`), which `ff package` builds for too, and tagged as the repository tags them with `-ff-<version>` after: `ghcr.io/<owner>/ff-runtime-python:3.13-v3-ff-0.1.0`. `hack/runtime-images.sh` builds them, pushes them with the run's own token, reads each digest the push recorded and saves each image as an archive. Its manifest, for each runtime the image, the tag, the digest and the archive's path on the site, is built into the five (`FF_BUILD_RUNTIME_IMAGES`), as the site's address is. The two constants of `local.rs` stay, as the tags of a build from the repository, which has no manifest.
- **`ff local` runs the tag when the machine has it;** else it pulls the digest and gives it the tag; else, with a warning saying why the pull failed, it downloads the archive, hashing it as it is written, checks the signature with the release's key and that its trusted comment names the archive, and only then runs `docker load`, which gives the tag. The download goes to a file of its own in the system's temporary folder, removed however the command ends. A tag `ff` made is trusted afterwards, as the machine's Docker is its user's.
- **gzip, not zstd:** every Docker engine's `load` reads gzip, where an older one may not read zstd; the archive is a little larger.
- **The manifest is checked before Docker sees any of it:** each name made of a name's characters, the digest 64 lowercase hexadecimal digits, the archive a path of the site without `..`. A build whose manifest fails says so rather than hand Docker an option.
- **`FF_RUNTIME_IMAGE_NODEJS` and `FF_RUNTIME_IMAGE_PYTHON`** still name an image, run as it is, never pulled. A missing one, or a missing repository tag, is said with the line that builds it.
- **The tests' settings,** `FF_TEST_RUNTIME_IMAGES` and `FF_TEST_RELEASE_KEY`, are read by a build with debug assertions alone: `cargo test`'s, and now the `ff` suite's (`cli/Cargo.toml`'s `e2e` profile). A release build ignores them.
- **The release job's `images` job** runs before the builds, which take its manifest. `hack/release.sh` signs the archives the manifest names, lists them in `SHA256SUMS`, and refuses a release where one is missing or isn't a file of `images/`. The site serves them under `images/`; GitHub's release holds a copy. The site holds the latest release's alone: an older `ff` pulls its own from `ghcr.io`, or finds it on the machine.
- **`ghcr.io`'s packages** must be public for customers' pulls: GitHub gave the first release's the public repository's visibility. A private one refuses the pull, and `ff local` loads the archive (the guide's "A release of `ff`").
- **`ff sites deploy` uploads each archive in one request,** as it uploads every file, held in memory: 43 MiB for Python's, 83 MiB for Node.js's, as measured.

### As built (M-04, part 2): `ff` in a customer's CI

- **`examples/ci/github-actions.yml` and `gitlab-ci.yml`** deploy a repository's `template.yaml` at each push to its main branch: `ff` installed from the downloads site by `install.sh`, then `ff deploy template.yaml --yes --output json`, with `FF_ENDPOINT`, `FF_DOWNLOADS_URL` and the secret `FF_TOKEN`, a key with `stacks:read`, `stacks:write`, `functions:read` and `functions:write`.
- **A failure fails the job with `ff`'s code and its message,** read from the error document on stderr: on GitHub as the job's error annotation, a 6 titled as the account's refusal; on GitLab as the log's last line. GitHub's job lists the stack's outputs in its summary.
- **GitLab's image is Alpine with minisign,** so that `install.sh` checks the signatures there too; GitHub's runner checks the SHA-256.
- **The site serves both under `ci/`,** its page linking them, as §5 says; actionlint checks the GitHub one in `static`, and the `ff` suite's `ci` section runs each example's own lines, read from its file, against a release on a site FF serves, with a deploy's key and then a reader's, which is refused.

## Consequences

- The builds need no musl-gcc, MinGW or Alpine container: two tools pinned, zig and cargo-zigbuild. macOS keeps needing a macOS runner, about 10 of a run's 22 runner-minutes. That costs nothing while the repository is public, and counts at macOS's rate when it is private, once a release.
- Verifying signatures adds no crate to `ff`. Its BLAKE2b is ours to keep, 148 lines with its tests. A mistake in it would make a genuine file fail, which its tests show; a changed file passing would take the code ignoring part of its input.
- The signing key is the user's to make (`minisign -G`). Its secret half goes in GitHub's secrets, and its public half is committed. Losing it means a new key and a reinstall for everyone.
- macOS's builds aren't notarized for now (the decision log's 73). The install script downloads with `curl`, which marks no file as quarantined, so macOS runs the binary without Gatekeeper's prompt.

## Alternatives considered

- **macOS cross-compiled from Linux with Apple's SDK copied (osxcross):** Apple's licence allows the SDK on Apple's machines alone.
- **MinGW for Windows, musl-gcc for Linux:** two toolchains where zig is one, and zig builds `ring`'s C for every target.
- **The `blake2` crate:** 8 crates and 12.5 KB, three of them from RustCrypto's newest generation, still changing, for a hash that doesn't change. Measured 20% faster: 0.07 s on an archive of 256 MB.
- **The `minisign-verify` crate:** it carries an Ed25519 of its own beside `ring`'s.
- **GitHub's releases alone:** FF's downloads would depend on a service it doesn't run, where a site of FF's own serves itself as it serves customers (the decision log's 72).
- **Signatures through Sigstore:** a transparency log reached online at each check, where minisign is a key and a file.
