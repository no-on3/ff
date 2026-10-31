#!/usr/bin/env bash
# Step 5's spike of what AWS's tools call: lambda-endpoint.mjs on a free port, fresh
# for each client, recording every request; then the AWS CLI v2, AWS's SDK for JavaScript v3 and boto3, each through a
# function's whole life with only the endpoint, the region and a key, as a customer's code would have them; and
# Terraform's AWS provider with OpenTofu and with Terraform's CLI, terraform/main.tf applied, planned again with
# nothing to change, and destroyed; and the SAM CLI's validate --lint and build of sam/template.yaml, every AWS
# endpoint pointed at the spike's, to see whether they ask AWS anything. Each client's steps (one JSON line each, its errors as it shows them) and its
# requests land in hack/.spike-lambda/, and analyze.py says, for each: the operations it called and how often, how it
# signed their paths, its waiters' polls, what it made of a refusal, and the largest bodies.
#   hack/spikes/lambda/run.sh [cli] [sdk] [boto3] [tofu] [terraform] [sam]    # all without an argument
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Its work, and where what each tool sent is kept: elsewhere for a run of other versions (hack/ci.sh tools).
work="${SPIKE_WORK:-$FF_REPO_ROOT/hack/.spike-lambda}"
recordings="${SPIKE_RECORDINGS:-$here/recordings}"
"$FF_REPO_ROOT/hack/check-resources.sh"
mkdir -p "$work"

# The clients, pinned: the CLI and the SDKs at the versions hack/e2e.sh uses for S3 and SQS; others through the
# environment, as the nightly's tools job gives the latest, OpenTofu's, Terraform's, the provider's and the SAM CLI's
# through hack/install-tools.sh's own variables, and where it installs them (FF_TOOLS_BIN, FF_SAM_DIR).
tools_bin="${FF_TOOLS_BIN:-$FF_REPO_ROOT/hack/bin}"
AWS_CLI_VERSION="${AWS_CLI_VERSION:-2.34.32}"
SDK_VERSION="${SDK_VERSION:-3.1156.0}"
BOTO3_VERSION="${BOTO3_VERSION:-1.43.118}"
AWS_CLI_IMAGE="amazon/aws-cli:$AWS_CLI_VERSION"
[ "$(jq -r .version "$work/js/node_modules/@aws-sdk/client-lambda/package.json" 2>/dev/null)" = "$SDK_VERSION" ] ||
  npm install --prefix "$work/js" --no-audit --no-fund --silent "@aws-sdk/client-lambda@$SDK_VERSION" >/dev/null
[ -x "$work/venv/bin/python" ] || python3 -m venv "$work/venv"
[ "$("$work/venv/bin/python" -c 'import boto3; print(boto3.__version__)' 2>/dev/null)" = "$BOTO3_VERSION" ] ||
  "$work/venv/bin/pip" install --quiet --disable-pip-version-check "boto3==$BOTO3_VERSION"

# Two functions' code: a handler, and the same with 6 MB that doesn't compress, for the largest body.
python3 - "$work" <<'PY'
import os, sys, zipfile
work = sys.argv[1]
handler = 'export const handler = async (event) => ({ echo: event });\n'
with zipfile.ZipFile(f'{work}/code.zip', 'w') as z:
    z.writestr('index.mjs', handler)
with zipfile.ZipFile(f'{work}/big.zip', 'w') as z:
    z.writestr('index.mjs', handler)
    z.writestr('data.bin', os.urandom(6 * 1024 * 1024))
PY

# A key of the spike's own, made up, its secret too: the recordings keep each request as signed, for a test to check
# its signature again with them.
key=AKFFSPIKELAMBDA23456
secret=the-spike-s-own-secret-not-a-real-one
export AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_REGION=tn-tunis-1 AWS_DEFAULT_REGION=tn-tunis-1
endpoint_pid=''
trap '[ -z "$endpoint_pid" ] || kill "$endpoint_pid" 2>/dev/null || true' EXIT

endpoint_start() { # <tool>: a fresh endpoint, its requests in $work/<tool>.requests.jsonl
  local port
  port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  endpoint="http://127.0.0.1:$port"
  : >"$work/$1.requests.jsonl"
  PORT="$port" KEY="$key" SECRET="$secret" REQUESTS="$work/$1.requests.jsonl" node "$here/lambda-endpoint.mjs" 2>"$work/$1.endpoint.log" &
  endpoint_pid=$!
  for _ in $(seq 50); do curl -s -o /dev/null "$endpoint/" && break; sleep 0.1; done
  : >"$work/$1.requests.jsonl" # the probe above isn't the client's
}
endpoint_stop() { kill "$endpoint_pid" 2>/dev/null || true; wait "$endpoint_pid" 2>/dev/null || true; endpoint_pid=''; }

