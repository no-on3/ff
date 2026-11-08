#!/usr/bin/env bash
# The developer tools' spike of `ff mcp`: an MCP server on stdio in Rust (src/main.rs) listing one tool, its tests, then
# a client as the specification describes one (client.py) through the whole exchange: initialize, the initialized
# notification, tools/list, the tool answered, a tool's error, a protocol's error, ping, a method the server hasn't.
# The server logs every message, with its time, so that the same server connected to Claude Code and to another client
# by hand (the README says how) shows what each sends. What it found lands in hack/.spikes/mcp/results.md.
#   hack/spikes/mcp/run.sh      # under a minute
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/lib/spikes.sh"
spike_work mcp
source "$repo/hack/lib/checks.sh"
results="$work/results.md"

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

{ echo "# ff mcp's handshake ($(date -u +%F))"; echo
  echo "The server's tests: $tests. A client as the specification describes one, through the whole exchange:"; echo
  echo '```'; jq -c '{sent, reply}' <<<"$exchanges"; echo '```'
  echo; echo "Connect it to a client by hand as the README says; each connection's log is a file in hack/.spikes/mcp/."
} >"$results"
cat "$results"
checks_done spike-mcp
