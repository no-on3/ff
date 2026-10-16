#!/usr/bin/env bash
# Installs pinned kubectl and k3d into hack/bin/ (git-ignored) after verifying
# the SHA-256 checksums each project publishes. Idempotent: tools already at
# the pinned version are left alone. Nothing is installed system-wide.
set -euo pipefail

KUBECTL_VERSION="${KUBECTL_VERSION:-v1.37.1}"
K3D_VERSION="${K3D_VERSION:-v5.9.0}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

install_kubectl
install_k3d
