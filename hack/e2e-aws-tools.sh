#!/usr/bin/env bash
# L4 for AWS's tools, in a job of its own: the Terraform project `ff init --template terraform` writes, applied on FF by
# OpenTofu and then by Terraform's CLI, each pinned (hack/install-tools.sh), as either applies it on AWS:
#   PostgreSQL + S3 (compose project "ff-aws-tools", ports 25437 / 29008) + the k3d dev cluster + the backend (built,
#   started on a free port in development mode, with Lambda's, S3's, SQS's and SES's endpoints, function URLs and
#   sites, each on a port of its own) + ff (built), whose profile acts as the account.
# For each tool: ff init writes the project from GET /me, FF's endpoints in its provider block and the account in its
# functions' role, its providers pinned by an override file to the installer's versions, from its mirror; fmt and
# validate take it; apply makes its four modules: a function with a URL on its alias live and its asynchronous calls'
# settings, a queue with its dead-letter queue and a function reading it, a bucket whose new files run a function, and
# a site. Each then works: the URL answers, the site serves its page and its 404, a message sent runs the worker, a file
# uploaded runs the uploads' function. A second plan finds nothing to change; with the uploads' bucket emptied, destroy
# removes it all, and the account holds none of it. Then the move to AWS as the project's README says it: ff doctor
# names the provider block's lines for FF, and once they are removed, nothing, and validate takes the project. Then the
# plan's limit on changes: on a plan of 3 a minute, Lambda's endpoint answers TooManyRequestsException with Retry-After,
# which the provider retries until its apply goes through.
# Removes its compose project, its namespaces and the backend on exit; keeps the cluster. Its sections run alone too
# (hack/lib/sections.sh): --list names them, --only and --from choose; --keep and --reuse as hack/lib/e2e-stack.sh says.
#   hack/e2e-aws-tools.sh [--teardown | --keep] [--reuse] [--list | --only <section>[,<section>…] | --from <section>]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-aws-tools
E2E_NAME=aws-tools
export FF_PG_PORT="${FF_AWS_TOOLS_PG_PORT:-25437}"
export FF_S3_PORT="${FF_AWS_TOOLS_S3_PORT:-29008}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
source "$FF_REPO_ROOT/hack/lib/sections.sh"
sections_options "$@"
e2e_options "${sections_rest[@]}"

be_port="$(free_port)"
api="http://127.0.0.1:$be_port"
account="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account")")
tools_bin="${FF_TOOLS_BIN:-$FF_REPO_ROOT/hack/bin}"
# The versions hack/install-tools.sh pins, or those its variables give, as the nightly's newest tools do.
pinned() { sed -n "s/^$1=\"\\\${$1:-\(.*\)}\"\$/\1/p" "$FF_REPO_ROOT/hack/install-tools.sh"; }
aws_provider="${AWS_PROVIDER_VERSION:-$(pinned AWS_PROVIDER_VERSION)}"
archive_provider="${ARCHIVE_PROVIDER_VERSION:-$(pinned ARCHIVE_PROVIDER_VERSION)}"
export TF_CLI_CONFIG_FILE="$FF_REPO_ROOT/hack/.terraform/cli.tfrc" TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1

# What more than one section uses: ff, its output kept, FF's database, the tools' runs.

# ff <args...>: its stdout in $work/out, its stderr in $work/err, its exit code in $work/code.
ff() {
  local code=0
  "$ff_bin" "$@" >"$work/out" 2>"$work/err" || code=$?
  echo "$code" >"$work/code"
}
out() { cat "$work/out"; }
code() { cat "$work/code"; }

# sql <statement>: run on FF's database, its answer dropped.
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }

# tool <tool> <app> <step> <arguments...>: the tool in the app's project, its output in $work/<app>/<step>.out and its
# provider's log, at DEBUG, in <step>.log; prints its exit status, and the errors it showed.
tool() {
  local name=$1 app=$2 step=$3 status=0 errors
  shift 3
  TF_LOG=DEBUG TF_LOG_PATH="$work/$app/$step.log" "$tools_bin/$name" "-chdir=$work/$app" "$@" >"$work/$app/$step.out" 2>&1 || status=$?
  printf '%s' "$status"
  errors="$(grep -A3 '^Error: ' "$work/$app/$step.out" | grep -vE '^(--|\s*)$' | head -12 | paste -sd' ' || true)"
  [ -z "$errors" ] || printf ' %s' "$errors"
}

