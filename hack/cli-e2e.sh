#!/usr/bin/env bash
# L3 for the ff command: the built binary against the whole stack, as a developer runs it:
#   PostgreSQL + S3 (compose project "ff-cli-e2e", ports 25436 / 29007) + the k3d dev cluster
#   + the backend (built, started on a free port in development mode, which acts as the account
#   a profile names, as hack/e2e.sh's requests do).
# For examples/hello.ts and examples/hello.py: deploy, invoke, the handler's line in ff logs and
# in ff logs --follow, an asynchronous call and a dry run, deploy again unchanged, scale, update, history, delete. A Python function that raises, and examples/slow.py past its timeout,
# exit 5 with the call's ID, which the history shows, the Python one's calls that don't wait set
# by ff async-config to go on to another function; code that fails to load exits 4, and the
# function is kept, in ERROR, with its error. A second account finds none of the first's. A function's versions
# and aliases: published by ff deploy --publish and by ff publish, called as name:alias and name:version, an alias
# moved with a share of its calls and rolled back, its own URL, a schedule through it, a version it names kept. Then
# ff init for both runtimes, its folder run locally, deployed and invoked; ff init's SAM application, sam init's hello
# world with a URL for its API, deployed as a stack, called and deleted with ff delete-stack, and sam init's own refused at
# its Api event; a stack with an alias, a second function, queues and a bucket's site and notifications, again
# unchanged, then without them, after asking, a variable with a secret's name refused, and ff delete-stack, stopped by
# the bucket's files; ff init's REST API, its README's commands run for both runtimes, the Python one deployed with
# a database of ff db's and called at its URL, with its CORS, each run with ff local start --with postgres; ff init's
# cron job, the Python one deployed, a file uploaded with the AWS CLI and reported, a failed run's record in its queue,
# each run here as its README says, its schedule by hand and a failed run tried three times; ff init's queue worker,
# the Node.js one deployed, a job done and one dead-lettered after three tries, each the same here; ff init's site with
# an API, the Node.js one deployed, its page by ff sites deploy and signed from its origin, each here with --site;
# ff init's image resizer, both deployed with --container and an image's thumbnail made, each the same here;
# folders deployed as packages with their libraries (an npm library, requests, numpy's native wheels from
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
# the customer's added, the bucket no site again; the downloads site, a release signed with a throwaway key and
# deployed to FF by ff sites deploy, installed from it by install.sh as a customer would, refused changed (its checks
# hack/test-install.sh's); ff queues: a queue made
# with its attributes and a dead-letter queue by name, a message sent by ff and received by the AWS CLI
# with a key naming that queue alone, received again by ff until the third receive moves it to the
# dead-letter queue, where ff receives and deletes it, a purge, attributes changed and seen by the AWS
# CLI, its metrics, the queue deleted and the other account seeing none, its month in ff usage; the getting-started
# guide's walkthrough of the small app on FF alone, one SAM template deployed as a stack, internet access off: its
# orders in FF's database, the latest kept in FF's cache, each one put in a queue with the function's own key, read by
# a function that writes its receipt to a bucket and e-mails it through the SES endpoint from an address proved by its
# link, the receipt read back by a GET and by the AWS CLI, both gone after the night 90 days on, called without
# waiting as its schedule calls it; its page a site, which the function URL's CORS lets in; its stack deleted at the
# end; the account exported to AWS, its template and terraform/ taken by the SAM CLI and OpenTofu, each function's
# role what its keys used, the template deployed back on FF by another account, which makes the same; ff login against
# the development realm in Keycloak (its own port, 28181) and a second backend that takes its tokens: the user's part
# of the device flow done with curl at the realm's pages, as a browser does it, the login kept and renewed, a user with
# two accounts shown them, an API key made by ff api-keys and put before the login, then revoked, and ff logout
# revoking the offline token at the realm; and ff local, in Docker: both runtimes, a failed load, a timeout, a call over its memory, and ff local start
# answering on its port until Ctrl-C, no container left behind; a template's app behind its front door, each function
# started at its first call, its variables resolved there and its secrets from .env.local, one calling another through
# the front door, started again when its code changes and stopped when idle; ff init's SAM application and the small app
# on it, called at their URLs, the small app's nightly run by hand and retried; a template's queues there, the AWS
# CLI's SQS cases against them, a function sending to one, a failed call's record and dead letter in them; the mail its
# functions send, the AWS CLI's SES cases and a function's receipt, kept as files a mail reader opens, listed by ff
# local mail, never sent; the small app whole there with its database and its cache: its page served, an order kept,
# listed from the cache, its receipt made through the local queue into the local bucket and e-mailed, its nightly
# removing an old order and its receipt; then a release's runtime image, made, signed and put on
# a site of FF's as the release job does, ff pinned to it: pulled by its digest from the dev registry, else its archive
# loaded from the site, verified, once, and refused when signed by another key or changed.
# What waits on the clock (the schedule's runs, a sample taken each minute, requests and visits written a minute at a
# time) is started in its section and read a few sections on, in a section of its own (schedules_ran, databases_used,
# buckets_used, sites_counted, queues_counted, small_app_exported), so that its minute passes while the sections between
# run: what it checks is the same, a real minute of the product's, and a section run alone waits as long as before.
# Removes its compose project, its namespaces and the backend on exit; keeps the cluster. Its sections run alone
# too, with what they need (hack/lib/sections.sh): --list names them, --only and --from choose. --keep removes
# nothing on exit, for a look and for the next run, which --reuse runs against the same stack (hack/lib/e2e-stack.sh
# says what each keeps).
#   hack/cli-e2e.sh [--teardown | --keep] [--reuse] [--list | --only <section>[,<section>…] | --from <section>]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-cli-e2e
E2E_NAME=cli-e2e
export FF_PG_PORT="${FF_CLI_E2E_PG_PORT:-25436}"
export FF_S3_PORT="${FF_CLI_E2E_S3_PORT:-29007}"
# Keycloak, for ff login's section alone.
export FF_KEYCLOAK_PORT="${FF_CLI_E2E_KEYCLOAK_PORT:-28181}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
source "$FF_REPO_ROOT/hack/lib/sections.sh"
source "$FF_REPO_ROOT/hack/lib/orders-app.sh"
source "$FF_REPO_ROOT/hack/lib/keycloak.sh"
sections_options "$@"
e2e_options "${sections_rest[@]}"

be_port="$(free_port)"
api="http://127.0.0.1:$be_port"
account_a="$(random_account)"
account_b="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_a")" "$(tenant_namespace "$account_b")")

# What more than one section uses: ff, its output kept, and FF's database.

# ff <args...>: its stdout in $work/out, its stderr in $work/err, its exit code in $work/code.
ff() {
  local code=0
  "$ff_bin" "$@" >"$work/out" 2>"$work/err" || code=$?
  echo "$code" >"$work/code"
}

out() { cat "$work/out"; }
err() { cat "$work/err"; }
code() { cat "$work/code"; }
# in_folder <folder> <args...>: ff in an application's folder, where a template's CodeUri starts and samconfig.toml
# names the stack.
in_folder() { local folder=$1; shift; (cd "$folder" && ff "$@"); }

# sql <statement>: run on FF's database, its answer dropped.
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }

# local_image <name>: the image ff local start --with runs, as cli/src/local/services.rs pins it, by digest; its client
# reaches the service here as a developer's tools would, at its port.
local_image() { sed -n "s|^ *\"\($1:[^\"]*@sha256:[0-9a-f]*\)\"$|\1|p" "$FF_REPO_ROOT/cli/src/local/services.rs"; }
# local_url <ff local start's listing> <service>: the service's URL from this machine, with its password, as listed.
local_url() { sed -n "s/^  $2 \{1,\}\([a-z]*:\/\/[^,]*\),.*/\1/p" "$1"; }
# local_psql <listing> <statement>: the statement run at the PostgreSQL the listing names, its rows unaligned.
local_psql() { docker run --rm --network host "$(local_image postgres)" psql "$(local_url "$1" postgres)" -Atqc "$2" 2>&1; }
# read_mail <file>: the message as a mail reader shows it: its sender, its recipients, its subject decoded, its type,
# and its text.
read_mail() {
  python3 -I -c 'import email, email.policy, sys
message = email.message_from_binary_file(open(sys.argv[1], "rb"), policy=email.policy.default)
print(message["from"], "|", message["to"], "|", message["subject"], "|", message.get_content_type(), "|", message.get_body(("plain",)).get_content().strip())' "$1"
}

# leftover: how many of ff local's containers are left, running or stopped.
leftover() { docker ps -a --filter name=ff-local- --format '{{.Names}}' | wc -l | tr -d ' '; }
# at <url> [curl args...]: a request, its status and its answer; its headers in $work/at.head.
at() {
  local url="$1"
  shift
  curl -s -o "$work/at.body" -D "$work/at.head" -w '%{http_code}' "$@" "$url"
  echo " $(cat "$work/at.body")"
}
# local_started <listing> <its stderr> <ff local start's args...>: ff local start in the background, its pid in
# $starter, until it says how to stop it: 120 s at most, as a first start with --with pulls its images, and less if it
# ends.
local_started() {
  local listing="$1" errors="$2" _
  shift 2
  "$ff_bin" local start "$@" >"$listing" 2>"$errors" &
  starter=$!
  for _ in $(seq 1 240); do
    grep -F "Ctrl-C stops" "$listing" >/dev/null 2>&1 && return 0
    kill -0 "$starter" 2>/dev/null || break
    sleep 0.5
  done
  grep -F "Ctrl-C stops" "$listing" >/dev/null 2>&1 ||
    fail "ff local start $* said nothing in 120 s, or ended: $(cat "$errors")"
}
# local_stopped: Ctrl-C to the ff local start local_started made, its end waited for.
local_stopped() {
  kill -INT "$starter"
  wait "$starter" 2>/dev/null || true
}
# local_aws <project> <port> <aws args...>: the AWS CLI with the local key's file of ff local's project alone, none of
# this machine's settings, the front door at the port the endpoint of each service.
local_aws() {
  local project="$1" door="http://127.0.0.1:$2"
  shift 2
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE="$project/.ff/local/credentials" AWS_PROFILE=default \
    AWS_REGION=tn-tunis-1 AWS_ENDPOINT_URL_LAMBDA="$door" AWS_ENDPOINT_URL_SQS="$door" AWS_ENDPOINT_URL_S3="$door" \
    AWS_ENDPOINT_URL_SESV2="$door" "${aws_cli[@]}" "$@"
}

# template_files <folder>: the files ff init wrote there, sorted, on one line.
template_files() { (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | paste -sd' '); }
# git_sees <folder>: the files git takes of the folder made a repository, what its .gitignore leaves in, on one line.
git_sees() {
  git -C "$1" init -q
  git -C "$1" status --porcelain --untracked-files=all | sed 's/^?? //' | LC_ALL=C sort | paste -sd' '
}
# readme_here <folder>: a template's README's commands before its ff local start, as written, which install its
# libraries and run its tests: their exit, then how many tests passed.
readme_here() {
  local status=0
  (cd "$1" && bash -e -o pipefail -c "$(sed -n '/^## Here$/,/^ff local start/p' README.md | sed '1,3d;$d')") \
    >"$work/here.out" 2>&1 || status=$?
  echo "$status $(sed -nE 's/^(# |ℹ )pass ([0-9]+)$/\2/p; s/^Ran ([0-9]+) tests? in .*/\1/p' "$work/here.out")"
}
# readme_after <folder> <line> <sed script>: a template's README's commands after the line its pattern finds, to the
# end of their block, as written but for the script's changes, ff local start's port or a placeholder's value, with
# the suite's ff: their exit; what they wrote in $work/after.out, their stderr in $work/after.err.
readme_after() {
  local status=0
  (cd "$1" && PATH="$(dirname "$ff_bin"):$PATH" bash -e -o pipefail -c \
    "$(sed -n "/$2/,/^\`\`\`\$/p" README.md | sed '1d;$d;/^```bash$/d' | sed "$3")") \
    >"$work/after.out" 2>"$work/after.err" || status=$?
  echo "$status"
}
# preflight <URL> <origin>: the origin a browser's preflight for a POST from it is let in as, or none.
preflight() {
  local allowed
  allowed="$(curl -s -o /dev/null -D - -X OPTIONS "$1" -H "Origin: $2" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' | tr -d '\r' | sed -n 's/^access-control-allow-origin: //Ip')"
  echo "${allowed:-none}"
}
# until_found <url>: waits up to 30 s for the URL to answer 200.
until_found() {
  local _
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = 200 ] && return 0
    sleep 0.5
  done
  return 1
}

# release_site <folder> <bucket>: a release of ff as the release job makes it, on a site FF serves as the downloads
# site, http://<bucket>.site.localhost:<port>: this machine's build the suite's ff, the other four stand-ins, signed by
# hack/release.sh with a throwaway key (<folder>/release.pub) and made a site by hack/downloads-site.sh, then put on
# the bucket by ff sites deploy. FF_RUNTIME_IMAGES, when set, names runtime images' archives already in <folder>/dist.
release_site() {
  local folder=$1 bucket=$2 binary processor version
  local minisign="${FF_TOOLS_BIN:-$FF_REPO_ROOT/hack/bin}/minisign"
  version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$FF_REPO_ROOT/cli/Cargo.toml" | head -1)"
  case "$(uname -m)" in x86_64 | amd64) processor=x86_64 ;; *) processor=arm64 ;; esac
  source "$FF_REPO_ROOT/hack/lib/ff-builds.sh"
  mkdir -p "$folder/dist"
  for binary in "${FF_BUILDS[@]}"; do
    if [ "$binary" = "ff-linux-$processor" ]; then
      cp "$ff_bin" "$folder/dist/$binary"
    else
      printf 'stand-in for %s\n' "$binary" >"$folder/dist/$binary"
    fi
    (cd "$folder/dist" && sha256sum "$binary" >"$binary.sha256")
  done
  "$minisign" -G -W -p "$folder/release.pub" -s "$folder/release.key" >/dev/null 2>&1
  FF_RELEASE_KEY="$(cat "$folder/release.key")" FF_RELEASE_PUBLIC_KEY="$folder/release.pub" \
    "$FF_REPO_ROOT/hack/release.sh" "$folder/dist" "ff-v$version" 0123456789ab >>"$folder/made.out"
  FF_RELEASE_PUBLIC_KEY="$folder/release.pub" "$FF_REPO_ROOT/hack/downloads-site.sh" "$folder/dist" "$folder/site" \
    "$(site_of "$bucket")" >>"$folder/made.out"
  "$ff_bin" buckets create "$bucket" >>"$folder/made.out" 2>&1
  "$ff_bin" sites deploy "$bucket" "$folder/site" >>"$folder/made.out" 2>&1
}
site_of() { echo "http://$1.site.localhost:$website_port"; }

# aws_cli: the AWS CLI, this machine's, else AWS's image: as this user, so that the files it writes are this user's,
# s3.localhost this machine, given the variables AWS's tools read that the sections set.
if command -v aws >/dev/null; then aws_cli=("$(command -v aws)"); else
  aws_cli=(docker run --rm --network host --add-host s3.localhost:127.0.0.1 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$work:$work"
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION -e AWS_ENDPOINT_URL_S3 -e AWS_ENDPOINT_URL_SQS
    -e AWS_ENDPOINT_URL_LAMBDA -e AWS_ENDPOINT_URL_SESV2 -e AWS_CONFIG_FILE -e AWS_SHARED_CREDENTIALS_FILE
    -e AWS_PROFILE amazon/aws-cli:2.34.32)
fi

