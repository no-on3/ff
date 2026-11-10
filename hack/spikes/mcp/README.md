# MCP spike

How `ff mcp` will speak to an AI assistant: the Model Context Protocol over stdio, as its clients start a server. The [developer tools plan](../../../docs/dev-tools-plan.md)'s D5, its task list's M-01, part 6, for M-09 to build on.

```bash
hack/spikes/mcp/run.sh      # under a minute: the server's tests and build, a client as the specification describes one,
                            # then MCP's Inspector, which the first run installs from npm
```

It needs Rust (the toolchain `cli/` pins), Python 3, jq, Node.js and npm. Its build, the logs and the results go to `hack/.spikes/mcp/` (`results.md`). The crate stands apart from `cli/` and depends on `serde_json` alone, which `ff` has already.

## What it does

- **The server** (`src/main.rs`) reads JSON-RPC 2.0 on stdin, one message a line, and answers on stdout, as MCP's stdio transport says. It answers:
  - `initialize`, with the protocol version the client asks when it speaks it (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), else its newest, and the one capability `tools`;
  - `ping`;
  - `tools/list`, with one tool, `ff_functions`, shaped as `ff mcp`'s will be: a name, a title, a description and a JSON schema of its arguments;
  - `tools/call`: a fixed list of two functions, as text and as `structuredContent`. Asked with `"fail": "tool"`, a tool's error: a result with `isError` and the API's message, as `ff mcp` will answer a refused key. Asked with `"fail": "protocol"`, JSON-RPC's error -32602, as an argument the schema doesn't take would be;
  - anything else, -32601; a line that isn't JSON, -32700. A notification gets no answer.

  It writes every message it reads and sends to a log, one JSON line each with the time, so what a client sends can be read afterwards. The log is the file it's given, else `$FF_MCP_SPIKE_LOG`, else `hack/.spikes/mcp/<its pid>.jsonl`.
- **A client as the specification describes one** (`client.py`) starts the server and goes through the whole exchange: `initialize`, the `initialized` notification, `tools/list`, the tool called three ways, `ping`, and `resources/list`, which the server hasn't.
- **MCP's Inspector,** the second client, its CLI (`mcp-inspector --cli`) at 2.12.0, installed into `hack/.spikes/mcp/inspector/` with its dependencies as npm had them on 2026-10-26 and their install scripts off. It starts the server four times, as Claude Code was asked to call it: `tools/list`, then `ff_functions` with no arguments, with `fail` `tool` and with `fail` `protocol`. Its catalog of servers is kept in the work folder, not in the user's home.
- **The checks,** 15:
  - the server's tests (4);
  - what the specification's client got back for each exchange, and the log holding the 8 messages in and the 7 answers out;
  - what the Inspector sent before `tools/list`, and what it printed and exited with for an answer and for each kind of error (6).

## Connecting it to a client by hand

`run.sh` builds the server at `hack/.spikes/target/release/mcp-spike`. Each client starts it with a log file of its own as its one argument, then the log says what that client sent.

**Claude Code,** in a session of its own, as a developer adds `ff mcp`:

```bash
claude mcp add ff-spike -- "$PWD/hack/.spikes/target/release/mcp-spike" "$PWD/hack/.spikes/mcp/claude-code.jsonl"
claude      # then ask it to call ff_functions three times: with no arguments, with fail "tool", with fail "protocol"
claude mcp remove ff-spike
```

Or once, in print mode, with this server alone, no other tool, and the stream of what the model saw kept:

```bash
cat >mcp.json <<EOF
{"mcpServers": {"ff-spike": {"type": "stdio", "command": "$PWD/hack/.spikes/target/release/mcp-spike",
                             "args": ["$PWD/hack/.spikes/mcp/claude-code.jsonl"]}}}
EOF
claude -p 'Call the ff_functions tool three times, one after the other: first with no arguments, then with {"fail": "tool"}, then with {"fail": "protocol"}. Then quote, word for word, what you received from each call, any error text included. Do nothing else.' \
  --strict-mcp-config --mcp-config mcp.json --tools "" --allowedTools mcp__ff-spike__ff_functions \
  --setting-sources local --no-session-persistence --model haiku --output-format stream-json --verbose >stream.jsonl
```

