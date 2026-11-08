# Cross-build spike

How `ff`'s releases will be built for the five systems customers run it on: Linux on x86_64 and arm64, Windows on x86_64, macOS on x86_64 and arm64. The measurements behind ADR 0018 (`ff`'s releases); the [developer tools plan](../../../docs/dev-tools-plan.md)'s D2, its task list's M-01, part 1, for M-03 to build on.

```bash
hack/spikes/cross-build/run.sh                 # on Linux: 15 to 25 minutes the first time, the tools, the targets, five builds
TARGETS="x86_64-pc-windows-gnu" hack/spikes/cross-build/run.sh    # some of them
hack/spikes/cross-build/macos.sh               # on macOS, with Xcode's command line tools: both macOS builds
hack/spikes/cross-build/smoke.sh <ff binary>   # on the system the binary is for
gh workflow run ci.yml --ref <branch> -f jobs=cross   # all of it on GitHub's runners
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
