#!/usr/bin/env bash
# The install scripts of this machine's system, install.sh or install.ps1, run as a customer runs them against a copy
# of the downloads site served here: a release signed with a throwaway key by hack/release.sh, made a site by
# hack/downloads-site.sh. Installed as is, its signatures checked when minisign is on the machine and said unchecked
# when it isn't; refused, with nothing installed, for a build that differs from latest.json's checksum, a build's
# signature or latest.json's by another key, and the repository's own copy, which names no site. Given a folder of real
# builds, as a build job has some of the five, those are released and stand-ins for the others, and this machine's,
# when it is there, is run once installed. Python's server serves the site, or, with --site, the command given deploys
# it, after each change, to the address given, as the ff suite deploys it to FF. In a second or two.
#   hack/test-install.sh [<builds folder>]      stand-in builds alone without one
#   hack/test-install.sh --site <address> --deploy '<command, given the site's folder last>' [<builds folder>]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo/hack/lib/checks.sh"
source "$repo/hack/lib/ff-builds.sh"
url='' deploy=()
while [ $# -gt 0 ]; do
  case "$1" in
    --site) url="${2%/}"; shift 2 ;;
    --deploy) read -ra deploy <<<"$2"; shift 2 ;;
    *) break ;;
  esac
done
[ "${url:+site}" = "$([ ${#deploy[@]} -eq 0 ] || echo site)" ] || { echo "--site and --deploy go together" >&2; exit 2; }
builds="${1:-}"
unset FF_DOWNLOADS_URL # the scripts' own address, the site's, is what is tested
work="$(mktemp -d)"
on_exit 'rm -rf "$work"'
minisign="${FF_TOOLS_BIN:-$repo/hack/bin}/minisign"
[ -x "$minisign" ] || fail "minisign is installed (hack/install-tools.sh minisign)"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo/cli/Cargo.toml" | head -1)"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# This machine's system, and its build, as the install scripts choose it.
case "$(uname -s)" in
  Linux) system=linux ;;
  Darwin) system=macos ;;
  MINGW* | MSYS*) system=windows ;;
  *) fail "the install scripts are for Linux, macOS and Windows, and this is $(uname -s)" ;;