# project <app> <runtime>: ff init's Terraform project in $work/<app>, its providers pinned to the installer's versions
# by an override file, which Terraform and OpenTofu merge into providers.tf's; the key ff init says to make, made, in
# the variables the provider reads.
project() {
  local command
  rm -rf "${work:?}/$1"
  (cd "$work" && ff init "$1" --template terraform --runtime "$2" --output json)
  [ "$(code)" = 0 ] || return 0
  command="$(out | jq -r .keyCommand)"
  read -ra command <<<"${command#ff }"
  ff "${command[@]}"
  AWS_ACCESS_KEY_ID="$(out | sed -n 's/^export AWS_ACCESS_KEY_ID=//p')"
  AWS_SECRET_ACCESS_KEY="$(out | sed -n 's/^export AWS_SECRET_ACCESS_KEY=//p')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  cat >"$work/$1/versions_override.tf" <<EOF
terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "$aws_provider" }
    archive = { source = "hashicorp/archive", version = "$archive_provider" }
  }
}
EOF
}

# provider_setting <app> <name>: a setting of the project's provider block, as ff init wrote it.
provider_setting() { sed -n "s/^ *$2 *= \"\(.*\)\"\$/\1/p" "$work/$1/providers.tf" | head -1; }

# s3 <method> <bucket>/<key> [curl option...]: S3's request, signed with the tools' key; prints the status.
s3() {
  local method=$1 path=$2
  shift 2
  curl -sS -o "$work/s3-body" -w '%{http_code}' -X "$method" --aws-sigv4 "aws:amz:$region:s3" \
    --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" "$s3_endpoint/$path" "$@"
}

# calls <function> <source>: the function's calls from that source that completed, as ff history lists them.
calls() { "$ff_bin" history "$1" --output json | jq "[.invocations[] | select(.source == \"$2\" and .status == \"COMPLETED\")] | length"; }

# names_left <app>: the account's functions, buckets and queues whose names start with the app's, or none.
names_left() {
  {
    "$ff_bin" list --output json
    "$ff_bin" buckets list --output json
    "$ff_bin" queues list --output json
  } | jq -rs --arg app "$1-" '[.[][].name | select(startswith($app))] | if length == 0 then "none" else join(",") end'
}

section_stack() {
section "the stack: its database and object storage, the cluster"
e2e_dependencies
e2e_cluster
}
section_def stack section_stack budget=90

section_backend() {
section "ff, the backend and the tools"
# Release's optimizations without its link-time ones (cli/Cargo.toml's e2e profile), as the ff suite builds it.
(cd "$FF_REPO_ROOT/cli" && cargo build --profile e2e --locked -q)
ff_bin="$FF_REPO_ROOT/cli/target/e2e/ff"
"$FF_REPO_ROOT/hack/install-tools.sh" tofu terraform aws-provider archive-provider
e2e_build
# Function URLs on a port of their own, each at http://<id>.fn.localhost:<port>/, which curl takes to this machine.
url_port="$(free_port)"
# S3's front door at http://127.0.0.1:<port>, and the SQS, Lambda and mail endpoints at http://localhost:<port>: the
# provider's resolver, Go's, finds localhost in /etc/hosts, where s3.localhost needs one that knows *.localhost, as
# curl's does; S3's must have a dot, and the provider reaches it path-style, as providers.tf says.
storage_port="$(free_port)"
sqs_port="$(free_port)"
lambda_port="$(free_port)"
ses_port="$(free_port)"
# Buckets' sites, each at http://<bucket>.site.localhost:<port>.
website_port="$(free_port)"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account"
  FF_FUNCTION_URL_PORT="$url_port" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port"
  FF_STORAGE_PORT="$storage_port" FF_STORAGE_BASE="http://127.0.0.1:$storage_port"
  FF_SQS_PORT="$sqs_port" FF_SQS_BASE="http://localhost:$sqs_port"
  FF_LAMBDA_PORT="$lambda_port" FF_LAMBDA_BASE="http://localhost:$lambda_port"
  FF_SES_PORT="$ses_port" FF_SES_BASE="http://localhost:$ses_port"
  FF_WEBSITE_PORT="$website_port" FF_WEBSITE_BASE="http://site.localhost:$website_port")
e2e_migrate "${be_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"

# ff's settings in a folder of the test's, and none of the caller's: its profile acts as the account.
export FF_CONFIG_DIR="$work/ff"
unset FF_TOKEN FF_ENDPOINT FF_ACCOUNT FF_PROFILE
rm -rf "$FF_CONFIG_DIR"
ff config set endpoint "$api"
ff config set dev_account "$account"
check "ff's profile acts as the account" "0" "$(code)"
}
section_def backend section_backend stack budget=120

