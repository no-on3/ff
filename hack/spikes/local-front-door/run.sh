#!/usr/bin/env bash
# The developer tools' spike of the local front door's shape: S3's PutObject, GetObject and ListObjectsV2 and SQS's
# SendMessage, ReceiveMessage and DeleteMessage, two ways. One is a port to Rust (src/), as `ff local` would serve
# them, its objects as files and its messages in memory, its tests reading the backend's own fixtures. The other is the
# backend's own front doors, BE/dist's, run in Node.js without NestJS and PostgreSQL (node/serve.mjs), its objects in
# SeaweedFS, as the backend's are. Each side is started five times, then driven by the AWS CLI, AWS's SDK for
# JavaScript v3 and boto3, the same twelve checks each (drivers/); then measured: the lines it takes, the time to its
# ports, its memory, the fixtures it passes, and what a developer must have to run it. What it found lands in
# hack/.spikes/local-front-door/results.md.
#   hack/spikes/local-front-door/run.sh      # about 3 minutes; Docker, the AWS CLI, Node.js, and the L4 clients'
#                                            # hack/.cache/{s3,sqs}-clients, which hack/e2e.sh installs
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work local-front-door
source "$repo/hack/lib/checks.sh"
results="$work/results.md"
ACCOUNT=123456789012 KEY=AKIDLOCALSPIKE SECRET=local-spike-secret BUCKET=photos QUEUE=orders
STORE_IMAGE=chrislusf/seaweedfs:4.48
store="ff-spike-local-front-door-store"
s3_clients="$repo/hack/.cache/s3-clients" sqs_clients="$repo/hack/.cache/sqs-clients"
[ -d "$s3_clients/node_modules/@aws-sdk/client-s3" ] && [ -d "$sqs_clients/node_modules/@aws-sdk/client-sqs" ] &&
  [ -x "$s3_clients/venv/bin/python" ] || fail "the L4 clients are not in hack/.cache: hack/e2e.sh installs them"
[ -f "$repo/BE/dist/storage/front-door.js" ] || fail "BE/dist is not built: cd BE && npm run build"
[ -z "$(find "$repo/BE/src/storage" "$repo/BE/src/queues" "$repo/BE/src/common" -name '*.ts' ! -name '*.spec.ts' -newer "$repo/BE/dist/storage/front-door.js")" ] ||
  fail "BE/dist is older than the front doors' sources: cd BE && npm run build"

lines() { cat "$@" | grep -cvE '^\s*(//|/\*|\*|$)'; } # without blank lines and comments
rust_lines() { cat "$@" | grep -cvE '^\s*(//|$)'; }
rust_code_lines() { for file in "$@"; do awk '/^#\[cfg\(test\)\]/ { exit } { print }' "$file"; done | grep -cvE '^\s*(//|$)'; }
millis() { echo $(($(date +%s%N) / 1000000)); }
median() { sort -n | awk '{ value[NR] = $1 } END { print value[int((NR + 1) / 2)] }'; }
kib_to_mb() { awk '{ printf "%.0f", $1 / 1024 }'; }
# Docker's "177.3MiB / 31GiB", in MB.
docker_mb() { awk '{ n = $1 + 0; if ($1 ~ /GiB/) n *= 1024; if ($1 ~ /KiB/) n /= 1024; printf "%.0f", n * 1.048576 }'; }

server='' start_ms=0
stop_server() {
  [ -n "$server" ] || return 0
  kill "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  server=''
}
on_exit stop_server
on_exit "docker rm -f $store >/dev/null 2>&1 || true"

# start <side> <command…>: the server started, its pid in $server, its ports in $side/ports.json, and in $start_ms its
# milliseconds from the start to its ports open. Not in a subshell, which would keep $server to itself.
start() {
  local side=$1 started
  shift
  rm -f "$work/$side/ports.json"
  started="$(millis)"
  "$@" >"$work/$side/ports.json" 2>>"$work/$side/server.log" &
  server=$!
  while [ ! -s "$work/$side/ports.json" ]; do
    kill -0 "$server" 2>/dev/null || fail "the $side server stopped: $(tail -5 "$work/$side/server.log")"
    sleep 0.005
  done
  start_ms=$(($(millis) - started))
}

