#!/bin/sh
# Installs ff, FF's command, on Linux or macOS, from its downloads site:
#   curl -fsSL https://get.<domain>/install.sh | sh
#   curl -fsSL https://get.<domain>/install.sh | sh -s -- --prefix /usr/local
# It names this machine's system and processor, downloads ff's build for them, checks its SHA-256 against
# latest.json and, when minisign is on the machine, the signatures of both against the release's public key; then
# installs it as <prefix>/bin/ff, ~/.local/bin/ff by default, and says what to add to PATH. When a check fails,
# nothing is installed. The site's copy names the site and holds the public key (hack/downloads-site.sh puts them
# in); FF_DOWNLOADS_URL names another copy of the site, as the tests' own. Everything runs from the last line, so that
# a download cut short runs nothing.

downloads='@downloads@'
public_key='@public-key@'

refuse() {
  echo "ff not installed: $*" >&2
  exit 1
}

usage() {
  echo "usage: install.sh [--prefix <folder>]: ff installed as <folder>/bin/ff, ~/.local/bin/ff by default"
}

# ff's file for this machine, as the release names it: ff-<system>-<processor>.
build_for_this_machine() {
  case "$(uname -s)" in
    Linux) system=linux ;;
    Darwin) system=macos ;;
    MINGW* | MSYS* | CYGWIN*) refuse "on Windows, install.ps1 installs ff, in PowerShell: irm $downloads/install.ps1 | iex" ;;
    *) refuse "ff is built for Linux, macOS and Windows, and this system is $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) processor=x86_64 ;;
    aarch64 | arm64) processor=arm64 ;;
    *) refuse "ff is built for x86_64 and arm64 processors, and this one is $(uname -m)" ;;
  esac
  # A Mac with Apple's processor says x86_64 in a shell that Rosetta runs: its own build is the one it should have.
  if [ "$system" = macos ] && [ "$processor" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
    processor=arm64
  fi
  echo "ff-$system-$processor"
}

fetch() { # <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1" || refuse "$1 couldn't be downloaded"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || refuse "$1 couldn't be downloaded"
  else
    refuse "curl or wget is needed to download it"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    refuse "sha256sum or shasum is needed to check what was downloaded"
  fi
}

# A value of latest.json, as hack/release.sh writes it, its keys and values without commas or braces.
latest() { # <key>
  tr ',{}' '\n\n\n' <"$work/latest.json" | sed -n "s/^ *\"$1\": *\"\([^\"]*\)\" *$/\1/p" | head -1
}

verified() { # <file>: its signature, <file>.minisig, against the release's key
  minisign -Vqm "$1" -P "$public_key" >/dev/null 2>&1
}

main() {
  prefix="$HOME/.local"
  while [ $# -gt 0 ]; do
    case "$1" in
      --prefix) [ $# -ge 2 ] || refuse "--prefix needs a folder"; prefix="$2"; shift 2 ;;
      --prefix=*) prefix="${1#--prefix=}"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; refuse "$1 isn't one of its options" ;;
    esac
  done
  downloads="${FF_DOWNLOADS_URL:-$downloads}"
  downloads="${downloads%/}"
  case "$downloads" in
    @*) refuse "this copy of install.sh isn't the downloads site's, which names the site: give FF_DOWNLOADS_URL" ;;
  esac
  file="$(build_for_this_machine)" || exit 1
  bin="$prefix/bin"

  work="$(mktemp -d)" || refuse "no temporary folder could be made"
  trap 'rm -rf "$work"' EXIT
  fetch "$downloads/latest.json" "$work/latest.json"
  signatures="minisign isn't on this machine, so their signatures weren't checked: https://jedisct1.github.io/minisign/"
  if command -v minisign >/dev/null 2>&1; then
    fetch "$downloads/latest.json.minisig" "$work/latest.json.minisig"
    verified "$work/latest.json" || refuse "latest.json's signature isn't the release key's"
  fi
  version="$(latest version)"
  expected="$(latest "$file")"
  [ -n "$version" ] && [ -n "$expected" ] || refuse "latest.json names no $file"

  fetch "$downloads/$file" "$work/ff"
  actual="$(sha256_of "$work/ff")"
  [ "$actual" = "$expected" ] || refuse "$file's SHA-256 is $actual, and latest.json's is $expected"
  if command -v minisign >/dev/null 2>&1; then
    fetch "$downloads/$file.minisig" "$work/ff.minisig"
    verified "$work/ff" || refuse "$file's signature isn't the release key's"
    signatures="their signatures are the release key's"
  fi

  mkdir -p "$bin" 2>/dev/null && cp "$work/ff" "$bin/.ff.new" 2>/dev/null ||
    refuse "$bin can't be written: give --prefix a folder of yours, or run it as the folder's owner"
  chmod 755 "$bin/.ff.new" && mv -f "$bin/.ff.new" "$bin/ff" || refuse "$bin/ff can't be replaced"
  echo "ff $version installed as $bin/ff: its SHA-256 is latest.json's, and $signatures."
  case ":$PATH:" in
    *":$bin:"*) echo "Run ff --help to begin." ;;
    *) echo "$bin isn't in your PATH: add this line to your shell's profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:
  export PATH=\"$bin:\$PATH\"" ;;
  esac
}

main "$@"
