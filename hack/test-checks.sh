#!/usr/bin/env bash
# hack/lib/checks.sh, on small suites of its own: failures planted in two sections are both reported and the checks
# after them still run; a check failing in a subshell or a pipeline's loop is not lost; fail() and a command failing
# under set -e stop the run and say where; FF_FAIL_FAST=1 stops at the first; the suite's cleanup runs first, the last
# added first; the Markdown report. Its own assertions are plain, so that a broken library can't pass itself. A second.
#   hack/test-checks.sh
set -euo pipefail
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checks.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
asserted=0
expect() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; asserted=$((asserted + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
# Runs a suite: its exit status, and its output in $work/out and $work/err.
suite() { # <body>, after the library is sourced
  printf '#!/usr/bin/env bash\nset -euo pipefail\nsource %q\n%s\n' "$lib" "$1" >"$work/suite.sh"
  local status=0
  FF_CHECKS_REPORT="${REPORT:-}" bash "$work/suite.sh" >"$work/out" 2>"$work/err" || status=$?
  echo "$status"
}
times() { sed -E 's/  [0-9]{2}:[0-9]{2}:[0-9]{2}  /  hh:mm:ss  /' "$1"; } # failures' times, made comparable

expect "failures in two sections: the run fails" 1 "$(suite '
section "first"
check "one" a a
check "two" a b
check "three" a a
section "second"
check "four" c d
check "five" e e
checks_done planted')"
expect "every check ran, the failed ones too" "== first|  ok   one|  ok   three|== second|  ok   five" \
  "$(paste -sd'|' "$work/out")"
expect "the summary counts both" "planted: 3 checks passed, 2 failed" "$(grep '^planted: .*checks passed' "$work/err")"
expect "and lists them, in order, each with its section" \
  "planted: 2 failed check(s), in order:|  hh:mm:ss  first: two (expected 'a', got 'b')|  hh:mm:ss  second: four (expected 'c', got 'd')" \
  "$(times "$work/err" | sed -n '/failed check(s), in order:/,$p' | paste -sd'|')"

expect "a second failure in the same section is marked as after the first" 1 "$(suite '
section "one section"
check "made" id ""
check "used" ACTIVE ""
checks_done cascade')"
expect "so" "  hh:mm:ss  one section: used (expected 'ACTIVE', got '')  (after the failure above, in the same section)" \
  "$(times "$work/err" | grep 'hh:mm:ss  one section: used')"

expect "a value of several lines is one failure, on one line" "1|planted: 0 checks passed, 1 failed|  hh:mm:ss  before the first section: one (expected 'a', got 'line 1 | line 2')" "$(suite '
check "one" a "$(printf "line 1\nline 2")"
checks_done planted')|$(grep 'checks passed' "$work/err")|$(times "$work/err" | grep 'hh:mm:ss')"

expect "a check failing in a subshell or a pipeline's loop is not lost" "1 2" "$(suite '
section "nested"
( check "in a subshell" x y )
printf "a\n" | while read -r line; do check "in a loop" "$line" b; done
checks_done nested') $(grep -c 'nested: in a' "$work/err")"

expect "fail ends the run" 1 "$(suite '
section "start"
check "before" a a
section "the backend"
fail "the backend did not start"
check "after" a a
checks_done stopped')"
expect "and says where it stopped, and that the checks after it did not run" \
  "suite: the run stopped early, in \"the backend\", at a failure nothing after it can pass without; the checks after it did not run" \
  "$(tail -1 "$work/err")"
expect "the check after it never ran" 0 "$(grep -c 'after' "$work/out" || true)"

expect "a command failing under set -e stops the run too" 1 "$(suite '
section "made"
id="$(false)"
check "after" a a')"
expect "named with its line and command" \
  "suite: the run stopped early, in \"made\", at line 6: id=\"\$(false)\"; the checks after it did not run" \
  "$(tail -1 "$work/err")"

expect "FF_FAIL_FAST=1 stops at the first failed check" "1 0" "$(FF_FAIL_FAST=1 suite '
check "first" a b
check "second" a a
checks_done fast') $(grep -c second "$work/out" || true)"

expect "the suite's cleanup runs at exit, the last added first, its status given, before the list" \
  "1|cleanup second, status 1|cleanup first, status 1|ordered: 1 failed check(s), in order:" "$(suite '
on_exit "echo cleanup first, status \$checks_status >&2"
on_exit "echo cleanup second, status \$checks_status >&2"
check "one" a b
checks_done ordered')|$(grep -E '^cleanup|failed check' "$work/err" | paste -sd'|')"

REPORT="$work/report.md"
expect "the report, in Markdown, for hack/ci.sh and GitHub's summary" 1 "$(suite '
section "a section"
check "one" a b
checks_done reported')"
expect "so" "### reported: 1 failed check(s)|\`\`\`text|  hh:mm:ss  a section: one (expected 'a', got 'b')|\`\`\`" \
  "$(times "$REPORT" | grep -v '^$' | paste -sd'|')"
REPORT=''

expect "a failure fails the run even when the suite ends without checks_done" 1 "$(suite 'check "one" a b')"

expect "all green: it passes and lists nothing" "0|green: 2 checks passed|" "$(suite '
section "fine"
check "one" a a
check "two" b b
checks_done green')|$(cat "$work/out" | tail -1)|$(cat "$work/err")"

echo "checks: $asserted assertions passed"
