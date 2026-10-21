#!/usr/bin/env bash
# L2 smoke test: builds the runtime image and runs it with the same hardening
# Kubernetes applies (read-only root, tmpfs /tmp, uid 10001, no capabilities,
# no privilege escalation, memory/CPU limits), then checks the protocol.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="${IMAGE:-ff-runtime-nodejs:24-v3}"
name="ff-runtime-smoke-$$"

"$repo/hack/check-resources.sh"
docker build -q -t "$image" "$here/.." >/dev/null
echo "built $image ($(docker image inspect "$image" --format '{{.Size}}' | awk '{ printf "%d MB", $1 / 1e6 }'))"

trap 'docker rm -f "$name" "$name-cwd" >/dev/null 2>&1 || true' EXIT
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
check "has no package manager: npm, npx, corepack and yarn removed" none \
  "$(docker exec "$name" sh -c 'for tool in npm npx corepack yarn; do command -v $tool; done; ls /usr/local/lib/node_modules 2>/dev/null' | paste -sd, - | sed 's/^$/none/')"
check "root filesystem is read-only" denied \
  "$(docker exec "$name" sh -c 'touch /opt/ff/probe 2>/dev/null && echo writable || echo denied')"
check "/tmp is writable" ok "$(docker exec "$name" sh -c 'touch /tmp/probe && echo ok')"
check "no install at start (no npm activity in logs)" 0 "$(docker logs "$name" 2>&1 | grep -c 'npm' || true)"
check "speaks runtime protocol 3" 1 "$(docker logs "$name" 2>&1 | grep -c '"protocol":3' || true)"
# The TypeScript compiler's code cache, written at the build, taken by V8 in a worker thread with a small heap, as
# the runtime loads user code: refused, a cold start at 0.1 CPU takes seconds longer, and nothing else says so.
check "the TypeScript compiler's code cache is taken, in a worker thread" true \
  "$(docker exec "$name" node -e "
const { Worker } = require('node:worker_threads');
const code = 'require(\"node:worker_threads\").parentPort.postMessage(require(\"/opt/ff/dist/typescript-cache\").loadTypeScript().cached)';
new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 6 } }).once('message', console.log);")"

# The function runs in its task root, so a relative path finds the files next to its code.
docker run -d --name "$name-cwd" \
  --read-only --tmpfs /tmp:rw,size=64m \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 0.5 \
  -e FUNCTION_NAME=cwd -e FUNCTION_TIMEOUT=3000 -e FUNCTION_MEMORY_LIMIT=128 \
  -v "$here/fixtures/cwd:/var/task:ro" \
  -p 127.0.0.1::8080 "$image" >/dev/null
port="$(docker port "$name-cwd" 8080/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 50); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz")" = 200 ] && break
  sleep 0.2
done
check "runs in /var/task and reads a file next to the code" "/var/task next to the code" \
  "$(curl -s -X POST -d '{}' "http://127.0.0.1:$port/invoke" | jq -r '"\(.cwd) \(.data)"')"

echo "container smoke: $passed passed"
