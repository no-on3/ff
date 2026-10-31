#!/usr/bin/env bash
# L3 for the ff command: the built binary against the whole stack, as a developer runs it:
#   PostgreSQL + S3 (compose project "ff-cli-e2e", ports 55436 / 59007) + the k3d dev cluster
#   + the backend (built, started on a free port in development mode, which acts as the account
#   a profile names, as hack/e2e.sh's requests do).
# For examples/hello.ts and examples/hello.py: deploy, invoke, the handler's line in ff logs and
# in ff logs --follow, an asynchronous call and a dry run, deploy again unchanged, scale, update, history, delete. A Python function that raises, and examples/slow.py past its timeout,
# exit 5 with the call's ID, which the history shows, the Python one's calls that don't wait set
# by ff async-config to go on to another function; code that fails to load exits 4, and the
# function is kept, in ERROR, with its error. A second account finds none of the first's. Then
# ff init for both runtimes, its folder run locally, deployed and invoked; folders deployed as
# packages with their libraries (an npm library, requests, numpy's native wheels from
# pyproject.toml, bcrypt's native module), uploaded once, one built in Docker with --container,
# an ES module named by --handler with .ffignore, and TypeScript compiled for AWS Lambda by
# ff package --compile, whose zip runs on FF as it is; the small app (examples/orders-app), its
# functions writing to a database of its own as one on the internet would be
# (hack/k8s/app-database.sh), in an account whose internet access is on; ff db, with the run's own
# server of customers' databases: one made, its string a function's secret, the app writing its
# order there with its account's internet access off, read with psql, a new password, its month
# in ff usage, then deleted; ff buckets: one made, a key whose secret ff prints once as the
# variables AWS's tools read, the AWS CLI uploading with them alone, what the bucket held at its
# measure and its month in ff usage, the export kit's s3-sync.sh copying it out to a folder and on
# to another bucket as to AWS S3, the bucket emptied when told, the key revoked; ff sites: a built folder deployed
# with a deploy's own key, visited as a single-page app, deployed again changed, its visits in its metrics, a domain of
# the customer's added, the bucket no site again; ff queues: a queue made
# with its attributes and a dead-letter queue by name, a message sent by ff and received by the AWS CLI
# with a key naming that queue alone, received again by ff until the third receive moves it to the
# dead-letter queue, where ff receives and deletes it, a purge, attributes changed and seen by the AWS
# CLI, its metrics, the queue deleted and the other account seeing none, its month in ff usage; the getting-started
# guide's walkthrough of the small app on FF alone, internet access off: its orders in FF's database,
# the latest kept in FF's cache, each one put in a queue with the function's own key, read by a function
# that writes its receipt to a bucket and e-mails it through the SES endpoint from an address proved by its
# link, the receipt read back by a GET and by the AWS CLI, both gone after the night 90 days on, called
# without waiting as its schedule calls it; its page a site, which the function URL's CORS lets in; and ff local, in
# Docker: both runtimes, a failed load, a timeout, a call over its memory, and ff local start
# answering on its port until Ctrl-C, no container left behind.
# Removes its compose project, its namespaces and the backend on exit; keeps the cluster. Its sections run alone
# too, with what they need (hack/lib/sections.sh): --list names them, --only and --from choose.
#   hack/cli-e2e.sh [--list | --only <section>[,<section>…] | --from <section>]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-cli-e2e
E2E_NAME=cli-e2e
export FF_PG_PORT="${FF_CLI_E2E_PG_PORT:-55436}"
export FF_S3_PORT="${FF_CLI_E2E_S3_PORT:-59007}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
source "$FF_REPO_ROOT/hack/lib/sections.sh"
sections_options "$@"
set -- "${sections_rest[@]}"

be_port="$(free_port)"
api="http://127.0.0.1:$be_port"
account_a="$(random_account)"
account_b="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_a")" "$(tenant_namespace "$account_b")")

# What more than one section uses: ff, its output kept.

# ff <args...>: its stdout in $work/out, its stderr in $work/err, its exit code in $work/code.
ff() {
  local code=0
  "$ff_bin" "$@" >"$work/out" 2>"$work/err" || code=$?
  echo "$code" >"$work/code"
}

out() { cat "$work/out"; }
err() { cat "$work/err"; }
code() { cat "$work/code"; }

section_stack() {
section "the stack: its database and object storage, the cluster, customers' database, cache and mail servers"
e2e_dependencies
e2e_cluster
# This machine as the cluster's pods see it, the gateway of the cluster's Docker network: functions reach the S3 front
# door there with their own keys, at an IP address, where AWS's SDKs address buckets path-style by themselves.
cluster_gateway="$(docker network inspect "k3d-$FF_CLUSTER_NAME" --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | awk '{print $1}')"
# Customers' databases (ADR 0008): the run's own server, on 10.199.3.0/24, which no other run uses.
data_db_address=10.199.3.10
e2e_data_db 10.199.3.0/24 "$data_db_address"
# Customers' caches and mail (ADR 0013, 0012): the run's own servers, beside it, the mail handed to a stand-in for
# recipients' servers, which keeps it.
e2e_cache 10.199.3.11
e2e_mail 10.199.3.12 10.199.3.13
}
section_def stack section_stack

section_backend() {
section "ff and the backend"
(cd "$FF_REPO_ROOT/cli" && cargo build --release --locked -q)
ff_bin="$FF_REPO_ROOT/cli/target/release/ff"
e2e_build
# Function URLs on a port of their own, each at http://<id>.fn.localhost:<port>/, which ff reaches on 127.0.0.1.
url_port="$(free_port)"
# Buckets' S3 front door on another, at http://s3.localhost:<port>.
storage_port="$(free_port)"
# Queues' SQS endpoint on a third, at http://localhost:<port>, which the AWS CLI reaches with a key of the account's,
# and functions with their own at the cluster's gateway.
sqs_port="$(free_port)"
# Buckets' sites on a fourth, each at http://<bucket>.site.localhost:<port>, which curl takes to this machine.
website_port="$(free_port)"
# Mail's SES endpoint on a fifth, at http://localhost:<port>, which functions reach with their own keys at the
# cluster's gateway; FF's own mail, the links that prove addresses among it, goes to the backend's log.
ses_port="$(free_port)"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a"
  FF_FUNCTION_URL_PORT="$url_port" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port"
  FF_STORAGE_PORT="$storage_port" FF_STORAGE_BASE="http://s3.localhost:$storage_port"
  FF_STORAGE_FUNCTION_ENDPOINT="http://$cluster_gateway:$storage_port" FF_STORAGE_FUNCTION_CIDRS="$cluster_gateway/32"
  FF_SQS_PORT="$sqs_port" FF_SQS_BASE="http://localhost:$sqs_port"
  FF_SQS_FUNCTION_ENDPOINT="http://$cluster_gateway:$sqs_port" FF_SQS_FUNCTION_CIDRS="$cluster_gateway/32"
  FF_WEBSITE_PORT="$website_port" FF_WEBSITE_BASE="http://site.localhost:$website_port"
  FF_SES_PORT="$ses_port" FF_SES_BASE="http://localhost:$ses_port"
  FF_SES_FUNCTION_ENDPOINT="http://$cluster_gateway:$ses_port" FF_SES_FUNCTION_CIDRS="$cluster_gateway/32"
  "${e2e_data_db_env[@]}" "${e2e_cache_env[@]}" "${e2e_mail_env[@]}")
e2e_migrate "${be_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"

# ff's settings in a folder of the test's, and none of the caller's: profile default acts as account A, b as account B.
export FF_CONFIG_DIR="$work/ff"
unset FF_TOKEN FF_ENDPOINT FF_ACCOUNT FF_PROFILE
rm -rf "$FF_CONFIG_DIR"
# A file's SHA-256 in base64 and its size, as AWS Lambda's CodeSha256 and CodeSize give a function's code.
file_facts() { python3 -c 'import base64, hashlib, sys; code = open(sys.argv[1], "rb").read(); print(base64.b64encode(hashlib.sha256(code).digest()).decode(), len(code))' "$1"; }

ff config set endpoint "$api"
ff config set dev_account "$account_a"
ff config set endpoint "$api" --profile b
ff config set dev_account "$account_b" --profile b
ff whoami --output json
check "ff whoami: development mode, acting as account A" "0 $account_a" "$(code) $(out | jq -r '.accounts[0].id')"