# applied <tool> <app> <runtime>: the project ff init writes, taken by the tool: written, applied, each of its four
# parts called, planned again with nothing to change, its bucket of uploads emptied, destroyed; then readied for AWS.
applied() {
  local name=$1 app=$2 runtime=$3 status
  project "$app" "$runtime"
  check "ff init writes the project from GET /me: FF's Lambda, S3, SQS and SES endpoints, the account in its functions' role" \
    "http://localhost:$lambda_port http://127.0.0.1:$storage_port http://localhost:$sqs_port http://localhost:$ses_port arn:aws:iam::$account:role/$app" \
    "$(provider_setting "$app" lambda) $(provider_setting "$app" s3) $(provider_setting "$app" sqs) $(provider_setting "$app" sesv2) $(provider_setting "$app" function_role)"
  check "  ... and the key it says to make, made: the project's functions, buckets and queues by name" "0 true" \
    "$(code) $([ -n "$AWS_ACCESS_KEY_ID" ] && echo true || echo false)"
  [ -n "$AWS_ACCESS_KEY_ID" ] || fail "no project, or no key for it"
  region="$(provider_setting "$app" region)"
  s3_endpoint="$(provider_setting "$app" s3)"
  status="$(tool "$name" "$app" init init -no-color)"
  check "  ... which $name init takes, its providers from the mirror at the versions pinned" "0 $aws_provider $archive_provider" \
    "$status $(for provider in aws archive; do grep -A1 "hashicorp/$provider\"" "$work/$app/.terraform.lock.hcl" | sed -n 's/^ *version *= "\(.*\)"$/\1/p'; done | paste -sd' ')"
  check "  ... $name fmt leaves as it is, and validate takes" "0 0" \
    "$(tool "$name" "$app" fmt fmt -check -recursive) $(tool "$name" "$app" validate validate -no-color)"

  status="$(tool "$name" "$app" apply apply -auto-approve -no-color)"
  check "$name apply makes the four modules: the API, the queue's worker, the bucket's function and the site" \
    "0 Apply complete! Resources: 22 added, 0 changed, 0 destroyed." "$status $(grep -o '^Apply complete!.*' "$work/$app/apply.out" || true)"
  [ "${status%% *}" = 0 ] || fail "$name's apply failed"
  "$tools_bin/$name" "-chdir=$work/$app" output -json >"$work/$app/outputs.json"

  local url host
  url="$(jq -r .api_url.value "$work/$app/outputs.json")"
  host="${url#http://}" && host="${host%%[:/]*}"
  check "  ... its API answers at its URL, on its alias live, the app's name in its environment" "200 {\"app\":\"$app\",\"method\":\"GET\",\"path\":\"/orders\"}" \
    "$(curl -sS -o "$work/$app/api.json" -w '%{http_code}' --max-time 60 --resolve "$host:$url_port:127.0.0.1" "${url%/}/orders") $(jq -c . "$work/$app/api.json")"
  local site="http://$app-site.site.localhost:$website_port"
  check "  ... its site serves its page, and its 404 for a page it hasn't" "200 <h1>$app</h1> 404 <h1>Not found</h1>" \
    "$(curl -sS -o "$work/$app/index.html" -w '%{http_code}' "$site/") $(grep -o '<h1>.*</h1>' "$work/$app/index.html") \
$(curl -sS -o "$work/$app/missing.html" -w '%{http_code}' "$site/missing") $(grep -o '<h1>.*</h1>' "$work/$app/missing.html")"

  ff queues send "$app-jobs" '{"job": 1}'
  for _ in $(seq 90); do [ "$(calls "$app-jobs" sqs)" -ge 1 ] && break; sleep 1; done
  check "  ... a message sent to its queue runs its worker" "0 1" "$(code) $(calls "$app-jobs" sqs)"
  printf 'hello from %s' "$name" >"$work/$app/hello.txt"
  status="$(s3 PUT "$app-uploads/in/hello.txt" --data-binary "@$work/$app/hello.txt")"
  for _ in $(seq 60); do [ "$(calls "$app-uploads" async)" -ge 1 ] && break; sleep 1; done
  check "  ... a file uploaded to its bucket runs its function, with S3's event" "200 1" "$status $(calls "$app-uploads" async)"

  status="$(tool "$name" "$app" plan plan -detailed-exitcode -no-color)"
  # 0 when nothing is left to change, 2 when something is: then what.
  check "$name plan, again, finds nothing to change" "0" \
    "$status$(grep -E '^  # |^Plan: ' "$work/$app/plan.out" | head -12 | paste -sd' ' | sed 's/^./ &/')"
  check "  ... the bucket of uploads emptied, as Terraform deletes a bucket with nothing in it" "204" "$(s3 DELETE "$app-uploads/in/hello.txt")"
  status="$(tool "$name" "$app" destroy destroy -auto-approve -no-color)"
  check "$name destroy removes it all, and the account holds none of it" "0 Destroy complete! Resources: 22 destroyed. none" \
    "$status $(grep -o '^Destroy complete!.*' "$work/$app/destroy.out" || true) $(names_left "$app")"

  # The move to AWS as the project's README says it. Its providers.tf alone, where the suite's logs are beside it.
  ff doctor "$work/$app/providers.tf" --output json
  check "ff doctor names the provider block's lines for FF: the endpoints block an error, its five settings warnings" \
    "1 provider-endpoints:1 provider-setting:5" \
    "$(code) $(out | jq -r '[.findings[].check] | group_by(.) | map("\(.[0]):\(length)") | join(" ")')"
  sed -i -e '/# FF: from here/,/# \.\.\.to here\./d' -e 's/^\(  region = \).*/\1"eu-west-1"/' \
    -e 's/^\(  function_role = \).*/\1null/' "$work/$app/providers.tf"
  ff doctor "$work/$app/providers.tf" --strict
  check "  ... and nothing once they are removed, an AWS region given and the roles the modules' own, which $name validate takes" \
    "0 0" "$(code) $(tool "$name" "$app" validate-aws validate -no-color)"
}