section_stack() {
section "the stack: its database and object storage, the cluster, customers' database, cache and mail servers"
e2e_within_one_month 12
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
section_def stack section_stack budget=90

section_backend() {
section "ff and the backend"
# Release's optimizations without its link-time ones (cli/Cargo.toml's e2e profile), which take most of a build after
# each commit: the commit is built in, so every commit builds ff again.
(cd "$FF_REPO_ROOT/cli" && cargo build --profile e2e --locked -q)
ff_bin="$FF_REPO_ROOT/cli/target/e2e/ff"
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
# The sections run one after another, with no wait between them to spread their changes, and A's pass its plan's 60 a
# minute, after which the rate limit holds the account a minute: A is on a plan of the test's own, with beta's limits
# but that one.
sql "INSERT INTO plans (id, name, limits) SELECT 'cli-e2e', 'CLI e2e', limits || '{\"writesPerMinute\": 10000}' FROM plans WHERE id = 'beta'"
sql "UPDATE accounts SET plan_id = 'cli-e2e' WHERE id = '$account_a'"

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
section_def backend section_backend stack budget=90

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
section_def failures section_failures backend budget=45

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
section_def environment section_environment backend budget=40

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
section_def secrets section_secrets backend budget=25

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
check "ff url show says its address and who may call it" "0 $address callers need an access key of the account that may invoke it, signing for lambda, or an API key of it with functions:invoke" \
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
section_def url section_url backend budget=15

section_versions() {
section "versions and aliases: ff publish, ff alias, name:alias called, through its URL and a schedule"
answering() {
  printf 'export async function handler() {\n  return { statusCode: 200, headers: { "content-type": "text/plain" }, body: "%s" };\n}\n' "$1" >"$work/versioned.ts"
}
answering one
ff deploy "$work/versioned.ts" --name cli-ver --publish --alias live
check "ff deploy --publish --alias publishes version 1 and points the alias at it" "0 version 1 published cli-ver:live made: version 1" \
  "$(code) $(out | sed -n 2p) $(out | sed -n 3p)"
answering two
ff deploy "$work/versioned.ts" --name cli-ver --publish
check "changed and published again, version 2, the alias where it was" "0 version 2 published" "$(code) $(out | tail -1)"
answers=""
for target in cli-ver cli-ver:live cli-ver:2; do
  ff invoke "$target" --raw
  answers+=" $(code) $(out | jq -r .body)"
done
check "a call runs \$LATEST, name:alias what the alias names, name:version that version" " 0 two 0 one 0 two" "$answers"
ff publish cli-ver
check "ff publish with nothing changed answers the last version, as Lambda does" \
  "0 cli-ver: nothing but the description changed since version 2, which it is again, as Lambda answers" "$(code) $(out)"
ff alias set cli-ver live 2 --also 1 10%
check "ff alias set moves it, a share of its calls to the version before, saying what it was and is" \
  "0 cli-ver:live: version 1 → version 2, 10% of its calls to version 1" "$(code) $(out)"
ff versions cli-ver
check "ff versions lists them newest first, with the aliases whose calls reach each" "0 2 live 90% 1 live 10%" \
  "$(code) $(out | sed -n '2,3p' | awk '{ print $1, $9, $10 }' | paste -sd' ')"
ff alias set cli-ver live 1
check "a rollback is a set to the version before: every call to it, the share gone" \
  "0 cli-ver:live: version 2, 10% of its calls to version 1 → version 1" "$(code) $(out)"
ff invoke cli-ver:live --raw
check "which the alias's calls run at once" "0 one" "$(code) $(out | jq -r .body)"
ff url enable cli-ver --alias live --auth none
alias_address="$(out | head -1 | sed 's/^cli-ver:live has a URL: //')"
ff invoke cli-ver:live --http GET /
check "the alias's own URL, which ff invoke name:alias --http calls, runs what it names" "0 HTTP 200 one" "$(code) $(out | head -1) $(out | tail -1)"
ff alias list cli-ver
check "ff alias list says where its calls go, and its URL" "0 live version 1 $alias_address" "$(code) $(out | sed -n 2p | awk '{ print $1, $2, $3, $4 }')"
ff schedule set cli-ver "rate(1 hour)" --qualifier live
check "a schedule runs the alias, which ff schedule set and list say" \
  "0 cli-ver's schedule schedule made: rate(1 hour), running alias live, with EventBridge's Scheduled Event alias live" \
  "$(code) $(out | head -1) $(ff schedule list cli-ver; out | sed -n 2p | awk '{ print $2, $3 }')"
ff versions cli-ver --delete 1 --yes
check "a version an alias names isn't deleted, in the API's words" \
  "3 error: Version 1 of the function cli-ver is named by its alias live: point it at another version, or delete it, first" "$(code) $(err | head -1)"
ff alias remove cli-ver live --yes
check "ff alias remove removes it" "0 cli-ver:live removed: what names it stops until an alias of that name is made again" "$(code) $(out)"
ff url show cli-ver --alias live
check "its URL with it" "3" "$(code)"
ff invoke cli-ver:live --raw
check "and a call to it is refused, in the API's words" \
  "3 error: The function cli-ver has no alias live: GET /functions/{id}/aliases lists them" "$(code) $(err | head -1)"
ff versions cli-ver --delete 1 --yes
check "then the version is deleted" "0 cli-ver: version 1 deleted" "$(code) $(out)"
ff delete cli-ver --yes
}
section_def versions section_versions backend budget=40

section_schedules() {
section "schedules: ff schedule set, its runs read a few sections on"
ff deploy "$FF_REPO_ROOT/examples/hello.py" --name cli-sched
sched_made_at="$(date -u +%s)"
ff schedule set cli-sched "rate(1 minute)" --input '{"name": "Schedule"}'
check "ff schedule set makes it, and says its next runs" "0 cli-sched's schedule schedule made: rate(1 minute), with its own input true" \
  "$(code) $(out | head -1) $(out | sed -n 2p | grep -E '^next runs \(UTC\): [0-9-]+ [0-9:]+, ' >/dev/null && echo true || echo false)"
ff schedule set cli-sched "rate(5 minute)"
check "a wrong expression is said in the API's words, and nothing changes" "3 error: rate(5 minute) must be rate(5 minutes): the unit is plural above 1" "$(code) $(err | head -1)"
}
section_def schedules section_schedules backend budget=10

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
section_def init section_init backend budget=35

section_stacks() {
section "SAM templates as stacks: ff init --template sam deployed and called at its URL, sam init's own refused, a stack deployed with a second function, events, queues and a bucket's site and notifications, then without them, ff delete-stack"
(cd "$work" && rm -rf cli-sam && "$ff_bin" init cli-sam --runtime nodejs --template sam >"$work/out" 2>"$work/err")
check "ff init --template sam makes sam init's hello world as FF takes it: its template, code, event and test, samconfig.toml naming the stack" \
  ".gitignore README.md events/event.json hello-world/app.mjs hello-world/package.json samconfig.toml template.yaml tests/unit/test-handler.mjs" \
  "$(cd "$work/cli-sam" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | paste -sd' ')"
in_folder "$work/cli-sam" deploy template.yaml --output json
hello="$(out | jq -r '.functions[0].name')"
check "ff deploy makes its function in the stack samconfig.toml names, its outputs the function's URL and ARN" \
  "0 created HelloWorldFunction true true" \
  "$(code) $(out | jq -r '.functions | map("\(.action) \(.logicalId)") | join(", ")') $(out | jq -r --arg name "$hello" \
    '(.functions[0].url // "" | startswith("http")) and ([.outputs[] | select(.name == "HelloWorldApi") | .value][0] == .functions[0].url),
     ([.outputs[] | select(.name == "HelloWorldFunction") | .value][0] // "" | endswith(":function:" + $name))' | paste -sd' ')"
ff invoke "$hello" --http GET /hello
check "which answers at its URL as sam init's did at its API" "0 HTTP 200 hello world" "$(code) $(out | head -1) $(out | tail -1 | jq -r .message)"
in_folder "$work/cli-sam" delete-stack --yes
check "ff delete-stack deletes the stack samconfig.toml names, with what it made" \
  "0 deleted the function $hello (HelloWorldFunction) deleted the stack cli-sam" "$(code) $(out | paste -sd' ')"
ff get "$hello"
check "its function with it" "3" "$(code)"

rm -rf "$work/sam-init" && mkdir -p "$work/sam-init"
cp "$FF_REPO_ROOT/cli/src/sam/testdata/hello-node.yaml" "$work/sam-init/template.yaml"
in_folder "$work/sam-init" deploy template.yaml --stack-name sam-init
check "sam init's own hello world is refused, each problem at its line, its Api event's naming FunctionUrlConfig and HttpApi" "2 true true" \
  "$(code) $(err | head -1 | grep '^error: ff deploy changed nothing: the template has [0-9]* problems$' >/dev/null && echo true || echo false) $(err | grep "^template.yaml:25: HelloWorldFunction's event HelloWorld: an Api event makes an API Gateway REST API, which FF hasn't: the function's FunctionUrlConfig gives it a URL, and HttpApi events, all of one function, go to that URL$" >/dev/null && echo true || echo false)"

# A stack of the suite's own: a parameter from samconfig.toml, an alias and its URL, a bucket, and, in
# with-reports.yaml, a second function, whose HttpApi event gives it a URL, whose S3 event the bucket tells and whose
# DeletionPolicy retains it, a queue with its dead-letter queue, the first's Schedule and SQS events, and the bucket's
# tags, site and notification to the queue, which the deploy after the next no longer has.
stack="$work/cli-stack"
rm -rf "$stack" && mkdir -p "$stack/src"
cat >"$stack/src/app.mjs" <<'EOF'
export const handler = async (event) => ({ message: `Hello ${event.queryStringParameters?.name ?? 'world'}`, stage: process.env.STAGE, jobs: process.env.JOBS_URL });
EOF
printf 'version = 0.1\n\n[default.deploy.parameters]\nstack_name = "cli-stack"\nparameter_overrides = "Stage=dev"\n' >"$stack/samconfig.toml"
cat >"$stack/template.yaml" <<'EOF'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Parameters:
  Stage:
    Type: String
    Default: test
    AllowedValues: [test, dev, prod]
Globals:
  Function:
    Runtime: nodejs24.x
    MemorySize: 128
    Timeout: 10
Resources:
  HelloFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Description: !Sub Says hello, in ${Stage}
      Environment:
        Variables:
          STAGE: !Ref Stage
      AutoPublishAlias: live
      FunctionUrlConfig:
        AuthType: NONE
  UploadsBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: cli-stack-uploads

Outputs:
  HelloUrl:
    Value: !GetAtt HelloFunctionUrl.FunctionUrl
  HelloFunctionName:
    Value: !Ref HelloFunction
EOF
cat >"$stack/more-resources.yaml" <<'EOF'
  ReportsFunction:
    Type: AWS::Serverless::Function
    DeletionPolicy: Retain
    Properties:
      FunctionName: cli-stack-reports
      CodeUri: src/
      Handler: app.handler
      ReservedConcurrentExecutions: 2
      Tags:
        team: reports
      Events:
        Reports:
          Type: HttpApi
          Properties:
            Path: /reports
            Method: get
        Upload:
          Type: S3
          Properties:
            Bucket: !Ref UploadsBucket
            Events: s3:ObjectCreated:*
            Filter:
              S3Key:
                Rules:
                  - Name: prefix
                    Value: reports/
  JobsQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: cli-stack-jobs
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt JobsFailedQueue.Arn
        maxReceiveCount: 3
      Tags:
        - Key: team
          Value: jobs
  JobsFailedQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: cli-stack-jobs-failed

EOF
awk -v more="$stack/more-resources.yaml" '/^Outputs:/ { while ((getline line < more) > 0) print line } { print }' \
  "$stack/template.yaml" >"$stack/with-reports.yaml"
printf '  JobsUrl:\n    Value: !Ref JobsQueue\n  UploadsSite:\n    Value: !GetAtt UploadsBucket.WebsiteURL\n' >>"$stack/with-reports.yaml"
printf '  UploadsDomain:\n    Value: !GetAtt UploadsBucket.DomainName\n' >>"$stack/with-reports.yaml"
sed -i 's/^          STAGE: !Ref Stage$/&\n          JOBS_URL: !Ref JobsQueue/' "$stack/with-reports.yaml"
cat >"$stack/uploads-bucket.yaml" <<'EOF'
      Tags:
        - Key: team
          Value: uploads
      WebsiteConfiguration:
        IndexDocument: index.html
      NotificationConfiguration:
        QueueConfigurations:
          - Event: s3:ObjectRemoved:*
            Queue: !GetAtt JobsQueue.Arn
EOF
sed -i "/^      BucketName: cli-stack-uploads$/r $stack/uploads-bucket.yaml" "$stack/with-reports.yaml"
cat >"$stack/hello-events.yaml" <<'EOF'
      Events:
        Nightly:
          Type: Schedule
          Properties:
            Schedule: cron(0 2 * * ? *)
            Input: '{"report": "nightly"}'
        Jobs:
          Type: SQS
          Properties:
            Queue: !GetAtt JobsQueue.Arn
            BatchSize: 5
EOF
sed -i "/^      AutoPublishAlias: live$/r $stack/hello-events.yaml" "$stack/with-reports.yaml"
# broken.yaml: an expression FF's schedules don't take, queues the account hasn't, a function's and the bucket's, and
# names another queue and another bucket have.
sed -e 's/cron(0 2 \* \* ? \*)/cron(0 2 * * *)/' \
  -e 's/Queue: !GetAtt JobsQueue.Arn/Queue: !Sub arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:cli-stack-missing/' \
  -e 's/deadLetterTargetArn: !GetAtt JobsFailedQueue.Arn/deadLetterTargetArn: !Sub arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:cli-stack-gone/' \
  -e 's/QueueName: cli-stack-jobs-failed/QueueName: cli-stack-taken/' \
  -e 's/BucketName: cli-stack-uploads/BucketName: cli-stack-taken/' "$stack/with-reports.yaml" >"$stack/broken.yaml"
ff queues create cli-stack-taken
ff buckets create cli-stack-taken
in_folder "$stack" deploy broken.yaml
# refused <message>: whether ff deploy said it at a line of broken.yaml.
refused() { err | sed -n 's/^broken\.yaml:[0-9][0-9]*: //p' | grep -F -x -- "$1" >/dev/null && echo true || echo false; }
check "an expression FF's schedules wouldn't take, queues the account hasn't and a queue's name taken outside the stack are refused at their lines, before any change" "2 true true true true" \
  "$(code) $(refused "HelloFunction: event Nightly's Schedule cron(0 2 * * *): cron() takes six fields, minutes hours day-of-month month day-of-week year; got 5") $(refused "HelloFunction: event Jobs reads the queue cli-stack-missing, which the account hasn't: \`ff queues create cli-stack-missing\` makes it") $(refused "JobsQueue: RedrivePolicy's dead-letter queue cli-stack-gone, which the account hasn't: a queue of the template, or \`ff queues create cli-stack-gone\`, makes it") $(refused "JobsFailedQueue: the account has a queue cli-stack-taken outside the stack: ff deploy doesn't take it over; give JobsFailedQueue another QueueName, or delete that queue with \`ff queues delete cli-stack-taken\`")"
check "  ... as are a queue a bucket tells that the account hasn't, and a bucket's name taken outside the stack" "true true" \
  "$(refused "UploadsBucket: the notification UploadsBucketQueue1 tells the queue cli-stack-missing, which the account hasn't: a queue of the template, or \`ff queues create cli-stack-missing\`, makes it") $(refused "UploadsBucket: the account has a bucket cli-stack-taken outside the stack: ff deploy doesn't take it over; give UploadsBucket another BucketName, or delete that bucket with \`ff buckets delete cli-stack-taken\`")"
ff queues delete cli-stack-taken --yes
ff buckets delete cli-stack-taken --yes
in_folder "$stack" deploy with-reports.yaml --output json
hello="$(out | jq -r '.outputs[] | select(.name == "HelloFunctionName") | .value')"
jobs_url="$(out | jq -r '.outputs[] | select(.name == "JobsUrl") | .value')"
queues_made="$(out | jq -r '.queues | map("\(.action) \(.logicalId)") | join(", ")')"
buckets_made="$(out | jq -r '.buckets | map("\(.action) \(.logicalId)") | join(", ")')"
uploads_site="$(out | jq -r '.outputs[] | select(.name == "UploadsSite") | .value')"
uploads_domain="$(out | jq -r '.outputs[] | select(.name == "UploadsDomain") | .value')"
check "ff deploy makes each function of the template, its alias's version published, its outputs resolved" \
  "0 created HelloFunction 1, created ReportsFunction - true" \
  "$(code) $(out | jq -r '.functions | map("\(.action) \(.logicalId) \(.version // "-")") | join(", ")') $([[ $hello =~ ^cli-stack-HelloFunction-[A-Z0-9]{12}$ ]] && echo true || echo false)"
ff queues get cli-stack-jobs --output json
check "and each queue before them, the dead-letter queue first, with the template's attributes and tags; an output gives its public URL" \
  "created JobsFailedQueue, created JobsQueue 0 60 cli-stack-jobs-failed 3 jobs http://localhost:$sqs_port/$account_a/cli-stack-jobs" \
  "$queues_made $(code) $(out | jq -r '"\(.visibilityTimeout) \(.redrivePolicy.deadLetterTargetArn | split(":") | last) \(.redrivePolicy.maxReceiveCount) \(.tags.team)"') $jobs_url"
ff buckets get cli-stack-uploads --output json
check "and each bucket first, with its tags, a site; outputs give the site's address and the bucket's domain" \
  "created UploadsBucket 0 uploads http://cli-stack-uploads.site.localhost:$website_port cli-stack-uploads.s3.localhost:$storage_port" \
  "$buckets_made $(code) $(out | jq -r .tags.team) $uploads_site $uploads_domain"
ff buckets notifications cli-stack-uploads --output json
check "whose notifications are its own configuration's and its function's S3 event, put once the function is made" \
  "0 ReportsFunctionUpload cli-stack-reports s3:ObjectCreated:* reports/, UploadsBucketQueue1 cli-stack-jobs s3:ObjectRemoved:*" \
  "$(code) $(out | jq -r '(.lambdaFunctionConfigurations + .queueConfigurations) | map([.id, ((.lambdaFunctionArn // .queueArn) | split(":") | last), (.events | join(",")), (.filter.key.filterRules[0].value // empty)] | join(" ")) | join(", ")')"
ff invoke "$hello:live" --http GET "/?name=Stack"
check "the function answers at its alias's URL, with samconfig.toml's value of the parameter and the URL it reaches its queue at, in the cluster" \
  "0 HTTP 200 Hello Stack dev http://$cluster_gateway:$sqs_port/$account_a/cli-stack-jobs" \
  "$(code) $(out | head -1) $(out | tail -1 | jq -r '"\(.message) \(.stage) \(.jobs)"')"
ff get cli-stack-reports --output json
check "each function is the stack's, as ff get says, with its settings from the template" "0 cli-stack 2 reports" "$(code) $(out | jq -r '"\(.stack) \(.maxInstances) \(.tags.team)"')"
ff schedule list "$hello" --output json
check "a Schedule event is a schedule of the function, running its alias, with the event's input" "0 Nightly cron(0 2 * * ? *) live nightly true" \
  "$(code) $(out | jq -r '.[] | "\(.name) \(.expression) \(.qualifier) \(.input.report) \(.enabled)"')"
ff event-sources list --function "$hello" --output json
check "an SQS event has the alias read the queue, five messages a call" "0 cli-stack-jobs 5 live Enabled" \
  "$(code) $(out | jq -r '.[] | "\(.eventSourceArn | split(":") | last) \(.batchSize) \(.functionArn | split(":") | last) \(.state)"')"
ff invoke cli-stack-reports --http GET /reports
check "and the function of an HttpApi event answers its route at its URL" "0 HTTP 200 Hello world" "$(code) $(out | head -1) $(out | tail -1 | jq -r .message)"
in_folder "$stack" deploy with-reports.yaml --output json
check "deployed again, nothing changes" "0 unchanged HelloFunction 1, unchanged ReportsFunction - unchanged JobsFailedQueue, unchanged JobsQueue unchanged UploadsBucket" \
  "$(code) $(out | jq -r '.functions | map("\(.action) \(.logicalId) \(.version // "-")") | join(", ")') $(out | jq -r '.queues | map("\(.action) \(.logicalId)") | join(", ")') $(out | jq -r '.buckets | map("\(.action) \(.logicalId)") | join(", ")')"
mkdir -p "$stack/site" && printf '<!doctype html><title>cli stack site</title>' >"$stack/site/index.html"
ff sites deploy cli-stack-uploads "$stack/site"
check "ff sites deploy fills the template's site, which answers at the address its output gave" "0 200 cli stack site" \
  "$(code) $(curl -s -o "$work/page.html" -w '%{http_code}' "$uploads_site/") $(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$work/page.html")"
echo "token-$account_a" | ff secrets set "$hello" API_TOKEN
sed 's/^          STAGE: !Ref Stage$/&\n          API_TOKEN: in-the-template/' "$stack/template.yaml" >"$stack/with-secret.yaml"
in_folder "$stack" deploy with-secret.yaml --yes
check "a variable with the name of one of the function's secrets is refused, at its line, before any change" "2 true" \
  "$(code) $(err | grep "^with-secret.yaml:[0-9]*: HelloFunction: API_TOKEN is a secret of $hello's, which stays with \`ff secrets\`" >/dev/null && echo true || echo false)"
in_folder "$stack" deploy template.yaml --parameter-overrides Stage=prod
check "what the template no longer has is deleted after asking, which a script says with --yes" \
  "2 error: ff deploy asks first, and there is no terminal to ask in: say --yes" "$(code) $(err | tail -1)"
in_folder "$stack" deploy template.yaml --parameter-overrides Stage=prod --yes --output json
check "with --yes, the function changed and published, the events and the queues the template no longer has deleted, the function it retained kept, the bucket's tags, site and notifications gone" \
  "0 updated HelloFunction environment,description 2 HelloFunctionNightly HelloFunctionJobs JobsFailedQueue JobsQueue kept ReportsFunction updated UploadsBucket tags,site,notifications" \
  "$(code) $(out | jq -r '.functions | map("\(.action) \(.logicalId) \(.changed | join(",")) \(.version)") | join(", ")') $(out | jq -r '.deleted | map(.logicalId) | join(" ")') kept $(out | jq -r '.kept | map(.logicalId) | join(" ")') $(out | jq -r '.buckets | map("\(.action) \(.logicalId) \(.changed | join(","))") | join(", ")')"
ff get cli-stack-reports --output json
check "which stays in the account, in no stack, as CloudFormation leaves it; the schedule, the queue's reader and the queues are gone" "0 none 0 0 0" \
  "$(code) $(out | jq -r '.stack // "none"') $(ff schedule list "$hello" --output json; out | jq length) $(ff event-sources list --function "$hello" --output json; out | jq length) $(ff queues list --output json; out | jq '[.[] | select(.name | startswith("cli-stack"))] | length')"
ff delete cli-stack-reports --yes
ff invoke "$hello:live" --http GET "/?name=Stack"
check "and the alias's URL runs the new version" "0 HTTP 200 Hello Stack prod" "$(code) $(out | head -1) $(out | tail -1 | jq -r '"\(.message) \(.stage)"')"
in_folder "$stack" delete-stack --yes
check "ff delete-stack stops at a bucket with files, as CloudFormation does, saying how to go on" \
  "3 error: The bucket cli-stack-uploads (UploadsBucket) isn't empty, and CloudFormation deletes a bucket that is: empty it, or delete it with \`ff buckets delete cli-stack-uploads --force\`, then run this again" \
  "$(code) $(err | tail -1)"
ff buckets delete cli-stack-uploads --force --yes
in_folder "$stack" delete-stack --yes
check "then deletes the stack with what it made, its function with its alias and URL" \
  "0 deleted the function $hello (HelloFunction) deleted the bucket cli-stack-uploads (UploadsBucket) deleted the stack cli-stack" \
  "$(code) $(out | paste -sd' ')"
ff get "$hello"
check "which is gone" "3" "$(code)"
}
section_def stacks section_stacks backend budget=80

section_template_rest_api() {
section "ff init --template rest-api: a REST API at a function's URL, its items in PostgreSQL; the Python one deployed on FF with a database of ff db's, then each runtime's run here as its README says, with ff local start --with postgres"
local runtime api url items db_conn deleted base port starter id
declare -A written=(
  [nodejs]=".gitignore README.md events/create-item.json events/list-items.json samconfig.toml src/app.mjs src/package-lock.json src/package.json template.yaml tests/app.test.mjs"
  [python]=".gitignore README.md events/create-item.json events/list-items.json samconfig.toml src/app.py src/requirements.txt template.yaml tests/__init__.py tests/test_app.py"
)
for runtime in python nodejs; do
  (cd "$work" && rm -rf "cli-rest-$runtime" && "$ff_bin" init "cli-rest-$runtime" --runtime "$runtime" --template rest-api >"$work/out" 2>"$work/err")
  check "ff init --template rest-api makes cli-rest-$runtime's template, code, tests, events and README, and nothing else" "${written[$runtime]}" \
    "$(template_files "$work/cli-rest-$runtime")"
done

# On FF, from the folder as ff init wrote it: ff deploy installs psycopg's Linux build itself.
api="$work/cli-rest-python"
in_folder "$api" deploy template.yaml --output json
url="$(out | jq -r '.outputs[] | select(.name == "ApiUrl") | .value')"
check "the Python one deployed as the stack samconfig.toml names: its function, psycopg installed by ff deploy, its URL the output ApiUrl" \
  "0 cli-rest-python created cli-rest-python-api true" \
  "$(code) $(out | jq -r '"\(.stack) \(.functions[0].action) \(.functions[0].name)"') $(out | jq -r --arg url "$url" '.functions[0].url == $url and ($url | startswith("http"))')"
ff db create cli-rest --secret-for cli-rest-python-api --output json
db_conn="$(out | jq -r .connectionString)"
check "ff db create makes its database, its address the function's DATABASE_URL, as its README says" "0 active cli-rest-python-api:DATABASE_URL" \
  "$(code) $(out | jq -r '"\(.status) \(.secretsSet[0].function):\(.secretsSet[0].secret)"')"
ff invoke cli-rest-python-api --http POST /items --data '{"name": "Harissa, 2 jars"}'
id="$(out | tail -1 | jq -r .id)"
check "  ... ff invoke --http POST /items keeps an item there, over TLS, the table made at the first call" "0 HTTP 201 Harissa, 2 jars $id|Harissa, 2 jars" \
  "$(code) $(out | head -1) $(out | tail -1 | jq -r .name) $(data_db_psql "$db_conn" 'select id, name from items')"
items="$("$ff_bin" url show cli-rest-python-api --output json | jq -r .url.functionUrl)items"
check "  ... its URL, as its README reads it from ff url show, lists it, and gives it at its address" "true 200 1 200 Harissa, 2 jars" \
  "$([ "$items" = "${url}items" ] && echo true || echo false) $(at "$items" | sed 's/ .*//') $(jq length "$work/at.body") \
$(at "$items/$id" | sed 's/ .*//') $(jq -r .name "$work/at.body")"
check "  ... deletes it, then has none; a path without a route is 404, a method its route lacks 405 with Allow" \
  "204 404 No item $id 404 405 GET, DELETE" \
  "$(at "$items/$id" -X DELETE | sed 's/ .*//') $(at "$items/$id" | sed 's/ .*//') $(jq -r .message "$work/at.body") \
$(at "${url}orders" | sed 's/ .*//') $(at "$items/$id" -X PUT | sed 's/ .*//') $(sed -n 's/^allow: //Ip' "$work/at.head" | tr -d '\r')"
check "  ... its URL's CORS, as the template says, lets in its one origin and no other" "http://localhost:5173 none" \
  "$(preflight "$items" http://localhost:5173) $(preflight "$items" https://elsewhere.example)"
in_folder "$api" delete-stack --yes
deleted="$(code) $(out | paste -sd' ')"
ff db delete cli-rest --yes
check "ff delete-stack deletes its function with its URL, ff db delete its database" \
  "0 deleted the function cli-rest-python-api (Api) deleted the stack cli-rest-python 0 deleted the database cli-rest, with its data" \
  "$deleted $(code) $(out)"

# Here, each runtime as its README says: its commands before ff local start, as written, install its library and run
# its tests; then ff local start --with postgres, called with its curl.
for runtime in python nodejs; do
  api="$work/cli-rest-$runtime"
  check "cli-rest-$runtime's README: its commands install its library and run its 7 tests, which pass" "0 7" "$(readme_here "$api")"
  port="$(free_port)"
  base="http://cli-rest-$runtime-api.fn.localhost:$port"
  local_started "$work/rest.out" "$work/rest.err" "$api/template.yaml" --port "$port" --with postgres
  check "  ... ff local start --with postgres runs it at the address its README names, a PostgreSQL beside it" "true true" \
    "$(grep -E "^  cli-rest-$runtime-api +$runtime +256 MB, 10 s  $base/$" "$work/rest.out" >/dev/null && echo true || echo false) \
$(grep -E '^  postgres  postgresql://' "$work/rest.out" >/dev/null && echo true || echo false)"
  id="$(at "$base/items" -d '{"name": "Harissa, 2 jars"}' >"$work/rest-post"; jq -r .id "$work/at.body")"
  check "  ... its README's curl keeps an item: 201, its address in Location, kept in that PostgreSQL" \
    "201 /items/$id Harissa, 2 jars $id|Harissa, 2 jars" \
    "$(sed 's/ .*//' "$work/rest-post") $(sed -n 's/^location: //Ip' "$work/at.head" | tr -d '\r') $(jq -r .name "$work/at.body") \
$(local_psql "$work/rest.out" 'select id, name from items')"
  check "  ... lists it, gives it at its address, deletes it, then has none, and answers 405 with Allow" \
    "200 Harissa, 2 jars 200 Harissa, 2 jars 204 404 405 GET, DELETE" \
    "$(at "$base/items" | sed 's/ .*//') $(jq -r '.[0].name' "$work/at.body") $(at "$base/items/$id" | sed 's/ .*//') $(jq -r .name "$work/at.body") \
$(at "$base/items/$id" -X DELETE | sed 's/ .*//') $(at "$base/items/$id" | sed 's/ .*//') \
$(at "$base/items/$id" -X PUT | sed 's/ .*//') $(sed -n 's/^allow: //Ip' "$work/at.head" | tr -d '\r')"
  check "  ... its URL's CORS lets in its one origin and no other, as on FF" "http://localhost:5173 none" \
    "$(preflight "$base/items" http://localhost:5173) $(preflight "$base/items" https://elsewhere.example)"
  local_stopped
  ff local reset "$api" --data --yes
  check "  ... Ctrl-C leaving no container, ff local reset --data its database's volume gone" "0 0 0" \
    "$(code) $(leftover) $(docker volume ls --quiet --filter "label=ff.local.project=$(cd "$api" && pwd -P)" | wc -l | tr -d ' ')"
  check "  ... and its .gitignore leaves out what its README's commands installed and ff local kept: git sees ff init's files alone" \
    "${written[$runtime]}" "$(git_sees "$api")"
done
}
section_def template_rest_api section_template_rest_api backend budget=90

section_template_cron_job() {
section "ff init --template cron-job: a job on a schedule, its bucket and a queue of its failed runs; the Python one deployed on FF, a file uploaded with the AWS CLI and reported, its schedule, a failed run's record in its queue; then each runtime's run here as its README says, its schedule run by hand, a failed run tried three times then recorded in the local queue"
local runtime job bucket today yesterday size port starter failed_id deleted
declare -A written=(
  [nodejs]=".gitignore README.md events/scheduled.json samconfig.toml src/app.mjs src/package-lock.json src/package.json template.yaml tests/app.test.mjs"
  [python]=".gitignore README.md events/scheduled.json samconfig.toml src/app.py src/requirements.txt template.yaml tests/__init__.py tests/test_app.py"
)
for runtime in python nodejs; do
  (cd "$work" && rm -rf "cli-cron-$runtime" && "$ff_bin" init "cli-cron-$runtime" --runtime "$runtime" --template cron-job >"$work/out" 2>"$work/err")
  check "ff init --template cron-job makes cli-cron-$runtime's template, code, tests, event and README, and nothing else" "${written[$runtime]}" \
    "$(template_files "$work/cli-cron-$runtime")"
done
today="$(date -u +%F)"
yesterday="$(date -u -d yesterday +%F)"

# On FF, from the folder as ff init wrote it: ff deploy installs boto3, which FF's Python runtime hasn't.
job="$work/cli-cron-python"
in_folder "$job" deploy template.yaml --output json
bucket="$(out | jq -r '.outputs[] | select(.name == "FilesBucket") | .value')"
check "the Python one deployed as the stack samconfig.toml names: its function, its bucket named from the stack's, its queue" \
  "0 cli-cron-python created cli-cron-python-report true cli-cron-python-failed-runs" \
  "$(code) $(out | jq -r '"\(.stack) \(.functions[0].action) \(.functions[0].name)"') \
$([[ $bucket =~ ^cli-cron-python-files-[a-z0-9]{12}$ ]] && echo true || echo false) \
$(out | jq -r '.outputs[] | select(.name == "FailedRunsQueue") | .value | split("/") | last')"
# As its README says: a key to the bucket alone, its variables for the AWS CLI, none of this machine's settings.
ff keys create --name cli-cron-files --bucket "$bucket"
out | grep '^export ' >"$work/cron.env"
cron_aws() { (eval "$(cat "$work/cron.env")"; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
size="$(wc -c <"$job/README.md" | tr -d ' ')"
uploaded="$(cron_aws s3 cp "$job/README.md" "s3://$bucket/incoming/README.md" --only-show-errors >/dev/null 2>&1; echo $?)"
ff invoke cli-cron-python-report --data "{\"day\": \"$today\"}"
check "  ... a file uploaded to its bucket by the AWS CLI with that key; ff invoke naming today reports it" \
  "0 0 $today 1 $size incoming/README.md" \
  "$uploaded $(code) $(out | sed '$d' | jq -r '"\(.day) \(.files) \(.bytes) \(.largest.key)"')"
check "  ... in the bucket, beside the files, as reports/<day>.json" "$today 1 $size" \
  "$(cron_aws s3 cp "s3://$bucket/reports/$today.json" - 2>/dev/null | jq -r '"\(.day) \(.files) \(.bytes)"')"
ff schedule list cli-cron-python-report --output json
check "  ... its schedule, the template's Schedule event: 06:00 UTC each day, running" "0 EveryMorning cron(0 6 * * ? *) true" \
  "$(code) $(out | jq -r '.[] | "\(.name) \(.expression) \(.enabled)"')"
ff async-config cli-cron-python-report
check "  ... a run that fails tried twice more, then sent to its queue, as its EventInvokeConfig says" \
  "0 cli-cron-python-report: a call that fails is retried twice, and kept 6 hours at most; one that fails for good to the queue cli-cron-python-failed-runs" \
  "$(code) $(out)"
# FF tries a run again a minute after it failed, then two minutes after: with no retry, its record comes at once.
ff async-config cli-cron-python-report --retries 0
ff invoke cli-cron-python-report --async --data '{"time": "yesterday"}' --raw
failed_id="$(out)"
ff queues receive cli-cron-python-failed-runs --wait 20s --output json
check "  ... a run that failed for good: its record in that queue, as Lambda writes it, its event under requestPayload" \
  "0 RetriesExhausted $failed_id yesterday The event's time is no date: \"yesterday\"" \
  "$(code) $(out | jq -r '.[0].body | fromjson | "\(.requestContext.condition) \(.requestContext.requestId) \(.requestPayload.time) \(.responsePayload.errorMessage)"')"
in_folder "$job" delete-stack --yes
check "ff delete-stack stops at the bucket while it holds files, as CloudFormation does, saying what deletes it" "3 true" \
  "$(code) $(err | grep -F "The bucket $bucket (Files) isn't empty" | grep -F "ff buckets delete $bucket --force" >/dev/null && echo true || echo false)"
ff buckets delete "$bucket" --force --yes
deleted="$(code)"
in_folder "$job" delete-stack --yes
check "  ... ff buckets delete --force deletes it with its files, then ff delete-stack the rest" \
  "0 0 deleted the function cli-cron-python-report (Report) deleted the bucket $bucket (Files) deleted the queue cli-cron-python-failed-runs (FailedRuns) deleted the stack cli-cron-python" \
  "$deleted $(code) $(out | paste -sd' ')"
ff keys revoke cli-cron-files --yes

# Here, each runtime as its README says: its commands before ff local start, then the start, then the commands for
# another terminal, at the suite's port. A failed run's retries come in 1.2 s and 2.4 s, a second of the test build's
# asynchronous calls 20 ms.
for runtime in python nodejs; do
  job="$work/cli-cron-$runtime"
  check "cli-cron-$runtime's README: its commands install its library and run its 6 tests, which pass" "0 6" "$(readme_here "$job")"
  port="$(free_port)"
  FF_TEST_ASYNC_SECOND_MS=20 local_started "$work/cron.out" "$work/cron.err" "$job/template.yaml" --port "$port"
  check "  ... ff local start runs the job, its schedule, its queue and its bucket, its files kept in .ff/local/buckets/files" \
    "true true true true" \
    "$(grep -E "^  cli-cron-$runtime-report  $runtime  256 MB, 60 s$" "$work/cron.out" >/dev/null && echo true || echo false) \
$(grep -E "^  cli-cron-$runtime-report/EveryMorning  cron\(0 6 \* \* \? \*\)  next [0-9-]{10}T06:00:00Z$" "$work/cron.out" >/dev/null && echo true || echo false) \
$(grep -E "^  cli-cron-$runtime-failed-runs  http://127\.0\.0\.1:$port/000000000000/cli-cron-$runtime-failed-runs$" "$work/cron.out" >/dev/null && echo true || echo false) \
$(grep -E "^  files  $job/\.ff/local/buckets/files$" "$work/cron.out" >/dev/null && echo true || echo false)"
  check "  ... its README's commands for another terminal: a file put in the bucket by curl, today's report made by Lambda's Invoke" \
    "0 200 $today 1 $(wc -c <"$job/README.md" | tr -d ' ') incoming/README.md" \
    "$(readme_after "$job" '^In another terminal' "s/:3700/:$port/g") $(at "http://127.0.0.1:$port/files/reports/$today.json" | sed -n '1s/ .*//p') \
$(jq -r '"\(.day) \(.files) \(.bytes) \(.largest.key)"' "$work/at.body")"
  until_found "http://127.0.0.1:$port/files/reports/$yesterday.json" || true
  check "  ... and ff local run EveryMorning, the schedule's run now, yesterday's report, with none of today's files" \
    "200 $yesterday 0 null true" \
    "$(at "http://127.0.0.1:$port/files/reports/$yesterday.json" | sed -n '1s/ .*//p') $(jq -r '"\(.day) \(.files) \(.largest)"' "$work/at.body") \
$(grep -F "cli-cron-$runtime-report | " "$work/cron.err" | grep -F "reported $yesterday: 0 files, 0 bytes" >/dev/null && echo true || echo false)"
  curl -s -o /dev/null -X POST -H 'X-Amz-Invocation-Type: Event' \
    "http://127.0.0.1:$port/2015-03-31/functions/cli-cron-$runtime-report/invocations" -d '{"time": "yesterday"}'
  local_aws "$job" "$port" sqs receive-message --wait-time-seconds 20 --output json \
    --queue-url "http://127.0.0.1:$port/000000000000/cli-cron-$runtime-failed-runs" >"$work/cron-record.json" 2>&1 || true
  check "  ... a run that fails, tried three times as on FF, then its record in the local queue, read by the AWS CLI with the local key" \
    "RetriesExhausted 3 yesterday The event's time is no date: \"yesterday\"" \
    "$(jq -r '.Messages[0].Body | fromjson | "\(.requestContext.condition) \(.requestContext.approximateInvokeCount) \(.requestPayload.time) \(.responsePayload.errorMessage)"' "$work/cron-record.json" 2>&1)"
  local_stopped
  check "  ... Ctrl-C leaving no container, the bucket's three files kept for the next start" "0 3" \
    "$(leftover) $(find "$job/.ff/local/buckets/files" -name '*.object.json' | wc -l | tr -d ' ')"
  ff local reset "$job" --yes
  check "  ... ff local reset removing them, and its .gitignore leaves out what its README's commands installed: git sees ff init's files alone" \
    "0 false ${written[$runtime]}" "$(code) $([ -e "$job/.ff/local" ] && echo true || echo false) $(git_sees "$job")"
done
}
section_def template_cron_job section_template_cron_job backend budget=70

section_template_queue_worker() {
section "ff init --template queue-worker: a URL that takes jobs into a queue, a worker reading it in batches, a dead-letter queue; the Node.js one deployed on FF, a job done and one of a task it hasn't failed three times then dead-lettered; then each runtime's run here as its README says, the same"
local runtime app url failing_on_ff good bad port base starter jobs
declare -A written=(
  [nodejs]=".gitignore README.md events/batch.json events/post-job.json samconfig.toml src/api.mjs src/package-lock.json src/package.json src/worker.mjs template.yaml tests/api.test.mjs tests/worker.test.mjs"
  [python]=".gitignore README.md events/batch.json events/post-job.json samconfig.toml src/api.py src/requirements.txt src/worker.py template.yaml tests/__init__.py tests/test_api.py tests/test_worker.py"
)
# json_lines: the JSON objects of log lines, whatever comes before each, as each runtime writes a line differently.
json_lines() { sed -n 's/^[^{]*\({.*}\)$/\1/p'; }
for runtime in python nodejs; do
  (cd "$work" && rm -rf "cli-jobs-$runtime" && "$ff_bin" init "cli-jobs-$runtime" --runtime "$runtime" --template queue-worker >"$work/out" 2>"$work/err")
  check "ff init --template queue-worker makes cli-jobs-$runtime's template, code, tests, events and README, and nothing else" \
    "${written[$runtime]}" "$(template_files "$work/cli-jobs-$runtime")"
done

# On FF, the Node.js one: ff deploy installs AWS's SDK's SQS client. A job the worker failed comes back after 10 s, not
# 60, so that its third failure comes within the section, whose part here runs meanwhile.
app="$work/cli-jobs-nodejs"
in_folder "$app" deploy template.yaml --parameter-overrides JobsVisibilityTimeout=10 --output json
url="$(out | jq -r '.outputs[] | select(.name == "ApiUrl") | .value')"
check "the Node.js one deployed as the stack samconfig.toml names: the API and its URL, the worker, the two queues" \
  "0 cli-jobs-nodejs cli-jobs-nodejs-api cli-jobs-nodejs-worker true cli-jobs-nodejs-jobs cli-jobs-nodejs-jobs-dead-letters" \
  "$(code) $(out | jq -r '"\(.stack) \([.functions[].name] | sort | join(" "))"') $([[ $url == http*/ ]] && echo true || echo false) \
$(out | jq -r '[.outputs[] | select(.name == "JobsQueue" or .name == "DeadLettersQueue") | .value | split("/") | last] | sort | join(" ")')"
ff invoke cli-jobs-nodejs-api --http POST /jobs --data '{"task": "resize"}'
failing_on_ff="$(out | tail -1 | jq -r .id)"
check "  ... ff invoke --http POST /jobs, a job of a task the worker hasn't: 202, its ID" "0 HTTP 202 resize true" \
  "$(code) $(out | head -1) $(out | tail -1 | jq -r .task) $([[ $failing_on_ff =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false)"
ff invoke cli-jobs-nodejs-api --http POST /jobs --data '{"task": "greet", "name": "Amira"}'
good="$(out | tail -1 | jq -r .id)"
jobs=""
for _ in $(seq 1 30); do
  ff logs cli-jobs-nodejs-worker
  jobs="$(out | json_lines | jq -r --arg job "$good" 'select(.job == $job) | "\(.task) \(.done)"' 2>/dev/null)"
  [ -n "$jobs" ] && break
  sleep 1
done
check "  ... and a greeting's, done by the worker from the queue, its line in ff logs" "greet Hello Amira" "$jobs"
check "  ... the API's refusals at its URL: a job without a task 400, another path 404, another method 405 with Allow" \
  "400 A job names its task, {\"task\": \"…\"}, 1 to 100 characters 404 405 POST" \
  "$(at "${url}jobs" -d '{"name": "Amira"}' | sed 's/ .*//') $(jq -r .message "$work/at.body") $(at "${url}orders" | sed 's/ .*//') \
$(at "${url}jobs" | sed 's/ .*//') $(sed -n 's/^allow: //Ip' "$work/at.head" | tr -d '\r')"
ff event-sources list --function cli-jobs-nodejs-worker --output json
check "  ... the worker reads the jobs' queue in batches of 10, naming the jobs it failed" "0 cli-jobs-nodejs-jobs 10 Enabled ReportBatchItemFailures" \
  "$(code) $(out | jq -r '.[] | "\(.eventSourceArn | split(":") | last) \(.batchSize) \(.state) \(.functionResponseTypes | join(","))"')"

# Here, each runtime as its README says, the same 10 s.
for runtime in python nodejs; do
  app="$work/cli-jobs-$runtime"
  check "cli-jobs-$runtime's README: its commands install its library and run its 9 tests, which pass" "0 9" "$(readme_here "$app")"
  port="$(free_port)"
  base="http://cli-jobs-$runtime-api.fn.localhost:$port"
  local_started "$work/jobs.out" "$work/jobs.err" "$app/template.yaml" --port "$port" --parameter-overrides JobsVisibilityTimeout=10
  check "  ... ff local start runs the API at the address its README names, the worker reading the jobs' queue, the two queues" \
    "true true true" \
    "$(grep -E "^  cli-jobs-$runtime-api +$runtime  256 MB, 10 s  $base/$" "$work/jobs.out" >/dev/null && echo true || echo false) \
$(grep -E "^  cli-jobs-$runtime-worker/Jobs  cli-jobs-$runtime-jobs: batches of 10, ReportBatchItemFailures$" "$work/jobs.out" >/dev/null && echo true || echo false) \
$(grep -E "^  cli-jobs-$runtime-jobs +http://127\.0\.0\.1:$port/000000000000/cli-jobs-$runtime-jobs, to cli-jobs-$runtime-jobs-dead-letters after 3 receives$" "$work/jobs.out" >/dev/null && echo true || echo false)"
  check "  ... its README's two curls: each job taken, 202 with its ID" "0 greet resize" \
    "$(readme_after "$app" '^ff local start' "s/:3700/:$port/g") $(jq -r .task "$work/after.out" | paste -sd' ')"
  good="$(jq -r 'select(.task == "greet") | .id' "$work/after.out")"
  bad="$(jq -r 'select(.task == "resize") | .id' "$work/after.out")"
  # The job the worker fails is received a fourth time 30 s after it came, and goes to the dead-letter queue then.
  for _ in 1 2 3; do
    local_aws "$app" "$port" sqs receive-message --wait-time-seconds 20 --output json \
      --queue-url "http://127.0.0.1:$port/000000000000/cli-jobs-$runtime-jobs-dead-letters" >"$work/jobs-dead.json" 2>&1 || true
    jq -e '.Messages | length > 0' "$work/jobs-dead.json" >/dev/null 2>&1 && break
  done
  grep -F "cli-jobs-$runtime-worker | " "$work/jobs.err" | json_lines >"$work/worker.lines"
  check "  ... the greeting's job done by the worker, its line on ff local start's stderr as its README shows it" "greet Hello Amira" \
    "$(jq -r --arg job "$good" 'select(.job == $job) | "\(.task) \(.done)"' "$work/worker.lines")"
  check "  ... the other failed at each of its three tries, then in the dead-letter queue, read by the AWS CLI with the local key" \
    "1,2,3 No task \"resize\" $bad resize" \
    "$(jq -r --arg job "$bad" 'select(.job == $job) | .tries' "$work/worker.lines" | paste -sd,) \
$(jq -r --arg job "$bad" 'select(.job == $job) | .failed' "$work/worker.lines" | sort -u) \
$(jq -r '.Messages[0] | "\(.MessageId) \(.Body | fromjson | .task)"' "$work/jobs-dead.json" 2>&1)"
  local_stopped
  ff local reset "$app" --yes
  check "  ... Ctrl-C leaving no container, ff local reset what ff local kept, and git sees ff init's files alone" \
    "0 0 ${written[$runtime]}" "$(leftover) $(code) $(git_sees "$app")"
done

# On FF meanwhile, the job the worker failed: received three times, 10 s apart, then in the dead-letter queue.
ff queues receive cli-jobs-nodejs-jobs-dead-letters --wait 20s --output json
check "the job the worker failed on FF: in the dead-letter queue after its three tries, as its redrive policy says" \
  "0 resize" "$(code) $(out | jq -r '.[0].body | fromjson | .task')"
ff logs cli-jobs-nodejs-worker
check "  ... its three tries' lines in ff logs, each failed" "1,2,3 No task \"resize\"" \
  "$(out | json_lines | jq -r --arg job "$failing_on_ff" 'select(.job == $job) | .tries' | paste -sd,) \
$(out | json_lines | jq -r --arg job "$failing_on_ff" 'select(.job == $job) | .failed' | sort -u)"
in_folder "$work/cli-jobs-nodejs" delete-stack --yes
check "ff delete-stack deletes both functions, with the URL and the worker's reading of the queue, and the two queues" \
  "0 deleted the function cli-jobs-nodejs-api (Api) deleted the function cli-jobs-nodejs-worker (Worker) deleted the queue cli-jobs-nodejs-jobs-dead-letters (DeadLetters) deleted the queue cli-jobs-nodejs-jobs (Jobs) deleted the stack cli-jobs-nodejs" \
  "$(code) $(out | paste -sd' ')"
}
section_def template_queue_worker section_template_queue_worker backend budget=180

section_template_site_with_api() {
section "ff init --template site-with-api: a page on a bucket's site and its API at a function's URL, a guestbook kept in a second bucket; the Node.js one deployed on FF, its page by ff sites deploy, as its README says, and signed from its site's origin; then each runtime's run here as its README says, its page served from its folder by ff local start --site"
local runtime app url bucket entries site deployed page base port starter id
declare -A written=(
  [nodejs]=".gitignore README.md events/list-entries.json events/post-entry.json samconfig.toml site/app.js site/index.html site/style.css src/app.mjs src/package-lock.json src/package.json template.yaml tests/app.test.mjs"
  [python]=".gitignore README.md events/list-entries.json events/post-entry.json samconfig.toml site/app.js site/index.html site/style.css src/app.py src/requirements.txt template.yaml tests/__init__.py tests/test_app.py"
)
for runtime in python nodejs; do
  (cd "$work" && rm -rf "cli-guests-$runtime" && "$ff_bin" init "cli-guests-$runtime" --runtime "$runtime" --template site-with-api >"$work/out" 2>"$work/err")
  check "ff init --template site-with-api makes cli-guests-$runtime's template, code, tests, events, page and README, and nothing else" "${written[$runtime]}" \
    "$(template_files "$work/cli-guests-$runtime")"
done

# On FF, from the folder as ff init wrote it: ff deploy installs AWS's SDK, then the README's lines after it write the
# page's config.json and deploy the page, its bucket the deploy's output.
app="$work/cli-guests-nodejs"
in_folder "$app" deploy template.yaml --output json
url="$(out | jq -r '.outputs[] | select(.name == "ApiUrl") | .value')"
bucket="$(out | jq -r '.outputs[] | select(.name == "WebsiteBucket") | .value')"
entries="$(out | jq -r '.outputs[] | select(.name == "EntriesBucket") | .value')"
site="$(out | jq -r '.outputs[] | select(.name == "WebsiteUrl") | .value')"
check "the Node.js one deployed as the stack samconfig.toml names: its function at its URL, its two buckets named from the stack's, the page's address its bucket's site" \
  "0 cli-guests-nodejs created cli-guests-nodejs-api true true true $(site_of "$bucket")" \
  "$(code) $(out | jq -r '"\(.stack) \(.functions[0].action) \(.functions[0].name)"') \
$(out | jq -r --arg url "$url" '.functions[0].url == $url and ($url | startswith("http"))') \
$([[ $bucket =~ ^cli-guests-nodejs-website-[a-z0-9]{12}$ ]] && echo true || echo false) \
$([[ $entries =~ ^cli-guests-nodejs-entries-[a-z0-9]{12}$ ]] && echo true || echo false) $site"
check "  ... its README's lines after ff deploy: config.json naming the API's URL, from ff url show, and the page's four files deployed to its bucket" \
  "0 {\"api\": \"$url\"} site deployed to $bucket: 4 files uploaded, 0 files unchanged, 0 files deleted $site" \
  "$(readme_after "$app" '^ff deploy template.yaml' "s/<WebsiteBucket>/$bucket/g") $(cat "$app/site/config.json") \
$(paste -sd' ' "$work/after.out")"
check "  ... the page answers at its site's address, and its config.json there names the API" \
  "200 true 200 $url" \
  "$(at "$site/" | sed -n '1s/ .*//p') $(grep -F "<h1>cli-guests-nodejs's guestbook</h1>" "$work/at.body" >/dev/null && echo true || echo false) \
$(at "$site/config.json" | sed -n '1s/ .*//p') $(jq -r .api "$work/at.body")"
page="$(site_of "$bucket")"
check "  ... the API's CORS lets the page's origin in, as any, without credentials" "* *" \
  "$(preflight "${url}entries" "$page") $(curl -s -o /dev/null -D - "${url}entries" -H "Origin: $page" | tr -d '\r' | sed -n 's/^access-control-allow-origin: //Ip')"
id="$(at "${url}entries" -H "Origin: $page" -H 'content-type: application/json' -d '{"name": " Amira ", "message": "Ahlan from Sousse!"}' >"$work/guests-post"; jq -r .id "$work/at.body")"
check "  ... a POST from the page keeps an entry, trimmed, in the entries' bucket; GET lists it" \
  "201 Amira 200 1 $id Ahlan from Sousse!" \
  "$(sed -n '1s/ .*//p' "$work/guests-post") $(jq -r .name "$work/at.body") $(at "${url}entries" | sed -n '1s/ .*//p') \
$(jq -r '"\(length) \(.[0].id) \(.[0].message)"' "$work/at.body")"
check "  ... an entry without a message is refused with 400, another path is 404, another method 405 with Allow" \
  "400 An entry has a message, 1 to 500 characters 404 405 GET, POST" \
  "$(at "${url}entries" -d '{"name": "Amira"}' | sed -n '1s/ .*//p') $(jq -r .message "$work/at.body") \
$(at "${url}items" | sed -n '1s/ .*//p') $(at "${url}entries" -X DELETE | sed -n '1s/ .*//p') $(sed -n 's/^allow: //Ip' "$work/at.head" | tr -d '\r')"
in_folder "$app" delete-stack --yes
check "ff delete-stack stops at the buckets that hold files, as its README says" "3 true" \
  "$(code) $(err | grep -F "ff buckets delete" >/dev/null && echo true || echo false)"
ff buckets delete "$bucket" --force --yes
ff buckets delete "$entries" --force --yes
in_folder "$app" delete-stack --yes
check "  ... ff buckets delete --force deletes each with its files, then ff delete-stack the rest" \
  "0 deleted the function cli-guests-nodejs-api (Api) deleted the bucket $entries (Entries) deleted the bucket $bucket (Website) deleted the stack cli-guests-nodejs" \
  "$(code) $(out | paste -sd' ')"

# Here, each runtime as its README says: its commands before ff local start install its library, run its tests and
# write config.json; ff local start --site serves the page from its folder; the README's curl signs the guestbook.
for runtime in python nodejs; do
  app="$work/cli-guests-$runtime"
  check "cli-guests-$runtime's README: its commands install its library, run its 6 tests, which pass, and write config.json naming the API here" \
    "0 6 {\"api\": \"http://cli-guests-$runtime-api.fn.localhost:3700\"}" "$(readme_here "$app") $(cat "$app/site/config.json")"
  port="$(free_port)"
  sed -i "s/:3700/:$port/" "$app/site/config.json"
  base="http://cli-guests-$runtime-api.fn.localhost:$port"
  page="http://website.site.localhost:$port"
  local_started "$work/guests.out" "$work/guests.err" "$app/template.yaml" --port "$port" --site "Website=$app/site"
  check "  ... ff local start --site runs its API at the address its README names, its page from site/, its entries kept in .ff/local" \
    "true true true" \
    "$(grep -E "^  cli-guests-$runtime-api +$runtime +256 MB, 10 s  $base/$" "$work/guests.out" >/dev/null && echo true || echo false) \
$(grep -F "  website  $page/, $(cd "$app/site" && pwd -P)'s files" "$work/guests.out" >/dev/null && echo true || echo false) \
$(grep -E "^  entries  $app/\.ff/local/buckets/entries$" "$work/guests.out" >/dev/null && echo true || echo false)"
  check "  ... the page answers at the address its README names, config.json with it, and the API lets its origin in" \
    "200 true 200 $base *" \
    "$(at "$page/" | sed -n '1s/ .*//p') $(grep -F "<h1>cli-guests-$runtime's guestbook</h1>" "$work/at.body" >/dev/null && echo true || echo false) \
$(at "$page/config.json" | sed -n '1s/ .*//p') $(jq -r .api "$work/at.body") $(preflight "$base/entries" "$page")"
  check "  ... its README's curl signs the guestbook and lists the entry, kept in the entries' bucket" \
    "0 Amira 1 Ahlan from Sousse! 1" \
    "$(readme_after "$app" '^ff local start' "s/:3700/:$port/g") $(jq -rs '"\(.[0].name) \(.[1] | length) \(.[1][0].message)"' "$work/after.out") \
$(find "$app/.ff/local/buckets/entries" -name '*.object.json' | wc -l | tr -d ' ')"
  local_stopped
  ff local reset "$app" --yes
  check "  ... Ctrl-C leaving no container, ff local reset removing the entries, and its .gitignore leaves out config.json and what its README's commands installed: git sees ff init's files alone" \
    "0 0 false ${written[$runtime]}" "$(leftover) $(code) $([ -e "$app/.ff/local" ] && echo true || echo false) $(git_sees "$app")"
done
}
section_def template_site_with_api section_template_site_with_api backend budget=50

section_template_image_resize() {
section "ff init --template image-resize: an image put in a bucket under uploads/ makes its thumbnail under thumbnails/, sharp's or Pillow's native code built for Linux; both runtimes deployed on FF with --container as its README says, an image uploaded by the AWS CLI and its thumbnail waited for; then each runtime's run here as its README says, an image too small to shrink kept its size, a file that is no image left"
local runtime app bucket port starter made _
declare -A written=(
  [nodejs]=".gitignore README.md events/upload.json samconfig.toml src/app.mjs src/package-lock.json src/package.json template.yaml tests/app.test.mjs"
  [python]=".gitignore README.md events/upload.json samconfig.toml src/app.py src/requirements.txt template.yaml tests/__init__.py tests/test_app.py"
)
# png_of <width> <height> <file>: a PNG of a gradient, written by Python alone, as this machine may have no image tool.
png_of() {
  python3 -I -c 'import struct, sys, zlib
width, height = int(sys.argv[1]), int(sys.argv[2])
rows = b"".join(b"\0" + b"".join(bytes((x * 255 // width, y * 255 // height, 160)) for x in range(width)) for y in range(height))
chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
open(sys.argv[3], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
  + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))' "$@"
}
# pixels <file>: an image's width x height, as file reads it; webp <file>: WebP when file reads one, which its older
# versions call Web/P.
pixels() { file -b "$1" | grep -oE '[0-9]+ ?x ?[0-9]+' | head -1 | tr -d ' '; }
webp() { file -b "$1" | grep -oE 'Web/?P image' | sed 's|/||; s| image||'; }
for runtime in python nodejs; do
  (cd "$work" && rm -rf "cli-photos-$runtime" && "$ff_bin" init "cli-photos-$runtime" --runtime "$runtime" --template image-resize >"$work/out" 2>"$work/err")
  check "ff init --template image-resize makes cli-photos-$runtime's template, code, tests, event and README, and nothing else" "${written[$runtime]}" \
    "$(template_files "$work/cli-photos-$runtime")"
done
png_of 640 480 "$work/photo.png"
png_of 120 90 "$work/small.png"
check "the suite's images: a photo, 640x480, and one smaller than a thumbnail, 120x90" "640x480 120x90" \
  "$(pixels "$work/photo.png") $(pixels "$work/small.png")"

# On FF, each runtime from its folder as ff init wrote it, as the README says: --container installs sharp, or Pillow,
# in the runtime's build image, Linux's native code. One stack at a time, as the dev cluster has room for one
# function of this size beside the suite's own.
for runtime in nodejs python; do
  app="$work/cli-photos-$runtime"
  in_folder "$app" deploy template.yaml --container --output json
  bucket="$(out | jq -r '.outputs[] | select(.name == "ImagesBucket") | .value')"
  check "the $runtime one deployed with --container as the stack samconfig.toml names: its function, its bucket named after the stack and the account" \
    "0 cli-photos-$runtime created cli-photos-$runtime-resize true" \
    "$(code) $(out | jq -r '"\(.stack) \(.functions[0].action) \(.functions[0].name)"') \
$([[ $bucket =~ ^cli-photos-$runtime-images-[0-9]{12}$ ]] && echo true || echo false)"
  # As its README says: a key to the bucket alone, its variables for the AWS CLI, none of this machine's settings.
  ff keys create --name "cli-photos-$runtime" --bucket "$bucket"
  out | grep '^export ' >"$work/photos.env"
  photos_aws() { (eval "$(cat "$work/photos.env")"; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
  rm -f "$work/photo.webp"
  check "  ... an image uploaded under uploads/ by the AWS CLI with that key: its thumbnail waited for as the README says, 200x150, a WebP" \
    "0 0 0 200x150 WebP" \
    "$(photos_aws s3 cp "$work/photo.png" "s3://$bucket/uploads/photo.png" --only-show-errors >/dev/null 2>&1; echo $?) \
$(photos_aws s3api wait object-exists --bucket "$bucket" --key thumbnails/photo.webp >/dev/null 2>&1; echo $?) \
$(photos_aws s3 cp "s3://$bucket/thumbnails/photo.webp" "$work/photo.webp" --only-show-errors >/dev/null 2>&1; echo $?) \
$(pixels "$work/photo.webp") $(webp "$work/photo.webp")"
  for _ in $(seq 1 20); do
    ff logs "cli-photos-$runtime-resize"
    out | grep -E '"made": ?"thumbnails/photo.webp", ?"from": ?"uploads/photo.png"' >/dev/null && break
    sleep 1
  done
  check "  ... and its log says so, in ff logs" "0 true" \
    "$(code) $(out | grep -E '"made": ?"thumbnails/photo.webp", ?"from": ?"uploads/photo.png"' >/dev/null && echo true || echo false)"
  ff buckets delete "$bucket" --force --yes
  in_folder "$app" delete-stack --yes
  made="$(code) $(out | paste -sd' ')"
  ff keys revoke "cli-photos-$runtime" --yes
  check "  ... ff buckets delete --force and ff delete-stack delete it, the key revoked" \
    "0 deleted the function cli-photos-$runtime-resize (Resize) deleted the bucket $bucket (Images) deleted the stack cli-photos-$runtime 0" \
    "$made $(code)"
done

# Here, each runtime as its README says: its commands before ff local start install its libraries, Linux's builds,
# and run its tests; ff local start; its curls, the image put and its thumbnail waited for.
for runtime in python nodejs; do
  app="$work/cli-photos-$runtime"
  bucket="cli-photos-$runtime-images-000000000000"
  check "cli-photos-$runtime's README: its commands install its libraries and run its 6 tests, which pass" "0 6" "$(readme_here "$app")"
  port="$(free_port)"
  local_started "$work/photos.out" "$work/photos.err" "$app/template.yaml" --port "$port"
  check "  ... ff local start runs the function and its bucket, named as the README says, its files kept in .ff/local, its events to the function" \
    "true true" \
    "$(grep -E "^  cli-photos-$runtime-resize  $runtime  512 MB, 30 s$" "$work/photos.out" >/dev/null && echo true || echo false) \
$(grep -E "^  $bucket  $app/\.ff/local/buckets/$bucket, its events to cli-photos-$runtime-resize$" "$work/photos.out" >/dev/null && echo true || echo false)"
  cp "$work/photo.png" "$app/photo.png"
  check "  ... its README's curls: the image put under uploads/, its thumbnail waited for, 200x150, a WebP" "0 200x150 WebP" \
    "$(readme_after "$app" '^ff local start' "s/:3700/:$port/g; s/photo\.jpg/photo.png/g") $(pixels "$app/photo.webp") $(webp "$app/photo.webp")"
  curl -s -o /dev/null -T "$work/small.png" "http://127.0.0.1:$port/$bucket/uploads/small.png"
  printf 'no image\n' >"$work/notes.txt"
  curl -s -o /dev/null -T "$work/notes.txt" "http://127.0.0.1:$port/$bucket/uploads/notes.txt"
  until_found "http://127.0.0.1:$port/$bucket/thumbnails/small.webp" || true
  curl -s -o "$work/small.webp" "http://127.0.0.1:$port/$bucket/thumbnails/small.webp"
  for _ in $(seq 1 60); do
    grep -E '"left": ?"uploads/notes.txt"' "$work/photos.err" >/dev/null && break
    sleep 0.5
  done
  check "  ... an image smaller than a thumbnail kept its size; a file that is no image left, said in the log, nothing made of it" \
    "120x90 true 404" \
    "$(pixels "$work/small.webp") $(grep -E '"left": ?"uploads/notes.txt"' "$work/photos.err" >/dev/null && echo true || echo false) \
$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/$bucket/thumbnails/notes.webp")"
  local_stopped
  check "  ... Ctrl-C leaving no container, the bucket's five files kept for the next start" "0 5" \
    "$(leftover) $(find "$app/.ff/local/buckets/$bucket" -name '*.object.json' | wc -l | tr -d ' ')"
  rm -f "$app/photo.png" "$app/photo.webp"
  ff local reset "$app" --yes
  check "  ... ff local reset removing them, and its .gitignore leaves out what its README's commands installed: git sees ff init's files alone" \
    "0 false ${written[$runtime]}" "$(code) $([ -e "$app/.ff/local" ] && echo true || echo false) $(git_sees "$app")"
done
}
section_def template_image_resize section_template_image_resize backend budget=300

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
section_def packages section_packages init budget=135

section_schedules_ran() {
section "schedules: its runs, list, disable, remove, once their minute has passed in the sections before"
# Its first run came a minute after it was made, then the scheduler's tick within 5 s; the next a minute after it. By
# now it has run; run alone, it is waited for, as long as before.
ran=false
for _ in $(seq 1 30); do
  ff schedule list cli-sched --output json
  if [ "$(out | jq -r '.[0].lastOutcome')" = success ]; then
    ran=true
    break
  fi
  sleep 5
done
ff history cli-sched --output json
first_run_after="$(out | jq --argjson made "$sched_made_at" '[.invocations[] | select(.source == "schedule") | (.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdate) - $made] | min')"
check "within about 70 s it has run, and ff schedule list says it succeeded" "true true" \
  "$ran $([ "${first_run_after:-null}" != null ] && [ "$first_run_after" -le 75 ] && echo true || echo "false: $first_run_after s after")"
ff schedule disable cli-sched
check "ff schedule disable stops its runs" "0 cli-sched's schedule schedule disabled: it doesn't run" "$(code) $(out)"
# Disabled, its last run is the history's newest call, once that run has ended.
for _ in $(seq 1 30); do
  ff schedule list cli-sched --output json
  [ "$(out | jq -r '.[0].lastOutcome')" != running ] && break
  sleep 1
done
ff history cli-sched --output json
check "the history has the call, as a schedule's, with its input" "schedule $(out | jq -r '.invocations[0].id')" \
  "$(out | jq -r '.invocations[0].source') $(ff schedule list cli-sched --output json; out | jq -r '.[0].lastRequestId')"
ff schedule remove cli-sched
ff schedule list cli-sched
check "ff schedule remove takes it away" "0 cli-sched has no schedule: \`ff schedule set cli-sched \"rate(1 hour)\"\` makes one" "$(code) $(out)"
ff delete cli-sched --yes
}
section_def schedules_ran section_schedules_ran schedules budget=10

section_small_app_db() {
section "the small app with a database of its own on the internet: a package with a driver, a secret, a URL that writes there, a nightly schedule"
# The app's database, as one on the internet would be (hack/k8s/app-database.sh), on a network of the test's own. No
# bucket is named, so its orders go without receipts.
export FF_APP_DB_NAME="$E2E_PROJECT-app-db" FF_APP_DB_SUBNET=198.18.1.0/24 FF_APP_DB_ADDRESS=198.18.1.10
e2e_cleanups+=("$FF_REPO_ROOT/hack/k8s/app-database.sh down")
database_url="$("$FF_REPO_ROOT/hack/k8s/app-database.sh" up)"
app_db() { "$FF_REPO_ROOT/hack/k8s/app-database.sh" psql -tA "$@"; }
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
section_def small_app_db section_small_app_db backend budget=90

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
}
section_def databases section_databases small_app_db budget=55

section_buckets() {
section "buckets, with ff buckets and ff keys: one made, a named key for AWS's tools, the AWS CLI with those alone, a key to functions"
ff buckets create My.Photos
check "ff buckets create refuses a name AWS wouldn't take, before calling" "2 true" "$(code) $(err | grep "can't be a bucket's name" >/dev/null && echo true || echo false)"
ff buckets create cli-photos
check "ff buckets create makes it, and says where AWS's tools reach it" "0 cli-photos made http://cli-photos.s3.localhost:$storage_port" \
  "$(code) $(out | head -1) $(out | sed -n 3p | awk '{ print $2 }')"
ff buckets list
check "ff buckets list shows it" "0 cli-photos active" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff keys create --name cli-photos-key --bucket cli-photos
check "ff keys create prints its secret once, as the seven variables AWS's tools read" "0 7" "$(code) $(out | grep -c '^export AWS_')"
out | grep '^export AWS_' >"$work/s3.env"
key_id="$(sed -n 's/^export AWS_ACCESS_KEY_ID=//p' "$work/s3.env")"
printf 'Ahlan from the CLI' >"$work/hello.txt"
# The AWS CLI with those variables alone, none of this machine's settings: AWS_ENDPOINT_URL_S3 names FF's endpoint.
aws_with_key() { (set -a; . "$work/s3.env"; set +a; AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" "$@"); }
uploaded="$(aws_with_key s3 cp "$work/hello.txt" s3://cli-photos/hello.txt --only-show-errors >/dev/null 2>&1; echo $?)"
check "the AWS CLI uploads with them and reads it back, AWS_ENDPOINT_URL_S3 its only change" "0 Ahlan from the CLI" \
  "$uploaded $(aws_with_key s3 cp s3://cli-photos/hello.txt - 2>/dev/null)"
ff keys list
check "ff keys list names each key and what it reaches, never its secret" "0 $key_id cli-photos-key cli-photos - read-write - false" \
  "$(code) $(out | sed -n 2p | awk '{ print $1, $2, $3, $4, $5, $6 }') $(out | grep "$(sed -n 's/^export AWS_SECRET_ACCESS_KEY=//p' "$work/s3.env")" >/dev/null && echo true || echo false)"
listed="$(out | sed -n 2p | awk '{ print $1, $2, $3, $4, $5, $6 }')"
ff buckets keys list
check "  ... ff buckets keys, its name before, the same" "0 $listed" "$(code) $(out | sed -n 2p | awk '{ print $1, $2, $3, $4, $5, $6 }')"
# A key to the account's functions alone, to invoke them: no bucket or queue, so no read-only either.
ff keys create --name cli-invoker --function '*' --read-only
check "ff keys create refuses --read-only for a key to functions alone, before calling" "2 true" \
  "$(code) $(err | grep -- "--read-only is for a key's buckets and queues" >/dev/null && echo true || echo false)"
ff keys create --name cli-invoker --function '*'
check "ff keys create makes a key to every function, to invoke when no level is said" "0 every function of the account, to invoke" \
  "$(code) $(out | head -1 | sed -n 's/^cli-invoker (AKFF[A-Z2-7]\{16\}) made, reaching \(.*\): its secret.*/\1/p')"
ff keys list
check "  ... listed with its functions and their level, no bucket or queue" "0 - - - all (invoke)" \
  "$(code) $(out | awk '$2 == "cli-invoker" { print $3, $4, $5, $6, $7 }')"
ff keys revoke cli-invoker --yes
check "ff keys revoke takes a key's name" "0 true" "$(code) $(out | grep -E '^revoked the access key cli-invoker \(AKFF[A-Z2-7]{16}\)$' >/dev/null && echo true || echo false)"
# The export kit's way out to AWS S3, both halves: the bucket to a folder with the key's variables, then the folder to
# "S3", here another bucket behind an AWS CLI profile whose key reaches that one alone, so that a second half still
# holding FF's variables would be refused there. The script calls the AWS CLI by name: the one above.
ff buckets create cli-photos-out
ff keys create --bucket cli-photos-out
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
ff keys revoke cli-photos-key --yes
# The AWS CLI exits non-zero when refused: its words, kept whatever its exit, say why.
refused="$(aws_with_key s3 ls 2>&1 || true)"
check "ff keys revoke, by its name, stops the key at once" "0 true" "$(code) $(grep -q InvalidAccessKeyId <<<"$refused" && echo true || echo false)"
}
section_def buckets section_buckets backend budget=15

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
  "$(ff keys list --output json; code) $(out | jq '[.[] | select(.buckets == ["cli-site"])] | length')"
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
}
section_def sites section_sites backend budget=5

section_downloads() {
section "the downloads site: a release signed with a throwaway key, deployed to FF by ff sites deploy, installed from it"
# This machine's ff as its build in the release, stand-ins for the others: hack/test-install.sh installs it from the
# site FF serves as a customer would, runs it, and is refused a changed build and signatures by another key; then
# installs as each machine install.sh knows.
local processor
case "$(uname -m)" in x86_64 | amd64) processor=x86_64 ;; *) processor=arm64 ;; esac
rm -rf "$work/builds" && mkdir "$work/builds"
cp "$ff_bin" "$work/builds/ff-linux-$processor"
ff buckets create cli-downloads
"$FF_REPO_ROOT/hack/test-install.sh" --site "http://cli-downloads.site.localhost:$website_port" \
  --deploy "$ff_bin sites deploy cli-downloads" "$work/builds" >"$work/install.out" 2>&1 || true
check "install.sh installs ff from the site FF serves, and refuses what changed: hack/test-install.sh's checks" \
  "install: 15 checks passed" "$(tail -1 "$work/install.out")"
}
section_def downloads section_downloads backend budget=5

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
ff keys create --queue cli-orders
check "a key for that queue alone gives the SQS endpoint among its seven variables" "0 7 http://localhost:$sqs_port" \
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
# Its key's last use is above: revoked now, so that the sections after find the account's keys as they left them.
ff keys revoke "$queue_key" --yes
}
section_def queues section_queues buckets budget=15

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
section_def event_sources section_event_sources backend budget=20

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
ff keys create --bucket cli-drop
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
ff keys revoke "$drop_key" --yes
ff buckets delete cli-drop --force --yes
ff queues delete cli-drop-events --yes
ff delete cli-on-upload --yes
}
section_def notifications section_notifications buckets budget=15

section_databases_used() {
section "a customer's database: its month in ff usage, minutes after it was made; then deleted"
# Each minute, the backend measures every database not measured yet in the hour: by now this one; run alone, it is
# waited for, as long as before. Before the small app, which makes the plan's one database.
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
section_def databases_used section_databases_used databases budget=15

section_small_app() {
section "the small app on FF alone, as one SAM template, as the guide walks through it: its page a site, its orders in FF's database, the latest in a cache, each one's receipt made through a queue and e-mailed"
# In account A, whose functions don't reach the internet: FF's database and cache, the S3 front door, the SQS and SES
# endpoints, they do.
# The app as one SAM template, deployed as the stack its samconfig.toml names, the buckets' names the suite's own: its
# three functions, its queue, the receipts' bucket and the page's, a site, whose origin the API's URL lets in.
site_origin="http://cli-shop-site.site.localhost:$website_port"
in_folder "$app" deploy template.yaml --parameter-overrides ReceiptsBucketName=cli-receipts SiteBucketName=cli-shop-site \
  "SiteOrigin=$site_origin" --output json
check "examples/orders-app's template.yaml deployed as the stack shop: two buckets, the page's a site, a queue, three functions with the Valkey, S3, SQS and SES clients among their libraries" \
  "0 shop cli-receipts,cli-shop-site $site_origin shop-new-orders shop-api,shop-receipts,shop-nightly" \
  "$(code) $(out | jq -r '"\(.stack) \([.buckets[].name] | join(",")) \(.buckets[1].site) \([.queues[].name] | join(",")) \([.functions[].name] | join(","))"')"
shop_url="$(out | jq -r '.outputs[] | select(.name == "OrdersApi") | .value' | sed 's:/$::')"
ff env list shop-api --show
check "the queue's name and the receipts' bucket in the API's variables, as the template's GetAtt and Ref give them" \
  "0 RECEIPTS_BUCKET=cli-receipts RECEIPTS_QUEUE=shop-new-orders" "$(code) $(out | paste -sd' ')"
ff event-sources list --function shop-receipts --output json
check "shop-receipts reads the queue ten messages a call, naming the messages it fails, as the template's SQS event says" \
  "0 shop-new-orders 10 ReportBatchItemFailures Enabled" \
  "$(code) $(out | jq -r '.[] | "\(.eventSourceArn | split(":") | last) \(.batchSize) \(.functionResponseTypes | join(",")) \(.state)"')"
ff schedule list shop-nightly --output json
check "shop-nightly runs each night at 02:00 UTC, the template's Schedule event" "0 EveryNight cron(0 2 * * ? *) true" \
  "$(code) $(out | jq -r '.[] | "\(.name) \(.expression) \(.enabled)"')"
ff db create shop --secret-for shop-api --secret-for shop-nightly --output json
check "ff db create: FF's database, its connection string the API's and the night's DATABASE_URL" "0 active shop-api,shop-nightly" \
  "$(code) $(out | jq -r '"\(.status) \([.secretsSet[].function] | join(","))"')"
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
# The sender, once proved, as the guide gives it: the template's ReceiptsFrom on a second deploy, each parameter not
# given keeping the stack's last value, and the secrets ff db and ff caches set left as they are.
in_folder "$app" deploy template.yaml --parameter-overrides ReceiptsFrom=orders@shop-cli.tn --output json
check "a second deploy gives shop-receipts its sender alone, the other parameters the stack's last, the secrets kept" \
  "0 unchanged,updated,unchanged environment RECEIPTS_BUCKET=cli-receipts|RECEIPTS_FROM=orders@shop-cli.tn DATABASE_URL,REDIS_URL" \
  "$(code) $(out | jq -r '"\([.functions[].action] | join(",")) \(.functions[1].changed | join(","))"') \
$("$ff_bin" env list shop-receipts --show | paste -sd'|') \
$("$ff_bin" secrets list shop-api --output json | jq -r '[.secrets[].name] | sort | join(",")')"
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
held() { "$ff_bin" queues get shop-new-orders --output json | jq '.messages.available + .messages.inFlight'; }
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
# Its page: site/'s files deployed to the template's site, as SAM uploads none, the API's address in config.json beside
# them.
cp -r "$app/site" "$work/shop-site"
printf '{"api": "%s"}\n' "$shop_url" >"$work/shop-site/config.json"
ff sites deploy cli-shop-site "$work/shop-site"
check "the app's page deployed to its bucket's site" "0 $site_origin" "$(code) $(out | tail -1)"
orders_page_check "$site_origin" "$shop_url" "$work/shop-page.html"
orders_cors_check "$shop_url" "$site_origin"
# The same receipt as the AWS CLI sees it, with a key of the account's that reads that bucket alone.
ff keys create --bucket cli-receipts --read-only
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
ff keys revoke "$receipts_key" --yes
}
section_def small_app section_small_app small_app_db buckets budget=195

# What the sections above started and the minutes since have done: read here, once those minutes have passed in the
# sections between.
section_buckets_used() {
section "buckets: what the bucket held at its measure, and its month in ff usage, minutes after; then emptied and deleted"
# Each minute, the backend measures every bucket not measured yet in the hour, and the front door writes the minutes
# of requests that are over: by now this one's; run alone, they are waited for, as long as before.
for _ in $(seq 75); do "$ff_bin" buckets get cli-photos --output json 2>/dev/null | jq -e '.measuredAt != null' >/dev/null && break; sleep 1; done
ff buckets get cli-photos
check "ff buckets get says what it held at its last measure" "0 true" "$(code) $(out | grep -E '^held +[0-9.]+ MB, [01] objects?, as measured at ' >/dev/null && echo true || echo false)"
# Its month: the requests the front door counted, by S3's classes, and the bytes they sent out, once their minute is written.
for _ in $(seq 150); do "$ff_bin" usage --output json 2>/dev/null | jq -e '.buckets[] | select(.name == "cli-photos" and .tier1Requests > 0 and .tier2Requests > 0)' >/dev/null && break; sleep 1; done
ff usage
check "ff usage lists its month after the databases: GB-months, each class's requests, what it sent out" "0 true true" \
  "$(code) $(out | grep -E '^cli-photos +[0-9.]+ +[1-9][0-9]* +[1-9][0-9]* +[0-9.]+ [MG]B +[0-9.]+$' >/dev/null && echo true || echo false) $("$ff_bin" usage --output json | jq '.buckets[] | select(.name == "cli-photos") | .bytesDownloaded > 0')"
ff buckets delete cli-photos --yes
check "ff buckets delete leaves a bucket with files, in the API's words, exit 3" "3 true" "$(code) $(err | grep "isn't empty" >/dev/null && echo true || echo false)"
ff buckets delete cli-photos --force --yes
check "  ... and --force deletes them first" "0 deleted the bucket cli-photos, with its files" "$(code) $(out)"
}
section_def buckets_used section_buckets_used buckets budget=5

section_sites_counted() {
section "a site: its visits in ff sites metrics, minutes after; then no site, a site again, and deleted"
# Each minute, the website server writes the minutes that are over: by now these; run alone, they are waited for, as
# long as before.
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
section_def sites_counted section_sites_counted sites budget=5

section_queues_counted() {
section "queues: the queue's metrics, minutes after; then deleted, and its month in ff usage"
# Its requests are counted a minute at a time: in its metrics by now; run alone, they are waited for, as long as
# before.
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
}
section_def queues_counted section_queues_counted queues budget=5

section_small_app_exported() {
section "the small app exported to AWS, minutes after: ff export's template and terraform/, which the SAM CLI and OpenTofu take, each function's role what its keys used"
# Its keys' uses are written at the minute's turn: by now the small app's; run alone, they are waited for, as long as
# before.
receipts_id="$("$ff_bin" get shop-receipts --output json | jq -r .id)"
for _ in $(seq 75); do
  curl -s "$api/functions/$receipts_id/key-uses" | jq -e '.uses | any(.operation == "SendEmail")' >/dev/null && break
  sleep 1
done
# An alias naming $LATEST, which the files publish as SAM's AutoPublishAlias, and one naming a version, whose code the
# export hasn't, which MIGRATION.md says.
ff alias set shop-receipts live latest
ff publish shop-api
ff alias set shop-api stable 1
check "shop-receipts's alias live names \$LATEST, shop-api's stable its version 1" "0 shop-api:stable made: version 1" "$(code) $(out)"
# stable's own URL, with a domain on it, which the runbook says how to make on AWS and moves at the cutover.
ff url enable shop-api --alias stable --auth none
ff domains add shop-api stable.shop-cli.tn --alias stable
check "  ... stable with a URL of its own, and a domain on it" "0 stable.shop-cli.tn: pending" "$(code) $(out | head -1)"
ff doctor "$app" --output json
check "ff doctor finds nothing in the small app's code or its template that works on FF alone, the folder read as its package" \
  "0 0 0" "$(code) $(out | jq -r '"\(.errors) \(.warnings)"')"
# What still points at FF: the shop's functions reached its S3, SQS and SES through FF's endpoints, as their keys say.
endpoints_of() { jq -r --arg resource "function $1" '.findings[] | select(.resource == $resource and .check == "ff-endpoints") | .message' "$work/out"; }
ff doctor --deployed --output json
check "ff doctor --deployed: shop-receipts reached FF's S3 and SES, shop-api FF's SQS, through the endpoints FF set them" \
  "0 true true true" \
  "$(code) $(endpoints_of shop-receipts | grep -F "S3 (cli-receipts" >/dev/null && echo true || echo false) \
$(endpoints_of shop-receipts | grep -F "SES (" >/dev/null && echo true || echo false) \
$(endpoints_of shop-api | grep -F "SQS (shop-new-orders)" >/dev/null && echo true || echo false)"
deployed="$(jq -c .findings "$work/out")"
ff doctor --deployed --strict
check "  ... which --strict fails on, with 1" "1" "$(code)"
kit="$work/shop-to-aws"
rm -rf "$kit"
ff export "$kit" --output json
check "ff export writes the account's kit: the template, terraform/, each function's zip, the runbook and the estimate" "0 true" \
  "$(code) $(for file in template.yaml terraform/functions.tf terraform/terraform.tfvars.example code/shop-api.zip code/shop-receipts.zip MIGRATION.md \
    cost-estimate.md; do [ -s "$kit/$file" ] || { echo false; exit; }; done; echo true)"
check "  ... cost-estimate.md, the last three months at AWS's prices, a column each" "3" \
  "$(grep -F '| US$ |' "$kit/cost-estimate.md" | tr '|' '\n' | grep -cE '^ [0-9]{4}-[0-9]{2}')"
ff doctor --deployed --output json
check "  ... and ff doctor --deployed says the same after it: an export changes nothing in the account" "0 true" \
  "$(code) $([ "$(jq -c .findings "$work/out")" = "$deployed" ] && echo true || echo false)"
# A function's resource in the template, up to the next one.
resource_of() { awk -v id="  $1:" '$0 == id { on = 1; next } on && /^  [A-Za-z]/ { exit } on' "$kit/template.yaml"; }
check "  ... shop-receipts's role writes the receipts and sends from the proved address, as its keys did, and neither reads the bucket nor sends to the queue" "true true false" \
  "$(resource_of ShopReceiptsFunction | grep -A1 -- '- S3WritePolicy:' | grep 'BucketName: !Ref CliReceiptsBucketName' >/dev/null && echo true || echo false) \
$(resource_of ShopReceiptsFunction | grep -A1 -- '- ses:SendEmail' | grep -F 'identity/orders@shop-cli.tn' >/dev/null && echo true || echo false) \
$(resource_of ShopReceiptsFunction | grep -E 'S3ReadPolicy|S3CrudPolicy|SQSSendMessagePolicy' >/dev/null && echo true || echo false)"
check "  ... shop-api's sends to the queue of new orders, which it can't read, and reads the receipts" "true false true" \
  "$(resource_of ShopApiFunction | grep -A1 -- '- SQSSendMessagePolicy:' | grep 'QueueName: !GetAtt ShopNewOrdersQueue.QueueName' >/dev/null && echo true || echo false) \
$(resource_of ShopApiFunction | grep -- '- SQSPollerPolicy:' >/dev/null && echo true || echo false) \
$(resource_of ShopApiFunction | grep -A1 -- '- S3ReadPolicy:' | grep 'BucketName: !Ref CliReceiptsBucketName' >/dev/null && echo true || echo false)"
# The tools AWS's users check a template and Terraform with, as hack/install-tools.sh pins them, the provider from
# its mirror; the region any, as nothing here reaches AWS.
tool() { local code=0; "$@" >"$work/out" 2>"$work/err" || code=$?; echo "$code" >"$work/code"; }
check "  ... shop-receipts's alias live its AutoPublishAlias, and Terraform's alias; shop-api's alias stable in MIGRATION.md, with the commands that make it" \
  "true true true" \
  "$(resource_of ShopReceiptsFunction | grep -F 'AutoPublishAlias: live' >/dev/null && echo true || echo false) \
$(grep -A1 -F 'resource "aws_lambda_alias" "shop_receipts"' "$kit/terraform/functions.tf" | grep -F 'name             = "live"' >/dev/null && echo true || echo false) \
$(grep -F "**shop-api**'s alias \`stable\` names version 1 on FF" "$kit/MIGRATION.md" | grep -F 'aws lambda create-alias --function-name shop-api --name stable' >/dev/null && echo true || echo false)"
check "  ... and stable's URL, made with the AWS CLI, its callers and its domain moved at the cutover" "true true" \
  "$(grep -F "**shop-api**'s alias \`stable\` has a URL of its own on FF" "$kit/MIGRATION.md" | grep -F -e '--qualifier stable --auth-type NONE' | grep -F '`stable.shop-cli.tn` reaches it' >/dev/null && echo true || echo false) \
$(grep -F "its alias \`stable\`'s URL's callers from http" "$kit/MIGRATION.md" | grep -F '`stable.shop-cli.tn` through CloudFront' >/dev/null && echo true || echo false)"
tool env -C "$kit" SAM_CLI_TELEMETRY=0 "$FF_REPO_ROOT/hack/bin/sam" validate --lint --region eu-west-3
check "  ... the template, which sam validate --lint takes, cfn-lint inside it" "0 true" \
  "$(code) $(out | grep 'is a valid SAM Template' >/dev/null && echo true || echo false)"
tofu=(env TF_CLI_CONFIG_FILE="$FF_REPO_ROOT/hack/.terraform/cli.tfrc" TF_IN_AUTOMATION=1 "$FF_REPO_ROOT/hack/bin/tofu" -chdir="$kit/terraform")
tool "${tofu[@]}" fmt -check
formatted="$(code)"
tool "${tofu[@]}" init -input=false -no-color
initialized="$(code)"
tool "${tofu[@]}" validate -no-color
check "  ... terraform/, which tofu fmt leaves as it is, and tofu init and validate take" "0 0 0 Success! The configuration is valid." \
  "$formatted $initialized $(code) $(out | head -1)"
}
section_def small_app_exported section_small_app_exported small_app budget=120

section_small_app_round_trip() {
section "the small app's way back: the template ff export wrote, deployed on FF by account B, makes what A has, compared through FF's API; then the app removed from both"
trip="$work/shop-round-trip"
rm -rf "$trip"
# The small app's functions alone, with what they use, whatever the sections before left in the account.
ff export "$trip" --functions shop-api,shop-receipts,shop-nightly --with-values --output json
check "ff export --with-values writes the variables' values in the template, the secrets left to fill" "0 true" \
  "$(code) $(grep -E '^[A-Za-z0-9]+=$' "$trip/secrets.template.env" >/dev/null && echo true || echo false)"
# As on AWS: S3's names are global, on FF too, so B names each bucket anew, as its parameter lets, its Default A's
# name; and the secrets, which FF never shows back, are filled.
overrides=()
renamed='{}'
while read -r parameter bucket; do
  overrides+=("$parameter=$bucket-b")
  renamed="$(jq -c --arg bucket "$bucket" '.[$bucket] = $bucket + "-b"' <<<"$renamed")"
done < <(awk '/^  [A-Za-z0-9]+BucketName:$/ { p = substr($1, 1, length($1) - 1) } p && $1 == "Default:" { print p, $2; p = "" }' \
  "$trip/template.yaml")
for parameter in $(sed -n 's/^\([A-Za-z0-9]*\)=$/\1/p' "$trip/secrets.template.env"); do overrides+=("$parameter=filled-by-b"); done
in_folder "$trip" --profile b deploy template.yaml --stack-name shop --parameter-overrides "${overrides[@]}" --yes
check "account B deploys it as the stack shop: A's three functions, its queue and its bucket, under the name B gave it" \
  "0 shop-api,shop-nightly,shop-receipts shop-new-orders cli-receipts-b" \
  "$(code) $("$ff_bin" --profile b list --output json | jq -r '[.[].name] | sort | join(",")') \
$("$ff_bin" --profile b queues list --output json | jq -r '[.[].name] | join(",")') \
$("$ff_bin" --profile b buckets list --output json | jq -r '[.[].name] | join(",")')"
# What A has, as B should have it: a secret a variable, as Lambda has no other, its value B's; a variable that holds a
# bucket's name holding B's, which the template gives it. What each account's API gives: a function's settings, code
# and variables, and its URL.
function_facts() { # <a|b> <function>
  local profile=() function secrets url
  [ "$1" = a ] || profile=(--profile "$1")
  function="$("$ff_bin" "${profile[@]}" get "$2" --output json)"
  secrets="$("$ff_bin" "${profile[@]}" secrets list "$2" --output json)"
  url="$("$ff_bin" "${profile[@]}" url show "$2" --output json 2>/dev/null || echo '{}')"
  jq -cnS --arg account "$1" --argjson renamed "$renamed" --argjson function "$function" --argjson secrets "$secrets" \
    --argjson url "$url" '
    def as_b: if $account == "a" then (map_values(if type == "string" then $renamed[.] // . else . end)
      + ($secrets.secrets | map({ key: .name, value: "filled-by-b" }) | from_entries)) else . end;
    $function | { runtime, handler, memory, timeout, eventFormat, minInstances, maxInstances, scaleToZero, codeSha256,
      description, deadLetterTargetArn, tags, variables: ((.environment // {}) | as_b),
      url: ($url.url // null | if . then { authType, cors } else . end) }'
}
same=()
for function in shop-api shop-receipts shop-nightly; do
  if [ "$(function_facts a "$function")" = "$(function_facts b "$function")" ]; then same+=(true); else
    same+=(false); echo "  $function, A's then B's:"; function_facts a "$function"; function_facts b "$function"; fi
done
check "each function B made is A's: its runtime, handler, memory, timeout, instances, code and variables, and its URL with its CORS" \
  "true true true" "${same[*]}"
aliases_of() { "$ff_bin" "${@:2}" alias list "$1" --output json | jq -r '[.[].name] | if . == [] then "none" else join(",") end'; }
check "  ... shop-receipts's alias live, its AutoPublishAlias, B's naming the version its deploy published; shop-api's stable, which names a version, A's alone, as MIGRATION.md says" \
  "live live 1 stable none" \
  "$(aliases_of shop-receipts) $(aliases_of shop-receipts --profile b) \
$("$ff_bin" --profile b alias list shop-receipts --output json | jq -r '.[0].functionVersion') $(aliases_of shop-api) $(aliases_of shop-api --profile b)"
mapping_facts() { "$ff_bin" "$@" event-sources list --function shop-receipts --output json | jq -c '[.[] | {
  queue: (.eventSourceArn | split(":") | last), function: (.functionArn | split(":")[6]), batchSize,
  maximumBatchingWindowInSeconds, functionResponseTypes, scalingConfig, state }]'; }
queue_facts() { "$ff_bin" "$@" queues get shop-new-orders --output json | jq -c '{ visibilityTimeout, messageRetentionPeriod,
  delaySeconds, maximumMessageSize, receiveMessageWaitTimeSeconds, redrivePolicy, tags }'; }
bucket_facts() { "$ff_bin" "${@:2}" buckets get "$1" --output json | jq -c '{ tags }'
  "$ff_bin" "${@:2}" buckets notifications "$1" --output json | jq -c .; }
check "  ... the queue's attributes A's, its mapping to shop-receipts A's, on the alias in B, as SAM's SQS event under AutoPublishAlias" \
  "true true true" \
  "$([ "$(queue_facts)" = "$(queue_facts --profile b)" ] && echo true || echo false) \
$([ "$(mapping_facts)" = "$(mapping_facts --profile b)" ] && echo true || echo false) \
$("$ff_bin" --profile b event-sources list --function shop-receipts --output json | jq '.[0].functionArn | endswith(":shop-receipts:live")')"
check "  ... and the bucket A's, its tags and notifications" "true" \
  "$([ "$(bucket_facts cli-receipts)" = "$(bucket_facts cli-receipts-b --profile b)" ] && echo true || echo false)"
ff --profile b delete-stack shop --yes
check "B's stack deleted, with all it made; A's app untouched" "0 0 0 0 shop-api,shop-nightly,shop-receipts" \
  "$(code) $("$ff_bin" --profile b list --output json | jq length) $("$ff_bin" --profile b queues list --output json | jq length) \
$("$ff_bin" --profile b buckets list --output json | jq length) \
$("$ff_bin" list --output json | jq -r '[.[].name | select(startswith("shop-"))] | sort | join(",")')"
ff queues delete shop-new-orders --yes
check "deleting the queue removes its mapping" "0 0" "$(code) $("$ff_bin" event-sources list --function shop-receipts --output json | jq length)"
ff buckets delete cli-receipts --force --yes
ff buckets delete cli-shop-site --force --yes
ff caches delete cli-orders --yes
ff email delete orders@shop-cli.tn --yes
ff email delete buyer@shop-cli.tn --yes
ff db delete shop --yes
in_folder "$app" delete-stack --yes --output json
check "A's stack deleted, its functions with it, what was deleted before it passed by" "0 true shop-api,shop-nightly,shop-receipts none" \
  "$(code) $(out | jq -r '"\(.deleted) \([.resources[] | select(.type == "AWS::Serverless::Function") | .physicalId] | sort | join(","))"') \
$("$ff_bin" list --output json | jq -r '[.[].name | select(startswith("shop-"))] | if . == [] then "none" else join(",") end')"
}
section_def small_app_round_trip section_small_app_round_trip small_app_exported budget=50

section_account() {
section "the account: who, its plan, what it used and owes, how its functions ran"
ff accounts
check "ff accounts lists account A, current" "0 * $account_a" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff account
check "ff account says its plan, the test's own, its rate among its limits, and that its functions don't reach the internet, as a new account's" \
  "0 CLI e2e true true" \
  "$(code) $(out | sed -n 's/^plan *\([^:]*\):.*/\1/p') $(out | grep '^plan .* 10000 changes a minute' >/dev/null && echo true || echo false) \
$(out | grep '^internet     off' >/dev/null && echo true || echo false)"
ff usage --output json
check "ff usage counts this month's calls of the functions deleted since, by name, the asynchronous one among them" "0 5 true" \
  "$(code) $(out | jq -r '.functions[] | select(.functionName == "cli-hello-ts") | .requests') $(out | jq -r '[.functions[] | select(.functionName == "cli-hello-ts") | .deleted] | first')"
ff usage --csv
check "and gives the API's CSV" "0 true" "$(code) $(out | head -1 | grep 'requests' >/dev/null && echo true || echo false)"
ff usage --aws --months 2 --output json
check "ff usage --aws: last month and this one so far at AWS's prices, an estimate, Lambda's line and the NAT gateway's among them, beside FF's own" \
  "0 2 true 2 true" \
  "$(code) $(out | jq '.months | length') $(out | jq '.months[0].until == null and .months[1].until != null') \
$(out | jq '[.months[1].lines[] | select(.line == "functions" or .line == "natGateway")] | length') $(out | jq '.months[1] | has("ffTotal")')"
ff usage --aws --without natGateway,logs
check "  ... and as text, from the prices' days, the lines left out marked" "0 true true" \
  "$(code) $(out | head -1 | grep -E "^At AWS's prices, an estimate: .* as FF read them (on|from) [0-9]{4}-" >/dev/null && echo true || echo false) \
$(out | grep -E '^A NAT gateway \(natGateway, left out\) ' >/dev/null && echo true || echo false)"
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
section_def account section_account failures budget=5

section_login() {
section "ff login against the development realm, the user's part done as a browser does it; the account, an API key, the logout"
# The realm, and a backend that takes its tokens, beside the development one and on its database. The function URLs
# it gives are the development one's, whose front serves every account's (the CI examples' section calls one).
e2e_up "Keycloak" keycloak
keycloak="http://localhost:$FF_KEYCLOAK_PORT"
api_oidc="http://127.0.0.1:$(free_port)"
e2e_start_backend "$work/backend-oidc.log" "$api_oidc" "${e2e_base_env[@]}" PORT="${api_oidc##*:}" \
  FF_AUTH_MODE=oidc FF_DEV_ACCOUNT_ID= FF_OIDC_ISSUER="$keycloak/realms/ff" FF_OIDC_AUDIENCE=ff-api \
  FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port"
# A customer as the console's sign-up leaves one: one of this run's own, since a kept stack keeps the realm's users.
email="cli-e2e-$account_a@ff.test" password=cli-e2e-password-1
check "the realm has a customer to log in as" 201 "$(keycloak_user "$email" "$password" Cli)"

ff config set endpoint "$api_oidc" --profile login
"$ff_bin" login --profile login --no-browser >"$work/login.out" 2>"$work/login.err" &
login_pid=$!
for _ in $(seq 1 60); do
  grep 'check that it shows the code' "$work/login.err" >/dev/null 2>&1 && break
  sleep 0.5
done
address="$(sed -n 's/^Open \([^ ]*\) in a browser: check that it shows the code .*/\1/p' "$work/login.err")"
user_code="$(sed -n 's/.* check that it shows the code \([A-Z0-9-]*\), then sign in and approve this device\.$/\1/p' "$work/login.err")"
check "ff login asks the API where to log in, and prints the realm's address for this device and the code it shows" \
  "$keycloak/realms/ff/device?user_code=$user_code" "$address"
check "the user opens it, signs in and approves the device, as a browser does it" \
  "the login form, the device's approval, Device Login Successful" \
  "$(keycloak_approve_device "$address" "$user_code" "$email" "$password")"
for _ in $(seq 1 30); do
  kill -0 "$login_pid" 2>/dev/null || break
  sleep 1
done
kill "$login_pid" 2>/dev/null || true
login_code=0
wait "$login_pid" || login_code=$?
credentials="$FF_CONFIG_DIR/credentials.toml"
check "ff login sees the approval within a poll or two, keeps the login for the profile, readable by its owner alone, and says who logged in" \
  "0 Logged in on profile login, as: true 600 issuer access_token refresh_token expires_at" \
  "$login_code $(head -1 "$work/login.out") $(grep -F "$email" "$work/login.out" >/dev/null && echo true || echo false) \
$(stat -c %a "$credentials") $(sed -n 's/^\([a-z_]*\) = .*/\1/p' "$credentials" | tr '\n' ' ' | sed 's/ $//')"
ff whoami --profile login --output json
check "the login's token calls the API: the user, with no account yet" "0 $email 0" "$(code) $(out | jq -r '"\(.user.email) \(.accounts | length)"')"

# Two accounts, the development ones: an owner of A, a developer of B.
ff whoami --profile b
sql "INSERT INTO memberships (account_id, user_id, role) SELECT '$account_a', id, 'owner' FROM users WHERE email = '$email'"
sql "INSERT INTO memberships (account_id, user_id, role) SELECT '$account_b', id, 'developer' FROM users WHERE email = '$email'"
ff list --profile login
check "with several accounts and none named, a command lists them, each with the role in it, and stops" \
  "3 Your login has several accounts: name the one to act for with --account, FF_ACCOUNT or \`ff config set account <ID>\` true true" \
  "$(code) $(err | head -1 | sed 's/^error: //') $(err | grep -F "  account $account_a " | grep ', as owner$' >/dev/null && echo true || echo false) \
$(err | grep -F "  account $account_b " | grep ', as developer$' >/dev/null && echo true || echo false)"
ff list --profile login --account 000000000000
check "an account named that the login isn't in is said so" \
  "3 error: You don't belong to account 000000000000 (from --account): \`ff accounts\` lists yours" "$(code) $(err | head -1)"
ff config set account "$account_a" --profile login
ff list --profile login --output json
check "with the account named, a command after the login works" "0 array" "$(code) $(out | jq -r type)"

ff api-keys create --profile login --name "cli e2e" --scopes functions:read,logs:read --expires 1d --output json
key="$(out | jq -r .key)"
check "ff api-keys create, with the login: the key once, in its field, its scopes, its expiry a day on" \
  "0 true functions:read,logs:read true" \
  "$(code) $([[ $key =~ ^ffk_[0-9a-f]{12}_ ]] && echo true || echo false) $(out | jq -r '.scopes | join(",")') \
$(out | jq '(.expiresAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now | . > 86000 and . < 86500')"
key_id="$(out | jq -r .id)"
ff api-keys list --profile login
check "ff api-keys list shows it working, never the key" "0 true false" \
  "$(code) $(out | grep -E "^$key_id +cli e2e +functions:read,logs:read +active " >/dev/null && echo true || echo false) \
$(out | grep -F "$key" >/dev/null && echo true || echo false)"
FF_TOKEN="$key" ff whoami --profile login --output json
check "FF_TOKEN's key comes before the login" "0 cli e2e" "$(code) $(out | jq -r .key.name)"
ff config set-token --profile login <<<"$key"
ff whoami --profile login --output json
check "and so does the profile's key" "0 cli e2e" "$(code) $(out | jq -r .key.name)"
# At most a few seconds: were the key not there, it would wait for a browser until its code's end.
timeout 20 "$ff_bin" login --profile login --no-browser >"$work/out" 2>"$work/err" && echo 0 >"$work/code" || echo $? >"$work/code"
check "ff login on a profile with a key says so, and stops" "3 true" \
  "$(code) $(err | grep -F "Profile login holds an API key (${key:0:17}…), which ff uses before a login" >/dev/null && echo true || echo false)"
ff api-keys list --profile login
check "ff api-keys refuses to call with a key, saying how to use the login" "3 true" \
  "$(code) $(err | grep -F "API keys are managed with an owner's login, never with a key" >/dev/null && echo true || echo false)"
ff config unset token --profile login
ff api-keys revoke "cli e2e" --yes --profile login
check "ff api-keys revoke finds the key by its name and revokes it" "0 Revoked the API key \"cli e2e\" ($key_id): whatever uses it is refused" \
  "$(code) $(out)"
FF_TOKEN="$key" ff whoami --profile login
check "the key is refused from then on" "3 error: The API key was revoked: save another key with \`ff config set-token\`" \
  "$(code) $(err | head -1)"
# The CI examples' keys (section ci), made while the login lasts, as an owner makes a CI's: a deploy's scopes, and a
# reader's, which a deploy lacks.
ff api-keys create --profile login --name "cli ci" --scopes stacks:read,stacks:write,functions:read,functions:write \
  --expires 1d --output json
ci_key="$(out | jq -r .key)"
ff api-keys create --profile login --name "cli ci reader" --scopes functions:read --expires 1d --output json
ci_reader_key="$(out | jq -r .key)"

# The renewal: the access token's end moved to the past, as five minutes on would leave it.
access="$(sed -n 's/^access_token = "\(.*\)"$/\1/p' "$credentials")"
sed -i 's/^expires_at = .*/expires_at = "2000-01-01T00:00:00Z"/' "$credentials"
ff whoami --profile login --output json
check "an access token at its end is renewed before the call, and the new one kept" "0 $email true true" \
  "$(code) $(out | jq -r .user.email) $([ "$(sed -n 's/^access_token = "\(.*\)"$/\1/p' "$credentials")" != "$access" ] && echo true || echo false) \
$(sed -n 's/^expires_at = "\(.*\)"$/\1/p' "$credentials" | jq -R 'fromdateiso8601 > now')"
refresh="$(sed -n 's/^refresh_token = "\(.*\)"$/\1/p' "$credentials")"
refreshed() {
  curl -sS -o "$work/refreshed.json" -w '%{http_code}' -X POST "$keycloak/realms/ff/protocol/openid-connect/token" \
    -d grant_type=refresh_token -d client_id=ff-cli --data-urlencode "refresh_token=$refresh"
}
check "the login is an offline one, which outlives the realm's session: its token, refreshed at the realm, says so" "200 true" \
  "$(refreshed) $(jq -r .scope "$work/refreshed.json" | tr ' ' '\n' | grep -x offline_access >/dev/null && echo true || echo false)"
ff logout --profile login
check "ff logout revokes the login at the realm, then removes its tokens" \
  "0 Logged out of profile login: the login revoked at $keycloak/realms/ff, its tokens removed from $credentials 0" \
  "$(code) $(out) $(grep -c -E '^(issuer|access_token|refresh_token|expires_at) = ' "$credentials" || true)"
check "the token a copy would hold is refused at the realm from then on" "400 invalid_grant" \
  "$(refreshed) $(jq -r .error "$work/refreshed.json")"
ff whoami --profile login
check "and ff has no token to call with, saying how to log in" "3 true" \
  "$(code) $(err | grep -F 'There is no token to call' | grep -F '`ff login` logs you in with your browser' >/dev/null && echo true || echo false)"
}
section_def login section_login backend budget=60

section_local() {
section "ff local: on this machine, in Docker, as production runs it"
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
local_started "$work/start.out" "$work/start.err" "$FF_REPO_ROOT/examples/hello.py" --port "$local_port"
check "local start says where it runs" "hello (python) runs at http://127.0.0.1:$local_port/invoke: POST an event to it. Ctrl-C stops it" "$(cat "$work/start.out")"
check "and answers there, as the runtime answers the backend" "Hello Port" \
  "$(curl -s -X POST "http://127.0.0.1:$local_port/invoke" -d '{"name": "Port"}' | jq -r .message)"
local_stopped
check "Ctrl-C stops it and removes its container" 0 "$(leftover)"
url_local_port="$(free_port)"
local_started "$work/start.out" "$work/start.err" "$work/web.ts" --url --port "$url_local_port"
check "local start --url serves it as its URL would" \
  "web (nodejs) runs as its URL would at http://127.0.0.1:$url_local_port/: any request calls it with AWS Lambda's URL event. Ctrl-C stops it" \
  "$(cat "$work/start.out")"
check "a request there gets the function's answer, from Lambda's URL event" "200 Ahlan Local at /hi" \
  "$(curl -s -o "$work/answer" -w '%{http_code}' "http://127.0.0.1:$url_local_port/hi?name=Local") $(cat "$work/answer")"
local_stopped
check "and Ctrl-C removes its container too" 0 "$(leftover)"
}
section_def local section_local backend budget=45

section_local_template() {
section "ff local start template.yaml: the template's functions behind one front door, each started at its first call"
local app="$work/shop" port starter
# until_said <text> <file>: waits up to 30 s for the line ff local start says.
until_said() {
  local _
  for _ in $(seq 1 60); do
    grep -F "$1" "$2" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}
# invoked <function> <event>: Lambda's Invoke at the front door, its status and its answer.
invoked() {
  curl -s -o "$work/invoked" -w '%{http_code}' -X POST "http://127.0.0.1:$port/2015-03-31/functions/$1/invocations" -d "$2"
  echo " $(cat "$work/invoked")"
}
# at_url <host> [curl args...]: a request to a function's URL, its status and its answer; its headers in $work/url.head.
at_url() {
  local host="$1"
  shift
  curl -s -o "$work/url.body" -D "$work/url.head" -w '%{http_code}' "$@" "http://$host.fn.localhost:$port/"
  echo " $(cat "$work/url.body")"
}
# url_header <name>: the header of the last answer at_url got.
url_header() { sed -n "s/^$1: //Ip" "$work/url.head" | tr -d '\r'; }
# lambda_cli <args...>: the AWS CLI's lambda commands with the local key's file alone, the front door their endpoint.
lambda_cli() { local_aws "$app" "$port" lambda "$@"; }
rm -rf "$app" && mkdir -p "$app/greeter" "$app/caller" "$app/failing" "$app/recorder" "$app/reporter"
cat >"$app/template.yaml" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: python3.13
    Handler: app.handler
    Timeout: 10
Resources:
  Failing:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: failing/
      EventInvokeConfig:
        MaximumRetryAttempts: 1
        DestinationConfig:
          OnFailure:
            Type: Lambda
            Destination: !GetAtt Recorder.Arn
  Recorder:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: recorder/
  Greeter:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: greeter/
      FunctionUrlConfig:
        AuthType: NONE
        Cors:
          AllowOrigins: [https://app.example.tn]
          AllowMethods: [GET, POST]
          MaxAge: 300
      Environment:
        Variables:
          GREETING: Hola
          QUEUE_URL: !Ref Jobs
  Caller:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: caller/
      FunctionUrlConfig:
        AuthType: AWS_IAM
      Environment:
        Variables:
          GREETER: !Ref Greeter
  Reporter:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: reporter/
      Events:
        Nightly:
          Type: Schedule
          Properties:
            Schedule: cron(0 2 * * ? *)
        Hourly:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(1 hour)
            State: DISABLED
            Input: '{"report": "hourly"}'
  Jobs:
    Type: AWS::SQS::Queue
YAML
greeter() {
  printf 'import os\n\n\ndef handler(event, context):\n    print("greeting", event.get("name"))\n    return {"greeting": os.environ["GREETING"], "secret": os.environ["SECRET"], "queue": os.environ["QUEUE_URL"], "code": "%s"}\n' "$1" >"$app/greeter/app.py"
}
greeter first
cat >"$app/caller/app.py" <<'PY'
import json
import os
import urllib.request


def handler(event, context):
    url = f"{os.environ['AWS_ENDPOINT_URL_LAMBDA']}/2015-03-31/functions/{os.environ['GREETER']}/invocations"
    request = urllib.request.Request(url, data=json.dumps({"name": "Caller"}).encode(), method="POST")
    with urllib.request.urlopen(request, timeout=10) as answer:
        return {"called": json.load(answer)}
PY
printf 'def handler(event, context):\n    raise RuntimeError("no luck")\n' >"$app/failing/app.py"
printf 'def handler(event, context):\n    request = event["requestContext"]\n    print("recorded", request["condition"], request["approximateInvokeCount"], event["requestPayload"]["n"])\n' \
  >"$app/recorder/app.py"
printf 'def handler(event, context):\n    print("ran", event.get("source"), event.get("time"), (event.get("resources") or [event.get("report")])[0])\n' \
  >"$app/reporter/app.py"
printf '# what the functions are given apart from the template\nSECRET=from-env-local\n' >"$app/.env.local"
printf 'SECRET=fine\nAWS_REGION=eu-west-1\n' >"$work/reserved.env"
ff local start "$app/template.yaml" --secrets "$work/reserved.env"
check "a secrets file's problem is refused at its line, before anything starts" \
  "2 error: ff local start ran nothing: $work/reserved.env has a problem|$work/reserved.env:2: AWS_REGION is reserved: AWS Lambda or FF's runtime sets it" \
  "$(code) $(err | grep -A1 '^error:' | paste -sd'|')"

port="$(free_port)"
# An asynchronous call's second lasts 20 ms in the suite's build: its retry's minute comes in 1.2 s. Its schedules' clock
# is at noon, so that no schedule runs, whenever the suite does.
FF_TEST_ASYNC_SECOND_MS=20 FF_TEST_NOW=2026-11-10T12:00:00Z \
  local_started "$work/start.out" "$work/start.err" "$app/template.yaml" --port "$port" --idle 4s --watch
check "it says where the app runs, its functions, and how to call them" \
  "shop ($app/template.yaml) runs on this machine, its front door at http://127.0.0.1:$port:" \
  "$(head -1 "$work/start.out")"
check "  ... each function's URL, and which takes the local key's signature" "true true" \
  "$(grep -E "^  Greeter +python +128 MB, 10 s  http://greeter.fn.localhost:$port/$" "$work/start.out" >/dev/null && echo true || echo false) \
$(grep -E "^  Caller +python +128 MB, 10 s  http://caller.fn.localhost:$port/, signed with its key$" "$work/start.out" >/dev/null && echo true || echo false)"
check "  ... with its secrets file" "true" "$(grep -F "Their secrets are $app/.env.local's." "$work/start.out" >/dev/null && echo true || echo false)"
check "nothing runs before a call" 0 "$(leftover)"
check "a call starts the function and answers, its variables resolved here and its secret given" \
  "200 Hola from-env-local http://host.docker.internal:$port/000000000000/Jobs first" \
  "$(invoked Greeter '{"name": "Curl"}' | sed 's/ .*//') $(jq -r '[.greeting, .secret, .queue, .code] | join(" ")' "$work/invoked")"
invoked Greeter '{"name": "Again"}' >/dev/null
check "  ... and the next call finds it running" "1 1" \
  "$(leftover) $(grep -c '^Greeter: started' "$work/start.err")"
check "a function calls another through the front door, as AWS_ENDPOINT_URL_LAMBDA leads it from its container" \
  "200 Hola 2" "$(invoked Caller '{}' | sed 's/ .*//') $(jq -r .called.greeting "$work/invoked") $(leftover)"
check "each function's log is on stderr after its name, and in its file" "true true" \
  "$(grep -F 'Greeter | greeting Caller' "$work/start.err" >/dev/null && echo true || echo false) $(grep -F 'greeting Curl' "$app/.ff/local/logs/Greeter.log" >/dev/null && echo true || echo false)"
check "a function this machine hasn't is Lambda's 404" \
  "404 Function not found: arn:aws:lambda:tn-tunis-1:000000000000:function:Payments" \
  "$(invoked Payments '{}' | sed 's/ .*//') $(jq -r .message "$work/invoked")"
greeter second
until_said "Greeter: its code changed: starting it again" "$work/start.err" || true
check "--watch starts a running function again when its code changes" "true 200 second" \
  "$(grep -F 'Greeter: its code changed' "$work/start.err" >/dev/null && echo true || echo false) $(invoked Greeter '{}' | sed 's/ .*//') $(jq -r .code "$work/invoked")"
until_said "Greeter: no call for 4s: stopped" "$work/start.err" || true
until_said "Caller: no call for 4s: stopped" "$work/start.err" || true
check "--idle stops each function after that long without a call" 0 "$(leftover)"
check "  ... and its next call starts it again" "200 second 0" \
  "$(invoked Greeter '{}' | sed 's/ .*//') $(jq -r .code "$work/invoked") $(grep -c 'its code failed' "$work/start.err")"
local key_id
key_id="$(sed -n 's/^aws_access_key_id = //p' "$app/.ff/local/credentials")"
check "the local key is printed, and kept in .ff/local/credentials, which its owner alone reads" "AKFF 600 true" \
  "${key_id:0:4} $(stat -c %a "$app/.ff/local/credentials") $(grep -F "is in $app/.ff/local/credentials: AWS_ACCESS_KEY_ID=$key_id " "$work/start.out" >/dev/null && echo true || echo false)"
lambda_cli invoke --function-name Greeter --payload '{"name": "Cli"}' --cli-binary-format raw-in-base64-out \
  --log-type Tail "$work/cli-invoked.json" >"$work/cli-invoke.out"
check "the AWS CLI calls a function with the local key, its log asked with LogType Tail" "200 Hola true" \
  "$(jq -r .StatusCode "$work/cli-invoke.out") $(jq -r .greeting "$work/cli-invoked.json") $(jq -r .LogResult "$work/cli-invoke.out" | base64 -d | grep -F 'greeting Cli' >/dev/null && echo true || echo false)"
check "  ... and reads its configuration, the template's variables and never a secret" "python3.13 app.handler GREETING,QUEUE_URL Active" \
  "$(lambda_cli get-function-configuration --function-name Greeter | jq -r '[.Runtime, .Handler, (.Environment.Variables | keys | join(",")), .State] | join(" ")')"
AWS_ACCESS_KEY_ID=AKFFNOTTHELOCALKEY00 AWS_SECRET_ACCESS_KEY=not-the-secret AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_REGION=tn-tunis-1 AWS_ENDPOINT_URL_LAMBDA="http://127.0.0.1:$port" "${aws_cli[@]}" lambda invoke --function-name Greeter "$work/refused.json" \
  >"$work/refused.out" 2>&1 || true
check "a request signed with another key is refused in Lambda's words" "true" \
  "$(grep -F '(UnrecognizedClientException) when calling the Invoke operation: The security token included in the request is invalid.' "$work/refused.out" >/dev/null && echo true || echo false)"
# Greeter's calls without a name so far, each a line of its log: the URL's event has none.
local nameless
nameless="$(grep -c 'Greeter | greeting None' "$work/start.err" || true)"
check "a function's URL calls it with the URL's event, and answers its value with the template's CORS" \
  "200 Hola https://app.example.tn" \
  "$(at_url greeter -H 'Origin: https://app.example.tn' | sed 's/ .*//') $(jq -r .greeting "$work/url.body") $(url_header access-control-allow-origin)"
for _ in $(seq 1 60); do
  [ "$(grep -c 'Greeter | greeting None' "$work/start.err" || true)" -gt "$nameless" ] && break
  sleep 0.5
done
check "  ... a browser's preflight answered by its CORS, without a call" "204 POST 300 $((nameless + 1))" \
  "$(at_url greeter -X OPTIONS -H 'Origin: https://app.example.tn' -H 'Access-Control-Request-Method: POST' | sed 's/ .*//') \
$(url_header access-control-allow-methods | tr -d ' ' | tr ',' '\n' | grep -x POST) $(url_header access-control-max-age) \
$(grep -c 'Greeter | greeting None' "$work/start.err")"
check "a host that names no function's URL is the gateway's 404" '404 {"Message":"Not Found"}' "$(at_url recorder)"
check "a URL that takes the account's credentials refuses a request without the local key's signature" \
  '403 Forbidden: this URL takes a request signed for lambda by an access key of its account, or an API key of it, as "Authorization: Bearer ffk_…"' \
  "$(at_url caller | sed 's/ .*//') $(jq -r .Message "$work/url.body")"
check "  ... and takes one signed with it, as curl --aws-sigv4 signs it" "200 Hola" \
  "$(at_url caller --aws-sigv4 aws:amz:tn-tunis-1:lambda --user "$key_id:$(sed -n 's/^aws_secret_access_key = //p' "$app/.ff/local/credentials")" | sed 's/ .*//') $(jq -r .called.greeting "$work/url.body")"
check "an asynchronous call is answered 202" 202 \
  "$(lambda_cli invoke --function-name Failing --invocation-type Event --payload '{"n": 1}' --cli-binary-format raw-in-base64-out "$work/event.json" | jq -r .StatusCode)"
until_said "Recorder | recorded" "$work/start.err" || true
check "  ... retried as FF retries it, as many times as its function says, then its record is its OnFailure destination's" \
  "true true true" \
  "$(grep -E '^Failing: the asynchronous call [^ ]+ failed: RuntimeError: no luck; tried again in 60 s$' "$work/start.err" >/dev/null && echo true || echo false) \
$(grep -E '^Failing: the asynchronous call [^ ]+ failed: RuntimeError: no luck; dropped after 2 attempts: its retries are used$' "$work/start.err" >/dev/null && echo true || echo false) \
$(grep -F 'Recorder | recorded RetriesExhausted 2 1' "$work/start.err" >/dev/null && echo true || echo false)"
local_stopped
check "Ctrl-C removes their containers" 0 "$(leftover)"

# The schedules, in a start of their own: its clock, a test build's, three seconds before the Nightly's time.
port="$(free_port)"
FF_TEST_NOW=2026-11-10T01:59:57Z \
  local_started "$work/scheduled.out" "$work/scheduled.err" "$app/template.yaml" --port "$port"
check "the start lists each schedule, its expression and its next run" "true true" \
  "$(grep -E '^  Reporter/Nightly +cron\(0 2 \* \* \? \*\)  next 2026-11-10T02:00:00Z$' "$work/scheduled.out" >/dev/null && echo true || echo false) \
$(grep -E '^  Reporter/Hourly +rate\(1 hour\)  disabled$' "$work/scheduled.out" >/dev/null && echo true || echo false)"
until_said "Reporter | ran aws.events" "$work/scheduled.err" || true
check "a schedule runs on time, its function called without waiting with EventBridge's Scheduled Event" "true true" \
  "$(grep -E '^Reporter: its schedule Nightly runs, due at 2026-11-10T02:00:00Z: the asynchronous call [0-9a-f-]{36}$' "$work/scheduled.err" >/dev/null && echo true || echo false) \
$(grep -F 'Reporter | ran aws.events 2026-11-10T02:00:00Z arn:aws:events:tn-tunis-1:000000000000:rule/Reporter-Nightly' "$work/scheduled.err" >/dev/null && echo true || echo false)"
ff local run Hourly "$app"
until_said "Reporter | ran None None hourly" "$work/scheduled.err" || true
check "ff local run runs one now, a disabled one too, with its own input" "0 Reporter's schedule Hourly runs now true" \
  "$(code) $(out | sed 's/: the asynchronous call.*//') $(grep -F 'Reporter | ran None None hourly' "$work/scheduled.err" >/dev/null && echo true || echo false)"
ff local run Weekly "$app"
check "  ... and refuses one the template hasn't, naming those it has" \
  "2 error: No function has a schedule Weekly: the template's are Reporter/Hourly, Reporter/Nightly" "$(code) $(err | grep '^error:')"
local_stopped
ff local run Nightly "$app"
check "  ... and says when ff local start isn't running" "3 true" \
  "$(code) $(err | grep -F "error: ff local start isn't running for $app: nothing answers at http://127.0.0.1:$port" >/dev/null && echo true || echo false)"
ff local reset "$app" --yes
check "ff local reset removes what ff local keeps, the logs and the key" "0 removed $app/.ff/local false" \
  "$(code) $(out) $([ -e "$app/.ff/local" ] && echo true || echo false)"
}
section_def local_template section_local_template backend budget=45

section_local_apps() {
section "ff local start on the applications a developer has: ff init --template sam's, and the small app, its libraries installed, its page served from its folder"
local hello="$work/cli-local-hello" shop="$work/cli-local-shop" port starter origin
# started <out> <err> <args...>: ff local start in the background, at the section's port, with the test clocks.
started() { FF_TEST_ASYNC_SECOND_MS=20 FF_TEST_NOW=2026-11-10T12:00:00Z local_started "$@" --port "$port"; }

(cd "$work" && rm -rf "$hello" && "$ff_bin" init "$(basename "$hello")" --runtime nodejs --template sam >"$work/out" 2>"$work/err")
check "ff init --template sam's .gitignore leaves out what ff local keeps, and its secrets file" "true true" \
  "$(grep -x '.ff/' "$hello/.gitignore" >/dev/null && echo true || echo false) $(grep -x '.env.local' "$hello/.gitignore" >/dev/null && echo true || echo false)"
printf 'GREETING=never-committed\n' >"$hello/.env.local"
port="$(free_port)"
started "$work/hello.out" "$work/hello.err" "$hello/template.yaml"
check "its application starts as it is, its function's URL printed" "true" \
  "$(grep -E "^  HelloWorldFunction +nodejs +128 MB, 3 s  http://helloworldfunction.fn.localhost:$port/$" "$work/hello.out" >/dev/null && echo true || echo false)"
check "  ... and called there, answers as it does on FF" '200 {"message":"hello world"}' \
  "$(at "http://helloworldfunction.fn.localhost:$port/hello")"
local_stopped
git -C "$hello" init -q
check "  ... what ff local keeps and the secrets file stay out of git" ".gitignore README.md events/ hello-world/ samconfig.toml template.yaml tests/" \
  "$(git -C "$hello" status --porcelain --untracked-files=normal | sed 's/^?? //' | LC_ALL=C sort | paste -sd' ')"

# The small app as a developer runs it here: its libraries installed, as sam build installs them for sam local; its
# page served from site/ itself, at its site's address, which the API's CORS lets in, config.json beside it naming the
# API's address here, as a deploy writes it there.
rm -rf "$shop" && cp -r "$FF_REPO_ROOT/examples/orders-app" "$shop"
(cd "$shop" && npm ci --no-audit --no-fund --omit=dev >"$work/npm.out" 2>&1) || fail "npm ci in the small app: $(tail -5 "$work/npm.out")"
port="$(free_port)"
origin="http://local-site.site.localhost:$port"
printf '{"api": "http://shop-api.fn.localhost:%s"}\n' "$port" >"$shop/site/config.json"
started "$work/shop.out" "$work/shop.err" "$shop/template.yaml" --site "local-site=$shop/site" \
  --parameter-overrides ReceiptsBucketName=local-receipts SiteBucketName=local-site "SiteOrigin=$origin"
check "the small app starts, its three functions named as the stack names them, its URL, its schedule and its site listed" "shop-api,shop-nightly,shop-receipts true true true" \
  "$(sed -n 's/^  \(shop-[a-z]*\) .*/\1/p' "$work/shop.out" | LC_ALL=C sort | paste -sd,) \
$(grep -E "^  shop-api +nodejs +128 MB, 5 s  http://shop-api.fn.localhost:$port/$" "$work/shop.out" >/dev/null && echo true || echo false) \
$(grep -E '^  shop-nightly/EveryNight +cron\(0 2 \* \* \? \*\)  next 2026-11-11T02:00:00Z$' "$work/shop.out" >/dev/null && echo true || echo false) \
$(grep -F "  local-site  $origin/, $(cd "$shop/site" && pwd -P)'s files" "$work/shop.out" >/dev/null && echo true || echo false)"
check "  ... its page at its site's address, from site/, its config.json naming the API here, its error page for a path it hasn't" \
  "200 text/html; charset=utf-8 <title>Orders</title> http://shop-api.fn.localhost:$port 404 text/html; charset=utf-8" \
  "$(at "$origin/" | sed -n '1s/ .*//p') $(sed -n 's/^content-type: //Ip' "$work/at.head" | tr -d '\r') $(grep -o '<title>Orders</title>' "$work/at.body") \
$(at "$origin/config.json" >/dev/null; jq -r .api "$work/at.body") $(at "$origin/no/such/page" | sed -n '1s/ .*//p') $(sed -n 's/^content-type: //Ip' "$work/at.head" | tr -d '\r')"
orders_cors_check "http://shop-api.fn.localhost:$port" "$origin"
check "  ... and its handler, loaded with its libraries, refuses a wrong order before it reaches the database" \
  "400 An order is {\"item\": \"<what>\", \"quantity\": <a whole number above 0>}, and \"email\": \"<an address>\" for its receipt $origin" \
  "$(at "http://shop-api.fn.localhost:$port/orders" -X POST -H "Origin: $origin" -d '{"item": ""}' | sed 's/ .*//') $(jq -r .message "$work/at.body") \
$(sed -n 's/^access-control-allow-origin: //Ip' "$work/at.head" | tr -d '\r')"
ff local run EveryNight "$shop"
check "ff local run runs its nightly now, as its schedule would" "0 shop-nightly's schedule EveryNight runs now" \
  "$(code) $(out | sed 's/: the asynchronous call.*//')"
for _ in $(seq 1 60); do
  grep -F 'dropped after 3 attempts' "$work/shop.err" >/dev/null && break
  sleep 0.5
done
# Without its database's address, a secret, it fails: an asynchronous call's failure, tried twice more, a minute and
# then two after it, which the suite's build makes 1.2 s and 2.4 s.
check "  ... and, failing without its database, is tried again twice, then dropped, as FF retries an asynchronous call" \
  "3 2 true" \
  "$(grep -cE '^shop-nightly: the asynchronous call [^ ]+ failed: Error: DATABASE_URL is not set' "$work/shop.err") \
$(grep -cE '^shop-nightly: the asynchronous call [^ ]+ failed: Error: DATABASE_URL is not set: .*; tried again in (60|120) s$' "$work/shop.err") \
$(grep -E '^shop-nightly: the asynchronous call [^ ]+ failed: Error: DATABASE_URL is not set: .*; dropped after 3 attempts: its retries are used$' "$work/shop.err" >/dev/null && echo true || echo false)"
local_stopped
check "Ctrl-C removes their containers" 0 "$(leftover)"
git -C "$shop" init -q
check "what ff local keeps stays out of git in an app whose .gitignore doesn't name it: .ff/ has its own" "true 0" \
  "$([ -e "$shop/.ff/local/credentials" ] && echo true || echo false) $(git -C "$shop" status --porcelain --untracked-files=normal | grep -c '^?? \.ff/' || true)"
}
section_def local_apps section_local_apps backend budget=45

section_local_queues() {
section "ff local start's queues: SQS at the front door, the AWS CLI's cases of L4, a function's sends, its failures' records, and a function reading one"
local app="$work/queues" port starter key_id url
# sqs_cli <args...>: the AWS CLI's sqs commands with the local key's file alone, the front door their endpoint.
sqs_cli() { local_aws "$app" "$port" sqs "$@" --output json; }
# refused <args...>: an sqs command's error, by the code the AWS CLI names.
refused() { sqs_cli "$@" >/dev/null 2>"$work/sqs.err" && echo accepted || grep -oE 'An error occurred \([A-Za-z0-9.]+\)' "$work/sqs.err" | head -1; }
# received <queue> [args...]: the messages a queue answers a receive, all their attributes asked; nothing for none.
received() {
  local queue="$1"
  shift
  sqs_cli receive-message --queue-url "$url/$queue" --attribute-names All --message-attribute-names All "$@"
}
rm -rf "$app" && mkdir -p "$app/sender" "$app/failing" "$app/reader"
cat >"$app/template.yaml" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: python3.13
    Handler: app.handler
    Timeout: 10
Resources:
  Sender:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: sender/
      Environment:
        Variables:
          QUEUE_URL: !Ref Orders
  Failing:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: failing/
      DeadLetterQueue:
        Type: SQS
        TargetArn: !GetAtt Dead.Arn
      EventInvokeConfig:
        MaximumRetryAttempts: 0
        DestinationConfig:
          OnFailure:
            Type: SQS
            Destination: !GetAtt Records.Arn
  Orders:
    Type: AWS::SQS::Queue
    Properties:
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt Dead.Arn
        maxReceiveCount: 2
  Reader:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: reader/
      Timeout: 3
      Events:
        Work:
          Type: SQS
          Properties:
            Queue: !GetAtt Jobs.Arn
            MaximumBatchingWindowInSeconds: 1
            FunctionResponseTypes:
              - ReportBatchItemFailures
  Dead:
    Type: AWS::SQS::Queue
  Records:
    Type: AWS::SQS::Queue
  Jobs:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 3
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt JobsDead.Arn
        maxReceiveCount: 2
  JobsDead:
    Type: AWS::SQS::Queue
YAML
# A function that sends to its queue as an SDK would, with no setting: the endpoint, the region and the key FF gives
# it, its request signed by hand, as the runtime images have no SDK.
cp "$FF_REPO_ROOT/hack/lib/local-functions/signed.py" "$app/sender/"
cat >"$app/sender/app.py" <<'PY'
import json
import os

from signed import send


def handler(event, context):
    body = json.dumps({"QueueUrl": os.environ["QUEUE_URL"], "MessageBody": event["body"]}).encode()
    headers = {"content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.SendMessage"}
    with send("sqs", "POST", os.environ["AWS_ENDPOINT_URL_SQS"] + "/", body, headers) as answer:
        return json.load(answer)
PY
printf 'def handler(event, context):\n    raise RuntimeError("no luck")\n' >"$app/failing/app.py"
# A function reading its queue in batches, as the small app's receipts do: each batch and record logged, a message
# whose body is "fail" named in its answer, so that it alone comes back.
cat >"$app/reader/app.py" <<'PY'
import json


def handler(event, context):
    print(f"batch of {len(event['Records'])}", flush=True)
    failures = []
    for record in event["Records"]:
        print("record " + json.dumps(record, sort_keys=True), flush=True)
        if record["body"] == "fail":
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
PY

port="$(free_port)"
url="http://127.0.0.1:$port/000000000000"
FF_TEST_ASYNC_SECOND_MS=20 FF_TEST_NOW=2026-11-10T12:00:00Z \
  local_started "$work/queues.out" "$work/queues.err" "$app/template.yaml" --port "$port"
check "the start lists the template's queues, their URLs and a redrive policy" "true true true" \
  "$(grep -F "Its queues, SQS's at http://127.0.0.1:$port, kept while it runs:" "$work/queues.out" >/dev/null && echo true || echo false) \
$(grep -E "^  Orders +$url/Orders, to Dead after 2 receives$" "$work/queues.out" >/dev/null && echo true || echo false) \
$(grep -E "^  Records +$url/Records$" "$work/queues.out" >/dev/null && echo true || echo false)"
check "the AWS CLI lists them and finds one's URL, with the local key" "$url/Dead $url/Jobs $url/JobsDead $url/Orders $url/Records $url/Orders" \
  "$(sqs_cli list-queues | jq -r '.QueueUrls | join(" ")') $(sqs_cli get-queue-url --queue-name Orders | jq -r .QueueUrl)"
sqs_cli send-message --queue-url "$url/Orders" --message-body 'Ahlan from the CLI' \
  --message-attributes '{"source": {"DataType": "String", "StringValue": "aws-cli"}}' >"$work/sent.json"
received Orders --wait-time-seconds 2 >"$work/received.json"
key_id="$(sed -n 's/^aws_access_key_id = //p' "$app/.ff/local/credentials")"
check "  ... sends a message with an attribute, the sums it checks right, and receives it back, sent by the key" \
  "Ahlan from the CLI aws-cli 1 true" \
  "$(jq -r '.Messages[0] | "\(.Body) \(.MessageAttributes.source.StringValue) \(.Attributes.ApproximateReceiveCount)"' "$work/received.json") \
$([ "$(jq -r '.Messages[0].Attributes.SenderId' "$work/received.json")" = "$key_id" ] && echo true || echo false)"
sqs_cli delete-message --queue-url "$url/Orders" --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' "$work/received.json")"
check "  ... deletes it, the queue empty after" "0 0" \
  "$(sqs_cli get-queue-attributes --queue-url "$url/Orders" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  | jq -r '.Attributes | "\(.ApproximateNumberOfMessages) \(.ApproximateNumberOfMessagesNotVisible)"')"
check "  ... a queue that isn't there, by its query code" "An error occurred (AWS.SimpleQueueService.NonExistentQueue)" \
  "$(refused get-queue-url --queue-name nowhere)"
check "  ... and one ff local doesn't make, as the template makes them" "An error occurred (AWS.SimpleQueueService.UnsupportedOperation)" \
  "$(refused create-queue --queue-name more)"
check "  ... sends a batch, each entry answered" "a,b" \
  "$(sqs_cli send-message-batch --queue-url "$url/Records" --entries Id=a,MessageBody=one Id=b,MessageBody=two | jq -r '[.Successful[].Id] | sort | join(",")')"
sqs_cli purge-queue --queue-url "$url/Records"
check "  ... and purges a queue" 0 \
  "$(sqs_cli get-queue-attributes --queue-url "$url/Records" --attribute-names ApproximateNumberOfMessages | jq -r .Attributes.ApproximateNumberOfMessages)"
sqs_cli send-message --queue-url "$url/Orders" --message-body poison >/dev/null
received Orders --visibility-timeout 0 >/dev/null
received Orders --visibility-timeout 0 >/dev/null
check "a message received as often as its queue's redrive policy allows goes to its dead-letter queue" "0 poison 1" \
  "$(received Orders | jq -s 'map(.Messages | length) | add // 0') \
$(received Dead --visibility-timeout 0 | jq -r '.Messages[0] | "\(.Body) \(.Attributes.ApproximateReceiveCount)"')"
AWS_ACCESS_KEY_ID=AKFFNOTTHELOCALKEY00 AWS_SECRET_ACCESS_KEY=not-the-secret AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_REGION=tn-tunis-1 AWS_ENDPOINT_URL_SQS="http://127.0.0.1:$port" "${aws_cli[@]}" sqs list-queues >/dev/null 2>"$work/sqs.err" || true
check "a request signed with another key is refused in SQS's words, the key said on stderr" "true true" \
  "$(grep -F 'An error occurred (InvalidClientTokenId) when calling the ListQueues operation: The security token included in the request is invalid.' "$work/sqs.err" >/dev/null && echo true || echo false) \
$(grep -F "A request signed with AKFFNOTTHELOCALKEY00, not the local key $key_id" "$work/queues.err" >/dev/null && echo true || echo false)"
sqs_cli purge-queue --queue-url "$url/Dead"
curl -s -o "$work/sender.json" -X POST "http://127.0.0.1:$port/2015-03-31/functions/Sender/invocations" -d '{"body": "from a function"}'
check "a function sends to its queue with no setting, through the endpoint, the region and the key it is given" \
  "true from a function true" \
  "$(jq -r 'has("MessageId")' "$work/sender.json") \
$(received Orders --wait-time-seconds 2 | jq -r --arg key "$key_id" '.Messages[0] | "\(.Body) \(.Attributes.SenderId == $key)"')"
curl -s -o /dev/null -X POST -H 'X-Amz-Invocation-Type: Event' "http://127.0.0.1:$port/2015-03-31/functions/Failing/invocations" -d '{"n": 1}'
received Records --wait-time-seconds 20 >"$work/record.json"
received Dead --wait-time-seconds 20 >"$work/dead.json"
check "an asynchronous call that failed: its record in its OnFailure queue, sent by the function" \
  "RetriesExhausted 1 arn:aws:lambda:tn-tunis-1:000000000000:function:Failing" \
  "$(jq -r '.Messages[0] | (.Body | fromjson | "\(.requestContext.condition) \(.requestPayload.n)") + " " + .Attributes.SenderId' "$work/record.json")"
check "  ... and its event in its dead-letter queue, with its request ID, the status and the error, as Lambda sends it" \
  '1 200 no luck true' \
  "$(jq -r '.Messages[0] | "\(.Body | fromjson | .n) \(.MessageAttributes.ErrorCode.StringValue) \(.MessageAttributes.ErrorMessage.StringValue) \(.MessageAttributes.RequestID.StringValue | test("^[0-9a-f-]{36}$"))"' "$work/dead.json")"
check "the start lists a function's SQS event: its queue, its batches and window, its failures reported" "true true" \
  "$(grep -F "Its SQS events, each reading its queue while it runs, as FF's event source mappings:" "$work/queues.out" >/dev/null && echo true || echo false) \
$(grep -E '^  Reader/Work +Jobs: batches of 10 within 1 s, ReportBatchItemFailures$' "$work/queues.out" >/dev/null && echo true || echo false)"
cat >"$work/jobs.json" <<'JSON'
[
  {"Id": "one", "MessageBody": "ok-1", "MessageAttributes": {"source": {"DataType": "String", "StringValue": "aws-cli"}},
   "MessageSystemAttributes": {"AWSTraceHeader": {"DataType": "String", "StringValue": "Root=1-5759e988-bd862e3fe1be46a994272793"}}},
  {"Id": "two", "MessageBody": "fail"},
  {"Id": "three", "MessageBody": "ok-2"}
]
JSON
sqs_cli send-message-batch --queue-url "$url/Jobs" --entries "file://$work/jobs.json" >/dev/null
# Its message named as failed comes back after the queue's 3 s, fails again, and goes to JobsDead at the next receive.
received JobsDead --wait-time-seconds 20 >"$work/jobs-dead.json"
records() { sed -n 's/^.*record //p' "$app/.ff/local/logs/Reader.log"; }
check "a function's SQS event reads its queue: the three messages in one batch, as Lambda's SQS event gives them" \
  "batch of 3|ok-1 fail ok-2|aws:sqs arn:aws:sqs:tn-tunis-1:000000000000:Jobs tn-tunis-1 1|aws-cli String Root=1-5759e988-bd862e3fe1be46a994272793 true" \
  "$(grep -m1 -o 'batch of [0-9]*' "$app/.ff/local/logs/Reader.log")|$(records | head -3 | jq -r .body | paste -sd' ')|\
$(records | head -1 | jq -r '"\(.eventSource) \(.eventSourceARN) \(.awsRegion) \(.attributes.ApproximateReceiveCount)"')|\
$(records | head -1 | jq -r --arg key "$key_id" '"\(.messageAttributes.source.stringValue) \(.messageAttributes.source.dataType) \(.attributes.AWSTraceHeader) \(.attributes.SenderId == $key)"')"
check "  ... the message its answer names comes back after the visibility timeout, alone, the others deleted" \
  "fail 2|0 0" \
  "$(records | sed -n 4p | jq -r '"\(.body) \(.attributes.ApproximateReceiveCount)"')|\
$(sqs_cli get-queue-attributes --queue-url "$url/Jobs" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  | jq -r '.Attributes | "\(.ApproximateNumberOfMessages) \(.ApproximateNumberOfMessagesNotVisible)"')"
check "  ... and, received as often as the queue's redrive policy allows, goes to its dead-letter queue" "fail 4" \
  "$(jq -r '.Messages[0].Body' "$work/jobs-dead.json") $(records | wc -l | tr -d ' ')"
local_stopped
check "Ctrl-C removes their containers" 0 "$(leftover)"
}
section_def local_queues section_local_queues backend budget=45

section_local_buckets() {
section "ff local start's buckets: S3 at the front door, the AWS CLI's cases of L4, objects as files kept from a start to the next, a function writing to its bucket, their events to a function and a queue, a site from its objects or a folder"
local app="$work/buckets" port starter key_id described kept_file queue_url pages
local photos_line="^  photos +.*/\\.ff/local/buckets/photos, its events to Uploads, Thumbs$"
# s3_cli <args...>: the AWS CLI with the local key's file alone, the front door its S3 endpoint.
s3_cli() { local_aws "$app" "$port" "$@"; }
# s3_refused <args...>: an AWS CLI command's error, by the code it names.
s3_refused() { s3_cli "$@" >/dev/null 2>"$work/s3.err" && echo accepted || grep -m1 -oE 'An error occurred \([A-Za-z0-9.]+\)' "$work/s3.err"; }
# page <path> [curl args...]: a visit to the site pages, its status and its answer; `| sed -n '1s/ .*//p'` its status alone.
page() {
  local path="$1"
  shift
  curl -s -o "$work/page.body" -w '%{http_code}' "$@" "http://pages.site.localhost:$port$path"
  echo " $(cat "$work/page.body")"
}
# started [args...]: ff local start in the background, its listing waited for.
started() { local_started "$work/buckets.out" "$work/buckets.err" "$app/template.yaml" --port "$port" "$@"; }
rm -rf "$app" && mkdir -p "$app/writer"
cat >"$app/template.yaml" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Photos:
    Type: AWS::S3::Bucket
    Properties:
      NotificationConfiguration:
        QueueConfigurations:
          - Event: s3:ObjectRemoved:*
            Queue: !GetAtt Uploads.Arn
  Uploads:
    Type: AWS::SQS::Queue
  Pages:
    Type: AWS::S3::Bucket
    Properties:
      WebsiteConfiguration:
        IndexDocument: index.html
        ErrorDocument: 404.html
  Writer:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: writer/
      Runtime: python3.13
      Handler: app.handler
      Timeout: 10
      Environment:
        Variables:
          BUCKET: !Ref Photos
  Thumbs:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: writer/
      Runtime: python3.13
      Handler: app.seen
      Timeout: 10
      Environment:
        Variables:
          BUCKET: !Ref Photos
      Events:
        Upload:
          Type: S3
          Properties:
            Bucket: !Ref Photos
            Events: s3:ObjectCreated:*
            Filter:
              S3Key:
                Rules:
                  - Name: prefix
                    Value: images/
YAML
# A function that writes to its bucket as an SDK would, with no setting: at the bucket's own host under the endpoint
# FF gives it, its request signed by hand, as the runtime images have no SDK; and one that keeps the event an image's
# upload sent it, in the bucket, under a prefix its notification doesn't name.
cp "$FF_REPO_ROOT/hack/lib/local-functions/signed.py" "$app/writer/"
cat >"$app/writer/app.py" <<'PY'
import json
import os

from signed import send


def put(key, body, content_type):
    scheme, authority = os.environ["AWS_ENDPOINT_URL_S3"].split("://")
    url = f"{scheme}://{os.environ['BUCKET']}.{authority}/{key}"
    return send("s3", "PUT", url, body, {"content-type": content_type})


def handler(event, context):
    with put("from-a-function.txt", event["body"].encode(), "text/plain") as answer:
        return {"status": answer.status, "etag": answer.headers["ETag"]}


def seen(event, context):
    with put("seen/event.json", json.dumps(event).encode(), "application/json") as answer:
        return answer.status
PY
mkdir -p "$app/pages-folder"
printf '<h1>From the folder</h1>' >"$app/pages-folder/index.html"

port="$(free_port)"
started
key_id="$(sed -n 's/^aws_access_key_id = //p' "$app/.ff/local/credentials")"
check "the start lists the template's bucket and the folder its objects are files in" "true true" \
  "$(grep -F "Its buckets, S3's at http://127.0.0.1:$port, each object a file in its bucket's folder, kept from a start to the next:" "$work/buckets.out" >/dev/null && echo true || echo false) \
$(grep -E "$photos_line" "$work/buckets.out" >/dev/null && echo true || echo false)"
check "the AWS CLI lists them and finds one, with the local key" "photos pages accepted" \
  "$(s3_cli s3 ls | awk '{print $3}' | paste -sd' ') $(s3_refused s3api head-bucket --bucket photos)"
check "aws: s3api reads a bucket's notifications and website as the template sets them, and refuses a website it hasn't" \
  "PhotosQueue1 s3:ObjectRemoved:* ThumbsUpload arn:aws:lambda:tn-tunis-1:000000000000:function:Thumbs images/ index.html 404.html An error occurred (NoSuchWebsiteConfiguration)" \
  "$(s3_cli s3api get-bucket-notification-configuration --bucket photos --output json \
    | jq -r '[.QueueConfigurations[0].Id, .QueueConfigurations[0].Events[0], .LambdaFunctionConfigurations[0].Id, .LambdaFunctionConfigurations[0].LambdaFunctionArn, .LambdaFunctionConfigurations[0].Filter.Key.FilterRules[0].Value] | join(" ")') \
$(s3_cli s3api get-bucket-website --bucket pages --output json | jq -r '"\(.IndexDocument.Suffix) \(.ErrorDocument.Key)"') \
$(s3_refused s3api get-bucket-website --bucket photos)"

head -c $((100 * 1024 * 1024)) /dev/urandom >"$work/big.bin"
s3_cli s3 cp "$work/big.bin" s3://photos/cli/big.bin --only-show-errors
s3_cli s3 cp s3://photos/cli/big.bin "$work/big.out" --only-show-errors
check "aws: 100 MB up in parts and down again, byte for byte" "104857600 0" \
  "$(s3_cli s3api head-object --bucket photos --key cli/big.bin --query ContentLength --output text) $(cmp -s "$work/big.bin" "$work/big.out"; echo $?)"
described="$(jq -r 'select(.key == "cli/big.bin") | input_filename' "$app"/.ff/local/buckets/photos/*.object.json)"
kept_file="$app/.ff/local/buckets/photos/$(jq -r .file "$described")"
check "  ... a file in its bucket's folder, its key's extension kept, its key and its parts in the file beside it, no part left" \
  "0 bin cli/big.bin true 0" \
  "$(cmp -s "$work/big.bin" "$kept_file"; echo $?) ${kept_file##*.} $(jq -r '"\(.key) \(.parts | length > 1)"' "$described") \
$(find "$app/.ff/local/buckets/photos/.uploads" -type f 2>/dev/null | wc -l | tr -d ' ')"
s3_cli s3api get-object --bucket photos --key cli/big.bin --range bytes=0-9 "$work/range.out" >/dev/null
check "aws: a range" "$(head -c 10 "$work/big.bin" | od -An -tx1 | tr -d ' \n')" "$(od -An -tx1 "$work/range.out" | tr -d ' \n')"
rm -rf "$work/site" "$work/site-back"
mkdir -p "$work/site/css" "$work/site-back"
printf '<h1>Ahlan</h1>' >"$work/site/index.html"
printf 'body {}' >"$work/site/css/main.css"
s3_cli s3 sync "$work/site" s3://photos/site --only-show-errors
s3_cli s3 sync s3://photos/site "$work/site-back" --only-show-errors
check "aws: a folder synced up, listed, and down again, the same" "2 0" \
  "$(s3_cli s3 ls s3://photos/site/ --recursive | wc -l | tr -d ' ') $(diff -r "$work/site" "$work/site-back" >/dev/null; echo $?)"
presigned="$(s3_cli s3 presign s3://photos/site/index.html --expires-in 300)"
expiring="$(s3_cli s3 presign s3://photos/site/index.html --expires-in 1)"
sleep 2
check "aws: a presigned URL, fetched; one past its expiry, AccessDenied" "<h1>Ahlan</h1> 403 AccessDenied" \
  "$(curl -s "$presigned") $(curl -s -o "$work/expired" -w '%{http_code}' "$expiring") $(grep -o '<Code>[^<]*' "$work/expired" | cut -c7-)"
s3_cli s3 cp s3://photos/site/index.html s3://photos/copied/index.html --only-show-errors
check "aws: an object copied, then the folder's two deleted in one request" "<h1>Ahlan</h1> 2 0" \
  "$(s3_cli s3 cp s3://photos/copied/index.html - 2>/dev/null) \
$(s3_cli s3api delete-objects --bucket photos --delete '{"Objects": [{"Key": "site/index.html"}, {"Key": "site/css/main.css"}]}' | jq '.Deleted | length') \
$(s3_cli s3 ls s3://photos/site/ --recursive | wc -l | tr -d ' ')"
queue_url="http://127.0.0.1:$port/000000000000/Uploads"
local_aws "$app" "$port" sqs receive-message --queue-url "$queue_url" --max-number-of-messages 10 \
  --attribute-names SenderId --output json >"$work/uploads.json"
check "a removal's event goes to the queue the bucket's notification names, S3's record from the bucket, after S3's test event at the start" \
  "ObjectRemoved:Delete site%2Fcss%2Fmain.css, ObjectRemoved:Delete site%2Findex.html, s3:TestEvent arn:aws:s3:::photos" \
  "$(jq -r '[.Messages[].Body | fromjson | .Event // (.Records[0].eventName + " " + .Records[0].s3.object.key)] | sort | join(", ")' "$work/uploads.json") \
$(jq -r '[.Messages[].Attributes.SenderId] | unique | join(" ")' "$work/uploads.json")"
printf 'meow!' | s3_cli s3 cp - "s3://photos/images/red cat.jpg" --only-show-errors
for _ in $(seq 1 60); do
  s3_cli s3 cp s3://photos/seen/event.json "$work/seen.json" --only-show-errors 2>/dev/null && break
  sleep 0.5
done
check "an image's upload calls the function its notification names, with S3's record, its key form-encoded" \
  "ObjectCreated:Put images%2Fred+cat.jpg 5 ThumbsUpload photos" \
  "$(jq -r '.Records[0] | "\(.eventName) \(.s3.object.key) \(.s3.object.size) \(.s3.configurationId) \(.s3.bucket.name)"' "$work/seen.json" 2>/dev/null)"
check "aws: a wrong secret, SignatureDoesNotMatch" "An error occurred (SignatureDoesNotMatch)" \
  "$(AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY=wrong-secret s3_refused s3 ls s3://photos)"
AWS_ACCESS_KEY_ID=AKFFNOTTHELOCALKEY00 AWS_SECRET_ACCESS_KEY=not-the-secret AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_REGION=tn-tunis-1 AWS_ENDPOINT_URL_S3="http://127.0.0.1:$port" "${aws_cli[@]}" s3 ls s3://photos >/dev/null 2>"$work/s3.err" || true
check "  ... another key, InvalidAccessKeyId, the key said on stderr" "true true" \
  "$(grep -F 'An error occurred (InvalidAccessKeyId)' "$work/s3.err" >/dev/null && echo true || echo false) \
$(grep -F "A request signed with AKFFNOTTHELOCALKEY00, not the local key $key_id" "$work/buckets.err" >/dev/null && echo true || echo false)"
check "aws: a bucket the template hasn't, NoSuchBucket; one made or deleted, refused as the template's to make" \
  "An error occurred (NoSuchBucket) An error occurred (NotImplemented) An error occurred (NotImplemented)" \
  "$(s3_refused s3 ls s3://nowhere) $(s3_refused s3 mb s3://more) $(s3_refused s3 rb s3://photos)"
check "aws: s3api reads a bucket's settings it hasn't as S3 answers a bucket without them: the owner paying, versioning never on" \
  "BucketOwner never" \
  "$(s3_cli s3api get-bucket-request-payment --bucket photos --query Payer --output text) \
$(s3_cli s3api get-bucket-versioning --bucket photos --query "Status || 'never'" --output text)"
curl -s -o "$work/writer.json" -X POST "http://127.0.0.1:$port/2015-03-31/functions/Writer/invocations" -d '{"body": "from a function"}'
check "a function writes to its bucket with no setting, at the bucket's host under the endpoint it is given, with its key" \
  "200 from a function" \
  "$(jq -r .status "$work/writer.json") $(s3_cli s3 cp s3://photos/from-a-function.txt - 2>/dev/null)"
printf '<h1>Pages</h1>' | s3_cli s3 cp - s3://pages/index.html --content-type text/html --only-show-errors
printf '<h1>Not here</h1>' | s3_cli s3 cp - s3://pages/404.html --content-type text/html --only-show-errors
check "the start lists the site at its address; a browser gets the index document there, the error document with 404, and 405 for a POST" \
  "true 200 <h1>Pages</h1> 404 <h1>Not here</h1> 405" \
  "$(grep -E "^  pages +http://pages\.site\.localhost:$port/, its objects$" "$work/buckets.out" >/dev/null && echo true || echo false) \
$(page /) $(page /no/such/page) $(page / -X POST | sed -n '1s/ .*//p')"
s3_cli s3 ls s3://photos --recursive | awk '{print $3, $4}' | sort >"$work/listed"
local_stopped
check "Ctrl-C removes the functions' containers" 0 "$(leftover)"
started --site "pages=$app/pages-folder"
pages="$(cd "$app/pages-folder" && pwd -P)"
check "the objects are kept from a start to the next: listed the same, read the same" "true 0" \
  "$(s3_cli s3 ls s3://photos --recursive | awk '{print $3, $4}' | sort | cmp -s - "$work/listed" && echo true || echo false) \
$(s3_cli s3 cp s3://photos/cli/big.bin - 2>/dev/null | cmp -s - "$work/big.bin"; echo $?)"
first="$(page /)"
printf '<h1>Changed in the folder</h1>' >"$app/pages-folder/index.html"
check "--site: the site answers a folder's files, a change seen at once without a copy, the bucket's objects as they were" \
  "true 200 <h1>From the folder</h1> 200 <h1>Changed in the folder</h1> 404 <h1>Pages</h1>" \
  "$(grep -F "  pages  http://pages.site.localhost:$port/, $pages's files" "$work/buckets.out" >/dev/null && echo true || echo false) \
$first $(page /) $(page /404.html | sed -n '1s/ .*//p') $(s3_cli s3 cp s3://pages/index.html - 2>/dev/null)"
local_stopped
rm -rf "$work/big.bin" "$work/big.out" "$app/.ff/local/buckets"
}
section_def local_buckets section_local_buckets backend budget=45

section_local_data() {
section "ff local start --with postgres,valkey: each beside the functions at its name and its variable, reached from this machine at its port, its data kept in Docker's volumes from a start to the next, a second start refused, ff local reset --data removing them"
local app="$work/data" port starter project before
local postgres_image valkey_image
postgres_image="$(local_image postgres)"
valkey_image="$(local_image valkey/valkey)"
[ -n "$postgres_image" ] && [ -n "$valkey_image" ] || fail "the images of cli/src/local/services.rs weren't found"
volumes() { docker volume ls --quiet --filter "label=ff.local.project=$project" | wc -l | tr -d ' '; }
url_of() { local_url "$work/data.out" "$1"; }
psql_here() { local_psql "$work/data.out" "$1"; }
valkey_here() { docker run --rm --network host "$valkey_image" valkey-cli --no-auth-warning -u "$(url_of valkey)" "$@" 2>&1; }
# started [args...]: ff local start in the background with both, its listing waited for: a first start pulls the
# images and makes the data.
started() {
  local_started "$work/data.out" "$work/data.err" "$app/template.yaml" --port "$port" --with postgres,valkey "$@"
}
rm -rf "$app" && mkdir -p "$app/probe"
project="$(cd "$app" && pwd -P)"
cat >"$app/template.yaml" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Probe:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: probe/
      Runtime: python3.13
      Handler: app.handler
      Timeout: 10
YAML
# A function that finds each service at its variable and reaches it at its name: PostgreSQL's answer to a TLS request,
# and Valkey's to its password and a PING; the runtime images have no driver.
cat >"$app/probe/app.py" <<'PY'
import os
import socket
from urllib.parse import urlsplit


def handler(event, context):
    database, cache = urlsplit(os.environ["DATABASE_URL"]), urlsplit(os.environ["REDIS_URL"])
    with socket.create_connection((database.hostname, database.port), timeout=5) as connection:
        connection.sendall((8).to_bytes(4, "big") + (80877103).to_bytes(4, "big"))
        tls = connection.recv(1).decode()
    with socket.create_connection((cache.hostname, cache.port), timeout=5) as connection:
        connection.sendall(f"AUTH {cache.username} {cache.password}\r\nPING\r\n".encode())
        answer = b""
        while answer.count(b"\r\n") < 2:
            answer += connection.recv(64)
    return f"{database.hostname}:{database.port}{database.path} {tls} {cache.hostname}:{cache.port} {' '.join(answer.decode().split())}"
PY
port="$(free_port)"
started
check "the start lists each service at its URL here, with its password, where the functions reach it, and their variable" "true true" \
  "$(grep -E "^  postgres  postgresql://app:[A-Za-z0-9]{32}@127\.0\.0\.1:[0-9]+/app, at postgres:5432 from the functions, the functions' DATABASE_URL$" "$work/data.out" >/dev/null && echo true || echo false) \
$(grep -E "^  valkey    redis://default:[A-Za-z0-9]{32}@127\.0\.0\.1:[0-9]+, at valkey:6379 from the functions, the functions' REDIS_URL$" "$work/data.out" >/dev/null && echo true || echo false)"
check "a function finds each at its variable and reaches it at its name: PostgreSQL answering, Valkey taking its password" \
  '"postgres:5432/app N valkey:6379 +OK +PONG"' \
  "$(curl -s -d '{}' "http://127.0.0.1:$port/2015-03-31/functions/Probe/invocations")"
check "this machine reaches each at its port with its password, and Valkey refuses a client without it" "1 OK NOAUTH" \
  "$(psql_here "create table kept (word text); insert into kept values ('first'); select count(*) from kept") \
$(valkey_here set word kept) \
$(docker run --rm --network host "$valkey_image" valkey-cli -p "$(url_of valkey | sed 's/.*://')" ping 2>&1 | grep -o NOAUTH)"
ff local start "$app/template.yaml" --port "$(free_port)" --with postgres
check "a second start of the project is refused while the first runs its data, the container named" \
  "3 another ff local start of this project runs it" \
  "$(code) $(err | grep -o 'another ff local start of this project runs it')"
before="$(url_of postgres)"
local_stopped
check "Ctrl-C removes the containers, the functions' and the services', and keeps their volumes" "0 2" "$(leftover) $(volumes)"
started
check "the data is kept from a start to the next, at the same URL" "first kept true" \
  "$(psql_here "select word from kept") $(valkey_here get word) $([ "$(url_of postgres)" = "$before" ] && echo true || echo false)"
local_stopped
ff local reset "$project" --yes
started
check "ff local reset leaves the data: the next start makes another password, and reads the data with it" "true first kept" \
  "$([ "$(url_of postgres | sed 's/@.*//')" != "$(printf '%s' "$before" | sed 's/@.*//')" ] && echo true || echo false) \
$(psql_here "select word from kept") $(valkey_here get word)"
local_stopped
ff local reset "$project" --data --yes
check "ff local reset --data removes the volumes, naming them" "0 2 0" \
  "$(code) $(out | grep -o "Docker's volume ff-local-data-[0-9a-f]*-[a-z]*" | wc -l | tr -d ' ') $(volumes)"
}
section_def local_data section_local_data backend budget=90

section_local_mail() {
section "ff local start's mail: SES v2's SendEmail at the front door, the AWS CLI's cases of L4 and a function's, each message kept as a file a mail reader opens, its Bcc in its envelope alone, said, listed by ff local mail, refused in FF's words, never sent"
local app="$work/mail" port starter sent_id function_id raw_id
local simple='{"Simple": {"Subject": {"Data": "Your order"}, "Body": {"Text": {"Data": "Thanks for your order."}}}}'
local to_orders='{"ToAddresses": ["orders@example.tn"]}'
# ses_cli <args...>: the AWS CLI's sesv2 with the local key's file alone, the front door its SES endpoint.
ses_cli() { local_aws "$app" "$port" sesv2 "$@"; }
# ses_refused <args...>: the error the CLI prints, its name and FF's words.
ses_refused() { ses_cli "$@" >/dev/null 2>"$work/ses.err" && echo accepted || grep -m1 -oE 'An error occurred .*' "$work/ses.err"; }
# kept <message ID> <extension>: the message's file, or its envelope's.
kept() { printf '%s\n' "$app"/.ff/local/mail/*-"$1.$2"; }
# started: ff local start in the background, its listing waited for.
started() { local_started "$work/mail.out" "$work/mail.err" "$app/template.yaml" --port "$port"; }
rm -rf "$app" && mkdir -p "$app/sender"
cat >"$app/template.yaml" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Sender:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: sender/
      Runtime: python3.13
      Handler: app.handler
      Timeout: 10
YAML
# A function that sends a receipt as an SDK would, with no setting: to the SES endpoint FF gives it, signed by hand, as
# the runtime images have no SDK.
cp "$FF_REPO_ROOT/hack/lib/local-functions/signed.py" "$app/sender/"
cat >"$app/sender/app.py" <<'PY'
import json
import os

from signed import send


def handler(event, context):
    body = json.dumps({
        "FromEmailAddress": "Boutique Ana <orders@shop.example.tn>",
        "Destination": {"ToAddresses": [event["to"]]},
        "Content": {"Simple": {"Subject": {"Data": event["subject"]},
                               "Body": {"Text": {"Data": "Merci"}, "Html": {"Data": "<p>Merci</p>"}}}},
    }).encode()
    url = f"{os.environ['AWS_ENDPOINT_URL_SESV2']}/v2/email/outbound-emails"
    with send("ses", "POST", url, body, {"content-type": "application/json"}) as answer:
        return json.load(answer)["MessageId"]
PY

port="$(free_port)"
started
check "the start says where its mail is kept, never sent" true \
  "$(grep -E "^Its mail, SES v2's SendEmail at http://127\.0\.0\.1:$port, is kept in .*/\.ff/local/mail, never sent: ff local mail lists it$" "$work/mail.out" >/dev/null && echo true || echo false)"

sent_id="$(ses_cli send-email --from-email-address 'Shop <news@shop.example.tn>' \
  --destination '{"ToAddresses": ["orders@example.tn"], "CcAddresses": ["copy@example.tn"], "BccAddresses": ["Audit@Example.TN"]}' \
  --content "$simple" --output json | jq -r .MessageId)"
check "the AWS CLI sends L4's message with the local key, a Cc and a Bcc: SES's MessageId" true \
  "$([[ $sent_id =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false)"
check "  ... kept: its envelope names its sender and each recipient, in lower case, the Bcc too; its file has no Bcc, its ID the message's" \
  "news@shop.example.tn orders@example.tn,copy@example.tn,audit@example.tn Your order 0 true" \
  "$(jq -r '"\(.from) \(.recipients | join(",")) \(.subject)"' "$(kept "$sent_id" json)") $(grep -c '^Bcc:' "$(kept "$sent_id" eml)" || true) \
$(grep -F "Message-ID: <$sent_id@email.localhost>" "$(kept "$sent_id" eml)" >/dev/null && echo true || echo false)"
check "  ... said on ff local start's stderr, with its file" true \
  "$(grep -E "^A message from news@shop\.example\.tn to orders@example\.tn, copy@example\.tn, audit@example\.tn, \"Your order\", kept in .*/\.ff/local/mail/[0-9TZ]+-$sent_id\.eml, not sent$" "$work/mail.err" >/dev/null && echo true || echo false)"

function_id="$(curl -s -d '{"to": "client@example.tn", "subject": "Votre reçu n° 42"}' "http://127.0.0.1:$port/2015-03-31/functions/Sender/invocations" | jq -r .)"
check "a function sends a receipt at the SES endpoint FF gives it, which a mail reader opens: its subject decoded, both bodies" \
  "Boutique Ana <orders@shop.example.tn> | client@example.tn | Votre reçu n° 42 | multipart/alternative | Merci" \
  "$(read_mail "$(kept "$function_id" eml)" 2>&1)"

printf 'From: Shop <news@shop.example.tn>\r\nTo: orders@example.tn\r\nBcc: audit@example.tn\r\nSubject: Raw\r\nMessage-ID: <raw-local@shop.example.tn>\r\n\r\nHello from a raw message.\r\n' >"$work/raw.eml"
printf 'From: Shop <news@shop.example.tn>\r\nTo: orders@example.tn\r\nSubject: Raw\r\nMessage-ID: <raw-local@shop.example.tn>\r\n\r\nHello from a raw message.\r\n' >"$work/raw-without-bcc.eml"
raw_id="$(ses_cli send-email --content "{\"Raw\": {\"Data\": \"$(base64 -w0 "$work/raw.eml")\"}}" --output json | jq -r .MessageId)"
check "a raw message, its sender and recipients from its header, the Bcc's too: kept as it came but its Bcc field" \
  "news@shop.example.tn orders@example.tn,audit@example.tn 0" \
  "$(jq -r '"\(.from) \(.recipients | join(","))"' "$(kept "$raw_id" json)") $(cmp -s "$work/raw-without-bcc.eml" "$(kept "$raw_id" eml)"; echo $?)"

check "a sender of two addresses is refused in FF's words, a template as FF refuses it, and nothing kept" \
  "An error occurred (BadRequestException) when calling the SendEmail operation: a@shop.example.tn, b@shop.example.tn is not one address|An error occurred (NotImplemented) when calling the SendEmail operation: FF's SES endpoint doesn't send templates: send Simple or Raw content|3" \
  "$(ses_refused send-email --from-email-address 'a@shop.example.tn, b@shop.example.tn' --destination "$to_orders" --content "$simple")|$(ses_refused send-email --from-email-address news@shop.example.tn --destination "$to_orders" --content '{"Template": {"TemplateName": "receipt"}}')|$(find "$app/.ff/local/mail" -name '*.eml' | wc -l | tr -d ' ')"
check "FF's account's operations are FF's: ff local says so" \
  "An error occurred (NotImplemented) when calling the GetAccount operation: ff local keeps the mail its functions send, and answers SendEmail alone: GetAccount is FF's, whose account has identities, quotas and a suppression list" \
  "$(ses_refused get-account)"
local_stopped

ff local mail "$app"
check "ff local mail lists them once the app has stopped, the latest last, each with its file" \
  "0 3 messages kept in true|Raw" \
  "$(code) $(out | head -1 | grep -oE '^3 messages kept in') $(out | head -1 | grep -E "/\.ff/local/mail, never sent, the latest last:$" >/dev/null && echo true || echo false)|$(out | sed -n '6s/.*: "\(.*\)", [0-9]* bytes$/\1/p')"
ff local mail "$app/template.yaml" --output json
check "  ... and as JSON, by the template too: each message's subject, its recipients and its file" \
  "Your order|Votre reçu n° 42|Raw 3 true" \
  "$(out | jq -r '[.messages[].subject] | join("|")') $(out | jq -r '.messages[0].recipients | length') $([ -f "$(out | jq -r '.messages[2].file')" ] && echo true || echo false)"
ff local reset "$app" --yes
ff local mail "$app"
check "ff local reset removes the mail with what ff local keeps, and ff local mail says there is none; no container left" \
  "0 true 0" \
  "$(code) $(out | grep -E '^No mail in .*/\.ff/local/mail: ' >/dev/null && echo true || echo false) $(leftover)"
}
section_def local_mail section_local_mail backend budget=20

section_local_small_app() {
section "the small app whole on ff local, with --with postgres,valkey: its page served, an order posted at its URL kept in PostgreSQL, the latest listed from Valkey, its receipt made through the local queue into the local bucket and e-mailed, the mail kept; the nightly run by hand removing an old order and its receipt"
# The small app local_apps installed, started again with its database, its cache and an address its receipts go from.
local shop="$work/cli-local-shop" port starter origin api order old put report
volumes() { docker volume ls --quiet --filter "label=ff.local.project=$(cd "$shop" && pwd -P)" | wc -l | tr -d ' '; }
x_cache() { at "$api/orders" >/dev/null; sed -n 's/^x-cache: //Ip' "$work/at.head" | tr -d '\r'; }
# until_true <command...>: waits up to 30 s for the command to succeed.
until_true() {
  for _ in $(seq 1 60); do
    "$@" && return 0
    sleep 0.5
  done
  return 1
}
receipt_of() { [ "$(at "$api/orders/$1/receipt" | sed -n '1s/ .*//p')" = "$2" ]; }
mailed() { "$ff_bin" local mail "$shop" --output json 2>/dev/null | jq -e '.messages | length > 0' >/dev/null; }
reported() { grep -F 'shop-nightly | ' "$work/small.err" | grep -F 'report {' >/dev/null; }
[ -d "$shop/node_modules" ] || fail "the small app isn't installed in $shop: local_apps installs it"
port="$(free_port)"
origin="http://local-site.site.localhost:$port"
api="http://shop-api.fn.localhost:$port"
printf '{"api": "%s"}\n' "$api" >"$shop/site/config.json"
FF_TEST_ASYNC_SECOND_MS=20 FF_TEST_NOW=2026-11-10T12:00:00Z \
  local_started "$work/small.out" "$work/small.err" "$shop/template.yaml" --port "$port" --with postgres,valkey \
  --site "local-site=$shop/site" --parameter-overrides ReceiptsBucketName=local-receipts SiteBucketName=local-site \
  "SiteOrigin=$origin" ReceiptsFrom=receipts@shop.example.tn
check "the small app starts with its database and its cache, each the functions' at DATABASE_URL and REDIS_URL" "true true" \
  "$(grep -E "^  postgres  postgresql://app:[^@]+@127\.0\.0\.1:[0-9]+/app, at postgres:5432 from the functions, the functions' DATABASE_URL$" "$work/small.out" >/dev/null && echo true || echo false) \
$(grep -E "^  valkey    redis://default:[^@]+@127\.0\.0\.1:[0-9]+, at valkey:6379 from the functions, the functions' REDIS_URL$" "$work/small.out" >/dev/null && echo true || echo false)"
check "  ... its page served at its site's address from its folder, its config.json naming the API here" \
  "200 <title>Orders</title> $api" \
  "$(at "$origin/" | sed -n '1s/ .*//p') $(grep -o '<title>Orders</title>' "$work/at.body") $(at "$origin/config.json" >/dev/null; jq -r .api "$work/at.body")"

at "$api/orders" -X POST -H "Origin: $origin" -H 'content-type: application/json' \
  -d '{"item": "tea", "quantity": 2, "email": "client@example.tn"}' >"$work/order.out"
order="$(jq -r .id "$work/at.body")"
check "an order posted at the API's URL, as the page posts it, is kept in PostgreSQL, its receipt queued" "201 tea 2 queued" \
  "$(sed 's/ .*//' "$work/order.out") $(local_psql "$work/small.out" "select item, quantity from orders where id = $order" | tr '|' ' ') $(jq -r .receipt "$work/at.body")"
check "  ... the latest listed, from the database the first time, then from Valkey" "miss hit tea" \
  "$(x_cache) $(x_cache) $(jq -r '.[0].item' "$work/at.body")"
until_true receipt_of "$order" 200 || true
check "  ... its receipt made by shop-receipts from the local queue, into the local bucket, read back at its URL" \
  "200 Order $order|2 × tea true" \
  "$(at "$api/orders/$order/receipt" | sed -n '1s/ .*//p') $(head -2 "$work/at.body" | paste -sd'|') \
$(grep -lF "\"receipts/$order.txt\"" "$shop"/.ff/local/buckets/local-receipts/*.object.json >/dev/null 2>&1 && echo true || echo false)"
until_true mailed || true
ff local mail "$shop" --output json
check "  ... and e-mailed from ReceiptsFrom to the order's address through the SES endpoint FF gives it: kept, never sent" \
  "1 receipts@shop.example.tn client@example.tn Your receipt, order $order true" \
  "$(out | jq -r '.messages | length') $(out | jq -r '.messages[0] | "\(.from) \(.recipients | join(",")) \(.subject)"') \
$(read_mail "$(out | jq -r '.messages[0].file')" | grep -F "2 × tea" >/dev/null && echo true || echo false)"

# An order of last July and its receipt, which the nightly of 10 November removes, past 90 days.
old="$(local_psql "$work/small.out" "insert into orders (item, quantity, created_at) values ('old', 1, '2026-07-01T10:00:00Z') returning id")"
printf 'Order %s\n' "$old" >"$work/old-receipt.txt"
put="$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary "@$work/old-receipt.txt" "http://127.0.0.1:$port/local-receipts/receipts/$old.txt")"
x_cache >/dev/null
ff local run EveryNight "$shop"
until_true reported || true
report="$(grep -F 'shop-nightly | ' "$work/small.err" | sed -n 's/.*report \({.*}\)$/\1/p' | tail -1)"
check "ff local run runs the nightly with its database: the day before counted, the old order and its receipt removed" \
  "200 0 2026-11-09 1 1 404 0 miss" \
  "$put $(code) $(jq -r '"\(.day) \(.removed) \(.receipts)"' <<<"$report") $(at "$api/orders/$old/receipt" | sed -n '1s/ .*//p') \
$(local_psql "$work/small.out" "select count(*) from orders where id = $old") $(x_cache)"
local_stopped
ff local reset "$shop" --data --yes
check "Ctrl-C removes the containers, and ff local reset --data the database's and the cache's volumes" "0 0 0" \
  "$(leftover) $(code) $(volumes)"
}
section_def local_small_app section_local_small_app local_apps budget=90

section_local_images() {
section "ff local's runtime images as a release pins them: pulled by digest, else loaded from the downloads site, verified"
# The release job's steps with this machine's Python image, which hack/runtime-images.sh pushes to the dev registry
# rather than GitHub's, its archive signed with the release and put on a site FF serves (release_site). ff then runs
# with that release's settings, as a test build takes them.
local images="$work/images" minisign="${FF_TOOLS_BIN:-$FF_REPO_ROOT/hack/bin}/minisign" version
local registry="127.0.0.1:$FF_REGISTRY_PORT/cli-e2e" site
local manifest tagged by_digest archive digest key other_key
site="$(site_of cli-images)"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$FF_REPO_ROOT/cli/Cargo.toml" | head -1)"
rm -rf "$images" && mkdir -p "$images/dist"
"$FF_REPO_ROOT/hack/runtime-images.sh" "$registry" "$version" "$images/dist" --from-local --runtime python >"$images/made.out"
manifest="$(cat "$images/dist/runtime-images.json")"
tagged="$(jq -r '.python.image + ":" + .python.tag' <<<"$manifest")"
by_digest="$(jq -r '.python.image + "@" + .python.digest' <<<"$manifest")"
archive="$(jq -r .python.archive <<<"$manifest")"
digest="$(jq -r .python.digest <<<"$manifest")"
FF_RUNTIME_IMAGES="$manifest" release_site "$images" cli-images
"$minisign" -G -W -p "$images/other.pub" -s "$images/other.key" >/dev/null 2>&1
key="$(sed -n 2p "$images/release.pub")"
other_key="$(sed -n 2p "$images/other.pub")"
check "the release's image pushed, its archive signed and on the site FF serves" "true" \
  "$(curl -fsS -o /dev/null "$site/$archive.minisig" && echo true || echo false)"

# pinned [<manifest>] [<key>]: ff local invoke as the release's build runs it, examples/hello.py its function.
pinned() {
  FF_TEST_RUNTIME_IMAGES="${1:-$manifest}" FF_TEST_RELEASE_KEY="${2:-$key}" FF_DOWNLOADS_URL="$site" \
    ff local invoke "$FF_REPO_ROOT/examples/hello.py" --data '{"name": "Pinned"}'
}
said() { err | grep -F "$1" >/dev/null && echo true || echo false; }
here() { docker image inspect "$tagged" >/dev/null 2>&1 && echo true || echo false; }
downloads_left() { find "${TMPDIR:-/tmp}" -maxdepth 1 -name "ff-*-${archive#images/}" 2>/dev/null | wc -l | tr -d ' '; }
docker rmi "$tagged" >/dev/null
pinned
check "missing here, the release's image is pulled by its digest, tagged, and runs the function" "0 Hello Pinned true true" \
  "$(code) $(out | sed '$d' | jq -r .message) $(said "pulling the runtime image $by_digest") $(here)"
docker rmi "$tagged" >/dev/null
unpullable="$(jq -c --arg digest "sha256:$(printf '0%.0s' $(seq 1 64))" '.python.digest = $digest' <<<"$manifest")"
pinned "$unpullable"
check "when Docker can't pull it, its archive is downloaded from the site, verified, loaded, and runs it" \
  "0 Hello Pinned true true true true" \
  "$(code) $(out | sed '$d' | jq -r .message) $(said "its archive instead, from $site/$archive") $(said "downloading $site/$archive") $(said "loading $tagged") $(here)"
pinned "$unpullable"
check "  ... once: the next run finds it here" "0 false false" \
  "$(code) $(said "pulling") $(said "downloading")"
docker rmi "$tagged" >/dev/null
pinned "$unpullable" "$other_key"
check "an archive another key signed is refused, and nothing loaded" \
  "3 error: The runtime image's archive, $site/$archive: its signature: signed by another key than the one given; nothing was loaded false" \
  "$(code) $(err | grep '^error:') $(here)"
head -c 1048576 "$images/dist/$archive" >"$images/site/$archive"
ff sites deploy cli-images "$images/site"
pinned "$unpullable"
check "  ... and a changed one too" \
  "3 error: The runtime image's archive, $site/$archive: its signature: the signature doesn't match the file: it was changed, or another key signed it; nothing was loaded false" \
  "$(code) $(err | grep '^error:') $(here)"
check "the download is removed however it ends" 0 "$(downloads_left)"
# What the dev registry and this machine hold of it, removed: the tag here, the image there.
docker rmi "$tagged" >/dev/null 2>&1 || true
curl -fsS -o /dev/null -X DELETE "http://127.0.0.1:$FF_REGISTRY_PORT/v2/cli-e2e/ff-runtime-python/manifests/$digest" || true
}
section_def local_images section_local_images backend budget=60

section_ci() {
section "ff in a customer's CI: the examples' own steps, as GitHub Actions and GitLab CI run them, deploying a SAM app"
# Each example's steps, read from its file, run in a checkout of a customer's application (ff init --template sam's)
# with the settings it names: the downloads site of a release made here, which FF serves; the key the login section
# made with a deploy's scopes; the API that takes it. A home of their own, where install.sh puts ff, as a runner's.
# GitHub's steps run as its runner runs them, with bash, its PATH and summary files; GitLab's job as one script in sh,
# its image's packages this machine's, minisign among them, so that install.sh checks the signatures there.
local ci="$work/ci" site extra code steps
site="$(site_of cli-ci-downloads)"
rm -rf "$ci" && mkdir -p "$ci/github" "$ci/bin"
release_site "$ci/release" cli-ci-downloads
(cd "$ci" && "$ff_bin" init cli-ci --runtime nodejs --template sam >/dev/null 2>&1)
cp "${FF_TOOLS_BIN:-$FF_REPO_ROOT/hack/bin}/minisign" "$ci/bin/"
# The deploy job's run: blocks, each a script of its own, in order.
steps="$(awk -v out="$ci/github" '
  /^        run: \|$/ { n++; block = 1; next }
  block && /^          / { sub(/^          /, ""); print > (out "/step-" n ".sh"); next }
  { block = 0 }
  END { print n + 0 }' "$FF_REPO_ROOT/examples/ci/github-actions.yml")"
check "the downloads site serves both examples as examples/ci/ has them" "true true" \
  "$(curl -fsS "$site/ci/github-actions.yml" | cmp -s - "$FF_REPO_ROOT/examples/ci/github-actions.yml" && echo true || echo false) \
$(curl -fsS "$site/ci/gitlab-ci.yml" | cmp -s - "$FF_REPO_ROOT/examples/ci/gitlab-ci.yml" && echo true || echo false)"
check "the GitHub example's job takes FF_ENDPOINT, FF_DOWNLOADS_URL and FF_TOKEN, and runs two steps after the checkout" \
  "FF_ENDPOINT FF_DOWNLOADS_URL FF_TOKEN 2" \
  "$(awk '/^    env:$/ { env = 1; next } env && /^      [A-Z_]+:/ { sub(/:.*/, ""); sub(/^ +/, ""); print; next } { env = 0 }' \
    "$FF_REPO_ROOT/examples/ci/github-actions.yml" | paste -sd' ') $steps"
# github_job <key>: the steps in a fresh checkout and home, each with bash -eo pipefail as the runner runs it, the
# folders a step adds to GITHUB_PATH before PATH from the next step on; to the first that fails. The output in
# $ci/job.out, the exit code in $ci/job.code.
github_job() {
  local step=0
  code=0
  rm -rf "$ci/home" "$ci/app" && mkdir "$ci/home" && cp -r "$ci/cli-ci" "$ci/app"
  : >"$ci/github_path" && : >"$ci/summary.md" && : >"$ci/job.out"
  while [ "$step" -lt "$steps" ] && [ "$code" -eq 0 ]; do
    step=$((step + 1))
    extra="$(tac "$ci/github_path" | paste -sd:)"
    (cd "$ci/app" && env -i HOME="$ci/home" PATH="${extra:+$extra:}$PATH" GITHUB_PATH="$ci/github_path" \
      GITHUB_STEP_SUMMARY="$ci/summary.md" FF_ENDPOINT="$api_oidc" FF_DOWNLOADS_URL="$site" FF_TOKEN="$1" \
      bash --noprofile --norc -eo pipefail "$ci/github/step-$step.sh") >>"$ci/job.out" 2>&1 || code=$?
  done
  echo "$code" >"$ci/job.code"
}
job() { cat "$ci/job.out"; }
said_in_job() { job | grep -E "$1" >/dev/null && echo true || echo false; }
github_job "$ci_key"
check "GitHub's: ff installed from the downloads site into the runner's home, its SHA-256 checked, the app deployed" \
  "0 true true" \
  "$(cat "$ci/job.code") $(said_in_job "^ff [0-9.]+ installed as $ci/home/.local/bin/ff: its SHA-256 is latest.json's") \
$(said_in_job '^created HelloWorldFunction: ')"
url="$(sed -n 's/^- HelloWorldApi: //p' "$ci/summary.md")"
check "  ... its URL in the job's summary, where the app answers" "true hello world" \
  "$(grep -Fx '### Deployed to FF' "$ci/summary.md" >/dev/null && echo true || echo false) $(curl -s "${url%/}/hello" | jq -r .message)"
github_job "$ci_reader_key"
check "  ... and with a key that lacks a deploy's scopes, the job fails with ff's code, 6, the account's message its error" \
  "6 true" "$(cat "$ci/job.code") $(said_in_job '^::error title=FF refused the account \(exit 6\)::This API key lacks the scope ')"

# GitLab's: before_script's and script's lines, one script as the runner joins them, the image's apk line aside.
awk '
  /^  (before_script|script):$/ { list = 1; next }
  list && /^    - \|$/ { block = 1; next }
  list && block && /^      / { sub(/^      /, ""); print; next }
  list && /^    - / { block = 0; sub(/^    - /, ""); print; next }
  { list = 0; block = 0 }' "$FF_REPO_ROOT/examples/ci/gitlab-ci.yml" >"$ci/gitlab-job.sh"
check "the GitLab example's job installs curl, jq and minisign in its image, then installs ff and deploys" \
  "apk add --no-cache curl jq minisign" "$(grep '^apk ' "$ci/gitlab-job.sh")"
grep -v '^apk ' "$ci/gitlab-job.sh" >"$ci/gitlab.sh"
# gitlab_job <key>: its script with sh -e, in a fresh checkout and home.
gitlab_job() {
  code=0
  rm -rf "$ci/home" "$ci/app" && mkdir "$ci/home" && cp -r "$ci/cli-ci" "$ci/app"
  (cd "$ci/app" && env -i HOME="$ci/home" PATH="$ci/bin:$PATH" FF_ENDPOINT="$api_oidc" FF_DOWNLOADS_URL="$site" \
    FF_TOKEN="$1" sh -e "$ci/gitlab.sh") >"$ci/job.out" 2>&1 || code=$?
  echo "$code" >"$ci/job.code"
}
gitlab_job "$ci_key"
check "GitLab's: ff installed, its signatures checked with minisign, the app deployed again, unchanged, its URL said" \
  "0 true true true" \
  "$(cat "$ci/job.code") $(said_in_job "^ff [0-9.]+ installed as $ci/home/.local/bin/ff: its SHA-256 is latest.json's, and their signatures are the release key's") \
$(said_in_job '^unchanged HelloWorldFunction: ') $(said_in_job "^HelloWorldApi: ${url%/}")"
gitlab_job "$ci_reader_key"
check "  ... and refused with a reader's key, its last line the account's message" "6 true" \
  "$(cat "$ci/job.code") $(job | tail -1 | grep -E '^FF refused the account \(exit 6\): This API key lacks the scope ' >/dev/null && echo true || echo false)"
in_folder "$ci/cli-ci" delete-stack --yes
check "the app's stack deleted after" 0 "$(code)"
}
section_def ci section_ci login budget=60

sections_run
checks_done cli-e2e
