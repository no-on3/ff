#!/usr/bin/env bash
# L3 for the ff command: the built binary against the whole stack, as a developer runs it:
#   PostgreSQL + S3 (compose project "ff-cli-e2e", ports 55436 / 59007) + the k3d dev cluster
#   + the backend (built, started on a free port in development mode, which acts as the account
#   a profile names, as hack/e2e.sh's requests do).
# For examples/hello.ts and examples/hello.py: deploy, invoke, deploy again unchanged, scale,
# update, history, delete. A Python function that raises, and examples/slow.py past its timeout,
# exit 5 with the call's ID, which the history shows; code that fails to load exits 4, and the
# function is kept, in ERROR, with its error. A second account finds none of the first's.
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
  check "history lists its calls, newest first, by the IDs invoke printed" "0 3 $last_id COMPLETED" \
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

echo "cli-e2e: $passed checks passed"
