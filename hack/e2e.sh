#!/usr/bin/env bash
# L4 end-to-end test of the whole stack, driven through the public REST API:
#   PostgreSQL + S3 (compose project "ff-e2e", ports 25432 / 29003), customers' database server (10.199.1.10)
#   + the k3d dev cluster + the backend (built, started on a free port).
# The backend first refuses the new database, then the migrations run from the
# build, as a deploy step would. Scenario: create → invoke → history → update →
# invoke → delete, with checks on the Kubernetes side (inline code too an image
# of the cluster's registry, no ConfigMap) and in object storage (the
# code archive, read through SeaweedFS's filer), and on the code's hash and size
# as AWS Lambda gives them; then the same lifecycle for a Python function (its
# handler then renamed lambda_handler), a package uploaded (named by its SHA-256,
# kept once, refused when a name leaves it) and a function made from it (its code
# an image from the cluster's registry, then a Python package, then inline code
# again), a function's environment variables (delivered through
# a Secret, replaced by an update, sealed in the database) and its secrets
# (never in an answer or the audit log, set and removed by name), and the
# event a function receives (the payload itself, or the old wrapper until
# switched). Then a function's URL, called with curl through its gateway: a
# query, a JSON body, bytes, a cookie, the function's own 404 and its error, a
# browser's preflight, the account's credentials, and the call in the history
# and the usage records; the URL's own domains, proved through a DNS server of
# the test's, a subdomain by its CNAME and an apex by its TXT record. Then a
# function on schedules: rate(1 minute) within about 70 s, with EventBridge's
# Scheduled Event or the schedule's input, a disabled one never, and a failing
# run retried a minute after, as an asynchronous call. Then
# asynchronous calls, as AWS Lambda's: an Event answered 202 at once and run
# within seconds under its request ID, a DryRun that runs nothing, Lambda's
# 1 MB limit; a failing Event retried a minute, then two minutes after its
# failure (the waits read in FF's database, then cut short there), then
# dropped, each attempt in the history and billed; one past its age dropped
# without another attempt; a function's own settings, as Lambda's
# EventInvokeConfig: no retry, and a destination function getting Lambda's
# record of each call, on success and on failure. Then a
# customer's database on the run's own server of customers' databases: made, its
# connection string over TLS as its own user, the plan's one database, a new
# password, a function reaching it with its account's internet access off and
# trusting its certificate, its hourly sample within a minute, then deleted
# from the server. Then a customer's cache on the run's own server of
# customers' caches: made, its address over TLS as its own user, the plan's
# memory with the least recently used keys going past it, the server's settings
# refused, its process under a user of its own, the plan's one cache, a new
# password, a function reaching it with its account's internet access off and
# logging in, then deleted from the server. Then customers' buckets: made
# through the API, a name once across FF, the plan's five; access keys, two at
# most, the secret once; then
# AWS's SDK for JavaScript v3, boto3 and the AWS CLI through the S3 front door,
# only their endpoint changed (uploads, downloads, ranges, listings, 100 MB in
# parts, presigned URLs, a wrong signature, an expired URL, another account's
# bucket); a read-only key, a revoked one, a suspended account and one whose
# storage is off refused; two functions, AWS's SDK for JavaScript v3 and boto3
# with no setting at all, writing to the account's bucket with keys of their own
# and refused another's, a function's key revoked with it; the bucket measured
# within a minute; an account past its plan's storage, its uploads waiting for
# room and let in again once it has some; the requests counted by the minute; its
# metrics, and an alarm on its errors firing; a bucket deleted empty, or emptied
# first when asked, its alarm with it. Then customers' queues: the AWS CLI, AWS's
# SDK for JavaScript v3 and boto3 through the SQS endpoint, only their endpoint
# changed (queues made and listed, messages with attributes sent and received,
# long polls, batches, visibility, a dead-letter queue, a queue that isn't there,
# another account's, a wrong secret, an unknown key); two functions with no
# setting at all, the SDK's own queue URL inside the cluster and boto3 with one
# from outside, which the SDK for JavaScript sends to its host; a queue as a
# function's destination, receiving Lambda's record of a call that failed; an
# alarm on a queue's messages waiting, firing once a minute sampled them, and the
# queue's metrics. Then plans:
# an account on a small plan, its limits, its namespace's quota and its rate
# limits, which don't touch other accounts. Then usage records (P-20): one per
# invocation, with the runtime
# given the invocation's ID, and a call lost when the backend is killed during
# it, which the restarted backend marks LOST without billing it, read after an
# alarm: a function's error fires it, a quiet minute recovers it, and each
# change reaches a local webhook receiver, signed. Then capacity
# samples (P-21): the warm function sampled each minute, and the capacity report.
# Then GET /usage (P-22) against the raw records, as JSON and as CSV, the deleted
# database's, bucket's and queue's months in both, priced with the first price book (P-30). Then the hourly rating (P-32): every hour settled
# since the first book rated as the backend started, in shadow mode, the balance,
# and the reconciliation. Then the balance check (P-33): a wallet run below zero,
# invokes refused with 402, a top-up, and invokes accepted again at once. Last,
# code images the registry lost: a function's layer, made again when the backend
# restarts, and pulled by a node that had no copy; and a function whose pods
# named an image the registry never had, rolled out with its package's.
# What waits on the clock (a schedule's runs, a sample taken each minute, counts
# written a minute at a time, the reaper's minute) is started in its section and
# read a few sections on, in a section of its own (schedules_ran, buckets_room,
# async_metrics, databases_sampled, caches_sampled, sites_counted, usage_lost),
# so that its minute passes while the sections between run: what it checks is
# the same, a real minute of the product's, and a section run alone waits as
# long as before.
# Removes its compose project (including its volumes),
# its tenant namespace and the backend process on exit. Keeps the cluster
# unless --teardown is given. K8S_RUNTIME_CLASS=gvisor runs every function in
# gVisor (hack/k8s/gvisor-up.sh installs it). Its sections run alone too, with what
# they need (hack/lib/sections.sh): --list names them, --only and --from choose.
# --keep removes nothing on exit, for a look and for the next run, which --reuse
# runs against the same stack (hack/lib/e2e-stack.sh says what each keeps).
#   [K8S_RUNTIME_CLASS=gvisor] hack/e2e.sh [--teardown | --keep] [--reuse] [--list | --only <section>[,<section>…] | --from <section>]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-e2e
E2E_NAME=e2e
export FF_PG_PORT="${FF_E2E_PG_PORT:-25432}"
export FF_S3_PORT="${FF_E2E_S3_PORT:-29003}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
source "$FF_REPO_ROOT/hack/lib/sections.sh"
sections_options "$@"
e2e_options "${sections_rest[@]}"

be_port="${FF_E2E_BE_PORT:-$(free_port)}"
api="http://127.0.0.1:$be_port"
tenant="$(random_account)"
tenant_ns="$(tenant_namespace "$tenant")"
e2e_namespaces+=("$tenant_ns")
http() { http_at "$api" "$@"; }
# A text's SHA-256 in base64 and its size, as AWS Lambda's CodeSha256 and CodeSize give a function's code.
code_facts() { printf '%s' "$1" | python3 -c 'import base64, hashlib, sys; code = sys.stdin.buffer.read(); print(base64.b64encode(hashlib.sha256(code).digest()).decode(), len(code))'; }
# The code image a function's pods mount at /var/task (ADR 0003), and whether it is the account's in the cluster's registry, by digest.
code_image_of() { kubectl -n "$tenant_ns" get deployment "fn-$1" -o jsonpath='{.spec.template.spec.volumes[?(@.name=="code")].image.reference}'; }
in_registry() { [[ "$1" == "$FF_REGISTRY_NAME:5000/ff-code/$tenant@sha256:"* ]] && echo true || echo false; }
code_configmaps() { kubectl -n "$tenant_ns" get configmaps -l "ff.dev/function-id=$1" -o name | wc -l; }

# What more than one section uses: a function's code, and helpers.
v1='export async function handler(event: { name?: string }) {
  return { version: 1, message: `Hello ${event.name ?? "world"}` };
}'

# xs <n>: n x's, for bodies of a size.
xs() { head -c "$1" /dev/zero | tr '\0' x; }

# zip_of <zip> <name=text>...: a zip as zip tools make one, each file deflated, its names as given.
zip_of() {
  python3 - "$@" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for entry in sys.argv[2:]:
        name, text = entry.split('=', 1)
        archive.writestr(name, text)
PY
}

# upload <zip> [content type]: POST /packages with the file as the body; its answer, its status in $work/status.
upload() { curl -sS -o "$work/body" -w '%{http_code}' -X POST -H "content-type: ${2:-application/zip}" --data-binary @"$1" "$api/packages" >"$work/status"; cat "$work/body"; }

# sha256_of <file>: its SHA-256 in base64, as AWS Lambda's CodeSha256 gives it.
sha256_of() { python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.sha256(open(sys.argv[1], "rb").read()).digest()).decode())' "$1"; }

# env_q <sql>: what FF's database holds, read with the stack's own PostgreSQL.
env_q() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -tA -c "$1"; }

echo_code='export const handler = async (event: unknown) => ({ event });'

# sql <statement>: run on FF's database, its answer dropped.
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }

# q <sql>: one value, or a row with its columns separated by spaces.
q() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -tA -F ' ' -c "$1"; }

# aws_cli: the AWS CLI, this machine's or its image's; each caller gives the key, the region and the endpoint.
if command -v aws >/dev/null; then aws_cli=(aws); else
  aws_cli=(docker run --rm --network host -v "$work:$work" -w "$work" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION
    -e AWS_CONFIG_FILE -e AWS_SHARED_CREDENTIALS_FILE -e AWS_ENDPOINT_URL_SQS -e AWS_ENDPOINT_URL_SESV2 amazon/aws-cli:2.34.32)
fi

# other: a second account, the one development mode's X-FF-Dev-Account header names: neither reaches what the other owns.
other="$(random_account)"

# as_other <method> <path> [json-body] [curl option...]: http, as the other account.
as_other() {
  local method=$1 path=$2 body=${3:-}
  shift $(($# < 3 ? $# : 3))
  http_at "$api" "$method" "$path" "$body" -H "X-FF-Dev-Account: $other" "$@"
}

# client_checks <file> <how many>: each JSON line a check, its detail shown when it fails; then that none is missing.
client_checks() {
  local line
  while IFS= read -r line; do
    if [ "$(jq -r .want <<<"$line")" = "$(jq -r .got <<<"$line")" ]; then
      check "$(jq -r '"\(.client): \(.what)"' <<<"$line")" "$(jq -r .want <<<"$line")" "$(jq -r .got <<<"$line")"
    else
      fail "$(jq -r '"\(.client): \(.what): wanted \(.want), got \(.got): \(.detail)"' <<<"$line")"
    fi
  done <"$1"
  check "  ... all $2 of them, the client to its end" "$2" "$(wc -l <"$1" | tr -d ' ')"
}

# package_with <zip> <libraries> <their folder in it> <name=file>...: a function's files and its libraries, deflated.
package_with() {
  python3 - "$@" <<'PY'
import os, sys, zipfile
target, libraries, folder, *files = sys.argv[1:]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for entry in files:
        name, path = entry.split('=', 1)
        archive.write(path, name)
    for root, dirs, names in os.walk(libraries):
        dirs[:] = sorted(d for d in dirs if d not in ('__pycache__', '.bin', 'bin'))
        for name in sorted(names):
            path = os.path.join(root, name)
            archive.write(path, os.path.join(folder, os.path.relpath(path, libraries)))
PY
}

# function_secret <function> <name>: a value of the environment Secret the function's Deployment reads, as an operator would.
function_secret() {
  kubectl -n "$tenant_ns" get secret "$(kubectl -n "$tenant_ns" get deployment "fn-$1" -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.name}')" \
    -o jsonpath="{.data.$2}" | base64 -d
}

# The AWS CLI, path-style as it addresses any endpoint, with the key in its environment and none of this machine's settings.
aws_ff() { AWS_ACCESS_KEY_ID="${AWS_KEY:-$key_id}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET:-$key_secret}" AWS_DEFAULT_REGION=tn-tunis-1 AWS_CONFIG_FILE=/dev/null \
  AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" --endpoint-url "$s3_endpoint" "$@"; }

# outcome <command…>: accepted, or refused with the S3 error's code in its message, as the CLI prints it.
outcome() { "$@" >/dev/null 2>"$work/aws.err" && echo accepted || echo "refused $(grep -oE '\((SignatureDoesNotMatch|AccessDenied|InvalidAccessKeyId|AccountProblem|InvalidArgument)\)' "$work/aws.err" | head -1 | tr -d '()')"; }

# written_within <seconds> <table> <id> <since>: true when the backend wrote the table's first row for the id within
# that many seconds of <since> (seconds since the epoch), else how long after, as its log says: in development, each
# query with its time. A sample read minutes after it was due is timed there.
written_within() {
  python3 - "$work/backend.log" "$@" <<'PY'
import datetime, json, sys
log, seconds, table, row, since = sys.argv[1:]
for line in open(log):
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    message = entry.get('message', '')
    if message.startswith(f'query: INSERT INTO "{table}"') and row in message:
        after = datetime.datetime.fromisoformat(entry['time'].replace('Z', '+00:00')).timestamp() - float(since)
        print('true' if after <= float(seconds) else f'{after:.0f} s after')
        break
else:
    print('not in the log')
PY
}

section_stack() {
section "the stack: its database and object storage, the cluster, customers' database, cache and mail servers"
e2e_within_one_month 15
e2e_dependencies
e2e_cluster
# This machine as the cluster's pods see it, the gateway of the cluster's Docker network: functions reach the S3 front
# door there with their own keys, at an IP address, where AWS's SDKs address buckets path-style by themselves.
cluster_gateway="$(docker network inspect "k3d-$FF_CLUSTER_NAME" --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | awk '{print $1}')"
# Customers' databases (ADR 0008): the run's own server, on 10.199.1.0/24, which no other run uses.
data_db_address=10.199.1.10
e2e_data_db 10.199.1.0/24 "$data_db_address"
# Customers' caches (ADR 0013): the run's own server, beside it.
cache_address=10.199.1.11
e2e_cache "$cache_address"
# Customers' mail (ADR 0012): the run's own server, beside them, handing what it sends to a stand-in for recipients'.
e2e_mail 10.199.1.12 10.199.1.13
}
section_def stack section_stack budget=80

section_backend() {
section "backend"
e2e_build
# The operator's metrics on a port of their own, and the log as production writes it: one JSON object a line.
# hack/k8s/test-monitoring.sh sets the address, for the cluster's metrics store to scrape them during the run.
metrics_host="${FF_E2E_METRICS_HOST:-127.0.0.1}"
metrics_port="${FF_E2E_METRICS_PORT:-$(free_port)}"
# Function URLs on a port of their own, each at http://<id>.fn.localhost:<port>/, which curl takes to this machine.
url_port="$(free_port)"
# Buckets' S3 front door on another, at http://s3.localhost:<port>, each bucket at http://<bucket>.s3.localhost:<port> too.
storage_port="$(free_port)"
s3_endpoint="http://s3.localhost:$storage_port"
# Queues' SQS endpoint on a third, at http://localhost:<port>; functions reach it at the cluster's gateway.
sqs_port="$(free_port)"
# Buckets' sites on a fourth, each at http://<bucket>.site.localhost:<port>, which curl takes to this machine.
website_port="$(free_port)"
# Customers' mail's SES endpoint on a fifth, at http://localhost:<port>; functions reach it at the cluster's gateway.
ses_port="$(free_port)"
# Customers' domains are checked against a DNS server of the test's, its test zone's apex on this machine.
dns_port="$(free_port)"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$tenant"
  FF_METRICS_HOST="$metrics_host" FF_METRICS_PORT="$metrics_port" FF_LOG_FORMAT=json
  FF_FUNCTION_URL_PORT="$url_port" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port"
  FF_STORAGE_PORT="$storage_port" FF_STORAGE_BASE="http://s3.localhost:$storage_port"
  FF_STORAGE_FUNCTION_ENDPOINT="http://$cluster_gateway:$storage_port" FF_STORAGE_FUNCTION_CIDRS="$cluster_gateway/32"
  FF_SQS_PORT="$sqs_port" FF_SQS_BASE="http://localhost:$sqs_port"
  FF_SQS_FUNCTION_ENDPOINT="http://$cluster_gateway:$sqs_port" FF_SQS_FUNCTION_CIDRS="$cluster_gateway/32"
  FF_WEBSITE_PORT="$website_port" FF_WEBSITE_BASE="http://site.localhost:$website_port"
  FF_SES_PORT="$ses_port" FF_SES_BASE="http://localhost:$ses_port"
  FF_SES_FUNCTION_ENDPOINT="http://$cluster_gateway:$ses_port" FF_SES_FUNCTION_CIDRS="$cluster_gateway/32"
  FF_DOMAIN_RESOLVERS="127.0.0.1:$dns_port" FF_EDGE_ADDRESSES=127.0.0.1 "${e2e_data_db_env[@]}" "${e2e_cache_env[@]}" "${e2e_mail_env[@]}")
# Production refuses development settings, at boot (the same variables, with NODE_ENV=production).
refused=0
(cd "$FF_REPO_ROOT/BE" && timeout 180 env "${be_env[@]}" NODE_ENV=production node dist/main.js) \
  >"$work/backend-production.log" 2>&1 || refused=$?
check "the backend refuses development settings in production" "1 FF_AUTH_MODE=dev is for development only" \
  "$refused $(grep -o 'FF_AUTH_MODE=dev is for development only' "$work/backend-production.log" | head -1)"
# The database is new: the backend must refuse it until the migrations have run.
refused=0
(cd "$FF_REPO_ROOT/BE" && timeout 180 env "${be_env[@]}" node dist/main.js) >"$work/backend-refused.log" 2>&1 || refused=$?
check "the backend refuses a database with pending migrations" "1 pending" \
  "$refused $(grep -o 'pending' "$work/backend-refused.log" | head -1)"
e2e_migrate "${be_env[@]}"
# The backend's own startup check, below, then proves that none is left pending.
check "the migrations run from the build" true \
  "$(grep -q 'executed successfully' "$work/migrations.log" && echo true || echo false)"
# Alarms evaluated every 5 s, each minute as soon as it is over, and notifications sent every second, to this machine too.
alarm_env=(FF_ALARM_INTERVAL_SECONDS=5 FF_ALARM_SETTLE_SECONDS=0 FF_NOTIFY_INTERVAL_SECONDS=1 FF_WEBHOOK_ALLOW_PRIVATE=true)
# The cold start the running backend allows a function (K8S_READY_TIMEOUT_SECONDS), which its hourly rating's wait for
# an hour to settle follows: the default here.
be_ready_timeout=90
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}" "${alarm_env[@]}"
check "backend answers on $api" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$api/functions")"
}
section_def backend section_backend stack budget=50

section_scenario() {
section "scenario (tenant $tenant → namespace $tenant_ns)"
created="$(http POST /functions "$(jq -n --arg code "$v1" '{name: "e2e-hello", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
check "create returns 201" 201 "$(status)"
check "function is ACTIVE once ready" ACTIVE "$(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
check "its code is inline, its handler function.handler, with its SHA-256 and size as AWS Lambda's CodeSha256 and CodeSize" \
  "inline function.handler $(code_facts "$v1")" "$(jq -r '"\(.packageType) \(.handler) \(.codeSha256) \(.codeSize)"' <<<"$created")"
check "its code is archived in object storage" "$v1" "$(archived "$id/code.ts")"
check "its Deployment runs in the tenant namespace" "fn-$id" \
  "$(kubectl -n "$tenant_ns" get deployment "fn-$id" -o jsonpath='{.metadata.name}' 2>/dev/null)"
v1_image="$(code_image_of "$id")"
check "its code reaches its pods as an image of the registry, as a package's, and no ConfigMap holds it" "true 0" \
  "$(in_registry "$v1_image") $(code_configmaps "$id")"
check "the account's packages are its uploads, none: not the one the backend made of this code" 0 "$(http GET /packages | jq length)"
if [ -n "${K8S_RUNTIME_CLASS:-}" ]; then
  check "its pods use RuntimeClass $K8S_RUNTIME_CLASS" "$K8S_RUNTIME_CLASS" \
    "$(kubectl -n "$tenant_ns" get deployment "fn-$id" -o jsonpath='{.spec.template.spec.runtimeClassName}')"
fi
# Names follow AWS Lambda's rule, and belong to one function of the account.
http POST /functions "$(jq -n --arg code "$v1" '{name: "e2e-hello", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" >/dev/null
check "a second function of the same name is refused with 409, and nothing is created" \
  "409 A function named \"e2e-hello\" already exists in this account: choose another name, or change that function 1" \
  "$(status) $(jq -r .message "$work/body") $(http GET /functions | jq length)"
http PUT "/functions/$id" '{"name": "e2e hello"}' >/dev/null
check "a name outside AWS Lambda's rule is refused, naming the rule" \
  "400 name must be 1 to 64 letters, digits, hyphens or underscores, as an AWS Lambda function's name e2e-hello" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body") $(http GET "/functions/$id" | jq -r .name)"

scaling="$(http PUT "/functions/$id/scaling-config" '{"maxInstances": 2}')"
check "scaling limits can be changed" "200 0 2 true" \
  "$(status) $(jq -r '"\(.minInstances) \(.maxInstances) \(.scaleToZero)"' <<<"$scaling")"
http PUT "/functions/$id/scaling-config" '{"minInstances": 3}' >/dev/null
check "minInstances above maxInstances is refused" 400 "$(status)"
http PUT "/functions/$id/scaling-config" '{"maxInstances": 11}' >/dev/null
check "maxInstances above the plan's limit is refused, naming it" "400 maxInstances must be at most 10 on the Beta plan" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
check "the namespace's quota is the beta plan's" "20 8 8Gi" \
  "$(kubectl -n "$tenant_ns" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"

invoked="$(http POST "/functions/$id/invoke" '{"input":{"name":"e2e"}}')"
check "invoke returns 201" 201 "$(status)"
check "invocation is COMPLETED" COMPLETED "$(jq -r .status <<<"$invoked")"
check "handler output is returned" "Hello e2e" "$(jq -r .output.message <<<"$invoked")"

history="$(http GET "/functions/$id/invocations")"
check "history lists the invocation" 1 "$(jq -r .total <<<"$history")"
check "a duration was recorded" true "$(jq -r '.invocations[0].duration > 0' <<<"$history")"

# P-45: the history keeps up to 64 KiB of an input and an output, while the answer has them whole; NUL is kept as U+FFFD.
long="$(head -c 80000 /dev/zero | tr '\0' x)"
big="$(http POST "/functions/$id/invoke" "$(jq -cn --arg name "$long" '{input: {name: $name}}')")"
check "an input and an output over 64 KiB are answered whole, and flagged as cut in the history (P-45)" "201 80000 80006 true true" \
  "$(status) $(jq -r '"\(.input.name | length) \(.output.message | length) \(.inputTruncated) \(.outputTruncated)"' <<<"$big")"
kept="$(http GET "/functions/$id/invocations?limit=1" | jq -c '.invocations[0]')"
check "the history keeps the first 64 KiB of each, the start of its JSON text" "true true 65536 65536 true true" \
  "$(jq -r '"\(.inputTruncated) \(.outputTruncated) \(.input | utf8bytelength) \(.output | utf8bytelength) \(.input | startswith("{\"name\":\"xxx")) \(.output | startswith("{\"version\":1,\"message\":\"Hello xxx"))"' <<<"$kept")"
nul="$(http POST "/functions/$id/invoke" '{"input":{"name":"a\u0000b"}}')"
check "a NUL in the input reaches the function, and comes back in the answer (P-45)" "201 true" \
  "$(status) $(jq -r '.output.message == "Hello a\u0000b"' <<<"$nul")"
check "the history keeps it as U+FFFD, which PostgreSQL can store" true \
  "$(http GET "/functions/$id/invocations?limit=1" | jq -r '.invocations[0] | .input.name == "a\ufffdb" and .output.message == "Hello a\ufffdb" and .inputTruncated == false')"

v2="${v1//version: 1/version: 2}"
http PUT "/functions/$id" "$(jq -n --arg code "$v2" '{code: $code}')" >/dev/null
check "update returns 200" 200 "$(status)"
check "the new code is live after the update" 2 \
  "$(http POST "/functions/$id/invoke" '{"input":{}}' | jq -r .output.version)"
check "the record has the new code's SHA-256 and size" "$(code_facts "$v2")" "$(http GET "/functions/$id" | jq -r '"\(.codeSha256) \(.codeSize)"')"
check "the archive holds the new code" "$v2" "$(archived "$id/code.ts")"
v2_image="$(code_image_of "$id")"
check "its pods mount the new code's image" "true true" "$([ "$v2_image" != "$v1_image" ] && echo true || echo false) $(in_registry "$v2_image")"

http DELETE "/functions/$id" >/dev/null
check "delete returns 200" 200 "$(status)"
gone=false
for _ in $(seq 1 30); do
  if ! kubectl -n "$tenant_ns" get deployment "fn-$id" >/dev/null 2>&1; then
    gone=true
    break
  fi
  sleep 1
done
check "its Deployment is removed from the cluster" true "$gone"
check "its archive is removed from object storage" "" "$(archived "$id/code.ts")"
http GET "/functions/$id" >/dev/null
check "the function record is gone" 404 "$(status)"
}
section_def scenario section_scenario backend budget=20

section_schedules() {
section "a function on a schedule: its schedules made, their runs checked a few sections on"
created="$(http POST /functions "$(jq -n --arg code "$echo_code" '{name: "e2e-scheduled", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
sched_fn="$(jq -r .id <<<"$created")"
check "the next runs of an expression, for a preview: five, in UTC" "200 5 true" \
  "$(http GET '/schedules/next-runs?expression=cron(0%208%20*%20*%20%3F%20*)' >/dev/null; status) $(jq '.runs | length' "$work/body") $(jq '[.runs[] | endswith("T08:00:00.000Z")] | all' "$work/body")"
http POST "/functions/$sched_fn/schedules" '{"name": "bad", "expression": "rate(5 minute)"}' >/dev/null
check "an expression EventBridge wouldn't take is refused, saying why" "400 rate(5 minute) must be rate(5 minutes): the unit is plural above 1" "$(status) $(jq -r .message "$work/body")"
made_at="$(date -u +%s)"
every="$(http POST "/functions/$sched_fn/schedules" '{"name": "every-minute", "expression": "rate(1 minute)"}')"
check "a schedule is made, its first run a minute after" "201 true" \
  "$(status) $(jq --argjson t "$made_at" '(.nextRunAt | sub("\\.[0-9]+Z$"; "Z") | fromdate) - $t | (. >= 55 and . <= 65)' <<<"$every")"
http POST "/functions/$sched_fn/schedules" '{"name": "with-input", "expression": "rate(1 minute)", "input": {"report": "daily"}}' >/dev/null
http POST "/functions/$sched_fn/schedules" '{"name": "off", "expression": "rate(1 minute)", "enabled": false}' >/dev/null
check "and one with an input of its own, and one disabled" "201 null" "$(status) $(jq -r .nextRunAt "$work/body")"
http PUT "/functions/$sched_fn" '{"eventFormat": "wrapped"}' >/dev/null
check "a function with schedules keeps AWS Lambda's event" 400 "$(status)"
# A function whose runs fail: each run is an asynchronous call, retried.
failing_sched_fn="$(http POST /functions "$(jq -n '{name: "e2e-scheduled-fails", runtime: "nodejs", code: "export const handler = async () => { throw new Error(\"the report failed\"); };", memory: 128, timeout: 5}')" | jq -r .id)"
http POST "/functions/$failing_sched_fn/schedules" '{"name": "every-minute", "expression": "rate(1 minute)"}' >/dev/null
}
section_def schedules section_schedules backend budget=20

section_python() {
section "python function"
py='def handler(event, context):
    return {"message": "Hello " + event.get("name", "world"), "memory": context.memory_limit_in_mb}
'
created="$(http POST /functions "$(jq -n --arg code "$py" '{name: "e2e-python", runtime: "python", code: $code, memory: 128, timeout: 5}')")"
check "create returns 201" 201 "$(status)"
check "function is ACTIVE once ready" ACTIVE "$(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
invoked="$(http POST "/functions/$id/invoke" '{"input":{"name":"Python"}}')"
check "invocation is COMPLETED" COMPLETED "$(jq -r .status <<<"$invoked")"
check "handler output is returned, with the Lambda context" "Hello Python 128" \
  "$(jq -r '"\(.output.message) \(.output.memory)"' <<<"$invoked")"
# AWS Lambda's Python functions are often lambda_handler: naming it is enough.
py_aws='def lambda_handler(event, context):
    return {"message": "Hello from lambda_handler"}
'
http PUT "/functions/$id" "$(jq -n --arg code "$py_aws" '{code: $code, handler: "function.lambda_handler"}')" >/dev/null
check "a handler named by an update rolls out, and the runtime calls it" "200 function.lambda_handler Hello from lambda_handler" \
  "$(status) $(http GET "/functions/$id" | jq -r .handler) $(http POST "/functions/$id/invoke" '{"input":{}}' | jq -r .output.message)"
check "its pods are told it" function.lambda_handler \
  "$(kubectl -n "$tenant_ns" get deployment "fn-$id" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FF_HANDLER")].value}')"
http PUT "/functions/$id" '{"handler": "lambda_function.lambda_handler"}' >/dev/null
check "a handler in another file than inline code's is refused, naming its file, and the function keeps its own" \
  "400 handler must be function.<name> for inline code, which is the file function.py: function.handler, for example function.lambda_handler" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body") $(http GET "/functions/$id" | jq -r .handler)"
http DELETE "/functions/$id" >/dev/null
check "delete returns 200" 200 "$(status)"
}
section_def python section_python backend budget=15

