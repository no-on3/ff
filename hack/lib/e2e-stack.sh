# shellcheck shell=bash
# A whole FF stack for one end-to-end run, shared by hack/e2e.sh (L4) and
# hack/e2e-tenancy.sh (L5): PostgreSQL and S3 in their own compose project, the
# k3d dev cluster with the runtime images, and the built backend.
#
# Source it after hack/k8s/env.sh, with E2E_PROJECT (the compose project) and
# E2E_NAME (the name in messages and of the work directory) set, and with
# FF_PG_PORT and FF_S3_PORT exported. Then call e2e_dependencies, e2e_cluster,
# e2e_build, e2e_migrate and e2e_start_backend. On exit, it stops the backends
# it started, deletes the namespaces listed in e2e_namespaces, and removes the
# compose project with its volumes; the cluster too if e2e_teardown is true.

work="$FF_REPO_ROOT/hack/.$E2E_NAME"
compose=(docker compose -p "$E2E_PROJECT" -f "$FF_REPO_ROOT/docker-compose.yml")
e2e_pids=()
e2e_namespaces=()
e2e_teardown=false
passed=0
mkdir -p "$work"

# The backend's settings, explicit so that BE/.env (read for any missing variable)
# can't change the test. Callers add the port and the authentication mode.
e2e_base_env=(
  NODE_ENV=development
  DB_HOST=127.0.0.1 DB_PORT="$FF_PG_PORT" DB_USERNAME=postgres DB_PASSWORD=postgres DB_NAME=serverless_platform
  MINIO_ENDPOINT=127.0.0.1 MINIO_PORT="$FF_S3_PORT" MINIO_USE_SSL=false MINIO_BUCKET_NAME=functions
  MINIO_ACCESS_KEY=ffdevaccesskey MINIO_SECRET_KEY=ffdevsecretkey-local-only
  ORCHESTRATOR=kubernetes K8S_API_URL="https://127.0.0.1:$FF_API_PORT" K8S_INVOKE_MODE=proxy
  K8S_TOKEN_FILE="$FF_SA_TOKEN_FILE" K8S_CA_FILE="$FF_CA_FILE"
  K8S_RUNTIME_CLASS="${K8S_RUNTIME_CLASS:-}"
)

e2e_cleanup() {
  local status=$? pid ns
  for pid in "${e2e_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      wait "$pid" 2>/dev/null || true
    fi
  done
  for ns in "${e2e_namespaces[@]}"; do
    kubectl delete namespace "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if $e2e_teardown; then "$FF_REPO_ROOT/hack/k8s/cluster-down.sh" >/dev/null 2>&1 || true; fi
  if [ "$status" -ne 0 ]; then
    echo "$E2E_NAME: FAILED. Last backend log lines ($work/backend.log):" >&2
    tail -20 "$work/backend.log" >&2 2>/dev/null || true
  fi
}
trap e2e_cleanup EXIT

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
# http_at <base URL> <method> <path> [json-body] [curl option...]: prints the body;
# the status code goes to $work/status. Extra options are passed to curl, e.g. -H 'x: y'.
http_at() {
  local base=$1 method=$2 path=$3 body=${4:-}
  shift $(($# < 4 ? $# : 4))
  local args=(-sS -o "$work/body" -w '%{http_code}' -X "$method" -H 'content-type: application/json')
  if [ -n "$body" ]; then args+=(--data "$body"); fi
  curl "${args[@]}" "$@" "$base$path" >"$work/status"
  cat "$work/body"
}
status() { cat "$work/status"; }
# archived <path>: an object of the "functions" bucket, read through SeaweedFS's filer inside the s3 container.
archived() { "${compose[@]}" exec -T s3 wget -qO- "http://127.0.0.1:8888/buckets/functions/$1" 2>/dev/null || true; }
# A free port chosen by the OS, so the test never collides with other servers on the machine.
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
# A random account (12 digits, ADR 0004), so runs never share a namespace.
random_account() { node -e "console.log(String(require('crypto').randomInt(1e12)).padStart(12, '0'))"; }
tenant_namespace() { printf 'ff-t-%s' "$(printf %s "$1" | sha256sum | cut -c1-12)"; }

e2e_dependencies() {
  echo "== resources"
  MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3500}" "$FF_REPO_ROOT/hack/check-resources.sh"
  echo "== dependencies (compose project $E2E_PROJECT)"
  "${compose[@]}" up -d --wait postgres s3 >/dev/null 2>&1 || fail "compose dependencies did not become healthy"
  echo "  postgres on 127.0.0.1:$FF_PG_PORT, s3 on 127.0.0.1:$FF_S3_PORT"
}

e2e_cluster() {
  echo "== cluster"
  k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1 || "$FF_REPO_ROOT/hack/k8s/cluster-up.sh" >/dev/null
  "$FF_REPO_ROOT/hack/k8s/mint-token.sh" >/dev/null
  docker image inspect ff-runtime-nodejs:24-v2 >/dev/null 2>&1 ||
    docker build -q -t ff-runtime-nodejs:24-v2 "$FF_REPO_ROOT/runtimes/nodejs" >/dev/null
  docker image inspect ff-runtime-python:3.13-v2 >/dev/null 2>&1 ||
    docker build -q -t ff-runtime-python:3.13-v2 "$FF_REPO_ROOT/runtimes/python" >/dev/null
  "$FF_REPO_ROOT/hack/k8s/load-images.sh" ff-runtime-nodejs:24-v2 ff-runtime-python:3.13-v2 >/dev/null 2>&1
  echo "  $FF_CLUSTER_NAME ready, runtime images imported"
}

e2e_build() {
  (cd "$FF_REPO_ROOT/BE" && npm run build >/dev/null)
}

# e2e_migrate <VAR=value...>: runs the migrations from the build, as a deploy step would.
e2e_migrate() {
  (cd "$FF_REPO_ROOT/BE" && env "$@" npm run migration:run:prod) >"$work/migrations.log" 2>&1 ||
    fail "the migrations failed (see $work/migrations.log)"
}

# e2e_start_backend <log> <base URL> <VAR=value...>: starts the built backend and
# waits until it answers. It is stopped on exit.
e2e_start_backend() {
  local log=$1 url=$2 pid
  shift 2
  (cd "$FF_REPO_ROOT/BE" && exec env "$@" node dist/main.js) >"$log" 2>&1 &
  pid=$!
  e2e_pids+=("$pid")
  # A cold start reads thousands of node_modules files. With a cold page cache on
  # a spinning disk that took 23 s just to load the modules, so allow 3 minutes.
  for _ in $(seq 1 "${FF_E2E_BACKEND_START_SECONDS:-180}"); do
    kill -0 "$pid" 2>/dev/null || fail "the backend exited during startup (see $log)"
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/api-json")" = 200 ] && return 0
    sleep 1
  done
  fail "the backend did not answer on $url (see $log)"
}
