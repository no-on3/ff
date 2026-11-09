#!/usr/bin/env bash
# The downloads site's folder, made from a release's folder as hack/release.sh leaves it: the builds latest.json names,
# each with its signature; SHA256SUMS; latest.json and its signature; the public key; the install scripts, with the
# site's address and the public key put in; and a page saying how to install, with the key's ID. Refused, with no
# folder made, when a file latest.json names or a signature is missing.
#   hack/downloads-site.sh <release folder> <site folder> <the site's address>
#   FF_RELEASE_PUBLIC_KEY   another public key file than cli/release/minisign.pub, as the tests' throwaway one
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ $# -eq 3 ] || { echo "usage: hack/downloads-site.sh <release folder> <site folder> <the site's address>" >&2; exit 2; }
release=$1 site=$2 address="${3%/}"
public_key="${FF_RELEASE_PUBLIC_KEY:-$repo/cli/release/minisign.pub}"
refuse() { echo "no downloads site made: $*" >&2; exit 1; }

case "$address" in http://* | https://*) ;; *) refuse "the site's address, \"$address\", isn't a URL" ;; esac
[ -f "$public_key" ] || refuse "there is no public key at $public_key"
# minisign's public key file: its ID in the comment's last word, then the key on the second line.
key_id="$(sed -n '1s/.* //p' "$public_key")"
key="$(sed -n 2p "$public_key")"
[ -n "$key_id" ] && [ -n "$key" ] || refuse "$public_key isn't a minisign public key"
for made in latest.json latest.json.minisig SHA256SUMS; do
  [ -f "$release/$made" ] || refuse "$release has no $made: hack/release.sh makes it"
done
version="$(jq -r .version "$release/latest.json")"
files=() # read a line at a time, as macOS's older bash has no mapfile
while IFS= read -r file; do files+=("$file"); done < <(jq -r '.files | keys[]' "$release/latest.json")
[ "${#files[@]}" -gt 0 ] || refuse "latest.json names no file"
for file in "${files[@]}"; do
  [ -f "$release/$file" ] && [ -f "$release/$file.minisig" ] || refuse "$file or its signature is missing from $release"
done
[ ! -e "$site" ] || refuse "$site is there already"

mkdir -p "$site"
for file in "${files[@]}"; do
  cp "$release/$file" "$release/$file.minisig" "$site/"
done
cp "$release/latest.json" "$release/latest.json.minisig" "$release/SHA256SUMS" "$site/"
cp "$public_key" "$site/minisign.pub"
for script in install.sh install.ps1; do
  text="$(<"$repo/cli/release/$script")"
  # The replacements quoted, so that no character of theirs means anything to bash.
  text="${text//@downloads@/"$address"}"
  text="${text//@public-key@/"$key"}"
  printf '%s\n' "$text" >"$site/$script"
done

cat >"$site/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ff $version</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; background: #fff; }
  pre { background: #f2f2f4; padding: .75rem 1rem; overflow-x: auto; }
  code, pre { font: 14px ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8ea; background: #161618; } pre { background: #232326; } a { color: #8ab4ff; } }
</style>
</head>
<body>
<h1>ff $version</h1>
<p>FF's command. On Linux and macOS:</p>
<pre>curl -fsSL $address/install.sh | sh</pre>
<p>On Windows, in PowerShell:</p>
<pre>irm $address/install.ps1 | iex</pre>
<p>Each script checks the build's SHA-256 against <a href="latest.json">latest.json</a> and, when
<a href="https://jedisct1.github.io/minisign/">minisign</a> is on the machine, the signatures against the release's
public key, <a href="minisign.pub">minisign.pub</a>, whose ID is <code>$key_id</code>:</p>
<pre>$key</pre>
<p>A new key would mean installing <code>ff</code> again with these scripts, which this page would say.</p>
<p>The builds: $(for file in "${files[@]}"; do printf '<a href="%s">%s</a> ' "$file" "$file"; done)and their
<a href="SHA256SUMS">SHA256SUMS</a>, each with its signature beside it (<code>.minisig</code>).</p>
</body>
</html>
EOF
echo "the downloads site of ff $version in $site: ${#files[@]} builds, latest.json, the install scripts for $address"