section_requests() {
section "the API's request limits, and a function found by its name"
# Bodies this large go through files: a command line's argument holds 128 KiB at most.
greeter='export async function handler(event: { name?: string }) {
  return { message: `Hello ${event.name ?? "world"}` };
}'
{ printf '// '; xs 150000; printf '\n%s\n' "$greeter"; } >"$work/large.ts"
jq -n --rawfile code "$work/large.ts" '{name: "e2e-large", runtime: "nodejs", code: $code, memory: 128, timeout: 5}' >"$work/large.json"
created="$(http POST /functions "" --data-binary @"$work/large.json")"
check "a function with 150 KB of code is made, which a body of 100 KB at most refused before" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
large_id="$(jq -r .id <<<"$created")"
check "GET /functions?name= finds it, and only it" "1 $large_id" "$(http GET '/functions?name=e2e-large' | jq -r '"\(length) \(.[0].id)"')"
check "and compares names exactly: another case finds none" 0 "$(http GET '/functions?name=e2e-LARGE' | jq length)"
{ printf '// '; xs 1048576; printf '\n%s\n' "$greeter"; } >"$work/mib.ts"
jq -n --rawfile code "$work/mib.ts" '{code: $code}' >"$work/mib.json"
http PUT "/functions/$large_id" "" --data-binary @"$work/mib.json" >/dev/null
check "1 MiB of code, more than a ConfigMap holds, is taken, as its image, and answers" "200 $(stat -c %s "$work/mib.ts") Hello Sfax" \
  "$(status) $(jq -r .codeSize "$work/body") $(http POST "/functions/$large_id/invoke" '{"input":{"name":"Sfax"}}' | jq -r .output.message)"
xs 3145729 >"$work/huge.ts"
jq -n --rawfile code "$work/huge.ts" '{code: $code}' >"$work/huge.json"
http PUT "/functions/$large_id" "" --data-binary @"$work/huge.json" >/dev/null
check "3 MiB and a byte of code is refused, saying the limit, and the function stays as it was" \
  "400 code is 3,145,729 bytes of UTF-8; it may have 3,145,728 at most, as AWS Lambda's console takes in its editor (3 MiB): more comes as a package ACTIVE $(stat -c %s "$work/mib.ts")" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body") $(http GET "/functions/$large_id" | jq -r '"\(.status) \(.codeSize)"')"
xs 1000000 >"$work/name.txt"
jq -n --rawfile name "$work/name.txt" '{input: {name: $name}}' >"$work/input.json"
invoked="$(http POST "/functions/$large_id/invoke" "" --data-binary @"$work/input.json")"
check "an input of 1 MB is taken, and its answer comes whole" "201 COMPLETED 1000006" "$(status) $(jq -r '"\(.status) \(.output.message | length)"' <<<"$invoked")"
xs 6300000 >"$work/name.txt"
jq -n --rawfile name "$work/name.txt" '{input: {name: $name}}' >"$work/input.json"
calls="$(http GET "/functions/$large_id/invocations" | jq -r .total)"
http POST "/functions/$large_id/invoke" "" --data-binary @"$work/input.json" >/dev/null
check "an input over 6 MB is refused as AWS Lambda refuses it, and nothing runs" \
  "413 RequestEntityTooLargeException Request must be smaller than 6291456 bytes for the InvokeFunction operation: the input is 6300011 bytes as JSON $calls" \
  "$(status) $(jq -r '"\(.error) \(.message)"' "$work/body") $(http GET "/functions/$large_id/invocations" | jq -r .total)"
xs 7400000 >"$work/name.txt"
jq -n --rawfile name "$work/name.txt" '{input: {name: $name}}' >"$work/input.json"
http POST "/functions/$large_id/invoke" "" --data-binary @"$work/input.json" >/dev/null
check "a body over 7 MB is refused, saying the limits" \
  "413 The request's body is over 7 MB (7,340,032 bytes): a function's code may have 3 MiB, an invocation's input 6 MB" \
  "$(status) $(jq -r .message "$work/body")"
xs 120000 >"$work/name.txt"
jq -n --rawfile name "$work/name.txt" '{name: "e2e-large", expression: "rate(1 hour)", input: {name: $name}}' >"$work/schedule.json"
http POST "/functions/$large_id/schedules" "" --data-binary @"$work/schedule.json" >/dev/null
check "any other body over 100 KB is refused with 413 and why, where the API answered 500 before" \
  "413 The request's body is over 100 KB (102,400 bytes), this route's limit true" \
  "$(status) $(jq -r .message "$work/body") $(jq -r '.requestId | length == 36' "$work/body")"
http DELETE "/functions/$large_id" >/dev/null
check "delete returns 200" 200 "$(status)"
}
section_def requests section_requests backend budget=30

section_package() {
section "a function's package"
zip_of "$work/package.zip" 'index.js=exports.handler = async () => require("./lib/greet")("e2e");' 'lib/greet.js=module.exports = (name) => "Hello " + name;'
package_sha="$(sha256_of "$work/package.zip")"
uploaded="$(upload "$work/package.zip")"
check "a package is taken: 201, named by its SHA-256 in base64 as computed here, with its sizes and files" \
  "201 $package_sha $(stat -c %s "$work/package.zip") 2" "$(status) $(jq -r '"\(.codeSha256) \(.codeSize) \(.fileCount)"' <<<"$uploaded")"
upload "$work/package.zip" >/dev/null
check "the same package again: 200, and the account has it once" "200 1" "$(status) $(http GET /packages | jq length)"
check "GET /packages?codeSha256= finds it" "$package_sha" \
  "$(http GET "/packages?codeSha256=$(jq -rn --arg s "$package_sha" '$s | @uri')" | jq -r '.[0].codeSha256')"
check "its zip is in object storage, under its account and its SHA-256 in hex" "$(stat -c %s "$work/package.zip")" \
  "$(archived "packages/$tenant/$(printf '%s' "$package_sha" | base64 -d | od -An -tx1 | tr -d ' \n').zip" | wc -c)"
check "the audit log records the upload once" 1 \
  "$(http GET /audit-log | jq --arg r "package:$package_sha" '[.entries[] | select(.resource == $r and .action == "package.upload")] | length')"
zip_of "$work/slip.zip" 'index.js=exports.handler = async () => 1;' '../../etc/cron.d/evil=* * * * * root sh'
upload "$work/slip.zip" >/dev/null
check "a package whose name leaves it is refused, saying which, and nothing is kept" \
  "400 The package can't be read: ../../etc/cron.d/evil leaves the package with ..: a package's names stay inside it 1" \
  "$(status) $(jq -r .message "$work/body") $(http GET /packages | jq length)"
upload "$work/package.zip" text/plain >/dev/null
check "a body not sent as a zip is refused with 415" "415 Send the package as the body, a zip archive, with Content-Type: application/zip, not text/plain" \
  "$(status) $(jq -r .message "$work/body")"
}
section_def package section_package backend budget=5

section_from_package() {
section "a function made from a package"
created="$(http POST /functions "$(jq -n --arg sha "$package_sha" '{name: "e2e-package", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 5}')")"
check "a function made from the package is ACTIVE: zip, the package's hash and size, no inline code" \
  "201 ACTIVE zip $package_sha $(stat -c %s "$work/package.zip") 0" \
  "$(status) $(jq -r '"\(.status) \(.packageType) \(.codeSha256) \(.codeSize) \(.code | length)"' <<<"$created")"
pkg_fn="$(jq -r .id <<<"$created")"
check "it runs the package's code, its library in a folder included" "Hello e2e" "$(http POST "/functions/$pkg_fn/invoke" '{"input":{}}' | jq -r .output)"
code_image="$(code_image_of "$pkg_fn")"
check "its pods mount the package's code image at /var/task, from the registry, by digest" true "$(in_registry "$code_image")"
check "the registry has that image, and the function no code ConfigMap" "200 0" \
  "$(curl -s -o /dev/null -w '%{http_code}' -I -H 'accept: application/vnd.oci.image.manifest.v1+json' "http://127.0.0.1:$FF_REGISTRY_PORT/v2/ff-code/$tenant/manifests/${code_image##*@}") $(code_configmaps "$pkg_fn")"
http POST /functions "$(jq -n --arg sha "$package_sha" '{name: "e2e-wrong-handler", runtime: "nodejs", codeSha256: $sha, handler: "src/app.handler", memory: 128, timeout: 5}')" >/dev/null
check "a handler the package lacks is refused, saying which file, and nothing is made" \
  "400 The package has no src/app.js, .mjs, .cjs or .ts, nor a folder src/app/, which the handler src/app.handler names 0" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body") $(http GET '/functions?name=e2e-wrong-handler' | jq length)"
unknown_sha='n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg='
http POST /functions "$(jq -n --arg sha "$unknown_sha" '{name: "e2e-no-package", runtime: "nodejs", codeSha256: $sha, memory: 128, timeout: 5}')" >/dev/null
check "a package the account hasn't is refused, saying how to upload one" \
  "400 The account has no package $unknown_sha: upload it with POST /packages, which answers its SHA-256" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
# A Python package: its handler's module at the root, a helper in a folder without __init__.py, as Python 3 imports one.
zip_of "$work/python.zip" 'lambda_function.py=from helpers.greet import greet


def lambda_handler(event, context):
    return greet(event.get("name", "world"))
' 'helpers/greet.py=def greet(name):
    return "Ahlan " + name
'
upload "$work/python.zip" >/dev/null
python_sha="$(sha256_of "$work/python.zip")"
http PUT "/functions/$pkg_fn" "$(jq -n --arg sha "$python_sha" '{runtime: "python", codeSha256: $sha, handler: "lambda_function.lambda_handler", memory: 256}')" >/dev/null
check "one update moves it to a Python package, with its handler, runtime and memory, in one rollout" "200 python 256 Ahlan Sfax" \
  "$(status) $(http GET "/functions/$pkg_fn" | jq -r '"\(.runtime) \(.memory)"') $(http POST "/functions/$pkg_fn/invoke" '{"input":{"name":"Sfax"}}' | jq -r .output)"
http PUT "/functions/$pkg_fn" "$(jq -n --arg code 'def handler(event, context):
    return "inline again"
' '{code: $code, handler: "function.handler"}')" >/dev/null
inline_image="$(code_image_of "$pkg_fn")"
check "and back to inline code: an image of its own, which answers, and still no ConfigMap" "200 inline inline again true true 0" \
  "$(status) $(http GET "/functions/$pkg_fn" | jq -r .packageType) $(http POST "/functions/$pkg_fn/invoke" '{"input":{}}' | jq -r .output) $([ "$inline_image" != "$code_image" ] && echo true || echo false) $(in_registry "$inline_image") $(code_configmaps "$pkg_fn")"
check "the account's packages are still its two uploads" 2 "$(http GET /packages | jq length)"
http DELETE "/functions/$pkg_fn" >/dev/null
check "delete returns 200" 200 "$(status)"
# A native module built as AWS Lambda's builds are, against glibc: bcrypt with the prebuilt linux-x64-glibc binary that npm
# fetches as it installs it. Made once, then kept in hack/.cache, since it needs the npm registry and GitHub.
native_zip="$FF_REPO_ROOT/hack/.cache/bcrypt-5.1.1-glibc.zip"
if [ ! -s "$native_zip" ]; then
  mkdir -p "$(dirname "$native_zip")" "$work/native"
  printf '%s\n' "const bcrypt = require('bcrypt');" "exports.handler = async (event) => {" \
    "  const hash = bcrypt.hashSync(event.password ?? 'secret', 4);" \
    "  return { native: true, matches: bcrypt.compareSync(event.password ?? 'secret', hash) };" "};" >"$work/native/index.js"
  docker run --rm -v "$work/native:/out" -w /out node:24-trixie-slim sh -c \
    "npm init -y >/dev/null && npm install --silent --omit=dev bcrypt@5.1.1 >/dev/null && chown -R $(id -u):$(id -g) /out" ||
    fail "could not build the bcrypt package: npm needs the network"
  (cd "$work/native" && python3 -c 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", ".")' "$native_zip")
fi
upload "$native_zip" >/dev/null
native="$(http POST /functions "$(jq -n --arg sha "$(sha256_of "$native_zip")" '{name: "e2e-native", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 10}')")"
check "a package with a native module built against glibc, as Lambda's are, runs on the Node.js runtime: bcrypt hashes and checks" \
  '201 ACTIVE {"native":true,"matches":true}' \
  "$(status) $(jq -r .status <<<"$native") $(http POST "/functions/$(jq -r .id <<<"$native")/invoke" '{"input":{"password":"hunter2"}}' | jq -c .output)"
http DELETE "/functions/$(jq -r .id <<<"$native")" >/dev/null
}
section_def from_package section_from_package package budget=30

section_environment() {
section "environment variables"
# A variable of its own for the function: the sections below still read $id, the Python function's.
reader='export async function handler() { return { table: process.env.TABLE ?? null, tz: process.env.TZ }; }'
created="$(http POST /functions "$(jq -n --arg code "$reader" '{name: "e2e-environment", runtime: "nodejs", code: $code, memory: 128, timeout: 5, environment: {TABLE: "orders"}}')")"
check "a function created with a variable answers with it" "201 ACTIVE orders" "$(status) $(jq -r '"\(.status) \(.environment.TABLE)"' <<<"$created")"
env_fn="$(jq -r .id <<<"$created")"
check "the function reads it, in UTC by default" "orders UTC" "$(http POST "/functions/$env_fn/invoke" '{"input":{}}' | jq -r '"\(.output.table) \(.output.tz)"')"
check "GET answers with it; the list doesn't load it" "orders null" \
  "$(http GET "/functions/$env_fn" | jq -r .environment.TABLE) $(http GET /functions | jq -r --arg id "$env_fn" '.[] | select(.id == $id) | .environment')"
http PUT "/functions/$env_fn" '{"environment": {"TABLE": "invoices", "TZ": "Africa/Tunis"}}' >/dev/null
check "an update replaces them, rolled out, and the function's own TZ wins" "200 invoices Africa/Tunis" \
  "$(status) $(http POST "/functions/$env_fn/invoke" '{"input":{}}' | jq -r '"\(.output.table) \(.output.tz)"')"
check "the Deployment reads them from its Secret, and holds no value" "fn-$env_fn-env-1 0" \
  "$(kubectl -n "$tenant_ns" get deployment "fn-$env_fn" -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.name}') $(kubectl -n "$tenant_ns" get deployment "fn-$env_fn" -o json | grep -c invoices)"
check "the Secret of the version replaced is gone once the rollout is complete" "fn-$env_fn-env-1" \
  "$(kubectl -n "$tenant_ns" get secrets -l "ff.dev/function-id=$env_fn" -o jsonpath='{.items[*].metadata.name}')"
check "the database keeps them sealed: no value, no name in clear" "1 0" \
  "$(env_q "SELECT count(*), count(*) FILTER (WHERE document::text ~ 'invoices|TABLE') FROM function_environments WHERE function_id = '$env_fn'" | tr '|' ' ')"
http PUT "/functions/$env_fn" '{"environment": {"AWS_REGION": "x", "1BAD": "y"}}' >/dev/null
check "names AWS Lambda reserves, or outside its rule, are refused, naming each" \
  "400 AWS_REGION is reserved: AWS Lambda or FF's runtime sets it; \"1BAD\" is not a variable name: a letter first, then letters, digits or underscores, two characters at least, as on AWS Lambda" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
check "the audit log names the variables changed, never their values" '{"added":["TZ"],"changed":["TABLE"],"removed":[]} 0' \
  "$(http GET /audit-log | jq -c --arg r "function:$env_fn" '[.entries[] | select(.resource == $r and .action == "function.update")][0].details.environment') $(http GET /audit-log | grep -c -E 'invoices|orders')"
http DELETE "/functions/$env_fn" >/dev/null
check "deleting the function deletes its Secrets and its row" "200  0" \
  "$(status) $(kubectl -n "$tenant_ns" get secrets -l "ff.dev/function-id=$env_fn" -o name) $(env_q "SELECT count(*) FROM function_environments WHERE function_id = '$env_fn'")"
}
section_def environment section_environment backend budget=20

section_secrets() {
section "secrets"
# Variables whose values nobody reads back, read by a Python function as its variables.
sec_reader='import os

def handler(event, context):
    return {"user": os.environ.get("DB_USER"), "password": os.environ.get("DB_PASSWORD"), "token": os.environ.get("API_TOKEN")}
'
created="$(http POST /functions "$(jq -n --arg code "$sec_reader" '{name: "e2e-secrets", runtime: "python", code: $code, memory: 128, timeout: 5,
  environment: {DB_USER: "ff"}, secrets: {DB_PASSWORD: "e2e-first-password"}}')")"
check "a function created with a secret answers with its variable, never the secret" "201 ACTIVE ff 0" \
  "$(status) $(jq -r '"\(.status) \(.environment.DB_USER)"' <<<"$created") $(grep -c e2e-first-password <<<"$created")"
sec_fn="$(jq -r .id <<<"$created")"
check "the Python function reads both, as variables" "ff e2e-first-password null" \
  "$(http POST "/functions/$sec_fn/invoke" '{"input":{}}' | jq -r '"\(.output.user) \(.output.password) \(.output.token)"')"
http GET "/functions/$sec_fn/secrets" >/dev/null
check "GET .../secrets names it, with when it was set, never its value" '200 ["DB_PASSWORD"] true 0' \
  "$(status) $(jq -c '[.secrets[].name]' "$work/body") $(jq -r '.secrets[0].updatedAt | test("^20[0-9-]{8}T")' "$work/body") $(grep -c e2e-first-password "$work/body")"
http PATCH "/functions/$sec_fn/secrets" '{"secrets": {"DB_PASSWORD": "e2e-second-password", "API_TOKEN": "e2e-token"}}' >/dev/null
check "PATCH sets and replaces them, rolled out, and answers their names alone" '200 ["API_TOKEN","DB_PASSWORD"] 0' \
  "$(status) $(jq -c '[.secrets[].name]' "$work/body") $(grep -c -E 'e2e-second-password|e2e-token' "$work/body")"
check "the new version reads the new values" "e2e-second-password e2e-token" \
  "$(http POST "/functions/$sec_fn/invoke" '{"input":{}}' | jq -r '"\(.output.password) \(.output.token)"')"
in_use="$(kubectl -n "$tenant_ns" get deployment "fn-$sec_fn" -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.name}')"
check "they reach the pods through the Secret the Deployment names, and the Deployment holds none" "e2e-second-password 0" \
  "$(kubectl -n "$tenant_ns" get secret "$in_use" -o jsonpath='{.data.DB_PASSWORD}' | base64 -d) $(kubectl -n "$tenant_ns" get deployment "fn-$sec_fn" -o json | grep -c -E 'e2e-(first|second)-password|e2e-token')"
http PATCH "/functions/$sec_fn/secrets" '{"secrets": {"API_TOKEN": null}}' >/dev/null
check "null removes one, and the function no longer reads it" '200 ["DB_PASSWORD"] null' \
  "$(status) $(jq -c '[.secrets[].name]' "$work/body") $(http POST "/functions/$sec_fn/invoke" '{"input":{}}' | jq -r .output.token)"
http PUT "/functions/$sec_fn" '{"environment": {"DB_USER": "ff", "DB_PASSWORD": "x"}}' >/dev/null
check "a variable can't take a secret's name" "400 DB_PASSWORD is both a variable and a secret: a name is one or the other" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
http PATCH "/functions/$sec_fn/secrets" "$(jq -cn --arg big "$(head -c 4100 /dev/zero | tr '\0' x)" '{secrets: {BIG: $big}}')" >/dev/null
check "nor do variables and secrets go over 4 KB together" "400 true" \
  "$(status) $(jq -r '.message | join("; ") | test("AWS Lambda allows 4096 \\(4 KB\\)")' "$work/body")"
check "neither the function's answers, nor the audit log, nor the database holds a secret's value" "0 0 0" \
  "$(http GET "/functions/$sec_fn" | grep -c -E 'e2e-(first|second)-password') $(http GET /audit-log | grep -c -E 'e2e-(first|second)-password|e2e-token') $(env_q "SELECT count(*) FROM function_environments WHERE document::text ~ 'e2e-|DB_PASSWORD'")"
check "the audit log names the secrets changed" '{"added":["API_TOKEN"],"changed":["DB_PASSWORD"],"removed":[]}' \
  "$(http GET /audit-log | jq -c --arg r "function:$sec_fn" '[.entries[] | select(.resource == $r and .action == "function.update")] | last | .details.secrets')"
http DELETE "/functions/$sec_fn" >/dev/null
check "deleting the function deletes its Secrets" "200 " "$(status) $(kubectl -n "$tenant_ns" get secrets -l "ff.dev/function-id=$sec_fn" -o name)"
}
section_def secrets section_secrets backend budget=20

section_event() {
section "the event a function receives"
created="$(http POST /functions "$(jq -n --arg code "$echo_code" '{name: "e2e-event", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
check "a new function gets AWS Lambda's event, the payload itself" "201 lambda" "$(status) $(jq -r .eventFormat <<<"$created")"
event_fn="$(jq -r .id <<<"$created")"
echoed() { http POST "/functions/$1/invoke" "$(jq -cn --argjson input "$2" '{input: $input}')" | jq -c .output.event; }
check "any JSON value is the event: an object, a string, a number, an array, null" '{"name":"Tunis"} "Tunis" 42 [1,"two"] null' \
  "$(echoed "$event_fn" '{"name":"Tunis"}') $(echoed "$event_fn" '"Tunis"') $(echoed "$event_fn" 42) $(echoed "$event_fn" '[1,"two"]') $(echoed "$event_fn" null)"
check "its pods are told so" lambda \
  "$(kubectl -n "$tenant_ns" get deployment "fn-$event_fn" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FF_EVENT_FORMAT")].value}')"
