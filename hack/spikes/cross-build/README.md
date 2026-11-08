# Cross-build spike

How `ff`'s releases will be built for the five systems customers run it on: Linux on x86_64 and arm64, Windows on x86_64, macOS on x86_64 and arm64. The measurements behind ADR 0018 (`ff`'s releases); the [developer tools plan](../../../docs/dev-tools-plan.md)'s D2, its task list's M-01, part 1, for M-03 to build on.

```bash
hack/spikes/cross-build/run.sh                 # on Linux: 15 to 25 minutes the first time, the tools, the targets, five builds
TARGETS="x86_64-pc-windows-gnu" hack/spikes/cross-build/run.sh    # some of them
hack/spikes/cross-build/macos.sh               # on macOS, with Xcode's command line tools: both macOS builds
hack/spikes/cross-build/smoke.sh <ff binary>   # on the system the binary is for
gh workflow run ci.yml --ref <branch> -f jobs=cross   # all of it on GitHub's runners, about 12 minutes
```

`run.sh` needs Rust (rustup, with the toolchain `cli/` pins), curl and xz. It installs minisign through `hack/install-tools.sh minisign`, and zig and cargo-zigbuild into `hack/.spike-cross-build/`, where the builds, their logs, zig's caches and the results go too (`results.md`, `results-macos.md`). Nothing lands in the home folder but Rust's targets, which rustup keeps with the toolchain.

## What it does

- **The tools, pinned and checked:** zig 0.17.0, its archive's minisign signature checked against zig's key and its SHA-256 against the one copied here; cargo-zigbuild 0.24.0, its SHA-256 against its release's checksum file. A checksum that differs stops the run with nothing installed.
- **The builds,** one at a time, each `cargo zigbuild --release --locked --target <target>` in `cli/`, with the release profile `ff` ships (`lto`, one codegen unit, `strip`) and the commit compiled in. zig is the C compiler and the linker for every target, ring's C and assembly included; nothing else is installed: no musl-gcc, no MinGW. For each: whether it built, the time, the size, what the file is, and the first errors when it failed.
- **The Linux build checked here:** static, and `ff version` names the commit.
- **macOS on macOS** (`macos.sh`): both of macOS's targets built on one machine, an arm64 one, with Rust's own toolchain and Apple's linker; the one for that machine's processor run.
- **Each binary run on its own system** (`smoke.sh`): what a customer's first minutes do without an FF to reach. `ff version`; `ff init` makes a function's folder; `ff package` zips it, a script that starts with `#!` at 0755 and the rest at 0644, as Lambda wants them; `ff config set` saves a setting, the file its owner's alone (on Windows, `icacls` says who may read it); `ff completion` prints a script for bash, or for PowerShell on Windows. Its settings in a folder of its own, never the machine's.
- **On GitHub's runners** (`ci.yml`'s `cross` jobs, only in a run started by hand that names them): the Linux and Windows builds on an x86_64 Linux runner, the macOS ones on an arm64 macOS runner; then on a Windows runner, an Intel and an arm64 macOS runner and an arm64 Linux runner, the binary for that system run by `smoke.sh`, and `ff`'s tests (`cargo test --locked`) run with that system's own toolchain.

## What it found

On 2026-11-08, on this laptop (8 processors, 2 jobs), with Rust 1.91.0, zig 0.17.0 and cargo-zigbuild 0.24.0, the release builds of `438d68b`:

| Target | Built | Seconds | Size | The file |
|---|---|---|---|---|
| x86_64-unknown-linux-musl | yes | 187 | 7.8 MiB | ELF, x86-64, static |
| aarch64-unknown-linux-musl | yes | 170 | 6.4 MiB | ELF, ARM aarch64, static |
| x86_64-pc-windows-gnu | yes | 182 | 7.6 MiB | PE32+, console, x86-64 |
| x86_64-apple-darwin | no: the link | 160 | | |
| aarch64-apple-darwin | no: the link | 164 | | |

1. **Linux and Windows build from Linux, with zig alone.** ring's C code compiled for each target with no C toolchain installed for it. The Linux builds are static, as `hack/build-cli.sh`'s are today, without its musl-gcc or its Alpine container; the Windows one uses GNU's ABI, with zig's own MinGW headers and libraries, and needs no Visual Studio. About three minutes each with 2 jobs.
2. **macOS doesn't link from Linux.** Everything compiles, ring's C included, but the link needs Apple's SDK, which zig doesn't carry: `libobjc` and Foundation (for `ctrlc`, through `dispatch2` and `objc2`), CoreServices (for `notify`, through `fsevent-sys`), Security and CoreFoundation (for `rustls-platform-verifier`, through `security-framework`). All three are `ff`'s own needs: a local run's container removed on Ctrl-C, `--watch`'s restarts, the system's certificates. The SDK can't be had otherwise: Apple's licence allows it on Apple's machines alone, which rules out copying it to Linux (osxcross). **So macOS's builds run on a macOS runner,** both from the arm64 one (`macos.sh`), as the task list planned for what failed from Linux.
3. **The Windows build warns once:** `executable` unused in `src/commands/export/mod.rs`, because the exported script's mode is set on Unix alone. M-03's part 1 lists it among the Unix-only code that needs its Windows counterpart.
4. **zig and cargo-zigbuild stay** for the Linux and Windows builds, pinned with their checksums in `hack/install-tools.sh` by M-03, zig's signature checked too, as here.

