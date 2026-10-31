#!/usr/bin/env bash
# Step 5's spike of how a function's versions run, on the dev cluster: FF's backend makes $LATEST's Deployment and
# Service as today, and a version's are made beside them by hand from $LATEST's, as the step-5 plan has a version run
# (pods of its own, a Deployment fn-<id>-v<n> made at its first call and scaled to zero when idle). It measures a
# version's first call from zero, and $LATEST's through FF for comparison; whether $LATEST's Service and Deployment,
# which select the function's pods by its ID alone, take the version's pods for theirs; how FF counts the instances of
# both; and an alias's share, 10 % of the calls to the version, over a thousand calls, once each version's pods have
# a Service of their own. Everything it made goes at the end, the stack's own compose project with it; what it found
# lands in hack/.spike-versions/results.md.
#   hack/spikes/versions/run.sh        # about 2 minutes, the stack and the backend's build included
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_PROJECT=ff-spike-versions
E2E_NAME=spike-versions
port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
FF_PG_PORT="$(port)"
FF_S3_PORT="$(port)"
export FF_PG_PORT FF_S3_PORT
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
results="$work/results.md"

e2e_dependencies
e2e_cluster
e2e_build
be_port="$(free_port)"
api="http://127.0.0.1:$be_port"
account="$(random_account)"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account")
e2e_migrate "${be_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"
ns="$(tenant_namespace "$account")"
e2e_namespaces+=("$ns")
k() { kubectl -n "$ns" "$@"; }
now() { date +%s%3N; }
# One call through the cluster API's service proxy, as the backend makes it: its status; the answer in $work/answer.
proxy() { # <service>
  curl -sS -o "$work/answer" -w '%{http_code}' --cacert "$FF_CA_FILE" -H "Authorization: Bearer $(cat "$FF_SA_TOKEN_FILE")" \
    -H 'content-type: application/json' -X POST --data '{}' \
    "https://127.0.0.1:$FF_API_PORT/api/v1/namespaces/$ns/services/$1:http/proxy/invoke" 2>/dev/null || true
}
# Called until it answers: the calls refused before. Right after a pod is ready, the API server may not yet count it
# among its Service's endpoints, and answers 503.
until_answered() { # <service>
  local refused=0
  until [ "$(proxy "$1")" = 200 ]; do
    refused=$((refused + 1))
    [ "$refused" -lt 100 ] || fail "$1 not answered in 100 calls"
    sleep 0.05
  done
  echo "$refused"
}
calls() { # <n> <latest's service> [<version's service> <weight>]: calls.mjs's line
  API="https://127.0.0.1:$FF_API_PORT" TOKEN_FILE="$FF_SA_TOKEN_FILE" CA_FILE="$FF_CA_FILE" NS="$ns" N="$1" LATEST="$2" \
    VERSION="${3:-}" WEIGHT="${4:-0}" node "$here/calls.mjs"
}
ready() { k get deployment "$1" -o jsonpath='{.status.readyReplicas}'; }
until_ready() { # <deployment> <replicas>
  for _ in $(seq 1 600); do [ "$(ready "$1")" = "$2" ] && return 0; sleep 0.1; done
  fail "$1 did not have $2 ready replicas within 60 s"
}
until_gone() { # <label selector>: no pod left
  for _ in $(seq 1 600); do [ -z "$(k get pods -l "$1" -o name)" ] && return 0; sleep 0.1; done
  fail "pods $1 still there after 60 s"
}
endpoints() { k get endpointslices -l "kubernetes.io/service-name=$1" -o json | jq '[.items[].endpoints[]? | select(.conditions.ready)] | length'; }
until_endpoints() { # <service> <ready endpoints>
  for _ in $(seq 1 300); do [ "$(endpoints "$1")" = "$2" ] && return 0; sleep 0.1; done
  fail "$1 did not have $2 ready endpoints within 30 s"
}
{ echo "# A function's versions on the dev cluster ($(date -u +%F))"; echo
  echo "## A first call from zero (scaled to one, its pod ready, its first answer)"; echo
  echo "| call | ready after | answered after | refused before the answer |"; echo "|---|---|---|---|"; } >"$results"