created="$(http POST /functions "$(jq -n --arg code "$echo_code" '{name: "e2e-wrapped", runtime: "nodejs", code: $code, memory: 128, timeout: 5, eventFormat: "wrapped"}')")"
wrapped_fn="$(jq -r .id <<<"$created")"
check "a function made before gets FF's original wrapper, the payload in body" '201 {"name":"Sfax"} POST /invoke' \
  "$(status) $(http POST "/functions/$wrapped_fn/invoke" '{"input": {"name": "Sfax"}}' | jq -cr '.output.event | "\(.body | tojson) \(.method) \(.path)"')"
http PUT "/functions/$wrapped_fn" '{"eventFormat": "lambda"}' >/dev/null
check "switching it is an update, rolled out, after which it gets the payload itself" '200 lambda {"name":"Sfax"}' \
  "$(status) $(jq -r .eventFormat "$work/body") $(echoed "$wrapped_fn" '{"name":"Sfax"}')"
http PUT "/functions/$wrapped_fn" '{"eventFormat": "v2"}' >/dev/null
check "an unknown format is refused" "400 eventFormat must be one of the following values: lambda, wrapped" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
for f in "$event_fn" "$wrapped_fn"; do http DELETE "/functions/$f" >/dev/null; done
}
section_def event section_event backend budget=30

section_url() {
section "a function's URL"
url_code='export async function handler(event: any) {
  if (event.rawPath === "/fail") throw new Error("broken on purpose");
  if (event.rawPath === "/missing") return { statusCode: 404, headers: { "content-type": "text/plain" }, body: "no such page" };
  if (event.rawPath === "/cookie") return { statusCode: 200, cookies: ["visited=yes; Path=/"], body: "set" };
  return {
    statusCode: 200,
    headers: { "x-handled-by": "e2e" },
    body: JSON.stringify({
      method: event.requestContext.http.method, path: event.rawPath, query: event.queryStringParameters ?? null,
      cookies: event.cookies ?? [], body: event.body ?? null, base64: event.isBase64Encoded, auth: event.headers.authorization ?? null,
      account: event.requestContext.accountId, requestId: event.requestContext.requestId, domain: event.requestContext.domainName,
    }),
  };
}'
created="$(http POST /functions "$(jq -n --arg code "$url_code" '{name: "e2e-url", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
url_fn="$(jq -r .id <<<"$created")"
made="$(http POST "/functions/$url_fn/url" '{"authType": "NONE"}')"
url_address="$(jq -r .functionUrl <<<"$made")"
check "a function gets a URL, at a random address under the function domain" "201 true" \
  "$(status) $([[ $url_address =~ ^http://[a-z0-9]{32}\.fn\.localhost:$url_port/$ ]] && echo true || echo false)"
url_host="${url_address#http://}"
url_host="${url_host%%:*}"
# at_url <method> <path> [curl option...]: a request to the URL, by its address; prints the body, the status and
# the headers go to $work/url-status and $work/url-headers. --resolve so that no system resolver is needed.
at_url() {
  local method=$1 path=$2
  shift 2
  curl -sS -o "$work/url-body" -D "$work/url-headers" -w '%{http_code}' -X "$method" --resolve "$url_host:$url_port:127.0.0.1" \
    "$@" "http://$url_host:$url_port$path" >"$work/url-status"
  cat "$work/url-body"
}
url_status() { cat "$work/url-status"; }
url_header() { awk -v name="$1" 'tolower($1) == tolower(name ":") { sub(/\r$/, ""); $1 = ""; sub(/^ /, ""); print }' "$work/url-headers"; }
answered="$(at_url GET '/hello?name=Amira&tag=a&tag=b')"
check "GET with a query reaches the function as AWS Lambda's event, anonymous, and its answer comes back" \
  '200 e2e {"method":"GET","path":"/hello","query":{"name":"Amira","tag":"a,b"},"account":"anonymous"}' \
  "$(url_status) $(url_header x-handled-by) $(jq -c '{method, path, query, account}' <<<"$answered")"
check "the answer names the call, as the event does: the invocation's ID" true \
  "$(jq -r --arg id "$(url_header x-amzn-requestid)" '.requestId == $id and ($id | test("^[0-9a-f-]{36}$"))' <<<"$answered")"
url_call="$(url_header x-amzn-requestid)"
check "a JSON POST comes as text" '200 {"body":"{\"order\":7}","base64":false}' \
  "$(url_status) $(at_url POST /orders -H 'content-type: application/json' --data '{"order":7}' | jq -c '{body, base64}')"
printf '\x89PNG\r\n\x1a\n\x00\xff' >"$work/url-bytes"
check "a binary PUT comes in base64" "200 $(base64 -w0 "$work/url-bytes") true" \
  "$(url_status) $(at_url PUT /upload -H 'content-type: image/png' --data-binary @"$work/url-bytes" | jq -r '"\(.body) \(.base64)"')"
at_url GET /cookie >/dev/null
check "a cookie set by the function, and read back" '200 visited=yes; Path=/ ["visited=yes"]' \
  "$(url_status) $(url_header set-cookie) $(at_url GET / -H 'cookie: visited=yes' | jq -c .cookies)"
check "a path the function doesn't know: its own 404" "no such page 404" "$(at_url GET /missing) $(url_status)"
check "a function's error is a 502, without its message" '502 {"Message":"Internal Server Error"}' "$(at_url GET /fail >/dev/null; url_status) $(cat "$work/url-body")"
check "a host that is no URL is a 404" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' --resolve "nothing.fn.localhost:$url_port:127.0.0.1" "http://nothing.fn.localhost:$url_port/")"
at_url GET / -H 'authorization: Bearer the-callers-own-token' >/dev/null
latest="$(http GET "/functions/$url_fn/invocations?limit=1" | jq -c '.invocations[0]')"
check "the call is in the history as the URL's, its credentials kept as ***" 'url *** null' \
  "$(jq -r '"\(.source) \(.input.headers.authorization) \(.input.cookies)"' <<<"$latest")"
check "each call has its usage record, under its request ID" 1 "$(env_q "SELECT count(*) FROM usage_records WHERE request_id = '$url_call'")"
}
section_def url section_url backend budget=15

section_url_domain() {
section "a URL's own domain"
zone_dir="$work/zones"
mkdir -p "$zone_dir"
# zone <serial> [record...]: the test zone, e2e-customer.tn, with these records besides its own; a new serial each time.
zone() {
  local serial=$1
  shift
  {
    printf '$ORIGIN e2e-customer.tn.\n$TTL 5\n@ IN SOA ns.e2e-customer.tn. hostmaster.e2e-customer.tn. %s 60 60 600 5\n' "$serial"
    printf '@ IN NS ns.e2e-customer.tn.\nns IN A 127.0.0.1\n'
    printf '%s\n' "$@"
  } >"$zone_dir/e2e-customer.tn.db"
}
zone 1
e2e_dns "$dns_port" "$zone_dir"
added="$(http POST "/functions/$url_fn/url/domains" '{"domain": "Shop.E2E-Customer.tn."}')"
check "a domain of the customer's is added, pending, with the CNAME to make: to the URL's host" "201 shop.e2e-customer.tn pending $url_host" \
  "$(status) $(jq -r '"\(.domain) \(.status) \(.records.cname[0].value)"' <<<"$added")"
# verify_until <domain>: checks the domain again until the DNS server has read the new zone, half a minute at most.
verify_until() {
  local _
  for _ in $(seq 1 30); do
    http POST "/functions/$url_fn/url/domains/$1/verify" >/dev/null
    [ "$(jq -r .status "$work/body")" = verified ] && break
    sleep 1
  done
  cat "$work/body"
}
at_domain() { curl -sS -o "$work/url-body" -w '%{http_code}' --resolve "$1:$url_port:127.0.0.1" "http://$1:$url_port${2:-/}"; }
check "before it is proved, the URL doesn't answer there" 404 "$(at_domain shop.e2e-customer.tn)"
zone 2 "shop IN CNAME $url_host."
check "once its CNAME is made, the check proves it" "verified null" "$(verify_until shop.e2e-customer.tn | jq -r '"\(.status) \(.checkError)"')"
check "the URL answers there, and the event names the domain" '200 {"path":"/hello","domain":"shop.e2e-customer.tn"}' \
  "$(at_domain shop.e2e-customer.tn '/hello?name=domain') $(jq -c '{path, domain}' "$work/url-body")"
apex="$(http POST "/functions/$url_fn/url/domains" '{"domain": "e2e-customer.tn"}')"
txt="$(jq -r '.records.txt[] | select(.type == "TXT") | .value' <<<"$apex")"
check "an apex, which can't be a CNAME, gets a TXT record with its token to make, and the edge's address" "201 pending A 127.0.0.1 true" \
  "$(status) $(jq -r .status <<<"$apex") $(jq -r '.records.txt[] | select(.type == "A") | "\(.type) \(.value)"' <<<"$apex") $([[ $txt =~ ^ff-verify=[0-9a-f]{32}$ ]] && echo true || echo false)"
zone 3 "shop IN CNAME $url_host." "_ff-verify IN TXT \"$txt\"" "@ IN A 127.0.0.1"
check "once the TXT record and the address are made, the check proves the apex" verified "$(verify_until e2e-customer.tn | jq -r .status)"
asked() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$url_port/tls/allowed?domain=$1"; }
check "the edge may get certificates for the verified domains, and not for another" "200 200 404" \
  "$(asked shop.e2e-customer.tn) $(asked e2e-customer.tn) $(asked blog.e2e-customer.tn)"
http DELETE "/functions/$url_fn/url/domains/shop.e2e-customer.tn" >/dev/null
check "removed, the domain stops answering at once" "204 404" "$(status) $(at_domain shop.e2e-customer.tn)"
check "the audit log names each change of the domains" "custom_domain.add custom_domain.verify custom_domain.add custom_domain.verify custom_domain.remove" \
  "$(http GET '/audit-log?limit=30' | jq -r --arg r "function:$url_fn" '[.entries[] | select(.resource == $r and (.action | startswith("custom_domain")))] | reverse | map(.action) | join(" ")')"
http PUT "/functions/$url_fn/url" '{"cors": {"allowOrigins": ["https://app.example.tn"], "allowMethods": ["POST"], "maxAge": 60}}' >/dev/null
at_url OPTIONS /orders -H 'origin: https://app.example.tn' -H 'access-control-request-method: POST' >/dev/null
check "with CORS set, the URL answers a browser's preflight itself" "200 204 https://app.example.tn POST 60" \
  "$(status) $(url_status) $(url_header access-control-allow-origin) $(url_header access-control-allow-methods) $(url_header access-control-max-age)"
http PUT "/functions/$url_fn/url" '{"authType": "AWS_IAM"}' >/dev/null
check "a URL that takes the account's credentials refuses a caller without them" '403 403' \
  "$(at_url GET / >/dev/null; url_status) $(at_url GET / -H 'authorization: Bearer ffk_0123456789ab_not-a-real-secret' >/dev/null; url_status)"
http PUT "/functions/$url_fn" '{"eventFormat": "wrapped"}' >/dev/null
check "a function with a URL keeps AWS Lambda's event" 400 "$(status)"
http DELETE "/functions/$url_fn/url" >/dev/null
check "deleting the URL: its address answers 404 at once, and the function has none" "204 404 404" \
  "$(status) $(at_url GET / >/dev/null; url_status) $(http GET "/functions/$url_fn/url" >/dev/null; status)"
http DELETE "/functions/$url_fn" >/dev/null
}
section_def url_domain section_url_domain url budget=10

section_async() {
section "asynchronous calls (ADR 0010)"
async_code='export const handler = async (event: { fail?: boolean }, context: { awsRequestId: string }) => { if (event.fail) throw new Error("asked to fail"); return { got: event, requestId: context.awsRequestId }; };'
async_fn="$(http POST /functions "$(jq -n --arg code "$async_code" '{name: "e2e-async", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
# A request's attempts in the history, the first first; the n-th's end awaited, as the worker claims every second.
attempts_of() { http GET "/functions/$async_fn/invocations?limit=50" | jq -c --arg r "$1" '[.invocations[] | select(.requestId == $r)] | sort_by(.attempt)'; }
attempt_ended() {
  for _ in $(seq 1 30); do
    [ "$(attempts_of "$1" | jq --argjson n "$2" '[.[] | select(.attempt == $n and .status != "RUNNING")] | length')" = 1 ] && return 0
    sleep 1
  done
}
kept_events() { env_q "SELECT count(*) FROM queue_messages WHERE message_id = '$1'"; }
gone_soon() { for _ in $(seq 1 15); do [ "$(kept_events "$1")" = 0 ] && return 0; sleep 1; done; }
# The event put back after its attempt n, which the worker does a moment after the attempt's end.
put_back() { for _ in $(seq 1 50); do [ "$(env_q "SELECT attributes->>'settled' FROM queue_messages WHERE message_id = '$1'")" = "$2" ] && return 0; sleep 0.2; done; }
# How long the event waits after its attempt n ended, by FF's database: the next attempt's time, less the attempt's end.
retry_wait() {
  put_back "$1" "$2"
  env_q "SELECT round(extract(epoch FROM m.visible_at - i.updated_at))::int FROM queue_messages m JOIN function_invocations i ON i.request_id = m.message_id AND i.attempt = $2 WHERE m.message_id = '$1'"
}
queued="$(http POST "/functions/$async_fn/invoke" '{"input": {"order": 7}}' -H 'X-Amz-Invocation-Type: Event' -D "$work/async-headers")"
async_request="$(jq -r .requestId <<<"$queued")"
check "an Event is kept and answered at once: 202 and its request ID, the answer's own" "202 true" \
  "$(status) $(grep -qi "^x-ff-request-id: $async_request" "$work/async-headers" && echo true || echo false)"
attempt_ended "$async_request" 1
gone_soon "$async_request"
check "it runs without anyone waiting, as its first attempt, the function seeing its request ID; it is kept no more" \
  "COMPLETED async 1 true {\"order\":7} $async_request 0" \
  "$(attempts_of "$async_request" | jq -r '.[0] | "\(.status) \(.source) \(.attempt) \(.id == .requestId) \(.output.got | tojson) \(.output.requestId)"') $(kept_events "$async_request")"
http POST "/functions/$async_fn/invoke" '{"input": {}}' -H 'X-Amz-Invocation-Type: DryRun' >/dev/null
check "a DryRun only checks: 204, nothing kept, nothing run" "204 0 1" \
  "$(status) $(env_q "SELECT count(*) FROM queue_messages WHERE function_id = '$async_fn'") $(http GET "/functions/$async_fn/invocations" | jq .total)"
xs 1048576 >"$work/async-big.txt"
jq -n --rawfile big "$work/async-big.txt" '{input: $big}' >"$work/async-big.json"
http POST "/functions/$async_fn/invoke" "" --data-binary @"$work/async-big.json" -H 'X-Amz-Invocation-Type: Event' >/dev/null
check "an Event over AWS Lambda's 1 MB as JSON is refused as Lambda refuses it" "413 RequestEntityTooLargeException" "$(status) $(jq -r .error "$work/body")"
failing="$(http POST "/functions/$async_fn/invoke" '{"input": {"fail": true}, "invocationType": "Event"}' | jq -r .requestId)"
check "an Event named in the body is kept too" 202 "$(status)"
attempt_ended "$failing" 1
first_wait="$(retry_wait "$failing" 1)"
# The rest of its wait cut short, in FF's database, so that the run needn't wait three minutes.
env_q "UPDATE queue_messages SET visible_at = now() WHERE message_id = '$failing'" >/dev/null
attempt_ended "$failing" 2
second_wait="$(retry_wait "$failing" 2)"
env_q "UPDATE queue_messages SET visible_at = now() WHERE message_id = '$failing'" >/dev/null
attempt_ended "$failing" 3
gone_soon "$failing"
check "a failing Event is retried a minute after its first failure, then two minutes after its second, as Lambda retries it" "60 120" "$first_wait $second_wait"
check "then dropped after its third attempt, each attempt in the history under its request ID" "1:ERROR 2:ERROR 3:ERROR 0" \
  "$(attempts_of "$failing" | jq -r '[.[] | "\(.attempt):\(.status)"] | join(" ")') $(kept_events "$failing")"
check "each attempt a call billed on its own" 3 "$(env_q "SELECT count(*) FROM usage_records WHERE request_id = '$failing'")"
aged="$(http POST "/functions/$async_fn/invoke" '{"input": {"fail": true}}' -H 'X-Amz-Invocation-Type: Event' | jq -r .requestId)"
attempt_ended "$aged" 1
put_back "$aged" 1
# Waiting for its retry, it is made six hours and a minute old, past Lambda's maximum age, and due at once.
env_q "UPDATE queue_messages SET sent_at = now() - interval '6 hours 1 minute', visible_at = now() WHERE message_id = '$aged'" >/dev/null
gone_soon "$aged"
check "an Event past its maximum age is dropped at its next claim, without another attempt" "0 1" "$(kept_events "$aged") $(attempts_of "$aged" | jq length)"
records_fn="$(http POST /functions "$(jq -n --arg code "$echo_code" '{name: "e2e-async-records", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
records_arn="arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-async-records"
http GET "/functions/$async_fn/event-invoke-config" >/dev/null
check "a function without settings for its asynchronous calls follows Lambda's defaults, which the 404 says" \
  "404 The function arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-async has no event invoke configuration: its asynchronous calls are retried twice and kept 6 hours, AWS Lambda's defaults" \
  "$(status) $(jq -r .message "$work/body")"
set_config="$(http PUT "/functions/$async_fn/event-invoke-config" "$(jq -cn --arg arn "$records_arn" '{maximumRetryAttempts: 0, destinationConfig: {onSuccess: {destination: $arn}, onFailure: {destination: $arn}}}')")"
check "its own settings, as Lambda's EventInvokeConfig: no retry, and another function as the destination of each call's record" \
  "200 arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-async:\$LATEST 0 null $records_arn $records_arn" \
  "$(status) $(jq -r '"\(.functionArn) \(.maximumRetryAttempts) \(.maximumEventAgeInSeconds) \(.destinationConfig.onSuccess.destination) \(.destinationConfig.onFailure.destination)"' <<<"$set_config")"
# The records come to the destination as asynchronous calls of its own, their event Lambda's record.
record_of() {
  for _ in $(seq 1 30); do
    found="$(http GET "/functions/$records_fn/invocations?limit=20" | jq -c --arg r "$1" '[.invocations[] | select(.status == "COMPLETED" and .input.requestContext.requestId == $r)][0].input // empty')"
    [ -n "$found" ] && echo "$found" && return 0
    sleep 1
  done
}
succeeded="$(http POST "/functions/$async_fn/invoke" '{"input": {"order": 9}}' -H 'X-Amz-Invocation-Type: Event' | jq -r .requestId)"
check "a call that succeeds hands its destination Lambda's record of it: Success, its event, its answer" \
  "Success arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-async:\$LATEST 1 9 9 200" \
  "$(record_of "$succeeded" | jq -r '"\(.requestContext.condition) \(.requestContext.functionArn) \(.requestContext.approximateInvokeCount) \(.requestPayload.order) \(.responsePayload.got.order) \(.responseContext.statusCode)"')"
failed="$(http POST "/functions/$async_fn/invoke" '{"input": {"fail": true}}' -H 'X-Amz-Invocation-Type: Event' | jq -r .requestId)"
check "one that fails, with no retry, hands it at once its record: RetriesExhausted, the function's error" \
  "RetriesExhausted 1 Unhandled Error asked to fail" \
  "$(record_of "$failed" | jq -r '"\(.requestContext.condition) \(.requestContext.approximateInvokeCount) \(.responseContext.functionError) \(.responsePayload.errorType) \(.responsePayload.errorMessage)"')"
check "  ... after its one attempt" 1 "$(attempts_of "$failed" | jq length)"
http DELETE "/functions/$async_fn/event-invoke-config" >/dev/null
check "its settings deleted, it follows Lambda's defaults again" "204 404" "$(status) $(http GET "/functions/$async_fn/event-invoke-config" >/dev/null; status)"
}
section_def async section_async backend budget=45

section_databases() {
section "customers' databases (ADR 0008)"
db_made_at="$(date -u +%s)"
made="$(http POST /databases '{"name": "e2e-orders"}')"
check "a database is made: active, the password and the connection string in the answer, TLS asked" "201 active true true" \
  "$(status) $(jq -r '. as $d | "\($d.status) \($d.connectionString | startswith("postgresql://\($d.user):\($d.password)@")) \($d.connectionString | endswith("?sslmode=require"))"' <<<"$made")"
db_id="$(jq -r .id <<<"$made")"
db_name="$(jq -r .database <<<"$made")"
db_conn="$(jq -r .connectionString <<<"$made")"
check "the string reaches it over TLS, as its own user, the database's owner" "$db_name|$db_name|t" \
  "$(data_db_psql "$db_conn" "select current_user, (select pg_get_userbyid(datdba) from pg_database where datname = current_database()), (select ssl from pg_stat_ssl where pid = pg_backend_pid())")"
data_db_psql "$db_conn" 'create table orders (id int primary key); insert into orders values (1)' >/dev/null
shown="$(http GET "/databases/$db_id")"
check "GET shows its size, its sessions and the plan's limits, never its password" "200 true 10 1024 false false" \
  "$(status) $(jq -r '"\(.sizeBytes > 1000000) \(.connectionLimit) \(.storageLimitMb) \(has("password")) \(has("connectionString"))"' <<<"$shown")"
http POST /databases '{"name": "e2e-second"}' >/dev/null
check "a second database, past the beta plan's one, is refused" "400 The Beta plan allows 1 database, and the account has 1: delete one first" "$(status) $(jq -r .message "$work/body")"
http POST /databases '{"name": "Not_A_Name"}' >/dev/null
check "a name RDS wouldn't take is refused, saying what a name is" "400 name must be 1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases" \
  "$(status) $(jq -r '.message | if type == "array" then join("; ") else . end' "$work/body")"
reset="$(http POST "/databases/$db_id/password")"
new_conn="$(jq -r .connectionString <<<"$reset")"
check "a new password: the old one opens no session, the new one does, the data kept" "200 true 1" \
  "$(status) $( (data_db_psql "$db_conn" 'select 1' || true) | grep 'password authentication failed' >/dev/null && echo true || echo false) $(data_db_psql "$new_conn" 'select count(*) from orders')"
probe='import * as net from "node:net";
import * as tls from "node:tls";
// The server of customers'"'"' databases, as a function reaches it: its port, then TLS after PostgreSQL'"'"'s SSLRequest, its certificate checked.
export async function handler(event: { host: string }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: event.host, port: 5432 });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("error", (error) => resolve(error.message));
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once("data", (answer) => {
      if (answer.toString() !== "S") return resolve("no TLS");
      const secure = tls.connect({ socket, host: event.host });
      secure.once("secureConnect", () => { resolve(secure.authorized ? "trusted" : String(secure.authorizationError)); secure.destroy(); });
      secure.once("error", (error) => resolve(error.message));
    });
  });
}'
probe_fn="$(http POST /functions "$(jq -n --arg code "$probe" '{name: "e2e-data-db-probe", runtime: "nodejs", code: $code, memory: 128, timeout: 10}')" | jq -r .id)"
check "a function reaches it, the account's internet access off, and trusts its certificate" '"trusted"' \
  "$(http POST "/functions/$probe_fn/invoke" "$(jq -cn --arg host "$data_db_address" '{input: {host: $host}}')" | jq -c .output)"