for example in hello.ts hello.py; do
  name="cli-${example/./-}"
  runtime=nodejs
  [ "${example##*.}" = py ] && runtime=python
  section "$example, as $name"
  ff deploy "$FF_REPO_ROOT/examples/$example" --name "$name"
  check "deploy creates it, live" "0 created $name ($runtime, 128 MB, 5 s): ACTIVE" "$(code) $(out | sed 's/ in [0-9.]* s$//')"
  ff invoke "$name" --data '{"name": "Tunis"}'
  request_id="$(out | tail -1 | cut -d' ' -f2)"
  check "invoke prints the answer, and the request ID the function saw" "0 Hello Tunis $request_id" \
    "$(code) $(out | sed '$d' | jq -r '"\(.message) \(.requestId)"')"
  # The handler's print reaches the log store within seconds, under the call's request ID.
  found=false
  for _ in $(seq 1 30); do
    ff logs "$name" --request-id "$request_id"
    if out | grep ' greeting Tunis$' >/dev/null; then
      found=true
      break
    fi
    sleep 1
  done
  check "ff logs shows the handler's line, found by the call's request ID" true "$found"
  "$ff_bin" logs "$name" --follow --tail 1 --output json >"$work/follow.out" 2>"$work/follow.err" &
  follower=$!
  sleep 2
  ff invoke "$name" --data '{"name": "Follow"}'
  followed=false
  for _ in $(seq 1 20); do
    if grep -q '"message":"greeting Follow"' "$work/follow.out"; then
      followed=true
      break
    fi
    sleep 1
  done
  kill "$follower" 2>/dev/null || true
  wait "$follower" 2>/dev/null || true
  check "ff logs --follow prints a new call's line as it comes, within 20 s" true "$followed"
  ff invoke "$name" --data '{"name": "raw"}' --raw
  check "--raw prints the answer only, for a pipe" "0 Hello raw" "$(code) $(out | jq -r .message)"
  ff invoke "$name" --async --data '{"name": "Later"}' --raw
  async_code="$(code)"
  async_id="$(out)"
  ran=""
  for _ in $(seq 1 30); do
    ff history "$name" --limit 5 --output json
    ran="$(out | jq -r --arg r "$async_id" '[.invocations[] | select(.requestId == $r and .status == "COMPLETED")][0] | select(. != null) | "\(.source) \(.attempt) \(.output.message) \(.output.requestId == $r)"')"
    [ -n "$ran" ] && break
    sleep 1
  done
  check "ff invoke --async prints the request ID at once, and the call runs without waiting, its first attempt under that ID" \
    "0 async 1 Hello Later true" "$async_code $ran"
  ff invoke "$name" --dry-run
  check "--dry-run only checks: nothing runs" "0 $name would take the call: nothing ran" "$(code) $(out)"
  ff deploy "$FF_REPO_ROOT/examples/$example" --name "$name"
  check "deploy again, unchanged, sends nothing" "0 $name: no changes ($runtime, 128 MB, 5 s, ACTIVE)" "$(code) $(out)"
  ff scale "$name" --max 2
  check "scale sets its instances" "0 $name: instances 0 to 2, to zero when idle" "$(code) $(out)"
  sed 's/Hello /Ahlan /' "$FF_REPO_ROOT/examples/$example" >"$work/$example"
  ff deploy "$work/$example" --name "$name" --memory 256
  check "deploy updates what changed, and says what" "0 updated $name ($runtime, 256 MB, 5 s): ACTIVE, changed: code, memory" \
    "$(code) $(out | sed 's/ in [0-9.]* s,/,/')"
  ff invoke "$name" --data '{"name": "Sfax"}'
  check "the new code answers" "0 Ahlan Sfax" "$(code) $(out | sed '$d' | jq -r .message)"
  last_id="$(out | tail -1 | cut -d' ' -f2)"
  ff history "$name" --limit 2 --output json
  check "history lists its calls, newest first, by the IDs invoke printed" "0 5 $last_id COMPLETED" \
    "$(code) $(out | jq -r '"\(.total) \(.invocations[0].id) \(.invocations[0].status)"')"
  ff get "$name" --output json
  check "get shows it: its handler, and its code's package, SHA-256 and size rather than its code" \
    "0 256 0 2 null function.handler inline $(file_facts "$work/$example")" \
    "$(code) $(out | jq -r '"\(.memory) \(.minInstances) \(.maxInstances) \(.code) \(.handler) \(.packageType) \(.codeSha256) \(.codeSize)"')"
  ff --profile b get "$name"
  check "another account doesn't find it" "3 error: There is no function named \"$name\" in the account: \`ff list\` shows its functions" "$(code) $(err)"
  ff delete "$name" </dev/null
  check "delete asks first: a script must say --yes" "2 error: ff delete asks first, and there is no terminal to ask in: say --yes" "$(code) $(err)"
  ff delete "$name" --yes
  check "delete removes it" "0 deleted $name" "$(code) $(out)"
  ff get "$name"
  check "and it is gone" 3 "$(code)"
done
}
section_def backend section_backend stack

section_failures() {
section "failures"
ff deploy "$FF_REPO_ROOT/examples/hello.py" --name cli-raises
ff invoke cli-raises --data '{"name": "error"}'
raised_id="$(err | sed -n 's/^request ID: //p')"
check "a function that raises exits 5, with its error and the call's ID" "5 error: ValueError: this name is not allowed true" \
  "$(code) $(err | head -1) $([ -n "$raised_id" ] && echo true || echo false)"
ff history cli-raises --output json
check "which the history shows, as ERROR" "$raised_id ERROR" "$(out | jq -r '"\(.invocations[0].id) \(.invocations[0].status)"')"
# Its calls that don't wait: no retry, and another function, by name, gets the record of each that fails.
ff deploy "$FF_REPO_ROOT/examples/hello.ts" --name cli-records
ff async-config cli-raises --retries 0 --on-failure cli-records
check "ff async-config sets no retry, and another function, by its name, as the destination of the calls that fail" \
  "0 cli-raises: a call that fails is not retried, and kept 6 hours at most; one that fails for good to cli-records" "$(code) $(out)"
ff invoke cli-raises --async --data '{"name": "error"}' --raw
failed_id="$(out)"
record=""
for _ in $(seq 1 30); do
  ff history cli-records --limit 5 --output json
  record="$(out | jq -r --arg r "$failed_id" '[.invocations[] | select(.status == "COMPLETED" and .input.requestContext.requestId == $r)][0] | select(. != null) | .input | "\(.requestContext.condition) \(.responseContext.functionError) \(.responsePayload.errorType)"')"
  [ -n "$record" ] && break
  sleep 1
done
check "the call that failed goes on to cli-records at once, Lambda's record of it its event" "RetriesExhausted Unhandled ValueError" "$record"
ff async-config cli-raises --reset
check "--reset goes back to AWS Lambda's defaults" \
  "0 cli-raises: a call that fails is retried twice, and kept 6 hours at most, going nowhere once it ends (AWS Lambda's defaults)" "$(code) $(out)"
ff delete cli-records --yes
ff deploy "$FF_REPO_ROOT/examples/slow.py" --name cli-slow --timeout 2
ff invoke cli-slow --data '{"seconds": 5}'
slow_id="$(err | sed -n 's/^request ID: //p')"
check "a call past the function's timeout exits 5, with the call's ID" "5 error: Sandbox.Timedout: Task timed out after 2.00 seconds true" \
  "$(code) $(err | head -1) $([ -n "$slow_id" ] && echo true || echo false)"
ff history cli-slow --output json
check "which the history shows, as TIMEOUT" "$slow_id TIMEOUT" "$(out | jq -r '"\(.invocations[0].id) \(.invocations[0].status)"')"
printf 'def handler(event, context:\n    return 1\n' >"$work/broken.py"
ff deploy "$work/broken.py" --name cli-broken
check "code that fails to load exits 4, saying why, after the line saying what it was doing" \
  "4 creating cli-broken (python, 128 MB, 5 s)… error: The function failed to load: Runtime.UserCodeSyntaxError" \
  "$(code) $(err | head -1) $(err | grep '^error:' | cut -d: -f1-3)"
ff get cli-broken
check "the function is kept, in ERROR, with its error" "0 ERROR The function failed to load: Runtime.UserCodeSyntaxError" \
  "$(code) $(out | sed -n 's/^status *//p') $(out | sed -n 's/^error *//p' | cut -d: -f1-2)"
ff list --output json
check "list shows the three" "0 cli-broken cli-raises cli-slow" "$(code) $(out | jq -r '[.[].name] | sort | join(" ")')"
ff --profile b list
check "and another account none of them" "0 No function yet: \`ff deploy <file>\` makes one" "$(code) $(out)"
for name in cli-raises cli-slow cli-broken; do ff delete "$name" --yes; done
check "the last one deleted" "0 deleted cli-broken" "$(code) $(out)"
}
section_def failures section_failures backend

section_environment() {
section "environment variables: --env, ff env, and on this machine"
printf 'import os\n\ndef handler(event, context):\n    return {"greeting": os.environ.get("GREETING", "none"), "token": os.environ.get("TOKEN", "none")}\n' >"$work/env-reader.py"
ff deploy "$work/env-reader.py" --name cli-env --env GREETING=Ahlan
check "deploy --env makes a function with its variable" "0 created" "$(code) $(out | cut -d' ' -f1)"
ff invoke cli-env --raw
check "which the function reads" "0 Ahlan" "$(code) $(out | jq -r .greeting)"
ff env set cli-env GREETING=Salam
echo "from-stdin" | ff env set cli-env TOKEN
ff invoke cli-env --raw
check "ff env set changes one, and reads a value from stdin, both live once it answers" "0 Salam from-stdin" "$(code) $(out | jq -r '"\(.greeting) \(.token)"')"
ff env list cli-env
check "ff env list names them, without their values" "0 GREETING TOKEN" "$(code) $(out | paste -sd' ')"
ff env unset cli-env GREETING
ff invoke cli-env --raw
check "ff env unset removes one" "0 none from-stdin" "$(code) $(out | jq -r '"\(.greeting) \(.token)"')"
ff delete cli-env --yes
ff local invoke "$work/env-reader.py" --env GREETING=Local --raw
check "ff local invoke --env gives the run its variables" "0 Local" "$(code) $(out | jq -r .greeting)"
ff local invoke "$work/env-reader.py" --env FUNCTION_TIMEOUT=1
check "and refuses the names the runtime sets itself, as the API does" "2 error: FUNCTION_TIMEOUT is reserved: AWS Lambda or FF's runtime sets it" "$(code) $(err)"
}
section_def environment section_environment backend

section_secrets() {
section "secrets: set from stdin, read by the function only"
printf 'import os\n\ndef handler(event, context):\n    return {"password": os.environ.get("DB_PASSWORD", "none")}\n' >"$work/secret-reader.py"
ff deploy "$work/secret-reader.py" --name cli-secrets
echo "hunter2-$account_a" | ff secrets set cli-secrets DB_PASSWORD
check "ff secrets set takes the value from stdin, and says nothing of it" "0 false" \
  "$(code) $(cat "$work/out" "$work/err" | grep "hunter2" >/dev/null && echo true || echo false)"
ff invoke cli-secrets --raw
check "the function reads it, once the command has answered" "0 hunter2-$account_a" "$(code) $(out | jq -r .password)"
ff secrets list cli-secrets
check "ff secrets list names it, and when it was set" "0 DB_PASSWORD" "$(code) $(out | sed -n 2p | awk '{ print $1 }')"
ff get cli-secrets --output json
check "and ff get shows no value of it" "0 false" "$(code) $(out | grep hunter2 >/dev/null && echo true || echo false)"
ff secrets unset cli-secrets DB_PASSWORD
ff invoke cli-secrets --raw
check "ff secrets unset removes it" "0 none" "$(code) $(out | jq -r .password)"
ff delete cli-secrets --yes
}
section_def secrets section_secrets backend

