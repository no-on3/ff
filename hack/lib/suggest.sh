#!/usr/bin/env bash
# What a change needs before its commit: the stages of hack/ci.sh and the suites' sections that cover the paths it
# changed, read from hack/suggest.map, and the commands that run them in order, one at a time, as a machine others
# share needs: the resource check first, FF_CI_JOBS for the test workers. A suggestion only, which skips nothing:
# GitHub runs every stage on a push, but for one that changes documents alone (hack/lib/changes.sh).
#   hack/ci.sh suggest [<commit>]   the working tree's changes against HEAD, its files not added yet among them; with a
#                                   commit, everything since it too
#   source hack/lib/suggest.sh      for suggest_needs <path> and suggest_commands (what to run, on stdin)
set -euo pipefail

suggest_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suggest_map="$suggest_repo/hack/suggest.map"
# The stages in the order they run; a suite's sections run in its stage's place.
suggest_order=(static unit db security l3 l4 l5 cli images platform tools)
declare -A suggest_suite=([l4]=hack/e2e.sh [l5]=hack/e2e-tenancy.sh [cli]=hack/cli-e2e.sh)

# suggest_needs <path>: what the first line of the map that it matches names; none, and it fails.
suggest_needs() {
  local pattern needs
  while read -r pattern needs; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    # shellcheck disable=SC2254 # the map's pattern, as case reads it
    case "$1" in $pattern) echo "$needs" && return 0 ;; esac
  done <"$suggest_map"
  return 1
}

# suggest_commands: the commands for what stdin names, a stage or <suite>:<sections> a word: the resource check, then
# each stage once, in order, a suite whole when anything needs it whole, else its sections together; stages in a row
# run in one hack/ci.sh.
suggest_commands() {
  local word stage run=()
  local -A whole=() sections=()
  for word in $(cat); do
    case "$word" in
      *:*) stage="${word%%:*}" && sections[$stage]="${sections[$stage]:+${sections[$stage]},}${word#*:}" ;;
      *) whole[$word]=1 ;;
    esac
  done
  echo hack/check-resources.sh
  for stage in "${suggest_order[@]}"; do
    if [ -n "${whole[$stage]:-}" ]; then
      run+=("$stage")
    elif [ -n "${sections[$stage]:-}" ]; then
      [ ${#run[@]} -eq 0 ] || echo "FF_CI_JOBS=${FF_CI_JOBS:-2} hack/ci.sh ${run[*]}"
      run=()
      echo "${suggest_suite[$stage]} --only $(tr ',' '\n' <<<"${sections[$stage]}" | awk '!seen[$0]++' | paste -sd,)"
    fi
  done
  [ ${#run[@]} -eq 0 ] || echo "FF_CI_JOBS=${FF_CI_JOBS:-2} hack/ci.sh ${run[*]}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cd "$suggest_repo"
  base="${1:-HEAD}"
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "suggest: $base is no commit" >&2; exit 2; }
  paths="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)"
  [ -n "$paths" ] || { echo "suggest: nothing changed since $base"; exit 0; }
  needs='' listing=''
  while IFS= read -r path; do
    if found="$(suggest_needs "$path")"; then
      needs+=" $found"
    else
      found="all: not in hack/suggest.map, which a line for it would narrow"
      needs+=" ${suggest_order[*]:0:9}"
    fi
    listing+="  $path: $found"$'\n'
  done <<<"$paths"
  echo "suggest: what the changes since $base need, run one at a time, in this order:"
  suggest_commands <<<"$needs" | sed 's/^/  /'
  echo "each path, and what it needs (hack/suggest.map):"
  printf '%s' "$listing"
  echo "a suggestion only: GitHub runs every stage on a push, but static alone for documents"
fi
