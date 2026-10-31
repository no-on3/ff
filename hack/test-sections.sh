#!/usr/bin/env bash
# hack/lib/sections.sh, on small suites of its own: what a section leaves, variables, arrays and functions, reaches the
# sections after it, a value changed again too; one that stops, at a failed command or at fail(), stops alone, recorded at its line, the sections
# that need it not run, the others run, and the cleanup it asked for still runs; --only runs a section and what it
# needs, --from one and those after it, --list names them with the last run's times; FF_FAIL_FAST=1 stops at the first.
# Its own assertions are plain, so that a broken library can't pass itself. A few seconds.
#   hack/test-sections.sh
set -euo pipefail
hack="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
asserted=0
expect() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; asserted=$((asserted + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
# Runs a suite of sections with the given arguments: its exit status, its output in $work/out and $work/err.
suite() { # <sections, defined and registered> [argument...]
  local body=$1 status=0
  shift
  mkdir -p "$work/run"
  rm -f "$work/run/cleanups"
  printf '#!/usr/bin/env bash\nset -euo pipefail\nwork=%q\nsource %q\nsource %q\nsections_options "$@"\n%s\nsections_run\nchecks_done toy\n' \
    "$work/run" "$hack/lib/checks.sh" "$hack/lib/sections.sh" "$body" >"$work/suite.sh"
  bash "$work/suite.sh" "$@" >"$work/out" 2>"$work/err" || status=$?
  echo "$status"
}
times() { sed -E 's/  [0-9]{2}:[0-9]{2}:[0-9]{2}  /  hh:mm:ss  /' "$1"; } # failures' times, made comparable

# Four sections, the second needing the first, the fourth the second; what the first leaves, the others use.
made='
made() {
section "made"
id=fn-1
tricky="$(printf "a \"b\"\n\$c \\\\d")"
names=(a b)
declare -gA by=([a]=1)
helper() { echo "helped $1"; }
e2e_cleanups+=("echo cleaned >>$work/cleanups")
check "made it" fn-1 "$id"
}'
rest='
used() {
section "used"
check "its variable" fn-1 "$id"
check "its array and map" "a b 1" "${names[*]} ${by[a]}"
check "its function" "helped x" "$(helper x)"
check "its value with quotes, a newline, a dollar and a backslash" "$(printf "a \"b\"\n\$c \\\\d")" "$tricky"
id=fn-2
}
alone() {
section "alone"
check "needs nothing" a a
}
again() {
section "again"
check "a value changed by the section it needs" fn-2 "$id"
}
e2e_cleanups=()
on_exit '\''for c in "${e2e_cleanups[@]}"; do eval "$c"; done'\''
section_def made made
section_def used used made
section_def alone alone
section_def again again used
'
toy="$made$rest"

expect "a whole run passes" 0 "$(suite "$toy")"
expect "what the first section left reached the next: every check passed, counted across the sections" \
  "toy: 7 checks passed" "$(tail -1 "$work/out")"
expect "a cleanup a section asked for ran at the end" cleaned "$(cat "$work/run/cleanups")"

expect "--only runs a section and what it needs, in the suite's order" 0 "$(suite "$toy" --only used)"
expect "so" "sections: made used, of 4|== made|== used" "$(grep -E '^(sections|==)' "$work/out" | paste -sd'|')"
expect "--from runs one and those after it, with what they need" 0 "$(suite "$toy" --from used)"
expect "so" "made used alone again" "$(sed -n 's/^sections: \(.*\), of 4$/\1/p' "$work/out")"
expect "an unknown section is refused, naming those there are" "2|no section nope; the sections: made used alone again" \
  "$(suite "$toy" --only nope)|$(tail -1 "$work/err")"
expect "--list names each section with its title, its last time and what it needs" 0 "$(suite "$toy" --list)"
# A section's seconds are whole ones, its start's and its end's: one of a few milliseconds can cross a second.
expect "so" "made N s made|used N s used (needs: made)|alone N s alone|again N s again (needs: used)" \
  "$(tr -s ' ' <"$work/out" | sed -E 's/^([a-z]+) [0-9]+ s /\1 N s /' | paste -sd'|')"

# The first section asks for a cleanup, then stops: at a failed command, or at fail().
stopping='
made() {
section "made"
check "before" a a
e2e_cleanups+=("echo cleaned >>$work/cleanups")
id="$(false)"
check "after, never run" a a
}'"$rest"
expect "a section that stops at a failed command fails the run" 1 "$(suite "$stopping")"
expect "but stops alone: the section that needs nothing ran" "== made|  ok   before|== used|== alone|  ok   needs nothing|== again" \
  "$(paste -sd'|' "$work/out")"
expect "its stop is recorded at its line, and the section that needs it as not run" \
  "  hh:mm:ss  made: the section stopped at line 12, at \`id=\"\$(false)\"\` (exit 1): its checks after it did not run|  hh:mm:ss  used: not run: it needs made, which stopped or did not run|  hh:mm:ss  again: not run: it needs used, which stopped or did not run" \
  "$(times "$work/err" | grep 'hh:mm:ss' | paste -sd'|')"
expect "and the cleanup it asked for before it stopped still ran" cleaned "$(cat "$work/run/cleanups")"

failing="${stopping/id=\"\$(false)\"/fail \"no function\"}"
expect "fail() stops its section alone too, the section that needs nothing run" "1 1" "$(suite "$failing") $(grep -c 'needs nothing' "$work/out")"
expect "recorded once, as fail() says it" "  hh:mm:ss  made: no function|  hh:mm:ss  used: not run: it needs made, which stopped or did not run|  hh:mm:ss  again: not run: it needs used, which stopped or did not run" \
  "$(times "$work/err" | grep 'hh:mm:ss' | paste -sd'|')"

expect "FF_FAIL_FAST=1 stops the run at the section that stopped" "1 0" \
  "$(FF_FAIL_FAST=1 suite "$stopping") $(grep -c '^== alone' "$work/out" || true)"

echo "test-sections: $asserted assertions passed"