section_url() {
section "a function's URL: ff url, ff invoke --http, ff domains"
printf '%s\n' 'export async function handler(event: { rawPath: string; queryStringParameters?: Record<string, string> }) {' \
  '  return { statusCode: 200, headers: { "content-type": "text/plain" }, body: `Ahlan ${event.queryStringParameters?.name ?? "world"} at ${event.rawPath}` };' \
  '}' >"$work/web.ts"
ff deploy "$work/web.ts" --name cli-url
ff url enable cli-url
check "a new URL needs who may call it" "2" "$(code)"
ff url enable cli-url --auth none
address="$(out | head -1 | sed 's/^cli-url has a URL: //')"
check "ff url enable gives it its address, open to anyone" "0 true" "$(code) $([[ $address =~ ^http://[a-z0-9]{32}\.fn\.localhost:$url_port/$ ]] && echo true || echo false)"
ff invoke cli-url --http GET "/hello?name=Browser"
check "ff invoke --http calls it there, with AWS Lambda's URL event" "0 HTTP 200 Ahlan Browser at /hello" "$(code) $(out | head -1) $(out | tail -1)"
ff url enable cli-url --auth key
ff invoke cli-url --http GET /
check "once it takes API keys, a call without one is refused there" "0 HTTP 403" "$(code) $(out | head -1)"
ff url show cli-url
check "ff url show says its address and who may call it" "0 $address callers need an API key of the account with functions:invoke" \
  "$(code) $(out | head -1) $(out | sed -n 2p | cut -d';' -f1)"
ff domains add cli-url shop.cli-e2e.test
check "ff domains add says the records that prove it" "0 shop.cli-e2e.test: pending true" \
  "$(code) $(out | head -1) $(out | grep "CNAME shop.cli-e2e.test ${address:7:32}.fn.localhost" >/dev/null && echo true || echo false)"
ff domains verify cli-url shop.cli-e2e.test
check "which, until they exist, leave it pending" "0 shop.cli-e2e.test: pending" "$(code) $(out | head -1)"
ff domains list cli-url --output json
check "ff domains list has it" "0 shop.cli-e2e.test pending" "$(code) $(out | jq -r '.[0] | "\(.domain) \(.status)"')"
ff domains remove cli-url shop.cli-e2e.test --yes
ff url disable cli-url --yes
check "ff url disable deletes the URL" "0 cli-url's URL deleted: $address answers 404" "$(code) $(out)"
ff invoke cli-url --http GET /
check "after which ff invoke --http has nowhere to call" "3 error: cli-url has no URL: \`ff url enable cli-url --auth none|key\` gives it one" "$(code) $(err)"
ff delete cli-url --yes
}
section_def url section_url backend

section_schedules() {
section "schedules: ff schedule set, its run, list, disable, remove"
ff deploy "$FF_REPO_ROOT/examples/hello.py" --name cli-sched
ff schedule set cli-sched "rate(1 minute)" --input '{"name": "Schedule"}'
check "ff schedule set makes it, and says its next runs" "0 cli-sched's schedule schedule made: rate(1 minute), with its own input true" \
  "$(code) $(out | head -1) $(out | sed -n 2p | grep -E '^next runs \(UTC\): [0-9-]+ [0-9:]+, ' >/dev/null && echo true || echo false)"
ff schedule set cli-sched "rate(5 minute)"
check "a wrong expression is said in the API's words, and nothing changes" "3 error: rate(5 minute) must be rate(5 minutes): the unit is plural above 1" "$(code) $(err | head -1)"
# Its first run comes a minute after it was made, then the scheduler's tick within 5 s.
ran=false
for _ in $(seq 1 30); do
  ff schedule list cli-sched --output json
  if [ "$(out | jq -r '.[0].lastOutcome')" = success ]; then
    ran=true
    break
  fi
  sleep 5
done
check "within about 70 s it has run, and ff schedule list says it succeeded" true "$ran"
ff history cli-sched --output json
check "the history has the call, as a schedule's, with its input" "schedule $(out | jq -r '.invocations[0].id')" \
  "$(out | jq -r '.invocations[0].source') $(ff schedule list cli-sched --output json; out | jq -r '.[0].lastRequestId')"
ff schedule disable cli-sched
check "ff schedule disable stops its runs" "0 cli-sched's schedule schedule disabled: it doesn't run" "$(code) $(out)"
ff schedule remove cli-sched
ff schedule list cli-sched
check "ff schedule remove takes it away" "0 cli-sched has no schedule: \`ff schedule set cli-sched \"rate(1 hour)\"\` makes one" "$(code) $(out)"
ff delete cli-sched --yes
}
section_def schedules section_schedules backend

section_init() {
section "ff init: a new function's folder, run locally, then deployed"
for runtime in python nodejs; do
  name="cli-init-$runtime"
  (cd "$work" && rm -rf "$name" && "$ff_bin" init "$name" --runtime "$runtime" >"$work/out" 2>"$work/err")
  extension=py
  [ "$runtime" = nodejs ] && extension=ts
  check "ff init makes $name's handler, event and README, and nothing else" "README.md events/event.json function.$extension" \
    "$(cd "$work/$name" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | paste -sd' ')"
  (cd "$work/$name" && ff local invoke . --data @events/event.json)
  check "which runs locally with its event, the folder's name its own" "0 Hello Tunis" "$(code) $(out | sed '$d' | jq -r .message)"
  (cd "$work/$name" && ff deploy "function.$extension")
  check "and deploys as $name, from function.$extension" "0 created $name ($runtime, 128 MB, 5 s): ACTIVE" "$(code) $(out | sed 's/ in [0-9.]* s$//')"
  ff invoke "$name" --data "@$work/$name/events/event.json"
  check "and answers on FF" "0 Hello Tunis" "$(code) $(out | sed '$d' | jq -r .message)"
  ff delete "$name" --yes
done
}
section_def init section_init backend

section_packages() {
section "packages: a folder with its libraries, packaged, uploaded once, deployed"
# npm and pip fetch the libraries: this part needs the network, or their caches.
node_pkg="$work/cli-pkg-node"
rm -rf "$node_pkg" && mkdir -p "$node_pkg/lib"
echo '{ "name": "cli-pkg-node", "private": true, "dependencies": { "ms": "2.1.3" } }' >"$node_pkg/package.json"
cat >"$node_pkg/index.js" <<'EOF'
const ms = require('ms');
const { greet } = require('./lib/greet');
exports.handler = async (event) => ({ took: ms(event.ms), greeting: greet(event.name) });
EOF
echo 'exports.greet = (name) => `Hello ${name}`;' >"$node_pkg/lib/greet.js"
echo 'DB_PASSWORD=hunter2' >"$node_pkg/.env"
ff deploy "$node_pkg"
check "deploy of a folder installs its npm library, uploads its package, and makes it live" \
  "0 created cli-pkg-node (nodejs, 128 MB, 5 s): ACTIVE uploaded" "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//') $(out | tail -1 | awk '{ print $NF }')"
check "leaving out its .env, and saying so" true "$(err | grep '^warning: not packaged: .env, which usually hold secrets' >/dev/null && echo true || echo false)"
ff invoke cli-pkg-node --data '{"ms": 90000, "name": "Tunis"}'
check "it answers through its library and its own module" "0 2m Hello Tunis" "$(code) $(out | sed '$d' | jq -r '"\(.took) \(.greeting)"')"
ff package "$node_pkg" --output json
node_sha="$(out | jq -r .codeSha256)"
ff get cli-pkg-node --output json
check "ff get shows the package ff package makes, by its SHA-256, and the handler ff found" "0 zip index.handler $node_sha" \
  "$(code) $(out | jq -r '"\(.packageType) \(.handler) \(.codeSha256)"')"
ff deploy "$node_pkg"
check "deploy again, the folder unchanged, sends nothing" "0 cli-pkg-node: no changes (nodejs, 128 MB, 5 s, ACTIVE)" "$(code) $(out)"
sed -i 's/Hello/Ahlan/' "$node_pkg/lib/greet.js"
ff deploy "$node_pkg"
check "a change uploads the new package, in one rollout" "0 updated cli-pkg-node (nodejs, 128 MB, 5 s): ACTIVE, changed: code uploaded" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s,/,/') $(out | tail -1 | awk '{ print $NF }')"
sed -i 's/Ahlan/Hello/' "$node_pkg/lib/greet.js"
ff deploy "$node_pkg"
check "and back uploads nothing: the account has that package" "0 which the account had" "$(code) $(out | tail -1 | sed 's/.*, //')"
ff deploy "$FF_REPO_ROOT/examples/hello.ts" --name cli-pkg-node
check "a file deployed over it makes it inline code again, with inline code's handler, saying so" \
  "0 changed: code, handler true" \
  "$(code) $(out | sed 's/.*, changed/changed/') $(err | grep '^warning: cli-pkg-node ran a package: it becomes inline code, .*hello.ts alone, its handler function.handler$' >/dev/null && echo true || echo false)"
ff invoke cli-pkg-node --data '{"name": "Inline"}'
check "which answers" "0 Hello Inline" "$(code) $(out | sed '$d' | jq -r .message)"
ff delete cli-pkg-node --yes

requests_pkg="$work/cli-pkg-requests"
rm -rf "$requests_pkg" && mkdir -p "$requests_pkg"
echo 'requests==2.32.5' >"$requests_pkg/requirements.txt"
cat >"$requests_pkg/lambda_function.py" <<'EOF'
import requests


def lambda_handler(event, context):
    prepared = requests.Request("GET", "https://example.tn/search", params={"q": event["q"]}).prepare()
    return {"requests": requests.__version__, "url": prepared.url}
EOF
ff deploy "$requests_pkg" --name cli-pkg-requests
check "a Python folder's requirements, installed as wheels for the runtime, deployed" "0 created cli-pkg-requests (python, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff invoke cli-pkg-requests --data '{"q": "ff"}'
check "it answers through requests, its handler AWS Lambda's default" "0 2.32.5 https://example.tn/search?q=ff lambda_function.lambda_handler" \
  "$(code) $(out | sed '$d' | jq -r '"\(.requests) \(.url)"') $("$ff_bin" get cli-pkg-requests --output json | jq -r .handler)"
ff package "$requests_pkg" --container --zip "$work/requests-container.zip"
check "ff package --container installs them in the runtime's base, in Docker" "0 true" \
  "$(code) $(python3 -I -m zipfile -l "$work/requests-container.zip" | grep '^requests/__init__.py ' >/dev/null && echo true || echo false)"
ff delete cli-pkg-requests --yes

numpy_pkg="$work/cli-pkg-numpy"
rm -rf "$numpy_pkg" && mkdir -p "$numpy_pkg"
printf '[project]\nname = "cli-pkg-numpy"\nversion = "1.0.0"\ndependencies = ["numpy==2.3.4"]\n' >"$numpy_pkg/pyproject.toml"
cat >"$numpy_pkg/function.py" <<'EOF'
import numpy as np


def handler(event, context):
    return {"mean": float(np.array(event["values"], dtype=float).mean()), "numpy": np.__version__}
EOF
ff deploy "$numpy_pkg" --name cli-pkg-numpy
check "pyproject.toml's dependencies, numpy's native wheels among them, deployed" "0 created cli-pkg-numpy (python, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff invoke cli-pkg-numpy --data '{"values": [1, 2, 3, 4]}'
check "its native code loads in the runtime and answers" "0 2.5 2.3.4" "$(code) $(out | sed '$d' | jq -r '"\(.mean) \(.numpy)"')"
ff delete cli-pkg-numpy --yes

native_pkg="$work/cli-pkg-native"
rm -rf "$native_pkg" && mkdir -p "$native_pkg"
echo '{ "name": "cli-pkg-native", "private": true, "dependencies": { "bcrypt": "6.0.0" } }' >"$native_pkg/package.json"
cat >"$native_pkg/index.js" <<'EOF'
const bcrypt = require('bcrypt');
exports.handler = async (event) => ({ matches: bcrypt.compareSync(event.password, bcrypt.hashSync(event.password, 4)) });
EOF
ff deploy "$native_pkg"
check "an npm library with native code, bcrypt's binary for Linux x86_64, deployed" "0 created cli-pkg-native (nodejs, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff invoke cli-pkg-native --data '{"password": "hunter2"}'
check "its native code loads on the runtime's glibc and answers" "0 true" "$(code) $(out | sed '$d' | jq -r .matches)"
ff delete cli-pkg-native --yes

esm_pkg="$work/cli-pkg-esm"
rm -rf "$esm_pkg" && mkdir -p "$esm_pkg/src/handlers" "$esm_pkg/test"
echo '{ "name": "cli-pkg-esm", "private": true, "type": "module" }' >"$esm_pkg/package.json"
cat >"$esm_pkg/src/handlers/orders.js" <<'EOF'
export const create = async (event) => ({ order: event.id, status: 'created', module: import.meta.url });
EOF
echo "throw new Error('tests stay home');" >"$esm_pkg/test/orders.test.js"
echo 'test/' >"$esm_pkg/.ffignore"
ff deploy "$esm_pkg" --handler src/handlers/orders.create
check "an ES module in a folder, its handler named with --handler, deployed" "0 created cli-pkg-esm (nodejs, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff invoke cli-pkg-esm --data '{"id": 7}'
check "the runtime imports it from the package, at /var/task" "0 7 created file:///var/task/src/handlers/orders.js" \
  "$(code) $(out | sed '$d' | jq -r '"\(.order) \(.status) \(.module)"')"
ff package "$esm_pkg" --zip "$work/esm.zip"
check "what .ffignore names isn't in the package" "0 true false" \
  "$(code) $(python3 -I -m zipfile -l "$work/esm.zip" | grep '^src/handlers/orders.js ' >/dev/null && echo true || echo false) $(python3 -I -m zipfile -l "$work/esm.zip" | grep '^test/' >/dev/null && echo true || echo false)"
ff delete cli-pkg-esm --yes

ts_pkg="$work/cli-pkg-ts"
rm -rf "$ts_pkg" && mkdir -p "$ts_pkg/src"
echo '{ "name": "cli-pkg-ts", "private": true, "dependencies": { "ms": "2.1.3" }, "devDependencies": { "typescript": "5.9.3", "@types/ms": "2.1.0" } }' >"$ts_pkg/package.json"
echo '{ "compilerOptions": { "target": "es2022", "module": "commonjs", "outDir": "dist", "rootDir": "src", "strict": true, "esModuleInterop": true } }' >"$ts_pkg/tsconfig.json"
cat >"$ts_pkg/src/index.ts" <<'EOF'
import ms from 'ms';

export const handler = async (event: { ms: number }) => ({ took: ms(event.ms) });
EOF
ff package "$ts_pkg" --compile --zip "$work/ts.zip" --output json
ts_sha="$(out | jq -r .codeSha256)"
check "ff package --compile makes it JavaScript for AWS Lambda: its tsc's output, no TypeScript, no build tools" "0 true 0" \
  "$(code) $(python3 -I -m zipfile -l "$work/ts.zip" | grep '^dist/index.js ' >/dev/null && echo true || echo false) $(python3 -I -m zipfile -l "$work/ts.zip" | grep -cE '^[^ ]+\.ts |^node_modules/typescript/')"
rm -rf "$work/ts-built" && mkdir -p "$work/ts-built" && python3 -I -m zipfile -e "$work/ts.zip" "$work/ts-built"
ff deploy "$work/ts-built" --name cli-pkg-ts --no-build --handler dist/index.handler --output json
check "that zip's files, deployed as they are with --no-build, are the same package" "0 created $ts_sha" \
  "$(code) $(out | jq -r '"\(.action) \(.package.codeSha256)"')"
ff invoke cli-pkg-ts --data '{"ms": 60000}'
check "and run on FF as they would on Lambda" "0 1m" "$(code) $(out | sed '$d' | jq -r .took)"
ff delete cli-pkg-ts --yes
}
section_def packages section_packages init

