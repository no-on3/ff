# `ff`, FF's command-line tool

One Rust binary that deploys, invokes and reads FF's functions, through FF's API only: no storage keys, no cluster access ([ADR 0002](../docs/adr/0002-cli.md)). It is being built task by task, as the [CLI plan](../docs/cli-plan.md) says; its progress log says what works.

## Commands so far

| Command | What it does |
|---|---|
| `ff init <name> --runtime nodejs\|python` | Makes the folder `<name>`: `function.ts` or `function.py`, AWS Lambda's handler, which logs a line and answers a greeting; `events/event.json`, an event to call it with; and a README with the commands that run it here, deploy it and read its log |
| `ff deploy <file> [--name] [--runtime] [--memory] [--timeout] [--min-instances] [--max-instances] [--env KEY=value…]` | Creates the function of the file's name (or `--name`; a `function.*` file, as `ff init` makes, takes its folder's name), its runtime from the extension (`.ts`, `.js`, `.cjs`: nodejs; `.py`: python), 128 MB and 5 s unless said; or updates the function of that name with only what changed, and says "no changes" when nothing did. It returns once the new version is live, and sets the instances after. `--env KEY=value`, repeated, sets the function's variables, all of them as on Lambda: those not named are removed; `ff env` changes one at a time. Code that fails to load exits 4 with the diagnosis: a new function is kept, in `ERROR`, and a working one keeps its previous version |
| `ff invoke <name> [--data JSON\|@file\|-] [--raw] [--http METHOD PATH [-H 'name: value']…]` | Calls it with the event (`{}` by default) and prints its answer, then `request <ID> · <duration> · <memory>`; the request ID finds the call's log lines. `--raw` prints the answer only. A function that raised or timed out exits 5, with the call's ID. `--http` calls it through its URL instead, as a browser or a webhook does, with the API key when the URL takes one, and prints the HTTP status and body (`--verbose`: the headers too) whatever the status, as curl does; a host under `localhost` is reached on `127.0.0.1` |
| `ff list` | The account's functions: runtime, memory, timeout, status, instances, last update |
| `ff get <name>` | One function: its settings and state, its error when it is in `ERROR`, its variables' names |
| `ff logs <name> [--tail N] [--since 15m] [--start] [--end] [--grep phrase] [--request-id ID] [--all] [--follow [--poll]]` | Its log lines from the log store, as `time [instance] message` (with `--verbose`, the call's request ID too): the newest 100 of the window by default, `--all` every page of it, `--follow` then each new line as it comes, through the API's live tail, a new tail when one ends (after 30 minutes), a minute of retries 5 s apart when the store is unavailable, and `--poll` asking every 2 s instead, through a proxy that holds streams back. `--grep` finds a phrase as whole words, case included; `--request-id` one call's lines, from its START to its REPORT. The store's notice of dropped lines comes as a warning. With `--output json`, each line is a JSON object of its own |
| `ff history <name> [--limit N]` | Its last calls, newest first: time, request ID, status, duration, how it came, the error's first line |
| `ff scale <name> [--min N] [--max N]` | The instances it keeps running when idle (billed as AWS bills provisioned concurrency), and the most it runs |
| `ff delete <name> [--yes]` | Deletes it, with its history and its logs, after asking; a script says `--yes` |
| `ff local invoke <file\|folder> [--data …] [--raw] [--name] [--runtime] [--memory] [--timeout]` | Runs it once on this machine, in Docker, in the runtime image production uses and with the pod's hardening: a read-only root with a 512 MiB `/tmp`, uid 10001, no capability, no new privileges, its memory as the limit and CPU by Lambda's ratio, the variables the backend gives a pod, the code mounted read-only (a file as `/var/task/function.<extension>`, a folder as `/var/task`), the port on `127.0.0.1` only. `--env KEY=value` gives the run variables, refusing the names the runtime sets itself, as the API does. It prints the answer and the call's log; a load that fails exits 4 with the runtime's reason, a call that raised, timed out or ran out of memory exits 5. The container is removed after, Ctrl-C too |
| `ff local start <file\|folder> [--port N] [--watch]` | Keeps it running on `127.0.0.1` (any free port unless `--port`): it prints the address to `POST` events to, then its log on stderr as it comes, until Ctrl-C. `--watch` starts it again when its code changes: its file, even replaced by an editor, or anything in its folder |
| `ff env list <name> [--show]` | Its environment variables' names, and with `--show` their values: they are readable like its code, as on Lambda |
| `ff env set <name> KEY=value… \| KEY…` | Sets variables, keeping the others, and returns once the new version is live; a `KEY` alone reads its value from stdin, or from a prompt that doesn't show it, so that the shell's history doesn't keep it. Nothing is sent when nothing changes |
| `ff env unset <name> KEY…` | Removes variables |
| `ff secrets list <name>` | Its secrets: their names, and when each was set; never a value, which nobody reads back, the API included |
| `ff secrets set <name> NAME…` | Sets secrets, keeping the others, once the new version is live: each value from a prompt that doesn't show it, or a line of stdin each, in the names' order; a value on the command line is refused, as the shell's history would keep it |
| `ff secrets unset <name> NAME…` | Removes secrets |
| `ff url show <name>` | Its web address, as AWS Lambda's function URLs: who may call it, its CORS, its own domains |
| `ff url enable <name> [--auth none\|key] [--cors-origin …] [--cors-method …] [--cors-header …]` | Gives it a URL, `--auth` saying who may call it: `none`, anyone; `key`, the account's API keys with `functions:invoke`, as Lambda's `AWS_IAM` would ask for a signature; or changes what is given on the URL it has |
| `ff url disable <name> [--yes]` | Deletes its URL, after asking: the address stops answering at once, and a new URL would have another |
| `ff domains list\|add\|verify\|remove <name> [<domain>]` | The account's own domains for its URL: `add` says the DNS records that prove one (a CNAME to the URL's host for a subdomain, or a TXT record, for an apex too), `verify` checks them again, `remove` takes one away |
| `ff accounts` | The accounts the token reaches, the role in each, the current one marked |
| `ff account` | The current account (the one named by `--account`, `FF_ACCOUNT` or the profile, else the only one): its status, the role in it, its plan's limits, and whether its functions reach the internet, which is why a call out fails when they don't |
| `ff usage [--month YYYY-MM] [--csv]` | A month's usage per function, deleted ones included: requests, GB-seconds, the calls not billed, the cost; the total and the estimate; `--csv`, the API's own CSV. Needs `usage:read` |
| `ff balance` | The balance, this month's charges and how far they are rated, and whether calls go on, are in their grace period, or stopped. Needs `usage:read` |
| `ff metrics [<name>] [--period 60\|300\|3600] [--since 1h]` | A function's metrics, or the whole account's: a row per period with invocations, errors, throttles, cold starts, the duration's p50, p95 and maximum, and the instances; then the window's totals. Needs `metrics:read` |
| `ff whoami` | Who the token is, an API key (its name, ID and scopes) or a user (their accounts, and which one acts), and the account it acts for: `GET /me`. The first check of a new key |
| `ff config set <key> <value>` | Set one of the profile's settings: `endpoint`, `account`, `dev_account` or `allow_http` |
| `ff config unset <key>` | Remove one of them, or the profile's `token` |
| `ff config show` | The settings in effect, each with where it comes from; the token masked, `ffk_<key ID>_…`, as the console lists keys |
| `ff config set-token` | Save an API key for the profile, read from a prompt that doesn't show it, or from stdin (`ff config set-token < key.txt`) |
| `ff version` | The version, and the commit it was built from; with `--verbose`, the platform it was built for |
| `ff completion <shell>` | A completion script for `bash`, `zsh`, `fish`, `elvish` or `powershell` |

