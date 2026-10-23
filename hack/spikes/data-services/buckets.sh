#!/usr/bin/env bash
# Step 2's spike, its buckets half (the step-2 plan's V-01, for ADR 0009): the minimal S3 front door of this folder
# (front-door.mjs) in front of FF's development SeaweedFS, against AWS's SDK for JavaScript v3, boto3 and the AWS
# CLI, each with its defaults and only the endpoint changed: what each sends (addressing, signatures, streaming
# uploads and their trailing checksums), whether each works, presigned URLs, multipart; the front door's throughput
# against the store's own, and its memory; and what a bucket's size costs to measure.
#   hack/spikes/data-services/buckets.sh             # about 5 minutes; npm and pip fetch the SDKs the first time
#   OBJECTS=2000 hack/spikes/data-services/buckets.sh  # fewer objects for the size's measure (10,000 by default)
# Needs FF's development stack (docker compose up: SeaweedFS on 127.0.0.1:9003), Node.js 22+, Python 3 and the AWS
# CLI v2. Results: hack/.data-services-spike/buckets.md. Its buckets on the store are removed on exit.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$repo/hack/check-resources.sh"

work="$repo/hack/.data-services-spike/buckets"
results="$repo/hack/.data-services-spike/buckets.md"
cache="$repo/hack/.data-services-spike/clients"
mkdir -p "$work" "$cache"
rm -rf "${work:?}"/*
port=55480
store_endpoint="http://127.0.0.1:${FF_S3_PORT:-9003}"
OBJECTS="${OBJECTS:-10000}"
suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
photos_store="ff-spike-photos-$suffix"
other_store="ff-spike-other-$suffix"
direct=(env AWS_ACCESS_KEY_ID=ffdevaccesskey AWS_SECRET_ACCESS_KEY=ffdevsecretkey-local-only AWS_REGION=us-east-1 AWS_PAGER= aws --endpoint-url "$store_endpoint")
key_a="AKFF$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | tr a-f A-F)"
key_b="AKFF$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | tr a-f A-F)"
secret_a="$(head -c 30 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
secret_b="$(head -c 30 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"

door_pid=""
cleanup() {
  [ -n "$door_pid" ] && kill "$door_pid" 2>/dev/null || true
  "${direct[@]}" s3 rb "s3://$photos_store" --force >/dev/null 2>&1 || true
  "${direct[@]}" s3 rb "s3://$other_store" --force >/dev/null 2>&1 || true
}
trap cleanup EXIT
note() { printf '%s\n' "$*" >>"$results"; }
ms_since() { echo $((($(date +%s%N) - $1) / 1000000)); }

# ---------- the clients, pinned to what is newest today ----------
echo "== the clients" >&2
if [ ! -d "$cache/node_modules/@aws-sdk/client-s3" ]; then
  (cd "$cache" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/lib-storage >/dev/null)
fi
if [ ! -x "$cache/venv/bin/python" ]; then
  python3 -m venv "$cache/venv"
  "$cache/venv/bin/pip" install --quiet --disable-pip-version-check boto3
fi
sdk_version="$(node -p "require('$cache/node_modules/@aws-sdk/client-s3/package.json').version")"
boto3_version="$("$cache/venv/bin/python" -c 'import boto3, botocore; print(boto3.__version__, "/ botocore", botocore.__version__)')"
cli_version="$(aws --version 2>&1 | awk '{print $1}')"

# ---------- the store and the front door ----------
"${direct[@]}" s3 mb "s3://$photos_store" >/dev/null
"${direct[@]}" s3 mb "s3://$other_store" >/dev/null
echo "another account's" | "${direct[@]}" s3 cp - "s3://$other_store/secret.txt" >/dev/null
cat >"$work/keys.json" <<EOF
{"keys": {"$key_a": {"secret": "$secret_a", "buckets": ["photos"]}, "$key_b": {"secret": "$secret_b", "buckets": ["other"]}},
 "buckets": {"photos": "$photos_store", "other": "$other_store"}}
EOF
PORT=$port KEYS_FILE="$work/keys.json" LOG="$work/requests.jsonl" COUNTS="$work/counts.json" UPSTREAM="$store_endpoint" \
  node "$here/front-door.mjs" 2>"$work/front-door.log" &
door_pid=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  sleep 0.1
done

: >"$results"
note "# Buckets spike ($(date -u +%Y-%m-%dT%H:%MZ))"
note ""
note "The front door (\`front-door.mjs\`, Node.js $(node --version)) on port $port, virtual-hosted under \`s3.localhost\`, in front of SeaweedFS $(docker exec ff-s3-1 weed version 2>/dev/null | head -1 | awk '{print $3}') (FF's development store). Clients, with their defaults: AWS SDK for JavaScript v3 $sdk_version (client-s3, s3-request-presigner, lib-storage); boto3 $boto3_version; AWS CLI $cli_version. Each gets only an endpoint, the region \`tn-tunis-1\` and its account's key."

# ---------- the checks ----------
echo "== the SDKs and the CLI" >&2
ENDPOINT="http://s3.localhost:$port" IP_ENDPOINT="http://127.0.0.1:$port" KEY="$key_a" SECRET="$secret_a" BUCKET=photos OTHER_BUCKET=other MODULES="$cache" \
  node "$here/sdk-check.mjs" >"$work/checks.jsonl" 2>"$work/sdk.log" || true
ENDPOINT="http://s3.localhost:$port" KEY="$key_a" SECRET="$secret_a" BUCKET=photos OTHER_BUCKET=other \
  "$cache/venv/bin/python" "$here/boto3_check.py" >>"$work/checks.jsonl" 2>"$work/boto3.log" || true

cli=(env AWS_ACCESS_KEY_ID="$key_a" AWS_SECRET_ACCESS_KEY="$secret_a" AWS_REGION=tn-tunis-1 AWS_PAGER= aws --endpoint-url "http://s3.localhost:$port")
cli_check() { # want what command…
  local want="$1" what="$2" out status=0 got
  shift 2
  out="$("$@" 2>&1)" || status=$?
  got=ok
  [ "$status" -eq 0 ] || got=refused
  python3 -c 'import json,sys; print(json.dumps({"client": "aws-cli", "want": sys.argv[1], "got": sys.argv[2], "what": sys.argv[3], "detail": sys.argv[4][:160]}))' "$want" "$got" "$what" "$(printf '%s' "$out" | tr '\n' ' ')" >>"$work/checks.jsonl"
}
head -c 1024 /dev/urandom >"$work/small.bin"
head -c $((30 * 1024 * 1024)) /dev/urandom >"$work/30mb.bin"
mkdir -p "$work/tree/a" "$work/back"
for i in 1 2 3; do echo "file $i" >"$work/tree/a/$i.txt"; done
cli_check ok "s3 cp, a small file" "${cli[@]}" s3 cp "$work/small.bin" s3://photos/cli/small.bin
cli_check ok "s3 cp, 30 MB: multipart" "${cli[@]}" s3 cp "$work/30mb.bin" s3://photos/cli/30mb.bin
cli_check ok "s3 cp back, 30 MB, the same bytes" bash -c "$(printf '%q ' "${cli[@]}") s3 cp s3://photos/cli/30mb.bin '$work/30mb.back' >/dev/null && cmp '$work/30mb.bin' '$work/30mb.back' && echo same"
cli_check ok "s3 ls" "${cli[@]}" s3 ls s3://photos/cli/
cli_check ok "s3api list-objects-v2" "${cli[@]}" s3api list-objects-v2 --bucket photos --prefix cli/ --query 'Contents[].Key' --output text
cli_check ok "s3 sync up: a folder" "${cli[@]}" s3 sync "$work/tree" s3://photos/tree/
cli_check ok "s3 sync down: the way out" bash -c "$(printf '%q ' "${cli[@]}") s3 sync s3://photos/tree/ '$work/back' >/dev/null && diff -r '$work/tree' '$work/back' && echo same"
cli_check ok "s3 presign, then curl" bash -c "curl -sf \"\$($(printf '%q ' "${cli[@]}") s3 presign s3://photos/cli/small.bin --expires-in 300)\" | cmp - '$work/small.bin' && echo same"
cli_check ok "s3 ls: the buckets" "${cli[@]}" s3 ls
cli_check refused "s3 ls of a bucket the key may not reach" "${cli[@]}" s3 ls s3://other/
cli_check ok "s3 rm --recursive" "${cli[@]}" s3 rm s3://photos/cli/ --recursive

note ""
note "## Checks"
note ""
note "| Client | Check | Expected | Got | What it said | |"
note "|---|---|---|---|---|---|"
passes=0
fails=0
while IFS= read -r line; do
  row="$(python3 -c '
import json, sys
c = json.loads(sys.argv[1])
mark = "pass" if c["want"] == c["got"] else "FAIL"
detail = c["detail"].replace("|", "/").replace("`", "")
print(mark, "| %s | %s | %s | %s | `%s` | %s |" % (c["client"], c["what"], c["want"], c["got"], detail, mark))' "$line")"
  case "$row" in pass*) passes=$((passes + 1)) ;; *) fails=$((fails + 1)) ;; esac
  note "${row#* }"
done <"$work/checks.jsonl"
[ -s "$work/sdk.log" ] && note "" && note "The SDK's script also printed: \`$(head -c 300 "$work/sdk.log" | tr '\n' ' ')\`"
[ -s "$work/boto3.log" ] && note "" && note "boto3's script also printed: \`$(head -c 300 "$work/boto3.log" | tr '\n' ' ')\`"

# ---------- throughput and memory ----------
echo "== throughput" >&2
rss() { awk '/VmRSS/ {print $2, $3}' "/proc/$door_pid/status"; }
rss_before="$(rss)"
head -c $((200 * 1024 * 1024)) /dev/urandom >"$work/200mb.bin"
timed() { local started; started="$(date +%s%N)"; "$@" >/dev/null; ms_since "$started"; }
direct_up="$(timed "${direct[@]}" s3 cp "$work/200mb.bin" "s3://$photos_store/throughput/direct.bin")"
door_up="$(timed "${cli[@]}" s3 cp "$work/200mb.bin" s3://photos/throughput/door.bin)"
direct_down="$(timed "${direct[@]}" s3 cp "s3://$photos_store/throughput/direct.bin" "$work/direct.back")"
door_down="$(timed "${cli[@]}" s3 cp s3://photos/throughput/door.bin "$work/door.back")"
single_up="$(timed env MODULES="$cache" ENDPOINT="http://127.0.0.1:$port" KEY="$key_a" SECRET="$secret_a" node -e "
const { createRequire } = require('node:module'); const r = createRequire(process.env.MODULES + '/');
const s3 = r('@aws-sdk/client-s3'); const fs = require('node:fs');
new s3.S3Client({ endpoint: process.env.ENDPOINT, region: 'tn-tunis-1', credentials: { accessKeyId: process.env.KEY, secretAccessKey: process.env.SECRET } })
  .send(new s3.PutObjectCommand({ Bucket: 'photos', Key: 'throughput/single.bin', Body: fs.createReadStream('$work/200mb.bin'), ContentLength: 200 * 1024 * 1024 }))
  .catch((e) => { console.error(e); process.exit(1); });")"
single_direct="$(timed env MODULES="$cache" node -e "
const { createRequire } = require('node:module'); const r = createRequire(process.env.MODULES + '/');
const s3 = r('@aws-sdk/client-s3'); const fs = require('node:fs');
new s3.S3Client({ endpoint: '$store_endpoint', forcePathStyle: true, region: 'us-east-1', credentials: { accessKeyId: 'ffdevaccesskey', secretAccessKey: 'ffdevsecretkey-local-only' } })
  .send(new s3.PutObjectCommand({ Bucket: '$photos_store', Key: 'throughput/single-direct.bin', Body: fs.createReadStream('$work/200mb.bin'), ContentLength: 200 * 1024 * 1024 }))
  .catch((e) => { console.error(e); process.exit(1); });")"
rate() { awk -v ms="$1" 'BEGIN { printf "%.0f MB/s", 200 / (ms / 1000) }'; }
peak="$(awk '/VmHWM/ {print $2, $3}' "/proc/$door_pid/status")"
rss_after="$(rss)"
note ""
note "## Throughput, 200 MB of random bytes, on this machine"
note ""
note "| Path | Upload | Download |"
note "|---|---|---|"
note "| AWS CLI to SeaweedFS directly (multipart, 8 MB parts, 10 at a time) | $direct_up ms, $(rate "$direct_up") | $direct_down ms, $(rate "$direct_down") |"
note "| AWS CLI through the front door | $door_up ms, $(rate "$door_up") | $door_down ms, $(rate "$door_down") |"
note "| SDK for JavaScript, one PutObject of a 200 MB stream (aws-chunked, its CRC-32 in a trailer), to SeaweedFS directly | $single_direct ms, $(rate "$single_direct") | |"
note "| The same, through the front door | $single_up ms, $(rate "$single_up") | |"
note ""
note "The front door's memory: $rss_before resident after the checks, $rss_after after the 1 GB of uploads and downloads above, $peak at its peak (VmHWM): what a garbage-collected process holds at 200 MB/s of buffers in flight, not the size of a body."

# ---------- a bucket's size ----------
echo "== a bucket's size, $OBJECTS objects" >&2
mkdir -p "$work/objects"
for i in $(seq 1 "$OBJECTS"); do printf 'object %06d\n' "$i" >"$work/objects/o$i.txt"; done
started="$(date +%s%N)"
"${direct[@]}" s3 cp --recursive --quiet "$work/objects" "s3://$photos_store/many/"
loaded="$(ms_since "$started")"
walk="$(env MODULES="$cache" ENDPOINT="http://127.0.0.1:$port" KEY="$key_a" SECRET="$secret_a" node -e "
const { createRequire } = require('node:module'); const r = createRequire(process.env.MODULES + '/');
const s3 = r('@aws-sdk/client-s3');
const client = new s3.S3Client({ endpoint: process.env.ENDPOINT, region: 'tn-tunis-1', credentials: { accessKeyId: process.env.KEY, secretAccessKey: process.env.SECRET } });
(async () => { const started = Date.now(); let token, objects = 0, bytes = 0, pages = 0;
  do { const page = await client.send(new s3.ListObjectsV2Command({ Bucket: 'photos', ContinuationToken: token }));
       for (const o of page.Contents ?? []) { objects++; bytes += o.Size; } pages++; token = page.NextContinuationToken; } while (token);
  console.log(objects + ' objects, ' + bytes + ' bytes, ' + pages + ' pages of 1,000, in ' + (Date.now() - started) + ' ms'); })();")"
started="$(date +%s%N)"
weed_out="$(echo "s3.bucket.list" | docker exec -i ff-s3-1 weed shell -master=localhost:9333 2>/dev/null | grep -E "$photos_store" | head -3 | tr '\n' ' ' || true)"
weed_ms="$(ms_since "$started")"
note ""
note "## A bucket's size"
note ""
note "- $OBJECTS small objects written straight to the store in $loaded ms, beside the throughput's three of 200 MB."
note "- Walking the bucket's listing through the front door, as an hourly sample could on any store: $walk."
note "- SeaweedFS's own count, \`weed shell\` \`s3.bucket.list\` (its volumes' sizes for the bucket's collection, deleted bytes included until a vacuum), in $weed_ms ms: \`${weed_out:-nothing printed}\`."

# ---------- what the clients sent ----------
kill -TERM "$door_pid" 2>/dev/null || true
wait "$door_pid" 2>/dev/null || true
door_pid=""
note ""
note "## What each client sent, from the front door's log"
note ""
python3 - "$work/requests.jsonl" "$work/counts.json" >>"$results" <<'EOF'
import collections, json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
def client(agent):
    agent = agent or ""
    if "aws-cli" in agent: return "aws-cli"
    if "Boto3" in agent: return "boto3"
    if "aws-sdk-js" in agent or "lib-storage" in agent: return "sdk-js"
    return agent.split(" ")[0] or "(none)"
seen = collections.OrderedDict()
for r in rows:
    key = (client(r.get("userAgent")), r["operation"], r.get("style"), r.get("auth"), r.get("payload"), r.get("contentEncoding"), r.get("trailer"), r.get("checksumHeader"), r.get("checksumAlgorithm"))
    entry = seen.setdefault(key, {"n": 0, "statuses": collections.Counter(), "errors": collections.Counter()})
    entry["n"] += 1
    entry["statuses"][r.get("status")] += 1
    if r.get("error"): entry["errors"][r["error"]] += 1
print("| Client | Operation | Addressing | Signature | x-amz-content-sha256 | Content-Encoding | x-amz-trailer | Checksum header | Requests | Answers |")
print("|---|---|---|---|---|---|---|---|---|---|")
for (who, op, style, auth, payload, encoding, trailer, header, algorithm), entry in seen.items():
    answers = ", ".join(f"{status}×{n}" for status, n in sorted(entry["statuses"].items(), key=lambda x: str(x[0])))
    if entry["errors"]: answers += " (" + ", ".join(entry["errors"]) + ")"
    print(f"| {who} | {op} | {style} | {auth or '-'} | {payload or '-'} | {encoding or '-'} | {trailer or '-'} | {header or algorithm or '-'} | {entry['n']} | {answers} |")
internal = [r for r in rows if r.get("internal")]
if internal:
    print("\nInternal errors:\n")
    for r in internal[:5]: print("- `" + r["internal"].splitlines()[0][:200] + "`")
try:
    counts = json.loads(open(sys.argv[2]).read().splitlines()[-1])
    totals = collections.Counter()
    for c in counts: totals[(c["bucket"], c["class"])] += c["requests"]
    print("\nCounted per bucket and class, as the bill would: " + "; ".join(f"{b} {k}: {n}" for (b, k), n in sorted(totals.items())) + ".")
except (FileNotFoundError, IndexError):
    print("\nNo counts were written.")
EOF
note ""
note "**$passes checks passed, $fails failed.**"
echo "buckets: $passes passed, $fails failed; $results" >&2