# The AWS CLI, in its image, on this machine's network; one JSON line a step, its error as it prints it.
aws_cli() {
  docker run --rm --network host -v "$work:/work" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION -e AWS_DEFAULT_REGION \
    -e AWS_ENDPOINT_URL_LAMBDA="$endpoint" -e AWS_PAGER= "$AWS_CLI_IMAGE" lambda "$@"
}
cli_step() { # <label> <lambda command and arguments...>
  local label="$1" started out status=0
  shift
  started="$(date +%s%3N)"
  out="$(aws_cli "$@" 2>&1)" || status=$?
  jq -cn --arg step "$label" --argjson ok "$([ "$status" -eq 0 ] && echo true || echo false)" --argjson ms "$(($(date +%s%3N) - started))" --arg out "$out" \
    'if $ok then {step: $step, ok: true, ms: $ms, result: ($out | .[0:200])} else {step: $step, ok: false, ms: $ms, shown: ($out | .[0:400])} end'
}
# A step whose refusal depends on the CLI's own pace: each command starts a container, which takes about as long as the
# endpoint's 3 s of Pending or 2 s of InProgress, so that the refusal comes on one run and not on the next.
cli_paced_step() { cli_step "$@" | jq -c '. + {paced: true}'; }
cli_flow() {
  local name=spike-cli arn mapping
  arn="arn:aws:lambda:$AWS_REGION:123456789012:function:$name"
  cli_step create-function create-function --function-name "$name" --runtime nodejs22.x --role arn:aws:iam::123456789012:role/spike \
    --handler index.handler --zip-file fileb:///work/code.zip --query State --output text
  cli_paced_step "invoke while pending" invoke --function-name "$name" --cli-binary-format raw-in-base64-out --payload '{"early":true}' /work/cli-out.json
  cli_step "wait function-active-v2" wait function-active-v2 --function-name "$name"
  cli_step "invoke, with the log tail" invoke --function-name "$name" --cli-binary-format raw-in-base64-out --payload '{"hello":"spike"}' --log-type Tail \
    --query StatusCode /work/cli-out.json
  cli_step "invoke, asynchronously" invoke --function-name "$name" --invocation-type Event --cli-binary-format raw-in-base64-out --payload '{}' /work/cli-out.json
  cli_step "update-function-code, 6 MB" update-function-code --function-name "$name" --zip-file fileb:///work/big.zip --query LastUpdateStatus --output text
  cli_paced_step "update-function-configuration during the update" update-function-configuration --function-name "$name" --timeout 10 --query LastUpdateStatus --output text
  cli_step "wait function-updated-v2" wait function-updated-v2 --function-name "$name"
  cli_step update-function-configuration update-function-configuration --function-name "$name" --timeout 10 --environment 'Variables={STAGE=spike}' \
    --query LastUpdateStatus --output text
  cli_step "wait function-updated-v2, again" wait function-updated-v2 --function-name "$name"
  cli_step publish-version publish-version --function-name "$name" --query Version --output text
  cli_step create-alias create-alias --function-name "$name" --name live --function-version 1 --query AliasArn --output text
  cli_step "invoke the alias" invoke --function-name "$name" --qualifier live --cli-binary-format raw-in-base64-out --payload '{}' --query ExecutedVersion /work/cli-out.json
  cli_step "invoke by the alias ARN" invoke --function-name "$arn:live" --cli-binary-format raw-in-base64-out --payload '{}' --query ExecutedVersion /work/cli-out.json
  cli_step create-function-url-config create-function-url-config --function-name "$name" --auth-type NONE --query FunctionUrl --output text
  cli_step add-permission add-permission --function-name "$name" --statement-id url --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
  mapping="$(aws_cli create-event-source-mapping --function-name "$name" --event-source-arn "arn:aws:sqs:$AWS_REGION:123456789012:spike" --batch-size 5 \
    --query UUID --output text 2>&1)" || true
  jq -cn --arg uuid "$mapping" '{step: "create-event-source-mapping", ok: ($uuid | test("^[0-9a-f-]{36}$")), result: $uuid}'
  cli_step put-function-event-invoke-config put-function-event-invoke-config --function-name "$name" --maximum-retry-attempts 1
  cli_step put-function-concurrency put-function-concurrency --function-name "$name" --reserved-concurrent-executions 5
  cli_step tag-resource tag-resource --resource "$arn" --tags team=spike,stage=x
  cli_step untag-resource untag-resource --resource "$arn" --tag-keys stage
  cli_step list-tags list-tags --resource "$arn"
  cli_step "reads: get-function" get-function --function-name "$name" --query Configuration.State --output text
  cli_step "reads: get-function-configuration of 1" get-function-configuration --function-name "$name" --qualifier 1 --query Version --output text
  cli_step "reads: list-functions" list-functions --query 'length(Functions)'
  cli_step "reads: list-versions-by-function" list-versions-by-function --function-name "$name" --query 'length(Versions)'
  cli_step "reads: list-aliases" list-aliases --function-name "$name" --query 'length(Aliases)'
  cli_step "reads: get-alias" get-alias --function-name "$name" --name live --query FunctionVersion --output text
  cli_step "reads: get-policy" get-policy --function-name "$name" --query Policy --output text
  cli_step "reads: get-function-url-config" get-function-url-config --function-name "$name" --query AuthType --output text
  cli_step "reads: list-function-url-configs" list-function-url-configs --function-name "$name" --query 'length(FunctionUrlConfigs)'
  cli_step "reads: list-event-source-mappings" list-event-source-mappings --function-name "$name" --query 'length(EventSourceMappings)'
  cli_step "reads: get-event-source-mapping" get-event-source-mapping --uuid "$mapping" --query State --output text
  cli_step "reads: get-function-event-invoke-config" get-function-event-invoke-config --function-name "$name" --query MaximumRetryAttempts
  cli_step "reads: list-function-event-invoke-configs" list-function-event-invoke-configs --function-name "$name" --query 'length(FunctionEventInvokeConfigs)'
  cli_step "reads: get-function-concurrency" get-function-concurrency --function-name "$name"
  cli_step "reads: get-function-code-signing-config" get-function-code-signing-config --function-name "$name"
  cli_step "reads: get-account-settings" get-account-settings --query AccountUsage.FunctionCount
  cli_step "update-alias, weighted" update-alias --function-name "$name" --name live --function-version 1 --routing-config 'AdditionalVersionWeights={}' \
    --query FunctionVersion --output text
  cli_paced_step "update-event-source-mapping while creating" update-event-source-mapping --uuid "$mapping" --batch-size 7 --query State --output text
  cli_step update-function-url-config update-function-url-config --function-name "$name" --auth-type AWS_IAM --query AuthType --output text
  cli_step update-function-event-invoke-config update-function-event-invoke-config --function-name "$name" --maximum-event-age-in-seconds 600
  cli_step "a later operation: list-layers" list-layers
  cli_step "a missing function: get-function" get-function --function-name no-such-function
  cli_step "deletes: delete-function-concurrency" delete-function-concurrency --function-name "$name"
  cli_step "deletes: delete-function-event-invoke-config" delete-function-event-invoke-config --function-name "$name"
  cli_step "deletes: delete-event-source-mapping" delete-event-source-mapping --uuid "$mapping" --query State --output text
  cli_step "deletes: remove-permission" remove-permission --function-name "$name" --statement-id url
  cli_step "deletes: delete-function-url-config" delete-function-url-config --function-name "$name"
  cli_step "deletes: delete-alias" delete-alias --function-name "$name" --name live
  cli_step "deletes: delete-function" delete-function --function-name "$name"
}