http DELETE "/functions/$probe_fn" >/dev/null
}
section_def databases section_databases backend budget=15

section_caches() {
section "customers' caches (ADR 0013)"
cache_made_at="$(date -u +%s)"
made="$(http POST /caches '{"name": "e2e-sessions"}')"
check "a cache is made: active, Valkey, the plan's 64 MB, its address with its password in the answer, TLS asked" "201 active Valkey 9.1 64 true true" \
  "$(status) $(jq -r '. as $c | "\($c.status) \($c.engine) \($c.memoryMb) \($c.url == "rediss://default:\($c.password)@\($c.host):\($c.port)") \($c.address == "rediss://default@\($c.host):\($c.port)")"' <<<"$made")"
cache_url="$(jq -r .url <<<"$made")"
cache_server_name="$(env_q "SELECT server_name FROM caches WHERE name = 'e2e-sessions'")"
check "the address reaches it over TLS, the server's certificate checked, as the customer's user" "OK two croissants default" \
  "$(cache_cli "$cache_url" SET cart:42 'two croissants') $(cache_cli "$cache_url" GET cart:42) $(cache_cli "$cache_url" ACL WHOAMI)"
memory="$(cache_cli "$cache_url" INFO memory | tr -d '\r')"
check "its memory the plan's, the least recently used keys going past it; the server's settings none of the customer's" "67108864 allkeys-lru true" \
  "$(sed -n 's/^maxmemory://p' <<<"$memory") $(sed -n 's/^maxmemory_policy://p' <<<"$memory") $(cache_cli "$cache_url" CONFIG SET maxmemory 1gb | grep NOPERM >/dev/null && echo true || echo false)"
check "its process runs as a user of its own, never root" true \
  "$([ "$(docker exec "$e2e_cache_container" sh -c 'for p in $(pgrep valkey-server); do stat -c %u /proc/$p; done')" -gt 20000 ] && echo true || echo false)"
shown="$(http GET /caches/e2e-sessions)"
check "GET shows the memory its keys use and its connections, never its password" "200 true true false false" \
  "$(status) $(jq -r '"\(.bytesUsedForCache > 0) \(.currConnections | type == "number") \(has("password")) \(has("url"))"' <<<"$shown")"
http POST /caches '{"name": "e2e-second"}' >/dev/null
check "a second cache, past the beta plan's one, is refused" "400 The Beta plan allows 1 cache, and the account has 1: delete one first" "$(status) $(jq -r .message "$work/body")"
http POST /caches '{"name": "Not_A_Name"}' >/dev/null
check "a name ElastiCache wouldn't take is refused, saying what a name is" "400 name must be 1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters" \
  "$(status) $(jq -r '.message | if type == "array" then join("; ") else . end' "$work/body")"
reset="$(http POST /caches/e2e-sessions/password)"
new_cache_url="$(jq -r .url <<<"$reset")"
check "a new password: the old one refused, the new one logs in, the keys kept" "200 true two croissants" \
  "$(status) $(cache_cli "$cache_url" PING | grep WRONGPASS >/dev/null && echo true || echo false) $(cache_cli "$new_cache_url" GET cart:42)"
probe='import * as tls from "node:tls";
// The server of customers'"'"' caches, as a function reaches it: TLS to the cache'"'"'s port, its certificate checked, then AUTH and GET.
export async function handler(event: { url: string }) {
  const { hostname, port, password } = new URL(event.url);
  const secret = decodeURIComponent(password);
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: Number(port) });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("error", (error) => resolve(error.message));
    socket.once("secureConnect", () => {
      if (!socket.authorized) { resolve(String(socket.authorizationError)); socket.destroy(); return; }
      socket.write(`*3\r\n$4\r\nAUTH\r\n$7\r\ndefault\r\n$${secret.length}\r\n${secret}\r\n*2\r\n$3\r\nGET\r\n$7\r\ncart:42\r\n`);
    });
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      const got = /^\+OK\r\n\$\d+\r\n(.*)\r\n$/s.exec(answer);
      if (got) { resolve(`trusted, logged in: ${got[1]}`); socket.destroy(); }
      else if (answer.startsWith("-")) { resolve(answer.trim()); socket.destroy(); }
    });
  });
}'
probe_fn="$(http POST /functions "$(jq -n --arg code "$probe" '{name: "e2e-cache-probe", runtime: "nodejs", code: $code, memory: 128, timeout: 10}')" | jq -r .id)"
check "a function reaches it, the account's internet access off, trusts its certificate and logs in with the address" '"trusted, logged in: two croissants"' \
  "$(http POST "/functions/$probe_fn/invoke" "$(jq -cn --arg url "$new_cache_url" '{input: {url: $url}}')" | jq -c .output)"
http DELETE "/functions/$probe_fn" >/dev/null
}
section_def caches section_caches backend budget=15

