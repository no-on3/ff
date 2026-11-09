#!/usr/bin/env bash
# The ff command's release build for one of the five systems it is built for, and its SHA-256 beside it, in
# cli/target/dist/, named for its system and its processor:
#   x86_64-unknown-linux-musl    ff-linux-x86_64          static, the default
#   aarch64-unknown-linux-musl   ff-linux-arm64           static
#   x86_64-pc-windows-gnu        ff-windows-x86_64.exe
#   aarch64-apple-darwin         ff-macos-arm64           on a Mac
#   x86_64-apple-darwin          ff-macos-x86_64          on a Mac
# Linux's and Windows's with cargo-zigbuild, zig being the C compiler and the linker, ring's C code included, both
# pinned and installed by hack/install-tools.sh; macOS's on a Mac, by cargo alone, as their link needs Apple's SDK,
# which only Apple's machines may hold (ADR 0018). --container builds Linux's x86_64 one in the Rust image instead,
# with musl's own C compiler, as the development server does. The binary names the commit it is built from, and the
# one for this machine runs at the end. On Linux, the resource check runs first.
#   hack/build-cli.sh [<target>] [--container]
#   FF_BUILD_COMMIT=<commit>   the commit to name, where there is no git checkout, as on the development server
#   FF_BUILD_DOWNLOADS_URL=<address>   the downloads site the update notice reads, as a release's builds are given it
#   FF_BUILD_RUNTIME_IMAGES=<manifest> the release's runtime images, pinned by digest (hack/runtime-images.sh), for ff local
#   CARGO_BUILD_JOBS=<n>       Cargo's jobs, in the container too
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

target=x86_64-unknown-linux-musl container=false
for arg in "$@"; do
  case $arg in
    --container) container=true ;;
    -*) echo "unknown option $arg: --container is the one" >&2; exit 2 ;;
    *) target=$arg ;;
  esac
done
case $target in
  x86_64-unknown-linux-musl) binary=ff-linux-x86_64 ;;
  aarch64-unknown-linux-musl) binary=ff-linux-arm64 ;;
  x86_64-pc-windows-gnu) binary=ff-windows-x86_64.exe ;;
  aarch64-apple-darwin) binary=ff-macos-arm64 ;;
  x86_64-apple-darwin) binary=ff-macos-x86_64 ;;
  *)
    echo "ff isn't built for $target: x86_64-unknown-linux-musl, aarch64-unknown-linux-musl, x86_64-pc-windows-gnu," \
      "aarch64-apple-darwin or x86_64-apple-darwin" >&2
    exit 2
    ;;
esac
if $container && [ "$target" != x86_64-unknown-linux-musl ]; then
  echo "--container builds Linux's x86_64 ff alone: $target is built with zig, or on a Mac" >&2
  exit 2
fi
if [[ $target == *-apple-darwin ]] && [ "$(uname -s)" != Darwin ]; then
  echo "ff for macOS links with Apple's SDK, which only Apple's machines may hold: build $target on a Mac" >&2
  exit 2
fi

toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/cli/rust-toolchain.toml")"
# The toolchain the CLI is tested with in Alpine's image, for musl; Alpine pinned to a release at least two weeks old
# when chosen.
RUST_IMAGE="${RUST_IMAGE:-rust:$toolchain-alpine3.22}"
dist="$repo/cli/target/dist"
bin_dir="${FF_TOOLS_BIN:-$repo/hack/bin}"
executable=ff
[[ $target == *-windows-* ]] && executable=ff.exe

# The resource check guards the shared Linux machine it reads (/proc); a Mac builds without it.
[ "$(uname -s)" != Linux ] || "$repo/hack/check-resources.sh"
commit="${FF_BUILD_COMMIT:-$(git -C "$repo" rev-parse --short=12 HEAD)}"
mkdir -p "$dist"

if $container; then
  echo "== building in $RUST_IMAGE, for $target"
  # As root, to add musl's headers, which ring's C code needs; in a target folder of its own, given back to
  # this user at the end, even after a failure, so that no file of the build stays root's.
  docker run --rm -v "$repo/cli:/src" -w /src -e FF_BUILD_COMMIT="$commit" -e FF_BUILD_DOWNLOADS_URL -e FF_BUILD_RUNTIME_IMAGES -e CARGO_BUILD_JOBS \
    -e CARGO_HOME=/src/target/container/cargo-home -e CARGO_TARGET_DIR=/src/target/container "$RUST_IMAGE" \
    sh -c "apk add --no-cache musl-dev >/dev/null && cargo build --release --locked --target $target; status=\$?; \
      chown -R $(id -u):$(id -g) /src/target/container; exit \$status"
  built="$repo/cli/target/container"
else
  # The target's standard library, for the toolchain cli/ names, which cargo there installs first.
  (cd "$repo/cli" && cargo --version >/dev/null)
  rustup target list --installed --toolchain "$toolchain" | grep -x "$target" >/dev/null ||
    rustup target add --toolchain "$toolchain" "$target"
  if [[ $target == *-apple-darwin ]]; then
    echo "== building here, for $target"
    (cd "$repo/cli" && FF_BUILD_COMMIT="$commit" cargo build --release --locked --target "$target")
  else
    "$repo/hack/install-tools.sh" zig cargo-zigbuild >/dev/null
    echo "== building with zig $("$bin_dir/zig" version), for $target"
    # zig's caches in the build's folder, where cargo clean removes them, rather than the home folder's.
    (cd "$repo/cli" && PATH="$bin_dir:$PATH" ZIG_GLOBAL_CACHE_DIR="$repo/cli/target/zig/cache" \
      CARGO_ZIGBUILD_CACHE_DIR="$repo/cli/target/zig/cargo-zigbuild" FF_BUILD_COMMIT="$commit" \
      cargo zigbuild --release --locked --target "$target")
  fi
  built="${CARGO_TARGET_DIR:-$repo/cli/target}"
fi

cp "$built/$target/release/$executable" "$dist/$binary"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$dist" && sha256 "$binary" >"$binary.sha256")
if [[ $target == *-linux-musl ]] && ! file "$dist/$binary" | grep 'static' >/dev/null; then
  echo "$dist/$binary isn't static" >&2
  exit 1
fi
echo "== $dist/$binary ($(du -h "$dist/$binary" | cut -f1)), sha256 $(cut -d' ' -f1 "$dist/$binary.sha256")"
case "$(uname -s)-$(uname -m):$binary" in
  Linux-x86_64:ff-linux-x86_64 | Linux-aarch64:ff-linux-arm64 | Darwin-arm64:ff-macos-arm64 | Darwin-x86_64:ff-macos-x86_64)
    "$dist/$binary" version --verbose
    ;;
esac
