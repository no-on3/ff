#!/usr/bin/env bash
# Step 4's sites spike (the step-4 plan's W-01): a SeaweedFS of its own, as FF's store, holding a built site (an index,
# a folder with its own, an error document, ASSETS hashed assets, SMALL small files, a file stored without a type, one
# large file); website-server.mjs twice in front of it, a single-page app's and a plain site's; then load.mjs's checks
# and measures, and what each server counted, with its memory. The store's container is removed on exit.
#   hack/spikes/sites/website.sh                  # about a minute
#   ASSETS=60 SMALL=2000 hack/spikes/sites/website.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-sites"
"$FF_REPO_ROOT/hack/check-resources.sh"
rm -rf "$work" && mkdir -p "$work/site/assets" "$work/site/small" "$work/site/docs"
export ASSETS="${ASSETS:-30}" SMALL="${SMALL:-500}"

free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
key="spike$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
secret="$(head -c 30 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
printf '{"identities": [{"name": "spike", "credentials": [{"accessKey": "%s", "secretKey": "%s"}], "actions": ["Admin", "Read", "List", "Write"]}]}\n' \
  "$key" "$secret" >"$work/s3.json"
chmod 644 "$work/s3.json"
container="ff-spike-sites-$$"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  docker rm -f -v "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$container" -p 127.0.0.1::8333 -v "$work/s3.json:/etc/seaweedfs/s3.json:ro" chrislusf/seaweedfs:4.48 \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
store="http://127.0.0.1:$(docker port "$container" 8333/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$store/")" != 000 ] && break; sleep 1; done

# The site: what a build makes.
echo '<!doctype html><title>index</title><script src="/assets/app-0.js"></script>' >"$work/site/index.html"
echo '<!doctype html><title>docs index</title>' >"$work/site/docs/index.html"
echo '<!doctype html><title>error page</title>' >"$work/site/404.html"
for i in $(seq 0 $((ASSETS - 1))); do head -c 75000 /dev/urandom | base64 -w 120 | sed 's/^/\/\/ /' >"$work/site/assets/app-$i.js"; done
for i in $(seq 0 $((SMALL - 1))); do head -c 1500 /dev/urandom | base64 >"$work/site/small/f-$i.txt"; done
head -c $((50 * 1024 * 1024)) /dev/urandom >"$work/site/large.bin"
aws_store() { env AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_REGION=us-east-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null aws --endpoint-url "$store" "$@"; }
aws_store s3 mb s3://spike-site >/dev/null
started=$SECONDS
aws_store s3 sync --quiet "$work/site" s3://spike-site
echo "{\"uploaded\": $((ASSETS + SMALL + 4)), \"files with aws s3 sync in s\": $((SECONDS - started))}"
# Another bucket, whose object no path of the first must reach.
aws_store s3 mb s3://spike-other >/dev/null
printf 'the other bucket\n' >"$work/secret.txt"
aws_store s3 cp --quiet "$work/secret.txt" s3://spike-other/secret.txt
printf 'body { color: navy }\n' >"$work/untyped.css"
aws_store s3api put-object --bucket spike-site --key untyped.css --body "$work/untyped.css" >/dev/null

spa_port="$(free_port)" site_port="$(free_port)"
for entry in "1 $spa_port" "0 $site_port"; do
  read -r spa port <<<"$entry"
  PORT="$port" STORE="$store" STORE_KEY="$key" STORE_SECRET="$secret" BUCKET=spike-site SPA="$spa" \
    node "$here/website-server.mjs" >"$work/server-$spa.json" 2>"$work/server-$spa.log" &
  pids+=($!)
done
for port in "$spa_port" "$site_port"; do
  for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
done
rss() { awk '/^VmRSS/ { printf "%d", $2 / 1024 }' "/proc/$1/status"; }
echo "{\"website server's memory before, MB\": $(rss "${pids[1]}")}"

SPA_URL="http://127.0.0.1:$spa_port" SITE_URL="http://127.0.0.1:$site_port" STORE="$store" STORE_KEY="$key" STORE_SECRET="$secret" BUCKET=spike-site \
  node "$here/load.mjs" | tee "$work/results.jsonl"

echo "{\"website server's memory after, MB\": $(rss "${pids[1]}")}"
for pid in "${pids[@]}"; do kill -TERM "$pid"; wait "$pid" 2>/dev/null || true; done
pids=()
echo "single-page app's server: $(cat "$work/server-1.json")"
echo "plain site's server: $(cat "$work/server-0.json")"
jq -rs '[.[] | select(.check)] | "checks: \(map(select(.ok)) | length) of \(length) as wanted\(map(select(.ok | not) | "\n  not as wanted: \(.check) (want \(.want), got \(.got))") | join(""))"' "$work/results.jsonl"