section_schedules_ran() {
section "a function on a schedule: its runs, once their minute has passed in the sections before"
# Each schedule runs every minute, so by now once or more: those of the minute after their making are checked, which
# the scheduler's tick, every 5 s, runs within about 70 s; the next come a minute later, past 100 s.
first_minute='[.invocations[] | select(.source == "schedule" and ((.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdate) - $made) < 100)]'
# Run alone, it comes before them, and waits as long as before.
for _ in $(seq 1 30); do
  [ "$(http GET "/functions/$sched_fn/invocations?limit=100" | jq --argjson made "$made_at" "$first_minute | length")" -ge 2 ] && break
  sleep 5
done
# settled_schedules <function>: its schedules, once none says its run is still running, the next a minute away.
settled_schedules() {
  local answer=''
  for _ in $(seq 1 30); do
    answer="$(http GET "/functions/$1/schedules")"
    jq -e 'any(.[]; .lastOutcome == "running")' <<<"$answer" >/dev/null || break
    sleep 1
  done
  echo "$answer"
}
# The schedules before the history, so that the history has the call each names.
schedules="$(settled_schedules "$sched_fn")"
history="$(http GET "/functions/$sched_fn/invocations?limit=100")"
first_calls="$(jq -c --argjson made "$made_at" "$first_minute" <<<"$history")"
event="$(jq -c '[.[] | select(.input["detail-type"] != null)][0].input' <<<"$first_calls")"
check "each schedule ran within a minute and a few seconds, as calls of its schedule" 2 "$(jq length <<<"$first_calls")"
check "with EventBridge's Scheduled Event: its source, its account, FF's region, the rule's ARN" \
  "Scheduled Event aws.events $tenant tn-tunis-1 arn:aws:events:tn-tunis-1:$tenant:rule/e2e-scheduled-every-minute true" \
  "$(jq -r '"\(.["detail-type"]) \(.source) \(.account) \(.region) \(.resources[0]) \(.time | test("^[0-9-]{10}T[0-9:]{8}Z$"))"' <<<"$event")"
check "or the schedule's own input" '{"report":"daily"}' "$(jq -c '[.[] | select(.input.report != null)][0].input' <<<"$first_calls")"
check "each schedule says how its run went, and which call it was; the disabled one never ran" \
  "every-minute success true off null with-input success" \
  "$(jq -r --argjson h "$history" '[.[] | "\(.name) \(.lastOutcome // "null")\(if .name == "every-minute" then " \(.lastRequestId as $id | [$h.invocations[].id] | index($id) != null)" else "" end)"] | join(" ")' <<<"$schedules")"
first_ids="$(jq -r '.[].requestId' <<<"$first_calls" | sed "s/.*/'&'/" | paste -sd,)"
check "the usage records bill them as calls" 2 "$(env_q "SELECT count(*) FROM usage_records WHERE function_id = '$sched_fn' AND request_id IN (${first_ids:-NULL})")"
# run_attempts <request>: the attempts of the failing schedule's run whose request ID is given, ended, the first first.
run_attempts() {
  http GET "/functions/$failing_sched_fn/invocations?limit=100" |
    jq -r --arg r "$1" '[.invocations[] | select(.status != "RUNNING" and .requestId == $r)] | sort_by(.attempt) | map("\(.source):\(.attempt):\(.status)") | join(" ")'
}
# Its first run, and the retry of it a minute after its failure, as an asynchronous call's; run alone, both waited for.
first_run=''
for _ in $(seq 1 150); do
  first_run="$(env_q "SELECT request_id FROM function_invocations WHERE function_id = '$failing_sched_fn' AND attempt = 1 ORDER BY created_at LIMIT 1")"
  [[ -n "$first_run" && "$(run_attempts "$first_run")" == *":2:"* ]] && break
  sleep 1
done
check "a run that fails is the schedule's call, its outcome on the schedule" "schedule:1:ERROR error" \
  "$(run_attempts "$first_run" | cut -d' ' -f1) $(settled_schedules "$failing_sched_fn" | jq -r '.[0].lastOutcome')"
# The retry's wait: its start, less the failure's end. The worker claims what has come due at its next pass, every 5 s
# (FF_ASYNC_INTERVAL_SECONDS), so a retry due a minute after its failure starts within 65 s of it, and its attempt a
# moment after.
retry_wait="$(env_q "SELECT extract(epoch FROM r.created_at - f.updated_at) FROM function_invocations f JOIN function_invocations r ON r.request_id = f.request_id AND r.attempt = 2 WHERE f.request_id = '$first_run' AND f.attempt = 1")"
check "  ... retried as an asynchronous call is, a minute after its failure, under the run's request ID" "a minute schedule:1:ERROR schedule:2:ERROR" \
  "$(awk -v s="${retry_wait:-0}" 'BEGIN { print (s >= 59.5 && s < 70) ? "a minute" : s " s" }') $(run_attempts "$first_run" | cut -d' ' -f1,2)"
http DELETE "/functions/$failing_sched_fn" >/dev/null
http DELETE "/functions/$sched_fn" >/dev/null
check "deleting the function deletes its schedules" 0 "$(env_q "SELECT count(*) FROM schedules WHERE function_id = '$sched_fn'")"
}
section_def schedules_ran section_schedules_ran schedules budget=5

section_keys() {
section "keys and clients: the other account's access key, and AWS's clients at the versions ADR 0009 measured"
# The other account's own key, which the sections after it try on what this account owns, and the reverse.
other_key="$(as_other POST /storage-keys '{}')"

# The clients, pinned to the versions ADR 0009 measured: npm and pip fetch them once, into hack/.cache.
clients="$FF_REPO_ROOT/hack/.cache/s3-clients"
if [ ! -d "$clients/node_modules/@aws-sdk/lib-storage" ]; then
  npm install --prefix "$clients" --no-audit --no-fund --silent @aws-sdk/client-s3@3.1156.0 @aws-sdk/s3-request-presigner@3.1156.0 @aws-sdk/lib-storage@3.1156.0 >/dev/null
fi
if [ ! -x "$clients/venv/bin/python" ]; then
  python3 -m venv "$clients/venv"
  "$clients/venv/bin/pip" install --quiet --disable-pip-version-check boto3==1.43.118
fi
if [ ! -d "$clients/python/boto3" ]; then
  "$clients/venv/bin/pip" install --quiet --disable-pip-version-check --target "$clients/python" boto3==1.43.118
fi
}
section_def keys section_keys backend budget=20

section_buckets() {
section "customers' buckets (ADR 0009): the API, then AWS's own clients through the S3 front door"
made="$(http POST /buckets '{"name": "e2e-photos"}')"
check "a bucket is made: its endpoint, its own address, FF's region" "201 e2e-photos active $s3_endpoint http://e2e-photos.s3.localhost:$storage_port tn-tunis-1" \
  "$(status) $(jq -r '"\(.name) \(.status) \(.endpoint) \(.url) \(.region)"' <<<"$made")"
store_name="$(env_q "SELECT store_name FROM buckets WHERE name = 'e2e-photos'")"
photos_id="$(env_q "SELECT id FROM buckets WHERE name = 'e2e-photos'")"
# The store itself, with FF's own credentials: what it really keeps.
store_s3() { AWS_ACCESS_KEY_ID=ffdevaccesskey AWS_SECRET_ACCESS_KEY=ffdevsecretkey-local-only AWS_DEFAULT_REGION=us-east-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  "${aws_cli[@]}" --endpoint-url "http://127.0.0.1:$FF_S3_PORT" "$@"; }
# held <command…>: whether the store has the bucket, as head-bucket answers.
held() { "$@" >/dev/null 2>&1 && echo held || echo gone; }
check "the store has it, under a name of FF's that says nothing of whose it is" "true held" \
  "$([[ "$store_name" =~ ^ff-[0-9a-f]{24}$ ]] && echo true || echo false) $(held store_s3 s3api head-bucket --bucket "$store_name")"
as_other POST /buckets '{"name": "e2e-theirs"}' >/dev/null
http POST /buckets '{"name": "e2e-theirs"}' >/dev/null
check "a name is FF's once, whoever asks, as on AWS" "409 The bucket name \"e2e-theirs\" is taken: bucket names are unique across FF, as on AWS" "$(status) $(jq -r .message "$work/body")"
http POST /buckets '{"name": "My.Photos"}' >/dev/null
check "a name AWS wouldn't take, or that has a dot, is refused, saying why" "400 true" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body" | grep 'is not a bucket name: 3 to 63 lower-case letters' >/dev/null && echo true || echo false)"
for n in 2 3 4 5; do http POST /buckets "{\"name\": \"e2e-more-$n\"}" >/dev/null; done
http POST /buckets '{"name": "e2e-sixth"}' >/dev/null
check "past the beta plan's five buckets, refused" "400 The Beta plan allows 5 buckets, and the account has 5: delete one first" "$(status) $(jq -r .message "$work/body")"
for n in 2 3 4 5; do http DELETE "/buckets/e2e-more-$n" >/dev/null; done
check "an empty bucket deleted, 204, then 404; the list the account's own" "204 404 e2e-photos" \
  "$(status) $(http GET /buckets/e2e-more-5 >/dev/null; status) $(http GET /buckets | jq -r 'map(.name) | join(",")')"
key="$(http POST /storage-keys '{}')"
check "an access key: its ID, its secret this once, the endpoint and the region" "201 true true $s3_endpoint tn-tunis-1" \
  "$(status) $(jq -r '"\(.id | test("^AKFF[A-Z2-7]{16}$")) \(.secretAccessKey | test("^[A-Za-z0-9+/]{40}$")) \(.endpoint) \(.region)"' <<<"$key")"
key_id="$(jq -r .id <<<"$key")"
key_secret="$(jq -r .secretAccessKey <<<"$key")"
read_only="$(http POST /storage-keys '{"readOnly": true, "buckets": ["e2e-photos"]}')"
ro_id="$(jq -r .id <<<"$read_only")"
ro_secret="$(jq -r .secretAccessKey <<<"$read_only")"
http POST /storage-keys '{}' >/dev/null
check "two keys at most, as IAM gives a user; listed without their secrets" "409 2 false" \
  "$(status) $(http GET /storage-keys | jq -r 'length, (map(has("secretAccessKey")) | any)' | xargs)"
check "the secret is sealed in FF's database, never in clear" "0" \
  "$(env_q "SELECT count(*) FROM storage_keys WHERE secret::text LIKE '%' || '$key_secret' || '%'")"

# The plan's storage, an account's buckets together: the other account on a plan of 1 MB, its bucket holding 1.2 MB once
# a new bucket of its own has it measured, within a minute. Uploads wait for room; reads and deletes go on. Started
# here, so that its minute passes while AWS's clients run below; their key is this account's, which isn't full.
as_other_s3() { AWS_KEY="$(jq -r .id <<<"$other_key")" AWS_SECRET="$(jq -r .secretAccessKey <<<"$other_key")" "$@"; }
head -c 600000 /dev/urandom >"$work/part.bin"
as_other_s3 aws_ff s3 cp "$work/part.bin" s3://e2e-theirs/one.bin --only-show-errors
as_other_s3 aws_ff s3 cp "$work/part.bin" s3://e2e-theirs/two.bin --only-show-errors
sql "INSERT INTO plans (id, name, limits) SELECT 'e2e-files', 'E2E files', limits || '{\"bucketStorageMb\": 1}' FROM plans WHERE id = 'beta'"
sql "UPDATE accounts SET plan_id = 'e2e-files' WHERE id = '$other'"
storage_notice() { env_q "SELECT coalesce(bucket_storage_notice, 0) FROM accounts WHERE id = '$other'"; }
as_other POST /buckets '{"name": "e2e-theirs-more"}' >/dev/null
# An alarm on its 4xx errors, as CloudWatch's on S3's metrics, judging its last three minutes: a file it hasn't, asked
# for, judged once the clients below have run, its minute passing meanwhile.
bucket_alarm="$(http POST /alarms '{"name": "e2e-photos 4xx", "bucketName": "e2e-photos", "metric": "4xxErrors", "statistic": "Sum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 3, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' | jq -r .id)"
aws_ff s3 cp s3://e2e-photos/no-such-file.txt "$work/none" --only-show-errors 2>/dev/null || true

head -c $((100 * 1024 * 1024)) /dev/urandom >"$work/big.bin"
MODULES="$clients/node_modules" ENDPOINT="$s3_endpoint" IP_ENDPOINT="http://127.0.0.1:$storage_port" KEY="$key_id" SECRET="$key_secret" \
  BUCKET=e2e-photos OTHER_BUCKET=e2e-theirs BIG="$work/big.bin" node "$FF_REPO_ROOT/hack/lib/s3-clients/sdk.mjs" >"$work/sdk.jsonl" 2>"$work/sdk.log" || true
client_checks "$work/sdk.jsonl" 14
ENDPOINT="$s3_endpoint" KEY="$key_id" SECRET="$key_secret" BUCKET=e2e-photos OTHER_BUCKET=e2e-theirs BIG="$work/big.bin" \
  "$clients/venv/bin/python" "$FF_REPO_ROOT/hack/lib/s3-clients/boto3_checks.py" >"$work/boto3.jsonl" 2>"$work/boto3.log" || true
client_checks "$work/boto3.jsonl" 11
aws_ff s3 cp "$work/big.bin" s3://e2e-photos/cli/big.bin --only-show-errors
aws_ff s3 cp s3://e2e-photos/cli/big.bin "$work/big.out" --only-show-errors
check "aws: 100 MB up in parts and down again, byte for byte" "104857600 0" \
  "$(aws_ff s3api head-object --bucket e2e-photos --key cli/big.bin --query ContentLength --output text) $(cmp -s "$work/big.bin" "$work/big.out"; echo $?)"
aws_ff s3api get-object --bucket e2e-photos --key cli/big.bin --range bytes=0-9 "$work/range.out" >/dev/null
check "aws: a range" "$(head -c 10 "$work/big.bin" | od -An -tx1 | tr -d ' \n')" "$(od -An -tx1 "$work/range.out" | tr -d ' \n')"
rm -rf "$work/site" "$work/site-back"
mkdir -p "$work/site/css" "$work/site-back"
printf '<h1>Ahlan</h1>' >"$work/site/index.html"
printf 'body {}' >"$work/site/css/main.css"
aws_ff s3 sync "$work/site" s3://e2e-photos/site --only-show-errors
aws_ff s3 sync s3://e2e-photos/site "$work/site-back" --only-show-errors
check "aws: a folder synced up, listed, and down again, the same" "2 0" \
  "$(aws_ff s3 ls s3://e2e-photos/site/ --recursive | wc -l | tr -d ' ') $(diff -r "$work/site" "$work/site-back" >/dev/null; echo $?)"
presigned="$(aws_ff s3 presign s3://e2e-photos/site/index.html --expires-in 300)"
expiring="$(aws_ff s3 presign s3://e2e-photos/site/index.html --expires-in 1)"
sleep 2
check "aws: a presigned URL, fetched; one past its expiry, AccessDenied" "<h1>Ahlan</h1> 403 AccessDenied" \
  "$(curl -s "$presigned") $(curl -s -o "$work/expired" -w '%{http_code}' "$expiring") $(grep -o '<Code>[^<]*' "$work/expired" | cut -c7-)"
check "aws: a wrong secret, SignatureDoesNotMatch" "refused SignatureDoesNotMatch" "$(AWS_SECRET=wrong-secret outcome aws_ff s3 ls s3://e2e-photos)"
check "aws: another account's bucket, AccessDenied" "refused AccessDenied" "$(outcome aws_ff s3 ls s3://e2e-theirs)"
check "a read-only key lists, and writes nothing: AccessDenied" "accepted refused AccessDenied" \
  "$(AWS_KEY="$ro_id" AWS_SECRET="$ro_secret" outcome aws_ff s3 ls s3://e2e-photos/site/) $(AWS_KEY="$ro_id" AWS_SECRET="$ro_secret" outcome aws_ff s3 cp "$work/site/index.html" s3://e2e-photos/site/new.html)"
http DELETE "/storage-keys/$ro_id" >/dev/null
check "a revoked key opens nothing at once: InvalidAccessKeyId" "204 refused InvalidAccessKeyId" "$(status) $(AWS_KEY="$ro_id" AWS_SECRET="$ro_secret" outcome aws_ff s3 ls s3://e2e-photos)"
# The other account's buckets, measured full while the clients ran; run alone, waited for, as long as before.
for _ in $(seq 75); do [ "$(storage_notice)" = 100 ] && break; sleep 1; done
full="$(as_other_s3 aws_ff s3 cp "$work/part.bin" s3://e2e-theirs/three.bin 2>&1 >/dev/null || true)"
check "its buckets past the plan's storage together: an upload waits for room, AccountProblem saying why" "100 true true" \
  "$(storage_notice) $(grep -q AccountProblem <<<"$full" && echo true || echo false) $(grep -q 'its buckets hold the 1 MB its E2E files plan gives them' <<<"$full" && echo true || echo false)"
check "  ... a read and a delete go on" "accepted accepted" \
  "$(as_other_s3 outcome aws_ff s3 cp s3://e2e-theirs/one.bin "$work/one.out") $(as_other_s3 outcome aws_ff s3 rm s3://e2e-theirs/two.bin)"
# Room made: the next minute's measure lets its uploads in again, read in buckets_room, the queues' section on.
for _ in $(seq 150); do [ "$(http GET "/alarms/$bucket_alarm" | jq -r .state)" = ALARM ] && break; sleep 1; done
check "an alarm on its 4xx errors fires once the minute is counted, naming the bucket" "ALARM e2e-photos true" \
  "$(http GET "/alarms/$bucket_alarm" | jq -r '"\(.state) \(.bucketName) \(.stateReason | test("breaching 4xxErrors Sum > 0"))"')"
# Functions as on AWS Lambda with a role: AWS's SDK for JavaScript v3 and boto3 with no setting at all, in packages as
# npm and pip install them. FF gives the pods a key of the function's own, the region and the front door's address.
package_with "$work/s3-node.zip" "$clients/node_modules" node_modules "index.mjs=$FF_REPO_ROOT/hack/lib/s3-clients/functions/index.mjs"
package_with "$work/s3-python.zip" "$clients/python" '' "function.py=$FF_REPO_ROOT/hack/lib/s3-clients/functions/function.py"
upload "$work/s3-node.zip" >/dev/null
upload "$work/s3-python.zip" >/dev/null
node_s3="$(http POST /functions "$(jq -n --arg sha "$(sha256_of "$work/s3-node.zip")" '{name: "e2e-s3-node", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 256, timeout: 20}')" | jq -r .id)"
python_s3="$(http POST /functions "$(jq -n --arg sha "$(sha256_of "$work/s3-python.zip")" '{name: "e2e-s3-python", runtime: "python", codeSha256: $sha, handler: "function.handler", memory: 256, timeout: 20}')" | jq -r .id)"
s3_input='{"input": {"bucket": "e2e-photos", "other": "e2e-theirs"}}'
check "a Node.js function, new S3Client({}) as on Lambda: writes to its account's bucket and reads it back; another account's, AccessDenied" \
  '{"read":"written by a Node.js function","other":"AccessDenied"}' "$(http POST "/functions/$node_s3/invoke" "$s3_input" | jq -c .output)"
check "a Python function, boto3.client(\"s3\") as on Lambda: the same" \
  '{"read":"written by a Python function","other":"AccessDenied"}' "$(http POST "/functions/$python_s3/invoke" "$s3_input" | jq -c .output)"
check "what they wrote is in the bucket, as the account's own key reads it" "written by a Node.js function|written by a Python function" \
  "$(aws_ff s3 cp s3://e2e-photos/from-node.txt - 2>/dev/null)|$(aws_ff s3 cp s3://e2e-photos/from-python.txt - 2>/dev/null)"
fn_key="$(function_secret "$node_s3" AWS_ACCESS_KEY_ID)"
fn_secret="$(function_secret "$node_s3" AWS_SECRET_ACCESS_KEY)"
check "its pods get a key of its own, the region and the front door's address inside the cluster, through the Secret; the Deployment holds none" \
  "true tn-tunis-1 tn-tunis-1 http://$cluster_gateway:$storage_port $fn_key 0" \
  "$([[ "$fn_key" =~ ^AKFF[A-Z2-7]{16}$ ]] && echo true || echo false) $(function_secret "$node_s3" AWS_REGION) $(function_secret "$node_s3" AWS_DEFAULT_REGION) $(function_secret "$node_s3" AWS_ENDPOINT_URL_S3) \
$(env_q "SELECT id FROM storage_keys WHERE function_id = '$node_s3' AND revoked_at IS NULL") $(kubectl -n "$tenant_ns" get deployment "fn-$node_s3" -o json | grep -c -- "$fn_secret")"
check "a function's key is its own: not among the account's, which has one left, and sealed" "1 0" \
  "$(http GET /storage-keys | jq length) $(env_q "SELECT count(*) FROM storage_keys WHERE secret::text LIKE '%' || '$fn_secret' || '%'")"
http PUT "/functions/$node_s3" '{"timeout": 25}' >/dev/null
check "a new version keeps it: one key a function, and the new pods have it" "200 1 $fn_key" \
  "$(status) $(env_q "SELECT count(*) FROM storage_keys WHERE function_id = '$node_s3'") $(function_secret "$node_s3" AWS_ACCESS_KEY_ID)"
http PUT "/functions/$python_s3" '{"environment": {"AWS_ENDPOINT_URL_S3": "https://s3.amazonaws.com"}}' >/dev/null
check "a function can't point it elsewhere: AWS_ENDPOINT_URL_S3 is FF's" "400 AWS_ENDPOINT_URL_S3 is reserved: FF sets it, with the function's own key to its account's buckets" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
http DELETE "/functions/$node_s3" >/dev/null
check "a function deleted: its key revoked with it, and refused at once, InvalidAccessKeyId" "200 t refused InvalidAccessKeyId" \
  "$(status) $(env_q "SELECT revoked_at IS NOT NULL FROM storage_keys WHERE function_id = '$node_s3'") $(AWS_KEY="$fn_key" AWS_SECRET="$fn_secret" outcome aws_ff s3 ls s3://e2e-photos)"
http DELETE "/functions/$python_s3" >/dev/null
sql "UPDATE accounts SET status = 'suspended' WHERE id = '$tenant'"
suspended="$(aws_ff s3 ls s3://e2e-photos 2>&1 >/dev/null || true)"
sql "UPDATE accounts SET status = 'active', storage_disabled_at = now(), storage_disabled_reason = 'E2E check' WHERE id = '$tenant'"
storage_off="$(aws_ff s3 ls s3://e2e-photos 2>&1 >/dev/null || true)"
sql "UPDATE accounts SET storage_disabled_at = NULL, storage_disabled_reason = NULL WHERE id = '$tenant'"
check "a suspended account's keys, and those of an account whose storage FF turned off, AccountProblem, saying why" "true true true" \
  "$(grep -q AccountProblem <<<"$suspended" && echo true || echo false) $(grep -q AccountProblem <<<"$storage_off" && echo true || echo false) $(grep -q 'E2E check' <<<"$storage_off" && echo true || echo false)"
# Each minute, the buckets not measured yet in the hour are: this one within a minute, whatever its files.
for _ in $(seq 75); do [ "$(env_q "SELECT count(*) FROM bucket_samples WHERE bucket_id = '$photos_id' AND hour = date_trunc('hour', now())")" = 1 ] && break; sleep 1; done
check "its hourly measure, within a minute: once in the hour, by its name" "1|e2e-photos" \
  "$(env_q "SELECT count(*), max(name) FROM bucket_samples WHERE bucket_id = '$photos_id' AND hour = date_trunc('hour', now())")"
# Each minute, the front door writes the minutes that are over: these within two.
for _ in $(seq 150); do
  [ "$(env_q "SELECT count(DISTINCT class) FROM storage_request_counts WHERE name = 'e2e-photos'")" = 3 ] && break
  sleep 1
done
check "the requests counted by the minute, in AWS's three classes, with their bytes, the 300 MB up and down among them" "3 true true true" \
  "$(env_q "SELECT count(DISTINCT class) || ' ' || (sum(bytes_in) > 314572800) || ' ' || (sum(bytes_out) > 314572800) || ' ' || (sum(errors4xx) > 0) FROM storage_request_counts WHERE name = 'e2e-photos'" | tr -d '\r')"
# Its metrics, as CloudWatch names S3's: this hour and the one before, a point an hour. The minute of its last requests
# may be written between the two reads: both read again until they agree, which a minute's writing settles.
since="$(date -u -d '-1 hour' +%Y-%m-%dT%H:00:00Z)"
for _ in $(seq 75); do
  photos_metrics="$(http GET "/buckets/e2e-photos/metrics?period=3600&start=$since")"
  photos_metered="$(jq -r '"\([.metrics.AllRequests.Sum[]] | add) \([.metrics."4xxErrors".Sum[]] | add) \([.metrics.BytesUploaded.Sum[]] | add) \(.metrics.BucketSizeBytes.Average[-1])"' <<<"$photos_metrics")"
  photos_counted="$(env_q "SELECT sum(requests) || ' ' || sum(errors4xx) || ' ' || sum(bytes_in) FROM storage_request_counts WHERE bucket_id = '$photos_id' AND minute >= '$since'" | tr -d '\r') $(env_q "SELECT size_bytes FROM bucket_samples WHERE bucket_id = '$photos_id' AND hour = date_trunc('hour', now())")"
  [ "$photos_metered" = "$photos_counted" ] && break
  sleep 1
done
check "its metrics, as CloudWatch names S3's: its requests and their bytes as counted, what it holds as its hour's measure" \
  "200 $photos_counted" "$(status) $photos_metered"
http DELETE /buckets/e2e-photos >/dev/null
check "a bucket with files isn't deleted unless asked to empty it" "409 The bucket e2e-photos isn't empty: delete its objects first, or delete it with ?force=true, which deletes them all" \
  "$(status) $(jq -r .message "$work/body")"
http DELETE "/buckets/e2e-photos?force=true" >/dev/null
check "  ... which deletes its files, then the bucket, gone from the store too, and its alarm with it" "204 404 gone 404" \
  "$(status) $(http GET /buckets/e2e-photos >/dev/null; status) $(held store_s3 s3api head-bucket --bucket "$store_name") $(http GET "/alarms/$bucket_alarm" >/dev/null; status)"
http DELETE "/storage-keys/$key_id" >/dev/null
}
section_def buckets section_buckets keys budget=175

section_queues() {
section "customers' queues (ADR 0010): AWS's own clients through the SQS endpoint, then functions with no setting"
sqs_endpoint="http://localhost:$sqs_port"
queue_key="$(http POST /storage-keys '{}')"
queue_key_id="$(jq -r .id <<<"$queue_key")"
queue_key_secret="$(jq -r .secretAccessKey <<<"$queue_key")"
# The AWS CLI, its endpoint from AWS_ENDPOINT_URL_SQS alone, as a function's environment gives it, and no setting of
# this machine's; as the other account with AWS_KEY and AWS_SECRET.
aws_sqs() { AWS_ACCESS_KEY_ID="${AWS_KEY:-$queue_key_id}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET:-$queue_key_secret}" AWS_DEFAULT_REGION=tn-tunis-1 \
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_ENDPOINT_URL_SQS="$sqs_endpoint" "${aws_cli[@]}" sqs "$@"; }
as_other_sqs() { AWS_KEY="$(jq -r .id <<<"$other_key")" AWS_SECRET="$(jq -r .secretAccessKey <<<"$other_key")" "$@"; }
check "the AWS CLI makes a queue, its URL under the endpoint and the account" "$sqs_endpoint/$tenant/e2e-cli-orders" \
  "$(aws_sqs create-queue --queue-name e2e-cli-orders --query QueueUrl --output text)"
cli_url="$sqs_endpoint/$tenant/e2e-cli-orders"
aws_sqs send-message --queue-url "$cli_url" --message-body 'Ahlan from the CLI' \
  --message-attributes '{"source": {"DataType": "String", "StringValue": "aws-cli"}}' >/dev/null
aws_sqs receive-message --queue-url "$cli_url" --wait-time-seconds 2 --message-attribute-names All >"$work/received.json"
check "  ... sends a message with an attribute, receives it back, and deletes it" "Ahlan from the CLI aws-cli 0" \
  "$(jq -r '.Messages[0] | "\(.Body) \(.MessageAttributes.source.StringValue)"' "$work/received.json") \
$(aws_sqs delete-message --queue-url "$cli_url" --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' "$work/received.json")" >/dev/null; \
aws_sqs get-queue-attributes --queue-url "$cli_url" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
# outcome_sqs <command…>: accepted, or refused with the error's query code, as the CLI prints it.
outcome_sqs() { "$@" >/dev/null 2>"$work/aws.err" && echo accepted || echo "refused $(grep -oE '\((AWS\.SimpleQueueService\.[A-Za-z]+|SignatureDoesNotMatch|InvalidClientTokenId|AccessDenied|OverLimit|RequestThrottled)\)' "$work/aws.err" | head -1 | tr -d '()')"; }
check "  ... a queue that isn't there, by its query code" "refused AWS.SimpleQueueService.NonExistentQueue" "$(outcome_sqs aws_sqs get-queue-url --queue-name nowhere)"
other_url="$(as_other_sqs aws_sqs create-queue --queue-name e2e-cli-orders --query QueueUrl --output text)"
check "another account's queue of the same name is its own: its URL under its account, which this account's key doesn't find" \
  "$sqs_endpoint/$other/e2e-cli-orders refused AWS.SimpleQueueService.NonExistentQueue" \
  "$other_url $(outcome_sqs aws_sqs send-message --queue-url "$other_url" --message-body 'not mine')"
check "  ... nor lists" "$cli_url" "$(aws_sqs list-queues --query 'QueueUrls' --output text)"
# AWS's SDK for JavaScript v3, pinned to the version ADR 0010 measured, fetched once into hack/.cache; boto3 from the
# buckets' clients.
sqs_clients="$FF_REPO_ROOT/hack/.cache/sqs-clients"
if [ ! -d "$sqs_clients/node_modules/@aws-sdk/client-sqs" ]; then
  npm install --prefix "$sqs_clients" --no-audit --no-fund --silent @aws-sdk/client-sqs@3.1156.0 >/dev/null
fi
MODULES="$sqs_clients/node_modules" ENDPOINT="$sqs_endpoint" ACCOUNT="$tenant" KEY="$queue_key_id" SECRET="$queue_key_secret" OTHER_URL="$other_url" \
  node "$FF_REPO_ROOT/hack/lib/sqs-clients/sdk.mjs" >"$work/sqs-sdk.jsonl" 2>"$work/sqs-sdk.log" || true
client_checks "$work/sqs-sdk.jsonl" 13
ENDPOINT="$sqs_endpoint" ACCOUNT="$tenant" KEY="$queue_key_id" SECRET="$queue_key_secret" OTHER_URL="$other_url" \
  "$clients/venv/bin/python" "$FF_REPO_ROOT/hack/lib/sqs-clients/boto3_checks.py" >"$work/sqs-boto3.jsonl" 2>"$work/sqs-boto3.log" || true
client_checks "$work/sqs-boto3.jsonl" 8
# Two messages left waiting in a queue, and an alarm on them, as a dead-letter queue is watched: judged at the end of
# the queues' sections, by when a minute has sampled them.
aws_sqs create-queue --queue-name e2e-waiting >/dev/null
for body in one two; do aws_sqs send-message --queue-url "$sqs_endpoint/$tenant/e2e-waiting" --message-body "$body" >/dev/null; done
waiting_alarm="$(http POST /alarms '{"name": "e2e-waiting", "queueName": "e2e-waiting", "metric": "ApproximateNumberOfMessagesVisible", "statistic": "Maximum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 1, "evaluationPeriods": 3, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' | jq -r .id)"
check "an alarm on a queue's messages, naming the queue as CloudWatch's QueueName" "201 e2e-waiting" "$(status) $(http GET "/alarms/$waiting_alarm" | jq -r .queueName)"
# Functions as on AWS Lambda with a role: AWS's SDK for JavaScript v3 and boto3 with no setting at all, in packages
# as npm and pip install them; FF gives their pods the function's own key, the region and the endpoint.
aws_sqs create-queue --queue-name e2e-fn-orders >/dev/null
package_with "$work/sqs-node.zip" "$sqs_clients/node_modules" node_modules "index.mjs=$FF_REPO_ROOT/hack/lib/sqs-clients/functions/index.mjs"
package_with "$work/sqs-python.zip" "$clients/python" '' "function.py=$FF_REPO_ROOT/hack/lib/sqs-clients/functions/function.py"
upload "$work/sqs-node.zip" >/dev/null
upload "$work/sqs-python.zip" >/dev/null
node_sqs="$(http POST /functions "$(jq -n --arg sha "$(sha256_of "$work/sqs-node.zip")" '{name: "e2e-sqs-node", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 256, timeout: 30}')" | jq -r .id)"
python_sqs="$(http POST /functions "$(jq -n --arg sha "$(sha256_of "$work/sqs-python.zip")" '{name: "e2e-sqs-python", runtime: "python", codeSha256: $sha, handler: "function.handler", memory: 256, timeout: 30}')" | jq -r .id)"
sqs_input="$(jq -cn --arg url "$sqs_endpoint/$tenant/e2e-fn-orders" --arg other "$other" '{input: {queue: "e2e-fn-orders", publicUrl: $url, otherAccount: $other}}')"
check "a Node.js function, new SQSClient({}) as on Lambda: the queue's URL by its name under FF's endpoint inside the cluster, and a send to it; another account's, QueueDoesNotExist" \
  "{\"url\":\"http://$cluster_gateway:$sqs_port/$tenant/e2e-fn-orders\",\"byName\":\"sent\",\"other\":\"QueueDoesNotExist\"}" \
  "$(http POST "/functions/$node_sqs/invoke" "$sqs_input" | jq -c '.output | {url, byName, other}')"
check "  ... a URL from outside: the SDK sends to its host, which a function doesn't reach, unless its client keeps to its endpoint (useQueueUrlAsEndpoint: false)" \
  "ECONNREFUSED sent" "$(jq -r '.output | "\(.fromOutside) \(.keptToEndpoint)"' "$work/body")"
check "a Python function, boto3.client(\"sqs\") as on Lambda: the URL from outside works as it is, boto3 sending to its endpoint; it receives both functions' messages" \
  '{"bodies":["sent by a Node.js function","sent by a Node.js function, to the URL from outside","sent by a Python function"],"other":"AWS.SimpleQueueService.NonExistentQueue"}' \
  "$(http POST "/functions/$python_sqs/invoke" "$sqs_input" | jq -c .output)"
check "their pods get the SQS endpoint inside the cluster with their own key, through the Secret" \
  "http://$cluster_gateway:$sqs_port $(function_secret "$node_sqs" AWS_ACCESS_KEY_ID)" \
  "$(function_secret "$node_sqs" AWS_ENDPOINT_URL_SQS) $(env_q "SELECT id FROM storage_keys WHERE function_id = '$node_sqs' AND revoked_at IS NULL")"
check "  ... and the SES endpoint for the account's mail, as AWS_ENDPOINT_URL_SESV2" "http://$cluster_gateway:$ses_port" "$(function_secret "$node_sqs" AWS_ENDPOINT_URL_SESV2)"
http PUT "/functions/$python_sqs" '{"environment": {"AWS_ENDPOINT_URL_SQS": "https://sqs.us-east-1.amazonaws.com"}}' >/dev/null
check "a function can't point it elsewhere: AWS_ENDPOINT_URL_SQS is FF's" "400 AWS_ENDPOINT_URL_SQS is reserved: FF sets it, with the function's own key to its account's queues" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
http DELETE "/functions/$node_sqs" >/dev/null
http DELETE "/functions/$python_sqs" >/dev/null
# A queue as the destination of a function's calls that don't wait: the record, Lambda's, as the message's body.
aws_sqs create-queue --queue-name e2e-fn-records >/dev/null
records_queue_arn="arn:aws:sqs:tn-tunis-1:$tenant:e2e-fn-records"
failing_code='export const handler = async () => { throw new Error("asked to fail"); };'
failing_fn="$(http POST /functions "$(jq -n --arg code "$failing_code" '{name: "e2e-async-to-queue", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
http PUT "/functions/$failing_fn/event-invoke-config" "$(jq -cn --arg arn "$records_queue_arn" '{maximumRetryAttempts: 0, destinationConfig: {onFailure: {destination: $arn}}}')" >/dev/null
check "a queue of the account as a function's destination, by its ARN" "200 $records_queue_arn" "$(status) $(jq -r .destinationConfig.onFailure.destination "$work/body")"
to_queue="$(http POST "/functions/$failing_fn/invoke" '{"input": {"order": 11}}' -H 'X-Amz-Invocation-Type: Event' | jq -r .requestId)"
aws_sqs receive-message --queue-url "$sqs_endpoint/$tenant/e2e-fn-records" --wait-time-seconds 20 --attribute-names SenderId >"$work/record.json"
check "  ... a call that fails for good sends it Lambda's record, the message's body, its sender the function" \
  "RetriesExhausted $to_queue 11 asked to fail arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-async-to-queue" \
  "$(jq -r '.Messages[0].Body | fromjson | "\(.requestContext.condition) \(.requestContext.requestId) \(.requestPayload.order) \(.responsePayload.errorMessage)"' "$work/record.json") $(jq -r '.Messages[0].Attributes.SenderId' "$work/record.json")"
http PUT "/functions/$failing_fn/event-invoke-config" "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$other:e2e-cli-orders" '{destinationConfig: {onFailure: {destination: $arn}}}')" >/dev/null
check "  ... never another account's queue" "400 destinationConfig.onFailure.destination must be a queue of this account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:$tenant:e2e-cli-orders" \
  "$(status) $(jq -r .message "$work/body")"
http DELETE "/functions/$failing_fn" >/dev/null
# FF's API beside the endpoint: the same queues, through SQS's own operations.
api_queue="$(http POST /queues '{"name": "e2e-api-orders", "visibilityTimeout": 45}')"
check "FF's API makes a queue, its URL under the endpoint, which the AWS CLI finds" \
  "201 $sqs_endpoint/$tenant/e2e-api-orders 45 $sqs_endpoint/$tenant/e2e-api-orders" \
  "$(status) $(jq -r '"\(.url) \(.visibilityTimeout)"' <<<"$api_queue") $(aws_sqs get-queue-url --queue-name e2e-api-orders --query QueueUrl --output text)"
api_url="$sqs_endpoint/$tenant/e2e-api-orders"
http POST /queues/e2e-api-orders/messages '{"body": "from the API", "attributes": {"via": {"dataType": "String", "stringValue": "api"}}}' >/dev/null
check "  ... sends a message the AWS CLI receives, with its attribute" "201 from the API api" \
  "$(status) $(aws_sqs receive-message --queue-url "$api_url" --message-attribute-names All --query 'Messages[0].[Body, MessageAttributes.via.StringValue]' --output text | tr '\t' ' ')"
check "  ... and counts it in flight, hidden for the queue's 45 s" "0 1 0" "$(http GET /queues/e2e-api-orders | jq -r '"\(.messages.available) \(.messages.inFlight) \(.messages.delayed)"')"
aws_sqs send-message --queue-url "$api_url" --message-body 'from the CLI' >/dev/null
api_received="$(http POST /queues/e2e-api-orders/receive '{"maxMessages": 10}')"
check "  ... receives what the CLI sent, its sender the CLI's key, and deletes it by its handle" "200 from the CLI $queue_key_id 204" \
  "$(status) $(jq -r '.[0] | "\(.body) \(.senderId)"' <<<"$api_received") $(http DELETE "/queues/e2e-api-orders/messages/$(jq -r '.[0].receiptHandle' <<<"$api_received")" >/dev/null; status)"
http POST /queues '{"name": "e2e-api-orders"}' >/dev/null
check "  ... refuses a name the account has" '409 The account has a queue named "e2e-api-orders" already' "$(status) $(jq -r .message "$work/body")"
# A key that names a queue reaches it alone.
named_key="$(http POST /storage-keys '{"queues": ["e2e-api-orders"]}')"
named_sqs() { AWS_KEY="$(jq -r .id <<<"$named_key")" AWS_SECRET="$(jq -r .secretAccessKey <<<"$named_key")" "$@"; }
check "a key that names a queue lists it alone, and is refused another, AccessDenied" "201 e2e-api-orders $api_url refused AccessDenied" \
  "$(status) $(jq -r '.queues | join(",")' <<<"$named_key") $(named_sqs aws_sqs list-queues --query 'QueueUrls' --output text) $(named_sqs outcome_sqs aws_sqs get-queue-url --queue-name e2e-fn-records)"
http DELETE "/storage-keys/$(jq -r .id <<<"$named_key")" >/dev/null
http POST /queues/e2e-api-orders/purge >/dev/null
check "FF's API purges a queue, and deletes it, which the CLI then doesn't find" "204 0 204 refused AWS.SimpleQueueService.NonExistentQueue" \
  "$(status) $(http GET /queues/e2e-api-orders | jq -r .sizeBytes) $(http DELETE /queues/e2e-api-orders >/dev/null; status) $(outcome_sqs aws_sqs get-queue-url --queue-name e2e-api-orders)"
check "the audit log names each change of a queue, whichever way it came: the CLI's under its access key, the API's as its caller" \
  "queue.create access_key:$queue_key_id|queue.create dev|queue.purge dev|queue.delete dev" \
  "$(env_q "SELECT string_agg(action || ' ' || actor, '|' ORDER BY at) FROM audit_log WHERE account_id = '$tenant' AND resource IN ('queue:e2e-cli-orders', 'queue:e2e-api-orders') AND (resource = 'queue:e2e-api-orders' OR action = 'queue.create')")"
}
section_def queues section_queues keys budget=100

section_buckets_room() {
section "customers' buckets: the full account's room, made in their section, measured a minute on"
# A full account is measured every minute: room made, its uploads go in again within one, which the queues' section
# passes.
for _ in $(seq 75); do [ "$(storage_notice)" != 100 ] && break; sleep 1; done
check "the other account's buckets, room made in them, take its upload again within a minute" "0 accepted" \
  "$(storage_notice) $(as_other_s3 outcome aws_ff s3 cp "$work/part.bin" s3://e2e-theirs/three.bin)"
sql "UPDATE accounts SET plan_id = 'beta' WHERE id = '$other'"
}
section_def buckets_room section_buckets_room buckets budget=5

section_mappings() {
section "functions reading queues, as Lambda's event source mappings: a batch, a partial batch failure, the dead-letter queue"
aws_sqs create-queue --queue-name e2e-batch-dlq >/dev/null
aws_sqs create-queue --queue-name e2e-batch --attributes "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$tenant:e2e-batch-dlq" \
  '{VisibilityTimeout: "5", RedrivePolicy: ({deadLetterTargetArn: $arn, maxReceiveCount: 2} | tojson)}')" >/dev/null
batch_arn="arn:aws:sqs:tn-tunis-1:$tenant:e2e-batch"
# As a function written for Lambda answers: the messages it couldn't handle, by their IDs, in batchItemFailures.
batch_code='export const handler = async (event) => ({ batchItemFailures: event.Records.filter((record) => JSON.parse(record.body).fail).map((record) => ({ itemIdentifier: record.messageId })) });'
batch_fn="$(http POST /functions "$(jq -n --arg code "$batch_code" '{name: "e2e-batch-reader", runtime: "nodejs", code: $code, memory: 128, timeout: 3}')" | jq -r .id)"
# Warm, so that its first batch isn't held past the queue's visibility timeout by a cold start.
http POST "/functions/$batch_fn/invoke" '{"input": {"Records": []}}' >/dev/null
mapping="$(http POST "/functions/$batch_fn/event-sources" "$(jq -cn --arg arn "$batch_arn" '{eventSourceArn: $arn, maximumBatchingWindowInSeconds: 2, functionResponseTypes: ["ReportBatchItemFailures"]}')")"
check "a function made to read a queue, as Lambda's CreateEventSourceMapping: 10 a batch, a window of 2 s, partial batch responses" \
  "201 Enabled 10 2 ReportBatchItemFailures $batch_arn" \
  "$(status) $(jq -r '"\(.state) \(.batchSize) \(.maximumBatchingWindowInSeconds) \(.functionResponseTypes[0]) \(.eventSourceArn)"' <<<"$mapping")"
mapping_id="$(jq -r .uuid <<<"$mapping")"
http POST "/functions/$batch_fn/event-sources" "$(jq -cn --arg arn "$batch_arn" '{eventSourceArn: $arn}')" >/dev/null
check "  ... once: another for the same queue names the first, in Lambda's words" "409 Please update or delete the existing mapping with UUID $mapping_id" \
  "$(status) $(jq -r .message "$work/body" | grep -oE 'Please update or delete the existing mapping with UUID [0-9a-f-]+$')"
check "  ... which the function's list and the queue's show" "$mapping_id $mapping_id" \
  "$(http GET "/functions/$batch_fn/event-sources" | jq -r '.[0].uuid') $(http GET "/event-sources?eventSourceArn=$(jq -rn --arg arn "$batch_arn" '$arn | @uri')" | jq -r '.[0].uuid')"
aws_sqs send-message-batch --queue-url "$sqs_endpoint/$tenant/e2e-batch" \
  --entries "$(jq -cn '[range(1; 6) | {Id: "m\(.)", MessageBody: ({order: ., fail: (. == 2 or . == 4)} | tojson)}]')" >/dev/null
# The batch at once, PostgreSQL telling FF; the two that failed back after the 5 s of their visibility timeout, then a
# second time, and moved by the receive after to the dead-letter queue.
for _ in $(seq 1 60); do
  [ "$(http GET /queues/e2e-batch-dlq | jq .messages.available)" = 2 ] && [ "$(http GET /queues/e2e-batch | jq '.messages.available + .messages.inFlight')" = 0 ] && break
  sleep 1
done
check "the AWS CLI's five messages in one call of the function, SQS's event; the two its answer names called again, then in the dead-letter queue" \
  "5 aws:sqs $batch_arn 1,3,5 2,4 0 2" \
  "$(http GET "/functions/$batch_fn/invocations?limit=10" | jq -r '[.invocations[] | select(.source == "sqs")] | last | .input.Records | "\(length) \(.[0].eventSource) \(.[0].eventSourceARN) \([.[].body | fromjson | select(.fail | not) | .order] | map(tostring) | join(","))"') \
$(aws_sqs receive-message --queue-url "$sqs_endpoint/$tenant/e2e-batch-dlq" --max-number-of-messages 10 | jq -r '[.Messages[].Body | fromjson | .order] | sort | map(tostring) | join(",")') \
$(http GET /queues/e2e-batch | jq '.messages.available + .messages.inFlight') $(http GET /queues/e2e-batch-dlq | jq '.messages.available + .messages.inFlight')"
check "  ... each call in the function's history as the queue's: the batch, then the two again" "2 sqs" \
  "$(http GET "/functions/$batch_fn/invocations?limit=10" | jq -r '[.invocations[] | select(.source == "sqs")] | "\(length) \(.[0].source)"')"
http PATCH "/event-sources/$mapping_id" '{"enabled": false}' >/dev/null
check "a mapping disabled, as Lambda's UpdateEventSourceMapping: nothing read" "200 Disabled" "$(status) $(jq -r .state "$work/body")"
aws_sqs send-message --queue-url "$sqs_endpoint/$tenant/e2e-batch" --message-body '{"order": 6}' >/dev/null
sleep 4
check "  ... the message waits, the function not called" "1 2" \
  "$(http GET /queues/e2e-batch | jq .messages.available) $(http GET "/functions/$batch_fn/invocations?limit=10" | jq '[.invocations[] | select(.source == "sqs")] | length')"
http DELETE "/event-sources/$mapping_id" >/dev/null
check "  ... and deleted: the message stays" "204 1 []" "$(status) $(http GET /queues/e2e-batch | jq .messages.available) $(http GET "/functions/$batch_fn/event-sources" | jq -c .)"
check "the audit log names each change of the mapping" "event_source.create|event_source.update|event_source.delete" \
  "$(env_q "SELECT string_agg(action, '|' ORDER BY at) FROM audit_log WHERE account_id = '$tenant' AND resource = 'event_source:$mapping_id'")"
http DELETE "/functions/$batch_fn" >/dev/null
}
section_def mappings section_mappings queues budget=45

