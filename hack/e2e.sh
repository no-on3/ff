#!/usr/bin/env bash
# L4 end-to-end test of the whole stack, driven through the public REST API:
#   PostgreSQL + S3 (compose project "ff-e2e", ports 55432 / 59003)
#   + the k3d dev cluster + the backend (built, started on a free port).
# The backend first refuses the new database, then the migrations run from the
# build, as a deploy step would. Scenario: create → invoke → history → update →
# invoke → delete, with checks on the Kubernetes side and in object storage (the
# code archive, read through SeaweedFS's filer), then the same lifecycle
# for a Python function. Then plans (P-15): an account on a small plan, its
# limits, its namespace's quota and its rate limits, which don't touch other
# accounts. Then usage records (P-20): one per invocation, with the runtime
# given the invocation's ID, and a call lost when the backend is killed during
# it, which the restarted backend marks LOST without billing it. Then capacity
# samples (P-21): the warm function sampled each minute, and the capacity report.
# Then GET /usage (P-22) against the raw records, as JSON and as CSV, priced with
# the first price book (P-30). Then the hourly rating (P-32): every hour settled
# since the first book rated as the backend started, in shadow mode, the balance,
# and the reconciliation. Then the balance check (P-33): a wallet run below zero,
# invokes refused with 402, a top-up, and invokes accepted again at once. Then an
# alarm: a function's error fires it, a quiet minute recovers it, and each
# change reaches a local webhook receiver, signed.
# Removes its compose project (including its volumes),
# its tenant namespace and the backend process on exit. Keeps the cluster
# unless --teardown is given. K8S_RUNTIME_CLASS=gvisor runs every function in
# gVisor (hack/k8s/gvisor-up.sh installs it).
#   [K8S_RUNTIME_CLASS=gvisor] hack/e2e.sh [--teardown]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-e2e
E2E_NAME=e2e
export FF_PG_PORT="${FF_E2E_PG_PORT:-55432}"
export FF_S3_PORT="${FF_E2E_S3_PORT:-59003}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
[ "${1:-}" = "--teardown" ] && e2e_teardown=true

be_port="${FF_E2E_BE_PORT:-$(free_port)}"
api="http://127.0.0.1:$be_port"
tenant="$(random_account)"
tenant_ns="$(tenant_namespace "$tenant")"
e2e_namespaces+=("$tenant_ns")
http() { http_at "$api" "$@"; }

e2e_dependencies
e2e_cluster

echo "== backend"
e2e_build
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$tenant")
# Production refuses development settings, at boot (the same variables, with NODE_ENV=production).
refused=0
(cd "$FF_REPO_ROOT/BE" && timeout 180 env "${be_env[@]}" NODE_ENV=production node dist/main.js) \
  >"$work/backend-production.log" 2>&1 || refused=$?
check "the backend refuses development settings in production" "1 FF_AUTH_MODE=dev is for development only" \
  "$refused $(grep -o 'FF_AUTH_MODE=dev is for development only' "$work/backend-production.log" | head -1)"
# The database is new: the backend must refuse it until the migrations have run.
refused=0
(cd "$FF_REPO_ROOT/BE" && timeout 180 env "${be_env[@]}" node dist/main.js) >"$work/backend-refused.log" 2>&1 || refused=$?
check "the backend refuses a database with pending migrations" "1 pending" \
  "$refused $(grep -o 'pending' "$work/backend-refused.log" | head -1)"
e2e_migrate "${be_env[@]}"
# The backend's own startup check, below, then proves that none is left pending.
check "the migrations run from the build" true \
  "$(grep -q 'executed successfully' "$work/migrations.log" && echo true || echo false)"
# Alarms evaluated every 5 s, each minute as soon as it is over, and notifications sent every second, to this machine too.
alarm_env=(FF_ALARM_INTERVAL_SECONDS=5 FF_ALARM_SETTLE_SECONDS=0 FF_NOTIFY_INTERVAL_SECONDS=1 FF_WEBHOOK_ALLOW_PRIVATE=true)
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}" "${alarm_env[@]}"
check "backend answers on $api" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$api/functions")"

