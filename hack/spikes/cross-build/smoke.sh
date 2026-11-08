#!/usr/bin/env bash
# The ff command, built for another system, run on that system: what a customer's first minutes do without an FF to
# reach. Its version, a function's folder made and packaged (the zip's modes as Lambda wants them: 0644, and 0755 for
# a script), a setting saved, a key saved where its owner alone may read it, a completion script. What ff does today:
# where a system differs, the check says what it gives there. Its settings in a folder of its own (FF_CONFIG_DIR),
# never the machine's. ci.yml's cross jobs run it on Windows, macOS and Linux on arm64.
#   hack/spikes/cross-build/smoke.sh <ff binary>
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
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
# A script, executable as a Unix system marks it: ff keeps a file's executable bit in the zip, which Windows hasn't.
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
  if $windows; then
    check "the script is 0644 on Windows, which has no executable bit for ff to read" "run.sh 0o644" "$(grep '^run.sh ' <<<"$modes" || true)"
  else
    check "the script is 0755" "run.sh 0o755" "$(grep '^run.sh ' <<<"$modes" || true)"
  fi
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
  # Who may read it, as its permissions say: ff gives it none of its own on Windows.
  icacls "$(cygpath -w "$credentials")" 2>&1 | sed 's/^/    /' || true
else
  mode="$(stat -c %a "$credentials" 2>/dev/null || stat -f %Lp "$credentials")"
  check "the credentials file is its owner's alone" 600 "$mode"
fi
shell=bash
! $windows || shell=powershell
check "ff completion $shell prints a script" true "$("$ff" completion "$shell" 2>/dev/null | grep -i 'ff' >/dev/null && echo true || echo false)"
checks_done cross-build-smoke
