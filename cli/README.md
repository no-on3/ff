# `ff`, FF's command-line tool

One Rust binary that deploys, invokes and reads FF's functions, through FF's API only: no storage keys, no cluster access ([ADR 0002](../docs/adr/0002-cli.md)). It is being built task by task, as the [CLI plan](../docs/cli-plan.md) says; its progress log says what works.

## Commands so far

| Command | What it does |
|---|---|
| `ff whoami` | Who the token is, an API key (its name, ID and scopes) or a user (their accounts, and which one acts), and the account it acts for: `GET /me`. The first check of a new key |
| `ff config set <key> <value>` | Set one of the profile's settings: `endpoint`, `account`, `dev_account` or `allow_http` |
| `ff config unset <key>` | Remove one of them, or the profile's `token` |
| `ff config show` | The settings in effect, each with where it comes from; the token masked, `ffk_<key ID>_…`, as the console lists keys |
| `ff config set-token` | Save an API key for the profile, read from a prompt that doesn't show it, or from stdin (`ff config set-token < key.txt`) |
| `ff version` | The version, and the commit it was built from; with `--verbose`, the platform it was built for |
| `ff completion <shell>` | A completion script for `bash`, `zsh`, `fish`, `elvish` or `powershell` |

Every command takes `--output text|json` (one JSON document per command, for scripts), `--verbose` and `--no-color` (`NO_COLOR` in the environment says the same), and the connection's flags below.

## Settings

An owner of the account makes an API key in the console's API keys page, with the scopes the commands need, and the key is shown once. Then:

```bash
ff config set endpoint https://api.ff.example   # the API's address; http://localhost:3000 by default
ff config set-token                             # paste the key: it isn't shown, nor kept in the shell's history
ff whoami                                       # API key "laptop" (ffk_1a2b3c4d5e6f_…) on account 123456789012 …
```

The settings are kept in `config.toml`, the token in `credentials.toml` next to it, readable by its owner only (ff warns when others may read it). Both are in `~/.config/ff/` on Linux, `~/Library/Application Support/ff/` on macOS, `%APPDATA%\ff\` on Windows, or in the folder `FF_CONFIG_DIR` names. Each holds profiles:

```toml
[profiles.default]
endpoint = "https://api.ff.example"

[profiles.dev]
endpoint = "http://localhost:3000"
dev_account = "123456789012"     # a development stack (FF_AUTH_MODE=dev) acts as this account, with no token
```

`ff config set` and `unset` change a file keeping its comments and its other profiles; `--profile <name>` picks the profile they change, and the first setting makes a new one.

**Which setting applies:** a flag, then an environment variable, then the profile, then the default.

| Setting | Flag | Environment | Profile |
|---|---|---|---|
| The profile | `--profile` | `FF_PROFILE` | `default` |
| The API's address | `--endpoint` | `FF_ENDPOINT` | `endpoint`, else `http://localhost:3000` |
| The account, for a login with several | `--account` | `FF_ACCOUNT` | `account` |
| The token | none: a flag would stay in the shell's history | `FF_TOKEN` | `token`, in `credentials.toml` |
| The account a development stack acts as | | | `dev_account` |
| Plain http to another machine | `--allow-http` | | `allow_http` |

**Plain `http://`** sends the token in clear, so ff uses it only to this machine (`localhost`, `127.0.0.1`, `[::1]`), unless `--allow-http` or `allow_http = true` says otherwise, for a development stack elsewhere.

**Without a token**, nor a development account, ff says how to get a key, and calls nothing.

## What ff sends

Each request carries `Authorization: Bearer <token>`, `X-FF-Account` when an account is set, `X-FF-Dev-Account` when a development account is, and `User-Agent: ff-cli/<version>`. It connects within 5 s, and waits 30 s for an answer, unless a command needs longer. `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` are honoured, and certificates are checked against the system's own, so a company's CA works.

A read the plan's rate refused (429) is tried once more after its `Retry-After`, up to 30 s; a change never is, since it may have happened.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, "no changes" included |
| 2 | A usage error: an unknown command or flag, a bad argument |
| 3 | Configuration, connection, or an API error that isn't one below |
| 4 | A deploy failed: the function didn't become ready |
| 5 | The invocation failed: the function raised an error or timed out |
| 6 | Refused by the account, not the request: no credit (402), a role or a key's scopes (403), the plan's rate (429) |

An error goes to stderr: `error: <message>`, the API's own when it refused, and its request ID on the next line when there is one; with `--output json`, `{"error": {"message", "exitCode", "status", "requestId"}}`, the API's status and request ID null when the API gave none.

## Build and test

Rust 1.91 or later (`rustup`), from this folder:

```bash
cargo build --release --locked                                    # target/release/ff
cargo build --release --locked --target x86_64-unknown-linux-musl  # a static binary, with musl-gcc installed
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings
cargo test --locked                                                # unit tests, then the binary's own (tests/)
```

The binary's tests run `ff` with a settings folder of its own, against a scripted API (`tests/common/mod.rs`) that answers in order and records what it was sent. `ff version` names the commit from git at build time, or from `FF_BUILD_COMMIT` when the build sets it.
