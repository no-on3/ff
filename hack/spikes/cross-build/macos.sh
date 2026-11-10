#!/usr/bin/env bash
# The spike's macOS builds, which Linux can't link: ff's crates need Apple's frameworks, which only Apple's SDK holds
# (the README). Both of macOS's targets built on one macOS machine with Rust's own toolchain and Apple's linker, so that
# one runner could make both in a release. For each: whether it built, the time, the size, what the file is; the one
# for this machine's processor run here. ci.yml's cross job runs it on an arm64 runner; the Intel one runs the other.
#   hack/spikes/cross-build/macos.sh      # on macOS with Xcode's command line tools; about 10 minutes
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work cross-build
source "$repo/hack/lib/checks.sh"
targets=(aarch64-apple-darwin x86_64-apple-darwin)
mkdir -p "$work/dist" "$work/logs"
results="$work/results-macos.md"
toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/cli/rust-toolchain.toml")"

section "Rust's targets for toolchain $toolchain, on macOS $(sw_vers -productVersion) $(uname -m)"
# cargo in cli/ installs the toolchain its file names, as on a runner that has another.
(cd "$repo/cli" && cargo --version) >/dev/null
rustup target add --toolchain "$toolchain" "${targets[@]}" >/dev/null 2>&1
installed="$(rustup target list --installed --toolchain "$toolchain")"
for target in "${targets[@]}"; do
  check "$target installed" true "$(grep -x "$target" <<<"$installed" >/dev/null && echo true || echo false)"
done

section "the builds, one at a time"
commit="$(git -C "$repo" rev-parse --short=12 HEAD)"
rows=()
for target in "${targets[@]}"; do
  binary="$work/dist/ff-$target"
  started="$(date +%s)"
  if (cd "$repo/cli" && FF_BUILD_COMMIT="$commit" cargo build --release --locked --target "$target") >"$work/logs/$target.log" 2>&1; then
    cp "$CARGO_TARGET_DIR/$target/release/ff" "$binary"
    row="| $target | yes | $(($(date +%s) - started)) | $(wc -c <"$binary" | tr -d ' ') | $(file -b "$binary" | cut -d, -f1-3) |"
  else
    grep -E '^error' "$work/logs/$target.log" | head -5 | sed 's/^/    /' || true
    row="| $target | no | $(($(date +%s) - started)) | | see logs/$target.log |"
  fi
  echo "  $row"
  rows+=("$row")
  check "$target built" true "$([ -f "$binary" ] && echo true || echo false)"
done
native="$(uname -m | sed 's/^arm64$/aarch64/')-apple-darwin"
if [ -f "$work/dist/ff-$native" ]; then
  check "the one for this processor runs here and names its commit" true \
    "$("$work/dist/ff-$native" version | grep "$commit" >/dev/null && echo true || echo false)"
fi

{ echo "# ff built for macOS on macOS ($(date -u +%F))"; echo
  echo "With Rust $toolchain on macOS $(sw_vers -productVersion) $(uname -m), release builds of commit $commit, $CARGO_BUILD_JOBS jobs."
  echo; echo "| Target | Built | Seconds | Bytes | The file |"; echo "|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
} >"$results"
cat "$results"
checks_done spike-cross-build-macos
