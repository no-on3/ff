#!/usr/bin/env bash
# hack/lib/ci-steps.sh, on small runs of its own: two failed steps are both reported, the step between them still runs,
# and the run fails; a failed prepare stops the run there; FF_FAIL_FAST=1 stops at the first failure; the cleanups
# run at exit, a stopped run's too; the report's headline, its rows and the suites' checks, and GitHub's summary; a
# run that a command outside any step ended says so. Its own assertions are plain, so that a broken library can't
# pass itself. A second.
#   hack/test-ci-steps.sh
set -euo pipefail
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ci-steps.sh"
work="$(mktemp -d)"
export work # for the runs' own commands
trap 'rm -rf "$work"' EXIT
asserted=0
expect() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; asserted=$((asserted + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
# Runs a pipeline: its exit status, its output in $work/out and $work/err, its report in $work/ci/report.md.
run() { # <body>, after the library is sourced
  rm -rf "$work/ci" && mkdir -p "$work/ci"
  printf '#!/usr/bin/env bash\nset -euo pipefail\nci_dir=%q\nsource %q\nci_stages=planted\n%s\n' "$work/ci" "$lib" "$1" >"$work/run.sh"
  local status=0
  bash "$work/run.sh" >"$work/out" 2>"$work/err" || status=$?
  echo "$status"
}
rows() { sed -n 's/^| \([^|]*\) | \([^|]*\) | [0-9]* |$/\1: \2/p' "$work/ci/report.md" | paste -sd'|'; } # the steps, without their seconds

expect "all green: it passes" 0 "$(run '
step "one" true
step "two" true
ci_done')"
expect "so" "ci: planted passed|## hack/ci.sh planted: passed|one: ok|two: ok" "$(tail -1 "$work/out")|$(head -1 "$work/ci/report.md")|$(rows)"

expect "two failed steps: the run fails" 1 "$(run '
step "lint" false
step "types" true
step "clippy" false
ci_done')"
expect "every step ran, the one between the failures too" "== lint|== types|   ok, 0 s|== clippy" "$(paste -sd'|' "$work/out")"
expect "each failure said as it happens, then both at the end" \
  'FAILED: lint (0 s)|FAILED: clippy (0 s)|ci: planted: 2 step(s) failed: "lint", "clippy"' "$(paste -sd'|' "$work/err")"
expect "the report's headline names both, and its rows each step" \
  '## hack/ci.sh planted: failed at "lint", "clippy"|lint: **FAILED**|types: ok|clippy: **FAILED**' "$(head -1 "$work/ci/report.md")|$(rows)"

expect "a failed prepare stops the run" 1 "$(run '
step "lint" false
prepare "npm ci" false
step "tests" true
ci_done')"
expect "the steps after it don't run" "== lint|== npm ci" "$(paste -sd'|' "$work/out")"
expect "the headline says where it stopped" '## hack/ci.sh planted: failed at "lint", "npm ci"; the run stopped at "npm ci"' \
  "$(head -1 "$work/ci/report.md")"

expect "a prepare that passes lets the run go on" "0|npm ci: ok|tests: ok" "$(run '
prepare "npm ci" true
step "tests" true
ci_done')|$(rows)"

expect "FF_FAIL_FAST=1 stops at the first failed step" "1|== lint" "$(FF_FAIL_FAST=1 run '
step "lint" false
step "types" true
ci_done')|$(paste -sd'|' "$work/out")"

expect "the cleanups run at exit, a stopped run's too" "1|cleaned" "$(run '
ci_cleanups+=("echo cleaned >$work/cleanup")
prepare "the cluster" false
ci_done')|$(cat "$work/cleanup")"

expect "the suites' failed checks follow the steps in the report" "1|### l4: 1 failed check(s)" "$(run '
step "L4" sh -c "echo \"### l4: 1 failed check(s)\" >>\"\$FF_CHECKS_REPORT\"; exit 1"
ci_done')|$(grep '^### ' "$work/ci/report.md")"

expect "on GitHub, the report is the job's summary too" "0|## hack/ci.sh planted: passed" "$(GITHUB_STEP_SUMMARY="$work/summary" run '
step "one" true
ci_done')|$(head -1 "$work/summary")"

expect "a run that a command outside any step ended says so" "3|## hack/ci.sh planted: stopped, exit status 3" "$(run '
step "one" true
exit 3')|$(head -1 "$work/ci/report.md")"

echo "ci steps: $asserted assertions passed"