# Terraform's AWS provider, with OpenTofu or Terraform's CLI, from the mirror hack/install-tools.sh fills: main.tf in a
# directory of its own, its log at DEBUG beside it, for the provider's retries.
tf_step() { # <label> <command...>
  local label="$1" started out status=0
  shift
  started="$(date +%s%3N)"
  out="$("$@" 2>&1)" || status=$?
  jq -cn --arg step "$label" --argjson status "$status" --argjson ms "$(($(date +%s%3N) - started))" --arg out "$out" \
    'if $status == 0 then {step: $step, ok: true, ms: $ms} else {step: $step, ok: false, ms: $ms, exit: $status, shown: ($out | .[-1500:])} end'
}
tf_flow() { # <tofu|terraform>
  local dir="$work/$1"
  rm -rf "$dir" && mkdir -p "$dir" && cp "$here/terraform/main.tf" "$dir/"
  # Another version of the provider than the one main.tf names: AWS_PROVIDER_VERSION, as hack/install-tools.sh takes it.
  if [ -n "${AWS_PROVIDER_VERSION:-}" ]; then sed -i "s/version = \"[0-9.]*\"/version = \"$AWS_PROVIDER_VERSION\"/" "$dir/main.tf"; fi
  local tf=("$tools_bin/$1" "-chdir=$dir") vars=(-var "endpoint=$endpoint" -var "name=spike-$1" -var "code=$work/code.zip")
  export TF_CLI_CONFIG_FILE="$FF_REPO_ROOT/hack/.terraform/cli.tfrc" TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1 TF_LOG=DEBUG TF_LOG_PATH="$dir/debug.log"
  tf_step "$1 init" "${tf[@]}" init -input=false -no-color
  tf_step "$1 apply" "${tf[@]}" apply -input=false -no-color -auto-approve "${vars[@]}"
  tf_step "$1 plan, nothing to change" "${tf[@]}" plan -input=false -no-color -detailed-exitcode "${vars[@]}"
  tf_step "$1 destroy" "${tf[@]}" destroy -input=false -no-color -auto-approve "${vars[@]}"
  unset TF_LOG TF_LOG_PATH
}

