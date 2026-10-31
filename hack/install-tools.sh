#!/usr/bin/env bash
# Installs pinned kubectl and k3d into hack/bin/ (git-ignored) after verifying
# the SHA-256 checksums each project publishes, and the ff command's Rust toolchain
# (cli/rust-toolchain.toml's) through rustup, the PATH's, or one installed into
# hack/.rust/ (git-ignored), rustup-init's checksum verified too; hack/ci.sh uses
# it from there. On request, the AWS tools the tests of AWS's way in and out drive:
# OpenTofu and Terraform's CLI into hack/bin, Terraform's AWS provider, for both,
# into hack/.terraform/mirror (a directory the CLIs install providers from, in
# place of a registry), and the SAM CLI into hack/.sam, cfn-lint inside it. Each
# pinned to a release at least two weeks old when chosen. Idempotent: tools
# already at the pinned version are left alone, and so is a Rust at least as
# recent where there is no rustup to pin it with. Nothing is installed system-wide.
# FF_TOOLS_BIN and FF_SAM_DIR put the binaries and the SAM CLI elsewhere, as the nightly's newest tools go into a
# directory of their own, so that the pinned ones the other stages use stay as they are.
#   hack/install-tools.sh [kubectl] [k3d] [rust]     (all three without an argument)
#   hack/install-tools.sh tofu terraform aws-provider sam, or aws for the four
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.37.1}"
K3D_VERSION="${K3D_VERSION:-v5.9.0}"
# The ff command's toolchain, which rustup uses in cli/; RUSTUP_TOOLCHAIN, rustup's own setting, overrides it.
RUST_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo_root/cli/rust-toolchain.toml")}"
TOFU_VERSION="${TOFU_VERSION:-1.13.1}"
TERRAFORM_VERSION="${TERRAFORM_VERSION:-1.16.6}"
AWS_PROVIDER_VERSION="${AWS_PROVIDER_VERSION:-6.69.1}"
SAM_VERSION="${SAM_VERSION:-1.169.0}"
# The SAM CLI publishes its installers' checksums in its release's notes alone: copied from there, for the version
# pinned. Another version needs SAM_SHA256, from its own release's notes.
declare -A SAM_SHA256S=(
  [1.169.0-linux-amd64]=3e921832e9fb39a6563380afc9855eac6dab163238ef3b2bec4a5ba223e4be8b
  [1.169.0-linux-arm64]=a11352c4288a32cd75bb21eb9eb2cd7f23eb59384aa1224497e8de9862290d33
)
bin_dir="${FF_TOOLS_BIN:-$repo_root/hack/bin}"
sam_dir="${FF_SAM_DIR:-$repo_root/hack/.sam}"
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

# The SHA-256 a project's checksum file gives one of its files: lines of "<sha256>  <file>", the file's name perhaps
# with a path or a leading *.
published_sha256() { # <checksum file's URL> <file name>
  local expected
  expected="$(curl -fsSL --retry 3 "$1" |
    awk -v a="$2" '{ f = $2; sub(/^\*/, "", f); n = split(f, p, "/"); if (p[n] == a) { print $1; exit } }')"
  [ -n "$expected" ] || { echo "no checksum for $2 in $1" >&2; return 1; }
  echo "$expected"
}

unzip_to() { # <zip> <directory>: with unzip, else bsdtar, which keep the files' modes
  mkdir -p "$2"
  if command -v unzip >/dev/null; then
    unzip -q -o "$1" -d "$2"
  elif command -v bsdtar >/dev/null; then
    LC_ALL=C bsdtar -xf "$1" -C "$2"
  else
    echo "unzip or bsdtar is needed to unpack $(basename "$1")" >&2
    return 1
  fi
}

verify() { # <file> <expected sha256>
  local actual
  actual="$(sha256sum "$1" | awk '{ print $1 }')"
  if [ "$actual" != "$2" ]; then
    echo "checksum mismatch for $(basename "$1"): expected $2, got $actual" >&2
    exit 1
  fi
}

