#!/usr/bin/env bash
# The platform's images, built and run as Kubernetes runs them: a numeric non-root user, a read-only root with
# /tmp writable, no capability, no privilege escalation, memory and CPU limits.
#   - the backend (BE/Dockerfile): its migrations run from it against a PostgreSQL of the test's own; then, in
#     production mode, it answers /healthz and /readyz (the database, and the dev cluster's API with the
#     backend's own token), names each request, writes JSON log lines, serves its metrics on their port, and
#     keeps the API's documents off; with development settings it refuses to start;
#   - the console (FE/) and the admin app (admin/): their URLs baked into the bundle, index.html for the
#     router's paths, the hashed files cached a year and a missing one a 404, the security headers; and a build
#     without its login refused.
# Needs Docker and the dev cluster (hack/k8s/cluster-up.sh). Removes what it starts.
#   hack/test-images.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
tag="${FF_IMAGE_TAG:-test}"
prefix="ff-images-$$"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
work="$(mktemp -d)"
trap 'docker rm -f "$prefix-db" "$prefix-backend" "$prefix-console" "$prefix-admin" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
size() { docker image inspect "$1" --format '{{.Size}}' | awk '{ printf "%d MB", $1 / 1e6 }'; }
# The hardening every platform container gets in the cluster.
hardened=(--read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 1)

echo "== the backend"
docker build -q -t "ff-backend:$tag" "$FF_REPO_ROOT/BE" >/dev/null
echo "  built ff-backend:$tag ($(size "ff-backend:$tag"))"
check "it runs as the numeric user 10001, Node.js 24.21.0" "10001:10001 v24.21.0" \
  "$(docker image inspect "ff-backend:$tag" --format '{{.Config.User}}') $(docker run --rm "ff-backend:$tag" node --version)"
check "with its production dependencies only: no TypeScript, no ts-node, no Jest, no Nest CLI" "0" \
  "$(docker run --rm "ff-backend:$tag" sh -c 'ls -d node_modules/typescript node_modules/ts-node node_modules/jest node_modules/@nestjs/cli 2>/dev/null | wc -l')"

pg_port="$(free_port)"
docker run -d --name "$prefix-db" -e POSTGRES_PASSWORD=images-test-password -e POSTGRES_DB=ff -p "127.0.0.1:$pg_port:5432" postgres:15-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$prefix-db" pg_isready -U postgres -d ff >/dev/null 2>&1 && break; sleep 1; done
port="$(free_port)"
metrics_port="$(free_port)"
# Function URLs', buckets' and queues' ports too: with host networking, a development backend here may hold the defaults.
url_port="$(free_port)"
storage_port="$(free_port)"
sqs_port="$(free_port)"
# The backend's cluster credentials, readable by the container's user: copies in the test's own directory, which
# only this user may enter.
install -m 644 "$FF_SA_TOKEN_FILE" "$work/token"
install -m 644 "$FF_CA_FILE" "$work/ca.crt"
# A key of the test's own for functions' variables and secrets, as production requires one, readable there too.
printf 'images-test:%s\n' "$(openssl rand -base64 32)" >"$work/encryption-keys"
chmod 644 "$work/encryption-keys"
# What production requires, none of it a development default. S3 and SMTP are never reached: the backend starts
# without them and reports their errors when it uses them. No function is deployed: the sandbox is only named.
env=(
  -e NODE_ENV=production -e PORT="$port" -e FF_METRICS_PORT="$metrics_port" -e FF_METRICS_HOST=127.0.0.1
  -e DB_HOST=127.0.0.1 -e DB_PORT="$pg_port" -e DB_USERNAME=postgres -e DB_PASSWORD=images-test-password -e DB_NAME=ff
  -e FF_OBJECT_STORE_ENDPOINT=127.0.0.1 -e FF_OBJECT_STORE_PORT=1 -e FF_OBJECT_STORE_USE_SSL=false -e FF_OBJECT_STORE_ACCESS_KEY=images-test -e FF_OBJECT_STORE_SECRET_KEY=images-test-secret
  -e FF_OIDC_ISSUER=https://login.ff.test/realms/ff -e FF_OIDC_AUDIENCE=ff-api -e CORS_ORIGIN=https://console.ff.test
  -e FF_SMTP_URL=smtp://127.0.0.1:1 -e FF_CONSOLE_URL=https://console.ff.test -e FF_OPERATOR_EMAIL=operator@ff.test
  -e FF_SELLER_NAME='FF test' -e FF_SELLER_TAX_ID=0000000/A/M/000 -e FF_SELLER_ADDRESS='1 rue du Test, Tunis'
  -e FF_BANK_NAME='Test bank' -e FF_BANK_IBAN='TN20 1400 6006 0100 0000 0001'
  -e K8S_API_URL="https://127.0.0.1:$FF_API_PORT" -e K8S_INVOKE_MODE=proxy -e K8S_RUNTIME_CLASS=gvisor
  -e K8S_TOKEN_FILE=/etc/ff/kube/token -e K8S_CA_FILE=/etc/ff/kube/ca.crt
  -v "$work/token:/etc/ff/kube/token:ro" -v "$work/ca.crt:/etc/ff/kube/ca.crt:ro"
  # Production's addresses are https, and every function's code comes from the code registry, never reached here.
  -e FF_FUNCTION_URL_BASE=https://fn.ff.test -e FF_STORAGE_BASE=https://s3.ff.test -e FF_SQS_BASE=https://sqs.ff.test -e FF_WEBSITE_BASE=https://site.ff.test
  -e FF_CODE_REGISTRY=http://127.0.0.1:1
  -e FF_FUNCTION_URL_PORT="$url_port" -e FF_STORAGE_PORT="$storage_port" -e FF_SQS_PORT="$sqs_port" -e FF_WEBSITE_PORT=0
  -e FF_ENCRYPTION_KEYS_FILE=/etc/ff/keys/keys -v "$work/encryption-keys:/etc/ff/keys/keys:ro"
)
# Host networking: the database's and the cluster's ports are this machine's.
migrated=0
docker run --rm --network host "${hardened[@]}" --user 10001:10001 "${env[@]}" "ff-backend:$tag" \
  node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js >"$work/migrations.log" 2>&1 || migrated=$?