section_small_app_db() {
section "the small app with a database of its own on the internet: a package with a driver, a secret, a URL that writes there, a nightly schedule"
# The app's database, as one on the internet would be (hack/k8s/app-database.sh), on a network of the test's own. No
# bucket is named, so its orders go without receipts.
export FF_APP_DB_NAME="$E2E_PROJECT-app-db" FF_APP_DB_SUBNET=198.18.1.0/24 FF_APP_DB_ADDRESS=198.18.1.10
e2e_cleanups+=("$FF_REPO_ROOT/hack/k8s/app-database.sh down")
database_url="$("$FF_REPO_ROOT/hack/k8s/app-database.sh" up)"
app_db() { "$FF_REPO_ROOT/hack/k8s/app-database.sh" psql -tA "$@"; }
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }
account_c="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_c")")
ff config set endpoint "$api" --profile c
ff config set dev_account "$account_c" --profile c
ff whoami --profile c
# As an operator turns it on in the admin dashboard; e2e has no operator, so SQL. Its deploys apply it.
sql "UPDATE accounts SET internet_egress = true WHERE id = '$account_c'"
app="$work/orders-app"
rm -rf "$app" && cp -r "$FF_REPO_ROOT/examples/orders-app" "$app"
ff deploy "$app" --name orders-api --handler index.http --profile c
check "examples/orders-app, pg among its libraries, deployed as orders-api with its URL's handler" \
  "0 created orders-api (nodejs, 128 MB, 5 s): ACTIVE uploaded" "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//') $(out | tail -1 | awk '{ print $NF }')"
printf '%s\n' "$database_url" | ff secrets set orders-api DATABASE_URL --profile c
check "its database's address, a secret" "0 DATABASE_URL" "$(code) $("$ff_bin" secrets list orders-api --profile c --output json | jq -r '.secrets[0].name')"
ff url enable orders-api --auth none --profile c
check "a URL, open to anyone" 0 "$(code)"
ff invoke orders-api --http POST /orders --data '{"item": "harissa", "quantity": 2}' --profile c
check "a POST to its URL writes an order to the database, through the secret and the account's internet access" \
  "0 HTTP 201 harissa 2" "$(code) $(out | head -1) $(out | tail -1 | jq -r '"\(.item) \(.quantity)"')"
check "which the database has" "harissa|2" "$(app_db -c 'SELECT item, quantity FROM orders')"
ff invoke orders-api --http POST /orders --data '{"item": "", "quantity": 0}' --profile c
check "a wrong order is refused" "0 HTTP 400" "$(code) $(out | head -1)"
ff invoke orders-api --http GET /orders --profile c
check "a GET lists the orders" "0 HTTP 200 harissa" "$(code) $(out | head -1) $(out | tail -1 | jq -r '.[0].item')"
ff deploy "$app" --name orders-nightly --handler index.nightly --profile c
check "the same folder, a second function with the other handler: its package, the account has" \
  "0 created orders-nightly (nodejs, 128 MB, 5 s): ACTIVE which the account had" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//') $(out | tail -1 | sed 's/.*, //')"
printf '%s\n' "$database_url" | ff secrets set orders-nightly DATABASE_URL --profile c
ff schedule set orders-nightly "cron(0 2 * * ? *)" --profile c
check "a schedule at 02:00 UTC every night" "0 orders-nightly's schedule schedule made: cron(0 2 * * ? *), with EventBridge's Scheduled Event true" \
  "$(code) $(out | head -1) $(out | sed -n 2p | grep -E '^next runs \(UTC\): [0-9-]+ 02:00' >/dev/null && echo true || echo false)"
# Its next run's event, now: EventBridge's Scheduled Event for 02:00 after the day the order was made.
order_day="$(app_db -c "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM orders")"
jq --arg time "$(date -u -d "$order_day + 1 day" +%Y-%m-%dT02:00:00Z)" '.time = $time' "$app/events/scheduled.json" >"$work/scheduled.json"
ff invoke orders-nightly --data "@$work/scheduled.json" --profile c
check "which reports the day's order from the database" "0 $order_day 1 2 0" "$(code) $(out | sed '$d' | jq -r '"\(.day) \(.orders) \(.items) \(.removed)"')"
ff delete orders-nightly --yes --profile c
ff delete orders-api --yes --profile c
}
section_def small_app_db section_small_app_db backend

section_databases() {
section "a customer's database, with ff db: a function's secret, written by the app with its account's internet access off"
ff deploy "$app" --name cli-db-orders --handler index.http
check "the same app in account A, whose functions don't reach the internet" "0 created cli-db-orders (nodejs, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff db create Orders
check "ff db create refuses a name RDS wouldn't take, before calling" "2 true" "$(code) $(err | grep "can't be a database's name" >/dev/null && echo true || echo false)"
ff db create cli-orders --secret-for cli-db-orders --output json
db_conn="$(out | jq -r .connectionString)"
check "ff db create makes it, its connection string once, and sets it as the function's DATABASE_URL" "0 active cli-db-orders:DATABASE_URL true" \
  "$(code) $(out | jq -r '"\(.status) \(.secretsSet[0].function):\(.secretsSet[0].secret)"') $([[ "$db_conn" == postgresql://*"@$data_db_address:5432/"*"?sslmode=require" ]] && echo true || echo false)"
ff url enable cli-db-orders --auth none
ff invoke cli-db-orders --http POST /orders --data '{"item": "makroudh", "quantity": 3}'
check "a POST writes its order to FF's database, over TLS, its certificate trusted" "0 HTTP 201 makroudh 3" \
  "$(code) $(out | head -1) $(out | tail -1 | jq -r '"\(.item) \(.quantity)"')"
check "which psql reads with the string ff gave" "makroudh|3" "$(data_db_psql "$db_conn" 'select item, quantity from orders')"
ff db list
check "ff db list shows it available, its storage and sessions" "0 cli-orders available" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff db get cli-orders --output json
check "ff db get gives how to reach it, without its password" "0 $data_db_address false" \
  "$(code) $(out | jq -r .host) $(out | grep "$(jq -rn --arg s "$db_conn" '$s | capture(":(?<p>[^:@]+)@").p')" >/dev/null && echo true || echo false)"
ff db password cli-orders --secret-for cli-db-orders --output json
new_conn="$(out | jq -r .connectionString)"
check "ff db password: the old string opens no session, the new one does, and the function has it" "0 true 1" \
  "$(code) $( (data_db_psql "$db_conn" 'select 1' || true) | grep 'password authentication failed' >/dev/null && echo true || echo false) $(data_db_psql "$new_conn" 'select count(*) from orders')"
ff invoke cli-db-orders --http POST /orders --data '{"item": "bambalouni", "quantity": 1}'
check "  ... which writes again through its new secret" "0 HTTP 201 2" "$(code) $(out | head -1) $(data_db_psql "$new_conn" 'select count(*) from orders')"
# Each minute, the backend measures every database not measured yet in the hour: this one within a minute.
for _ in $(seq 75); do "$ff_bin" usage --output json 2>/dev/null | jq -e '.databases | map(.name) | index("cli-orders")' >/dev/null && break; sleep 1; done
ff usage
check "ff usage lists its month after the functions" "0 true" "$(code) $(out | grep -E '^cli-orders +[0-9]+ +[0-9.]+ +[0-9.]+$' >/dev/null && echo true || echo false)"
ff db delete cli-orders
check "ff db delete asks first, a script saying --yes" "2 true" "$(code) $(err | grep 'ff db delete asks first' >/dev/null && echo true || echo false)"
ff db delete cli-orders --yes
check "ff db delete drops it, with its data, its user gone" "0 deleted the database cli-orders, with its data 0" \
  "$(code) $(out) $(docker exec -u postgres "$e2e_data_db_container" psql -XAtc "select count(*) from pg_roles where rolname = '$(jq -rn --arg s "$new_conn" '$s | capture("//(?<u>[^:]+):").u')'")"
ff delete cli-db-orders --yes
}
section_def databases section_databases small_app_db