# measure <side> <command…>: five starts, then the three clients; the side's results in $work/<side>/.
measure() {
  # Not "passed", the checks' own count, which a local of that name would hide from check.
  local side=$1 run times=() s3 sqs count failed
  shift
  rm -rf "${work:?}/$side" && mkdir -p "$work/$side"
  for run in 1 2 3 4 5; do
    start "$side" "$@"
    times+=("$start_ms")
    stop_server
  done
  echo "${times[0]}" >"$work/$side/first-start-ms"
  printf '%s\n' "${times[@]}" | median >"$work/$side/start-ms"
  start "$side" "$@"
  s3="http://localhost:$(jq .s3 "$work/$side/ports.json")" sqs="http://localhost:$(jq .sqs "$work/$side/ports.json")"
  export S3_ENDPOINT="$s3" SQS_ENDPOINT="$sqs" ACCOUNT KEY SECRET BUCKET QUEUE WORK="$work/$side"
  S3_MODULES="$s3_clients/node_modules" SQS_MODULES="$sqs_clients/node_modules" node "$here/drivers/sdk.mjs" >"$work/$side/sdk.jsonl" 2>"$work/$side/sdk.log" || true
  "$s3_clients/venv/bin/python" -I "$here/drivers/boto3_checks.py" >"$work/$side/boto3.jsonl" 2>"$work/$side/boto3.log" || true
  bash "$here/drivers/cli.sh" >"$work/$side/cli.jsonl" 2>"$work/$side/cli.log" || true
  sed -n 's/^VmHWM:\s*\([0-9]*\) kB$/\1/p' "/proc/$server/status" | kib_to_mb >"$work/$side/peak-mb"
  stop_server
  for client in cli sdk boto3; do
    count="$(jq -s '[.[] | select(.passed)] | length' "$work/$side/$client.jsonl")"
    failed="$(jq -rs '[.[] | select(.passed | not) | "\(.check): \(.detail)"] | join("; ")' "$work/$side/$client.jsonl")"
    check "$side, the $client's twelve checks" "12" "$count${failed:+ ($failed)}"
    echo "$count" >"$work/$side/$client-passed"
  done
}

section "the Rust side: its tests, then the clients"
"$repo/hack/check-resources.sh"
rust_tests="$(cd "$here" && cargo test --locked 2>&1 | sed -n 's/^test result: ok\. \([0-9]*\) passed.*/\1/p' | head -1)"
check "the Rust side's tests pass" true "$([ -n "$rust_tests" ] && echo true || echo false)"
(cd "$here" && cargo build --locked --quiet --release)
binary="$CARGO_TARGET_DIR/release/local-front-door-spike"
rm -rf "$work/rust-data"
measure rust "$binary" --data "$work/rust-data" --account "$ACCOUNT" --key "$KEY:$SECRET" --bucket "$BUCKET" --queue "$QUEUE"

section "the backend's side: SeaweedFS, then its front doors in Node.js, then the clients"
mkdir -p "$work/store"
store_key=spike-store store_secret="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
printf '{"identities": [{"name": "spike", "credentials": [{"accessKey": "%s", "secretKey": "%s"}], "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}\n' \
  "$store_key" "$store_secret" >"$work/store/s3.json"