section_notifications() {
section "buckets' notifications, as S3's: an upload runs a function with S3's event, a deletion puts S3's event in a queue"
# The AWS CLI on buckets with the queues' key, which reaches all the account's buckets and queues.
s3n() { AWS_KEY="$queue_key_id" AWS_SECRET="$queue_key_secret" aws_ff "$@"; }
http POST /buckets '{"name": "e2e-notify"}' >/dev/null
# As a function written for Lambda reads S3's event: each key form-decoded, a "+" a space.
upload_code='export const handler = async (event) => ({ keys: event.Records.map((record) => decodeURIComponent(record.s3.object.key.replace(/\+/g, " "))), name: event.Records[0].eventName });'
upload_fn="$(http POST /functions "$(jq -n --arg code "$upload_code" '{name: "e2e-on-upload", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
aws_sqs create-queue --queue-name e2e-removals >/dev/null
removals_url="$sqs_endpoint/$tenant/e2e-removals"
s3n s3api put-bucket-notification-configuration --bucket e2e-notify --notification-configuration "$(jq -cn \
  --arg fn "arn:aws:lambda:tn-tunis-1:$tenant:function:e2e-on-upload" --arg queue "arn:aws:sqs:tn-tunis-1:$tenant:e2e-removals" \
  '{LambdaFunctionConfigurations: [{Id: "uploads", LambdaFunctionArn: $fn, Events: ["s3:ObjectCreated:*"], Filter: {Key: {FilterRules: [{Name: "prefix", Value: "uploads/"}]}}}],
    QueueConfigurations: [{Id: "removals", QueueArn: $queue, Events: ["s3:ObjectRemoved:*"]}]}')"
check "the AWS CLI sets a bucket's notifications, as S3's, and reads them back; FF's API reads the same" "uploads removals uploads removals" \
  "$(s3n s3api get-bucket-notification-configuration --bucket e2e-notify | jq -r '"\(.LambdaFunctionConfigurations[0].Id) \(.QueueConfigurations[0].Id)"') \
$(http GET /buckets/e2e-notify/notifications | jq -r '"\(.lambdaFunctionConfigurations[0].id) \(.queueConfigurations[0].id)"')"
aws_sqs receive-message --queue-url "$removals_url" --wait-time-seconds 5 >"$work/s3-test.json"
check "  ... and the queue it names gets S3's test event" "s3:TestEvent e2e-notify" "$(jq -r '.Messages[0].Body | fromjson | "\(.Event) \(.Bucket)"' "$work/s3-test.json")"
aws_sqs delete-message --queue-url "$removals_url" --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' "$work/s3-test.json")"
printf 'not an upload' >"$work/other.txt"
printf 'a red cat' >"$work/cat.jpg"
s3n s3 cp "$work/other.txt" s3://e2e-notify/other/x.txt --only-show-errors
s3n s3 cp "$work/cat.jpg" "s3://e2e-notify/uploads/red cat.jpg" --only-show-errors
for _ in $(seq 1 30); do
  [ "$(http GET "/functions/$upload_fn/invocations?limit=5" | jq '[.invocations[] | select(.source == "async" and .status == "COMPLETED")] | length')" -ge 1 ] && break
  sleep 1
done
check "an upload its rule names runs the function without waiting, S3's event its input, the key decoded as Lambda's functions decode it; another, nothing" \
  '1 ["uploads/red cat.jpg"] ObjectCreated:Put 9 e2e-notify' \
  "$(http GET "/functions/$upload_fn/invocations?limit=5" | jq -r '[.invocations[] | select(.source == "async")] | "\(length) \(.[0].output.keys | tojson) \(.[0].output.name) \(.[0].input.Records[0].s3.object.size) \(.[0].input.Records[0].s3.bucket.name)"')"
s3n s3 rm "s3://e2e-notify/uploads/red cat.jpg" --only-show-errors
aws_sqs receive-message --queue-url "$removals_url" --wait-time-seconds 10 --attribute-names SenderId >"$work/s3-removed.json"
check "a deletion puts S3's event in the queue, as S3 sends it to SQS, from the bucket" "ObjectRemoved:Delete uploads%2Fred+cat.jpg removals arn:aws:s3:::e2e-notify" \
  "$(jq -r '.Messages[0].Body | fromjson | .Records[0] | "\(.eventName) \(.s3.object.key) \(.s3.configurationId)"' "$work/s3-removed.json") $(jq -r '.Messages[0].Attributes.SenderId' "$work/s3-removed.json")"
check "  ... a destination the account doesn't have refused, as S3 refuses one it can't validate" "refused InvalidArgument" \
  "$(outcome s3n s3api put-bucket-notification-configuration --bucket e2e-notify --notification-configuration "$(jq -cn --arg fn "arn:aws:lambda:tn-tunis-1:$tenant:function:nowhere" '{LambdaFunctionConfigurations: [{LambdaFunctionArn: $fn, Events: ["s3:ObjectCreated:*"]}]}')")"
check "the audit log names the change, under the CLI's key" "bucket.notifications access_key:$queue_key_id" \
  "$(env_q "SELECT action || ' ' || actor FROM audit_log WHERE account_id = '$tenant' AND resource = 'bucket:e2e-notify' AND action = 'bucket.notifications' ORDER BY at DESC LIMIT 1")"
http DELETE "/functions/$upload_fn" >/dev/null
http DELETE "/buckets/e2e-notify?force=true" >/dev/null
}
section_def notifications section_notifications mappings budget=25

section_sites() {
section "buckets' sites, as S3's website endpoint answers them: a built site synced with the AWS CLI, then visited"
site_url="http://e2e-site.site.localhost:$website_port"
# page <path> [curl options…]: the site's answer to a browser, its status and the error's code, as S3's error page says
# it under its own title, or else its page's title.
page() {
  local path=$1 code
  shift
  curl -s -o "$work/page.html" -w '%{http_code}' "$@" "$site_url$path"
  code="$(grep -oE 'Code: [A-Za-z]+' "$work/page.html" | head -1 | sed 's/Code: //')"
  echo " ${code:-$(grep -oE '<title>[^<]*' "$work/page.html" | head -1 | sed 's/<title>//')}"
}
http POST /buckets '{"name": "e2e-site"}' >/dev/null
# A built site of its own, apart from the folder the S3 checks above synced.
rm -rf "$work/www"
mkdir -p "$work/www/assets" "$work/www/docs"
printf '<!doctype html><title>e2e shop</title>' >"$work/www/index.html"
printf '<!doctype html><title>e2e docs</title>' >"$work/www/docs/index.html"
printf '<!doctype html><title>e2e missing</title>' >"$work/www/404.html"
printf 'console.log("e2e")' >"$work/www/assets/app-3c9d.js"
s3n s3 sync "$work/www" s3://e2e-site --only-show-errors
printf 'body { color: navy }' >"$work/untyped.css"
s3n s3api put-object --bucket e2e-site --key untyped.css --body "$work/untyped.css" >/dev/null
check "a bucket is no site before its website configuration" "404 NoSuchWebsiteConfiguration" "$(page /)"
s3n s3 website s3://e2e-site --index-document index.html --error-document 404.html
check "the AWS CLI makes it a site, as S3's; FF's API reads the same, with its address" "index.html 404.html index.html $site_url false" \
  "$(s3n s3api get-bucket-website --bucket e2e-site | jq -r '"\(.IndexDocument.Suffix) \(.ErrorDocument.Key)"') \
$(http GET /buckets/e2e-site/website | jq -r '"\(.indexDocument.suffix) \(.url) \(.singlePageApp)"')"
check "a browser gets its index, a folder's, a folder named without its slash redirected, a missing page its error document with 404" \
  "200 e2e shop|200 e2e docs|302 $site_url/docs/|404 e2e missing" \
  "$(page /)|$(page /docs/)|$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$site_url/docs")|$(page /no/such/page)"
check "an asset as the CLI typed it, a file uploaded without a type typed by its name, neither ever sniffed" "javascript text/css; charset=utf-8 nosniff" \
  "$(curl -s -o /dev/null -w '%{content_type}' "$site_url/assets/app-3c9d.js" | grep -o javascript) $(curl -s -o /dev/null -w '%{content_type}' "$site_url/untyped.css") \
$(curl -sI "$site_url/" | tr -d '\r' | sed -n 's/^x-content-type-options: //Ip')"
etag="$(curl -sI "$site_url/assets/app-3c9d.js" | tr -d '\r' | sed -n 's/^etag: //Ip')"
check "  ... the store's ETag, so that a browser that has the file gets 304, and a range 206" "304 206 console" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$site_url/assets/app-3c9d.js") \
$(curl -s -o "$work/part" -w '%{http_code}' -H 'Range: bytes=0-6' "$site_url/assets/app-3c9d.js") $(cat "$work/part")"
check "a path that climbs out of the site refused, never another bucket's file; a POST refused" "400 InvalidURI|405 MethodNotAllowed" \
  "$(page /../e2e-photos/x --path-as-is)|$(page / -X POST)"
# at_domain's page: its status and its title, or the error's code, as page says them.
domain_page() { echo "$(at_domain "$@") $(grep -oE '<title>[^<]*|Code: [A-Za-z]+' "$work/url-body" | head -1 | sed 's/<title>//; s/Code: //')"; }
added="$(http POST /buckets/e2e-site/website/domains '{"domain": "Docs.E2E-Customer.tn"}')"
check "a domain of the customer's for the site, added pending, with the CNAME to make: to the site's host" "201 docs.e2e-customer.tn pending e2e-site.site.localhost" \
  "$(status) $(jq -r '"\(.domain) \(.status) \(.records.cname[0].value)"' <<<"$added")"
check "before it is proved, the site doesn't answer there" 404 "$(at_domain docs.e2e-customer.tn)"
zone 4 "docs IN CNAME e2e-site.site.localhost."
for _ in $(seq 1 30); do
  http POST /buckets/e2e-site/website/domains/docs.e2e-customer.tn/verify >/dev/null
  [ "$(jq -r .status "$work/body")" = verified ] && break
  sleep 1
done
check "once its CNAME is made, the check proves it, and the site answers there as at its own host" "verified 200 e2e docs|404 e2e missing" \
  "$(jq -r .status "$work/body") $(domain_page docs.e2e-customer.tn /docs/)|$(domain_page docs.e2e-customer.tn /no/such/page)"
check "the edge may get certificates for it, and for the site's own host; not for a bucket that is no site" "200 200 404" \
  "$(asked docs.e2e-customer.tn) $(asked e2e-site.site.localhost) $(asked e2e-photos.site.localhost)"
http PUT /buckets/e2e-site/website '{"indexDocument": {"suffix": "index.html"}, "errorDocument": {"key": "404.html"}, "singlePageApp": true}' >/dev/null
check "FF's API makes it a single-page app's: its routes get its index with 200" "200 true 200 e2e shop" "$(status) $(jq -r .singlePageApp "$work/body") $(page /orders/42)"
check "the audit log names each change: the CLI's under its key, the API's" "bucket.website access_key:$queue_key_id bucket.website" \
  "$(env_q "SELECT string_agg(action || CASE WHEN actor LIKE 'access_key:%' THEN ' ' || actor ELSE '' END, ' ' ORDER BY at) FROM audit_log WHERE account_id = '$tenant' AND resource = 'bucket:e2e-site' AND action = 'bucket.website'")"
s3n s3api delete-bucket-website --bucket e2e-site
check "DeleteBucketWebsite makes it no site again, its files kept" "404 NoSuchWebsiteConfiguration 5" \
  "$(page /) $(s3n s3 ls s3://e2e-site --recursive | wc -l)"
}
section_def sites section_sites notifications url_domain budget=15

section_mail() {
section "customers' mail (ADR 0012): identities and the suppression list, with AWS's CLI through the SES endpoint"
ses_endpoint="http://localhost:$ses_port"
mail_key="$(http POST /storage-keys '{}')"
check "a new key's answer names the SES endpoint, AWS_ENDPOINT_URL_SESV2" "$ses_endpoint" "$(jq -r .sesEndpoint <<<"$mail_key")"
mail_key_id="$(jq -r .id <<<"$mail_key")"
mail_key_secret="$(jq -r .secretAccessKey <<<"$mail_key")"
# The AWS CLI, its endpoint from AWS_ENDPOINT_URL_SESV2 alone, as a function's environment gives it, and no setting of
# this machine's; as the other account with AWS_KEY and AWS_SECRET.
aws_ses() { AWS_ACCESS_KEY_ID="${AWS_KEY:-$mail_key_id}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET:-$mail_key_secret}" AWS_DEFAULT_REGION=tn-tunis-1 \
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_ENDPOINT_URL_SESV2="$ses_endpoint" "${aws_cli[@]}" sesv2 "$@" --output json; }
as_other_ses() { AWS_KEY="$(jq -r .id <<<"$other_key")" AWS_SECRET="$(jq -r .secretAccessKey <<<"$other_key")" "$@"; }
# outcome_ses <command…>: accepted, or refused with the error's name, as the CLI prints it.
outcome_ses() { "$@" >/dev/null 2>"$work/aws.err" && echo accepted || echo "refused $(grep -oE 'An error occurred \([A-Za-z]+\)' "$work/aws.err" | head -1 | sed -E 's/.*\((.*)\)/\1/')"; }
check "the AWS CLI makes a domain an identity, with a DKIM key of FF's, as SES's own DKIM brought in: pending, its one token the selector" \
  "DOMAIN false PENDING EXTERNAL 1" \
  "$(aws_ses create-email-identity --email-identity Shop.E2E-Customer.tn | jq -r '"\(.IdentityType) \(.VerifiedForSendingStatus) \(.DkimAttributes.Status) \(.DkimAttributes.SigningAttributesOrigin) \(.DkimAttributes.Tokens | length)"')"
http GET /email/identities/shop.e2e-customer.tn >/dev/null
selector="$(jq -r .dkimSelector "$work/body")"
check "FF's API gives the records to publish: its DKIM key's, and its return path's MX, to the mail server" \
  "200 $selector._domainkey.shop.e2e-customer.tn bounces.mail.shop.e2e-customer.tn 10 mail.localhost" \
  "$(status) $(jq -r '"\(.records[] | select(.purpose == "DKIM") | .name) \(.records[] | select(.purpose == "MAIL_FROM") | "\(.name) \(.value)")"' "$work/body")"
# A TXT record's strings are 255 characters at most: the key's record split in a few, as DNS providers store it.
dkim_strings="$(jq -r '.records[] | select(.purpose == "DKIM") | .value' "$work/body" | fold -w 200 | sed 's/.*/"&"/' | tr '\n' ' ')"
zone 5 "docs IN CNAME e2e-site.site.localhost." "$selector._domainkey.shop IN TXT $dkim_strings" "bounces.mail.shop IN MX 10 mail.localhost."
for _ in $(seq 1 30); do
  http POST /email/identities/shop.e2e-customer.tn/verify >/dev/null
  [ "$(jq -r .status "$work/body")" = SUCCESS ] && break
  sleep 1
done
check "once its records are published, a check proves it, its return path too" "SUCCESS true true" \
  "$(jq -r '"\(.status) \(.sendingEnabled) \(.mailFromVerified)"' "$work/body")"
check "  ... as the AWS CLI reads it back" "true SUCCESS SUCCESS" \
  "$(aws_ses get-email-identity --email-identity shop.e2e-customer.tn | jq -r '"\(.VerifiedForSendingStatus) \(.DkimAttributes.Status) \(.MailFromAttributes.MailFromDomainStatus)"')"
check "  ... the same domain again, refused as SES does" "refused AlreadyExistsException" "$(outcome_ses aws_ses create-email-identity --email-identity shop.e2e-customer.tn)"
check "an address is made an identity, pending until its link is followed" "EMAIL_ADDRESS false" \
  "$(aws_ses create-email-identity --email-identity Orders@E2E-Customer.tn | jq -r '"\(.IdentityType) \(.VerifiedForSendingStatus)"')"
# No SMTP server here: FF's own mail is written to the backend's log, the link with it.
for _ in $(seq 1 10); do
  token="$(grep -oE '/verify\?token=[A-Za-z0-9_-]{32}' "$work/backend.log" | tail -1 | cut -d= -f2)"
  [ -n "$token" ] && break
  sleep 1
done
check "  ... the link FF e-mails it proves it, once: a second visit finds nothing" "200 true 404" \
  "$(curl -s -o "$work/verify.html" -w '%{http_code}' "$ses_endpoint/verify?token=$token") $(grep -q 'orders@e2e-customer.tn' "$work/verify.html" && echo true || echo false) \
$(curl -s -o /dev/null -w '%{http_code}' "$ses_endpoint/verify?token=$token")"
check "  ... and the CLI lists both, proved" "orders@e2e-customer.tn:true shop.e2e-customer.tn:true" \
  "$(aws_ses list-email-identities | jq -r '[.EmailIdentities[] | "\(.IdentityName):\(.SendingEnabled)"] | join(" ")')"
check "another account's key finds none of them" "refused NotFoundException 0" \
  "$(outcome_ses as_other_ses aws_ses get-email-identity --email-identity shop.e2e-customer.tn) $(as_other_ses aws_ses list-email-identities | jq '.EmailIdentities | length')"
check "the account's sending as GetAccount says it: the plan's quotas, SES's doubles as the AWS CLI prints them, in the sandbox" "200.0 1.0 false true" \
  "$(aws_ses get-account | jq -r '"\(.SendQuota.Max24HourSend) \(.SendQuota.MaxSendRate) \(.ProductionAccessEnabled) \(.SendingEnabled)"')"
aws_ses put-suppressed-destination --email-address Gone@E2E-Customer.tn --reason BOUNCE >/dev/null
check "an address put on the suppression list, read back by the CLI and FF's API" "gone@e2e-customer.tn BOUNCE gone@e2e-customer.tn" \
  "$(aws_ses get-suppressed-destination --email-address gone@e2e-customer.tn | jq -r '"\(.SuppressedDestination.EmailAddress) \(.SuppressedDestination.Reason)"') $(http GET /email/suppressions | jq -r '.suppressions[0].address')"
aws_ses delete-suppressed-destination --email-address gone@e2e-customer.tn >/dev/null
check "  ... and taken off" "refused NotFoundException" "$(outcome_ses aws_ses get-suppressed-destination --email-address gone@e2e-customer.tn)"
check "the audit log names each change to the domain, the CLI's under its key" "email.identity.create access_key:$mail_key_id email.identity.verify" \
  "$(env_q "SELECT string_agg(action || CASE WHEN actor LIKE 'access_key:%' THEN ' ' || actor ELSE '' END, ' ' ORDER BY at) FROM audit_log WHERE account_id = '$tenant' AND resource = 'email-identity:shop.e2e-customer.tn'")"
}
section_def mail section_mail keys url_domain budget=20