section_buckets() {
section "buckets, with ff buckets: one made, a key for AWS's tools, the AWS CLI with those alone"
ff buckets create My.Photos
check "ff buckets create refuses a name AWS wouldn't take, before calling" "2 true" "$(code) $(err | grep "can't be a bucket's name" >/dev/null && echo true || echo false)"
ff buckets create cli-photos
check "ff buckets create makes it, and says where AWS's tools reach it" "0 cli-photos made http://cli-photos.s3.localhost:$storage_port" \
  "$(code) $(out | head -1) $(out | sed -n 3p | awk '{ print $2 }')"
ff buckets list
check "ff buckets list shows it" "0 cli-photos active" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff buckets keys create --bucket cli-photos
check "ff buckets keys create prints its secret once, as the six variables AWS's tools read" "0 6" "$(code) $(out | grep -c '^export AWS_')"
out | grep '^export AWS_' >"$work/s3.env"
key_id="$(sed -n 's/^export AWS_ACCESS_KEY_ID=//p' "$work/s3.env")"
printf 'Ahlan from the CLI' >"$work/hello.txt"
# The AWS CLI with those variables alone, none of this machine's settings: AWS_ENDPOINT_URL_S3 names FF's endpoint.
# Without one here, AWS's image: as this user, so that the files it writes are this user's, s3.localhost this machine.
if command -v aws >/dev/null; then aws_cli=("$(command -v aws)"); else
  aws_cli=(docker run --rm --network host --add-host s3.localhost:127.0.0.1 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$work:$work"
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION -e AWS_ENDPOINT_URL_S3 -e AWS_ENDPOINT_URL_SQS -e AWS_CONFIG_FILE -e AWS_SHARED_CREDENTIALS_FILE
    -e AWS_PROFILE amazon/aws-cli:2.34.32)
fi
aws_with_key() { (set -a; . "$work/s3.env"; set +a; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
uploaded="$(aws_with_key s3 cp "$work/hello.txt" s3://cli-photos/hello.txt --only-show-errors >/dev/null 2>&1; echo $?)"
check "the AWS CLI uploads with them and reads it back, AWS_ENDPOINT_URL_S3 its only change" "0 Ahlan from the CLI" \
  "$uploaded $(aws_with_key s3 cp s3://cli-photos/hello.txt - 2>/dev/null)"
ff buckets keys list
check "ff buckets keys list names what it reaches, never its secret" "0 $key_id cli-photos false" \
  "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }') $(out | grep "$(sed -n 's/^export AWS_SECRET_ACCESS_KEY=//p' "$work/s3.env")" >/dev/null && echo true || echo false)"
# Each minute, the backend measures every bucket not measured yet in the hour: this one within a minute.
for _ in $(seq 75); do "$ff_bin" buckets get cli-photos --output json 2>/dev/null | jq -e '.measuredAt != null' >/dev/null && break; sleep 1; done
ff buckets get cli-photos
check "ff buckets get says what it held at its last measure" "0 true" "$(code) $(out | grep -E '^held +[0-9.]+ MB, [01] objects?, as measured at ' >/dev/null && echo true || echo false)"
# Its month: the requests the front door counted, by S3's classes, and the bytes they sent out, once their minute is written.
for _ in $(seq 150); do "$ff_bin" usage --output json 2>/dev/null | jq -e '.buckets[] | select(.name == "cli-photos" and .tier1Requests > 0 and .tier2Requests > 0)' >/dev/null && break; sleep 1; done
ff usage
check "ff usage lists its month after the databases: GB-months, each class's requests, what it sent out" "0 true true" \
  "$(code) $(out | grep -E '^cli-photos +[0-9.]+ +[1-9][0-9]* +[1-9][0-9]* +[0-9.]+ [MG]B +[0-9.]+$' >/dev/null && echo true || echo false) $("$ff_bin" usage --output json | jq '.buckets[] | select(.name == "cli-photos") | .bytesDownloaded > 0')"
# The export kit's way out to AWS S3, both halves: the bucket to a folder with the key's variables, then the folder to
# "S3", here another bucket behind an AWS CLI profile whose key reaches that one alone, so that a second half still
# holding FF's variables would be refused there. The script calls the AWS CLI by name: the one above.
ff buckets create cli-photos-out
ff buckets keys create --bucket cli-photos-out
printf '[profile as-s3]\nregion = %s\nendpoint_url = %s\n' "$(sed -n 's/^export AWS_REGION=//p' "$work/s3.env")" \
  "$(sed -n 's/^export AWS_ENDPOINT_URL_S3=//p' "$work/s3.env")" >"$work/aws-config"
printf '[as-s3]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$(out | sed -n 's/^export AWS_ACCESS_KEY_ID=//p')" \
  "$(out | sed -n 's/^export AWS_SECRET_ACCESS_KEY=//p')" >"$work/aws-credentials"
as_s3() { AWS_CONFIG_FILE="$work/aws-config" AWS_SHARED_CREDENTIALS_FILE="$work/aws-credentials" AWS_PROFILE=as-s3 "$@"; }
mkdir -p "$work/bin"
{ echo '#!/usr/bin/env bash'; printf 'exec'; printf ' %q' "${aws_cli[@]}"; echo ' "$@"'; } >"$work/bin/aws"
chmod +x "$work/bin/aws"
synced="$(set -a; . "$work/s3.env"; set +a; PATH="$work/bin:$PATH" as_s3 "$FF_REPO_ROOT/cli/templates/export/data/s3-sync.sh" \
  cli-photos cli-photos-out "$work/backup" >"$work/s3-sync.out" 2>&1 && echo 0 || echo $?)"
check "the export kit's s3-sync.sh copies the bucket to a folder, then to S3 with the AWS CLI's own settings" \
  "0 Ahlan from the CLI Ahlan from the CLI" \
  "$synced $(cat "$work/backup/hello.txt" 2>/dev/null) $(as_s3 "${aws_cli[@]}" s3 cp s3://cli-photos-out/hello.txt - 2>/dev/null)"
ff buckets delete cli-photos-out --force --yes
ff buckets delete cli-photos --yes
check "ff buckets delete leaves a bucket with files, in the API's words, exit 3" "3 true" "$(code) $(err | grep "isn't empty" >/dev/null && echo true || echo false)"
ff buckets delete cli-photos --force --yes
check "  ... and --force deletes them first" "0 deleted the bucket cli-photos, with its files" "$(code) $(out)"
ff buckets keys revoke "$key_id" --yes
# The AWS CLI exits non-zero when refused: its words, kept whatever its exit, say why.
refused="$(aws_with_key s3 ls 2>&1 || true)"
check "ff buckets keys revoke stops the key at once" "0 true" "$(code) $(grep -q InvalidAccessKeyId <<<"$refused" && echo true || echo false)"
}
section_def buckets section_buckets backend

section_sites() {
section "a site, with ff sites: a built folder deployed with a deploy's own key, visited, deployed again changed"
site_url="http://cli-site.site.localhost:$website_port"
# visit <path> [curl options…]: the site's answer, its status and its page's title.
visit() {
  local path="$1"
  shift
  curl -s -o "$work/page.html" -w '%{http_code}' "$@" "$site_url$path"
  printf ' %s' "$(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$work/page.html")"
}
ff buckets create cli-site
rm -rf "$work/dist"
mkdir -p "$work/dist/assets" "$work/dist/.git"
printf '<!doctype html><title>cli shop</title>' >"$work/dist/index.html"
printf '<!doctype html><title>cli missing</title>' >"$work/dist/404.html"
printf 'console.log("cli")' >"$work/dist/assets/app-3c9d1a2b.js"
printf 'never served' >"$work/dist/.git/config"
ff sites deploy cli-site "$work/dist" --spa --output json
check "ff sites deploy uploads the folder but its dot files, pages last, and makes the bucket a single-page app's site" \
  "0 assets/app-3c9d1a2b.js,404.html,index.html true $site_url" \
  "$(code) $(out | jq -r '"\(.uploaded | join(",")) \(.singlePageApp) \(.url)"')"
check "the site answers its index, an app's route with it, each file typed and cached by its name" \
  "200 cli shop|200 cli shop|text/javascript; charset=utf-8 public, max-age=31536000, immutable|no-cache" \
  "$(visit /)|$(visit /orders/42)|$(curl -s -o /dev/null -w '%{content_type}' "$site_url/assets/app-3c9d1a2b.js") \
$(curl -sI "$site_url/assets/app-3c9d1a2b.js" | tr -d '\r' | sed -n 's/^cache-control: //Ip')|$(curl -sI "$site_url/" | tr -d '\r' | sed -n 's/^cache-control: //Ip')"
check "  ... with a key of its own, never one of the account's keys" "0 0" \
  "$(ff buckets keys list --output json; code) $(out | jq '[.[] | select(.buckets == ["cli-site"])] | length')"
rm "$work/dist/assets/app-3c9d1a2b.js"
printf '<!doctype html><title>cli shop, again</title>' >"$work/dist/index.html"
ff sites deploy cli-site "$work/dist" --output json
check "ff sites deploy again sends what changed alone, deletes what the folder hasn't, and keeps the site's settings" \
  "0 index.html 1 assets/app-3c9d1a2b.js true|200 cli shop, again" \
  "$(code) $(out | jq -r '"\(.uploaded | join(",")) \(.unchanged) \(.deleted | join(",")) \(.singlePageApp)"')|$(visit /orders/42)"
ff sites get cli-site
check "ff sites get says its address and settings" "0 $site_url yes" \
  "$(code) $(out | sed -n 1p) $(out | sed -n 's/^single-page app *\(yes\).*/\1/p')"
ff sites domains add cli-site www.cli-shop.tn
check "ff sites domains add gives the CNAME to the site's host that proves it" "0 true" \
  "$(code) $(out | grep 'CNAME www.cli-shop.tn cli-site.site.localhost' >/dev/null && echo true || echo false)"
ff sites domains remove cli-site www.cli-shop.tn --yes
check "  ... and remove takes it away" "0 0" "$(code) $("$ff_bin" sites domains list cli-site --output json | jq length)"
# Each minute, the website server writes the minutes that are over: these within two.
for _ in $(seq 150); do [ "$("$ff_bin" sites metrics cli-site --period 3600 --since 1h --output json | jq '[.metrics.Requests.Sum[]] | add // 0')" -ge 4 ] && break; sleep 1; done
ff sites metrics cli-site --period 3600 --since 1h --output json
check "ff sites metrics counts its visits once their minute is written, as CloudFront names them" "0 true" \
  "$(code) $(out | jq '([.metrics.Requests.Sum[]] | add >= 4) and ([.metrics.BytesDownloaded.Sum[]] | add > 0)')"
ff sites remove cli-site --yes
check "ff sites remove makes it no site: its address answers 404" "0 404" "$(code) $(curl -s -o /dev/null -w '%{http_code}' "$site_url/")"
ff sites deploy cli-site "$work/dist" --output json
check "  ... its files kept: a deploy finds them unchanged, and makes it a site again, no single-page app's unless told" "0 0 2 false" \
  "$(code) $(out | jq -r '"\(.uploaded | length) \(.unchanged) \(.singlePageApp)"')"
ff buckets delete cli-site --force --yes
}
section_def sites section_sites backend

section_queues() {
section "queues, with ff queues: made with a dead-letter queue, a message sent, received by the AWS CLI and by ff, then dead"
ff queues create cli-orders.fifo
check "ff queues create refuses a FIFO queue's name before calling" "2 true" "$(code) $(err | grep 'FIFO queues come later' >/dev/null && echo true || echo false)"
ff queues create cli-orders-dlq
ff queues create cli-orders --visibility-timeout 2s --retention 1d --dead-letter-queue cli-orders-dlq --max-receive-count 2
check "ff queues create makes it, and says where AWS's tools reach it" "0 cli-orders made http://localhost:$sqs_port/$account_a/cli-orders" \
  "$(code) $(out | head -1) $(out | sed -n 's/^url  *//p')"
ff queues get cli-orders --output json
check "  ... with its attributes, its dead-letter queue by the ARN of the queue named" "0 2 86400 2 cli-orders-dlq" \
  "$(code) $(out | jq -r '"\(.visibilityTimeout) \(.messageRetentionPeriod) \(.redrivePolicy.maxReceiveCount) \(.redrivePolicy.deadLetterTargetArn | split(":")[5])"')"
ff queues send cli-orders '{"order": 1}' --attribute item=bsissa
check "ff queues send sends a message, an attribute with it" "0 true" "$(code) $(out | grep -E '^sent [0-9a-f-]{36} to cli-orders$' >/dev/null && echo true || echo false)"
ff buckets keys create --queue cli-orders
check "a key for that queue alone gives the SQS endpoint among its six variables" "0 6 http://localhost:$sqs_port" \
  "$(code) $(out | grep -c '^export AWS_') $(out | sed -n 's/^export AWS_ENDPOINT_URL_SQS=//p')"
out | grep '^export AWS_' >"$work/sqs.env"
queue_key="$(sed -n 's/^export AWS_ACCESS_KEY_ID=//p' "$work/sqs.env")"
aws_sqs() { (set -a; . "$work/sqs.env"; set +a; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" sqs "$@"); }
queue_url="http://localhost:$sqs_port/$account_a/cli-orders"
check "the AWS CLI receives ff's message with that key, AWS_ENDPOINT_URL_SQS its only change" '{"order": 1} bsissa 1' \
  "$(aws_sqs receive-message --queue-url "$queue_url" --message-attribute-names All --attribute-names ApproximateReceiveCount 2>/dev/null |
    jq -r '.Messages[0] | "\(.Body) \(.MessageAttributes.item.StringValue) \(.Attributes.ApproximateReceiveCount)"')"
# The AWS CLI exits non-zero when refused: its words, kept whatever its exit, say why.
denied="$(aws_sqs get-queue-url --queue-name cli-orders-dlq 2>&1 || true)"
check "  ... and reaches no other queue of the account" "true" "$(grep -q AccessDenied <<<"$denied" && echo true || echo false)"
# Hidden for its visibility timeout of 2 s, it comes back to the next receive that waits long enough.
ff queues receive cli-orders --wait 10s --output json
check "ff queues receive gets it again once its visibility timeout ends, its second receive" '0 {"order": 1} 2 bsissa' \
  "$(code) $(out | jq -r '.[0] | "\(.body) \(.receiveCount) \(.attributes.item.stringValue)"')"
ff queues receive cli-orders --wait 5s --output json
check "  ... and the third moves it to the dead-letter queue, as its redrive policy says" "0 0" "$(code) $(out | jq length)"
ff queues receive cli-orders-dlq --delete --output json
check "ff queues receive --delete gets it from the dead-letter queue, and deletes it" '0 {"order": 1} true' \
  "$(code) $(out | jq -r '.[0] | "\(.body) \(.deleted)"')"
ff queues get cli-orders-dlq --output json
check "  ... which then holds nothing" "0 0 0 0" "$(code) $(out | jq -r '"\(.messages.available) \(.messages.inFlight) \(.sizeBytes)"')"
ff queues send cli-orders one
ff queues send cli-orders two --delay 1m
ff queues list --output json
check "ff queues list counts a queue's messages, one delayed" "0 1 1" "$(code) $(out | jq -r '.[] | select(.name == "cli-orders") | "\(.messages.available) \(.messages.delayed)"')"
ff queues purge cli-orders
check "ff queues purge asks first, and a script must say --yes" "2 true" "$(code) $(err | grep 'say --yes' >/dev/null && echo true || echo false)"
ff queues purge cli-orders --yes
check "  ... and deletes every message" "0 deleted every message of cli-orders 0" \
  "$(code) $(out) $("$ff_bin" queues get cli-orders --output json | jq '.messages.available + .messages.delayed')"
ff queues set cli-orders --retention 1h --no-dead-letter-queue
check "ff queues set changes what it is given, and removes the dead-letter queue" "0 cli-orders changed true" \
  "$(code) $(out | head -1) $(out | grep '^dead letters  *none' >/dev/null && echo true || echo false)"
check "  ... as the AWS CLI sees it" "3600" \
  "$(aws_sqs get-queue-attributes --queue-url "$queue_url" --attribute-names MessageRetentionPeriod 2>/dev/null | jq -r .Attributes.MessageRetentionPeriod)"
ff queues list --profile b
check "the other account has none of them" "0 The account has no queue: \`ff queues create <name>\` makes one" "$(code) $(out)"
# Its requests are counted a minute at a time: in its metrics within two.
for _ in $(seq 150); do "$ff_bin" queues metrics cli-orders --output json 2>/dev/null | jq -e '[.metrics.NumberOfMessagesSent.Sum[]] | add >= 3' >/dev/null && break; sleep 1; done
ff queues metrics cli-orders --period 300
check "ff queues metrics shows a row each five minutes, SQS's metrics as CloudWatch names them: the messages sent, received and deleted" "0 true true" \
  "$(code) $(out | head -1 | grep -E '^TIME \(UTC\) +WAITING +IN FLIGHT +OLDEST +SENT +RECEIVED +DELETED +EMPTY$' >/dev/null && echo true || echo false) $(out | tail -1 | grep -E '^cli-orders for [0-9hm ]+, a point each 5m: sent ([3-9]|[1-9][0-9]+), received [1-9][0-9]*, deleted [0-9]+, empty receives [1-9][0-9]*; at most [0-9]+ waiting$' >/dev/null && echo true || echo false)"
ff queues delete cli-orders --yes
check "ff queues delete deletes it" "0 deleted the queue cli-orders" "$(code) $(out)"
ff queues get cli-orders
check "  ... which then isn't there, in the API's words, exit 3" '3 true' "$(code) $(err | grep 'no queue named "cli-orders"' >/dev/null && echo true || echo false)"
ff queues delete cli-orders-dlq --yes
# Its requests are counted a minute at a time: in ff usage within two, deleted and all.
for _ in $(seq 150); do "$ff_bin" usage --output json 2>/dev/null | jq -e '.queues[] | select(.name == "cli-orders" and .deleted and .messagesSent >= 3)' >/dev/null && break; sleep 1; done
ff usage
check "ff usage lists the queue's month after the buckets, deleted since: its requests as SQS bills them, the messages sent and received" "0 true" \
  "$(code) $(out | grep -E '^cli-orders \(deleted\) +[1-9][0-9]* +[1-9][0-9]* +[1-9][0-9]* +[0-9.]+$' >/dev/null && echo true || echo false)"
ff buckets keys revoke "$queue_key" --yes
}
section_def queues section_queues buckets

section_event_sources() {
section "functions reading queues, with ff event-sources: the function given the queue's batches, the message it failed kept"
# As a function written for Lambda answers: the messages it couldn't handle, by their IDs.
cat >"$work/reader.ts" <<'TS'
export const handler = async (event: { Records: Array<{ messageId: string; body: string }> }) => ({
  batchItemFailures: event.Records.filter((record) => record.body === "fail").map((record) => ({ itemIdentifier: record.messageId })),
});
TS
ff deploy "$work/reader.ts" --name cli-reader --timeout 3
ff queues create cli-work --visibility-timeout 5
ff event-sources add cli-work cli-reader --batching-window 1s --report-batch-item-failures
check "ff event-sources add has the function read the queue, and says how" "0 true" \
  "$(code) $(out | grep '^cli-reader reads the queue cli-work: batches of 10 at most, a window of 1 second, the answer naming the messages that failed' >/dev/null && echo true || echo false)"
mapping_id="$(out | grep -oE '\([0-9a-f-]{36}\)$' | tr -d '()')"
ff event-sources add cli-work cli-reader
check "  ... once: again, the API's words name the mapping there is, exit 3" "3 true" "$(code) $(err | grep "UUID $mapping_id" >/dev/null && echo true || echo false)"
ff queues send cli-work done
ff queues send cli-work fail
reader_calls() { "$ff_bin" history cli-reader --output json | jq '[.invocations[] | select(.source == "sqs")] | length'; }
for _ in $(seq 1 30); do
  [ "$("$ff_bin" queues get cli-work --output json | jq '.messages.available + .messages.inFlight')" = 1 ] && [ "$(reader_calls)" -ge 1 ] && break
  sleep 1
done
check "the function called with the queue's batches, its history's source sqs, the message it handled deleted" "true 1" \
  "$([ "$(reader_calls)" -ge 1 ] && echo true || echo false) $("$ff_bin" queues get cli-work --output json | jq '.messages.available + .messages.inFlight')"
ff event-sources list --queue cli-work
check "ff event-sources list shows it, by the queue's and the function's names" "0 $mapping_id cli-work cli-reader Enabled" \
  "$(code) $(out | sed -n 2p | awk '{ print $1, $2, $3, $8 }')"
ff event-sources update "$mapping_id" --disable
check "ff event-sources update --disable stops its reads" "0 true" "$(code) $(out | grep 'disabled: nothing read' >/dev/null && echo true || echo false)"
ff queues receive cli-work --wait 15s --output json
check "  ... the message the function failed still there, received again once its visibility timeout ended" '0 fail true' \
  "$(code) $(out | jq -r '.[0] | "\(.body) \(.receiveCount >= 2)"')"
ff event-sources remove "$mapping_id" --yes
check "ff event-sources remove removes it, the queue's messages staying" "0 removed the mapping $mapping_id: the queue's messages stay 1 0" \
  "$(code) $(out) $("$ff_bin" queues get cli-work --output json | jq '.messages.available + .messages.inFlight') $("$ff_bin" event-sources list --function cli-reader --output json | jq length)"
ff delete cli-reader --yes
ff queues delete cli-work --yes
}
section_def event_sources section_event_sources backend

section_notifications() {
section "a bucket's notifications, with ff buckets notify: an upload with the AWS CLI runs a function with S3's event, a deletion goes to a queue"
# As a function written for Lambda reads S3's event: each key form-decoded, a "+" a space.
cat >"$work/on-upload.ts" <<'TS'
export const handler = async (event: { Records: Array<{ s3: { object: { key: string } } }> }) => ({
  keys: event.Records.map((record) => decodeURIComponent(record.s3.object.key.replace(/\+/g, " "))),
});
TS
ff deploy "$work/on-upload.ts" --name cli-on-upload
ff buckets create cli-drop
ff queues create cli-drop-events
ff buckets notify cli-drop cli-on-upload --prefix in/ --id uploads
check "ff buckets notify has the bucket run a function for its uploads, by its name, and says what it sends" "0 true" \
  "$(code) $(out | grep -E '^uploads +s3:ObjectCreated:\* +prefix in/ +function cli-on-upload$' >/dev/null && echo true || echo false)"
ff buckets notify cli-drop --queue cli-drop-events --event 's3:ObjectRemoved:*' --id removals
check "  ... and its deletions go to a queue, both now listed" "0 uploads,removals" \
  "$(code) $("$ff_bin" buckets notifications cli-drop --output json | jq -r '[.lambdaFunctionConfigurations[].id, .queueConfigurations[].id] | join(",")')"
ff buckets notify cli-drop cli-on-upload --id again
check "  ... a configuration one event could match twice refused, in S3's words, exit 3" "3 true" "$(code) $(err | grep 'Configuration is ambiguously defined' >/dev/null && echo true || echo false)"
ff buckets keys create --bucket cli-drop
out | grep '^export AWS_' >"$work/drop.env"
drop_key="$(sed -n 's/^export AWS_ACCESS_KEY_ID=//p' "$work/drop.env")"
aws_drop() { (set -a; . "$work/drop.env"; set +a; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
printf 'dropped in' >"$work/drop.txt"
aws_drop s3 cp "$work/drop.txt" "s3://cli-drop/in/a b.txt" --only-show-errors
upload_calls() { "$ff_bin" history cli-on-upload --output json | jq -c '[.invocations[] | select(.source == "async" and .status == "COMPLETED") | .output.keys]'; }
for _ in $(seq 1 30); do [ "$(upload_calls)" != "[]" ] && break; sleep 1; done
check "the AWS CLI's upload runs the function without waiting, S3's event its input, the key decoded as Lambda's functions decode it" '[["in/a b.txt"]]' "$(upload_calls)"
aws_drop s3 rm "s3://cli-drop/in/a b.txt" --only-show-errors
ff queues receive cli-drop-events --max 10 --wait 10s --delete --output json
check "  ... and its deletion puts S3's event in the queue, after S3's test event" "s3:TestEvent ObjectRemoved:Delete in%2Fa+b.txt" \
  "$(out | jq -r '[.[].body | fromjson | (.Event // .Records[0].eventName)] | join(" ")') $(out | jq -r '[.[].body | fromjson | .Records[0].s3.object.key // empty] | join(" ")')"
ff buckets notifications cli-drop --remove uploads
check "ff buckets notifications --remove takes one away by its ID" "0 removals" \
  "$(code) $("$ff_bin" buckets notifications cli-drop --output json | jq -r '[.lambdaFunctionConfigurations[].id, .queueConfigurations[].id] | join(",")')"
ff buckets notifications cli-drop --clear --yes
check "  ... and --clear all of them" "0 cli-drop sends no event any more" "$(code) $(out)"
ff buckets keys revoke "$drop_key" --yes
ff buckets delete cli-drop --force --yes
ff queues delete cli-drop-events --yes
ff delete cli-on-upload --yes
}
section_def notifications section_notifications buckets

section_small_app() {
section "the small app on FF alone, as the guide walks through it: its page a site, its orders in FF's database, the latest in a cache, each one's receipt made through a queue and e-mailed"
# In account A, whose functions don't reach the internet: FF's database and cache, the S3 front door, the SQS and SES
# endpoints, they do.
ff deploy "$app" --name shop-api --handler index.http
check "examples/orders-app, the Valkey, S3, SQS and SES clients among its libraries, deployed as shop-api" "0 created shop-api (nodejs, 128 MB, 5 s): ACTIVE" \
  "$(code) $(out | head -1 | sed 's/ in [0-9.]* s$//')"
ff deploy "$app" --name shop-receipts --handler index.receipts
ff deploy "$app" --name shop-nightly --handler index.nightly
ff db create shop --secret-for shop-api --secret-for shop-nightly --output json
check "ff db create: FF's database, its connection string the API's and the night's DATABASE_URL" "0 active shop-api,shop-nightly" \
  "$(code) $(out | jq -r '"\(.status) \([.secretsSet[].function] | join(","))"')"
ff buckets create cli-receipts
ff queues create cli-new-orders
ff env set shop-api RECEIPTS_QUEUE=cli-new-orders RECEIPTS_BUCKET=cli-receipts
ff env set shop-receipts RECEIPTS_BUCKET=cli-receipts
ff env set shop-nightly RECEIPTS_BUCKET=cli-receipts
ff env list shop-receipts
check "a bucket for the receipts and a queue of new orders, named in the functions' variables" "0 RECEIPTS_BUCKET" "$(code) $(out | paste -sd' ')"
ff event-sources add cli-new-orders shop-receipts --report-batch-item-failures
check "shop-receipts reads the queue, naming the messages it fails" "0 true" \
  "$(code) $(out | grep '^shop-receipts reads the queue cli-new-orders: .*the answer naming the messages that failed' >/dev/null && echo true || echo false)"
ff caches create cli-orders --secret-for shop-api --secret-for shop-nightly --output json
check "ff caches create: the app's cache, its address the API's and the night's REDIS_URL" "0 active shop-api,shop-nightly" \
  "$(code) $(out | jq -r '"\(.status) \([.secretsSet[].function] | join(","))"')"
cache_url="$(out | jq -r .url)"
# The receipts' sender and their recipient, each proved by the link FF e-mails it: the account is in the sandbox.
# No SMTP server for FF's own mail here: the backend writes the e-mail to its log before it answers, so the newest
# link there is the address just added.
follow_link() {
  local token
  token="$(grep -oE '/verify\?token=[A-Za-z0-9_-]{32}' "$work/backend.log" | tail -1 | cut -d= -f2)"
  curl -s -o /dev/null -w '%{http_code}' "http://localhost:$ses_port/verify?token=$token"
}
ff email add orders@shop-cli.tn
sender_proved="$(follow_link)"
ff email add buyer@shop-cli.tn
check "the receipts' sender and their recipient, each proved by its link" "200 200 SUCCESS SUCCESS" \
  "$sender_proved $(follow_link) $("$ff_bin" email identities --output json | jq -r '[.[].status] | join(" ")')"
ff env set shop-receipts RECEIPTS_BUCKET=cli-receipts RECEIPTS_FROM=orders@shop-cli.tn
ff url enable shop-api --auth none
shop_url="$(out | grep -oE 'http://[a-z0-9]+\.fn\.localhost:[0-9]+' | head -1)"
ff invoke shop-api --http POST /orders --data '{"item": "bsissa", "quantity": 4, "email": "buyer@shop-cli.tn"}'
check "a POST writes the order to FF's database, then puts it in the queue with the function's own key" \
  "0 HTTP 201 bsissa 4 queued" "$(code) $(out | head -1) $(out | tail -1 | jq -r '"\(.item) \(.quantity) \(.receipt)"')"
order_day="$(out | tail -1 | jq -r '.created_at[0:10]')"
# shop-receipts gets it from the queue within seconds, and writes the receipt.
for _ in $(seq 30); do [ "$("$ff_bin" invoke shop-api --http GET /orders/1/receipt 2>/dev/null | head -1)" = "HTTP 200" ] && break; sleep 1; done
ff invoke shop-api --http GET /orders/1/receipt
check "  ... which shop-receipts reads, writing its receipt to the bucket: a GET reads it back" "0 HTTP 200 Order 1|4 × bsissa" \
  "$(code) $(out | head -1) $(out | sed -n '3,4p' | paste -sd'|')"
# The receipt is written during the call, its message deleted once the call has ended.
held() { "$ff_bin" queues get cli-new-orders --output json | jq '.messages.available + .messages.inFlight'; }
for _ in $(seq 30); do
  [ "$("$ff_bin" history shop-receipts --output json | jq -r '.invocations[0].status')" = COMPLETED ] && [ "$(held)" = 0 ] && break
  sleep 1
done
ff history shop-receipts --output json
check "  ... as a call of SQS's event, the queue then empty" "sqs COMPLETED 0" "$(out | jq -r '.invocations[0] | "\(.source) \(.status)"') $(held)"
# The receipt e-mailed by shop-receipts with SES's client and the function's own key, handed to the stand-in; read
# as a mail client reads it, its text decoded (its "×" is quoted-printable on the way).
for _ in $(seq 30); do
  [ "$("$ff_bin" email messages --output json | jq -r '.[0].recipients[0].status // empty')" = SENT ] && [ "$(received_count)" -ge 1 ] && break
  sleep 1
done
check "  ... then e-mails it from the proved sender, through FF's SES endpoint, as SES sends it" "SENT orders@shop-cli.tn buyer@shop-cli.tn true" \
  "$("$ff_bin" email messages --output json | jq -r '.[0] | "\(.recipients[0].status) \(.from) \(.recipients[0].address)"') \
$(received 1 | python3 -c 'import email, email.policy, sys
mail = email.message_from_bytes(sys.stdin.buffer.read(), policy=email.policy.default)
print(str(mail["subject"] == "Your receipt, order 1" and "4 × bsissa" in mail.get_body(("plain",)).get_content()).lower())')"
# The latest orders from the cache: read from the database once, then kept a minute; a new order clears them.
latest() { curl -s -o /dev/null -D - "$shop_url/orders" | tr -d '\r' | sed -n 's/^x-cache: //Ip'; }
check "the latest orders read from the database, then from the cache, over TLS, with the address its secret gives" "miss hit" "$(latest) $(latest)"
ttl="$(cache_cli "$cache_url" TTL orders:latest)"
check "  ... the list kept there a minute, as the customer's own client sees it" "true" "$([ "$ttl" -gt 0 ] 2>/dev/null && [ "$ttl" -le 60 ] && echo true || echo false)"
# Its page: site/ deployed as a site of a bucket of its own, the API's address in config.json beside it, and the
# function URL letting the page's origin in.
cp -r "$app/site" "$work/shop-site"
printf '{"api": "%s"}\n' "$shop_url" >"$work/shop-site/config.json"
ff buckets create cli-shop-site
ff sites deploy cli-shop-site "$work/shop-site"
site_origin="http://cli-shop-site.site.localhost:$website_port"
check "the app's page deployed as a site of its own bucket" "0 $site_origin" "$(code) $(out | tail -1)"
check "  ... a browser gets the page, and the API's address beside it" "200 Orders $shop_url" \
  "$(curl -s -o "$work/shop-page.html" -w '%{http_code}' "$site_origin/") $(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$work/shop-page.html") $(curl -s "$site_origin/config.json" | jq -r .api)"
ff url enable shop-api --auth none --cors-origin "$site_origin" --cors-method GET --cors-method POST --cors-header content-type
check "  ... and the function URL lets the page's origin in, as a browser's preflight asks" "$site_origin" \
  "$(curl -s -o /dev/null -D - -X OPTIONS "$shop_url/orders" -H "Origin: $site_origin" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' | tr -d '\r' | sed -n 's/^access-control-allow-origin: //Ip')"
# The same receipt as the AWS CLI sees it, with a key of the account's that reads that bucket alone.
ff buckets keys create --bucket cli-receipts --read-only
out | grep '^export AWS_' >"$work/receipts.env"
receipts_key="$(sed -n 's/^export AWS_ACCESS_KEY_ID=//p' "$work/receipts.env")"
aws_receipts() { (set -a; . "$work/receipts.env"; set +a; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
check "the AWS CLI reads that receipt in the account's bucket, as the function wrote it" "Order 1" "$(aws_receipts s3 cp s3://cli-receipts/receipts/1.txt - 2>/dev/null | head -1)"
# The night 91 days after the order's day, called without waiting as its schedule calls it: the order is older than
# 90 days, so it goes, its receipt with it, and the latest orders, just kept in the cache again, are cleared there.
latest >/dev/null
kept="$(latest)"
jq --arg time "$(date -u -d "$order_day + 91 days" +%Y-%m-%dT02:00:00Z)" '.time = $time' "$app/events/scheduled.json" >"$work/night.json"
ff invoke shop-nightly --async --data "@$work/night.json" --raw
night_id="$(out)"
night=""
for _ in $(seq 30); do
  night="$("$ff_bin" history shop-nightly --output json | jq -r --arg r "$night_id" '[.invocations[] | select(.requestId == $r and .status == "COMPLETED")][0] | select(. != null) | "\(.source) \(.output.removed) \(.output.receipts)"')"
  [ -n "$night" ] && break
  sleep 1
done
check "the night 91 days on, called without waiting, removes the order and its receipt, which the bucket no longer has" "async 1 1 0" \
  "$night $(aws_receipts s3 ls s3://cli-receipts --recursive 2>/dev/null | wc -l | tr -d ' ')"
check "  ... and clears the latest orders, which the cache had" "hit miss" "$kept $(latest)"
ff buckets keys revoke "$receipts_key" --yes
ff queues delete cli-new-orders --yes
check "deleting the queue removes its mapping" "0 0" "$(code) $("$ff_bin" event-sources list --function shop-receipts --output json | jq length)"
ff buckets delete cli-receipts --force --yes
ff buckets delete cli-shop-site --force --yes
ff caches delete cli-orders --yes
ff email delete orders@shop-cli.tn --yes
ff email delete buyer@shop-cli.tn --yes
ff db delete shop --yes
ff delete shop-nightly --yes
ff delete shop-receipts --yes
ff delete shop-api --yes
}
section_def small_app section_small_app small_app_db buckets

section_account() {
section "the account: who, its plan, what it used and owes, how its functions ran"
ff accounts
check "ff accounts lists account A, current" "0 * $account_a" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff account
check "ff account says its plan, and that its functions don't reach the internet, as beta's" "0 Beta true" \
  "$(code) $(out | sed -n 's/^plan *\([A-Za-z]*\):.*/\1/p') $(out | grep '^internet     off' >/dev/null && echo true || echo false)"
ff usage --output json
check "ff usage counts this month's calls of the functions deleted since, by name, the asynchronous one among them" "0 5 true" \
  "$(code) $(out | jq -r '.functions[] | select(.functionName == "cli-hello-ts") | .requests') $(out | jq -r '[.functions[] | select(.functionName == "cli-hello-ts") | .deleted] | first')"
ff usage --csv
check "and gives the API's CSV" "0 true" "$(code) $(out | head -1 | grep 'requests' >/dev/null && echo true || echo false)"
ff balance --output json
check "ff balance says the balance, in dinars" "0 TND" "$(code) $(out | jq -r .currency)"
ff metrics --since 2h --output json
check "ff metrics counts the account's invocations of the last two hours" "0 true" "$(code) $(out | jq '[.metrics.Invocations[]] | add > 10')"
# Its calls that don't wait are counted a minute at a time too: in its metrics within two.
for _ in $(seq 150); do "$ff_bin" metrics --since 2h --output json 2>/dev/null | jq -e '([.metrics.AsyncEventsReceived[]] | add >= 2) and ([.metrics.AsyncEventsDropped[]] | add >= 1)' >/dev/null && break; sleep 1; done
ff metrics --since 2h --period 3600
check "  ... and its calls that didn't wait, as Lambda's metrics count them, cli-raises's dropped among them" "0 true" \
  "$(code) $(out | tail -1 | grep -E '; calls without waiting: ([2-9]|[1-9][0-9]+) kept, [1-9][0-9]* dropped' >/dev/null && echo true || echo false)"
}
section_def account section_account failures

section_local() {
section "ff local: on this machine, in Docker, as production runs it"
leftover() { docker ps -a --filter name=ff-local- --format '{{.Names}}' | wc -l; }
for example in hello.ts hello.py; do
  ff local invoke "$FF_REPO_ROOT/examples/$example" --data '{"name": "Local"}'
  check "local invoke of $example answers, in its runtime image, and says how it went" "0 Hello Local true" \
    "$(code) $(out | sed '$d' | jq -r .message) $(out | tail -1 | grep -E '^request [0-9a-f-]{36} · [0-9.]+ ms · [0-9.]+ MB, on this machine$' >/dev/null && echo true || echo false)"
done
check "with the handler's line and the runtime's report in its log" "true true" \
  "$(err | grep '^greeting Local$' >/dev/null && echo true || echo false) $(err | grep '^REPORT RequestId: ' >/dev/null && echo true || echo false)"
ff local invoke "$work/broken.py"
check "code that fails to load exits 4, with the runtime's reason" "4 error: The function failed to load: Runtime.UserCodeSyntaxError" \
  "$(code) $(err | grep '^error:' | cut -d: -f1-3)"
ff local invoke "$FF_REPO_ROOT/examples/slow.py" --timeout 1 --data '{"seconds": 3}'
check "a call past its timeout exits 5" "5 error: Sandbox.Timedout: Task timed out after 1.00 seconds" "$(code) $(err | grep '^error:')"
printf 'def handler(event, context):\n    hoard = []\n    while True:\n        hoard.append(bytearray(10 * 1024 * 1024))\n' >"$work/hog.py"
ff local invoke "$work/hog.py" --memory 128
check "a call over its memory exits 5, as the runtime reports it" "5 error: Runtime.OutOfMemory: Runtime exceeded its memory limit" "$(code) $(err | grep '^error:')"
check "no container is left behind" 0 "$(leftover)"
local_port="$(free_port)"
"$ff_bin" local start "$FF_REPO_ROOT/examples/hello.py" --port "$local_port" >"$work/start.out" 2>"$work/start.err" &
starter=$!
for _ in $(seq 1 60); do
  grep -q 'runs at' "$work/start.out" 2>/dev/null && break
  sleep 0.5
done
check "local start says where it runs" "hello (python) runs at http://127.0.0.1:$local_port/invoke: POST an event to it. Ctrl-C stops it" "$(cat "$work/start.out")"
check "and answers there, as the runtime answers the backend" "Hello Port" \
  "$(curl -s -X POST "http://127.0.0.1:$local_port/invoke" -d '{"name": "Port"}' | jq -r .message)"
kill -INT "$starter"
wait "$starter" 2>/dev/null || true
check "Ctrl-C stops it and removes its container" 0 "$(leftover)"
url_local_port="$(free_port)"
"$ff_bin" local start "$work/web.ts" --url --port "$url_local_port" >"$work/start.out" 2>"$work/start.err" &
starter=$!
for _ in $(seq 1 60); do
  grep -q 'runs as its URL would' "$work/start.out" 2>/dev/null && break
  sleep 0.5
done
check "local start --url serves it as its URL would" \
  "web (nodejs) runs as its URL would at http://127.0.0.1:$url_local_port/: any request calls it with AWS Lambda's URL event. Ctrl-C stops it" \
  "$(cat "$work/start.out")"
check "a request there gets the function's answer, from Lambda's URL event" "200 Ahlan Local at /hi" \
  "$(curl -s -o "$work/answer" -w '%{http_code}' "http://127.0.0.1:$url_local_port/hi?name=Local") $(cat "$work/answer")"
kill -INT "$starter"
wait "$starter" 2>/dev/null || true
check "and Ctrl-C removes its container too" 0 "$(leftover)"
}
section_def local section_local backend

sections_run
checks_done cli-e2e
