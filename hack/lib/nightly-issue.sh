#!/usr/bin/env bash
# The nightly run's one issue, so that a red night is seen: GitHub itself e-mails only whoever last changed the
# workflow, and six red nights in a row went unseen in October 2026. A run with a failed job opens the issue, or
# comments on the one already open; a green run closes it. .github/workflows/ci.yml's nightly-report job runs it, with:
#   RESULTS          the jobs' results, the workflow's needs context as JSON: {"<job>": {"result": "success"}, ...}
#   RUN_ID, RUN_URL  the run, for its failed jobs' logs and its page
#   GH_TOKEN, GH_REPO  for gh, allowed issues: write and actions: read
#   hack/lib/nightly-issue.sh
set -euo pipefail
title='The nightly run is red'
day="$(date -u +%F)"
# A job that timed out or was stopped is as red as one that failed; one skipped by the run's shape is not.
red="$(jq -r '[to_entries[] | select(.value.result == "failure" or .value.result == "cancelled") | .key] | join(", ")' <<<"$RESULTS")"
open="$(gh issue list --state open --limit 100 --json number,title | jq -r --arg title "$title" '[.[] | select(.title == $title)][0].number // empty')"

if [ -z "$red" ]; then
  if [ -n "$open" ]; then
    gh issue close "$open" --comment "The nightly run of $day passed: $RUN_URL" >/dev/null
    echo "nightly: green, issue #$open closed"
  else
    echo "nightly: green"
  fi
  exit 0
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
# hack/ci.sh names the step that failed ("FAILED: <step>"), and the suites each check ("  FAIL <check>"): those lines
# of the failed jobs' logs, each after its job's name, at most 30.
reasons="$({ gh run view "$RUN_ID" --log-failed 2>/dev/null || true; } | grep -E 'FAILED: |  FAIL ' |
  sed -E 's/^([^\t]*)\t[^\t]*\t[0-9TZ:.-]+ /\1: /' | head -30 || true)"
{
  echo "The nightly run of $day failed: $red."
  echo
  echo "$RUN_URL"
  if [ -n "$reasons" ]; then
    echo
    echo 'What failed, from the logs:'
    echo
    echo '```'
    echo "$reasons"
    echo '```'
  fi
  echo
  echo 'The next green nightly run closes this issue.'
} >"$body"
if [ -n "$open" ]; then
  gh issue comment "$open" --body-file "$body" >/dev/null
  echo "nightly: red ($red), issue #$open commented"
else
  gh issue create --title "$title" --body-file "$body" >/dev/null
  echo "nightly: red ($red), issue opened"
fi