### On GitHub's runners

On 2026-11-08, `ci.yml`'s `cross` jobs, dispatched twice: at `4ee381f` (run 42528875346), then at `7f27961` (run 42530168016) with what the first had found fixed. The table gives the second run's figures, and the first's in brackets where they differ. Nothing is cached, so each job builds from scratch, the tests' build included.

| Job | Runner | What it did | Result | Minutes |
|---|---|---|---|---|
| `cross-build` | `ubuntu-24.04`, 4 jobs | the Linux and Windows builds, as above | all three built: x86_64 musl in 160 s, 7.8 MiB; arm64 musl in 169 s, 6.4 MiB; Windows in 195 s, 7.6 MiB (the first run: 132 to 136 s each) | 9.2 (7.1) |
| `cross-build-macos` | `macos-15`, arm64, 3 jobs | both macOS builds (`macos.sh`) | both built: arm64 in 215 s (261), 6.2 MiB; x86_64 in 189 s (225), 7.3 MiB; the arm64 one run there names its commit | 7.2 (8.5) |
| `cross linux-arm64` | `ubuntu-24.04-arm` | `smoke.sh`, then `cargo test` with that system's toolchain | 9 checks passed; 467 tests passed | 0.8 |
| `cross macos-arm64` | `macos-15` | the same | 9 checks; 467 tests | 1.3 |
| `cross macos-x86_64` | `macos-15-intel` | the same | 9 checks; 467 tests | 2.2 (3.0) |
| `cross windows-x86_64` | `windows-2025` | the same, in Git for Windows' bash | 8 checks passed; 461 tests of 463 passed, 2 failed (the first run stopped at the first test binary: 9 of its 268 failed) | 1.3 (1.7) |

The x86_64 Linux binary is checked on the machine that builds it (static, names its commit). It passed `smoke.sh`'s 9 checks on this laptop. On Windows, `smoke.sh` runs 8 checks, because the file mode it checks elsewhere is read there with `icacls`. 4 of `ff`'s tests are compiled for Unix alone.

5. **Every binary runs on its own system,** built as a release would build it: arm64 and x86_64 macOS from one arm64 runner, Linux and Windows from one Linux runner. A customer's first minutes work on each: `ff version`, `ff init`, `ff package`, `ff config set`, `ff config set-token` and `ff completion` (PowerShell's on Windows). macOS, arm64 Linux and x86_64 Linux pass all of `ff`'s tests.
6. **Windows needs the work M-03's part 1 lists, and three things more that the runners showed:**
   - **Git checks files out with Windows line ends** (`core.autocrlf`, which Git for Windows turns on). 8 tests failed in the first run because they compare `ff`'s output with files read by `include_str!` or with the backend's names. The job now checks out with `autocrlf` off. M-03 adds a `.gitattributes` that keeps LF in every clone (`* text=auto eol=lf`), so that a developer's checkout on Windows passes the tests too.
   - **A path with `..` resolves by its text on Windows,** before the disk is read: `orders-api/sub/..` is `orders-api` even when `sub` doesn't exist, where Unix refuses it. `ff package`'s test of that case holds for Unix alone, and M-03 marks it so. The path a customer meant is the one `ff` packages either way.
   - **`ff package` prints Windows's paths with `\`,** as it should; its test's pattern expects `/`. M-03 makes the pattern take either.
   - **The package's modes, as M-03 plans:** the script is 0644 in the zip on Windows, because `ff` reads the mode from the disk and Windows has no executable bit. M-03 gives 0755 to what starts with `#!` without reading the disk.
   - **The credentials file** is readable, `icacls` says, by its owner, `SYSTEM` and the Administrators, inherited from the user's profile, where it lives: no other user can read it. M-03 sets the file's own permissions, as its part 1 says, for a settings folder outside the profile.
7. **The minutes:** the builds take about 9 minutes on two runners at once; then each system's checks and tests take 1 to 3 minutes, compiling included. That makes about 22 runner-minutes per run, 10 of them on macOS. This costs nothing while the repository is public. When it is private, the minutes come out of the plan's allowance, macOS's at a higher rate. A release makes them once.