echo "== scenario (tenant $tenant → namespace $tenant_ns)"
v1='export async function handler(event: { body: { name?: string } }) {
  return { version: 1, message: `Hello ${event.body.name ?? "world"}` };
}'
created="$(http POST /functions "$(jq -n --arg code "$v1" '{name: "e2e-hello", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
check "create returns 201" 201 "$(status)"
check "function is ACTIVE once ready" ACTIVE "$(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
check "its code is archived in object storage" "$v1" "$(archived "$id/code.ts")"
check "its Deployment runs in the tenant namespace" "fn-$id" \
  "$(kubectl -n "$tenant_ns" get deployment "fn-$id" -o jsonpath='{.metadata.name}' 2>/dev/null)"
if [ -n "${K8S_RUNTIME_CLASS:-}" ]; then
  check "its pods use RuntimeClass $K8S_RUNTIME_CLASS" "$K8S_RUNTIME_CLASS" \
    "$(kubectl -n "$tenant_ns" get deployment "fn-$id" -o jsonpath='{.spec.template.spec.runtimeClassName}')"
fi

scaling="$(http PUT "/functions/$id/scaling-config" '{"maxInstances": 2}')"
check "scaling limits can be changed" "200 0 2 true" \
  "$(status) $(jq -r '"\(.minInstances) \(.maxInstances) \(.scaleToZero)"' <<<"$scaling")"
http PUT "/functions/$id/scaling-config" '{"minInstances": 3}' >/dev/null
check "minInstances above maxInstances is refused" 400 "$(status)"
http PUT "/functions/$id/scaling-config" '{"maxInstances": 11}' >/dev/null
check "maxInstances above the plan's limit is refused, naming it" "400 maxInstances must be at most 10 on the Beta plan" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
check "the namespace's quota is the beta plan's" "20 8 8Gi" \
  "$(kubectl -n "$tenant_ns" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"

invoked="$(http POST "/functions/$id/invoke" '{"input":{"name":"e2e"}}')"
check "invoke returns 201" 201 "$(status)"
check "invocation is COMPLETED" COMPLETED "$(jq -r .status <<<"$invoked")"
check "handler output is returned" "Hello e2e" "$(jq -r .output.message <<<"$invoked")"

history="$(http GET "/functions/$id/invocations")"
check "history lists the invocation" 1 "$(jq -r .total <<<"$history")"
check "a duration was recorded" true "$(jq -r '.invocations[0].duration > 0' <<<"$history")"

# P-45: the history keeps up to 64 KiB of an input and an output, while the answer has them whole; NUL is kept as U+FFFD.
long="$(head -c 80000 /dev/zero | tr '\0' x)"
big="$(http POST "/functions/$id/invoke" "$(jq -cn --arg name "$long" '{input: {name: $name}}')")"
check "an input and an output over 64 KiB are answered whole, and flagged as cut in the history (P-45)" "201 80000 80006 true true" \
  "$(status) $(jq -r '"\(.input.name | length) \(.output.message | length) \(.inputTruncated) \(.outputTruncated)"' <<<"$big")"
kept="$(http GET "/functions/$id/invocations?limit=1" | jq -c '.invocations[0]')"
check "the history keeps the first 64 KiB of each, the start of its JSON text" "true true 65536 65536 true true" \
  "$(jq -r '"\(.inputTruncated) \(.outputTruncated) \(.input | utf8bytelength) \(.output | utf8bytelength) \(.input | startswith("{\"name\":\"xxx")) \(.output | startswith("{\"version\":1,\"message\":\"Hello xxx"))"' <<<"$kept")"
nul="$(http POST "/functions/$id/invoke" '{"input":{"name":"a\u0000b"}}')"
check "a NUL in the input reaches the function, and comes back in the answer (P-45)" "201 true" \
  "$(status) $(jq -r '.output.message == "Hello a\u0000b"' <<<"$nul")"
check "the history keeps it as U+FFFD, which PostgreSQL can store" true \
  "$(http GET "/functions/$id/invocations?limit=1" | jq -r '.invocations[0] | .input.name == "a\ufffdb" and .output.message == "Hello a\ufffdb" and .inputTruncated == false')"

v2="${v1//version: 1/version: 2}"
http PUT "/functions/$id" "$(jq -n --arg code "$v2" '{code: $code}')" >/dev/null
check "update returns 200" 200 "$(status)"
check "the new code is live after the update" 2 \
  "$(http POST "/functions/$id/invoke" '{"input":{}}' | jq -r .output.version)"
check "the archive holds the new code" "$v2" "$(archived "$id/code.ts")"

http DELETE "/functions/$id" >/dev/null
check "delete returns 200" 200 "$(status)"
gone=false
for _ in $(seq 1 30); do
  if ! kubectl -n "$tenant_ns" get deployment "fn-$id" >/dev/null 2>&1; then
    gone=true
    break
  fi
  sleep 1
done
check "its Deployment is removed from the cluster" true "$gone"
check "its archive is removed from object storage" "" "$(archived "$id/code.ts")"
http GET "/functions/$id" >/dev/null
check "the function record is gone" 404 "$(status)"

echo "== python function"
py='def handler(event, context):
    return {"message": "Hello " + event["body"].get("name", "world"), "memory": context.memory_limit_in_mb}
'
created="$(http POST /functions "$(jq -n --arg code "$py" '{name: "e2e-python", runtime: "python", code: $code, memory: 128, timeout: 5}')")"
check "create returns 201" 201 "$(status)"
check "function is ACTIVE once ready" ACTIVE "$(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
invoked="$(http POST "/functions/$id/invoke" '{"input":{"name":"Python"}}')"
check "invocation is COMPLETED" COMPLETED "$(jq -r .status <<<"$invoked")"
check "handler output is returned, with the Lambda context" "Hello Python 128" \
  "$(jq -r '"\(.output.message) \(.output.memory)"' <<<"$invoked")"
http DELETE "/functions/$id" >/dev/null
check "delete returns 200" 200 "$(status)"

echo "== plans and rate limits (P-15)"
# A small plan, assigned in SQL as the admin dashboard will (P-73), to an account
# that development mode creates on its first call.
small="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$small")")
# as_small <method> <path> [body] [curl option...]
as_small() {
  local method=$1 path=$2 body=${3:-}
  shift $(($# < 3 ? $# : 3))
  http_at "$api" "$method" "$path" "$body" -H "X-FF-Dev-Account: $small" "$@"
}
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }
as_small GET /functions >/dev/null
sql "INSERT INTO plans (id, name, limits) SELECT 'e2e-small', 'E2E small', limits || '{\"functions\": 1, \"memoryMb\": 512, \"writesPerMinute\": 5, \"invokesPerSecond\": 2, \"quota\": {\"pods\": 5, \"cpu\": \"2\", \"memory\": \"2Gi\"}}' FROM plans WHERE id = 'beta'"
sql "UPDATE accounts SET plan_id = 'e2e-small' WHERE id = '$small'"
small_fn() { jq -n --arg code "$v1" --argjson memory "$2" '{name: $ARGS.positional[0], runtime: "nodejs", code: $code, memory: $memory, timeout: 5}' --args "$1"; }
as_small POST /functions "$(small_fn e2e-big 1024)" >/dev/null # change 1
check "memory above the plan is refused, naming its limit" "400 memory must be at most 512 MB on the E2E small plan" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
created="$(as_small POST /functions "$(small_fn e2e-small 128)")" # change 2
check "the plan's one function is created" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
small_id="$(jq -r .id <<<"$created")"
check "its namespace has the plan's quota" "5 2 2Gi" \
  "$(kubectl -n "$(tenant_namespace "$small")" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"
as_small POST /functions "$(small_fn e2e-second 128)" >/dev/null # change 3
check "a second function is refused" "400 The E2E small plan allows 1 function per account: delete one first" "$(status) $(jq -r .message "$work/body")"
as_small PUT "/functions/$small_id/scaling-config" '{"maxInstances": 1}' >/dev/null # change 4
as_small PUT "/functions/$small_id" '{"name": "e2e-renamed"}' >/dev/null # change 5
check "changes within the plan's rate pass" 200 "$(status)"
as_small PUT "/functions/$small_id" '{"name": "e2e-again"}' -D "$work/headers" >/dev/null # change 6
retry_after="$(tr -d '\r' <"$work/headers" | awk -F': ' 'tolower($1) == "retry-after" {print $2}')"
check "the sixth change in a minute gets 429, with Retry-After" "429 true" "$(status) $([ "${retry_after:-0}" -gt 0 ] && echo true || echo false)"
check "and Lambda's error name, and the plan's limit" "TooManyRequestsException: Rate exceeded: the E2E small plan allows 5 changes per minute" \
  "$(jq -r .message "$work/body" | sed 's/\. Retry after.*//')"
as_small GET "/functions/$small_id" >/dev/null
check "reads still pass" 200 "$(status)"
codes=""
for _ in 1 2 3; do as_small POST "/functions/$small_id/invoke" '{"input":{}}' >/dev/null; codes="$codes $(status)"; done
check "invocations have their own rate: two a second, then 429" " 201 201 429" "$codes"
http PUT "/functions/$small_id/scaling-config" '{"maxInstances": 1}' >/dev/null
check "another account, from the same address, isn't slowed: its own count, and its function isn't found" 404 "$(status)"

echo "== usage records (P-20)"
# q <sql>: one value, or a row with its columns separated by spaces.
q() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -tA -F ' ' -c "$1"; }
meter='export async function handler(event: { body: { sleepMs?: number; fail?: boolean } }, context: { awsRequestId: string }) {
  if (event.body.sleepMs) await new Promise((resolve) => setTimeout(resolve, event.body.sleepMs));
  if (event.body.fail) throw new Error("failed on purpose");
  return { requestId: context.awsRequestId };
}'
created="$(http POST /functions "$(jq -n --arg code "$meter" '{name: "e2e-meter", runtime: "nodejs", code: $code, memory: 128, timeout: 3}')")"
check "create returns 201" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
meter_id="$(jq -r .id <<<"$created")"

