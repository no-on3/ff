#!/usr/bin/env bash
# The developer tools' spike of the ff command built for five systems from one Linux machine: Linux on x86_64 and
# arm64 (static, musl), Windows on x86_64 (GNU's ABI), macOS on x86_64 and arm64. Each through cargo-zigbuild, zig
# being the C compiler and the linker, ring's C code and all; zig and cargo-zigbuild pinned here with their checksums,
# zig's signature checked too. For each build: whether it built, the time, the size, what the file is; the Linux one
# run here. The other systems run theirs on GitHub's runners (ci.yml's cross job, dispatched with jobs=cross), whose
# times and results the README records. What it found lands in hack/.spikes/cross-build/results.md.
#   hack/spikes/cross-build/run.sh             # 15 to 25 minutes the first time: the tools, Rust's targets, 5 builds
#   TARGETS="x86_64-pc-windows-gnu" hack/spikes/cross-build/run.sh   # some of them
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work cross-build
source "$repo/hack/lib/checks.sh"

# Pinned to releases at least two weeks old when chosen. zig's SHA-256 is its own index's, of a file whose signature
# was checked against zig's key, as ziglang.org/download gives it; cargo-zigbuild's, its release's checksum file's.
ZIG_VERSION=0.17.0
ZIG_SHA256=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026
ZIG_KEY=RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U
ZIGBUILD_VERSION=0.24.0
ZIGBUILD_SHA256=52be2cb85ad3875682564a29bac1832b2ab3db68b1c504765c92d5249cc9b96f
read -r -a targets <<<"${TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu x86_64-apple-darwin aarch64-apple-darwin}"

mkdir -p "$work/bin" "$work/downloads" "$work/dist" "$work/logs"
results="$work/results.md"
# zig's and cargo-zigbuild's caches here too, where they would be in the home folder's.
export ZIG_GLOBAL_CACHE_DIR="$work/cache/zig" CARGO_ZIGBUILD_CACHE_DIR="$work/cache/cargo-zigbuild"
toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/cli/rust-toolchain.toml")"

download() { # <url> <file in downloads>: kept between runs
  [ -f "$work/downloads/$2" ] && return
  curl -fsSL --retry 3 -o "$work/downloads/$2.part" "$1"
  mv "$work/downloads/$2.part" "$work/downloads/$2"
}
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

section "the tools: zig $ZIG_VERSION and cargo-zigbuild $ZIGBUILD_VERSION, each checked"
"$repo/hack/install-tools.sh" minisign >/dev/null
zig_file="zig-x86_64-linux-$ZIG_VERSION.tar.xz"
download "https://ziglang.org/download/$ZIG_VERSION/$zig_file" "$zig_file"
download "https://ziglang.org/download/$ZIG_VERSION/$zig_file.minisig" "$zig_file.minisig"
check "zig's archive signed by zig's key" 0 \
  "$("$repo/hack/bin/minisign" -Vqm "$work/downloads/$zig_file" -P "$ZIG_KEY" >/dev/null 2>&1; echo $?)"
check "zig's archive, its SHA-256" "$ZIG_SHA256" "$(sha256_of "$work/downloads/$zig_file")"
zigbuild_file="cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz"
download "https://github.com/rust-cross/cargo-zigbuild/releases/download/v$ZIGBUILD_VERSION/$zigbuild_file" "$zigbuild_file"
check "cargo-zigbuild's archive, its SHA-256" "$ZIGBUILD_SHA256" "$(sha256_of "$work/downloads/$zigbuild_file")"
if [ "$(sha256_of "$work/downloads/$zig_file")" != "$ZIG_SHA256" ] ||
  [ "$(sha256_of "$work/downloads/$zigbuild_file")" != "$ZIGBUILD_SHA256" ]; then
  fail "a tool's checksum doesn't match: nothing installed"
fi
if [ ! -x "$work/zig/zig" ]; then
  rm -rf "$work/zig" && mkdir -p "$work/zig"
  tar -xJf "$work/downloads/$zig_file" -C "$work/zig" --strip-components=1
fi
tar -xJf "$work/downloads/$zigbuild_file" -C "$work/bin" --strip-components=1 "${zigbuild_file%.tar.xz}/cargo-zigbuild"
ln -sf "$work/zig/zig" "$work/bin/zig"
export PATH="$work/bin:$PATH"
check "zig runs" "$ZIG_VERSION" "$(zig version)"
check "cargo-zigbuild runs" "cargo-zigbuild $ZIGBUILD_VERSION" "$(cargo-zigbuild --version)"

section "Rust's targets for toolchain $toolchain"
# cargo in cli/ installs the toolchain its file names, as on a runner that has another.
(cd "$repo/cli" && cargo --version) >/dev/null
rustup target add --toolchain "$toolchain" "${targets[@]}" >/dev/null 2>&1
installed="$(rustup target list --installed --toolchain "$toolchain")"
for target in "${targets[@]}"; do
  check "$target installed" true "$(grep -x "$target" <<<"$installed" >/dev/null && echo true || echo false)"
done

section "the builds, one at a time"
"$repo/hack/check-resources.sh"
commit="$(git -C "$repo" rev-parse --short=12 HEAD)"
declare -A built seconds size kind
for target in "${targets[@]}"; do
  binary=ff
  [[ "$target" == *windows* ]] && binary=ff.exe
  log="$work/logs/$target.log"
  started="$(date +%s)"
  if (cd "$repo/cli" && FF_BUILD_COMMIT="$commit" cargo zigbuild --release --locked --target "$target") >"$log" 2>&1; then
    built[$target]=yes
    cp "$CARGO_TARGET_DIR/$target/release/$binary" "$work/dist/ff-$target${binary#ff}"
    size[$target]="$(stat -c %s "$work/dist/ff-$target${binary#ff}")"
    kind[$target]="$(file -b "$work/dist/ff-$target${binary#ff}" | cut -d, -f1-3)"
  else
    built[$target]=no
    # The first errors, for the README: what failed and where.
    grep -E '^(error|warning: .*link|  = note: .*(ld|lld|undefined|framework))' "$log" | head -5 | sed 's/^/    /' || true
  fi
  seconds[$target]=$(($(date +%s) - started))
  echo "  $target: built ${built[$target]} in ${seconds[$target]} s"
done
check "Linux on x86_64 built" yes "${built[x86_64-unknown-linux-musl]:-skipped}"
if [ "${built[x86_64-unknown-linux-musl]:-}" = yes ]; then
  linux="$work/dist/ff-x86_64-unknown-linux-musl"
  check "it's static" true "$(file "$linux" | grep -E 'static(ally|-pie)? linked' >/dev/null && echo true || echo false)"
  check "it runs here and names its commit" true "$("$linux" version | grep "$commit" >/dev/null && echo true || echo false)"
fi
(cd "$work/dist" && sha256sum ff-* >SHA256SUMS)

{ echo "# ff built for five systems from Linux ($(date -u +%F))"; echo
  echo "With Rust $toolchain, zig $ZIG_VERSION and cargo-zigbuild $ZIGBUILD_VERSION, release builds of commit $commit, $CARGO_BUILD_JOBS jobs."
  echo; echo "| Target | Built | Seconds | Bytes | The file |"; echo "|---|---|---|---|---|"
  for target in "${targets[@]}"; do
    echo "| $target | ${built[$target]} | ${seconds[$target]} | ${size[$target]:-} | ${kind[$target]:-see logs/$target.log} |"
  done
} >"$results"
cat "$results"
checks_done spike-cross-build
