#!/usr/bin/env bash
# Step 5's spike of what AWS's tools call, its last piece: Terraform's AWS provider, with OpenTofu, against FF's
# own S3 and SQS front doors, on a stack of the spike's own (hack/lib/e2e-stack.sh's: its PostgreSQL and S3, the dev
# cluster, the backend built), with an access key of the account's. Four flows, each in a directory of its own with
# terraform/front-doors/provider.tf: queue.tf (a queue and its dead-letter queue), bucket.tf (a bucket Terraform makes),
# site.tf (a bucket made through FF's API and imported, its website, a page and a notification), and tagged (the queue
# and the site again, with the provider's default tags, which many teams set). Each is applied, planned again, which
# must find nothing to change, and destroyed, whatever the step before it gave: what fails is what the spike is for.
# Each step's outcome, and each request the provider sent with FF's answer (provider_log.py, from the provider's log at
# DEBUG), land in hack/.spike-lambda-tf/, with summary.md.
#   hack/spikes/lambda/front-doors.sh        # a few minutes: the stack, the backend's build, the four flows
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_PROJECT=ff-spike-lambda
E2E_NAME=spike-lambda-tf
port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
FF_PG_PORT="$(port)"
FF_S3_PORT="$(port)"
export FF_PG_PORT FF_S3_PORT
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
"$FF_REPO_ROOT/hack/install-tools.sh" tofu aws-provider >/dev/null

e2e_dependencies
e2e_cluster
e2e_build
be_port="$(free_port)"
storage_port="$(free_port)"
sqs_port="$(free_port)"
api="http://127.0.0.1:$be_port"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$(random_account)"
  FF_STORAGE_PORT="$storage_port" FF_STORAGE_BASE="http://s3.localhost:$storage_port" FF_SQS_PORT="$sqs_port" FF_SQS_BASE="http://localhost:$sqs_port")
e2e_migrate "${be_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"

section "the account's key, its site's bucket and its events' queue, through FF's API"
key="$(http_at "$api" POST /storage-keys '{}')"
check "an access key" 201 "$(status)"
for bucket in spike-tf-site spike-tg-site; do
  http_at "$api" POST /buckets "{\"name\": \"$bucket\"}" >/dev/null
  check "the site's bucket, $bucket" 201 "$(status)"
done
events_arn="$(http_at "$api" POST /queues '{"name": "spike-tf-events"}' | jq -r .arn)"
check "the events' queue" 201 "$(status)"

section "OpenTofu against FF's S3 and SQS front doors"
AWS_ACCESS_KEY_ID="$(jq -r .id <<<"$key")"
AWS_SECRET_ACCESS_KEY="$(jq -r .secretAccessKey <<<"$key")"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export TF_CLI_CONFIG_FILE="$FF_REPO_ROOT/hack/.terraform/cli.tfrc" TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1 TF_LOG=DEBUG
vars=(-var "s3_endpoint=http://127.0.0.1:$storage_port" -var "sqs_endpoint=http://127.0.0.1:$sqs_port" -var "events_queue_arn=$events_arn")
# step <flow> <step> <tofu arguments...>: a JSON line, the step's exit status, its time and, when it fails, the errors
# it showed; its requests in <flow>/<step>.requests.tsv.
step() {
  local flow=$1 name=$2 dir="$work/$1" started status=0
  shift 2
  started="$(date +%s%3N)"
  TF_LOG_PATH="$dir/$name.log" "$FF_REPO_ROOT/hack/bin/tofu" "-chdir=$dir" "$@" -input=false -no-color >"$dir/$name.out" 2>&1 || status=$?
  python3 "$here/provider_log.py" "$dir/$name.log" >"$dir/$name.requests.tsv"
  jq -cn --arg flow "$flow" --arg step "$name" --argjson status "$status" --argjson ms "$(($(date +%s%3N) - started))" \
    --arg errors "$(grep -A3 '^Error: ' "$dir/$name.out" | grep -vE '^(--|\s*)$' | head -40 || true)" \
    '{flow: $flow, step: $step, status: $status, ms: $ms, errors: $errors}'
}
flows=(queue bucket site tagged)
for flow in "${flows[@]}"; do
  case "$flow" in
    tagged) files=(queue.tf site.tf) flow_vars=(-var name=spike-tg -var 'default_tags={team = "spike"}') ;;
    *) files=("$flow.tf") flow_vars=(-var name=spike-tf) ;;
  esac
  dir="$work/$flow"
  rm -rf "$dir" && mkdir -p "$dir" && cp "$here/terraform/front-doors/provider.tf" "${files[@]/#/$here/terraform/front-doors/}" "$dir/"
  step "$flow" init init
  step "$flow" apply apply -auto-approve "${vars[@]}" "${flow_vars[@]}"
  # 0 when nothing is left to change, 2 when something is.
  step "$flow" plan plan -detailed-exitcode "${vars[@]}" "${flow_vars[@]}"
  step "$flow" destroy destroy -auto-approve "${vars[@]}" "${flow_vars[@]}"
done >"$work/steps.jsonl"

{
  echo "# Terraform's AWS provider against FF's S3 and SQS front doors"
  for flow in "${flows[@]}"; do
    echo
    echo "## $flow"
    jq -r --arg flow "$flow" 'select(.flow == $flow) | "- \(.step): exit \(.status), \(.ms / 1000) s\(if .errors != "" then "\n\n```\n\(.errors)\n```\n" else "" end)"' "$work/steps.jsonl"
    for name in apply plan destroy; do
      echo
      echo "$name's requests (answered at, RPC, resource, operation, attempt, status, error):"
      echo
      echo '```'
      cat "$work/$flow/$name.requests.tsv"
      echo '```'
    done
  done
} >"$work/summary.md"
jq -r '"  \(.flow) \(.step): exit \(.status) (\(.ms / 1000) s)"' "$work/steps.jsonl"
echo "  the summary: $work/summary.md"
checks_done spike-front-doors