section_tofu() {
section "OpenTofu: ff init's project, in Node.js, applied, called, planned with nothing to change, destroyed"
applied tofu tf-tofu nodejs
}
section_def tofu section_tofu backend budget=300

section_terraform() {
section "Terraform's CLI: ff init's project, in Python, applied, called, planned with nothing to change, destroyed"
applied terraform tf-terraform python
}
section_def terraform section_terraform backend budget=300

section_throttled() {
section "the plan's changes a minute: Lambda's TooManyRequestsException with Retry-After, which the provider retries"
local app=tf-throttled status
# The project's key made on the account's own plan: the API's changes count against the same limit as Lambda's.
project "$app" nodejs
[ -n "$AWS_ACCESS_KEY_ID" ] || fail "no project, or no key for it"
check "OpenTofu init takes the project" "0" "$(tool tofu "$app" init init -no-color)"
sql "INSERT INTO plans (id, name, limits) SELECT 'aws-tools-small', 'AWS tools small', limits || '{\"writesPerMinute\": 3}' FROM plans WHERE id = 'beta' ON CONFLICT (id) DO NOTHING"
sql "UPDATE accounts SET plan_id = 'aws-tools-small' WHERE id = '$account'"
# The API's function alone: its function, alias, URL with its two permissions and asynchronous settings, six changes.
status="$(tool tofu "$app" apply apply -auto-approve -no-color -target=module.api)"
python3 "$FF_REPO_ROOT/hack/lib/provider_log.py" "$work/$app/apply.log" >"$work/$app/apply.requests.tsv"
check "its apply of the API, on a plan of 3 changes a minute, goes through" "0 Apply complete! Resources: 4 added, 0 changed, 0 destroyed." \
  "$status $(grep -o '^Apply complete!.*' "$work/$app/apply.out" || true)"
# Each throttled request's operation, then whether each was answered 2xx at a later attempt.
local throttled
throttled="$(awk -F'\t' '$6 == 429 && $7 == "TooManyRequestsException" { print $4 }' "$work/$app/apply.requests.tsv" | sort -u)"
check "  ... Lambda's endpoint answered TooManyRequestsException, and the provider sent each change again until it went through" "true true" \
  "$([ -n "$throttled" ] && echo true || echo false) $(for operation in $throttled; do
    awk -F'\t' -v op="$operation" '$4 == op && $6 ~ /^2/ { ok = 1 } END { print ok ? "true" : "false" }' "$work/$app/apply.requests.tsv"
  done | sort -u | paste -sd' ')"
check "  ... with Retry-After, the seconds until the minute's changes are through" "true" \
  "$(grep -E 'http.status_code=429' "$work/$app/apply.log" | grep -E 'retry_after="?[0-9]+' >/dev/null && echo true || echo false)"
sql "UPDATE accounts SET plan_id = 'beta' WHERE id = '$account'"
check "  ... destroyed on the account's own plan" "0 none" "$(tool tofu "$app" destroy destroy -auto-approve -no-color) $(names_left "$app")"
}
section_def throttled section_throttled backend budget=360

sections_run
checks_done e2e-aws-tools
