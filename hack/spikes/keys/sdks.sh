#!/usr/bin/env bash
# Step 5's spike of keys that expire, its first part: what AWS's SDKs show past a function's key's end, the plan's
# D5 having keys of 12 hours. expired.mjs answers every request as each service answers a key that has expired; AWS's
# SDK for JavaScript (sdks.mjs) and boto3 (sdks.py) call S3, SQS, SES and Lambda there, with the key in the
# environment as a function's pod has it, and again with AWS_CREDENTIAL_EXPIRATION set an hour ago, as a key's end
# could be given to them. What each showed lands in hack/.spike-keys/sdks.md; the key is made up.
#   hack/spikes/keys/sdks.sh      # under a minute, once the SDKs are installed
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../../lib/checks.sh"
work="$here/../../.spike-keys"
mkdir -p "$work"
SDK_VERSION="${SDK_VERSION:-3.1156.0}"
BOTO3_VERSION="${BOTO3_VERSION:-1.43.118}"

section "the SDKs: the SDK for JavaScript $SDK_VERSION, boto3 $BOTO3_VERSION"
clients=()
for client in client-s3 client-sqs client-sesv2 client-lambda; do
  [ "$(jq -r .version "$work/js/node_modules/@aws-sdk/$client/package.json" 2>/dev/null)" = "$SDK_VERSION" ] ||
    clients+=("@aws-sdk/$client@$SDK_VERSION")
done
if [ "${#clients[@]}" -gt 0 ]; then
  "$here/../../check-resources.sh"
  npm install --prefix "$work/js" --no-audit --no-fund --silent "${clients[@]}" >/dev/null
fi
if [ "$("$work/venv/bin/python" -c 'import boto3; print(boto3.__version__)' 2>/dev/null)" != "$BOTO3_VERSION" ]; then
  "$here/../../check-resources.sh"
  [ -x "$work/venv/bin/python" ] || python3 -m venv "$work/venv"
  "$work/venv/bin/pip" install --quiet --disable-pip-version-check "boto3==$BOTO3_VERSION"
fi

node "$here/expired.mjs" >"$work/expired.port" &
endpoint_pid=$!
on_exit "kill $endpoint_pid 2>/dev/null"
for _ in $(seq 1 50); do [ -s "$work/expired.port" ] && break; sleep 0.1; done
endpoint="http://127.0.0.1:$(cat "$work/expired.port")"

sdks() { # [<variable>=<value>…]: both SDKs' lines
  env AWS_ACCESS_KEY_ID=AKFFSPIKEKEYS2345678 AWS_SECRET_ACCESS_KEY=the-spike-s-own-secret-not-a-real-one \
    AWS_REGION=tn-tunis-1 AWS_DEFAULT_REGION=tn-tunis-1 ENDPOINT="$endpoint" "$@" sh -c '
      MODULES="$0/js/node_modules" node "$1/sdks.mjs"
      "$0/venv/bin/python" "$1/sdks.py"' "$work" "$here"
}
table() { # <title> <lines>
  echo; echo "## $1"; echo
  echo "| SDK | service | threw | status | attempts or retries | requests | ms | message |"; echo "|---|---|---|---|---|---|---|---|"
  jq -r '"| \(.sdk) | \(.service) | \(.threw) | \(.status // "") | \(if .sdk == "js" then "\(.attempts // "") attempts" else "\(.retries // "") retries" end) | \(.requests) | \(.ms) | \(.message // "" | gsub("\\|"; "/")) |"' <<<"$2"
}

section "past the key's end, the key alone in the environment"
plain="$(sdks)"
check "every call refused, by every SDK" 0 "$(jq -s '[.[] | select(.threw == "nothing")] | length' <<<"$plain")"
section "past the key's end, with AWS_CREDENTIAL_EXPIRATION an hour ago"
expiration="$(sdks AWS_CREDENTIAL_EXPIRATION="$(date -u -d '1 hour ago' +%FT%TZ)")"
check "every call refused, by every SDK" 0 "$(jq -s '[.[] | select(.threw == "nothing")] | length' <<<"$expiration")"

{ echo "# What AWS's SDKs show past a key's end ($(date -u +%F))"
  echo; echo "The SDK for JavaScript $SDK_VERSION, boto3 $BOTO3_VERSION, each service answering as AWS answers a key that has expired."
  table "The key alone in the environment" "$plain"
  table "With AWS_CREDENTIAL_EXPIRATION an hour ago" "$expiration"; } >"$work/sdks.md"
echo "the results: $work/sdks.md"
checks_done spike-keys-sdks
