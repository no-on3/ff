#!/usr/bin/env bash
# hack/release.sh with a throwaway key, made here with a password, in place of the release job's: five stand-in builds
# signed and listed, each signature verifying against the public key, latest.json naming the version, the commit and
# each file's SHA-256; and refused, with nothing signed, for a tag that isn't cli/Cargo.toml's version, a build missing
# or differing from its checksum, a wrong password, and a secret key that isn't the public key's other half. The
# password never in the output. In a few seconds.
#   hack/test-release.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo/hack/lib/checks.sh"
work="$(mktemp -d)"
on_exit 'rm -rf "$work"'
minisign="${FF_TOOLS_BIN:-$repo/hack/bin}/minisign"
[ -x "$minisign" ] || fail "minisign is installed (hack/install-tools.sh minisign)"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo/cli/Cargo.toml" | head -1)"
binaries=(ff-linux-x86_64 ff-linux-arm64 ff-windows-x86_64.exe ff-macos-arm64 ff-macos-x86_64)

password="throwaway-$RANDOM-$RANDOM"
printf '%s\n%s\n' "$password" "$password" | "$minisign" -G -p "$work/release.pub" -s "$work/release.key" >/dev/null 2>&1
printf '%s\n%s\n' "$password" "$password" | "$minisign" -G -p "$work/other.pub" -s "$work/other.key" >/dev/null 2>&1
builds() { # a folder of stand-in builds, each with its .sha256 as hack/build-cli.sh writes it
  rm -rf "$work/dist" && mkdir "$work/dist"
  local binary
  for binary in "${binaries[@]}"; do
    printf 'stand-in for %s\n' "$binary" >"$work/dist/$binary"
    (cd "$work/dist" && sha256sum "$binary" >"$binary.sha256")
  done
}
release() { # <tag> [<secret key file>] [<password>]: the script's status; its output in $work/out
  local status=0
  FF_RELEASE_KEY="$(cat "${2:-$work/release.key}")" FF_RELEASE_KEY_PASSWORD="${3:-$password}" \
    FF_RELEASE_PUBLIC_KEY="$work/release.pub" "$repo/hack/release.sh" "$work/dist" "$1" 0123456789ab \
    >"$work/out" 2>&1 || status=$?
  echo "$status"
}
signed() { find "$work/dist" -name '*.minisig' -o -name latest.json -o -name SHA256SUMS | wc -l | tr -d ' '; }

section "a release signed"
builds
check "the files signed, each signature verified" \
  "0 ff $version (0123456789ab): 5 files and latest.json signed in $work/dist, each signature verified" \
  "$(release "ff-v$version") $(cat "$work/out")"
verified=0
for file in "${binaries[@]}" latest.json; do
  "$minisign" -Vqm "$work/dist/$file" -p "$work/release.pub" >/dev/null 2>&1 && verified=$((verified + 1))
done
check "minisign verifies all six against the public key" 6 "$verified"
check "the trusted comment names the file, as minisign signs by default" true \
  "$(grep -E '^trusted comment: timestamp:[0-9]+	file:latest\.json	hashed$' "$work/dist/latest.json.minisig" >/dev/null && echo true || echo false)"
expected_files="$(cd "$work/dist" && for binary in "${binaries[@]}"; do
  jq -n --arg name "$binary" --arg sha "$(sha256sum "$binary" | cut -d' ' -f1)" '{($name): $sha}'
done | jq -cs 'add')"
check "latest.json: the version, the commit, each file's SHA-256" \
  "$(jq -cn --arg version "$version" --argjson files "$expected_files" '{version: $version, commit: "0123456789ab", files: $files}')" \
  "$(jq -c . "$work/dist/latest.json")"
check "SHA256SUMS lists the five, as sha256sum -c reads it" 5 \
  "$(cd "$work/dist" && sha256sum -c SHA256SUMS 2>/dev/null | grep -c ': OK$')"
check "the password never printed" false "$(grep -F "$password" "$work/out" >/dev/null && echo true || echo false)"

section "refused, with nothing signed"
builds
check "a tag that isn't cli/Cargo.toml's version" "1 release refused: the tag ff-v99.0.0 names 99.0.0, and cli/Cargo.toml's version is $version; nothing signed 0" \
  "$(release ff-v99.0.0) $(cat "$work/out") $(signed)"
check "a tag that isn't ff-v<version>" "1 release refused: the tag v$version isn't ff-v<version>; nothing signed" \
  "$(release "v$version") $(cat "$work/out")"
rm "$work/dist/ff-macos-x86_64"
check "a build missing" "1 release refused: ff-macos-x86_64 or its .sha256 is missing from $work/dist; nothing signed 0" \
  "$(release "ff-v$version") $(cat "$work/out") $(signed)"
builds
echo changed >>"$work/dist/ff-linux-arm64"
check "a build that differs from its checksum" "1 release refused: ff-linux-arm64 differs from its .sha256; nothing signed 0" \
  "$(release "ff-v$version") $(cat "$work/out") $(signed)"
builds
check "a wrong password" "1 release refused: minisign couldn't sign ff-linux-x86_64 with FF_RELEASE_KEY: a wrong password, or not a secret key; nothing signed 0" \
  "$(release "ff-v$version" "$work/release.key" wrong) $(cat "$work/out") $(signed)"
check "a secret key that isn't the public key's other half" "1 release refused: ff-linux-x86_64's signature doesn't verify against $work/release.pub: FF_RELEASE_KEY isn't its secret half; nothing signed 0" \
  "$(release "ff-v$version" "$work/other.key") $(cat "$work/out") $(signed)"
check "the tag alone, checked before the builds" "0 ff $version" \
  "$("$repo/hack/release.sh" --check "ff-v$version" >"$work/out" 2>&1 && echo 0 || echo $?) $(cat "$work/out")"
checks_done release