section_mail_sent() {
section "customers' mail sent (ADR 0012): through the run's mail server, signed with the domain's key, its bounces back"
simple_content='{"Simple": {"Subject": {"Data": "Your order"}, "Body": {"Text": {"Data": "Thanks for your order."}}}}'
sent_id="$(aws_ses send-email --from-email-address 'Shop <news@shop.e2e-customer.tn>' \
  --destination 'ToAddresses=orders@e2e-customer.tn,bounce-me@shop.e2e-customer.tn' --content "$simple_content" | jq -r .MessageId)"
check "the AWS CLI sends a message from the proved domain, to the proved address and to one at the domain: SES's MessageId" true \
  "$([[ $sent_id =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false)"
for _ in $(seq 1 30); do [ "$(received_count)" -ge 1 ] && break; sleep 1; done
received 1 >"$work/received-1.eml"
check "  ... the mail server, taking it over TLS, hands it on, its envelope's sender its return path, which names it" \
  "b-$sent_id@bounces.mail.shop.e2e-customer.tn orders@e2e-customer.tn true" \
  "$(received_envelope 1 | jq -r '"\(.from) \(.to | join(","))"') $(grep -q 'with ESMTPS' "$work/received-1.eml" && echo true || echo false)"
# mailauth, at a release at least two weeks old (7.3.0, 2026-10-10), checks the signature as a mailbox provider would.
[ -d "$work/js/node_modules/mailauth" ] || npm install --prefix "$work/js" --no-audit --no-fund --silent mailauth@7.3.0 >/dev/null
# dkim_of <message>: its signature's result, domain and selector; then the same, its subject changed on the way.
dkim_of() { MODULES="$work/js" DNS="127.0.0.1:$dns_port" node "$FF_REPO_ROOT/hack/lib/dkim-verify.mjs" "$1" | paste -sd' '; }
check "  ... signed with the domain's DKIM key, its record found in the DNS as a provider looks it up; changed on the way, it fails" \
  "pass shop.e2e-customer.tn $selector fail shop.e2e-customer.tn $selector" "$(dkim_of "$work/received-1.eml")"
# The stand-in refused bounce-me as a mailbox that doesn't exist: the mail server's bounce goes to the return path, its
# own mailbox, whence its agent gives it to the backend within 10 s.
fates() { http GET /email/messages | jq -r --arg id "$1" '[.messages[] | select(.messageId == $id) | .recipients[].status] | join(" ")'; }
for _ in $(seq 1 60); do [ "$(fates "$sent_id")" = "SENT BOUNCED" ] && break; sleep 1; done
check "  ... the refused address's bounce comes back through the server's agent: that recipient bounced, the other sent" "SENT BOUNCED" "$(fates "$sent_id")"
check "  ... its address on the suppression list, as SES puts it, naming the message" "BOUNCE $sent_id" \
  "$(aws_ses get-suppressed-destination --email-address bounce-me@shop.e2e-customer.tn | jq -r '"\(.SuppressedDestination.Reason) \(.SuppressedDestination.Attributes.MessageId)"')"
http POST /email/messages '{"from": "news@shop.e2e-customer.tn", "to": ["bounce-me@shop.e2e-customer.tn"], "subject": "Again", "text": "Hello again"}' >/dev/null
again_id="$(jq -r .messageId "$work/body")"
check "FF's API sends one too: to an address on the list, it is kept off, done at once, never handed on" "201 SENT SUPPRESSED 1" \
  "$(status) $(http GET /email/messages | jq -r --arg id "$again_id" '.messages[] | select(.messageId == $id) | "\(.status) \(.recipients[0].status)"') $(received_count)"
sleep 1 # the Beta plan's rate: a message a second
raw="$(printf 'From: Shop <news@shop.e2e-customer.tn>\r\nTo: orders@e2e-customer.tn\r\nSubject: Raw\r\nMessage-ID: <raw-e2e@shop.e2e-customer.tn>\r\n\r\nHello from a raw message.\r\n' | base64 -w0)"
aws_ses send-email --content "{\"Raw\": {\"Data\": \"$raw\"}}" >/dev/null
for _ in $(seq 1 30); do [ "$(received_count)" -ge 2 ] && break; sleep 1; done
received 2 >"$work/received-2.eml"
check "a raw message, its sender and recipient from its header as the AWS CLI sends it: handed on, its own Message-ID, signed" \
  "orders@e2e-customer.tn true pass shop.e2e-customer.tn $selector fail shop.e2e-customer.tn $selector" \
  "$(received_envelope 2 | jq -r '.to | join(",")') $(grep -q '^Message-ID: <raw-e2e@shop.e2e-customer.tn>' "$work/received-2.eml" && echo true || echo false) $(dkim_of "$work/received-2.eml")"
sleep 1
check "a message from an address the account hasn't proved is refused, as SES refuses it" "refused MessageRejected" \
  "$(outcome_ses aws_ses send-email --from-email-address someone@unproved.tn --destination ToAddresses=orders@e2e-customer.tn --content "$simple_content")"
check "  ... and in the sandbox, one to an address it hasn't proved" "refused MessageRejected" \
  "$(outcome_ses aws_ses send-email --from-email-address news@shop.e2e-customer.tn --destination ToAddresses=stranger@example.org --content "$simple_content")"
check "GetAccount counts what the account sent in the last day, each recipient once, the one kept off too" 4.0 \
  "$(aws_ses get-account | jq -r .SendQuota.SentLast24Hours)"
check "GET /email/metrics counts its recipients as CloudWatch names SES's metrics: sent, taken, bounced or kept off, complained of" "4 2 2 0" \
  "$(http GET /email/metrics | jq -r '[.metrics.Send.Sum, .metrics.Delivery.Sum, .metrics.Bounce.Sum, .metrics.Complaint.Sum] | map(add | tostring) | join(" ")')"
check "  ... and its reputation over 14 days: one of the three recipients its mail reached bounced for good, none complained" "0.333333 0" \
  "$(http GET /email/metrics | jq -r '[.metrics."Reputation.BounceRate".Average, .metrics."Reputation.ComplaintRate".Average] | map(map(select(. != null)) | last | tostring) | join(" ")')"
check "GET /usage bills it by its domain, as SES bills it: each recipient once, the one kept off too, no attachment" "shop.e2e-customer.tn 4 0 false" \
  "$(http GET /usage | jq -r '.email[] | "\(.identity) \(.recipients) \(.attachmentBytes) \(.deleted)"')"
aws_ses delete-email-identity --email-identity orders@e2e-customer.tn >/dev/null
http DELETE /email/identities/shop.e2e-customer.tn >/dev/null
check "both deleted, one through the CLI, one through FF's API, their keys with them" "204 0" "$(status) $(env_q "SELECT count(*) FROM email_identities WHERE account_id = '$tenant'")"
check "  ... the domain's mail stays in GET /usage, said deleted, as billed" "true 4" "$(http GET /usage | jq -r '.email[] | "\(.deleted) \(.recipients)"')"
http DELETE "/storage-keys/$mail_key_id" >/dev/null
}
section_def mail_sent section_mail_sent mail budget=20

section_plans() {
section "plans and rate limits (P-15)"
# A small plan, assigned in SQL as the admin dashboard will (P-73), to an account
# that development mode creates on its first call.
small="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$small")")
# as_small <method> <path> [body] [curl option...]
as_small() {
  local method=$1 path=$2 body=${3:-}
  shift $(($# < 3 ? $# : 3))
  http_at "$api" "$method" "$path" "$body" -H "X-FF-Dev-Account: $small" "$@"
}
as_small GET /functions >/dev/null
sql "INSERT INTO plans (id, name, limits) SELECT 'e2e-small', 'E2E small', limits || '{\"functions\": 1, \"memoryMb\": 512, \"writesPerMinute\": 5, \"invokesPerSecond\": 2, \"quota\": {\"pods\": 5, \"cpu\": \"2\", \"memory\": \"2Gi\"}}' FROM plans WHERE id = 'beta'"
sql "UPDATE accounts SET plan_id = 'e2e-small' WHERE id = '$small'"
small_fn() { jq -n --arg code "$v1" --argjson memory "$2" '{name: $ARGS.positional[0], runtime: "nodejs", code: $code, memory: $memory, timeout: 5}' --args "$1"; }
as_small POST /functions "$(small_fn e2e-big 1024)" >/dev/null # change 1
check "memory above the plan is refused, naming its limit" "400 memory must be at most 512 MB on the E2E small plan" \
  "$(status) $(jq -r '.message | join("; ")' "$work/body")"
created="$(as_small POST /functions "$(small_fn e2e-small 128)")" # change 2
check "the plan's one function is created" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
small_id="$(jq -r .id <<<"$created")"
check "its namespace has the plan's quota" "5 2 2Gi" \
  "$(kubectl -n "$(tenant_namespace "$small")" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"
as_small POST /functions "$(small_fn e2e-second 128)" >/dev/null # change 3
check "a second function is refused" "400 The E2E small plan allows 1 function per account: delete one first" "$(status) $(jq -r .message "$work/body")"
as_small PUT "/functions/$small_id/scaling-config" '{"maxInstances": 1}' >/dev/null # change 4
as_small PUT "/functions/$small_id" '{"name": "e2e-renamed"}' >/dev/null # change 5
check "changes within the plan's rate pass" 200 "$(status)"
as_small PUT "/functions/$small_id" '{"name": "e2e-again"}' -D "$work/headers" >/dev/null # change 6
retry_after="$(tr -d '\r' <"$work/headers" | awk -F': ' 'tolower($1) == "retry-after" {print $2}')"
check "the sixth change in a minute gets 429, with Retry-After" "429 true" "$(status) $([ "${retry_after:-0}" -gt 0 ] && echo true || echo false)"
check "and Lambda's error name, and the plan's limit" "TooManyRequestsException: Rate exceeded: the E2E small plan allows 5 changes per minute" \
  "$(jq -r .message "$work/body" | sed 's/\. Retry after.*//')"
as_small GET "/functions/$small_id" >/dev/null
check "reads still pass" 200 "$(status)"
codes=""
for _ in 1 2 3; do as_small POST "/functions/$small_id/invoke" '{"input":{}}' >/dev/null; codes="$codes $(status)"; done
check "invocations have their own rate: two a second, then 429" " 201 201 429" "$codes"
http PUT "/functions/$small_id/scaling-config" '{"maxInstances": 1}' >/dev/null
check "another account, from the same address, isn't slowed: its own count, and its function isn't found" 404 "$(status)"
}
section_def plans section_plans backend budget=15

# What the sections above started and the minutes since have done: read here, once those minutes have passed in the
# sections between, and before the backend is killed (usage_records), whose counts of the minute are in its memory
# until written.
section_async_metrics() {
section "asynchronous calls: their metrics, written a minute at a time, read minutes after"
# Its calls as Lambda's metrics count them, each backend's counts written a minute at a time: by now, or within
# one when run alone.
async_metrics() {
  http GET "/functions/$async_fn/metrics?period=3600&start=$(date -u -d '-2 hour' +%Y-%m-%dT%H:00:00Z)" |
    jq -r '"\([.metrics.AsyncEventsReceived[]] | add) \([.metrics.AsyncEventsDropped[]] | add) \([.metrics.DestinationDeliveryFailures[]] | add) \([.metrics.AsyncEventAge.Maximum[] | select(. != null)] | max > 0)"'
}
for _ in $(seq 90); do [ "$(async_metrics)" = "5 3 0 true" ] && break; sleep 1; done
check "its metrics, as Lambda's: the five events kept, the three that ended without success dropped, records to its destination all taken, each attempt's age" \
  "5 3 0 true" "$(async_metrics)"
http DELETE "/functions/$records_fn" >/dev/null
http DELETE "/functions/$async_fn" >/dev/null
check "deleting the function deletes its queue" 0 "$(env_q "SELECT count(*) FROM queues WHERE function_id = '$async_fn'")"
}
section_def async_metrics section_async_metrics async budget=5

section_databases_sampled() {
section "customers' databases: the one made, its hourly sample read minutes after; then deleted"
# Every minute, each database not measured yet in the hour is: a new one within a minute, the backend's log says when.
# By now it has been; run alone, it is waited for, as long as before.
for _ in $(seq 75); do [ "$(env_q "SELECT count(*) FROM database_samples WHERE database_id = '$db_id'")" -ge 1 ] && break; sleep 1; done
check "its hourly sample, within a minute: once in the hour, by its name, its size as the server counts it" "1|e2e-orders|t true" \
  "$(env_q "SELECT count(*), max(name), bool_and(size_bytes > 1000000) FROM database_samples WHERE database_id = '$db_id'
            AND hour = (SELECT min(hour) FROM database_samples WHERE database_id = '$db_id')") $(written_within 90 database_samples "$db_id" "$db_made_at")"
http DELETE "/databases/$db_id" >/dev/null
check "a database deleted: 204, then 404, gone from the server with its user" "204 404 0 0" \
  "$(status) $(http GET "/databases/$db_id" >/dev/null; status) $(docker exec -u postgres "$e2e_data_db_container" psql -XAtc "select (select count(*) from pg_database where datname = '$db_name') || ' ' || (select count(*) from pg_roles where rolname = '$db_name')")"
}
section_def databases_sampled section_databases_sampled databases budget=5

section_caches_sampled() {
section "customers' caches: the one made, its hourly sample read minutes after, its metrics, alarm and bill; then deleted"
# Every minute, each cache not measured yet in the hour is: a new one within a minute, the backend's log says when. By
# now it has been; run alone, it is waited for, as long as before.
cache_id="$(env_q "SELECT id FROM caches WHERE name = 'e2e-sessions'")"
for _ in $(seq 75); do [ "$(env_q "SELECT count(*) FROM cache_samples WHERE cache_id = '$cache_id'")" -ge 1 ] && break; sleep 1; done
check "its hourly sample, within a minute: by its name, its memory the plan's, what its keys use as its server counts it" "e2e-sessions|64|t true" \
  "$(env_q "SELECT max(name), max(memory_mb), bool_and(bytes_used > 0) FROM cache_samples WHERE cache_id = '$cache_id'") $(written_within 90 cache_samples "$cache_id" "$cache_made_at")"
# Its metrics, as CloudWatch names ElastiCache's, a point an hour: this hour and the one before.
cache_metrics="$(http GET "/caches/e2e-sessions/metrics?start=$(date -u -d '-1 hour' +%Y-%m-%dT%H:00:00Z)")"
check "its metrics, as CloudWatch names ElastiCache's: the memory its keys use as its latest sample says" \
  "200 3600 $(env_q "SELECT bytes_used FROM cache_samples WHERE cache_id = '$cache_id' ORDER BY hour DESC LIMIT 1")" \
  "$(status) $(jq -r '"\(.period) \([.metrics.BytesUsedForCache.Maximum[] | select(. != null)] | last)"' <<<"$cache_metrics")"
check "  ... and none at all for another account's cache, or none" "404 The account has no cache e2e-none" \
  "$(http GET /caches/e2e-none/metrics >/dev/null; status) $(jq -r .message "$work/body")"
cache_alarm="$(http POST /alarms '{"name": "e2e-sessions memory", "cacheName": "e2e-sessions", "metric": "BytesUsedForCache", "statistic": "Maximum", "period": 3600, "comparison": "GreaterThanThreshold", "threshold": 60000000, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}')"
check "an alarm watches its memory, an hour at a time, by its name" "201 e2e-sessions BytesUsedForCache 3600" "$(status) $(jq -r '"\(.cacheName) \(.metric) \(.period)"' <<<"$cache_alarm")"
# Billed by the hour of its memory, as ElastiCache bills a node: each hour sampled, 64 MB.
cache_month="$(http GET /usage | jq -c '.caches[] | select(.name == "e2e-sessions")')"
check "GET /usage has its hours this month, its memory and its GB-hours, 64 MB an hour" "$(env_q "SELECT count(*) FROM cache_samples WHERE cache_id = '$cache_id'") 64 true false" \
  "$(jq -r '"\(.hours) \(.memoryMb) \((.gbHours | tonumber) == .hours * 0.0625) \(.deleted)"' <<<"$cache_month")"
http DELETE /caches/e2e-sessions >/dev/null
check "a cache deleted: 204, then 404, gone from the server with its keys, its address answering no more" "204 404 404 true" \
  "$(status) $(http GET /caches/e2e-sessions >/dev/null; status) \
$(curl -s -o /dev/null -w '%{http_code}' --cacert "$work/cache-ca.crt" -H 'Authorization: Bearer ff-cache-dev' "https://$cache_address:6390/caches/$cache_server_name") \
$(cache_cli "$new_cache_url" PING | grep 'Could not connect' >/dev/null && echo true || echo false)"
check "  ... its alarm with it; its month's usage kept, as a deleted cache's" "404 true" \
  "$(http GET "/alarms/$(jq -r .id <<<"$cache_alarm")" >/dev/null; status) $(http GET /usage | jq -r '.caches[] | select(.name == "e2e-sessions") | .deleted')"
}
section_def caches_sampled section_caches_sampled caches budget=5

section_sites_counted() {
section "queues and sites, minutes on: the queue's alarm fired, the messages and the visits counted; then all deleted"
# The two messages the queues' section left waiting, under their alarm, and the site's visits, each sampled or counted
# a minute at a time: by now they have been; run alone, they are waited for, as long as before.
for _ in $(seq 150); do [ "$(http GET "/alarms/$waiting_alarm" | jq -r .state)" = ALARM ] && break; sleep 1; done
check "the alarm fires once a minute has sampled the two messages waiting, naming the queue" "ALARM e2e-waiting true" \
  "$(http GET "/alarms/$waiting_alarm" | jq -r '"\(.state) \(.queueName) \(.stateReason | test("breaching ApproximateNumberOfMessagesVisible Maximum > 1"))"')"
site_visits() { env_q "SELECT coalesce(sum(requests), 0) || ' ' || coalesce(sum(gets), 0) || ' ' || coalesce(sum(bytes_out), 0) FROM storage_request_counts WHERE name = 'e2e-site' AND class = 'website'"; }
# Each minute, the website server writes the minutes that are over, as the front door does: the visits within two.
for _ in $(seq 150); do [ "$(site_visits | cut -d' ' -f1)" -ge 12 ] && break; sleep 1; done
check "the site's visits counted in its minutes once written, apart from S3's requests, with what they sent" "true true" \
  "$(site_visits | awk '{ print ($1 >= 12 && $2 >= 10) ? "true" : "false", ($3 > 0) ? "true" : "false" }')"
since="$(date -u -d '-1 hour' +%Y-%m-%dT%H:00:00Z)"
check "its metrics, as CloudWatch names a CloudFront distribution's: the visits and their bytes, and a share of them answered 4xx" "true true true" \
  "$(http GET "/buckets/e2e-site/website/metrics?period=3600&start=$since" | jq -r '"\([.metrics.Requests.Sum[]] | add >= 12) \([.metrics.BytesDownloaded.Sum[]] | add > 0) \([.metrics."4xxErrorRate".Average[] | select(. != null)] | max > 0)"')"
http DELETE "/buckets/e2e-site?force=true" >/dev/null
check "the site's domain gone with its bucket: it answers nothing there" "404 0" \
  "$(at_domain docs.e2e-customer.tn) $(env_q "SELECT count(*) FROM custom_domains WHERE domain = 'docs.e2e-customer.tn'")"
since="$(date -u -d '-1 hour' +%Y-%m-%dT%H:00:00Z)"
for _ in $(seq 90); do [ "$(http GET "/queues/e2e-waiting/metrics?period=3600&start=$since" | jq '[.metrics.NumberOfMessagesSent.Sum[]] | add')" = 2 ] && break; sleep 1; done
check "its metrics, as CloudWatch names SQS's: the two messages sampled waiting, the two sent as counted, three bytes each at most" "2 2 3" \
  "$(http GET "/queues/e2e-waiting/metrics?period=3600&start=$since" | jq -r '"\([.metrics.ApproximateNumberOfMessagesVisible.Maximum[]] | max) \([.metrics.NumberOfMessagesSent.Sum[]] | add) \([.metrics.SentMessageSize.Maximum[] | select(. != null)] | max)"')"
for queue in e2e-removals e2e-batch e2e-batch-dlq e2e-cli-orders e2e-fn-orders e2e-fn-records e2e-waiting; do aws_sqs delete-queue --queue-url "$sqs_endpoint/$tenant/$queue"; done
check "  ... the alarm gone with its queue" 404 "$(http GET "/alarms/$waiting_alarm" >/dev/null; status)"
as_other_sqs aws_sqs delete-queue --queue-url "$other_url"
check "the queues deleted, their messages with them" "0 0" \
  "$(env_q "SELECT count(*) FROM queues WHERE kind = 'customer'") $(env_q "SELECT count(*) FROM queue_messages m JOIN queues q ON q.id = m.queue_id WHERE q.kind = 'customer'")"
http DELETE "/storage-keys/$queue_key_id" >/dev/null
}
section_def sites_counted section_sites_counted sites budget=45

section_usage_records() {
section "usage records (P-20)"
meter='export async function handler(event: { sleepMs?: number; fail?: boolean }, context: { awsRequestId: string }) {
  if (event.sleepMs) await new Promise((resolve) => setTimeout(resolve, event.sleepMs));
  if (event.fail) throw new Error("failed on purpose");
  return { requestId: context.awsRequestId };
}'
created="$(http POST /functions "$(jq -n --arg code "$meter" '{name: "e2e-meter", runtime: "nodejs", code: $code, memory: 128, timeout: 3}')")"
check "create returns 201" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
meter_id="$(jq -r .id <<<"$created")"

# A cold start first: no instance left, as after the idle window. Before any call, so the backend's
# autoscaler, which steps up a function that had calls in the last minute, leaves it at zero.
kubectl -n "$tenant_ns" scale deployment "fn-$meter_id" --replicas=0 >/dev/null
for _ in $(seq 1 90); do
  [ -z "$(kubectl -n "$tenant_ns" get pods -l "ff.dev/function-id=$meter_id" -o name 2>/dev/null)" ] && break
  sleep 1
done
check "scaled to zero: no instance left" "" "$(kubectl -n "$tenant_ns" get pods -l "ff.dev/function-id=$meter_id" -o name 2>/dev/null)"
cold="$(http POST "/functions/$meter_id/invoke" '{"input":{}}' | jq -r .id)"
check "a call that started an instance: its cold start is recorded, and not billed" "success t t" \
  "$(q "SELECT status, init_ms > 0, billed_ms < init_ms FROM usage_records WHERE request_id = '$cold'")"

invoked="$(http POST "/functions/$meter_id/invoke" '{"input":{}}')"
inv="$(jq -r .id <<<"$invoked")"
check "the runtime got the invocation's ID as its request ID" "201 $inv" "$(status) $(jq -r .output.requestId <<<"$invoked")"
check "the runtime's log names the call by that ID" true \
  "$(kubectl -n "$tenant_ns" logs "deployment/fn-$meter_id" 2>/dev/null | grep "START RequestId: $inv" >/dev/null && echo true || echo false)"
check "its usage record: a success, the function's memory and minInstances (P-30), billed its duration rounded up" "success 128 0 t" \
  "$(q "SELECT status, memory_mb, min_instances, billed_ms = ceil(duration_ms) FROM usage_records WHERE request_id = '$inv'")"
check "and the history's start and end, to the millisecond, and its duration" "t t t" \
  "$(q "SELECT u.started_at = date_trunc('milliseconds', i.created_at), u.ended_at = date_trunc('milliseconds', i.updated_at),
               u.duration_ms = round(i.duration::numeric, 3)
          FROM usage_records u JOIN function_invocations i ON i.id = u.request_id WHERE u.request_id = '$inv'")"

http POST "/functions/$meter_id/invoke" '{"input":{"fail":true}}' >/dev/null
check "a function's error answers 400" 400 "$(status)"
check "its record: an error, billed its duration rounded up; the history has the runtime's memory measure too" "error t t" \
  "$(q "SELECT u.status, u.billed_ms = ceil(u.duration_ms), i.memory_used > 0
          FROM usage_records u JOIN function_invocations i ON i.id = u.request_id WHERE i.function_id = '$meter_id' AND i.status = 'ERROR'")"
http POST "/functions/$meter_id/invoke" '{"input":{"sleepMs":5000}}' >/dev/null
check "a timeout answers 400" 400 "$(status)"
check "its record: a timeout, billed the function's timeout" "timeout 3000" \
  "$(q "SELECT u.status, u.billed_ms FROM usage_records u JOIN function_invocations i ON i.id = u.request_id
          WHERE i.function_id = '$meter_id' AND i.status = 'TIMEOUT'")"

# A call lost: the backend is killed while it waits for the answer.
be_pid="${e2e_pids[${#e2e_pids[@]}-1]}"
(http POST "/functions/$meter_id/invoke" '{"input":{"sleepMs":2500}}' >/dev/null 2>&1 || true) &
call_pid=$!
lost=""
for _ in $(seq 1 50); do
  lost="$(q "SELECT id FROM function_invocations WHERE function_id = '$meter_id' AND status = 'RUNNING'")"
  [ -n "$lost" ] && break
  sleep 0.2
done
check "a slow call is running" true "$([ -n "$lost" ] && echo true || echo false)"
kill -9 "$be_pid"
e2e_gone "$be_pid"
wait "$call_pid" 2>/dev/null || true
# Restarted at once, as a supervisor would, with a 1 s cold-start limit. Its reaper marks the call LOST once the longest
# a call can take has passed (2 × 3 s + the 1 s cold-start limit + 30 s), at the next run of the minute: read after the
# alarms' section, whose minutes pass meanwhile (usage_lost).
be_ready_timeout=1
e2e_start_backend "$work/backend-restarted.log" "$api" "${be_env[@]}" "${alarm_env[@]}" K8S_READY_TIMEOUT_SECONDS="$be_ready_timeout"
restarted_pid="${e2e_pids[${#e2e_pids[@]}-1]}" # the processes started after it come after it
}
section_def usage_records section_usage_records backend budget=70