# The SAM CLI on sam/template.yaml, in a copy: its build's output, and any call it makes to AWS, which the endpoint records.
sam_flow() {
  local dir="$work/sam" sam=("$tools_bin/sam")
  rm -rf "$dir" && cp -r "$here/sam" "$dir"
  export SAM_CLI_TELEMETRY=0 AWS_ENDPOINT_URL="$endpoint"
  tf_step "sam validate --lint, FF's region" "${sam[@]}" validate --lint --template "$dir/template.yaml" --region "$AWS_REGION"
  # cfn-lint reads the region for the resources' specification it checks against: any of AWS's, for a template.
  tf_step "sam validate --lint, an AWS region" "${sam[@]}" validate --lint --template "$dir/template.yaml" --region eu-west-1
  tf_step "sam validate" "${sam[@]}" validate --template "$dir/template.yaml" --region "$AWS_REGION"
  tf_step "sam build" bash -c "cd '$dir' && '${sam[0]}' build --template template.yaml"
  jq -cn --arg built "$(cd "$dir/.aws-sam/build" 2>/dev/null && find . -maxdepth 3 -not -path '*/node_modules/*' | sort | paste -sd' ')" \
    --arg template "$(sed -n '/^Resources:/,/^Outputs:/p' "$dir/.aws-sam/build/template.yaml" 2>/dev/null | grep -E 'Type:|CodeUri:|Handler:' | tr -s ' ' | paste -sd'|')" \
    '{step: "what sam build left", ok: ($built != ""), result: {files: $built, template: $template}}'
  unset AWS_ENDPOINT_URL
}

[ $# -gt 0 ] || set -- cli sdk boto3 tofu terraform sam
case " $* " in *" tofu "* | *" terraform "*) "$FF_REPO_ROOT/hack/install-tools.sh" tofu terraform aws-provider >/dev/null ;; esac
case " $* " in *" sam "*) "$FF_REPO_ROOT/hack/install-tools.sh" sam >/dev/null ;; esac
for tool in "$@"; do
  echo "== $tool"
  endpoint_start "$tool"
  case "$tool" in
    cli) cli_flow ;;
    sdk) MODULES="$work/js/node_modules" ENDPOINT="$endpoint" CODE="$work/code.zip" BIG="$work/big.zip" NAME=spike-sdk node "$here/sdk-flow.mjs" ;;
    boto3) ENDPOINT="$endpoint" CODE="$work/code.zip" BIG="$work/big.zip" NAME=spike-boto3 "$work/venv/bin/python" "$here/boto3_flow.py" ;;
    tofu | terraform) tf_flow "$tool" ;;
    sam) sam_flow ;;
    *) echo "unknown client $tool: cli, sdk, boto3, tofu, terraform or sam" >&2; exit 2 ;;
  esac >"$work/$tool.steps.jsonl"
  endpoint_stop
  # What the tool sent, kept in the repository for the endpoint's tests to replay, nothing for a tool that sent nothing;
  # and its steps, against which another version's are compared (compare.py).
  mkdir -p "$recordings" && cp "$work/$tool.steps.jsonl" "$recordings/"
  if [ -s "$work/$tool.requests.jsonl" ]; then cp "$work/$tool.requests.jsonl" "$recordings/"; fi
  jq -r '"  \(if .ok then "ok  " else "FAIL" end) \(.step)\(if .ok then "" else ": \(.shown | gsub("\n"; " ") | .[0:160])" end)"' "$work/$tool.steps.jsonl"
done
python3 "$here/analyze.py" "$work" "$@" | tee "$work/summary.md"
