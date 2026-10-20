#!/usr/bin/env bash
# P-41 spike (client-readiness plan, D10): the log pipeline, measured on the k3d dev cluster. For each collector,
# Vector then Fluent Bit, one at a time, with a fresh VictoriaLogs:
#   - the delay from a call's lines to a query finding them all, for Node.js and Python functions;
#   - each line's request ID, from the runtimes' START, END and REPORT lines;
#   - the collector's and the store's CPU and memory, idle and while a function floods its log;
#   - the per-namespace rate limit: one namespace floods, the other's lines all arrive;
#   - a long line cut; one account's logs deleted, the other's kept; retention at ingestion.
# The functions run on a backend of its own in development mode (the e2e stack, compose project ff-logging-spike),
# in two accounts, so two tenant namespaces. Everything it starts is removed on exit, the e2e stack's way, and so are
# the spike's namespace, cluster roles and the collectors' files on the node. Results: hack/.e2e/logging-spike/results.md.
#   hack/spikes/p41-logging/run.sh            LIMIT=200 (lines a second per namespace) RUNS=10 (calls per runtime)
#                                             COLLECTORS="vector fluent-bit" VECTOR_DEFAULT_LINES=0
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../k8s" && pwd)/env.sh"
E2E_PROJECT=ff-logging-spike
E2E_NAME=e2e/logging-spike
export FF_PG_PORT="${FF_SPIKE_PG_PORT:-55437}" FF_S3_PORT="${FF_SPIKE_S3_PORT:-59008}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"

spike="$FF_REPO_ROOT/hack/spikes/p41-logging"
LIMIT="${LIMIT:-200}"
RUNS="${RUNS:-10}"
node_name="k3d-$FF_CLUSTER_NAME-server-0"
results="$work/results.md"
vl=""

spike_cleanup() {
  kubectl delete namespace ff-logging-spike --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || true
  kubectl delete clusterrolebinding,clusterrole ff-logging-spike-vector ff-logging-spike-fluent-bit --ignore-not-found >/dev/null 2>&1 || true
  docker exec "$node_name" rm -rf /var/lib/ff-logging-spike >/dev/null 2>&1 || true
}
on_exit() {
  local status=$?
  set +e # a failing step here must not stop the cleanup
  if [ "$status" -ne 0 ] && kubectl get namespace ff-logging-spike >/dev/null 2>&1; then
    # What the collector and the store said, before they go.
    kubectl -n ff-logging-spike logs --all-containers --prefix --tail=80 -l 'app in (vector, fluent-bit)' >"$work/collector.log" 2>&1 || true
    kubectl -n ff-logging-spike logs --tail=40 statefulset/victoria-logs >"$work/victoria-logs.log" 2>&1 || true
    echo "the collector's last lines ($work/collector.log):" >&2
    tail -30 "$work/collector.log" >&2 || true
  fi
  spike_cleanup
  (exit "$status")
  e2e_cleanup
}
trap on_exit EXIT
spike_cleanup # a previous run cut short

now_ms() { date +%s%3N; }
# vl_query <LogsQL>: the matching lines, as JSON lines; a failed query stops the run, never reads as no lines.
vl_query() { curl -sS --fail --get "$vl/select/logsql/query" --data-urlencode "query=$1" || fail "VictoriaLogs did not answer the query: $1"; }
# vl_count <LogsQL>: how many lines match.
vl_count() { vl_query "$1 | stats count() as n" | jq -r '.n // "0"'; }
# usage <container>: "<CPU time so far, ms> <memory in use, MiB>" of a container on the node, from crictl.
usage() {
  docker exec "$node_name" crictl stats -o json --label "io.kubernetes.container.name=$1" |
    jq -r '.stats[0] | "\((.cpu.usageCoreNanoSeconds.value | tonumber) / 1e6 | floor) \((.memory.workingSetBytes.value | tonumber) / 1048576 | floor)"'
}