# A cold start first: no instance left, as after the idle window. Before any call, so the backend's
# autoscaler, which steps up a function that had calls in the last minute, leaves it at zero.
kubectl -n "$tenant_ns" scale deployment "fn-$meter_id" --replicas=0 >/dev/null
for _ in $(seq 1 90); do
  [ -z "$(kubectl -n "$tenant_ns" get pods -l "ff.dev/function-id=$meter_id" -o name 2>/dev/null)" ] && break
  sleep 1
done
check "scaled to zero: no instance left" "" "$(kubectl -n "$tenant_ns" get pods -l "ff.dev/function-id=$meter_id" -o name 2>/dev/null)"
cold="$(http POST "/functions/$meter_id/invoke" '{"input":{}}' | jq -r .id)"
check "a call that started an instance: its cold start is recorded, and not billed" "success t t" \
  "$(q "SELECT status, init_ms > 0, billed_ms < init_ms FROM usage_records WHERE request_id = '$cold'")"

invoked="$(http POST "/functions/$meter_id/invoke" '{"input":{}}')"
inv="$(jq -r .id <<<"$invoked")"
check "the runtime got the invocation's ID as its request ID" "201 $inv" "$(status) $(jq -r .output.requestId <<<"$invoked")"
check "the runtime's log names the call by that ID" true \
  "$(kubectl -n "$tenant_ns" logs "deployment/fn-$meter_id" 2>/dev/null | grep -q "START RequestId: $inv" && echo true || echo false)"