section "\$LATEST, made by FF, and its first call from zero through FF"
code='export async function handler(event: unknown, context: { functionVersion: string }) {
  return { version: context.functionVersion, pod: process.env.HOSTNAME };
}'
created="$(http_at "$api" POST /functions "$(jq -n --arg code "$code" '{name: "spike-versions", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
check "made" 201 "$(status)"
id="$(jq -r .id <<<"$created")"
name="fn-$id"
check "its Deployment and its Service, both named $name" "$name $name" "$(k get deployment "$name" -o jsonpath='{.metadata.name}') $(k get service "$name" -o jsonpath='{.metadata.name}')"
# At zero before FF has had a call: once it has, its scaler raises a function called within the minute back to one.
k scale deployment "$name" --replicas=0 >/dev/null
until_gone "ff.dev/function-id=$id"
started="$(now)"
invoked="$(http_at "$api" POST "/functions/$id/invoke" '{"input":{}}')"
answered="$(now)"
check "called through FF from zero: \$LATEST answers" "201 \$LATEST" "$(status) $(jq -r .output.version <<<"$invoked")"
echo "| \$LATEST, through FF | | $((answered - started)) ms | |" >>"$results"
echo "  FF's answer: $(jq -c . <<<"$invoked" | cut -c1-300)"
check "the runtime's own answer, through the proxy" 200 "$(proxy "$name")"
echo "  the runtime's own answer: $(cut -c1-300 "$work/answer")"
selector="$(k get deployment "$name" -o jsonpath='{.spec.selector.matchLabels}')"
service_selector="$(k get service "$name" -o jsonpath='{.spec.selector}')"
echo "  \$LATEST's Deployment selects $selector, its Service $service_selector"

section "version 1: a Deployment and a Service of its own, from \$LATEST's, at zero"
# The version's: its name, a version label on it and its pods, in its Deployment's selector and its Service's,
# FUNCTION_VERSION 1; nothing of $LATEST's own status or identity.
k get deployment "$name" -o json | jq --arg name "$name-v1" '
  {apiVersion, kind, metadata: {name: $name, labels: (.metadata.labels + {"ff.dev/version": "1"})}, spec: (.spec
    | .replicas = 0
    | .selector.matchLabels += {"ff.dev/version": "1"}
    | .template.metadata.labels += {"ff.dev/version": "1"}
    | .template.spec.containers[0].env |= map(if .name == "FUNCTION_VERSION" then .value = "1" else . end))}' | k apply -f - >/dev/null
k get service "$name" -o json | jq --arg name "$name-v1" '
  {apiVersion, kind, metadata: {name: $name, labels: (.metadata.labels + {"ff.dev/version": "1"})},
   spec: {ports: .spec.ports, selector: (.spec.selector + {"ff.dev/version": "1"})}}' | k apply -f - >/dev/null
check "made: $name-v1, at zero" "0" "$(k get deployment "$name-v1" -o jsonpath='{.spec.replicas}')"

section "a version's first call from zero"
for try in 1 2 3; do
  k scale deployment "$name-v1" --replicas=0 >/dev/null
  until_gone "ff.dev/version=1"
  started="$(now)"
  k scale deployment "$name-v1" --replicas=1 >/dev/null
  until_ready "$name-v1" 1
  at_ready="$(now)"
  refused="$(until_answered "$name-v1")"
  answered="$(now)"
  echo "| version 1, try $try | $((at_ready - started)) ms | $((answered - started)) ms | $refused |" >>"$results"
  check "try $try: the version's pod answers, as version 1" 1 "$(jq -r .version "$work/answer")"
done

section "\$LATEST's Service and Deployment, which select by the function's ID alone"
k scale deployment "$name-v1" --replicas=1 >/dev/null
until_ready "$name-v1" 1
until_ready "$name" 1
until_endpoints "$name" 2
overlap="$(calls 100 "$name")"
{ echo; echo "## \$LATEST's Service, its selector the function's ID alone, with version 1's pod up"; echo
  echo '```json'; echo "$overlap"; echo '```'; } >>"$results"
check "\$LATEST's Service reaches version 1's pod too" true "$(jq -r '[.answered | keys[] | select(test("-> 1$"))] | length > 0' <<<"$overlap")"
statuses="$(k get deployments -l "ff.dev/function-id=$id" -o json | jq -c '[.items[] | {name: .metadata.name, replicas: .status.replicas, ready: .status.readyReplicas}]')"
pods="$(k get pods -l "ff.dev/function-id=$id" -o json | jq -c '[.items[] | {version: (.metadata.labels["ff.dev/version"] // "none"), owner: .metadata.ownerReferences[0].name}]')"
{ echo; echo "Both Deployments, and the pods their ReplicaSets own:"; echo; echo '```json'; echo "$statuses"; echo "$pods"; echo '```'; } >>"$results"
check "each Deployment keeps its own pod: \$LATEST's selector doesn't take the version's" '[{"name":"'"$name"'","replicas":1,"ready":1},{"name":"'"$name"'-v1","replicas":1,"ready":1}]' "$statuses"

section "the instances, as FF counts them"
# FF counts a function's instances twice over: readyInstances reads the Deployment by its name, $LATEST's alone, and
# readyInstancesByFunction lists FF's Deployments in every namespace and keeps one count per function ID, the last.
listed="$(kubectl get deployments -A -l "app.kubernetes.io/managed-by=ff-controller,ff.dev/function-id=$id" -o json | jq -c '[.items[] | .status.readyReplicas // 0]')"
{ echo; echo "## The instances"; echo
  echo "- ready, both Deployments together: $(jq 'add' <<<"$listed")"
  echo "- FF's readyInstances (the Deployment named $name): $(ready "$name")"
  echo "- FF's readyInstancesByFunction (one per function ID, the last of the list): $(jq 'last' <<<"$listed")"; } >>"$results"
check "FF's own count misses the version's instance" "2 1" "$(jq 'add' <<<"$listed") $(ready "$name")"

section "an alias's share: version 1 for 10 % of the calls, each version behind a Service of its own"
# $LATEST's pods labeled too, and a Service that selects them by it: the label added to its pods' template rolls them.
k patch deployment "$name" --type=json -p '[{"op": "add", "path": "/spec/template/metadata/labels/ff.dev~1version", "value": "latest"}]' >/dev/null
k rollout status deployment "$name" --timeout=120s >/dev/null
k get service "$name" -o json | jq --arg name "$name-latest" '
  {apiVersion, kind, metadata: {name: $name, labels: (.metadata.labels + {"ff.dev/version": "latest"})},
   spec: {ports: .spec.ports, selector: (.spec.selector + {"ff.dev/version": "latest"})}}' | k apply -f - >/dev/null
until_endpoints "$name-latest" 1
until_endpoints "$name-v1" 1
share="$(calls 1000 "$name-latest" "$name-v1" 0.1)"
{ echo; echo "## An alias, 10 % to version 1, over 1,000 calls through the two Services"; echo
  echo '```json'; echo "$share"; echo '```'; } >>"$results"
check "every call answered by the version it was routed to" true \
  "$(jq -r '(.answered | to_entries | all(.key | (test("-latest -> \\$LATEST$") or test("-v1 -> 1$")))) and .failed == 0' <<<"$share")"
# A binomial's 99 % interval around 100 of 1,000: from 76 to 124.
check "the version's share within what chance allows around 10 %" true "$(jq -r '(.routed | to_entries | map(select(.key | endswith("-v1"))) | .[0].value) as $v | $v >= 76 and $v <= 124' <<<"$share")"

echo "the results: $results"
checks_done spike-versions
