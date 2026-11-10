#!/usr/bin/env bash
# The update notice's fixtures, made again with new keys: manifests as a release's latest.json, signed by a throwaway
# release key with the trusted comments minisign writes by default, their signing times chosen; the keys' secret
# halves thrown away. Signed in this order of times: replayed.json (99.0.0), then newer.json (98.0.0), then
# current.json (0.0.1, older than any ff).
#   cli/tests/fixtures/update/make.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
minisign="$here/../../../../hack/bin/minisign"
secret="$(mktemp -d)"
trap 'rm -rf "$secret"' EXIT
"$minisign" -G -W -f -p "$here/release.pub" -s "$secret/release.key" >/dev/null
"$minisign" -G -W -f -p "$secret/other.pub" -s "$secret/other.key" >/dev/null
manifest() { # <file> <version>
  printf '{"version":"%s","commit":"0123456789ab","files":{"ff-linux-x86_64":"%064d"}}\n' "$2" 0 >"$here/$1"
}
sign() { # <file> <signing time> [<key>] [<signature file>] [<file named>]
  "$minisign" -S -s "$secret/${3:-release}.key" -m "$here/$1" -x "$here/${4:-$1.minisig}" \
    -t "$(printf 'timestamp:%s\tfile:%s\thashed' "$2" "${5:-latest.json}")" >/dev/null
}
manifest replayed.json 99.0.0
manifest newer.json 98.0.0
manifest current.json 0.0.1
sign replayed.json 1800000000
sign newer.json 1800000100
sign current.json 1800000200
sign newer.json 1800000100 other newer.json.other.minisig
sign newer.json 1800000100 release newer.json.binary.minisig ff-linux-x86_64