check "its migrations run from the image, as the step before a rollout" "0 true" \
  "$migrated $(grep -q 'executed successfully' "$work/migrations.log" && echo true || echo false)"

refused=0
docker run --rm --network host "${hardened[@]}" "${env[@]}" -e FF_AUTH_MODE=dev -e FF_DEV_ACCOUNT_ID=000000000001 "ff-backend:$tag" >"$work/refused.log" 2>&1 || refused=$?
check "production refuses development settings, and says why" "1 true" \
  "$refused $(grep -q 'FF_AUTH_MODE=dev is for development only' "$work/refused.log" && echo true || echo false)"

docker run -d --name "$prefix-backend" --network host "${hardened[@]}" "${env[@]}" "ff-backend:$tag" >/dev/null
api="http://127.0.0.1:$port"
for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$api/healthz")" = 200 ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$prefix-backend")" = true ] || { docker logs --tail 20 "$prefix-backend"; exit 1; }
  sleep 1
done
check "it starts on a read-only root, as uid 10001, and is alive" "200 10001" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$api/healthz") $(docker exec "$prefix-backend" id -u)"
check "it has no package manager: npm, npx, corepack and yarn removed" none \
  "$(docker exec "$prefix-backend" sh -c 'for tool in npm npx corepack yarn; do command -v $tool; done; ls /usr/local/lib/node_modules 2>/dev/null' | paste -sd, - | sed 's/^$/none/')"
check "and ready: its database and the cluster answer" '200 {"database":"ok","kubernetes":"ok"}' \
  "$(curl -s -o "$work/ready" -w '%{http_code}' "$api/readyz") $(jq -c .checks "$work/ready")"
check "each answer names its request" true \
  "$(curl -s -D - -o /dev/null "$api/healthz" | tr -d '\r' | grep -qiE '^x-ff-request-id: [0-9a-f-]{36}$' && echo true || echo false)"
check "the API's documents are off in production" "404 404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$api/api") $(curl -s -o /dev/null -w '%{http_code}' "$api/api-json")"
check "its metrics, on their own port" true \
  "$(curl -s "http://127.0.0.1:$metrics_port/metrics" | grep -q '^ff_backend_process_resident_memory_bytes ' && echo true || echo false)"
