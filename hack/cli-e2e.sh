#!/usr/bin/env bash
# L3 for the ff command: the built binary against the whole stack, as a developer runs it:
#   PostgreSQL + S3 (compose project "ff-cli-e2e", ports 55436 / 59007) + the k3d dev cluster
#   + the backend (built, started on a free port in development mode, which acts as the account
#   a profile names, as hack/e2e.sh's requests do).
# For examples/hello.ts and examples/hello.py: deploy, invoke, the handler's line in ff logs and
# in ff logs --follow, deploy again unchanged, scale, update, history, delete. A Python function that raises, and examples/slow.py past its timeout,
# exit 5 with the call's ID, which the history shows; code that fails to load exits 4, and the
# function is kept, in ERROR, with its error. A second account finds none of the first's. Then
# ff init for both runtimes, its folder run locally, deployed and invoked; folders deployed as
# packages with their libraries (an npm library, requests, numpy's native wheels from
# pyproject.toml), uploaded once, and one built in Docker with --container; and ff local, in
# Docker: both runtimes, a failed load, a timeout, a call over its memory, and ff local start
# answering on its port until Ctrl-C, no container left behind.
# Removes its compose project, its namespaces and the backend on exit; keeps the cluster.
#   hack/cli-e2e.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-cli-e2e
E2E_NAME=cli-e2e
export FF_PG_PORT="${FF_CLI_E2E_PG_PORT:-55436}"
export FF_S3_PORT="${FF_CLI_E2E_S3_PORT:-59007}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"

be_port="$(free_port)"
api="http://127.0.0.1:$be_port"
account_a="$(random_account)"
account_b="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_a")" "$(tenant_namespace "$account_b")")

e2e_dependencies
e2e_cluster

echo "== ff and the backend"
(cd "$FF_REPO_ROOT/cli" && cargo build --release --locked -q)
ff_bin="$FF_REPO_ROOT/cli/target/release/ff"
e2e_build
# Function URLs on a port of their own, each at http://<id>.fn.localhost:<port>/, which ff reaches on 127.0.0.1.
url_port="$(free_port)"
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a"
  FF_FUNCTION_URL_PORT="$url_port" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port")
e2e_migrate "${be_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${be_env[@]}"

# ff's settings in a folder of the test's, and none of the caller's: profile default acts as account A, b as account B.
export FF_CONFIG_DIR="$work/ff"
unset FF_TOKEN FF_ENDPOINT FF_ACCOUNT FF_PROFILE
rm -rf "$FF_CONFIG_DIR"
# ff <args...>: its stdout in $work/out, its stderr in $work/err, its exit code in $work/code.
ff() {
  local code=0
  "$ff_bin" "$@" >"$work/out" 2>"$work/err" || code=$?
  echo "$code" >"$work/code"
}
out() { cat "$work/out"; }
err() { cat "$work/err"; }
code() { cat "$work/code"; }
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
  echo "== $example, as $name"
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
    if out | grep -q ' greeting Tunis$'; then
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
  check "history lists its calls, newest first, by the IDs invoke printed" "0 4 $last_id COMPLETED" \
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

echo "== failures"
ff deploy "$FF_REPO_ROOT/examples/hello.py" --name cli-raises
ff invoke cli-raises --data '{"name": "error"}'
raised_id="$(err | sed -n 's/^request ID: //p')"
check "a function that raises exits 5, with its error and the call's ID" "5 error: ValueError: this name is not allowed true" \
  "$(code) $(err | head -1) $([ -n "$raised_id" ] && echo true || echo false)"
ff history cli-raises --output json
check "which the history shows, as ERROR" "$raised_id ERROR" "$(out | jq -r '"\(.invocations[0].id) \(.invocations[0].status)"')"
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

echo "== environment variables: --env, ff env, and on this machine"
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

echo "== secrets: set from stdin, read by the function only"
printf 'import os\n\ndef handler(event, context):\n    return {"password": os.environ.get("DB_PASSWORD", "none")}\n' >"$work/secret-reader.py"
ff deploy "$work/secret-reader.py" --name cli-secrets
echo "hunter2-$account_a" | ff secrets set cli-secrets DB_PASSWORD
check "ff secrets set takes the value from stdin, and says nothing of it" "0 false" \
  "$(code) $(cat "$work/out" "$work/err" | grep -q "hunter2" && echo true || echo false)"
