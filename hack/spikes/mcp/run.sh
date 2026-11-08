#!/usr/bin/env bash
# The developer tools' spike of `ff mcp`: an MCP server on stdio in Rust (src/main.rs) listing one tool, its tests, then
# a client as the specification describes one (client.py) through the whole exchange: initialize, the initialized
# notification, tools/list, the tool answered, a tool's error, a protocol's error, ping, a method the server hasn't.
# Then MCP's Inspector, the second client, its CLI driving the same calls as Claude Code was asked to make. The server
# logs every message, with its time, so that each client's log shows what it sends; Claude Code is connected by hand
# (the README says how). What it found lands in hack/.spikes/mcp/results.md.
#   hack/spikes/mcp/run.sh      # under a minute; the first run installs the Inspector from npm
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work mcp
source "$repo/hack/lib/checks.sh"
results="$work/results.md"
# The Inspector's release, two weeks old or more when chosen, and its dependencies as npm had them before then.
INSPECTOR_VERSION=2.12.0 INSPECTOR_BEFORE=2026-10-26

section "the server: its tests"
"$repo/hack/check-resources.sh"
tests="$( (cd "$here" && cargo test --locked --quiet 2>&1) | sed -n 's/^test result: \(ok\. [0-9]* passed\).*/\1/p')"
check "the tests pass" true "$([[ "$tests" == "ok. "* ]] && echo true || echo "$tests")"
(cd "$here" && cargo build --locked --quiet --release)
server="$CARGO_TARGET_DIR/release/mcp-spike"

section "a client as the specification describes one"
log="$work/spec-client.jsonl"
rm -f "$log"
exchanges="$(python3 -I "$here/client.py" "$server" "$log")"
reply() { jq -c "select(.sent == \"$1\") | .reply" <<<"$exchanges" | sed -n "${2:-1}p"; }
check "initialize: the version asked, and tools" '"2025-06-18" {"listChanged":false}' \
  "$(reply initialize | jq -c '.result.protocolVersion') $(reply initialize | jq -c '.result.capabilities.tools')"
check "tools/list: the one tool" '["ff_functions"]' "$(reply tools/list | jq -c '[.result.tools[].name]')"
check "the tool answered" '"orders"' "$(reply tools/call 1 | jq -c '.result.structuredContent.functions[0].name')"
check "a tool's error: a result with isError" true "$(reply tools/call 2 | jq -c '.result.isError')"
check "a protocol's error: JSON-RPC's" -32602 "$(reply tools/call 3 | jq -c '.error.code')"
check "ping" '{}' "$(reply ping | jq -c '.result')"
check "a method it hasn't: not found" -32601 "$(reply resources/list | jq -c '.error.code')"
check "the log holds every message, in and out" "8 7" \
  "$(jq -s '[.[] | select(.direction == "in" and (.message.method != null))] | length' "$log") $(jq -s '[.[] | select(.direction == "out")] | length' "$log")"

section "MCP's Inspector $INSPECTOR_VERSION, the second client"
inspector_dir="$work/inspector"
inspector="$inspector_dir/node_modules/.bin/mcp-inspector"
if [ "$(jq -r .version "$inspector_dir/node_modules/@modelcontextprotocol/inspector/package.json" 2>/dev/null)" != "$INSPECTOR_VERSION" ]; then
  rm -rf "$inspector_dir" && mkdir -p "$inspector_dir"
  printf '{"private": true}\n' >"$inspector_dir/package.json"
  "$repo/hack/check-resources.sh"
  (cd "$inspector_dir" && npm install --no-audit --no-fund --ignore-scripts --before "$INSPECTOR_BEFORE" \
    "@modelcontextprotocol/inspector@$INSPECTOR_VERSION" >/dev/null)
fi
# inspect <log's name> <the CLI's arguments…>: its output in $work/<name>.out, its exit status in $work/<name>.status. Its
# catalog of servers in the work folder, not the user's home.
inspect() {
  local name=$1 status=0
  shift
  rm -f "$work/$name.jsonl"
  MCP_CATALOG_PATH="$inspector_dir/catalog.json" timeout 60 "$inspector" --cli "$server" "$work/$name.jsonl" "$@" \
    >"$work/$name.out" 2>&1 || status=$?
  echo "$status" >"$work/$name.status"
}
inspect inspector-list --method tools/list
inspect inspector-call --method tools/call --tool-name ff_functions
inspect inspector-tool-error --method tools/call --tool-name ff_functions --tool-arg fail=tool
inspect inspector-protocol-error --method tools/call --tool-name ff_functions --tool-arg fail=protocol
asked() { jq -r "select(.direction == \"in\" and .message.method != null) | .message.method" "$work/$1.jsonl" | paste -sd' '; }
check "initialize at the version asked, as itself" '"2025-11-25" "inspector-cli"' \
  "$(jq -c 'select(.message.method == "initialize") | .message.params | "\(.protocolVersion | tojson) \(.clientInfo.name | tojson)"' -r "$work/inspector-list.jsonl")"
check "before tools/list, the initialized notification alone" "initialize notifications/initialized tools/list" "$(asked inspector-list)"
check "tools/list before a call too" "initialize notifications/initialized tools/list tools/call" "$(asked inspector-call)"
check "the tool answered: its structured content printed" '"orders" 0' \
  "$(sed -n '/^{/,/^}/p' "$work/inspector-call.out" | jq -c '.structuredContent.functions[0].name') $(cat "$work/inspector-call.status")"
check "a tool's error: the result printed, then tool_is_error, exit 5" 'true tool_is_error 5' \
  "$(sed -n '/^{$/,/^}$/p' "$work/inspector-tool-error.out" | jq -c '.isError') $(tail -1 "$work/inspector-tool-error.out" | jq -r .error.code) $(cat "$work/inspector-tool-error.status")"
check "a protocol's error: its message alone, without its code, exit 1" "error the spike's protocol error 1" \
  "$(jq -r '.error.code' "$work/inspector-protocol-error.out") $(jq -r '.error.message' "$work/inspector-protocol-error.out" | sed -n "s/.*\(the spike's protocol error\).*/\1/p") $(cat "$work/inspector-protocol-error.status")"

{ echo "# ff mcp's handshake ($(date -u +%F))"; echo
  echo "The server's tests: $tests. A client as the specification describes one, through the whole exchange:"; echo
  echo '```'; jq -c '{sent, reply}' <<<"$exchanges"; echo '```'
  echo; echo "MCP's Inspector $INSPECTOR_VERSION, its CLI: what it sent in each session, and what it printed."; echo
  for name in inspector-list inspector-call inspector-tool-error inspector-protocol-error; do
    echo "- \`$name\`: $(asked "$name"); exit $(cat "$work/$name.status")"
  done
  echo; echo "Connect it to Claude Code by hand as the README says; each connection's log is a file in hack/.spikes/mcp/."
} >"$results"
cat "$results"
checks_done spike-mcp
