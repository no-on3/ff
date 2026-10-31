#!/usr/bin/env bash
# Installs pinned kubectl and k3d into hack/bin/ (git-ignored) after verifying
# the SHA-256 checksums each project publishes, and the ff command's Rust toolchain
# (cli/rust-toolchain.toml's) through rustup, the PATH's, or one installed into
# hack/.rust/ (git-ignored), rustup-init's checksum verified too; hack/ci.sh uses
# it from there. Idempotent: tools already at the pinned version are left alone,
# and so is a Rust at least as recent where there is no rustup to pin it with.
# Nothing is installed system-wide.
#   hack/install-tools.sh [kubectl] [k3d] [rust]     (all three without an argument)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.37.1}"
K3D_VERSION="${K3D_VERSION:-v5.9.0}"
# The ff command's toolchain, which rustup uses in cli/; RUSTUP_TOOLCHAIN, rustup's own setting, overrides it.
RUST_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo_root/cli/rust-toolchain.toml")}"
bin_dir="$repo_root/hack/bin"
mkdir -p "$bin_dir"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

verify() { # <file> <expected sha256>
  local actual
  actual="$(sha256sum "$1" | awk '{ print $1 }')"
  if [ "$actual" != "$2" ]; then
    echo "checksum mismatch for $(basename "$1"): expected $2, got $actual" >&2
    exit 1
  fi
}

install_kubectl() {
  if [ -x "$bin_dir/kubectl" ] && "$bin_dir/kubectl" version --client 2>/dev/null | grep -q "$KUBECTL_VERSION"; then
    echo "kubectl $KUBECTL_VERSION already installed"
    return
  fi
  local base="https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$os/$arch"
  curl -fsSL --retry 3 -o "$tmp/kubectl" "$base/kubectl"
  verify "$tmp/kubectl" "$(curl -fsSL --retry 3 "$base/kubectl.sha256")"
  install -m 0755 "$tmp/kubectl" "$bin_dir/kubectl"
  echo "installed kubectl $KUBECTL_VERSION (sha256 verified)"
}

install_k3d() {
  if [ -x "$bin_dir/k3d" ] && "$bin_dir/k3d" version 2>/dev/null | grep -q "k3d version $K3D_VERSION"; then
    echo "k3d $K3D_VERSION already installed"
    return
  fi
  local base="https://github.com/k3d-io/k3d/releases/download/$K3D_VERSION"
  local asset="k3d-$os-$arch"
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  local expected
  expected="$(curl -fsSL --retry 3 "$base/checksums.txt" |
    awk -v a="$asset" '{ f = $2; sub(/^\*/, "", f); n = split(f, p, "/"); if (p[n] == a) { print $1; exit } }')"
  if [ -z "$expected" ]; then
    echo "no checksum for $asset in checksums.txt" >&2
    exit 1
  fi
  verify "$tmp/$asset" "$expected"
  install -m 0755 "$tmp/$asset" "$bin_dir/k3d"
  echo "installed k3d $K3D_VERSION (sha256 verified)"
}

# Rust: the toolchain through rustup, the PATH's or hack/.rust's; without rustup, the PATH's Rust if it is at least
# that version; else rustup and the toolchain into hack/.rust.
install_rust() {
  local rust_dir="$repo_root/hack/.rust" installed log
  [ -x "$rust_dir/cargo/bin/cargo" ] && export PATH="$rust_dir/cargo/bin:$PATH" RUSTUP_HOME="$rust_dir/rustup" CARGO_HOME="$rust_dir/cargo"
  if command -v rustup >/dev/null; then
    log="$(rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt,clippy --no-self-update 2>&1)" ||
      { echo "$log" >&2; return 1; }
    echo "Rust $(cd "$repo_root/cli" && rustc --version | cut -d' ' -f2), the toolchain $RUST_TOOLCHAIN, through rustup"
    return
  fi
  installed="$(rustc --version 2>/dev/null | cut -d' ' -f2 || true)"
  if [ -n "$installed" ] && [ "$(printf '%s\n%s\n' "$RUST_TOOLCHAIN" "$installed" | sort -V | head -1)" = "$RUST_TOOLCHAIN" ]; then
    echo "Rust $installed already installed, without rustup to pin $RUST_TOOLCHAIN with"
    return
  fi
  local triple
  case "$os-$arch" in
    linux-amd64) triple=x86_64-unknown-linux-gnu ;;
    linux-arm64) triple=aarch64-unknown-linux-gnu ;;
    darwin-amd64) triple=x86_64-apple-darwin ;;
    darwin-arm64) triple=aarch64-apple-darwin ;;
  esac
  local base="https://static.rust-lang.org/rustup/dist/$triple"
  curl -fsSL --retry 3 -o "$tmp/rustup-init" "$base/rustup-init"
  verify "$tmp/rustup-init" "$(curl -fsSL --retry 3 "$base/rustup-init.sha256" | awk '{ print $1 }')"
  chmod +x "$tmp/rustup-init"
  RUSTUP_HOME="$rust_dir/rustup" CARGO_HOME="$rust_dir/cargo" "$tmp/rustup-init" -y --no-modify-path --profile minimal \
    --default-toolchain "$RUST_TOOLCHAIN" --component rustfmt,clippy >/dev/null
  if [ "$os" = linux ]; then
    RUSTUP_HOME="$rust_dir/rustup" CARGO_HOME="$rust_dir/cargo" "$rust_dir/cargo/bin/rustup" target add "${triple%%-*}-unknown-linux-musl" >/dev/null
  fi
  echo "installed Rust $RUST_TOOLCHAIN in hack/.rust (rustup-init sha256 verified)"
}

[ $# -gt 0 ] || set -- kubectl k3d rust
for tool in "$@"; do
  case "$tool" in
    kubectl | k3d | rust) "install_$tool" ;;
    *) echo "unknown tool $tool: kubectl, k3d or rust" >&2; exit 2 ;;
  esac
done
