#!/usr/bin/env bash
# The SES half of step 4's mail spike (the step-4 plan's W-01): ses-endpoint.mjs on a free port, then AWS's SDK for
# JavaScript v3, boto3 and the AWS CLI against it, each with its endpoint from AWS_ENDPOINT_URL_SESV2 alone, a region
# and a key, as a function's code would have them. Prints each check's JSON line, what the endpoint was asked and how
# each request's path was signed, and a summary.
#   hack/spikes/mail/ses.sh          # about a minute; npm and pip fetch the SDKs the first time
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-mail"
"$FF_REPO_ROOT/hack/check-resources.sh"
mkdir -p "$work"

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
endpoint="http://127.0.0.1:$port"
key=AKFFSPIKEMAIL2345678
secret="$(head -c 30 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
PORT="$port" KEY="$key" SECRET="$secret" node "$here/ses-endpoint.mjs" 2>"$work/endpoint.log" &
endpoint_pid=$!
trap 'kill "$endpoint_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "$endpoint/" && break; sleep 0.1; done

# The clients, pinned at releases at least two weeks old: the SDK for JavaScript 3.1152.0 (2026-10-14), boto3 as
# step 3's spike had it.
[ -d "$work/js/node_modules/@aws-sdk/client-sesv2" ] ||
  npm install --prefix "$work/js" --no-audit --no-fund --silent @aws-sdk/client-sesv2@3.1152.0 >/dev/null
[ -x "$work/venv/bin/python" ] || python3 -m venv "$work/venv"
"$work/venv/bin/python" -c 'import boto3' 2>/dev/null || "$work/venv/bin/pip" install --quiet --disable-pip-version-check boto3==1.43.118

results="$work/ses.jsonl"
: >"$results"
clean_env=(env -u AWS_PROFILE -u AWS_ENDPOINT_URL AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_ENDPOINT_URL_SESV2="$endpoint")
"${clean_env[@]}" MODULES="$work/js" KEY="$key" SECRET="$secret" node "$here/ses-sdk-check.mjs" | tee -a "$results"
"${clean_env[@]}" KEY="$key" SECRET="$secret" "$work/venv/bin/python" "$here/ses_boto3_check.py" | tee -a "$results"

cli() { "${clean_env[@]}" AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_REGION=tn-tunis-1 aws sesv2 "$@"; }
cli_check() { # <want> <what> <command…>: ok when the command succeeds, refused otherwise, its output the detail
  local want=$1 what=$2 got=ok detail
  shift 2
  detail="$("$@" 2>&1)" || got=refused
  jq -cn --arg want "$want" --arg got "$got" --arg what "$what" --arg detail "${detail:0:200}" '{client: "aws-cli", want: $want, got: $got, what: $what, detail: $detail}' | tee -a "$results"
}
cli_check ok "create-email-identity of a verified domain" cli create-email-identity --email-identity verified-cli.example
cli create-email-identity --email-identity sami@client.example >/dev/null
cli_check ok "get-email-identity of an address, its @ escaped in the path" cli get-email-identity --email-identity sami@client.example
cli_check ok "send-email, simple" cli send-email --from-email-address orders@verified-cli.example --destination ToAddresses=sami@client.example \
  --content '{"Simple": {"Subject": {"Data": "Receipt"}, "Body": {"Text": {"Data": "Thanks"}}}}'
cli_check ok "get-account" cli get-account
cli_check refused "get-email-identity of one not there" cli get-email-identity --email-identity nowhere.example

kill "$endpoint_pid" && wait "$endpoint_pid" 2>/dev/null || true
echo "endpoint: $(tail -1 "$work/endpoint.log")"
jq -rs 'group_by(.client)[] | "\(.[0].client): \(map(select(.want == .got)) | length) of \(length) as wanted\(map(select(.want != .got) | "\n  not as wanted: \(.what) (\(.got): \(.detail))") | join(""))"' "$results"
