#!/usr/bin/env bash
# L2 smoke test: builds the runtime image and runs it with the same hardening
# Kubernetes applies (read-only root, tmpfs /tmp, uid 10001, no capabilities,
# no privilege escalation, memory/CPU limits), then checks the protocol.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="${IMAGE:-ff-runtime-nodejs:24-v1}"
name="ff-runtime-smoke-$$"

"$repo/hack/check-resources.sh"
docker build -q -t "$image" "$here/.." >/dev/null
echo "built $image ($(docker image inspect "$image" --format '{{.Size}}' | awk '{ printf "%d MB", $1 / 1e6 }'))"

trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" \
  --read-only --tmpfs /tmp:rw,size=64m \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 0.5 \
  -e FUNCTION_NAME=hello -e FUNCTION_TIMEOUT=3000 -e FUNCTION_MEMORY_LIMIT=128 \
  -v "$here/fixtures/hello:/var/task:ro" \
  -p 127.0.0.1::8080 "$image" >/dev/null
port="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"

passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}

for _ in $(seq 1 50); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz")" = 200 ] && break
  sleep 0.2
done

check "readyz" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz")"
check "invoke returns the greeting" "Hello container" \
  "$(curl -s -X POST -H 'content-type: application/json' -d '{"name":"container"}' "http://127.0.0.1:$port/invoke" | jq -r .message)"
check "runs as uid 10001" 10001 "$(docker exec "$name" id -u)"
check "root filesystem is read-only" denied \
  "$(docker exec "$name" sh -c 'touch /opt/ff/probe 2>/dev/null && echo writable || echo denied')"
check "/tmp is writable" ok "$(docker exec "$name" sh -c 'touch /tmp/probe && echo ok')"
check "no install at start (no npm activity in logs)" 0 "$(docker logs "$name" 2>&1 | grep -c 'npm' || true)"

echo "container smoke: $passed passed"
