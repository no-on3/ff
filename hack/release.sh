#!/usr/bin/env bash
# ff's release files, signed and listed as the release job publishes them. In <folder>, the five builds
# hack/build-cli.sh made, each with its .sha256: each checked against its checksum, then signed with minisign
# (<file>.minisig); SHA256SUMS listing the five; latest.json naming the version, the commit and each file's SHA-256,
# signed too. Every signature is then verified against the public key ff trusts, cli/release/minisign.pub, so that a
# secret key that isn't its other half fails here rather than at a customer's. The tag must be ff-v<version>,
# cli/Cargo.toml's version. Nothing is signed when anything is missing or differs.
#   hack/release.sh <folder> <tag> <commit>
#   hack/release.sh --check <tag>      the tag checked against cli/Cargo.toml alone, before anything is built
#   FF_RELEASE_KEY            the secret key, its file's text, as GitHub's secret holds it; never printed
#   FF_RELEASE_KEY_PASSWORD   its password, when it has one
#   FF_RELEASE_PUBLIC_KEY     another public key file than cli/release/minisign.pub, as the tests' throwaway one
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The files a release holds, one for each system ff is built for (hack/build-cli.sh's names).
BINARIES=(ff-linux-x86_64 ff-linux-arm64 ff-windows-x86_64.exe ff-macos-arm64 ff-macos-x86_64)

refuse() { echo "release refused: $*; nothing signed" >&2; exit 1; }

# The version a tag names, which must be cli/Cargo.toml's.
version_of() {
  local tag=$1 version cargo
  [[ $tag == ff-v* ]] || refuse "the tag $tag isn't ff-v<version>"
  version="${tag#ff-v}"
  cargo="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo/cli/Cargo.toml" | head -1)"
  [ "$version" = "$cargo" ] || refuse "the tag $tag names $version, and cli/Cargo.toml's version is $cargo"
  echo "$version"
}

if [ "${1:-}" = --check ]; then
  echo "ff $(version_of "${2:?a tag}")"
  exit 0
fi
[ $# -eq 3 ] || { echo "usage: hack/release.sh <folder> <tag> <commit>, or --check <tag>" >&2; exit 2; }
folder=$1 tag=$2 commit=$3
version="$(version_of "$tag")"
public_key="${FF_RELEASE_PUBLIC_KEY:-$repo/cli/release/minisign.pub}"
minisign="${FF_TOOLS_BIN:-$repo/hack/bin}/minisign"
[ -x "$minisign" ] || refuse "minisign isn't installed: hack/install-tools.sh minisign"
[ -f "$public_key" ] || refuse "there is no public key at $public_key"
[ -n "${FF_RELEASE_KEY:-}" ] || refuse "FF_RELEASE_KEY holds no secret key"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

for binary in "${BINARIES[@]}"; do
  [ -f "$folder/$binary" ] && [ -f "$folder/$binary.sha256" ] || refuse "$binary or its .sha256 is missing from $folder"
  [ "$(sha256 "$folder/$binary" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$folder/$binary.sha256")" ] ||
    refuse "$binary differs from its .sha256"
done

# The secret key in a file of its own, its owner's alone; what is made goes into a folder of its own, moved beside the
# builds once every signature verifies; both removed however the script ends.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
secret="$work/secret.key"
(umask 077 && printf '%s\n' "$FF_RELEASE_KEY" >"$secret")
mkdir "$work/made"
sign() { # <file> <its signature>: minisign's default trusted comment, which holds the signing time and the file's name
  printf '%s\n' "${FF_RELEASE_KEY_PASSWORD:-}" | "$minisign" -S -s "$secret" -m "$1" -x "$2" >/dev/null 2>&1 ||
    refuse "minisign couldn't sign $(basename "$1") with FF_RELEASE_KEY: a wrong password, or not a secret key"
}

(cd "$folder" && sha256 "${BINARIES[@]}" >"$work/made/SHA256SUMS")
files="{}"
for binary in "${BINARIES[@]}"; do
  files="$(jq -c --arg name "$binary" --arg sha "$(cut -d' ' -f1 "$folder/$binary.sha256")" '. + {($name): $sha}' <<<"$files")"
done
jq -n --arg version "$version" --arg commit "$commit" --argjson files "$files" \
  '{version: $version, commit: $commit, files: $files}' >"$work/made/latest.json"

for binary in "${BINARIES[@]}"; do
  sign "$folder/$binary" "$work/made/$binary.minisig"
done
sign "$work/made/latest.json" "$work/made/latest.json.minisig"
for binary in "${BINARIES[@]}"; do
  "$minisign" -Vqm "$folder/$binary" -x "$work/made/$binary.minisig" -p "$public_key" >/dev/null 2>&1 ||
    refuse "$binary's signature doesn't verify against $public_key: FF_RELEASE_KEY isn't its secret half"
done
"$minisign" -Vqm "$work/made/latest.json" -p "$public_key" >/dev/null 2>&1 ||
  refuse "latest.json's signature doesn't verify against $public_key: FF_RELEASE_KEY isn't its secret half"
mv "$work/made/"* "$folder/"
echo "ff $version ($commit): ${#BINARIES[@]} files and latest.json signed in $folder, each signature verified"
