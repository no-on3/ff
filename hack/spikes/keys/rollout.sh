#!/usr/bin/env bash
# Step 5's spike of keys that expire, its second part: a function's pods replaced under load, as a renewed key will
# replace them (the plan's D5: the new key written into the function's environment Secret, then its pods replaced
# one at a time, each new one ready before an old one goes). A function at one instance, called without pause by four
# callers (load.mjs) through each of three paths in turn: FF's API; the cluster API's service proxy, as the backend
# calls in development; and the function's Service from a pod in ff-system, as the backend calls in production. Each
# time its environment changes, which takes the path a renewed key will: a new Secret, then the rollout. The calls
# lost are counted, each with its time after the change began. Then the cost: the cluster API's requests during one
# rollout, read from its metrics against a quiet window as long. Everything it made goes at the end, the stack's own
# compose project with it; what it found lands in hack/.spike-keys/rollout.md.
#   hack/spikes/keys/rollout.sh      # about 5 minutes, the stack and the backend's build included
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_PROJECT=ff-spike-keys
E2E_NAME=spike-keys
port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
FF_PG_PORT="$(port)"
FF_S3_PORT="$(port)"
export FF_PG_PORT FF_S3_PORT
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
results="$work/rollout.md"

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
api_requests() { kubectl get --raw /metrics | python3 -I "$here/api_requests.py"; }
# The function's pods, one ready and no other, once a rollout is over and its old pod gone.
until_one_pod() {
  for _ in $(seq 1 600); do
    [ "$(k get pods -l "ff.dev/function-id=$id" -o json | jq '[.items[] | select(.status.containerStatuses[0].ready)] | length') $(k get pods -l "ff.dev/function-id=$id" -o name | wc -l)" = "1 1" ] && return 0
    sleep 0.1
  done
  fail "the function didn't settle at one pod within 60 s"
}
load_pod=spike-keys-load
on_exit "kubectl -n ff-system delete pod/$load_pod configmap/$load_pod --ignore-not-found --wait=false >/dev/null 2>&1"

section "a function at one instance"
code='export async function handler() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { value: process.env.VALUE, pod: process.env.HOSTNAME };
}'
created="$(http_at "$api" POST /functions "$(jq -n --arg code "$code" '{name: "spike-keys", runtime: "nodejs", code: $code, memory: 128, timeout: 5, environment: {VALUE: "first"}}')")"
check "made" 201 "$(status)"
id="$(jq -r .id <<<"$created")"
name="fn-$id"
http_at "$api" PUT "/functions/$id/scaling-config" '{"minInstances": 1, "maxInstances": 1}' >/dev/null
check "kept at one instance" 200 "$(status)"
until_one_pod
kubectl -n ff-system create configmap "$load_pod" --from-file=load.mjs="$here/load.mjs" >/dev/null

