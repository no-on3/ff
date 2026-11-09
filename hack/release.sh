#!/usr/bin/env bash
# ff's release files, signed and listed as the release job publishes them. In <folder>, the five builds
# hack/build-cli.sh made, each with its .sha256: each checked against its checksum, then signed with minisign
# (<file>.minisig); SHA256SUMS listing the five; latest.json naming the version, the commit and each file's SHA-256,
# signed too. Every signature is then verified against the public key ff trusts, cli/release/minisign.pub, so that a
# secret key that isn't its other half fails here rather than at a customer's. The tag must be ff-v<version>,
# cli/Cargo.toml's version. The runtime images' archives the manifest names (hack/runtime-images.sh), under images/ in
# the folder, are signed and listed too. Nothing is signed when anything is missing or differs.
#   hack/release.sh <folder> <tag> <commit>
#   hack/release.sh --check <tag>      before anything is built: the tag against cli/Cargo.toml, and the public key there
#   FF_RELEASE_KEY            the secret key, its file's text, as GitHub's secret holds it; never printed
#   FF_RELEASE_KEY_PASSWORD   its password, when it has one
#   FF_RELEASE_PUBLIC_KEY     another public key file than cli/release/minisign.pub, as the tests' throwaway one
#   FF_RUNTIME_IMAGES         the runtime images' manifest, which the release's builds hold: its archives signed too
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo/hack/lib/ff-builds.sh"

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

public_key="${FF_RELEASE_PUBLIC_KEY:-$repo/cli/release/minisign.pub}"
public_key_there() {
  [ -f "$public_key" ] || refuse "there is no public key at $public_key: the guide's \"A release of ff\" makes one"
}
if [ "${1:-}" = --check ]; then
  version="$(version_of "${2:?a tag}")"
  public_key_there
  echo "ff $version"
  exit 0
fi
[ $# -eq 3 ] || { echo "usage: hack/release.sh <folder> <tag> <commit>, or --check <tag>" >&2; exit 2; }
folder=$1 tag=$2 commit=$3
version="$(version_of "$tag")"
minisign="${FF_TOOLS_BIN:-$repo/hack/bin}/minisign"
[ -x "$minisign" ] || refuse "minisign isn't installed: hack/install-tools.sh minisign"
public_key_there
[ -n "${FF_RELEASE_KEY:-}" ] || refuse "FF_RELEASE_KEY holds no secret key"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

for binary in "${FF_BUILDS[@]}"; do
  [ -f "$folder/$binary" ] && [ -f "$folder/$binary.sha256" ] || refuse "$binary or its .sha256 is missing from $folder"
  [ "$(sha256 "$folder/$binary" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$folder/$binary.sha256")" ] ||
    refuse "$binary differs from its .sha256"
done
archives=() # the runtime images' archives, by their paths in the folder, as the site serves them
if [ -n "${FF_RUNTIME_IMAGES:-}" ]; then
  listed="$(jq -rb '.[].archive' <<<"$FF_RUNTIME_IMAGES" 2>/dev/null)" ||
    refuse "FF_RUNTIME_IMAGES isn't the manifest hack/runtime-images.sh makes"
  while IFS= read -r archive; do
    case "$archive" in images/*/* | images/.* | */../*) refuse "FF_RUNTIME_IMAGES names $archive, not a file of images/" ;; esac
    case "$archive" in images/?*.tar.gz) ;; *) refuse "FF_RUNTIME_IMAGES names $archive, not a file of images/" ;; esac
    [ -f "$folder/$archive" ] || refuse "$archive, which FF_RUNTIME_IMAGES names, is missing from $folder"
    archives+=("$archive")
  done <<<"$listed"
fi

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

(cd "$folder" && sha256 "${FF_BUILDS[@]}" ${archives[@]+"${archives[@]}"} >"$work/made/SHA256SUMS")
files="{}" # jq -b: lines ending as Unix's on Windows too, whose jq ends them with CR LF
for binary in "${FF_BUILDS[@]}"; do
  files="$(jq -bc --arg name "$binary" --arg sha "$(cut -d' ' -f1 "$folder/$binary.sha256")" '. + {($name): $sha}' <<<"$files")"
done
jq -bn --arg version "$version" --arg commit "$commit" --argjson files "$files" \
  '{version: $version, commit: $commit, files: $files}' >"$work/made/latest.json"

for binary in "${FF_BUILDS[@]}"; do
  sign "$folder/$binary" "$work/made/$binary.minisig"
done
for archive in ${archives[@]+"${archives[@]}"}; do
  mkdir -p "$work/made/images"
  sign "$folder/$archive" "$work/made/$archive.minisig"
done
sign "$work/made/latest.json" "$work/made/latest.json.minisig"
for binary in "${FF_BUILDS[@]}"; do
  "$minisign" -Vqm "$folder/$binary" -x "$work/made/$binary.minisig" -p "$public_key" >/dev/null 2>&1 ||
    refuse "$binary's signature doesn't verify against $public_key: FF_RELEASE_KEY isn't its secret half"
done
for archive in ${archives[@]+"${archives[@]}"}; do
  "$minisign" -Vqm "$folder/$archive" -x "$work/made/$archive.minisig" -p "$public_key" >/dev/null 2>&1 ||
    refuse "$archive's signature doesn't verify against $public_key: FF_RELEASE_KEY isn't its secret half"
done
"$minisign" -Vqm "$work/made/latest.json" -p "$public_key" >/dev/null 2>&1 ||
  refuse "latest.json's signature doesn't verify against $public_key: FF_RELEASE_KEY isn't its secret half"
if [ -d "$work/made/images" ]; then # beside their archives, in the folder's images/
  mv "$work/made/images/"* "$folder/images/"
  rmdir "$work/made/images"
fi
mv "$work/made/"* "$folder/"
said="${#FF_BUILDS[@]} files"
[ "${#archives[@]}" -eq 0 ] || said="$said, ${#archives[@]} runtime images' archives"
echo "ff $version ($commit): $said and latest.json signed in $folder, each signature verified"
