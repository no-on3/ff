#!/usr/bin/env bash
# The ff command, built for a system, run on that system: what a customer's first minutes do without an FF to reach.
# Its version; a function's folder made and packaged, the zip's modes as Lambda wants them (0755 for a script, 0644
# for the rest), on Windows too, which marks no file as a program; a setting saved; a key saved where its owner alone
# may read it, as its mode says, or on Windows its access list; a completion script. Its settings in a folder of its
# own (FF_CONFIG_DIR), never the machine's. ci.yml's cli-builds jobs run it on each system ff is built for.
#   hack/cli-smoke.sh <ff binary>
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo/hack/lib/checks.sh"
ff="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
chmod +x "$ff" 2>/dev/null || true
scratch="$(mktemp -d)"
on_exit "rm -rf '$scratch'"
export FF_CONFIG_DIR="$scratch/config"
python="$(command -v python3 || command -v python)"
windows=false
[[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]] && windows=true

section "ff on $(uname -s) $(uname -m): $(basename "$ff")"
version="$("$ff" version 2>&1)" && status=0 || status=$?
echo "$version" | sed 's/^/    /'
check "ff version runs" 0 "$status"

(cd "$scratch" && "$ff" init hello --runtime python >/dev/null 2>&1) && status=0 || status=$?
check "ff init makes a function's folder" "0 true" "$status $([ -f "$scratch/hello/function.py" ] && echo true || echo false)"
# A script, marked as a program where the system has such a mark; ff knows it on Windows by its #!.
printf '#!/bin/sh\necho hello\n' >"$scratch/hello/run.sh"
chmod +x "$scratch/hello/run.sh"
(cd "$scratch" && "$ff" package hello --runtime python --zip hello.zip >/dev/null 2>&1) && status=0 || status=$?
check "ff package makes the zip" "0 true" "$status $([ -f "$scratch/hello.zip" ] && echo true || echo false)"
if [ -f "$scratch/hello.zip" ]; then
  modes="$("$python" - "$scratch/hello.zip" <<'EOF'
import sys, zipfile
for entry in zipfile.ZipFile(sys.argv[1]).infolist():
    if not entry.is_dir():
        print(f"{entry.filename} {oct(entry.external_attr >> 16 & 0o777)}")
EOF
)"
  echo "$modes" | sed 's/^/    /'
  check "the script is 0755" "run.sh 0o755" "$(grep '^run.sh ' <<<"$modes" || true)"
  check "the rest are 0644" "" "$(grep -v '^run.sh ' <<<"$modes" | grep -v ' 0o644$' || true)"
fi

"$ff" config set endpoint https://ff.example.invalid >/dev/null 2>&1 && status=0 || status=$?
check "ff config set saves the setting" "0 true" \
  "$status $(grep 'ff.example.invalid' "$FF_CONFIG_DIR/config.toml" >/dev/null 2>&1 && echo true || echo false)"
# A key of the right shape, made here: ff checks its shape alone before it saves it.
key="ffk_0123456789ab_$(printf 'a%.0s' $(seq 43))"
"$ff" config set-token <<<"$key" >/dev/null 2>&1 && status=0 || status=$?
credentials="$FF_CONFIG_DIR/credentials.toml"
check "ff config set-token saves the key" "0 true" "$status $(grep "$key" "$credentials" >/dev/null 2>&1 && echo true || echo false)"
if $windows; then
  # Its access list as icacls lists it, the file's name left out: the user alone, with everything, nothing inherited.
  listed="$(icacls "$(cygpath -w "$credentials")" | tr -d '\r' | sed '/^$/,$d; s/^.*credentials\.toml //; s/^ *//')"
  echo "$listed" | sed 's/^/    /'
  # The user as icacls names it, DOMAIN\name: Git's bash has a whoami of its own, which names the user alone.
  check "the credentials file is its owner's alone" "$(tr '[:upper:]' '[:lower:]' <<<"$USERDOMAIN\\$USERNAME"):(f)" \
    "$(tr '[:upper:]' '[:lower:]' <<<"$listed")"
else
  mode="$(stat -c %a "$credentials" 2>/dev/null || stat -f %Lp "$credentials")"
  check "the credentials file is its owner's alone" 600 "$mode"
fi
shell=bash
! $windows || shell=powershell
check "ff completion $shell prints a script" true "$("$ff" completion "$shell" 2>/dev/null | grep -i 'ff' >/dev/null && echo true || echo false)"
checks_done cli-smoke