chmod 644 "$work/store/s3.json"
docker rm -f "$store" >/dev/null 2>&1 || true
started="$(millis)"
docker run -d --name "$store" -p 127.0.0.1::8333 -v "$work/store/s3.json:/etc/seaweedfs/s3.json:ro" "$STORE_IMAGE" \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
store_port="$(docker port "$store" 8333/tcp | head -1 | sed 's/.*://')"
# SeaweedFS answers S3 once its volume server has joined: an anonymous request is refused then, with a status.
for _ in $(seq 1 600); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$store_port/")" != 000 ] && break; sleep 0.1; done
echo $(($(millis) - started)) >"$work/store/start-ms"
FF_SPIKE_MODULES="$work/node-modules.txt" measure node node "$here/node/serve.mjs" --dist "$repo/BE/dist" --account "$ACCOUNT" \
  --key "$KEY:$SECRET" --store "http://127.0.0.1:$store_port" --store-key "$store_key:$store_secret" --bucket "$BUCKET" --queue "$QUEUE"
docker stats --no-stream --format '{{.MemUsage}}' "$store" | docker_mb >"$work/store/memory"
docker rm -f "$store" >/dev/null

section "the backend's L1 for the same code, which the Node.js side passes as its own"
specs=(common/signature-v4.spec.ts storage/s3-signature.spec.ts storage/aws-chunked.spec.ts storage/checksums.spec.ts
  storage/s3-requests.spec.ts storage/xml.spec.ts storage/front-door.spec.ts queues/sqs-signature.spec.ts
  queues/sqs-messages.spec.ts queues/sqs-attributes.spec.ts queues/sqs-operations.spec.ts queues/sqs-front-door.spec.ts)
"$repo/hack/check-resources.sh"
(cd "$repo/BE" && npx jest --maxWorkers=2 --silent --json --outputFile="$work/l1.json" "${specs[@]/#/src/}" >/dev/null 2>"$work/l1.log") || true
check "the backend's L1 for these modules passes" 0 "$(jq .numFailedTests "$work/l1.json")"
l1_total="$(jq .numPassedTests "$work/l1.json")"
l1_by_spec="$(jq -r '.testResults | sort_by(.name)[] | "\(.name | sub(".*/src/"; "")) \(.assertionResults | length)"' "$work/l1.json")"

section "what each side takes"
mapfile -t be_sources < <(sed -n 's|.*/BE/dist/\(.*\)\.js$|'"$repo"'/BE/src/\1.ts|p' "$work/node-modules.txt" | sort -u)
be_lines="$(lines "${be_sources[@]}")"
# The package each file is of: BE/node_modules/<name>/ or BE/node_modules/@<scope>/<name>/.
packages="$(sed -n 's#.*/BE/node_modules/\(@[^/]*/[^/]*\|[^@/][^/]*\)/.*#\1#p' "$work/node-modules.txt" | sort -u)"
heaviest="$(sed -n 's#.*/BE/node_modules/\(@[^/]*/[^/]*\|[^@/][^/]*\)/.*#\1#p' "$work/node-modules.txt" | sort | uniq -c | sort -rn | head -8 |
  awk '{ printf "%s%s (%s)", (NR > 1 ? ", " : ""), $2, $1 }')"