Every command takes `--output text|json` (one JSON document per command, for scripts: a function's code is left out, its size given), `--quiet` (no progress or notes on stderr), `--verbose` and `--no-color` (`NO_COLOR` in the environment says the same), and the connection's flags below. Functions are named as on AWS Lambda: 1 to 64 letters, digits, hyphens or underscores, which `ff deploy` checks before sending anything.

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

## Running functions on this machine

`ff local` needs Docker, and the runtime images: `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`, built from this repository (`docker build -t ff-runtime-python:3.13-v3 runtimes/python`, or any end-to-end script's run), or others named by `FF_RUNTIME_IMAGE_NODEJS` and `FF_RUNTIME_IMAGE_PYTHON`. It speaks to the runtime as the backend does (`/readyz`, then `POST /invoke` with the event), so a function behaves on this machine as in its pod, but for its variables and secrets, which stay on FF.

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

## Install

`hack/build-cli.sh`, from the repository's root, makes the static Linux binary for x86_64, `cli/target/dist/ff-linux-x86_64`, and its SHA-256 beside it: here, when the musl target and `musl-gcc` are installed, else inside the Rust image (`--container` asks for it). Copy it as `ff` anywhere on the `PATH`; it needs nothing else, and `ff version` names the commit it was built from. Releases for other systems, signed, come with the CLI plan's C-41.

## Build and test

Rust 1.91 or later (`rustup`; `hack/install-tools.sh rust` installs it in `hack/.rust` where there is none recent enough), from this folder:

```bash
cargo build --release --locked                                    # target/release/ff
cargo build --release --locked --target x86_64-unknown-linux-musl  # a static binary, with musl-gcc installed
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings
cargo test --locked                                                # unit tests, then the binary's own (tests/)
```

The binary's tests run `ff` with a settings folder of its own, against a scripted API (`tests/common/mod.rs`) that answers in order and records what it was sent. `ff version` names the commit from git at build time, or from `FF_BUILD_COMMIT` when the build sets it.