# The load by one path, a change of environment 8 s into it, then the load's end: the calls in $work/<path>.jsonl,
# what they came to in $work/<path>.summary.json.
under_load() { # <path>
  local path="$1" pid=
  case "$path" in
    ff) MODE=ff API="$api" FUNCTION="$id" CALLERS=4 SECONDS=30 node "$here/load.mjs" >"$work/ff.jsonl" & pid=$! ;;
    proxy) MODE=proxy API="https://127.0.0.1:$FF_API_PORT" TOKEN_FILE="$FF_SA_TOKEN_FILE" CA_FILE="$FF_CA_FILE" NS="$ns" SERVICE="$name" \
      CALLERS=4 SECONDS=30 node "$here/load.mjs" >"$work/proxy.jsonl" & pid=$! ;;
    direct)
      # From ff-system, labeled as the backend's pods are: the tenant's network policy lets only them call a function.
      jq -n --arg name "$load_pod" --arg target "http://$name.$ns.svc:8080/invoke" '{apiVersion: "v1", kind: "Pod",
        metadata: {name: $name, namespace: "ff-system", labels: {"app.kubernetes.io/name": "ff-backend"}},
        spec: {restartPolicy: "Never", automountServiceAccountToken: false,
          securityContext: {runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: {type: "RuntimeDefault"}},
          volumes: [{name: "load", configMap: {name: $name}}],
          containers: [{name: "load", image: "ff-runtime-nodejs:24-v3", imagePullPolicy: "Never", command: ["node", "/load/load.mjs"],
            env: [{name: "MODE", value: "direct"}, {name: "TARGET", value: $target}, {name: "CALLERS", value: "4"}, {name: "SECONDS", value: "30"}],
            volumeMounts: [{name: "load", mountPath: "/load"}],
            securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}}]}}' |
        kubectl apply -f - >/dev/null
      kubectl -n ff-system wait --for=jsonpath='{.status.phase}'=Running "pod/$load_pod" --timeout=60s >/dev/null ;;
  esac
  sleep 8
  change_started="$(now)"
  http_at "$api" PUT "/functions/$id" "$(jq -n --arg value "$path" '{environment: {VALUE: $value}}')" >/dev/null
  change_answered="$(now)"
  check "$path: the change answered" 200 "$(status)"
  until_one_pod
  rolled_out="$(now)"
  if [ "$path" = direct ]; then
    kubectl -n ff-system wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$load_pod" --timeout=60s >/dev/null
    kubectl -n ff-system logs "$load_pod" >"$work/direct.jsonl"
    kubectl -n ff-system delete pod "$load_pod" --wait=false >/dev/null
  else
    wait "$pid"
  fi
  # Each call's time from the change's start; what failed, grouped; how long the answers took.
  jq -s --arg value "$path" --argjson from "$change_started" --argjson answered "$change_answered" --argjson over "$rolled_out" '
    def ok: (.status // 0) < 300 and (.status // 0) > 0 and (.record == null);
    def ms(p): (sort | .[((length - 1) * p | floor)]);
    {calls: length, lost: (map(select(ok | not)) | length),
     failures: (map(select(ok | not) | {after_ms: (.t - $from), refused,
         what: ((.error // "\(.status) \(.record // .body // "")") + (if .reused then ", on a connection kept alive" else "" end))})
       | group_by(.what) | map({what: .[0].what, count: length, after_ms: (map(.after_ms) | [min, max])})),
     refused_then_answered: (map(select(ok and (.refused // 0) > 0)) | length),
     not_run_then_answered: (map(select(ok and (.notRun // 0) > 0)) | length),
     change_answered_after_ms: ($answered - $from), rolled_out_after_ms: ($over - $from),
     first_new_after_ms: (map(select(ok and .value == $value) | .t - $from) | min),
     last_old_after_ms: (map(select(ok and .value != $value) | .t - $from) | max),
     ms_p50: (map(.ms) | ms(0.5)), ms_p99: (map(.ms) | ms(0.99)), ms_max: (map(.ms) | max)}' "$work/$path.jsonl" >"$work/$path.summary.json"
}

{ echo "# A function's pods replaced under load ($(date -u +%F))"; echo
  echo "One instance, four callers without pause for 30 s, its environment changed 8 s in: a new Secret, then the rollout."; } >"$results"
for path in ff proxy direct; do
  section "replaced under load, called through $path"
  under_load "$path"
  summary="$(cat "$work/$path.summary.json")"
  { echo; echo "## Through $path"; echo; echo '```json'; jq . <<<"$summary"; echo '```'; } >>"$results"
  check "$path: the load ran, and the new environment answered" true "$(jq '.calls > 100 and .first_new_after_ms != null' <<<"$summary")"
  echo "  $(jq -c '{calls, lost, failures: [.failures[] | "\(.count) \(.what)"]}' <<<"$summary")"
done

section "the cost of one rollout, in requests to the cluster's API"
before="$(api_requests)"
started="$(now)"
http_at "$api" PUT "/functions/$id" '{"environment": {"VALUE": "cost"}}' >/dev/null
check "the change answered" 200 "$(status)"
until_one_pod
took=$(( $(now) - started ))
rollout="$(jq -n --argjson a "$before" --argjson b "$(api_requests)" '$b | with_entries(.value -= ($a[.key] // 0)) | with_entries(select(.value > 0))')"
# The same time without a change: every other client's share, which the rollout's own is told from.
before="$(api_requests)"
sleep "$(awk -v ms="$took" 'BEGIN { printf "%.1f", ms / 1000 }')"
quiet="$(jq -n --argjson a "$before" --argjson b "$(api_requests)" '$b | with_entries(.value -= ($a[.key] // 0)) | with_entries(select(.value > 0))')"
own="$(jq -n --argjson r "$rollout" --argjson q "$quiet" '$r | with_entries(.value -= ($q[.key] // 0)) | with_entries(select(.value > 0))')"
{ echo; echo "## One rollout's requests to the cluster's API"; echo
  echo "The change answered and its old pod gone after $took ms; the requests of every client in that time, less a quiet window as long:"
  echo; echo '```json'; jq . <<<"$own"; echo '```'
  echo; echo "In all: $(jq 'add // 0' <<<"$own") requests, against $(jq 'add // 0' <<<"$rollout") with the quiet window's $(jq 'add // 0' <<<"$quiet")."; } >>"$results"
check "the rollout's own requests counted" true "$(jq 'add // 0 | . > 0' <<<"$own")"

echo "the results: $results"
checks_done spike-keys-rollout