be_folders="$(sed -n 's#.*/BE/dist/\([^/]*\)/.*#\1#p' "$work/node-modules.txt" | sort | uniq -c | sort -rn | awk '{ printf "%s%s (%s)", (NR > 1 ? ", " : ""), $2, $1 }')"
package_count="$(wc -l <<<"$packages")"
package_files="$(grep -c '/node_modules/' "$work/node-modules.txt")"
packages_mb="$(cd "$repo/BE/node_modules" && du -sck $packages | tail -1 | cut -f1 | kib_to_mb)"
node_modules_mb="$(du -sk "$repo/BE/node_modules" | cut -f1 | kib_to_mb)"
typeorm_files="$(grep -c '/node_modules/typeorm/' "$work/node-modules.txt" || true)"
nest_files="$(grep -c '/node_modules/@nestjs/' "$work/node-modules.txt" || true)"
rust_code="$(rust_code_lines "$here"/src/*.rs)"
rust_all="$(rust_lines "$here"/src/*.rs)"
crates="$(cd "$here" && cargo tree --locked -e normal --prefix none | sed 's/ (\*)$//' | sort -u | grep -vc '^local-front-door-spike')"
binary_mb="$(du -k "$binary" | cut -f1 | awk '{ printf "%.1f", $1 / 1024 }')"
store_mb="$(docker image inspect "$STORE_IMAGE" --format '{{.Size}}' | awk '{ printf "%.0f", $1 / 1048576 }')"
suite_cases="$(jq '.cases | length' "$repo/BE/src/common/signature-v4-suite/cases.json")"
check_values="$(jq '.checkValues | length' "$repo/BE/src/storage/checksum-check-values.json")"
check_examples="$(jq '.examples | length' "$repo/BE/src/storage/checksum-check-values.json")"
passes() { cat "$work/$1/cli-passed" "$work/$1/sdk-passed" "$work/$1/boto3-passed" | paste -sd/; }

{ echo "# The local front door's shape ($(date -u +%F))"; echo
  echo "Rust $(rustc --version | cut -d' ' -f2), a release build; Node.js $(node --version) with BE/dist as built on $(date -r "$repo/BE/dist/storage/front-door.js" +%F); SeaweedFS ${STORE_IMAGE#*:}; $(aws --version 2>&1 | cut -d' ' -f1), the SDK for JavaScript $(jq -r .version "$s3_clients/node_modules/@aws-sdk/client-s3/package.json"), boto3 $("$s3_clients/venv/bin/python" -Ic 'import boto3; print(boto3.__version__)')."
  echo; echo "| | Rust, as \`ff local\` would serve them | the backend's front doors in Node.js |"; echo "|---|---|---|"
  echo "| the lines it takes | $rust_code of code, $((rust_all - rust_code)) of tests; $crates crates | $be_lines of the backend's, in ${#be_sources[@]} files; $(lines "$here/node/serve.mjs") of stand-ins; $package_count packages, $package_files of their files ($typeorm_files TypeORM's, $nest_files NestJS's) |"
  echo "| start to its ports open, median of five (the first) | $(cat "$work/rust/start-ms") ms ($(cat "$work/rust/first-start-ms") ms) | $(cat "$work/node/start-ms") ms ($(cat "$work/node/first-start-ms") ms), after SeaweedFS's $(cat "$work/store/start-ms") ms |"
  echo "| its memory at its peak, after the clients | $(cat "$work/rust/peak-mb") MB | $(cat "$work/node/peak-mb") MB, and SeaweedFS's $(cat "$work/store/memory") MB |"
  echo "| the backend's fixtures it passes | the Signature V4 suite's $suite_cases cases, signed in a header and presigned; the $check_values checksums' check values and $check_examples example; AWS's two aws-chunked examples, its tests $rust_tests in all | the backend's L1 for the same code, $l1_total tests, its own |"
  echo "| the clients' checks passed, of 12 each (CLI/SDK/boto3) | $(passes rust) | $(passes node) |"
  echo "| what a developer must have | the one binary, $binary_mb MB | Node.js, BE's node_modules ($node_modules_mb MB; $packages_mb MB of the packages loaded), Docker, and SeaweedFS's image, $store_mb MB |"
  echo; echo "PutObject's answer to the AWS CLI, which sends a CRC64NVME: from Rust, $(jq -c keys "$work/rust/put-answer.json"); from the backend's, $(jq -c keys "$work/node/put-answer.json")."
  echo; echo "The backend's files loaded, by folder: $be_folders."
  echo; echo "The packages loaded, the most files first: $heaviest; $package_count in all."
  echo; echo "The backend's L1 for the same code, by spec:"; echo; sed 's/^\(.*\) \([0-9]*\)$/- `\1`: \2/' <<<"$l1_by_spec"
} >"$results"
cat "$results"
checks_done spike-local-front-door