esac
case "$(uname -m)" in x86_64 | amd64) processor=x86_64 ;; *) processor=arm64 ;; esac
[ "$system" = macos ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && processor=arm64
build="ff-$system-$processor"
[ "$system" = windows ] && build=ff-windows-x86_64.exe

# The release: the builds given or stand-ins, signed with a throwaway key; another key for the signatures refused.
# Keys without a password, whose hashing takes a second at each signature (hack/test-release.sh tests one with).
for key in release other; do
  "$minisign" -G -W -p "$work/$key.pub" -s "$work/$key.key" >/dev/null 2>&1
done
mkdir "$work/release"
for file in "${FF_BUILDS[@]}"; do
  if [ -f "$builds/$file" ]; then cp "$builds/$file" "$work/release/"; else printf 'stand-in for %s\n' "$file" >"$work/release/$file"; fi
  (cd "$work/release" && sha256 "$file" >"$file.sha256")
done
FF_RELEASE_KEY="$(cat "$work/release.key")" FF_RELEASE_PUBLIC_KEY="$work/release.pub" \
  "$repo/hack/release.sh" "$work/release" "ff-v$version" 0123456789ab >/dev/null

# The site: deployed by the command given, or served by Python's own server, which picks a free port and says it.
site="$work/site"
if [ ${#deploy[@]} -eq 0 ]; then
  python=python3
  "$python" -c '' 2>/dev/null || python=python # Windows names it python
  "$python" -u -m http.server 0 --bind 127.0.0.1 --directory "$work" >"$work/server.log" 2>&1 &
  server=$!
  on_exit "kill $server 2>/dev/null"
  for _ in $(seq 50); do
    port="$(sed -n 's/.* port \([0-9]*\) .*/\1/p' "$work/server.log")"
    [ -n "$port" ] && break
    sleep 0.2
  done
  [ -n "$port" ] || fail "Python's server started: $(cat "$work/server.log")"
  url="http://127.0.0.1:$port/site"
fi
FF_RELEASE_PUBLIC_KEY="$work/release.pub" "$repo/hack/downloads-site.sh" "$work/release" "$site" "$url" >/dev/null
# The repository's own copies beside the site's, as a script that names no site.
mkdir "$site/repository"
cp "$repo/cli/release/install.sh" "$repo/cli/release/install.ps1" "$site/repository/"
publish() { # the site as it now is, at its address
  [ ${#deploy[@]} -eq 0 ] || "${deploy[@]}" "$site" >"$work/deployed" 2>&1 || fail "the site deployed: $(cat "$work/deployed")"
}
publish

# minisign on the PATH, or not, as the scripts look for it.
mkdir "$work/with-minisign"
cp "$minisign"* "$work/with-minisign/"
# install <minisign: with|without> [<script's URL>]: the script run as its usage line says, into a prefix of its own,
# $work/prefix: its status and its output's first line, all of it in $work/out. PowerShell's refusal is printed as its
# message alone, as an error's display would wrap it at the window's width.
install() {
  local status=0 script="${2:-$url/install.sh}"
  rm -rf "$work/prefix"
  if [ "$system" = windows ]; then
    local path="$PATH"
    [ "$1" = with ] && path="$work/with-minisign:$PATH"
    script="${2:-$url/install.ps1}"
    PATH="$path" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try {
        & ([scriptblock]::Create((irm '$script'))) -Prefix '$(cygpath -w "$work/prefix")'
      } catch { [Console]::Error.WriteLine(\$_.Exception.Message); exit 1 }" >"$work/out" 2>&1 || status=$?
  else
    local path=/usr/bin:/bin:/usr/sbin:/sbin
    [ "$1" = with ] && path="$work/with-minisign:$path"
    curl -fsSL "$script" | PATH="$path" sh -s -- --prefix "$work/prefix" >"$work/out" 2>&1 || status=$?
  fi
  echo "$status $(tr -d '\r' <"$work/out" | head -1)"
}
installed() { # the file installed: the build's checksum, or none
  local file="$work/prefix/bin/ff"
  [ "$system" = windows ] && file="$work/prefix/bin/ff.exe"
  if [ -f "$file" ]; then sha256 "$file" | cut -d' ' -f1; else echo none; fi
}
expected="$(cut -d' ' -f1 "$work/release/$build.sha256")"
installed_as="$work/prefix/bin/ff"
[ "$system" = windows ] && installed_as="$(cygpath -w "$work/prefix/bin/ff.exe")"

section "$build installed as a customer installs it"
said="$(install with)"
check "installed, both signatures checked" \
  "0 ff $version installed as $installed_as: its SHA-256 is latest.json's, and their signatures are the release key's." \
  "$said"
check "  ... the build itself, the same bytes" "$expected" "$(installed)"
if [ "$system" = windows ]; then
  check "  ... the line that puts its folder in Path" true \
    "$(grep -F "SetEnvironmentVariable('Path', '$(cygpath -w "$work/prefix/bin");'" "$work/out" >/dev/null && echo true || echo false)"
else
  check "  ... runnable, and the line that puts its folder in PATH" "755 true" \
    "$(stat -c %a "$work/prefix/bin/ff" 2>/dev/null || stat -f %Lp "$work/prefix/bin/ff") $(grep -F "export PATH=\"$work/prefix/bin:\$PATH\"" "$work/out" >/dev/null && echo true || echo false)"
fi
if [ -f "$builds/$build" ]; then
  check "  ... and it runs, saying its version" true \
    "$("$work/prefix/bin/ff" version 2>&1 | grep -F "$version" >/dev/null && echo true || echo false)"
fi
said="$(install without)"
check "installed without minisign, saying its signatures weren't checked" \
  "0 ff $version installed as $installed_as: its SHA-256 is latest.json's, and minisign isn't on this machine, so their signatures weren't checked: https://jedisct1.github.io/minisign/." \
  "$said"

section "refused, with nothing installed"
cp "$site/$build" "$work/genuine"
echo changed >>"$site/$build"
publish
changed="$(sha256 "$site/$build" | cut -d' ' -f1)"
check "a build that isn't latest.json's" \
  "1 ff not installed: $build's SHA-256 is $changed, and latest.json's is $expected none" \
  "$(install without) $(installed)"
cp "$work/genuine" "$site/$build"
cp "$site/$build.minisig" "$work/genuine.minisig"
"$minisign" -S -s "$work/other.key" -m "$site/$build" >/dev/null 2>&1
publish
check "a build signed by another key" "1 ff not installed: $build's signature isn't the release key's none" \
  "$(install with) $(installed)"
cp "$work/genuine.minisig" "$site/$build.minisig"
"$minisign" -S -s "$work/other.key" -m "$site/latest.json" >/dev/null 2>&1
publish
check "latest.json signed by another key" "1 ff not installed: latest.json's signature isn't the release key's none" \
  "$(install with) $(installed)"
script=install.sh
[ "$system" = windows ] && script=install.ps1
check "the repository's own copy, which names no site" \
  "1 ff not installed: this copy of $script isn't the downloads site's, which names the site: give FF_DOWNLOADS_URL none" \
  "$(install without "$url/repository/$script") $(installed)"
checks_done install
