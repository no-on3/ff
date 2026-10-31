#!/usr/bin/env bash
# The ff command's release build for Linux on x86_64: a static binary (musl), and its SHA-256 beside
# it, in cli/target/dist/. It builds here when the musl target and musl-gcc are installed, else
# inside the Rust image, which has both; --container builds there in any case. The binary names
# the commit it is built from. The resource check runs first.
#   hack/build-cli.sh [--container]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The toolchain the CLI is tested with, cli/rust-toolchain.toml's, in Alpine's image, for musl; Alpine pinned to a
# release at least two weeks old when chosen.
RUST_IMAGE="${RUST_IMAGE:-rust:$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/cli/rust-toolchain.toml")-alpine3.22}"
target=x86_64-unknown-linux-musl
dist="$repo/cli/target/dist"
binary="ff-linux-x86_64"

"$repo/hack/check-resources.sh"
commit="$(git -C "$repo" rev-parse --short=12 HEAD)"
mkdir -p "$dist"

if [ "${1:-}" != --container ] && rustup target list --installed 2>/dev/null | grep -x "$target" >/dev/null && command -v musl-gcc >/dev/null; then
  echo "== building here, for $target"
  (cd "$repo/cli" && FF_BUILD_COMMIT="$commit" cargo build --release --locked --target "$target")
else
  echo "== building in $RUST_IMAGE, for $target"
  # As root, to add musl's headers, which ring's C code needs; in a target folder of its own, given back to
  # this user at the end, even after a failure, so that no file of the build stays root's.
  docker run --rm -v "$repo/cli:/src" -w /src -e FF_BUILD_COMMIT="$commit" \
    -e CARGO_HOME=/src/target/container/cargo-home -e CARGO_TARGET_DIR=/src/target/container "$RUST_IMAGE" \
    sh -c "apk add --no-cache musl-dev >/dev/null && cargo build --release --locked --target $target; status=\$?; \
      chown -R $(id -u):$(id -g) /src/target/container; exit \$status"
  built="$repo/cli/target/container"
fi

cp "${built:-$repo/cli/target}/$target/release/ff" "$dist/$binary"
(cd "$dist" && sha256sum "$binary" >"$binary.sha256")
file "$dist/$binary" | grep 'static' >/dev/null || { echo "$dist/$binary isn't static" >&2; exit 1; }
echo "== $dist/$binary ($(du -h "$dist/$binary" | cut -f1)), sha256 $(cut -d' ' -f1 "$dist/$binary.sha256")"
"$dist/$binary" version --verbose
