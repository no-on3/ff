#!/usr/bin/env bash
# L2 smoke test: builds the runtime image and runs it with the same hardening
# Kubernetes applies (read-only root, tmpfs /tmp, uid 10001, no capabilities,
# no privilege escalation, memory/CPU limits), then checks the protocol.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="${IMAGE:-ff-runtime-python:3.13-v3}"
prefix="ff-runtime-smoke-$$"

"$repo/hack/check-resources.sh"
docker build -q -t "$image" "$here/.." >/dev/null
echo "built $image ($(docker image inspect "$image" --format '{{.Size}}' | awk '{ printf "%d MB", $1 / 1e6 }'))"

trap 'docker rm -f "$prefix-hello" "$prefix-oom" >/dev/null 2>&1 || true' EXIT
start() { # <name> <fixture> [docker args...]: prints the published port
  local name="$prefix-$1" fixture="$2"
  shift 2
  docker run -d --name "$name" \
    --read-only --tmpfs /tmp:rw,size=64m \
    --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
    --memory 256m --cpus 0.5 \
    -e FUNCTION_NAME="$fixture" -e FUNCTION_TIMEOUT=10000 -e FUNCTION_MEMORY_LIMIT=128 "$@" \
    -v "$here/fixtures/$fixture:/var/task:ro" \
    -p 127.0.0.1::8080 "$image" >/dev/null
  docker port "$name" 8080/tcp | head -1 | sed 's/.*://'
}
wait_ready() { # <port>
  for _ in $(seq 1 50); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/readyz")" = 200 ] && return 0
    sleep 0.2
  done
  return 1
}

passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}

port="$(start hello hello)"
wait_ready "$port" || true
check "readyz" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz")"
check "invoke returns the greeting" "Hello container" \
  "$(curl -s -X POST -H 'content-type: application/json' -d '{"name":"container"}' "http://127.0.0.1:$port/invoke" | jq -r .message)"
check "runs as uid 10001" 10001 "$(docker exec "$prefix-hello" id -u)"
check "has no pip: removed, with the packages it vendors" "none" \
  "$(docker exec "$prefix-hello" sh -c 'command -v pip pip3; python -c "import pip" 2>/dev/null && echo importable; ls /usr/local/lib/python3.13/ensurepip 2>/dev/null' | paste -sd, - | sed 's/^$/none/')"
check "root filesystem is read-only" denied \
  "$(docker exec "$prefix-hello" sh -c 'touch /opt/ff/probe 2>/dev/null && echo writable || echo denied')"
check "/tmp is writable" ok "$(docker exec "$prefix-hello" sh -c 'touch /tmp/probe && echo ok')"
check "user output reaches the container log" 1 "$(docker logs "$prefix-hello" 2>&1 | grep -c 'hello from user code' || true)"
check "no install at start (no pip activity in logs)" 0 "$(docker logs "$prefix-hello" 2>&1 | grep -ci 'pip' || true)"
check "speaks runtime protocol 3" 1 "$(docker logs "$prefix-hello" 2>&1 | grep -c '"protocol": 3' || true)"

# Inside the container's 256 MB limit, a function that hoards memory gets
# Runtime.OutOfMemory from the runtime's own limit, and the container survives.
port="$(start oom oom)"
wait_ready "$port" || true
check "memory hoarding is reported as Runtime.OutOfMemory" Runtime.OutOfMemory \
  "$(curl -s -X POST -d '{}' "http://127.0.0.1:$port/invoke" | jq -r .errorType)"
wait_ready "$port" || true
check "a fresh worker is ready afterwards" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz")"
check "the container was not OOM-killed" "false 0" \
  "$(docker inspect "$prefix-oom" --format '{{.State.OOMKilled}} {{.RestartCount}}')"

echo "container smoke: $passed passed"
