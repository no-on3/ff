#!/usr/bin/env bash
# hack/check-resources.sh, its limits set so that each case's answer doesn't depend on the machine's: a load above
# its limit is refused and named; MAX_LOAD_FACTOR=off reports the load without refusing on it, as on a CI runner, and
# still checks the memory and the disk. In a second or so.
#   hack/test-check-resources.sh
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-resources.sh"
work="$(mktemp -d)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/checks.sh"
on_exit 'rm -rf "$work"'

guard() { # [<variable>=<value>…]: the guard's exit status, every disk and memory minimum 0 but those given; its output in $work/out
  local status=0
  env MIN_DOCKER_DISK_GB=0 MIN_REPO_DISK_GB=0 MIN_MEM_AVAILABLE_MB=0 "$@" "$script" >"$work/out" 2>&1 || status=$?
  echo "$status"
}
said() { grep -cE "$1" "$work/out" || true; } # <pattern>: the lines of the guard's output that match

# A negative factor makes a limit below any load, the lowest a machine can have.
check "a load above its limit: refused, the limit and the factor named" "1 1" \
  "$(guard MAX_LOAD_FACTOR=-1) $(said '^  - load average [0-9.]+ is above -[0-9]+ \([0-9]+ CPUs x -1\)$')"
check "off: the load reported, not checked, and the run let through" "0 1" \
  "$(guard MAX_LOAD_FACTOR=off) $(said '^resources: OK \(.* \| load [0-9.]+/[0-9]+ cpus, not checked\)$')"
check "off: the memory still checked" "1 1" \
  "$(guard MAX_LOAD_FACTOR=off MIN_MEM_AVAILABLE_MB=999999999) $(said '^  - only [0-9]+MB memory available, need 999999999MB$')"
check "off: the disk still checked" "1 1" \
  "$(guard MAX_LOAD_FACTOR=off MIN_REPO_DISK_GB=999999) $(said '^  - repository filesystem has [0-9]+G free, need 999999G$')"

checks_done check-resources
