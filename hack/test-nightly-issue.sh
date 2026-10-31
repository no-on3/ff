#!/usr/bin/env bash
# hack/lib/nightly-issue.sh against a stand-in gh, which answers from files and records what it was asked: the first
# red night opens the issue with what failed, the next one comments on it, a green night closes it, and a green night
# with no issue open does nothing. In a second or so.
#   hack/test-nightly-issue.sh
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/nightly-issue.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}

mkdir "$work/bin"
cat >"$work/bin/gh" <<'GH'
#!/usr/bin/env bash
# Records each call; answers issue list from issues.json and run view from failed.log; keeps each body it is given.
echo "$*" >>"$GH_WORK/calls"
case "$1 $2" in
  'issue list') cat "$GH_WORK/issues.json" ;;
  'run view') cat "$GH_WORK/failed.log" ;;
  'issue create' | 'issue comment')
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$GH_WORK/body"; shift; done ;;
esac
GH
chmod +x "$work/bin/gh"
# One run of the script: its line of output; the calls to gh go to $work/calls.
run() { # <results JSON>
  : >"$work/calls"
  rm -f "$work/body"
  PATH="$work/bin:$PATH" GH_WORK="$work" RESULTS="$1" RUN_ID=42 RUN_URL=https://example.test/runs/42 "$script"
}
tab=$'\t'
printf '%s\n' "platform${tab}Run hack/ci.sh deps platform${tab}2026-10-30T08:53:50.0966175Z e2e-platform: FAILED. Pods:" \
  "platform${tab}Run hack/ci.sh deps platform${tab}2026-10-30T08:53:50.8758444Z FAILED: FF deployed from deploy/k8s on a cluster of its own (475 s)" \
  "security${tab}Run hack/ci.sh deps security${tab}2026-10-30T08:45:08.9811175Z   FAIL zod <4.6.6: high, a flaw" \
  "security${tab}Run hack/ci.sh deps security${tab}2026-10-30T08:45:08.9856615Z FAILED: BE: no high or critical advisory (1 s)" >"$work/failed.log"
red='{"static": {"result": "success"}, "security": {"result": "failure"}, "cluster": {"result": "success"}, "platform": {"result": "failure"}}'
green='{"static": {"result": "success"}, "security": {"result": "success"}, "platform": {"result": "success"}, "tools": {"result": "skipped"}}'

echo '[{"number": 3, "title": "Something else"}]' >"$work/issues.json"
check "a red night with no issue open opens one, naming the red jobs" "nightly: red (security, platform), issue opened" "$(run "$red")"
check "with its title" "1" "$(grep -c "^issue create --title The nightly run is red --body-file " "$work/calls")"
check "what failed, each line after its job, from hack/ci.sh's FAILED and the suites' FAIL lines" \
  "platform: FAILED: FF deployed from deploy/k8s on a cluster of its own (475 s)|security:   FAIL zod <4.6.6: high, a flaw|security: FAILED: BE: no high or critical advisory (1 s)" \
  "$(sed -n '/^```$/,/^```$/p' "$work/body" | grep -v '^```$' | paste -sd'|')"
check "and the run's page" "1" "$(grep -c '^https://example.test/runs/42$' "$work/body")"

echo '[{"number": 3, "title": "Something else"}, {"number": 7, "title": "The nightly run is red"}]' >"$work/issues.json"
check "the next red night comments on the issue open, and opens no other" "nightly: red (security, platform), issue #7 commented" "$(run "$red")"
check "only that comment" "0 1" "$(grep -c '^issue create' "$work/calls") $(grep -c '^issue comment 7 --body-file ' "$work/calls")"

check "a job cancelled, as one past its time limit is, is red too" "nightly: red (cluster), issue #7 commented" \
  "$(run '{"static": {"result": "success"}, "cluster": {"result": "cancelled"}}')"
: >"$work/failed.log"
check "a red night whose logs can't be read still opens or comments, without the section" "0" \
  "$(run "$red" >/dev/null && grep -c 'What failed' "$work/body")"

check "a green night closes the issue open, a skipped job not counted against it" "nightly: green, issue #7 closed" "$(run "$green")"
check "with the run's page" "1" "$(grep -c '^issue close 7 --comment The nightly run of .* passed: https://example.test/runs/42$' "$work/calls")"

echo '[]' >"$work/issues.json"
check "a green night with no issue open does nothing" "nightly: green|issue list --state open --limit 100 --json number,title" \
  "$(run "$green")|$(cat "$work/calls")"

echo "nightly issue: $passed checks passed"