section_alarms() {
section "alarms: an error fires an alarm, a quiet minute recovers it, each change told to a webhook"
receiver_port="$(free_port)"
cat >"$work/receiver.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        with open(sys.argv[2], 'a') as out:
            out.write(json.dumps({'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body}) + '\n')
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), Receiver).serve_forever()
PY
: >"$work/webhooks.jsonl"
python3 "$work/receiver.py" "$receiver_port" "$work/webhooks.jsonl" &
e2e_pids+=("$!")
failing='export async function handler(event: { fail?: boolean }) {
  if (event.fail) throw new Error("asked to fail");
  return { ok: true };
}'
alarmed_id="$(http POST /functions "$(jq -n --arg code "$failing" '{name: "e2e-alarmed", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
check "a function to watch" 201 "$(status)"
alarm_id="$(http POST /alarms "$(jq -cn --arg fn "$alarmed_id" --arg url "http://127.0.0.1:$receiver_port/ff" \
  '{name: "e2e errors", functionId: $fn, metric: "Errors", statistic: "Sum", period: 60, comparison: "GreaterThanThreshold", threshold: 0,
    evaluationPeriods: 1, datapointsToAlarm: 1, actions: {email: false, webhookUrls: [$url]}}')" | jq -r .id)"
check "an alarm on its errors, each minute, telling the receiver" "201 INSUFFICIENT_DATA" "$(status) $(jq -r .state "$work/body")"
# alarm_state_after <state> <seconds>: waits for the alarm to reach the state, then prints it.
alarm_state_after() {
  local state=""
  for _ in $(seq 1 "$2"); do
    state="$(http GET "/alarms/$alarm_id" | jq -r .state)"
    [ "$state" = "$1" ] && break
    sleep 1
  done
  echo "$state"
}
check "its first evaluation judges a quiet minute: OK, and tells nobody" "OK 0" "$(alarm_state_after OK 30) $(wc -l <"$work/webhooks.jsonl" | tr -d ' ')"
http POST "/functions/$alarmed_id/invoke" '{"input": {"fail": true}}' >/dev/null
check "the function fails" "400 Error: asked to fail" "$(status) $(jq -r .message "$work/body")"
check "once that minute is over, the alarm fires" "ALARM" "$(alarm_state_after ALARM 90)"
check "saying why" "1 of the last 1 period(s) of 60 s breaching Errors Sum > 0 (1 needed); latest 1" "$(http GET "/alarms/$alarm_id" | jq -r .stateReason)"
check "the next minute, quiet, recovers it" "OK" "$(alarm_state_after OK 90)"
for _ in $(seq 1 20); do [ "$(wc -l <"$work/webhooks.jsonl" | tr -d ' ')" -ge 2 ] && break; sleep 0.5; done
secret="$(http GET /notifications/webhook-secret | jq -r .secret)"
told="$(python3 - "$secret" "$work/webhooks.jsonl" <<'PY'
import hashlib, hmac, json, sys
secret, path = sys.argv[1], sys.argv[2]
for line in open(path):
    hook = json.loads(line)
    fields = [part.split('=', 1) for part in hook['headers']['ff-signature'].split(',')]
    t = dict(fields)['t']
    body = hook['body']
    signed = any(name == 'v1' and hmac.compare_digest(value, hmac.new(secret.encode(), f'{t}.{body}'.encode(), hashlib.sha256).hexdigest()) for name, value in fields)
    data = json.loads(body)['data']
    print(f"{data['previousState']}>{data['state']}:{'signed' if signed else 'unsigned'}", end=' ')
PY
)"
check "the receiver was told each change once, into ALARM and out of it, signed" "OK>ALARM:signed ALARM>OK:signed" "${told% }"
check "and the webhooks are among the account's deliveries, delivered" "2" \
  "$(http GET /notifications/deliveries | jq '[.[] | select(.kind == "alarm" and .status == "delivered")] | length')"
http DELETE "/alarms/$alarm_id" >/dev/null
check "the alarm is deleted" 204 "$(status)"
http DELETE "/functions/$alarmed_id" >/dev/null
}
section_def alarms section_alarms backend budget=185

section_usage_lost() {
section "usage records: the call lost, marked LOST by the restarted backend, read once its minute has passed"
# The reaper's minute has passed in the alarms' section; run alone, it is waited for, as long as before.
state=""
for _ in $(seq 1 120); do
  state="$(q "SELECT status FROM function_invocations WHERE id = '$lost'")"
  [ "$state" = LOST ] && break
  sleep 1
done
check "the restarted backend marks the call LOST" LOST "$state"
check "its record bills nothing" "lost 0 0.000" "$(q "SELECT status, billed_ms, duration_ms FROM usage_records WHERE request_id = '$lost'")"
check "the history says why" "Lost: the backend restarted during the call, so its answer is unknown. It isn't billed." \
  "$(http GET "/functions/$meter_id/invocations" | jq -r --arg id "$lost" '.invocations[] | select(.id == $id) | .error')"
check "one record per invocation, none without one" "5 5" \
  "$(q "SELECT (SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'), (SELECT count(*) FROM usage_records WHERE function_id = '$meter_id')")"
}
section_def usage_lost section_usage_lost usage_records budget=5

section_capacity() {
section "capacity samples (P-21)"
# The backends sampled every minute since the meter function was created: it has had a ready instance since its cold start.
check "a sample a minute of the warm function: its instances, memory, account and minInstances" "t 1 128 $tenant 0" \
  "$(q "SELECT count(*) > 0, min(instances), max(memory_mb), max(account_id), max(min_instances) FROM capacity_samples WHERE function_id = '$meter_id'")"
report="$(cd "$FF_REPO_ROOT/BE" && env "${e2e_base_env[@]}" npm run -s capacity:report -- --days 1 2>&1)"
check "the capacity report shows the account's day: capacity reserved, and capacity billed" true \
  "$(awk -v account="$tenant" '$2 == account && $3 != "0.000" && $5 != "0.000" { found = 1 } END { print found ? "true" : "false" }' <<<"$report")"
}
section_def capacity section_capacity usage_records budget=20

section_usage() {
section "usage API (P-22)"
month="$(date -u +%Y-%m)"
billed="status IN ('success', 'error', 'timeout')"
# Queues' requests are written a minute at a time: the queues sections' are by now, minutes after; waited for all the same.
for _ in $(seq 75); do
  [ "$(env_q "SELECT coalesce(sum(received), 0) FROM queue_request_counts WHERE account_id = '$tenant' AND name = 'e2e-batch'")" = 7 ] && break
  sleep 1
done
usage="$(http GET /usage)"
check "GET /usage answers this month, by the UTC calendar" "200 $month" "$(status) $(jq -r .month <<<"$usage")"
check "the meter function: requests billed, the lost call apart, billed duration and GB-s, exactly as its records" \
  "$(q "SELECT count(*) FILTER (WHERE $billed), count(*) FILTER (WHERE status = 'lost'), sum(billed_ms),
               trim_scale(sum(billed_ms::numeric * memory_mb) / 1024000) FROM usage_records WHERE function_id = '$meter_id'")" \
  "$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | "\(.requests) \(.lost) \(.billedMs) \(.gbSeconds)"' <<<"$usage")"
check "the account's totals are its records' own sums" \
  "$(q "SELECT count(*) FILTER (WHERE $billed), sum(billed_ms), trim_scale(sum(billed_ms::numeric * memory_mb) / 1024000)
          FROM usage_records WHERE account_id = '$tenant' AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")" \
  "$(jq -r '.totals | "\(.requests) \(.billedMs) \(.gbSeconds)"' <<<"$usage")"
# Its two calls: handler's, then lambda_handler's.
check "the Python function, deleted earlier, keeps its usage, marked deleted" "true 2" \
  "$(jq -r --arg id "$id" '.functions[] | select(.functionId == $id) | "\(.deleted) \(.requests)"' <<<"$usage")"
check "the database, deleted earlier, keeps its month: its hours sampled and GB-months, at nothing before the book that prices databases" "true e2e-orders true true 0.000" \
  "$(jq -r --arg id "$db_id" '.databases[] | select(.databaseId == $id) | "\(.deleted) \(.name) \(.hours >= 1) \((.gbMonths | tonumber) > 0) \(.cost)"' <<<"$usage")"
photos_requests="$(env_q "SELECT coalesce(sum(requests) FILTER (WHERE class = 'tier1'), 0) || ' ' || coalesce(sum(requests) FILTER (WHERE class = 'tier2'), 0)
                           FROM storage_request_counts WHERE bucket_id = '$photos_id'")"
# The bytes its requests sent out and brought in, every request's: its files were uploaded and read, so neither is 0.
photos_bytes="$(env_q "SELECT coalesce(sum(bytes_out), 0) || ' ' || coalesce(sum(bytes_in), 0) FROM storage_request_counts WHERE bucket_id = '$photos_id'")"
# Its GB-months as its samples give them: what it held each hour, over the month's hours, 1 GB being 2^30 bytes, to six decimals.
photos_gb="$(env_q "SELECT trim_scale(round(coalesce(sum(size_bytes), 0)::numeric / 1073741824
                      / (extract(epoch FROM date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month' - date_trunc('month', now() AT TIME ZONE 'UTC')) / 3600), 6))
                      FROM bucket_samples WHERE bucket_id = '$photos_id'")"
check "the bucket, deleted earlier, keeps its month: its hours measured, GB-months, its requests by S3's two classes and its bytes as counted, at nothing before the book that prices buckets" \
  "true e2e-photos true $photos_gb $photos_requests $photos_bytes true 0.000" \
  "$(jq -r --arg id "$photos_id" '.buckets[] | select(.bucketId == $id) | "\(.deleted) \(.name) \(.hours >= 1) \(.gbMonths) \(.tier1Requests) \(.tier2Requests) \(.bytesDownloaded) \(.bytesUploaded) \(.bytesDownloaded > 0 and .bytesUploaded > 0) \(.cost)"' <<<"$usage")"
csv="$(curl -sS -H 'accept: text/csv' -D "$work/headers" "$api/usage?month=$month")"
check "as CSV: a download, its header, the meter function's line, the database's and the bucket's" \
  "text/csv; charset=utf-8|kind,id,name,deleted,requests,billed_ms,gb_seconds,gb_months,tier1_requests,tier2_requests,bytes_downloaded,bytes_uploaded,attachment_bytes,throttled,platform_errors,lost,cost|true|true|true" \
  "$(tr -d '\r' <"$work/headers" | awk -F': ' 'tolower($1) == "content-type" { print $2 }')|$(head -1 <<<"$csv" | tr -d '\r')|$(grep -q "^function,$meter_id,e2e-meter,false,4," <<<"$csv" && echo true || echo false)|$(tr -d '\r' <<<"$csv" | grep -E "^database,$db_id,e2e-orders,true,,,,[0-9.]+,,,,,,,,,0\.000$" >/dev/null && echo true || echo false)|$(tr -d '\r' <<<"$csv" | grep -E "^bucket,$photos_id,e2e-photos,true,,,,[0-9.]+,${photos_requests/ /,},${photos_bytes/ /,},,,,,0\.000$" >/dev/null && echo true || echo false)"
cli_queue_id="$(env_q "SELECT DISTINCT queue_id FROM queue_request_counts WHERE account_id = '$tenant' AND name = 'e2e-cli-orders'")"
cli_counted="$(env_q "SELECT sum(requests) || ' ' || sum(sent) || ' ' || sum(received) FROM queue_request_counts WHERE queue_id = '$cli_queue_id'")"
check "the AWS CLI's queue, deleted earlier, keeps its month: its requests as SQS bills them, its messages sent and received, as counted, at nothing before the book that prices queues" \
  "true e2e-cli-orders $cli_counted 0.000" \
  "$(jq -r --arg id "$cli_queue_id" '.queues[] | select(.queueId == $id) | "\(.deleted) \(.name) \(.requests) \(.messagesSent) \(.messagesReceived) \(.cost)"' <<<"$usage")"
check "  ... in the CSV, its requests in the requests column" true \
  "$(tr -d '\r' <<<"$csv" | grep -E "^queue,$cli_queue_id,e2e-cli-orders,true,${cli_counted%% *},,,,,,,,,,,,0\.000$" >/dev/null && echo true || echo false)"
check "a function's batches counted as received: the five, then the two again; the three handled deleted" "7 3" \
  "$(env_q "SELECT sum(received) || ' ' || sum(deleted) FROM queue_request_counts WHERE account_id = '$tenant' AND name = 'e2e-batch'")"
empty="$(http GET '/usage?month=2001-01')"
check "a month without calls is empty, and before the first price book, unpriced" "200 0 0 null" \
  "$(status) $(jq -r '"\(.functions | length) \(.totals.requests) \(.estimate)"' <<<"$empty")"
http GET '/usage?month=2026-13' >/dev/null
check "a month that is not YYYY-MM is refused" "400 month must be a month as YYYY-MM, such as 2026-10" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
}
section_def usage section_usage usage_lost python databases_sampled sites_counted buckets budget=5

section_priced() {
section "usage priced (P-30)"
book="$(q "SELECT id FROM price_books ORDER BY valid_from LIMIT 1")"
check "the month is priced in TND, with the first price book" "TND $book" "$(jq -r '.estimate | "\(.currency) \(.priceBooks | join(","))"' <<<"$usage")"
check "the meter function's cost: its billed requests and GB-s at the book's prices, rounded to the millime" \
  "$(q "SELECT round(count(*) * (b.prices->'prices'->>'requestsPerMillion')::numeric / 1000000
                     + sum(u.billed_ms::numeric * u.memory_mb) / 1024000 * (b.prices->'prices'->'gbSecond'->0->>'price')::numeric, 3)
          FROM usage_records u, price_books b WHERE u.function_id = '$meter_id' AND u.$billed AND b.id = '$book' GROUP BY b.prices")" \
  "$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | .cost' <<<"$usage")"
check "the free tier covers the month: usage, the free tier taking it all off, and nothing to pay" "true 0.000" \
  "$(jq -r '.estimate | "\((.usage | tonumber) + (.freeTier | tonumber) == 0) \(.total)"' <<<"$usage")"
check "and the CSV has each function's cost" true \
  "$(tr -d '\r' <<<"$csv" | grep "^function,$meter_id,e2e-meter,false,4,.*,$(jq -r --arg id "$meter_id" '.functions[] | select(.functionId == $id) | .cost' <<<"$usage")$" >/dev/null && echo true || echo false)"
}
section_def priced section_priced usage budget=5

section_rating() {
section "the hourly rating (P-32)"
# As it started, and each minute since, the backend rated every hour since the first book that had settled: ended
# long enough ago that no call in it can still be recorded, two of the platform's longest timeouts (900 s), the cold
# start it allows, 30 s and a minute. 33 minutes with the default 90 s cold start; 31 min 31 s for the backend
# usage_records restarted with 1 s, which answers here in a whole run.
settle=$((2 * 900 + be_ready_timeout + 30 + 60))
balance="$(http GET /billing/balance)"
rated_until="$(jq -r .ratedUntil <<<"$balance")"
settled="$(date -u -d "@$(( ($(date -u +%s) - settle) / 3600 * 3600 ))" +%Y-%m-%dT%H:%M:%S.000Z)"
previous="$(date -u -d "@$(( ($(date -u +%s) - settle) / 3600 * 3600 - 3600 ))" +%Y-%m-%dT%H:%M:%S.000Z)"
check "the balance: nothing charged, in shadow mode, rated up to the last hour settled (or the one before, if one just settled)" "200 0.000 TND true 0.000 true" \
  "$(status) $(jq -r '"\(.balance) \(.currency) \(.shadowMode) \(.charged)"' <<<"$balance") $([ "$rated_until" = "$settled" ] || [ "$rated_until" = "$previous" ] && echo true || echo false)"
check "every hour from the first book on rated, once, none skipped, in shadow mode" "t t t t" \
  "$(q "SELECT count(*) = count(DISTINCT hour), count(*) = extract(epoch FROM max(hour) - min(hour)) / 3600 + 1,
               min(hour) = (SELECT min(valid_from) FROM price_books), bool_and(shadow) FROM rating_runs")"
check "no transaction moved the balance: no debit in shadow mode" "200 0" "$(http GET /billing/transactions >/dev/null; status) $(jq '.transactions | length' "$work/body")"
reconciliation="$(cd "$FF_REPO_ROOT/BE" && env "${e2e_base_env[@]}" npm run -s billing:reconcile 2>&1)" || true
check "the reconciliation runs against the database: nobody used anything in the hours rated" "No account used anything." \
  "$(tail -1 <<<"$reconciliation")"
}
section_def rating section_rating backend budget=10

section_balance() {
section "the balance check (P-33)"
# As an operator sets them in the admin dashboard (P-70); e2e has no operator, so SQL. No buffer, no grace period.
sql "INSERT INTO platform_settings (key, value) VALUES ('billingShadowMode', 'false'), ('negativeBuffer', '\"0.000\"'), ('gracePeriodHours', '0')"
# move <account> <millimes> <kind> <FF's account> <key>: a balanced ledger transaction, as the rating (usage) or a payment (topup) writes it.
move() {
  sql "INSERT INTO ledger_accounts (account_id, type, currency) VALUES ('$1', 'wallet', 'TND') ON CONFLICT DO NOTHING;
       INSERT INTO ledger_accounts (type, currency) VALUES ('$4', 'TND') ON CONFLICT DO NOTHING;
       WITH t AS (INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('$3', '$5') RETURNING id)
       INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
       SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN $2 ELSE -($2) END FROM t, ledger_accounts a
        WHERE a.currency = 'TND' AND (a.account_id = '$1' OR (a.account_id IS NULL AND a.type = '$4'))"
}
move "$tenant" -500 usage revenue "e2e:usage"
invocations="$(q "SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'")"
http POST "/functions/$meter_id/invoke" '{"input":{}}' >/dev/null
check "a wallet run below zero, with no buffer and no grace period: invokes answer 402" "402 InsufficientCreditException" \
  "$(status) $(jq -r .message "$work/body" | cut -d: -f1)"
check "and the refused call left no invocation" "$invocations" "$(q "SELECT count(*) FROM function_invocations WHERE function_id = '$meter_id'")"
check "the balance says invokes stopped" "200 -0.500 stopped" "$(http GET /billing/balance >/dev/null; status) $(jq -r '"\(.balance) \(.credit.state)"' "$work/body")"
http GET "/functions/$meter_id" >/dev/null
check "reads go on" 200 "$(status)"
move "$tenant" 1000 topup provider_clearing "e2e:topup"
http POST "/functions/$meter_id/invoke" '{"input":{}}' >/dev/null
check "a top-up lets them in again at once: the ledger's NOTIFY refreshed the backend's cached balance" 201 "$(status)"
sql "DELETE FROM platform_settings WHERE key IN ('billingShadowMode', 'negativeBuffer', 'gracePeriodHours')"
}
section_def balance section_balance usage_records budget=5

section_monitoring() {
section "the operator's monitoring: readiness, the metrics on their own port, the log in JSON"
http GET /readyz >/dev/null
check "/readyz: ready, the database and the cluster both answering" "200 ready ok ok" \
  "$(status) $(jq -r '"\(.status) \(.checks.database) \(.checks.kubernetes)"' "$work/body")"
check "the API's own GET /metrics is the account's metrics, never the operator's" "200 0" \
  "$(http GET /metrics >/dev/null; status) $(grep -c 'ff_invocations_total' "$work/body")"
curl -s "http://$metrics_host:$metrics_port/metrics" >"$work/metrics"
# metric <name{labels}>: its value since the backend restarted, or 0 when it has none.
metric() { awk -v m="$1" '$1 == m {print $2; found = 1} END {if (!found) print 0}' "$work/metrics"; }
check "counted since the restart: the call it marked lost, and the one refused for the account's credit" "1 1" \
  "$(metric 'ff_invocations_total{outcome="lost"}') $(metric 'ff_invocations_refused_total{reason="credit"}')"
check "the call that failed, and the API's answers by class" "true true true" \
  "$([ "$(metric 'ff_invocations_total{outcome="error"}')" -ge 1 ] && echo true || echo false) \
$([ "$(metric 'ff_http_responses_total{class="2xx"}')" -gt 0 ] && echo true || echo false) \
$([ "$(metric 'ff_http_responses_total{class="4xx"}')" -gt 0 ] && echo true || echo false)"
check "the alarm into ALARM once and into OK twice; the two webhooks delivered; none pending" "1 2 2 0" \
  "$(metric 'ff_alarm_state_changes_total{state="ALARM"}') $(metric 'ff_alarm_state_changes_total{state="OK"}') \
$(metric 'ff_notification_attempts_total{channel="webhook",result="delivered"}') $(metric ff_notification_deliveries_pending)"
check "the rating's lag, the process's memory and its event loop" "3" \
  "$(grep -cE '^(ff_rating_lag_seconds|ff_backend_process_resident_memory_bytes|ff_backend_nodejs_eventloop_lag_seconds) ' "$work/metrics")"
check "the backend's log: one JSON object a line, each with its time, level and message; the lost call a warning of the usage service; queries naming their request" \
  "True warn UsageService True" "$(python3 - "$work/backend-restarted.log" <<'PY'
import json, sys
# The backend still runs: its last line may be half written, so only whole lines are read.
lines = [json.loads(line) for line in open(sys.argv[1]) if line.endswith('\n') and line.strip()]
lost = [line for line in lines if line['message'].startswith('Marked 1 invocation(s) LOST')]
# Development logs every query: those run for a request carry its ID, through TypeORM's own asynchronous work.
queries = [line for line in lines if line.get('context') == 'TypeORM' and line['message'].startswith('query:')]
print(bool(lines) and all({'time', 'level', 'message'} <= line.keys() for line in lines), *(lost and [lost[0]['level'], lost[0].get('context')]),
      any('requestId' in line for line in queries))
PY
)"
}
section_def monitoring section_monitoring backend budget=5

section_lost_images() {
section "code images the registry lost, made again (CLI plan, C-29)"
node="k3d-$FF_CLUSTER_NAME-server-0"
registry="http://127.0.0.1:$FF_REGISTRY_PORT"
small_ns="$(tenant_namespace "$small")"
# code_image_in <namespace> <function>: the code image its pods mount. repository_of <image>: its repository.
code_image_in() { kubectl -n "$1" get deployment "fn-$2" -o jsonpath='{.spec.template.spec.volumes[?(@.name=="code")].image.reference}'; }
repository_of() { local path="${1#*/}"; echo "${path%@*}"; }
# layer_status <image> <layer>: what the registry answers for the image's layer. on_node <image>: whether the node has it.
layer_status() { curl -s -o /dev/null -w '%{http_code}' -I "$registry/v2/$(repository_of "$1")/blobs/$2"; }
on_node() { docker exec "$node" crictl inspecti "$1" >/dev/null 2>&1 && echo true || echo false; }
meter_image="$(code_image_of "$meter_id")"
meter_layer="$(curl -s -H 'accept: application/vnd.oci.image.manifest.v1+json' "$registry/v2/$(repository_of "$meter_image")/manifests/${meter_image##*@}" | jq -r '.layers[0].digest')"
small_image="$(code_image_in "$small_ns" "$small_id")"
# Neither function has a pod, nor the node a copy of their images, as a node that never pulled them.
kubectl -n "$tenant_ns" scale deployment "fn-$meter_id" --replicas=0 >/dev/null
kubectl -n "$small_ns" scale deployment "fn-$small_id" --replicas=0 >/dev/null
kubectl -n "$tenant_ns" wait --for=delete pod -l "ff.dev/function-id=$meter_id" --timeout=120s >/dev/null 2>&1 || true
kubectl -n "$small_ns" wait --for=delete pod -l "ff.dev/function-id=$small_id" --timeout=120s >/dev/null 2>&1 || true
for image in "$meter_image" "$small_image"; do docker exec "$node" crictl rmi "$image" >/dev/null 2>&1 || true; done
# The registry loses the meter function's layer and keeps its manifest, as a disk that lost a file would.
curl -s -o /dev/null -X DELETE "$registry/v2/$(repository_of "$meter_image")/blobs/$meter_layer"
# The other function's pods name an image the registry never had, as one an earlier backend made, lost since.
lost_image="${small_image%@*}@sha256:$(printf '0%.0s' $(seq 1 64))"
kubectl -n "$small_ns" patch deployment "fn-$small_id" \
  -p "{\"spec\":{\"template\":{\"spec\":{\"volumes\":[{\"name\":\"code\",\"image\":{\"reference\":\"$lost_image\"}}]}}}}" >/dev/null
check "the registry lost a layer of the meter function's image; the node has neither image; the other function names a lost one" \
  "404 false false $lost_image" \
  "$(layer_status "$meter_image" "$meter_layer") $(on_node "$meter_image") $(on_node "$small_image") $(code_image_in "$small_ns" "$small_id")"
# Restarted, as the runbook says after losing the registry: the retention job runs at the backend's start.
kill "$restarted_pid"
e2e_gone "$restarted_pid"
be_ready_timeout=90
e2e_start_backend "$work/backend-restored.log" "$api" "${be_env[@]}" "${alarm_env[@]}"
restored=""
for _ in $(seq 1 180); do
  restored="$(grep -o 'Lost code images restored: [^"]*' "$work/backend-restored.log" | head -1 || true)"
  [ -n "$restored" ] && break
  sleep 1
done
check "the restarted backend restores them at once, and says what it did" \
  "1 image(s) made again, 0 zip(s) made again of inline code; 1 function(s) rolled out with their image; 0 failure(s)" "${restored#*in use, }"
check "the meter function's image whole again, by the digest its pods name" "200 $meter_image" \
  "$(layer_status "$meter_image" "$meter_layer") $(code_image_of "$meter_id")"
kubectl -n "$tenant_ns" scale deployment "fn-$meter_id" --replicas=1 >/dev/null
check "a new pod of it starts on the node, which had no copy: pulled from the registry" "true true" \
  "$(kubectl -n "$tenant_ns" rollout status deployment "fn-$meter_id" --timeout=120s >/dev/null 2>&1 && echo true || echo false) $(on_node "$meter_image")"
check "the other function rolled out with its package's image, which its new pod pulled; its record as it was" "$small_image true true ACTIVE" \
  "$(code_image_in "$small_ns" "$small_id") $(kubectl -n "$small_ns" rollout status deployment "fn-$small_id" --timeout=120s >/dev/null 2>&1 && echo true || echo false) $(on_node "$small_image") $(as_small GET "/functions/$small_id" | jq -r .status)"
}
section_def lost_images section_lost_images plans usage_records budget=35

sections_run
checks_done e2e