check "its usage record: a success, the function's memory and minInstances (P-30), billed its duration rounded up" "success 128 0 t" \
  "$(q "SELECT status, memory_mb, min_instances, billed_ms = ceil(duration_ms) FROM usage_records WHERE request_id = '$inv'")"
check "and the history's start and end, to the millisecond, and its duration" "t t t" \
  "$(q "SELECT u.started_at = date_trunc('milliseconds', i.created_at), u.ended_at = date_trunc('milliseconds', i.updated_at),
               u.duration_ms = round(i.duration::numeric, 3)
          FROM usage_records u JOIN function_invocations i ON i.id = u.request_id WHERE u.request_id = '$inv'")"

http POST "/functions/$meter_id/invoke" '{"input":{"fail":true}}' >/dev/null
check "a function's error answers 400" 400 "$(status)"
check "its record: an error, billed its duration rounded up; the history has the runtime's memory measure too" "error t t" \
  "$(q "SELECT u.status, u.billed_ms = ceil(u.duration_ms), i.memory_used > 0
          FROM usage_records u JOIN function_invocations i ON i.id = u.request_id WHERE i.function_id = '$meter_id' AND i.status = 'ERROR'")"
http POST "/functions/$meter_id/invoke" '{"input":{"sleepMs":5000}}' >/dev/null
check "a timeout answers 400" 400 "$(status)"
check "its record: a timeout, billed the function's timeout" "timeout 3000" \
  "$(q "SELECT u.status, u.billed_ms FROM usage_records u JOIN function_invocations i ON i.id = u.request_id
          WHERE i.function_id = '$meter_id' AND i.status = 'TIMEOUT'")"