echo "== the stack: PostgreSQL, S3, the backend in development mode"
e2e_dependencies
e2e_cluster
e2e_build
e2e_migrate "${e2e_base_env[@]}"
account_a="$(random_account)"
account_b="$(random_account)"
ns_a="$(tenant_namespace "$account_a")"
ns_b="$(tenant_namespace "$account_b")"
e2e_namespaces+=("$ns_a" "$ns_b")
api="http://127.0.0.1:$(free_port)"
e2e_start_backend "$work/backend.log" "$api" "${e2e_base_env[@]}" PORT="${api##*:}" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a"
as_a() { http_at "$api" "$@"; }
as_b() { http_at "$api" "$1" "$2" "${3:-}" -H "X-FF-Dev-Account: $account_b"; }

# Each user line carries its call's request ID in its text: the call's lines are found whether or not the collector tagged them.
node_code='export async function handler(event: { body: { lines?: number; long?: number } }, context: { awsRequestId: string }) {
  console.log(`spike line one ${context.awsRequestId}`);
  console.log(`spike line two ${context.awsRequestId}`);
  for (let i = 0; i < (event.body.lines ?? 0); i++) console.log(`flood ${i}`);
  if (event.body.long) console.log("x".repeat(event.body.long));
  return { requestId: context.awsRequestId };
}'
python_code='def handler(event, context):
    print(f"spike line one {context.aws_request_id}")
    print(f"spike line two {context.aws_request_id}")
    return {"requestId": context.aws_request_id}'
deploy() { # <as_a|as_b> <name> <runtime> <code>: the function's ID
  local created
  created="$("$1" POST /functions "$(jq -cn --arg name "$2" --arg runtime "$3" --arg code "$4" '{name: $name, runtime: $runtime, code: $code, memory: 128, timeout: 30}')")"
  [ "$(status)" = 201 ] || fail "deploying $2: $(status) $created"
  jq -r .id <<<"$created"
}
node_a="$(deploy as_a spike-node nodejs "$node_code")"
python_a="$(deploy as_a spike-python python "$python_code")"
node_b="$(deploy as_b spike-node-b nodejs "$node_code")"
echo "  account A $account_a ($ns_a): node $node_a, python $python_a; account B $account_b ($ns_b): node $node_b"
invoke() { # <as_a|as_b> <function> [input]: the call's request ID
  local out input="${3:-}"
  [ -n "$input" ] || input='{}'
  out="$("$1" POST "/functions/$2/invoke" "{\"input\": $input}")"
  [ "$(status)" = 201 ] || fail "invoking $2: $(status) $out"
  jq -r .id <<<"$out"
}

{
  echo "# P-41 spike results ($(date -u +%F))"
  echo
  echo "VictoriaLogs v1.53.0; Vector 0.58.0; Fluent Bit 5.1.3; k3d $(k3d version -o json 2>/dev/null | jq -r '.k3d // "?"' || echo '?'), one node; limit $LIMIT lines a second per namespace; $RUNS calls per runtime."
  echo
  echo "| | Vector | Fluent Bit |"
  echo "|---|---|---|"
} >"$results"
declare -A row

