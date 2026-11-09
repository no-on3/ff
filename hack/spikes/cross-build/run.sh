#!/usr/bin/env bash
# The developer tools' spike of the ff command built for five systems from one Linux machine: Linux on x86_64 and
# arm64 (static, musl), Windows on x86_64 (GNU's ABI), macOS on x86_64 and arm64. Each through cargo-zigbuild, zig
# being the C compiler and the linker, ring's C code and all; zig and cargo-zigbuild pinned with their checksums, zig's
# signature checked too, by hack/install-tools.sh since hack/build-cli.sh builds with them. For each build: whether it
# built, the time, the size, what the file is; the Linux one run here. The other systems ran theirs on GitHub's runners
# (the jobs ci.yml's cli-builds jobs replaced), whose times and results the README records. What it found lands in
# hack/.spikes/cross-build/results.md.
#   hack/spikes/cross-build/run.sh             # 15 to 25 minutes the first time: the tools, Rust's targets, 5 builds
#   TARGETS="x86_64-pc-windows-gnu" hack/spikes/cross-build/run.sh   # some of them
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work cross-build
source "$repo/hack/lib/checks.sh"

read -r -a targets <<<"${TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu x86_64-apple-darwin aarch64-apple-darwin}"

mkdir -p "$work/dist" "$work/logs"
results="$work/results.md"
# zig's and cargo-zigbuild's caches here too, where they would be in the home folder's.
export ZIG_GLOBAL_CACHE_DIR="$work/cache/zig" CARGO_ZIGBUILD_CACHE_DIR="$work/cache/cargo-zigbuild"
toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/cli/rust-toolchain.toml")"

section "the tools: zig and cargo-zigbuild, as hack/install-tools.sh pins and checks them"
"$repo/hack/install-tools.sh" zig cargo-zigbuild
export PATH="$repo/hack/bin:$PATH"
check "zig runs" true "$(zig version >/dev/null && echo true || echo false)"
check "cargo-zigbuild runs" true "$(cargo-zigbuild --version >/dev/null && echo true || echo false)"

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
  echo "With Rust $toolchain, zig $(zig version) and $(cargo-zigbuild --version), release builds of commit $commit, $CARGO_BUILD_JOBS jobs."
  echo; echo "| Target | Built | Seconds | Bytes | The file |"; echo "|---|---|---|---|---|"
  for target in "${targets[@]}"; do
    echo "| $target | ${built[$target]} | ${seconds[$target]} | ${size[$target]:-} | ${kind[$target]:-see logs/$target.log} |"
  done
} >"$results"
cat "$results"
checks_done spike-cross-build
