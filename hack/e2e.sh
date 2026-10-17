#!/usr/bin/env bash
# L4 end-to-end test of the whole stack, driven through the public REST API:
#   PostgreSQL + S3 (compose project "ff-e2e", ports 55432 / 59003)
#   + the k3d dev cluster + the backend (built, started on a free port).
# The backend first refuses the new database, then the migrations run from the
# build, as a deploy step would. Scenario: create → invoke → history → update →
# invoke → delete, with checks on the Kubernetes side and in object storage (the
# code archive, read through SeaweedFS's filer), then the same lifecycle
# for a Python function. Removes its compose project (including its volumes),
# its tenant namespace and the backend process on exit. Keeps the cluster
# unless --teardown is given. K8S_RUNTIME_CLASS=gvisor runs every function in
# gVisor (hack/k8s/gvisor-up.sh installs it).
#   [K8S_RUNTIME_CLASS=gvisor] hack/e2e.sh [--teardown]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"

teardown=false
[ "${1:-}" = "--teardown" ] && teardown=true

project=ff-e2e
export FF_PG_PORT="${FF_E2E_PG_PORT:-55432}"
export FF_S3_PORT="${FF_E2E_S3_PORT:-59003}"
# A free port chosen by the OS, so the test never collides with other servers on the machine.
be_port="${FF_E2E_BE_PORT:-$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
api="http://127.0.0.1:$be_port"
work="$FF_REPO_ROOT/hack/.e2e"
# A random account per run, so runs never share a namespace (12 digits, ADR 0004).
tenant="$(node -e "console.log(String(require('crypto').randomInt(1e12)).padStart(12, '0'))")"
tenant_ns="ff-t-$(printf %s "$tenant" | sha256sum | cut -c1-12)"
compose=(docker compose -p "$project" -f "$FF_REPO_ROOT/docker-compose.yml")
be_pid=""
passed=0
mkdir -p "$work"

cleanup() {
  local status=$?
  if [ -n "$be_pid" ] && kill -0 "$be_pid" 2>/dev/null; then
    kill "$be_pid"
    wait "$be_pid" 2>/dev/null || true
  fi
  kubectl delete namespace "$tenant_ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if $teardown; then "$FF_REPO_ROOT/hack/k8s/cluster-down.sh" >/dev/null 2>&1 || true; fi
  if [ "$status" -ne 0 ]; then
    echo "e2e: FAILED. Last backend log lines ($work/backend.log):" >&2
    tail -20 "$work/backend.log" >&2 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  echo "  FAIL $1" >&2
  exit 1
}
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
    passed=$((passed + 1))
  else
    fail "$1 (expected '$2', got '$3')"
  fi
}
# http <method> <path> [json-body]: prints the body; the status code goes to $work/status.
http() {
  local args=(-sS -o "$work/body" -w '%{http_code}' -X "$1" -H 'content-type: application/json')
  if [ -n "${3:-}" ]; then args+=(--data "$3"); fi
  curl "${args[@]}" "$api$2" >"$work/status"
  cat "$work/body"
}
status() { cat "$work/status"; }
# archived <path>: an object of the "functions" bucket, read through SeaweedFS's filer inside the s3 container.
archived() { "${compose[@]}" exec -T s3 wget -qO- "http://127.0.0.1:8888/buckets/functions/$1" 2>/dev/null || true; }

echo "== resources"
MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3500}" "$FF_REPO_ROOT/hack/check-resources.sh"

echo "== dependencies (compose project $project)"
"${compose[@]}" up -d --wait postgres s3 >/dev/null 2>&1 || fail "compose dependencies did not become healthy"
echo "  postgres on 127.0.0.1:$FF_PG_PORT, s3 on 127.0.0.1:$FF_S3_PORT"

echo "== cluster"
k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1 || "$FF_REPO_ROOT/hack/k8s/cluster-up.sh" >/dev/null
"$FF_REPO_ROOT/hack/k8s/mint-token.sh" >/dev/null
docker image inspect ff-runtime-nodejs:24-v2 >/dev/null 2>&1 ||
  docker build -q -t ff-runtime-nodejs:24-v2 "$FF_REPO_ROOT/runtimes/nodejs" >/dev/null
docker image inspect ff-runtime-python:3.13-v2 >/dev/null 2>&1 ||
  docker build -q -t ff-runtime-python:3.13-v2 "$FF_REPO_ROOT/runtimes/python" >/dev/null
"$FF_REPO_ROOT/hack/k8s/load-images.sh" ff-runtime-nodejs:24-v2 ff-runtime-python:3.13-v2 >/dev/null 2>&1
echo "  $FF_CLUSTER_NAME ready, runtime images imported"

echo "== backend"
(cd "$FF_REPO_ROOT/BE" && npm run build >/dev/null)
# Every setting explicit, so that BE/.env (read when a variable is missing) can't change the test.
be_env=(
  NODE_ENV=development PORT="$be_port"
  DB_HOST=127.0.0.1 DB_PORT="$FF_PG_PORT" DB_USERNAME=postgres DB_PASSWORD=postgres DB_NAME=serverless_platform
  MINIO_ENDPOINT=127.0.0.1 MINIO_PORT="$FF_S3_PORT" MINIO_USE_SSL=false MINIO_BUCKET_NAME=functions
  MINIO_ACCESS_KEY=ffdevaccesskey MINIO_SECRET_KEY=ffdevsecretkey-local-only
  ORCHESTRATOR=kubernetes K8S_API_URL="https://127.0.0.1:$FF_API_PORT" K8S_INVOKE_MODE=proxy
  K8S_TOKEN_FILE="$FF_SA_TOKEN_FILE" K8S_CA_FILE="$FF_CA_FILE" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$tenant"
  K8S_RUNTIME_CLASS="${K8S_RUNTIME_CLASS:-}"
)
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
(cd "$FF_REPO_ROOT/BE" && env "${be_env[@]}" npm run migration:run:prod) >"$work/migrations.log" 2>&1 ||
  fail "the migrations failed (see $work/migrations.log)"
# The backend's own startup check, below, then proves that none is left pending.
check "the migrations run from the build" true \
  "$(grep -q 'executed successfully' "$work/migrations.log" && echo true || echo false)"
(cd "$FF_REPO_ROOT/BE" && exec env "${be_env[@]}" node dist/main.js) >"$work/backend.log" 2>&1 &
be_pid=$!
# A cold start reads thousands of node_modules files. With a cold page cache on
# a spinning disk that took 23 s just to load the modules, so allow 3 minutes.
for _ in $(seq 1 "${FF_E2E_BACKEND_START_SECONDS:-180}"); do
  kill -0 "$be_pid" 2>/dev/null || fail "backend exited during startup"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$api/functions")" = 200 ] && break
  sleep 1
done
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
check "maxInstances above the limit is refused" 400 "$(status)"

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

echo "e2e: $passed checks passed"