# A call lost: the backend is killed while it waits for the answer.
be_pid="${e2e_pids[${#e2e_pids[@]}-1]}"
(http POST "/functions/$meter_id/invoke" '{"input":{"sleepMs":2500}}' >/dev/null 2>&1 || true) &
call_pid=$!
lost=""
for _ in $(seq 1 50); do
  lost="$(q "SELECT id FROM function_invocations WHERE function_id = '$meter_id' AND status = 'RUNNING'")"
  [ -n "$lost" ] && break
  sleep 0.2
done
check "a slow call is running" true "$([ -n "$lost" ] && echo true || echo false)"
kill -9 "$be_pid"
wait "$be_pid" 2>/dev/null || true # reaped quietly: bash would report "Killed"
wait "$call_pid" 2>/dev/null || true
# Restarted at once, as a supervisor would. Its reaper marks the call LOST once the longest a call can
# take has passed (2 × 3 s + a 1 s cold-start limit + 30 s), at the next run of the minute.
e2e_start_backend "$work/backend-restarted.log" "$api" "${be_env[@]}" "${alarm_env[@]}" K8S_READY_TIMEOUT_SECONDS=1
state=""
for _ in $(seq 1 120); do
  state="$(q "SELECT status FROM function_invocations WHERE id = '$lost'")"
  [ "$state" = LOST ] && break
  sleep 1
done
check "the restarted backend marks the call LOST" LOST "$state"
check "its record bills nothing" "lost 0 0.000" "$(q "SELECT status, billed_ms, duration_ms FROM usage_records WHERE request_id = '$lost'")"
check "the history says why" "Lost: the backend restarted during the call, so its answer is unknown. It isn't billed." \
  "$(http GET "/functions/$meter_id/invocations" | jq -r --arg id "$lost" '.invocations[] | select(.id == $id) | .error')"