check "queues' SQS endpoint, on its own port, refuses a request with no signature as SQS does" "403 com.amazonaws.sqs#MissingAuthenticationToken" \
  "$(curl -s -o "$work/sqs" -w '%{http_code}' -X POST -H 'Content-Type: application/x-amz-json-1.0' -H 'X-Amz-Target: AmazonSQS.ListQueues' -d '{}' "http://127.0.0.1:$sqs_port/") $(jq -r .__type "$work/sqs")"
check "every line of its log is one JSON object" true \
  "$(docker logs "$prefix-backend" 2>&1 | python3 -c '
import json, sys
lines = [line for line in sys.stdin if line.strip()]
print(str(bool(lines) and all(isinstance(json.loads(line), dict) for line in lines)).lower())')"

# static <name> <directory> <client>: builds the app with its URLs baked in, runs it hardened, and checks it.
static() {
  local name=$1 dir=$2 client=$3 url port asset refused=0
  echo "== the $name"
  docker build -q -t "ff-$name:$tag" --build-arg VITE_API_URL=https://api.ff.test \
    --build-arg VITE_OIDC_AUTHORITY=https://login.ff.test/realms/ff "$FF_REPO_ROOT/$dir" >/dev/null
  echo "  built ff-$name:$tag ($(size "ff-$name:$tag"))"
  docker build -q --build-arg VITE_API_URL=https://api.ff.test "$FF_REPO_ROOT/$dir" >"$work/$name-refused.log" 2>&1 || refused=$?
  check "a build without its login is refused" "true true" \
    "$([ "$refused" -ne 0 ] && echo true || echo false) $(grep -q 'VITE_API_URL and VITE_OIDC_AUTHORITY are required' "$work/$name-refused.log" && echo true || echo false)"
  check "it runs as the numeric user 65532" "65532:65532" "$(docker image inspect "ff-$name:$tag" --format '{{.Config.User}}')"
  port="$(free_port)"
  docker run -d --name "$prefix-$name" "${hardened[@]}" -p "127.0.0.1:$port:8080" "ff-$name:$tag" >/dev/null
  url="http://127.0.0.1:$port"
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/healthz")" = 200 ] && break; sleep 0.5; done
  check "it starts on a read-only root and is alive" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$url/healthz")"
  curl -s -D "$work/$name-headers" -o "$work/$name-index.html" "$url/"
  check "the app, never cached, with the security headers, and no Server header" "true no-cache nosniff DENY false" \
    "$(grep -q '<div id="root">' "$work/$name-index.html" && echo true || echo false) $(tr -d '\r' <"$work/$name-headers" | awk -F': ' 'tolower($1) == "cache-control" {printf "%s", $2}') $(tr -d '\r' <"$work/$name-headers" | awk -F': ' 'tolower($1) == "x-content-type-options" {printf "%s", $2}') $(tr -d '\r' <"$work/$name-headers" | awk -F': ' 'tolower($1) == "x-frame-options" {printf "%s", $2}') $(grep -qi '^server:' "$work/$name-headers" && echo true || echo false)"
  check "a path of the app's router gets the app" true \
    "$(curl -s "$url/accounts/000000000001?tab=usage" | grep -q '<div id="root">' && echo true || echo false)"
  asset="$(grep -o '/assets/index-[^"]*\.js' "$work/$name-index.html" | head -1)"
  check "its bundle has the API, the login and the client baked in" "true true true" \
    "$(curl -s "$url$asset" >"$work/$name.js"; for needle in https://api.ff.test https://login.ff.test/realms/ff "$client"; do grep -q "$needle" "$work/$name.js" && printf 'true ' || printf 'false '; done | sed 's/ $//')"
  # Browsers run a module script only when it is served as JavaScript.
  check "its script and styles served with their types" "text/javascript text/css" \
    "$(curl -s -o /dev/null -w '%{content_type}' "$url$asset" | cut -d';' -f1) $(curl -s -o /dev/null -w '%{content_type}' "$url$(grep -o '/assets/index-[^"]*\.css' "$work/$name-index.html" | head -1)" | cut -d';' -f1)"
  check "its hashed files are cached a year, and a missing one is a 404" "public, max-age=31536000, immutable 404" \
    "$(curl -s -D - -o /dev/null "$url$asset" | tr -d '\r' | awk -F': ' 'tolower($1) == "cache-control" {printf "%s", $2}') $(curl -s -o /dev/null -w '%{http_code}' "$url/assets/missing-0000.js")"
}
static console FE ff-console
static admin admin ff-admin

echo "images: $passed checks passed"