**Another client:** any that starts a stdio server from a command and its arguments, such as VS Code's agent (`code --add-mcp`). `run.sh` drives MCP's Inspector itself.

## What it found

On 2026-11-08, with Rust 1.91.0. The server's tests, the specification's exchange and the Inspector: 15 checks, all passed.

**Claude Code 2.1.319,** in print mode, Haiku answering. Its log, `claude-code.jsonl`:

| | What it sent, what it got |
|---|---|
| First | `server/discover`, with its id `server-discover-probe-1`, protocol version `2026-07-28` in `params._meta`, its capabilities and itself there too. The server answered -32601, method not found |
| Then | `initialize` at `2025-11-25`, which the server speaks and answered with; capabilities `roots` and `elicitation`; `clientInfo` naming Claude Code and its version |
| Before `tools/list` | the `initialized` notification, and nothing else |
| `tools/list` | once, at the start, before the prompt reached the model |
| `tools/call` | `params._meta` holding `progressToken` and `claudecode/toolUseId` beside the name and the arguments |
| The answer the model saw | `structuredContent`, as JSON text, in place of the text content when both are given |
| A tool's error (`isError`) | the text, as an error (`is_error: true`) |
| A protocol's error (-32602) | its message alone, without its code, as an error too: the model can't tell the two apart |

**MCP's Inspector 2.12.0,** its CLI. Its logs, `inspector-*.jsonl`, one per session:

| | What it sent, what it printed |
|---|---|
| First | `initialize` at `2025-11-25` at once, with no probe; capabilities `roots` and two extensions, `io.modelcontextprotocol/skills` and `io.modelcontextprotocol/tasks`; `clientInfo` `inspector-cli` |
| Before `tools/list` | the `initialized` notification, and nothing else |
| `tools/list` | in every session, before a call too |
| `tools/call` | the name and the arguments, nothing in `_meta` |
| The answer | the result as the server sent it, both contents; exit 0 |
| A tool's error (`isError`) | the result as sent, then `{"error": {"code": "tool_is_error", …}}`; exit 5 |
| A protocol's error (-32602) | `{"error": {"code": "error", "message": …}}`, its message without its code; exit 1 |

1. **The handshake is the one the specification describes,** after a probe the server may refuse. Claude Code first asks `server/discover` at a newer protocol version, `2026-07-28`, where the client's capabilities travel in `_meta` rather than in `initialize`. Refused with -32601, it falls back to `initialize` at the version before, `2025-11-25`, 4 ms later. So `ff mcp` at `2025-11-25` works with Claude Code today, by that fallback, and with the Inspector, which asks it straight away. Which version M-09 implements is its choice, against the specification's current version then: `2026-07-28` means answering `server/discover` as well, and a client that no longer falls back would need it.
2. **`structuredContent` is what the model reads.** `ff mcp`'s answer should be the command's `--output json` document there, as the plan's D5 says, and its text content the same document as text, for a client that reads the text alone, as the specification asks of a server that returns structured content.
3. **A tool's error is how `ff mcp` should answer a command that failed:** a result with `isError` and the command's message, which the model reads as the command's error and can act on (another key, another name). JSON-RPC's errors are for what isn't a tool's call at all: an unknown tool, arguments the schema refuses.

   Neither client shows JSON-RPC's code: Claude Code gives the model both kinds as errors alike, and the Inspector tells them apart by its exit status alone (5 and 1).
4. **Nothing else is needed for a client to start:** no `resources` or `prompts`, no notification from the server. Both clients ignore what they don't use: the Inspector offers extensions the server doesn't answer, and goes on.
5. **`tools/list` comes first, every time.** Both clients ask for it before anything else, and the Inspector asks again in each session before a call. So `ff mcp` must answer it from `ff` itself, without reaching the API, so that a client starts fast, offline, and before any login.