measure() { # <collector>: one phase, its results in row[<measure>|<collector>]
  local collector=$1 manifest pid ns
  echo "== $collector: fresh function pods and a fresh VictoriaLogs, then $collector"
  # New pods write new log files: no collector reads another phase's lines again.
  for ns in "$ns_a" "$ns_b"; do kubectl -n "$ns" delete pods -l ff.dev/function-id --wait=true --timeout=60s >/dev/null; done
  for ns in "$ns_a" "$ns_b"; do kubectl -n "$ns" rollout status deployment --timeout=180s >/dev/null || fail "the functions in $ns did not come back"; done
  kubectl apply -f "$spike/victorialogs.yaml" >/dev/null
  kubectl -n ff-logging-spike rollout status statefulset/victoria-logs --timeout=180s >/dev/null || fail "VictoriaLogs did not start"
  local port
  port="$(free_port)"
  kubectl -n ff-logging-spike port-forward svc/victoria-logs "$port:9428" >"$work/port-forward.log" 2>&1 &
  pid=$!
  e2e_pids+=("$pid")
  vl="http://127.0.0.1:$port"
  for _ in $(seq 1 30); do curl -sf -o /dev/null "$vl/health" && break; sleep 0.5; done
  curl -sf -o /dev/null "$vl/health" || fail "VictoriaLogs is not reachable through the port-forward ($(cat "$work/port-forward.log"))"

  manifest="$(sed -e "s|__LIMIT__|$LIMIT|g" \
    -e "s|__NAMESPACES__|[\"$ns_a\", \"$ns_b\"]|g" \
    -e "s|__PATHS__|/var/log/containers/*_${ns_a}_function-*.log,/var/log/containers/*_${ns_b}_function-*.log|g" \
    "$spike/$collector.yaml")"
  # VECTOR_DEFAULT_LINES=1: Vector's default line handling, which drops a merged line over 32 KiB, for comparison.
  if [ "$collector" = vector ] && [ "${VECTOR_DEFAULT_LINES:-0}" = 1 ]; then manifest="$(grep -v 'max_merged_line_' <<<"$manifest")"; fi
  kubectl apply -f - <<<"$manifest" >/dev/null
  kubectl -n ff-logging-spike rollout status "daemonset/$collector" --timeout=180s >/dev/null || fail "$collector did not start"

  echo "  waiting for the first call's lines"
  local first started
  first="$(invoke as_a "$node_a")"
  started=$(now_ms)
  until [ "$(vl_count "~\"$first\"")" -ge 5 ]; do
    if [ $(($(now_ms) - started)) -ge 90000 ]; then
      vl_query '* | sort by (_time) | limit 100' | jq -c '{t: ._time, ns: .namespace, pod: .pod, id: .request_id, m: ._msg}' >"$work/store.json"
      echo "the store's lines ($work/store.json):" >&2
      cut -c1-220 "$work/store.json" >&2
      fail "$collector: not all 5 lines of $first after 90 s; the store has $(vl_count '*') lines, by namespace: $(vl_query '* | stats by (namespace) count() as n' | jq -rc '[.namespace, .n]' | tr '\n' ' ')"
    fi
    sleep 0.2
  done
  row["first|$collector"]="$(( ($(now_ms) - started) ))"

  echo "  the delay, and each call's lines with its request ID ($RUNS calls a runtime)"
  local delays=() fn id t0 runtime tagged late
  declare -A full=([node]=0 [python]=0) after=([node]=0 [python]=0)
  for _ in $(seq 1 "$RUNS"); do
    for fn in "$node_a" "$python_a"; do
      runtime=node
      [ "$fn" = "$python_a" ] && runtime=python
      id="$(invoke as_a "$fn")"
      t0=$(now_ms)
      # All 5 of the call's lines collected: START, END and REPORT name the call, and so do the user lines' texts.
      until [ "$(vl_count "~\"$id\"")" -ge 5 ]; do
        [ $(($(now_ms) - t0)) -lt 30000 ] || break
        sleep 0.1
      done
      delays+=($(($(now_ms) - t0)))
      tagged="$(vl_count "request_id:=\"$id\"")"
      [ "$tagged" = 5 ] && full[$runtime]=$((full[$runtime] + 1))
      # The user lines written after the call's END line, which a tag from START to REPORT can miss.
      late="$(vl_query "~\"$id\" | sort by (_time)" | jq -s 'map(._msg) | (map(startswith("END RequestId")) | index(true)) as $end | [to_entries[] | select(.value | startswith("spike line")) | select(.key > $end)] | length')"
      after[$runtime]=$((after[$runtime] + late))
    done
  done
  local sorted
  sorted="$(printf '%s\n' "${delays[@]}" | sort -n)"
  row["median|$collector"]="$(awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }' <<<"$sorted") ms"
  row["max|$collector"]="$(tail -1 <<<"$sorted") ms"
  row["ids|$collector"]="Node.js ${full[node]} of $RUNS, Python ${full[python]} of $RUNS"
  row["late|$collector"]="Node.js ${after[node]} of $((2 * RUNS)), Python ${after[python]} of $((2 * RUNS))"

  echo "  resources, idle for 20 s"
  sleep 5
  local c0 v0 c1 v1
  c0="$(usage "$collector")"
  v0="$(usage victoria-logs)"
  sleep 20
  c1="$(usage "$collector")"
  v1="$(usage victoria-logs)"
  row["idle|$collector"]="$collector $(( (${c1%% *} - ${c0%% *}) / 20 )) ms CPU a second, ${c1##* } MiB; VictoriaLogs $(( (${v1%% *} - ${v0%% *}) / 20 )) ms CPU a second, ${v1##* } MiB"

  echo "  a flood in A ($ns_a), with B ($ns_b) calling meanwhile"
  : >"$work/stats-$collector.txt"
  c0="$(usage "$collector")"
  v0="$(usage victoria-logs)"
  (for _ in $(seq 1 25); do echo "$(usage "$collector") $(usage victoria-logs)" >>"$work/stats-$collector.txt"; sleep 1; done) &
  local sampler=$! flood b_ids=()
  e2e_pids+=("$sampler")
  # In the background, with files of its own: http_at's are the calls' below.
  curl -sS -o "$work/flood.json" -X POST -H 'content-type: application/json' --data '{"input": {"lines": 20000}}' "$api/functions/$node_a/invoke" &
  local flooding=$!
  for _ in 1 2 3 4 5; do b_ids+=("$(invoke as_b "$node_b")"); sleep 0.5; done
  wait "$flooding" || true
  flood="$(jq -r .id "$work/flood.json")"
  sleep 8
  local stored_a stored_b=0 b
  # By content, not by tag: most of a flood's lines come after its END line (see the late lines above).
  stored_a="$(vl_count "{namespace=\"$ns_a\"} ~\"^flood [0-9]+$\"")"
  vl_query "{namespace=\"$ns_a\"} ~\"^flood [0-9]+$\" | stats by (_time:1s) count() as n" >"$work/flood-$collector.json"
  # What the node's log file of A's Node.js pod holds: its CRI records, full (F) or partial (P), and its flood lines.
  local file
  file="$(docker exec "$node_name" sh -c "ls /var/log/pods/${ns_a}_fn-${node_a}-*/function/*.log 2>/dev/null | tail -1")"
  row["file|$collector"]="$(docker exec "$node_name" sh -c "wc -l < '$file'; awk '{ print \$3 }' '$file' | sort | uniq -c | tr '\n' ' '; grep -c ' flood [0-9]*\$' '$file'" | tr '\n' ' ') (lines; records by flag; flood lines); A has $(vl_count "{namespace=\"$ns_a\"}") lines in the store"
  # Lines that begin like a flood line but hold more: several lines glued into one.
  row["glued|$collector"]="$(vl_query "{namespace=\"$ns_a\"} ~\"^flood\"" | jq -rs '[.[] | select(._msg | test("^flood [0-9]+$") | not)] | "\(length) lines\(if length > 0 then ", the longest \(map(._msg | length) | max) characters" else "" end)"')"
  for b in "${b_ids[@]}"; do stored_b=$((stored_b + $(vl_count "~\"$b\""))); done
  sleep 22
  # Again 30 s after the flood: a collector that lags shows its lines here, one that drops them doesn't.
  row["limit|$collector"]="A: $stored_a of 20,000 flood lines kept after 8 s, $(vl_count "{namespace=\"$ns_a\"} ~\"^flood [0-9]+$\"") after 30 s; B: $stored_b of $((5 * ${#b_ids[@]})) lines"
  wait "$sampler" || true
  c1="$(usage "$collector")"
  v1="$(usage victoria-logs)"
  row["peak|$collector"]="$(awk -v name="$collector" -v cpu=$(( ${c1%% *} - ${c0%% *} )) -v vcpu=$(( ${v1%% *} - ${v0%% *} )) '
    { if ($2 > cm) cm = $2; if ($4 > vm) vm = $4 }
    END { printf "%s %d ms CPU in all, %d MiB at most; VictoriaLogs %d ms CPU, %d MiB at most", name, cpu, cm, vcpu, vm }' "$work/stats-$collector.txt")"

  echo "  a long line"
  id="$(invoke as_a "$node_a" '{"long": 100000}')"
  sleep 3
  row["long|$collector"]="$(vl_query "{namespace=\"$ns_a\"} ~\"^xxxxxxxxxx\"" | jq -rs 'map(._msg) | max_by(length) | "\(length) characters, ends \"\(.[-13:])\""')"

  echo "  deleting A's logs"
  local deleted_at before_b after_a after_b
  before_b="$(vl_count "{namespace=\"$ns_b\"}")"
  row["nokey|$collector"]="$(curl -s -o /dev/null -w '%{http_code}' -X POST --get "$vl/delete/run_task" --data-urlencode "filter={namespace=\"$ns_a\"}")"
  deleted_at=$(now_ms)
  curl -sS -X POST --get "$vl/delete/run_task" --data-urlencode "filter={namespace=\"$ns_a\"}" --data-urlencode "authKey=spike-delete-key" >/dev/null
  until [ "$(curl -sS --get "$vl/delete/active_tasks" --data-urlencode "authKey=spike-delete-key" | jq 'length')" = 0 ]; do
    [ $(($(now_ms) - deleted_at)) -lt 120000 ] || break
    sleep 0.2
  done
  after_a="$(vl_count "{namespace=\"$ns_a\"}")"
  after_b="$(vl_count "{namespace=\"$ns_b\"}")"
  row["delete|$collector"]="$(( $(now_ms) - deleted_at )) ms; A: $after_a lines left; B: $after_b of $before_b kept; without the key: HTTP ${row["nokey|$collector"]:-}"

  echo "  retention, at ingestion"
  local old new
  old="$(date -u -d '-40 days' +%FT%T.000Z)"
  new="$(date -u +%FT%T.000Z)"
  # A JSON content type: with curl's default, a form, VictoriaLogs reads no line and still answers 200.
  printf '{"namespace":"spike-retention","message":"old line","time":"%s"}\n{"namespace":"spike-retention","message":"new line","time":"%s"}\n' "$old" "$new" |
    curl -sS -X POST -H 'Content-Type: application/stream+json' "$vl/insert/jsonline?_stream_fields=namespace&_msg_field=message&_time_field=time" --data-binary @- >/dev/null
  sleep 3
  row["retention|$collector"]="stored: $(vl_query '{namespace="spike-retention"}' | jq -rs 'map(._msg) | sort | join(", ")'); refused as older than the retention: $(curl -s "$vl/metrics" | awk '/^vl_rows_dropped_total\{reason="too_small_timestamp"\}/ { print $2 }') line"

  echo "  removing $collector and VictoriaLogs"
  kubectl -n ff-logging-spike logs --tail=200 "daemonset/$collector" >"$work/$collector.log" 2>&1 || true
  kill "$pid" 2>/dev/null || true
  spike_cleanup
}

for collector in ${COLLECTORS:-vector fluent-bit}; do measure "$collector"; done

{
  echo "| First call's lines, from the collector's start | ${row["first|vector"]:-} ms | ${row["first|fluent-bit"]:-} ms |"
  echo "| Delay from a call to all its lines queryable, median | ${row["median|vector"]:-} | ${row["median|fluent-bit"]:-} |"
  echo "| The same, slowest | ${row["max|vector"]:-} | ${row["max|fluent-bit"]:-} |"
  echo "| Calls whose 5 lines all carry their request ID | ${row["ids|vector"]:-} | ${row["ids|fluent-bit"]:-} |"
  echo "| User lines written after their call's END line | ${row["late|vector"]:-} | ${row["late|fluent-bit"]:-} |"
  echo "| Idle, over 20 s | ${row["idle|vector"]:-} | ${row["idle|fluent-bit"]:-} |"
  echo "| The flood and B's calls, over 25 s | ${row["peak|vector"]:-} | ${row["peak|fluent-bit"]:-} |"
  echo "| Rate limit: A floods 20,000 lines, B calls 5 times | ${row["limit|vector"]:-} | ${row["limit|fluent-bit"]:-} |"
  echo "| Flood lines glued into one | ${row["glued|vector"]:-} | ${row["glued|fluent-bit"]:-} |"
  echo "| A's Node.js pod's log file on the node, after the flood | ${row["file|vector"]:-} | ${row["file|fluent-bit"]:-} |"
  echo "| A 100,000-character line | ${row["long|vector"]:-} | ${row["long|fluent-bit"]:-} |"
  echo "| Deleting A's logs (\`/delete/run_task\`) | ${row["delete|vector"]:-} | ${row["delete|fluent-bit"]:-} |"
  echo "| Retention, 31 days: a line 40 days old and a new one, written straight to the store | ${row["retention|vector"]:-} | ${row["retention|fluent-bit"]:-} |"
} >>"$results"
sed -i 's/| |/| – |/g' "$results"
echo "== results ($results)"
cat "$results"