install_kubectl() {
  if [ -x "$bin_dir/kubectl" ] && "$bin_dir/kubectl" version --client 2>/dev/null | grep "$KUBECTL_VERSION" >/dev/null; then
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
  if [ -x "$bin_dir/k3d" ] && "$bin_dir/k3d" version 2>/dev/null | grep "k3d version $K3D_VERSION" >/dev/null; then
    echo "k3d $K3D_VERSION already installed"
    return
  fi
  local base="https://github.com/k3d-io/k3d/releases/download/$K3D_VERSION"
  local asset="k3d-$os-$arch" expected
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  expected="$(published_sha256 "$base/checksums.txt" "$asset")"
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

# OpenTofu, the parent plan's default for Terraform's files (MPL).
install_tofu() {
  if [ -x "$bin_dir/tofu" ] && "$bin_dir/tofu" version 2>/dev/null | grep -x "OpenTofu v$TOFU_VERSION" >/dev/null; then
    echo "OpenTofu $TOFU_VERSION already installed"
    return
  fi
  local base="https://github.com/opentofu/opentofu/releases/download/v$TOFU_VERSION"
  local asset="tofu_${TOFU_VERSION}_${os}_${arch}.tar.gz" expected
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  expected="$(published_sha256 "$base/tofu_${TOFU_VERSION}_SHA256SUMS" "$asset")"
  verify "$tmp/$asset" "$expected"
  tar -xzf "$tmp/$asset" -C "$tmp" tofu
  install -m 0755 "$tmp/tofu" "$bin_dir/tofu"
  echo "installed OpenTofu $TOFU_VERSION (sha256 verified)"
}

install_terraform() {
  if [ -x "$bin_dir/terraform" ] && CHECKPOINT_DISABLE=1 "$bin_dir/terraform" version 2>/dev/null | grep -x "Terraform v$TERRAFORM_VERSION" >/dev/null; then
    echo "Terraform $TERRAFORM_VERSION already installed"
    return
  fi
  local base="https://releases.hashicorp.com/terraform/$TERRAFORM_VERSION"
  local asset="terraform_${TERRAFORM_VERSION}_${os}_${arch}.zip" expected
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  expected="$(published_sha256 "$base/terraform_${TERRAFORM_VERSION}_SHA256SUMS" "$asset")"
  verify "$tmp/$asset" "$expected"
  unzip_to "$tmp/$asset" "$tmp/terraform"
  install -m 0755 "$tmp/terraform/terraform" "$bin_dir/terraform"
  echo "installed Terraform $TERRAFORM_VERSION (sha256 verified)"
}

# Terraform's AWS provider, its release's zip as published, in a directory both CLIs install providers from in place of
# a registry (their filesystem mirror's packed layout), under each one's name for it: hashicorp/aws on Terraform's
# registry and on OpenTofu's. hack/.terraform/cli.tfrc tells both to take it from there (TF_CLI_CONFIG_FILE), and to
# unpack it once, into a cache every working directory links to.
install_aws_provider() {
  local mirror="$repo_root/hack/.terraform/mirror" asset="terraform-provider-aws_${AWS_PROVIDER_VERSION}_${os}_${arch}.zip" expected
  local zip="$mirror/registry.terraform.io/hashicorp/aws/$asset"
  aws_provider_config "$mirror"
  if [ -f "$zip" ]; then
    echo "Terraform's AWS provider $AWS_PROVIDER_VERSION already installed"
    return
  fi
  local base="https://releases.hashicorp.com/terraform-provider-aws/$AWS_PROVIDER_VERSION"
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  expected="$(published_sha256 "$base/terraform-provider-aws_${AWS_PROVIDER_VERSION}_SHA256SUMS" "$asset")"
  verify "$tmp/$asset" "$expected"
  mkdir -p "$(dirname "$zip")" "$mirror/registry.opentofu.org/hashicorp/aws"
  install -m 0644 "$tmp/$asset" "$zip"
  ln -f "$zip" "$mirror/registry.opentofu.org/hashicorp/aws/$asset"
  echo "installed Terraform's AWS provider $AWS_PROVIDER_VERSION in hack/.terraform/mirror (sha256 verified)"
}
aws_provider_config() { # <mirror>: the CLIs' configuration, for this checkout's paths
  mkdir -p "$repo_root/hack/.terraform/plugin-cache"
  cat >"$repo_root/hack/.terraform/cli.tfrc" <<EOF
# Written by hack/install-tools.sh: hashicorp/aws from the mirror it fills, any other provider from its registry.
plugin_cache_dir = "$repo_root/hack/.terraform/plugin-cache"
provider_installation {
  filesystem_mirror {
    path    = "$1"
    include = ["registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/aws"]
  }
  direct {
    exclude = ["registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/aws"]
  }
}
EOF
}

# The SAM CLI, from its Linux installer (macOS's is a .pkg, which installs system-wide: not here). cfn-lint comes inside
# it, at the version its own lock pins, and `sam validate --lint` runs it.
install_sam() {
  [ "$os" = linux ] || { echo "the SAM CLI installs here on Linux only; on macOS, from AWS's .pkg" >&2; return 1; }
  if [ -x "$bin_dir/sam" ] && SAM_CLI_TELEMETRY=0 "$bin_dir/sam" --version 2>/dev/null | grep -x "SAM CLI, version $SAM_VERSION" >/dev/null; then
    echo "the SAM CLI $SAM_VERSION already installed"
    return
  fi
  local expected="${SAM_SHA256:-${SAM_SHA256S[$SAM_VERSION-$os-$arch]:-}}" asset
  [ -n "$expected" ] || { echo "no checksum for the SAM CLI $SAM_VERSION: give SAM_SHA256, from its release's notes" >&2; return 1; }
  asset="aws-sam-cli-linux-$([ "$arch" = amd64 ] && echo x86_64 || echo arm64).zip"
  curl -fsSL --retry 3 -o "$tmp/$asset" "https://github.com/aws/aws-sam-cli/releases/download/v$SAM_VERSION/$asset"
  verify "$tmp/$asset" "$expected"
  unzip_to "$tmp/$asset" "$tmp/sam"
  "$tmp/sam/install" --install-dir "$sam_dir" --bin-dir "$bin_dir" --update >/dev/null
  # The installer leaves its link to the current version where it was when the version asked for is one it installed
  # before, as when a laptop goes back from the nightly's newest to the pinned one: the link is this version's.
  ln -sfn "$sam_dir/$SAM_VERSION" "$sam_dir/current"
  SAM_CLI_TELEMETRY=0 "$bin_dir/sam" --version 2>/dev/null | grep -x "SAM CLI, version $SAM_VERSION" >/dev/null ||
    { echo "the SAM CLI in $bin_dir isn't $SAM_VERSION after its install" >&2; return 1; }
  echo "installed the SAM CLI $SAM_VERSION in ${sam_dir#"$repo_root/"}, cfn-lint $(sam_cfn_lint_version) inside it (sha256 verified)"
}
sam_cfn_lint_version() { # the cfn-lint the SAM CLI's installer brought, by its package's metadata
  find "$sam_dir/$SAM_VERSION" -maxdepth 6 -type d -name 'cfn_lint-*.dist-info' 2>/dev/null | head -1 | sed 's/.*cfn_lint-\(.*\)\.dist-info/\1/'
}

[ $# -gt 0 ] || set -- kubectl k3d rust
for tool in "$@"; do
  case "$tool" in
    kubectl | k3d | rust | tofu | terraform | sam) "install_$tool" ;;
    aws-provider) install_aws_provider ;;
    aws) install_tofu; install_terraform; install_aws_provider; install_sam ;;
    *) echo "unknown tool $tool: kubectl, k3d, rust, tofu, terraform, aws-provider, sam, or aws for the last four" >&2; exit 2 ;;
  esac
done
