#!/usr/bin/env bash
# L3 for the ff command: the built binary against the whole stack, as a developer runs it:
#   PostgreSQL + S3 (compose project "ff-cli-e2e", ports 55436 / 59007) + the k3d dev cluster
#   + the backend (built, started on a free port in development mode, which acts as the account
#   a profile names, as hack/e2e.sh's requests do).
# For examples/hello.ts and examples/hello.py: deploy, invoke, the handler's line in ff logs and
# in ff logs --follow, deploy again unchanged, scale, update, history, delete. A Python function that raises, and examples/slow.py past its timeout,
# exit 5 with the call's ID, which the history shows; code that fails to load exits 4, and the
# function is kept, in ERROR, with its error. A second account finds none of the first's. Then
# ff init for both runtimes, its folder run locally, deployed and invoked; and ff local, in
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
be_env=("${e2e_base_env[@]}" PORT="$be_port" FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a")
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
  check "get shows it, its code's size rather than its code" "0 256 0 2 null true" \
    "$(code) $(out | jq -r '"\(.memory) \(.minInstances) \(.maxInstances) \(.code) \(.codeSize > 0)"')"
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
echo "from-stdin" | "$ff_bin" env set cli-env TOKEN >"$work/out" 2>"$work/err"
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

echo "cli-e2e: $passed checks passed"
