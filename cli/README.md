# `ff`, FF's command-line tool

One Rust binary that deploys, invokes and reads FF's functions, through FF's API only: no storage keys, no cluster access ([ADR 0002](../docs/adr/0002-cli.md)). It is being built task by task, as the [CLI plan](../docs/cli-plan.md) says; its progress log says what works.

## Commands so far

| Command | What it does |
|---|---|
| `ff version` | The version, and the commit it was built from; with `--verbose`, the platform it was built for |
| `ff completion <shell>` | A completion script for `bash`, `zsh`, `fish`, `elvish` or `powershell` |

Every command takes `--output text|json` (one JSON document per command, for scripts), `--verbose` and `--no-color` (`NO_COLOR` in the environment says the same).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, "no changes" included |
| 2 | A usage error: an unknown command or flag, a bad argument |
| 3 | Configuration, connection, or an API error that isn't one below |
| 4 | A deploy failed: the function didn't become ready |
| 5 | The invocation failed: the function raised an error or timed out |
| 6 | Refused by the account, not the request: no credit, a role or a key's scopes, the plan's rate |

An error goes to stderr: `error: <message>`, and the API's request ID when there is one; with `--output json`, `{"error": {"message", "exitCode", "requestId"}}`.

## Build and test

Rust 1.91 or later (`rustup`), from this folder:

```bash
cargo build --release --locked                                    # target/release/ff
cargo build --release --locked --target x86_64-unknown-linux-musl  # a static binary, with musl-gcc installed
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings
cargo test --locked                                                # unit tests, then the binary's own (tests/)
```

`ff version` names the commit from git at build time, or from `FF_BUILD_COMMIT` when the build sets it.