check "one record per invocation, none without one" "5 5" \
  "$(q "SELECT (SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'), (SELECT count(*) FROM usage_records WHERE function_id = '$meter_id')")"

echo "== capacity samples (P-21)"
# The backends sampled every minute since the meter function was created: it has had a ready instance since its cold start.
check "a sample a minute of the warm function: its instances, memory, account and minInstances" "t 1 128 $tenant 0" \
  "$(q "SELECT count(*) > 0, min(instances), max(memory_mb), max(account_id), max(min_instances) FROM capacity_samples WHERE function_id = '$meter_id'")"
report="$(cd "$FF_REPO_ROOT/BE" && env "${e2e_base_env[@]}" npm run -s capacity:report -- --days 1 2>&1)"
check "the capacity report shows the account's day: capacity reserved, and capacity billed" true \
  "$(awk -v account="$tenant" '$2 == account && $3 != "0.000" && $5 != "0.000" { found = 1 } END { print found ? "true" : "false" }' <<<"$report")"

echo "== usage API (P-22)"
month="$(date -u +%Y-%m)"
billed="status IN ('success', 'error', 'timeout')"
usage="$(http GET /usage)"
check "GET /usage answers this month, by the UTC calendar" "200 $month" "$(status) $(jq -r .month <<<"$usage")"
check "the meter function: requests billed, the lost call apart, billed duration and GB-s, exactly as its records" \
  "$(q "SELECT count(*) FILTER (WHERE $billed), count(*) FILTER (WHERE status = 'lost'), sum(billed_ms),
               trim_scale(sum(billed_ms::numeric * memory_mb) / 1024000) FROM usage_records WHERE function_id = '$meter_id'")" \
  "$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | "\(.requests) \(.lost) \(.billedMs) \(.gbSeconds)"' <<<"$usage")"
check "the account's totals are its records' own sums" \
  "$(q "SELECT count(*) FILTER (WHERE $billed), sum(billed_ms), trim_scale(sum(billed_ms::numeric * memory_mb) / 1024000)
          FROM usage_records WHERE account_id = '$tenant' AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")" \
  "$(jq -r '.totals | "\(.requests) \(.billedMs) \(.gbSeconds)"' <<<"$usage")"
check "the Python function, deleted earlier, keeps its usage, marked deleted" "true 1" \
  "$(jq -r --arg id "$id" '.functions[] | select(.functionId == $id) | "\(.deleted) \(.requests)"' <<<"$usage")"
csv="$(curl -sS -H 'accept: text/csv' -D "$work/headers" "$api/usage?month=$month")"
check "as CSV: a download, its header, and the meter function's line" \
  "text/csv; charset=utf-8|function_id,function_name,deleted,requests,billed_ms,gb_seconds,throttled,platform_errors,lost,cost|true" \
  "$(tr -d '\r' <"$work/headers" | awk -F': ' 'tolower($1) == "content-type" { print $2 }')|$(head -1 <<<"$csv" | tr -d '\r')|$(grep -q "^$meter_id,e2e-meter,false,4," <<<"$csv" && echo true || echo false)"
empty="$(http GET '/usage?month=2001-01')"
check "a month without calls is empty, and before the first price book, unpriced" "200 0 0 null" \
  "$(status) $(jq -r '"\(.functions | length) \(.totals.requests) \(.estimate)"' <<<"$empty")"
http GET '/usage?month=2026-13' >/dev/null
check "a month that is not YYYY-MM is refused" "400 month must be a month as YYYY-MM, such as 2026-10" "$(status) $(jq -r '.message | join("; ")' "$work/body")"

echo "== usage priced (P-30)"
book="$(q "SELECT id FROM price_books ORDER BY valid_from LIMIT 1")"
check "the month is priced in TND, with the first price book" "TND $book" "$(jq -r '.estimate | "\(.currency) \(.priceBooks | join(","))"' <<<"$usage")"
check "the meter function's cost: its billed requests and GB-s at the book's prices, rounded to the millime" \
  "$(q "SELECT round(count(*) * (b.prices->'prices'->>'requestsPerMillion')::numeric / 1000000
                     + sum(u.billed_ms::numeric * u.memory_mb) / 1024000 * (b.prices->'prices'->'gbSecond'->0->>'price')::numeric, 3)
          FROM usage_records u, price_books b WHERE u.function_id = '$meter_id' AND u.$billed AND b.id = '$book' GROUP BY b.prices")" \
  "$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | .cost' <<<"$usage")"
check "the free tier covers the month: usage, the free tier taking it all off, and nothing to pay" "true 0.000" \
  "$(jq -r '.estimate | "\((.usage | tonumber) + (.freeTier | tonumber) == 0) \(.total)"' <<<"$usage")"
check "and the CSV has each function's cost" true \
  "$(tr -d '\r' <<<"$csv" | grep -q "^$meter_id,e2e-meter,false,4,.*,$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | .cost' <<<"$usage")$" && echo true || echo false)"

echo "== the hourly rating (P-32)"
# As it started, the backend rated every hour since the first book that had settled: ended 33 minutes ago at least.
balance="$(http GET /billing/balance)"
rated_until="$(jq -r .ratedUntil <<<"$balance")"
settled="$(date -u -d "@$(( ($(date -u +%s) - 33 * 60) / 3600 * 3600 ))" +%Y-%m-%dT%H:%M:%S.000Z)"
previous="$(date -u -d "@$(( ($(date -u +%s) - 33 * 60) / 3600 * 3600 - 3600 ))" +%Y-%m-%dT%H:%M:%S.000Z)"
check "the balance: nothing charged, in shadow mode, rated up to the last hour settled (or the one before, if one just settled)" "200 0.000 TND true 0.000 true" \
  "$(status) $(jq -r '"\(.balance) \(.currency) \(.shadowMode) \(.charged)"' <<<"$balance") $([ "$rated_until" = "$settled" ] || [ "$rated_until" = "$previous" ] && echo true || echo false)"
check "every hour from the first book on rated, once, none skipped, in shadow mode" "t t t t" \
  "$(q "SELECT count(*) = count(DISTINCT hour), count(*) = extract(epoch FROM max(hour) - min(hour)) / 3600 + 1,
               min(hour) = (SELECT min(valid_from) FROM price_books), bool_and(shadow) FROM rating_runs")"
check "no transaction moved the balance: no debit in shadow mode" "200 0" "$(http GET /billing/transactions >/dev/null; status) $(jq '.transactions | length' "$work/body")"
reconciliation="$(cd "$FF_REPO_ROOT/BE" && env "${e2e_base_env[@]}" npm run -s billing:reconcile 2>&1)" || true
check "the reconciliation runs against the database: nobody used anything in the hours rated" "No account used anything." \
  "$(tail -1 <<<"$reconciliation")"

echo "== the balance check (P-33)"
# As an operator sets them in the admin dashboard (P-70); e2e has no operator, so SQL. No buffer, no grace period.
sql "INSERT INTO platform_settings (key, value) VALUES ('billingShadowMode', 'false'), ('negativeBuffer', '\"0.000\"'), ('gracePeriodHours', '0')"
# move <account> <millimes> <kind> <FF's account> <key>: a balanced ledger transaction, as the rating (usage) or a payment (topup) writes it.
move() {
  sql "INSERT INTO ledger_accounts (account_id, type, currency) VALUES ('$1', 'wallet', 'TND') ON CONFLICT DO NOTHING;
       INSERT INTO ledger_accounts (type, currency) VALUES ('$4', 'TND') ON CONFLICT DO NOTHING;
       WITH t AS (INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('$3', '$5') RETURNING id)
       INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
       SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN $2 ELSE -($2) END FROM t, ledger_accounts a
        WHERE a.currency = 'TND' AND (a.account_id = '$1' OR (a.account_id IS NULL AND a.type = '$4'))"
}
move "$tenant" -500 usage revenue "e2e:usage"
invocations="$(q "SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'")"
http POST "/functions/$meter_id/invoke" '{"input":{}}' >/dev/null
check "a wallet run below zero, with no buffer and no grace period: invokes answer 402" "402 InsufficientCreditException" \
  "$(status) $(jq -r .message "$work/body" | cut -d: -f1)"
check "and the refused call left no invocation" "$invocations" "$(q "SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'")"
check "the balance says invokes stopped" "200 -0.500 stopped" "$(http GET /billing/balance >/dev/null; status) $(jq -r '"\(.balance) \(.credit.state)"' "$work/body")"
http GET "/functions/$meter_id" >/dev/null
check "reads go on" 200 "$(status)"
move "$tenant" 1000 topup provider_clearing "e2e:topup"
http POST "/functions/$meter_id/invoke" '{"input":{}}' >/dev/null
check "a top-up lets them in again at once: the ledger's NOTIFY refreshed the backend's cached balance" 201 "$(status)"
sql "DELETE FROM platform_settings WHERE key IN ('billingShadowMode', 'negativeBuffer', 'gracePeriodHours')"

echo "== alarms: an error fires an alarm, a quiet minute recovers it, each change told to a webhook"
receiver_port="$(free_port)"
cat >"$work/receiver.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        with open(sys.argv[2], 'a') as out:
            out.write(json.dumps({'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body}) + '\n')
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), Receiver).serve_forever()
PY
: >"$work/webhooks.jsonl"
python3 "$work/receiver.py" "$receiver_port" "$work/webhooks.jsonl" &
e2e_pids+=("$!")
failing='export async function handler(event: { body: { fail?: boolean } }) {
  if (event.body.fail) throw new Error("asked to fail");
  return { ok: true };
}'
alarmed_id="$(http POST /functions "$(jq -n --arg code "$failing" '{name: "e2e-alarmed", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
check "a function to watch" 201 "$(status)"
alarm_id="$(http POST /alarms "$(jq -cn --arg fn "$alarmed_id" --arg url "http://127.0.0.1:$receiver_port/ff" \
  '{name: "e2e errors", functionId: $fn, metric: "Errors", statistic: "Sum", period: 60, comparison: "GreaterThanThreshold", threshold: 0,
    evaluationPeriods: 1, datapointsToAlarm: 1, actions: {email: false, webhookUrls: [$url]}}')" | jq -r .id)"
check "an alarm on its errors, each minute, telling the receiver" "201 INSUFFICIENT_DATA" "$(status) $(jq -r .state "$work/body")"
# alarm_state_after <state> <seconds>: waits for the alarm to reach the state, then prints it.
alarm_state_after() {
  local state=""
  for _ in $(seq 1 "$2"); do
    state="$(http GET "/alarms/$alarm_id" | jq -r .state)"
    [ "$state" = "$1" ] && break
    sleep 1
  done
  echo "$state"
}
check "its first evaluation judges a quiet minute: OK, and tells nobody" "OK 0" "$(alarm_state_after OK 30) $(wc -l <"$work/webhooks.jsonl" | tr -d ' ')"
http POST "/functions/$alarmed_id/invoke" '{"input": {"fail": true}}' >/dev/null
check "the function fails" "400 Error: asked to fail" "$(status) $(jq -r .message "$work/body")"
check "once that minute is over, the alarm fires" "ALARM" "$(alarm_state_after ALARM 90)"
check "saying why" "1 of the last 1 period(s) of 60 s breaching Errors Sum > 0 (1 needed); latest 1" "$(http GET "/alarms/$alarm_id" | jq -r .stateReason)"
check "the next minute, quiet, recovers it" "OK" "$(alarm_state_after OK 90)"
for _ in $(seq 1 20); do [ "$(wc -l <"$work/webhooks.jsonl" | tr -d ' ')" -ge 2 ] && break; sleep 0.5; done
secret="$(http GET /notifications/webhook-secret | jq -r .secret)"
told="$(python3 - "$secret" "$work/webhooks.jsonl" <<'PY'
import hashlib, hmac, json, sys
secret, path = sys.argv[1], sys.argv[2]
for line in open(path):
    hook = json.loads(line)
    fields = [part.split('=', 1) for part in hook['headers']['ff-signature'].split(',')]
    t = dict(fields)['t']
    body = hook['body']
    signed = any(name == 'v1' and hmac.compare_digest(value, hmac.new(secret.encode(), f'{t}.{body}'.encode(), hashlib.sha256).hexdigest()) for name, value in fields)
    data = json.loads(body)['data']
    print(f"{data['previousState']}>{data['state']}:{'signed' if signed else 'unsigned'}", end=' ')
PY
)"
check "the receiver was told each change once, into ALARM and out of it, signed" "OK>ALARM:signed ALARM>OK:signed" "${told% }"
check "and the webhooks are among the account's deliveries, delivered" "2" \
  "$(http GET /notifications/deliveries | jq '[.[] | select(.kind == "alarm" and .status == "delivered")] | length')"
http DELETE "/alarms/$alarm_id" >/dev/null
check "the alarm is deleted" 204 "$(status)"
http DELETE "/functions/$alarmed_id" >/dev/null

echo "e2e: $passed checks passed"
