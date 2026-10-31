#!/usr/bin/env bash
# hack/lib/evidence.sh against the dev cluster: what a failed run leaves behind is collected (the pods, the events,
# a namespace's pods described with their logs, the node's own log, the suite's logs) under hack/.ci/failure/, and
# nothing it can't reach makes it fail, a cluster it can't reach included. In a few seconds.
#   hack/test-evidence.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
source "$FF_REPO_ROOT/hack/lib/checks.sh"
source "$FF_REPO_ROOT/hack/lib/evidence.sh"
work="$(mktemp -d)"
suite="evidence-test-$$"
on_exit "rm -rf \"$work\" \"$FF_REPO_ROOT/hack/.ci/failure/$suite\""
has() { [ -s "$1" ] && echo true || echo false; } # <file>: there, and not empty

section "from the dev cluster"
dir="$(evidence_start "$suite")"
check "a directory of its own, under hack/.ci/failure" "$FF_REPO_ROOT/hack/.ci/failure/$suite true" "$dir $([ -d "$dir" ] && echo true)"
evidence_cluster "$dir" ff-system no-such-namespace
pod="$(kubectl -n ff-system get pods -o jsonpath='{.items[0].metadata.name}')"
check "every pod, and the recent events" "true true true" "$(has "$dir/pods.txt") $(grep -q "$pod" "$dir/pods.txt" && echo true) $(has "$dir/events.txt")"
check "a namespace named: its pods described, each one's log" "true true" \
  "$(has "$dir/namespaces/ff-system/describe.txt") $(has "$dir/namespaces/ff-system/$pod.log")"
check "a namespace that isn't there: nothing, and no failure" false "$([ -e "$dir/namespaces/no-such-namespace" ] && echo true || echo false)"
# Since half an hour ago, where a suite takes since it started: k3s may write nothing in a few seconds.
evidence_started_at="$(date -u -d '-30 minutes' +%FT%TZ)"
evidence_containers "$dir" "k3d-$FF_CLUSTER_NAME-server-0" no-such-container
check "the node's own log, the kubelet's and k3s's lines; none for a container that isn't there" "true false" \
  "$(has "$dir/containers/k3d-$FF_CLUSTER_NAME-server-0.log") $([ -e "$dir/containers/no-such-container.log" ] && echo true || echo false)"

section "the suite's own logs"
mkdir -p "$work/run/sub"
echo 'the backend' >"$work/run/backend.log"
echo 'a body' >"$work/run/body"
echo 'nested' >"$work/run/sub/cache.log"
echo 'a run before' >"$work/run/older.log"
touch -d '-2 hours' "$work/run/older.log"
evidence_started_at="$(date -u -d '-1 minute' +%FT%TZ)"
evidence_logs "$dir" "$work/run"
check "its .log files written during the run, nothing else, an older run's not" "backend.log cache.log" "$(cd "$dir/logs" && ls | paste -sd' ')"

section "what it can't reach"
dir="$(evidence_start "$suite")"
check "a new start empties the directory" "" "$(ls -A "$dir")"
status=0
KUBECONFIG=/nonexistent evidence_cluster "$dir" ff-system || status=$?
check "a cluster it can't reach: the files say so, and it doesn't fail" "0 true" "$status $(has "$dir/pods.txt")"
check "and it says where the run's evidence is" \
  "$suite: what the run left behind is in hack/.ci/failure/$suite: pods, events, logs (hack/.ci/report.md lists the failed checks)" \
  "$(evidence_done "$dir" "$suite" 2>&1)"

checks_done evidence
