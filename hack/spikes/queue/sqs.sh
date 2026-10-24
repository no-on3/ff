#!/usr/bin/env bash
# The SQS half of step 3's spike (the step-3 plan's Q-01): sqs-endpoint.mjs on a free port, then AWS's SDK for
# JavaScript v3, boto3 and the AWS CLI against it with only the endpoint, the region and a key, as a customer's code
# would have them. Prints each check's JSON line, the endpoint's count of what it was asked, and a summary.
#   hack/spikes/queue/sqs.sh          # about a minute; npm and pip fetch the SDKs the first time
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-queue"
"$FF_REPO_ROOT/hack/check-resources.sh"
mkdir -p "$work"

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
endpoint="http://127.0.0.1:$port"
key=AKFFSPIKEQUEUE234567
secret="$(head -c 30 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
PORT="$port" KEY="$key" SECRET="$secret" node "$here/sqs-endpoint.mjs" 2>"$work/endpoint.log" &
endpoint_pid=$!
trap 'kill "$endpoint_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -s -o /dev/null -X POST "$endpoint/" && break; sleep 0.1; done

# The clients, pinned: the SDK for JavaScript at the version hack/e2e.sh uses for S3, boto3 at hack/e2e.sh's.
[ -d "$work/js/node_modules/@aws-sdk/client-sqs" ] ||
  npm install --prefix "$work/js" --no-audit --no-fund --silent @aws-sdk/client-sqs@3.1156.0 >/dev/null
[ -x "$work/venv/bin/python" ] || python3 -m venv "$work/venv"
"$work/venv/bin/python" -c 'import boto3' 2>/dev/null || "$work/venv/bin/pip" install --quiet --disable-pip-version-check boto3==1.43.118

results="$work/sqs.jsonl"
: >"$results"
MODULES="$work/js" ENDPOINT="$endpoint" KEY="$key" SECRET="$secret" node "$here/sqs-sdk-check.mjs" | tee -a "$results"
ENDPOINT="$endpoint" KEY="$key" SECRET="$secret" "$work/venv/bin/python" "$here/sqs_boto3_check.py" | tee -a "$results"

# The AWS CLI, its endpoint from AWS_ENDPOINT_URL_SQS alone, as it would read FF's from a function's environment.
cli() { env AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_REGION=tn-tunis-1 AWS_ENDPOINT_URL_SQS="$endpoint" \
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null aws sqs "$@"; }
cli_check() { # <want> <what> <command…>: ok when the command succeeds, refused otherwise, its output the detail
  local want=$1 what=$2 got=ok detail
  shift 2
  detail="$("$@" 2>&1)" || got=refused
  jq -cn --arg want "$want" --arg got "$got" --arg what "$what" --arg detail "${detail:0:200}" '{client: "aws-cli", want: $want, got: $got, what: $what, detail: $detail}' | tee -a "$results"
}
url="$(cli create-queue --queue-name cli-orders --query QueueUrl --output text)"
cli_check ok "create-queue answers its URL, under the endpoint and the account" test "$url" = "$endpoint/000000000001/cli-orders"
cli_check ok "send-message with an attribute" cli send-message --queue-url "$url" --message-body 'hello from the CLI' \
  --message-attributes '{"kind": {"DataType": "String", "StringValue": "order"}}'
handle="$(cli receive-message --queue-url "$url" --wait-time-seconds 1 --message-attribute-names All --query 'Messages[0].ReceiptHandle' --output text)"
cli_check ok "receive-message gives it back, then delete-message" cli delete-message --queue-url "$url" --receipt-handle "$handle"
cli_check refused "get-queue-url of a queue that is not there" cli get-queue-url --queue-name nowhere
cli_check ok "delete-queue" cli delete-queue --queue-url "$url"

kill "$endpoint_pid" && wait "$endpoint_pid" 2>/dev/null || true
echo "endpoint: $(tail -1 "$work/endpoint.log")"
jq -rs 'group_by(.client)[] | "\(.[0].client): \(map(select(.want == .got)) | length) of \(length) as wanted\(map(select(.want != .got) | "\n  not as wanted: \(.what) (\(.got): \(.detail))") | join(""))"' "$results"
