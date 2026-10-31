#!/usr/bin/env bash
# hack/spikes/lambda/compare.py, which says whether the nightly's latest tools behave as the pinned ones did, on
# recordings of its own: the same run passes; a step that fails now, a refusal that goes through now, an operation
# called or no longer called, a path or a header signed otherwise each fail it; the polls' counts and a paced step's
# outcome, which the tool's pace decides, are notes, and pass. In a second.
#   hack/test-tools-compare.sh
set -euo pipefail
compare="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spikes/lambda/compare.py"
work="$(mktemp -d)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/checks.sh"
on_exit 'rm -rf "$work"'

request() { # <operation> <signed path> <signed headers, comma-separated>
  jq -cn --arg op "$1" --arg path "$2" --arg headers "$3" '{operation: $op, signedPath: $path, signedHeaders: ($headers | split(","))}'
}
step() { jq -cn --arg step "$1" --argjson ok "$2" '{step: $step, ok: $ok, shown: (if $ok then "" else "ResourceConflictException: busy" end)}'; }
# The pinned run: a function made, polled twice, invoked; an update refused while another is in progress.
mkdir "$work/pinned"
{ request CreateFunction twice host,x-amz-date; request GetFunction twice host,x-amz-date; request GetFunction twice host,x-amz-date
  request Invoke twice host,x-amz-date,x-amz-log-type; } >"$work/pinned/tool.requests.jsonl"
{ step "create-function" true; step "invoke" true; step "update during the update" false
  step "invoke while pending" false | jq -c '. + {paced: true}'; } >"$work/pinned/tool.steps.jsonl"
# other <edit>: a copy of the pinned run, changed by the edit (a shell command run in its folder); compare.py's exit
# status, then its lines but the ok one, joined.
other() {
  rm -rf "$work/other" && cp -r "$work/pinned" "$work/other"
  (cd "$work/other" && eval "$1")
  local status=0 out
  out="$(python3 "$compare" "$work/pinned" "$work/other" tool)" || status=$?
  echo "$status $(grep -v '^  ok ' <<<"$out" | sed 's/^  //' | paste -sd'|')"
}

check "the same run: it passes" "0 " "$(other true)"
check "a step that passed fails now: it fails, with what the tool showed" \
  '1 FAIL tool: the step "invoke" fails now: ResourceConflictException: busy' \
  "$(other "sed -i 's/\"step\":\"invoke\",\"ok\":true,\"shown\":\"\"/\"step\":\"invoke\",\"ok\":false,\"shown\":\"ResourceConflictException: busy\"/' tool.steps.jsonl")"
check "a refusal that goes through now: it fails, the tool retrying or skipping it" \
  '1 FAIL tool: the step "update during the update", refused with the pinned version, goes through now: the tool retries or skips the refusal' \
  "$(other "sed -i '3s/\"ok\":false,\"shown\":\"ResourceConflictException: busy\"/\"ok\":true,\"shown\":\"\"/' tool.steps.jsonl")"
check "a paced step let through, and a poll more: notes, and it passes" \
  '0 note tool: the step "invoke while pending" went through this time, as the tool'"'"'s pace decides|note tool: GetFunction 3 times, 2 with the pinned version' \
  "$(other "sed -i '4s/\"ok\":false,\"shown\":\"ResourceConflictException: busy\"/\"ok\":true,\"shown\":\"\"/' tool.steps.jsonl; $(declare -f request); request GetFunction twice host,x-amz-date >>tool.requests.jsonl")"
check "an operation more, and one no longer called: it fails, naming both" '1 FAIL tool: now calls GetFunctionConfiguration|FAIL tool: no longer calls Invoke' \
  "$(other "sed -i 's/\"Invoke\"/\"GetFunctionConfiguration\"/' tool.requests.jsonl")"
check "a path signed once, not twice: it fails" '1 FAIL tool: signs CreateFunction'"'"'s path once, not twice' \
  "$(other "sed -i '1s/\"twice\"/\"once\"/' tool.requests.jsonl")"
check "a header signed more, one less: it fails, naming them" '1 FAIL tool: signs Invoke with other headers: +x-amz-content-sha256, -x-amz-log-type' \
  "$(other "sed -i 's/x-amz-log-type/x-amz-content-sha256/' tool.requests.jsonl")"
check "no steps at all, the run having ended before the flow: it fails" '1 FAIL tool: no steps recorded: the run ended before its flow' \
  "$(other "rm tool.steps.jsonl")"

checks_done tools-compare