ff invoke cli-secrets --raw
check "the function reads it, once the command has answered" "0 hunter2-$account_a" "$(code) $(out | jq -r .password)"
ff secrets list cli-secrets
check "ff secrets list names it, and when it was set" "0 DB_PASSWORD" "$(code) $(out | sed -n 2p | awk '{ print $1 }')"
ff get cli-secrets --output json
check "and ff get shows no value of it" "0 false" "$(code) $(out | grep -q hunter2 && echo true || echo false)"
ff secrets unset cli-secrets DB_PASSWORD
ff invoke cli-secrets --raw
check "ff secrets unset removes it" "0 none" "$(code) $(out | jq -r .password)"
ff delete cli-secrets --yes

echo "== a function's URL: ff url, ff invoke --http, ff domains"
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
  "$(code) $(out | head -1) $(out | grep -q "CNAME shop.cli-e2e.test ${address:7:32}.fn.localhost" && echo true || echo false)"
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

echo "== schedules: ff schedule set, its run, list, disable, remove"
ff deploy "$FF_REPO_ROOT/examples/hello.py" --name cli-sched
ff schedule set cli-sched "rate(1 minute)" --input '{"name": "Schedule"}'
check "ff schedule set makes it, and says its next runs" "0 cli-sched's schedule schedule made: rate(1 minute), with its own input true" \
  "$(code) $(out | head -1) $(out | sed -n 2p | grep -qE '^next runs \(UTC\): [0-9-]+ [0-9:]+, ' && echo true || echo false)"
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

echo "== ff init: a new function's folder, run locally, then deployed"
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

echo "== packages: a folder with its libraries, packaged, uploaded once, deployed"
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
check "leaving out its .env, and saying so" true "$(err | grep -q '^warning: not packaged: .env, which usually hold secrets' && echo true || echo false)"
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
  "$(code) $(out | sed 's/.*, changed/changed/') $(err | grep -q '^warning: cli-pkg-node ran a package: it becomes inline code, .*hello.ts alone, its handler function.handler$' && echo true || echo false)"
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
  "$(code) $(python3 -I -m zipfile -l "$work/requests-container.zip" | grep -q '^requests/__init__.py ' && echo true || echo false)"
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

echo "== the account: who, its plan, what it used and owes, how its functions ran"
ff accounts
check "ff accounts lists account A, current" "0 * $account_a" "$(code) $(out | sed -n 2p | awk '{ print $1, $2 }')"
ff account
check "ff account says its plan, and that its functions don't reach the internet, as beta's" "0 Beta true" \
  "$(code) $(out | sed -n 's/^plan *\([A-Za-z]*\):.*/\1/p') $(out | grep -q '^internet     off' && echo true || echo false)"
ff usage --output json
check "ff usage counts this month's calls of the functions deleted since, by name" "0 4 true" \
  "$(code) $(out | jq -r '.functions[] | select(.functionName == "cli-hello-ts") | .requests') $(out | jq -r '[.functions[] | select(.functionName == "cli-hello-ts") | .deleted] | first')"
ff usage --csv
check "and gives the API's CSV" "0 true" "$(code) $(out | head -1 | grep -q 'requests' && echo true || echo false)"
ff balance --output json
check "ff balance says the balance, in dinars" "0 TND" "$(code) $(out | jq -r .currency)"
ff metrics --since 2h --output json
check "ff metrics counts the account's invocations of the last two hours" "0 true" "$(code) $(out | jq '[.metrics.Invocations[]] | add > 10')"

echo "== ff local: on this machine, in Docker, as production runs it"
leftover() { docker ps -a --filter name=ff-local- --format '{{.Names}}' | wc -l; }
for example in hello.ts hello.py; do
  ff local invoke "$FF_REPO_ROOT/examples/$example" --data '{"name": "Local"}'
  check "local invoke of $example answers, in its runtime image, and says how it went" "0 Hello Local true" \
    "$(code) $(out | sed '$d' | jq -r .message) $(out | tail -1 | grep -qE '^request [0-9a-f-]{36} · [0-9.]+ ms · [0-9.]+ MB, on this machine$' && echo true || echo false)"
done
check "with the handler's line and the runtime's report in its log" "true true" \
  "$(err | grep -q '^greeting Local$' && echo true || echo false) $(err | grep -q '^REPORT RequestId: ' && echo true || echo false)"
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

echo "cli-e2e: $passed checks passed"
