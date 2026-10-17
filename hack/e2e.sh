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
# accounts. Removes its compose project (including its volumes),
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
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"
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

echo "e2e: $passed checks passed"
