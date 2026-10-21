# FF CLI plan: one `ff` command for developers

| | |
|---|---|
| **Status** | Started on 2026-10-21: its phases 0 to 2 are task U-08 of the [step-1 plan](step-1-plan.md), on that plan's branch, `feat/step-1`; the step-1 plan also built this plan's C-31 backend part and answered its question 1. What is done is in the progress log (§12). Brought up to date on 2026-10-21 with the platform as the [client-readiness plan](client-readiness-plan.md) left it: login and API keys exist, the logs API exists, and function names are unique and follow Lambda's rule (§1.2). Open questions for you are in §10. |
| **Replaces** | The plan in `cli/README.md`, which no longer matched the platform (§1). It was removed with the prototypes; git history has it, for example at commit `fb9d833`. |
| **Parent plan** | [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): finding H-10; tasks R-02 (in part) and R-10; ADR-007 (Rust) and ADR-009 (SAM); §6.1 packaging, §7.1 `ff export`, §7.4 `ff doctor` |
| **Builds on** | The [Kubernetes migration](kubernetes-migration-plan.md) (K-00 to K-12), the [client-readiness plan](client-readiness-plan.md) (accounts, API keys, logs, metrics, usage) and the [getting-started guide](getting-started.md) |
| **Decision records** | [ADR 0002](adr/0002-cli.md) (the CLI) in C-00, ADR 0003 (code delivery) in C-20. [ADR 0004](adr/0004-identity-and-tenancy.md) already names the CLI's Keycloak client, `ff-cli`, and its login flow. |
| **Comes next** | [What to build next](what-to-build-next.md): the CLI side of each new service is phase 5 here. Step 1's services (environment and secrets, function URLs, schedules) come from the [step-1 plan](step-1-plan.md) |

FF needs one command-line tool for developers. With it you write a function, run it locally in the same runtime it gets in production, deploy it, invoke it, read its logs, and later package it with dependencies, all with the packaging rules of AWS Lambda. That way a project built on FF can move to AWS without changes. Today that work is done with the `curl` commands in the getting-started guide. The two CLI prototypes that were in the repository couldn't do it (§1).

The plan has six phases. Each delivers something usable on its own:

| Phase | You get | Needs from the platform |
|---|---|---|
| **0. Groundwork** | One Rust CLI skeleton, and ADR 0002 | nothing |
| **1. The CLI on today's API** | `ff deploy`, `invoke`, `list`, `get`, `history`, `logs`, `scale`, `delete`, `init`, `local invoke` / `local start` for single-file functions, with an API key; then `whoami`, `account`, `usage`, `balance` and `metrics` | a larger request limit (C-03). Unique names are under way, and the logs API, API keys, metrics and usage exist. |
| **2. Packages with dependencies** | `ff package` and `ff deploy <dir>`: zips with `node_modules` or pip packages, Lambda-compatible | the code artifact pipeline (upload, validation, delivery to pods) and a glibc Node.js runtime |
| **3. AWS projects and the exit kit** | `ff deploy` from an AWS SAM `template.yaml`; `ff env`; `ff export --target aws`; `ff doctor` | function environment variables; the Lambda event shape (§10, question 1) |
| **4. Customer-ready** | `ff login` (the device flow: its Keycloak client exists), `ff api-keys`, signed releases for Linux, macOS and Windows, published runtime images, CI usage | nothing new: authentication exists since the client-readiness plan's P-11 and P-13 |
| **5. The services after functions** | `ff url`, `ff schedule`, async invokes, queues, buckets and secrets: one command set per service of [What to build next](what-to-build-next.md), as each ships | each service's API |

---

## 1. Why the old plan is replaced

### 1.1 The prototypes

A review of the two prototypes, `cli/` (Node.js, 234 lines) and `cli-rust/` (Rust, 383 lines), against the platform as it was on 2026-10-16. Both were then removed as dead code, and they remain in git history (for example at commit `fb9d833`):

| The old plan assumed | What is true now | Consequence |
|---|---|---|
| `ff upload` puts a zip in the MinIO bucket, and that deploys it | The backend deploys from the `code` string of `POST /functions` into a Kubernetes ConfigMap. It only *writes* an archive copy to storage and never reads zips back. | `ff deploy` would upload and report success, while nothing changes. SeaweedFS speaks the same S3 API MinIO did, so the upload even succeeds. |
| The CLI holds the storage credentials | They are the platform's storage keys | Fine on your laptop; never shippable to customers (parent finding H-10). A CLI must talk to the FF API only. |
| Zip layout: `dist/`, `node_modules/`, `package.json`, `tsconfig.json` | The runtimes, like Lambda, load the handler from the root of `/var/task`, with `node_modules/` (or Python packages) next to it | Packages built this way would not load |
| Two CLIs, Node.js and Rust | Parent ADR-007 chose **Rust**: a single static binary, easy to install offline, no Node.js needed | Two code bases for one job |
| Node.js 18, `npm install --production` | Node 18 is end of life; the flag is deprecated (`--omit=dev`). The CLI also ran it in the user's own folder, mutating their `node_modules`. | Rework in any case |
| No limits | **Measured, and still true on 2026-10-21:** the backend rejects request bodies over about 100 KB with `413 request entity too large`, for function code and for invoke input alike. The runtimes accept 900 KiB of code and 6 MB payloads. | Deploys and payloads over 100 KB fail today (fixed in C-03) |

Both prototypes are small, so starting cleanly costs little. The new CLI can borrow the Rust prototype's `clap` command structure and error type from git history.

### 1.2 The platform since then

The client-readiness plan ran from 2026-10-17 to 2026-10-20. This plan was written before it, so several of its assumptions are stale. Checked against the code on 2026-10-21:

| Then | Now | What changes here |
|---|---|---|
| No login. The tenant came from a development variable. | **Every route needs a Keycloak token or an API key** (P-11, P-13). An API key is `ffk_<key ID>_<secret>`, with scopes (`functions:read`, `functions:write`, `functions:invoke`, `logs:read`, `metrics:read`, `alarms:read`, `alarms:write`, `usage:read`), created in the console by an owner. Roles: `owner`, `developer`, `viewer`; a viewer can't deploy or invoke. A user with several accounts names one in the `X-FF-Account` header. The development stack has `FF_AUTH_MODE=dev`, where `X-FF-Dev-Account` picks the account, as `hack/e2e.sh` does. Both Keycloak realm files already hold a public client `ff-cli` with the device flow turned on and the `ff-api` audience. | Phase 1 works with an API key (D8, C-02). `ff login` (C-40) is no longer blocked; it can move up whenever you want (§10, question 7). New account commands (C-09). |
| No logs API | **Done by P-40 and P-43:** `GET /functions/:id/logs` (a page, oldest first, with `tail`, `sinceSeconds`, `start`, `end`, `limit`, a phrase `q`, `requestId`, and a `cursor`/`next` pair) and `GET /functions/:id/logs/stream`, the live tail as Server-Sent Events. Lines outlive their instance (the plan's `logRetentionDays`). 503 while the log store is unavailable. | C-05 is CLI-only, and `--follow` streams instead of polling |
| Names weren't unique | **Done on 2026-10-21, outside this plan** (commit `1bd102e`): a name belongs to one function of its account and follows Lambda's rule, 1 to 64 letters, digits, hyphens or underscores, compared exactly (`Hello` and `hello` are two names). A name outside the rule answers `400`, another create or rename with a name in use `409 Conflict`, and the migration renamed the duplicates already there. A name given before the rule is kept until the function is renamed. `GET /functions` has no `name` filter. | D3 and C-03 updated: the CLI resolves a name from the list, and checks Lambda's rule before it sends one; `ff export` maps an older name (§10, question 6, decided) |
| Invoke answered 200, or 400 on a function error | **201 with the invocation record** (P-08): `id`, `status` (`COMPLETED`, `ERROR`, `TIMEOUT`, `THROTTLED`), `duration`, `memoryUsed`, `output`, `error`. A function error or timeout answers 400 with `ErrorType: message`; a function that can't load, 400 "The function failed to load: …"; no free instance in time, 429; a platform failure, 500 with a request ID; no credit, 402 (P-33). **The invocation's ID is the request ID** that the runtime logs (P-20), so `ff invoke` prints it and `ff logs --request-id` finds the call's lines. | C-04 and D7 |
| No plans | **Plans** (P-15) set the account's limits: functions, memory and timeout per function, instances per function, changes per minute and invocations per second (429 with `Retry-After`), log and history retention, idle time, internet egress (off on `beta`). | C-02 honours `Retry-After` on reads; `ff account` shows the plan and egress |
| One instance per function | `minInstances` and `maxInstances` per function, `GET`/`PUT /functions/:id/scaling-config` (P-06, D14) | `ff scale` (C-04) |
| No metrics, usage or balance for customers | `GET /functions/:id/metrics` and `GET /metrics` (P-50), `GET /usage?month=` as JSON or CSV (P-22), `GET /billing/balance` (P-31), `GET /me` and `GET /accounts/:id` (P-12) | C-09 |
| `functions.userId` | `accountId` (P-12), 12 digits | C-03's note |
| Cold start "about 10 s" | 6 to 11 s at 128 MB under gVisor, of which 2 to 5 s loading the code (P-62) | §9 |
| NestJS 10 | NestJS 12 on TypeScript 6, Express 5, ESLint 10 (P-09, P-64) | C-03 |

## 2. Goals and non-goals

**Goals:**
- **One static binary, `ff`,** for Linux and macOS (Windows in phase 4). It needs no Node.js or Python to run, and it installs offline.
- **API only.** No storage keys, cluster credentials, or kubeconfig on developer machines. An API key from day one; a user login from `ff login`.
- **One account at a time.** A profile names its account, so every command acts on one account, as the API requires.
- **Lambda-compatible packages.** A zip built by `ff package` follows Lambda's rules: handler at the root, dependencies inside, the same size limits, and the same `CodeSha256`. Later, the project file is an AWS SAM `template.yaml` (parent ADR-009), so leaving FF is `sam deploy` with the same file.
- **Local runs equal production runs.** `ff local` uses the same runtime images and the same hardening as function pods: read-only root, uid 10001, no capabilities, the memory limit.
- **Scriptable.** Stable exit codes, `--output json` on every command, and non-interactive use in CI.

**Non-goals (for now):**
- **Replacing the AWS CLI.** The Lambda API facade (parent §6.6) is what will make `aws lambda …`, the SDKs, and Terraform work against FF. `ff` adds what AWS tools can't: local runs against FF's runtimes, FF logs, packaging checks, export, and doctor.
- **Managing the account.** Members, alarms, notification settings, payments and invoices stay in the console. The CLI reads usage, the balance and metrics, and manages API keys (C-40), since CI needs them.
- Server-side builds ("deploy from source"). Parent §6.1 keeps builds on the developer's side, with a build service later.
- Layers, versions and aliases (until parent R-01), and a terminal UI. Event sources come in phase 5, as the platform ships them.

## 3. Decisions

Decisions D1–D3, D5, D7 and D8 are recorded in [ADR 0002](adr/0002-cli.md) (task C-00). D4 is decided by a spike and recorded in ADR 0003 (C-20).

### D1. Rust, one binary, talking only to the API
- **Crates:**
  - `clap` (derive) and `clap_complete`;
  - `ureq` for HTTP: blocking and small, using `rustls` with the operating system's certificate store, so company CAs and TLS-inspecting proxies work. `HTTPS_PROXY` and `NO_PROXY` are honoured. Its streaming reader serves the live tail (Server-Sent Events are a plain text stream).
  - `serde` / `serde_json` (`serde_yaml` in phase 3), and `toml` for the configuration files;
  - `zip` (writer, deflate), with `sha2` and `base64` for `CodeSha256`;
  - `walkdir` and `ignore` (`.ffignore` in gitignore syntax);
  - `directories` (config paths), `anyhow` / `thiserror`, `humantime` (`--since 15m`), and `notify` (watch mode);
  - versions: the latest stable at implementation time, locked in `Cargo.lock`, built with `--locked`.
- **Not carried over from the Rust prototype:** `tokio` (no async runtime is needed for a CLI that does one request at a time), `s3`, and `dotenv`.
- **Static builds:** `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`; macOS and Windows targets in phase 4. The toolchain on the reference machine is Rust 1.91, so edition 2024 is available.

### D2. Configuration
- **Files:**
  - `~/.config/ff/config.toml` on Linux (`~/Library/Application Support/ff/` on macOS, `%APPDATA%\ff\` on Windows), with profiles:

    ```toml
    [profiles.default]
    endpoint = "http://localhost:3000"
    dev_account = "123456789012"      # development stack only: sent as X-FF-Dev-Account

    [profiles.staging]
    endpoint = "https://api.staging.ff.example"
    account = "210987654321"          # sent as X-FF-Account, for a user with several accounts
    ```

  - tokens go in a separate `credentials.toml`, created with mode 0600 and never printed: per profile, an API key, or the user token and refresh token from `ff login` (C-40);
  - `FF_CONFIG_DIR` names another folder for both, for CI and tests (added in C-02).
- **Precedence:** command-line flags, then environment variables (`FF_ENDPOINT`, `FF_PROFILE`, `FF_TOKEN`, `FF_ACCOUNT`), then the profile, then the default `http://localhost:3000`. There is no `--token` flag: a token on the command line ends up in the shell's history.
- **TLS:** plain `http://` is accepted only for `localhost` and `127.0.0.1`, unless `--allow-http` is given.

### D3. Functions are addressed by name, as on Lambda
`ff invoke hello`, not a UUID. Names are unique per account (§1.2), compared exactly, so a name always finds one function. The CLI finds it in `GET /functions` (a plan caps the number of functions, so the list is short); a `name` filter on that route is a convenience for later (C-03).

The API enforces Lambda's character rule, `^[A-Za-z0-9_-]{1,64}$` (parent M-4), on every name it is sent. A function named before the rule may keep a name outside it until it is renamed: `ff doctor` flags such a name, and `ff export` derives a logical ID from it and says so (§10, question 6).

### D4. How packaged code reaches the pods (ADR 0003, after the C-20 spike)
Inline code fits in a ConfigMap today, which is limited to 1 MiB. A zip with `node_modules` does not. The options:

| Option | How | For | Against |
|---|---|---|---|
| **A. Per-version image** *(recommended for the spike)* | The backend appends one layer (the validated zip under `/var/task`) to the runtime image and pushes it to an in-cluster registry, without a Docker daemon (the `crane append` technique). The Deployment uses `image: <registry>/ff/fn-<id>@sha256:…`. | kubelet pulls on the node network, so no hole in tenant NetworkPolicies. Nothing expires. Base layers are cached and shared, and the code layer is small. Native modules work. Customer container images (parent §6.1) later use the same path. Re-pullable images also remove the dev cluster's "image GC deleted the imported runtime" problem. | A registry becomes part of the platform: Zot or Harbor (parent §6.1); `registry:2` via k3d in development. The backend implements an OCI push (about 300 lines, testable) and garbage-collects old versions. |
| B. Init container fetches the zip | An init container downloads from S3 into an `emptyDir` mounted read-only at `/var/task` | No registry needed | A pre-signed URL in the pod spec expires (7 days at most), so a pod restarted later can't fetch its code. The alternative is tenant credentials in Secrets, which the backend deliberately can't manage today. Tenant pods are blocked from private addresses, so S3 needs a NetworkPolicy exception. |
| C. Image volume | Mount an OCI artifact as a volume (Kubernetes `ImageVolume`) | No layer building | Mounted `noexec`, according to the feature's design (to confirm in the spike), so native modules (`.node`, numpy's `.so`) can't load |
| D. Bigger ConfigMaps | Several ConfigMaps per function | No new parts | 1 MiB each; `node_modules` is often 10–100 MB |

### D5. Packaging follows Lambda's rules exactly
- **Layout:** the handler file at the zip root, and dependencies inside: `node_modules/` for Node.js, packages at the root for Python (`pip install -t`).
- **Limits:** 50 MB zipped for a direct upload, 250 MB unzipped.
- **`CodeSha256`** is the base64 SHA-256 of the zip, exactly as Lambda reports it.
- **Deterministic zips:** sorted entries, fixed timestamps (1980-01-01), and normalized permissions (0644, and 0755 for executables). The same source gives the same `CodeSha256`, so `ff deploy` can say "no changes" and skip the upload.
- **Excluded by default:** `.git/`, `.ffignore`d paths, `__pycache__/`, and `.env*`. Excluding `.env*` triggers a warning, since it usually holds secrets.

### D6. The Node.js runtime moves to a glibc base
`ff-runtime-nodejs` is built on `node:24-alpine` (musl). Native modules compiled on a normal Linux machine, or prebuilt for Lambda (Amazon Linux, glibc), don't load on musl. The Python runtime is already on Debian slim (glibc). Moving Node.js to `node:24-slim` makes Lambda zips with native dependencies run unchanged (C-25).

### D7. Output and exit codes

| Code | Meaning |
|---|---|
| 0 | Success (also "no changes" on deploy) |
| 2 | Usage error: unknown flag, bad argument (clap's standard) |
| 3 | Configuration, connection, or API error (the API was unreachable, or refused the request for a reason that isn't code 4, 5 or 6) |
| 4 | Deploy failed: the function did not become ready. The diagnostics are printed. |
| 5 | The invocation failed: the function raised (`ERROR`) or timed out (`TIMEOUT`) |
| 6 | Refused by the account, not by the request: no credit (402), a role or a key's scopes that don't allow it (403), or the plan's rate limits (429 with `Retry-After`). CI can tell "my deploy is broken" from "the account needs attention". |

Text output is for people. `--output json` prints one JSON document per command, with a documented, stable shape. Errors always go to stderr, and an API error's message is printed as the API wrote it, with its request ID when there is one.

### D8. Authentication: an API key first, a login later
- **Every request carries `Authorization: Bearer <token>`.** The token is an API key (`ffk_…`) or a user token from `ff login`. The API tells them apart by the prefix; the CLI doesn't need to.
- **Phase 1 uses API keys.** An owner creates one in the console's API keys page, with the scopes the CLI needs (`functions:read`, `functions:write`, `functions:invoke`, `logs:read`; `metrics:read` and `usage:read` for C-09), and puts it in `FF_TOKEN` or `ff config set-token`. An API key acts on its own account, so no account header is needed.
- **`ff login` (C-40)** is the OAuth device flow against Keycloak's `ff-cli` client, which exists in both realm files with the `ff-api` audience. A user token may act on any of the user's accounts: the profile's `account`, or `--account`, goes into `X-FF-Account`. When the API answers 400 "This user belongs to several accounts", the CLI lists them (`GET /me`) and says how to pick one.
- **The development stack** runs with `FF_AUTH_MODE=dev` and needs no token. The profile's `dev_account` is sent as `X-FF-Dev-Account`, so the CLI's tests can act as a second account exactly as `hack/e2e.sh` does.
- **A 403 names what is missing:** the scope the key lacks, or the role the user would need. A 401 says whether the token is missing, expired or revoked, as the API's message does.

## 4. Commands (target)

| Command | What it does | Phase |
|---|---|---|
| `ff config set <key> <value>`, `ff config show`, `ff config set-token` | Endpoint, account and profile settings; the token, read from a prompt or stdin, never from an argument | 1 |
| `ff init <name> --runtime nodejs\|python` | A function folder: handler, `events/event.json`, README | 1 (SAM layout in 3) |
| `ff deploy <file\|dir> [--name] [--memory] [--timeout] [--handler] [--min-instances] [--max-instances]` | Create, or update by name. Sends only what changed, waits until the new version is live, and prints the diagnostics if it never gets there. | 1: one file; 2: folder as zip; 3: `template.yaml` |
| `ff list`, `ff get <name>` | Functions and their state; `get` shows the error of a function in `ERROR`, and its instances | 1 |
| `ff invoke <name> [--data JSON\|@file\|-] [--raw]` | Invoke and print the output, the request ID, the duration, the memory used, and the error if any (exit 5) | 1 |
| `ff history <name> [--limit N]` | Recent invocations: time, request ID, status, duration, error | 1 |
| `ff logs <name> [--tail N] [--since 15m] [--grep phrase] [--request-id ID] [--follow]` | The function's logs from the log store: START/END/REPORT lines, user output, errors. `--follow` is the live tail. | 1 |
| `ff scale <name> [--min N] [--max N]` | The function's instances: the minimum kept warm (billed as provisioned concurrency), and the most it may run | 1 |
| `ff delete <name> [--yes]` | Delete (asks first in a terminal) | 1 |
| `ff local invoke <file\|dir> [--data …]` | Run once in the production runtime image on Docker, and print the output and logs | 1 |
| `ff local start <file\|dir> [--port] [--watch]` | Keep it running on a local port; `--watch` restarts it when files change | 1 |
| `ff whoami`, `ff accounts` | The token's user and account, and the user's accounts with their roles | 1 |
| `ff account` | The current account: status, plan, role, internet egress | 1 |
| `ff usage [--month YYYY-MM] [--csv]`, `ff balance` | The month's usage per function with its estimated cost, and the account's balance | 1 |
| `ff metrics [<name>] [--period 60\|300\|3600] [--since 1h]` | Invocations, errors, throttles, duration percentiles, cold starts and instances, for one function or the whole account | 1 |
| `ff package <dir> [-o file.zip] [--container]` | Build a Lambda-compatible zip; `--container` builds inside the runtime image for an exact platform match | 2 |
| `ff env list\|set\|unset <name> …` | A function's environment variables, with `--env KEY=value` on deploy | 3 |
| `ff export --target aws [<name>…]` | `template.yaml`, code zips, and a migration checklist (parent §7.1, first slice) | 3 |
| `ff doctor [<dir>]` | Portability linter (parent §7.4, first slice) | 3 |
| `ff login`, `ff logout` | Device-flow login and tokens | 4 |
| `ff api-keys create\|list\|revoke` | API keys for CI, by an owner logged in with `ff login` | 4 |
| `ff url enable\|disable\|show <name>`, `ff domains …` | A function's public web address and custom domains | 5 |
| `ff schedule set\|remove <name>` | Run a function on AWS's `cron()` or `rate()` schedule | 5 |
| `ff invoke --async`, `ff queues …`, `ff event-sources …` | Background work: async invokes, queues, and functions that read them | 5 |
| `ff buckets …`, `ff secrets …` | File storage and secrets | 5 |
| `ff version`, `ff completion <shell>` | | 1 |

**Global flags:** `--profile`, `--endpoint`, `--account`, `--output text|json`, `--quiet`, `--verbose`, `--no-color`.

**What a phase-1 session looks like:**

```text
$ export FF_TOKEN=ffk_…                                  # an API key from the console, or ff config set-token
$ ff whoami
key "laptop" on account 123456789012 (Acme Dev, plan beta)
$ ff init hello --runtime python
created hello/function.py, hello/events/event.json
$ ff local invoke hello --data @hello/events/event.json
{"message": "Hello world", "requestId": "…"}        0.21 ms · 36 MB
$ ff deploy hello/function.py --name hello
creating hello (python, 128 MB, 5 s) … ACTIVE in 6.4 s
$ ff invoke hello --data '{"name": "Tunis"}'
{"message": "Hello Tunis"}        0.17 ms · 36 MB · request 7d1e…
$ ff logs hello --tail 4
START RequestId: 7d1e… Version: $LATEST
greeting Tunis
END RequestId: 7d1e…
REPORT RequestId: 7d1e…  Duration: 0.17 ms  Billed Duration: 1 ms  Memory Size: 128 MB  Max Memory Used: 36 MB
```

## 5. Architecture

```
developer machine                                   FF platform
┌────────────────────────────┐   HTTPS + token  ┌─────────────────────────────────────────────┐
│ ff                         │ ───────────────▶ │ backend API                                 │
│  ├─ API client             │                  │  ├─ functions, invocations, scaling         │
│  ├─ packager (zip, D5)     │                  │  ├─ logs: pages and a live tail (log store) │
│  └─ local runner ──┐       │                  │  ├─ me, accounts, usage, balance, metrics   │
└────────────────────│───────┘                  │  ├─ artifact pipeline (phase 2): validate,  │
                     │             device flow  │  │   store in S3, build the version image   │
                     │            (phase 4) ──▶ │  └─▶ Kubernetes: Deployment per function    │
                     ▼                          └─────────────────────────────────────────────┘
        docker: ff-runtime-* image                Keycloak (ff-cli)   registry ◀── kubelet pulls (phase 2)
        (same hardening as production pods)
```

- **Source layout.** The CLI lives in `cli/`:
  - `src/main.rs` (clap);
  - `config.rs` and `auth.rs`;
  - `api/` (client, types, error mapping);
  - `commands/` (one file per command);
  - `package/` (rules, zip writer, builders);
  - `local/` (docker runner);
  - `output.rs`;
  - tests under `tests/`.
- **Deploy in phase 1.** `POST /functions` or `PUT /functions/:id` with the code inline, as the guide's `curl` commands do. The API already waits until the version is live (up to `FF_READY_TIMEOUT_SECONDS`, 90 s), and answers in seconds when the code can't load. The CLI's read timeout is therefore longer than that.
- **Invoke.** `POST /functions/:id/invoke {"input": …}` answers 201 with the invocation: its `id` (the request ID), `status`, `duration`, `memoryUsed`, `output`. The API answers 400 when the function raises or times out (`ErrorType: message`), which the CLI maps to exit code 5; 429 when no instance could take the call in time or the plan's rate is reached; 402 without credit; 500 with a request ID on a platform failure. The Lambda-shaped answer (200 with `X-Amz-Function-Error`) belongs to the API facade (parent §6.6), not to this API.
- **Deploy in phase 2.** `ff package` builds the zip, then `ff deploy` compares its `CodeSha256` with the function's, uploads only when it differs, and waits for the rollout.
- **Local runs.** The CLI starts the runtime container with production's flags:
  - `--read-only --tmpfs /tmp --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --memory <m>m`;
  - the variables the backend sets (`BE/src/orchestrator/kubernetes/manifests.ts`): `FUNCTION_NAME`, `FUNCTION_VERSION=$LATEST`, `FUNCTION_MEMORY_LIMIT`, `FUNCTION_TIMEOUT` (milliseconds), `FF_MAX_QUEUE_WAIT_MS`, `LAMBDA_TASK_ROOT=/var/task`, `FF_HANDLER=function.handler`, `PORT`, `TZ=UTC`;
  - the code mounted read-only at `/var/task`, and the port published on `127.0.0.1` only.

  It then waits for `/readyz` (showing the init error if loading fails) and posts the payload to `/invoke`, the same protocol the platform uses. The payload is the event, as on Lambda (runtime protocol v3, [ADR 0007](adr/0007-function-events.md)); `ff local` passes `FF_EVENT_FORMAT` as the function's `eventFormat` says, so a local run sees exactly what a production call sees.

## 6. Platform changes the CLI needs

| Change | Why | Task | State on 2026-10-21 |
|---|---|---|---|
| Raise the API's JSON body limit to 7 MB. Check code against the real 900 KiB limit, and invoke input against Lambda's 6 MB, with clear messages. | The measured 100 KB default blocks both | C-03 | **done** (C-03): 7 MB on the routes that need it, 100 KB elsewhere |
| Unique function names per account | Address functions by name (D3) | C-03 | **done** (`1bd102e`, §1.2) |
| Lambda's naming rule, and `GET /functions?name=` | Portability; a shortcut for the CLI | C-03 | **done**: the rule (`1bd102e`), the filter (C-03) |
| `GET /functions/:id/logs` and `/logs/stream` | `ff logs` without cluster access | C-05 | **done** (P-40, P-43) |
| Authentication: tokens, API keys, the `ff-cli` client | `ff` for customers and CI | C-02, C-40 | **done** (P-11, P-13; the realm has the client) |
| Metrics, usage, balance, `/me` and `/accounts/:id` | `ff metrics`, `ff usage`, `ff balance`, `ff accounts` | C-09 | **done** (P-12, P-22, P-31, P-50) |
| `GET /me` for an API key, whatever its scopes: the key and its account (it took a user's token only) | `ff whoami` with a key, the first check of a new key | C-02 | **done** (C-02) |
| Function fields `packageType`, `handler`, `codeSha256`, `codeSize`; handler resolution with `.mjs` | Zip packages; Lambda handler names | C-21 | not started |
| Upload, validation, and artifact storage | Zip packages, safely | C-22 | not started |
| Version images and a registry (if ADR 0003 picks option A) | Delivering zips to pods (D4) | C-23 | not started |
| Node.js runtime on glibc | Native modules (D6) | C-25 | not started |
| Function environment variables (Lambda limit: 4 KB), and secrets | SAM `Environment`, and everyday configuration | C-31, C-53 | under way: the [step-1 plan](step-1-plan.md)'s U-01 and U-02 |
| `GET /functions/:id/code` (the zip, or the inline file) | `ff export` | C-32 | not started |
| The Lambda event shape | Portability of handler code (§10, question 1) | Parent R-04 | under way: the [step-1 plan](step-1-plan.md)'s U-03 |
| Function URLs and schedules | Phase 5 | Parent E-01, E-02 | under way: the [step-1 plan](step-1-plan.md)'s U-04 to U-07 |
| Async invokes, queues, buckets | Phase 5 | Parent E-03 to E-05 | not started; steps 2 and 3 of [What to build next](what-to-build-next.md) |

## 7. Working rules

These are the same as the Kubernetes migration and the client-readiness plan:
- `hack/check-resources.sh` runs before every heavy step: builds, Docker runs, cluster tests.
- One heavy operation at a time.
- Work on the step-1 plan's branch, `feat/step-1`, since phases 0 to 2 are its U-08 (the branch `feat/cli` this plan first named isn't made), with one commit per task: `type(scope): summary (C-xx)`. Task numbers go in commit messages and in this plan, not in code comments, tests or API documentation, which explain their context in plain words instead.
- Each task's progress row records its tests and documentation.
- The CLI's checks join `hack/ci.sh` (C-08), and `hack/install-tools.sh` installs the Rust toolchain it needs.

**Test levels:**

| Level | What | Tool |
|---|---|---|
| L0 | `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build --locked` | cargo |
| L1 | Unit tests: config precedence, error mapping, name rules, packaging rules, zip determinism, docker argument building | `cargo test`, `insta` snapshots |
| L2 | The real `ff` binary against a mock API: commands, outputs, and exit codes, black-box. The mock's bodies are copied from the API's documented examples (Swagger UI at `/api`), and L3 catches drift between the two. | `assert_cmd`, `predicates`, `tempfile`, and a scripted API of the tests' own (`cli/tests/common`), which answers in order, as retries and streams need |
| L3 | Against the dev stack (backend plus k3d) and Docker: `hack/cli-e2e.sh` deploys, invokes, logs, updates, deletes, and runs locally, for both runtimes, in `FF_AUTH_MODE=dev` with a `dev_account` like `hack/e2e.sh` | bash, like `hack/e2e.sh` |
| L4 | Portability (phases 2 and 3): zips checked against Lambda's packaging rules, and the exported `template.yaml` against SAM's schema (`sam validate`, where the SAM CLI is available) | bash |

A task is done when its tests pass at the levels listed, the docs it touches pass `hack/check-docs.py`, and the progress log row is filled in.

## 8. Tasks

### Phase 0: groundwork

#### C-00: Preparation and ADR 0002
- **Steps:**
  - Create the branch.
  - Write `docs/adr/0002-cli.md`, recording D1, D2, D3, D5, D7 and D8, and naming the parent's ADR-007 and ADR-009 and ADR 0004's `ff-cli` client.
- **Done when:** `hack/check-docs.py` passes on the new and changed documents.

#### C-01: One CLI
- **Create** the Rust project in `cli/`. Both prototypes were already removed as dead code; the Rust one's `clap` structure and error type can be borrowed from git history (`fb9d833`). The binary is `ff`, with edition 2024 and the dependencies of D1.
- **Skeleton:**
  - the global flags;
  - `ff version` (version and git commit, embedded at build time);
  - `ff completion`;
  - an error type mapped to exit codes (D7);
  - an output module (text or JSON).
- **Tests:** L0; L1 for the exit-code mapping; L2 that `ff --help` lists the commands and that an unknown command exits 2.
- **Done when:**
  - `cargo build --release --locked` produces `target/release/ff`;
  - `cargo tree` shows no S3 or tokio crates;
  - nothing in the repository refers to the Node.js CLI any more.

### Phase 1: the CLI on today's API

#### C-02: Configuration, authentication and the API client
- **Config:** files, profiles, and precedence (D2); `ff config set`, `ff config show` (the token shown as `ffk_1a2b…` only) and `ff config set-token`, which reads the token from a prompt or stdin. The TLS rule: refuse `http://` outside localhost unless `--allow-http`.
- **Authentication (D8):** `Authorization: Bearer` from `FF_TOKEN` or `credentials.toml`; `X-FF-Account` from `--account`, `FF_ACCOUNT` or the profile; `X-FF-Dev-Account` from the profile's `dev_account`. Without any token, and without `dev_account`, the CLI says how to get a key before it calls the API.
- **API client:**
  - timeouts: connect 5 s; read 120 s for deploys (the API waits up to 90 s for readiness); for invokes, the function timeout, plus one more for the wait for a free instance (D14 of the client-readiness plan), plus 90 s (cold start) plus a margin;
  - sends `User-Agent: ff-cli/<version>`;
  - maps the API's error bodies (`{statusCode, message, error}`, and a request ID when the API gives one) to typed errors: 401 and 403 name what is missing; 402, 403 and 429 become exit 6; a 429 on a read (list, get, history, logs) is retried once after `Retry-After`, never a write;
  - 503 from the logs routes ("the log store is unavailable") is reported as such, exit 3.
- **`ff whoami`** comes here rather than in C-09: it is how a key is checked once saved, and the client's first call. It needed the backend to answer `GET /me` for an API key (it took a user's token only), which this task does.
- **Tests:** L1 for precedence, the TLS rule, the headers sent, and error mapping; L2 against the scripted API (an unreachable API exits 3 with the address in the message; a 403 names the scope; a 429 read is retried once).

#### C-03: Backend: request limits and function names
- **Limits:**
  - the JSON body limit raised to 7 MB where the app is set up (`BE/src/app-setup.ts`), on NestJS 12;
  - code limited to 900 KiB (in bytes, checked in the DTO, with a message that names the limit);
  - invoke input limited to 6 MB once serialized, answered with 413 and `RequestEntityTooLargeException`, Lambda's name.
- **Names.** Unique names per account, with Lambda's rule, were done outside this plan (§1.2): the unique index on `(account_id, name)`, `400` for a name outside the rule, `409 Conflict`, and the migration that renamed duplicates. What this task adds:
  - `GET /functions?name=<name>`, so the CLI needn't list to resolve a name.
- **Tests:**
  - L1: DTO validation, and the conflict on create and on rename.
  - The e2e script gains checks that 150 KB of code is accepted, 1 MB is refused with the clear message, and a 1 MB input is accepted.
- **Docs:** the limits in the getting-started guide and the README, which both still say "about 100 KB".

#### C-04: Core commands
- **`ff deploy <file>`:**
  - the name comes from `--name`, else the file name without its extension; a name outside Lambda's rule is refused before anything is sent, with the rule (D3);
  - the runtime comes from the extension (`.ts`, `.js`, `.cjs` → `nodejs`; `.py` → `python`), or `--runtime`;
  - the CLI looks the name up in the list, then creates the function or updates it with only the changed fields; `--min-instances` and `--max-instances` go to `PUT /functions/:id/scaling-config` after the rollout;
  - "no changes" when the SHA-256 of the code equals the server's;
  - a spinner while the API waits for the rollout, and on failure the API's diagnostics with exit 4 (a function that failed to load stays, in `ERROR`, with its error in `ff get`);
  - a 409 on create means another deploy took the name first: the CLI reloads the list and updates that function; a 409 on a rename ("the new version is live, but the function keeps its name") is printed as the API says it, exit 3;
  - a 400 naming the plan ("The beta plan allows 5 per account") is printed as is, exit 3.
- **`ff invoke`:**
  - `--data` takes inline JSON, `@file`, or `-` for stdin;
  - prints the output (pretty-printed in text mode), the request ID, the duration and the memory used;
  - on `ERROR` or `TIMEOUT`, prints the error on stderr and exits 5; on 429 (no instance in time, or the plan's rate), 402 and 403, exits 6;
  - `--raw` prints only the output, for pipes.
- **`ff list`, `ff get`, `ff history`** print tables, or JSON. `get` shows the stored error of a function in `ERROR`, its `minInstances` and `maxInstances`, and whether it scales to zero. `history` shows each call's request ID, so `ff logs --request-id` can follow it.
- **`ff scale <name> --min N --max N`** calls `PUT /functions/:id/scaling-config` and prints the result; the plan's `instancesPerFunction` bounds both, and the API's message says so.
- **`ff delete`** asks for confirmation in a terminal, unless `--yes` is given. With no terminal (CI), it requires `--yes`.
- **Tests:**
  - L1: name and runtime inference, the Lambda-rule warning, and change detection;
  - L2: each command against the mock, including the exit codes and the 409 paths;
  - L3: `hack/cli-e2e.sh` runs deploy → invoke → scale → update → history → delete for `examples/hello.ts` and `examples/hello.py`, plus the error and timeout paths with `examples/slow.py`, as a second account where the first account's functions answer 404.

#### C-05: Logs
- **Backend: done.** `GET /functions/:id/logs` (P-40, then P-43) answers `{ lines: [{ time, instance, requestId, stream, message }], next }`, oldest first, from the log store, for the plan's retention. `tail`, `sinceSeconds`, `start`, `end`, `limit`, `q` (a phrase), `requestId` and `cursor` narrow it; `next` leads to older lines. A line's `instance` is null on the store's notice of dropped lines, whose `stream` is `ff`. `GET /functions/:id/logs/stream` is the live tail, as Server-Sent Events: a `message` event per line, a `ping` every 15 s, an `end` after 30 minutes, an `unavailable` event when the store fails. Another account's function answers 404 as JSON before the stream.
- **CLI:** `ff logs <name>`:
  - `--tail N` (default 100), `--since 15m|2h|1d` (to `sinceSeconds`) or `--start`/`--end` (RFC 3339), `--grep <phrase>` (to `q`), `--request-id <id>`;
  - `--all` follows `next` until the window is exhausted;
  - `--follow` opens the stream, prints each line as it comes, reopens it on `end`, waits 5 s and reopens on `unavailable` for up to a minute, then exits 3; through a proxy that buffers streams, `--follow --poll` falls back to polling with `sinceSeconds` every 2 s, dropping lines already printed;
  - text mode prints `time [instance] message`, with the request ID under `--verbose`; JSON mode prints one line per JSON object;
  - the store's notice of dropped lines is printed as a warning, not as a function line.
- **Tests:** L1 for the duration parser and the stream parser (events split across reads, `ping`, `end`, `unavailable`); L2 CLI against the mock, including a paged window and a stream; L3 for a `print` in a function showing up in `ff logs`, and in `ff logs --follow`, within 10 s.

#### C-06: Local runs (`ff local invoke`, `ff local start`)
- **Docker:** checks `docker version` and says clearly when Docker is missing.
- **Image:**
  - from `FF_RUNTIME_IMAGE_NODEJS` / `_PYTHON`, else `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`;
  - built locally in this repository; published images come in C-42.
- **The container gets production's hardening and settings** (§5):
  - memory from `--memory`, default 128 MB; the timeout from `--timeout`, default 5 s, sent in milliseconds as `FUNCTION_TIMEOUT`;
  - a single file is mounted as `/var/task/function.<ext>`, a folder as `/var/task`, both read-only; the Node.js runtime loads `.ts`, `.js` and `.cjs` (`.mjs` comes with C-21);
  - a random port on `127.0.0.1`.
- **`ff local invoke`:**
  - waits for `/readyz` and prints the init error if loading fails;
  - posts the event and prints the output, the `X-FF-Duration-Ms` and `X-FF-Max-Memory-Used-Mb` headers, the error when `X-FF-Function-Error` is set (exit 5), and the container's log lines;
  - removes the container, even after Ctrl-C.
- **`ff local start`** keeps the container running and prints its address. `--watch` restarts it when a file changes (about 1 s, debounced).
- **Tests:** L1 for the docker argument builder; L3 with real Docker: hello in both runtimes, an init error, a timeout, and an out-of-memory error (the runtimes report all of these).

#### C-07: `ff init` and examples
- `ff init <name> --runtime nodejs|python` creates `<name>/function.<ext>`, `<name>/events/event.json`, and `<name>/README.md` from templates embedded in the binary. The templates follow the event shape decided in §10, question 1, which is why that question comes before this task.
- **Tests:** L1 snapshots of the generated files; L3 for init → local invoke → deploy → invoke.

#### C-08: Phase-1 release and docs
- **Build:** `hack/build-cli.sh` makes the static Linux build (`x86_64-unknown-linux-musl`), writes a SHA-256 checksum, and runs the resource check first. It can build inside `rust:alpine` when the musl target isn't installed.
- **CI:** `hack/ci.sh` gains the CLI's L0 to L2 next to the backend's levels, and `hack/cli-e2e.sh` next to `hack/e2e.sh`; `hack/install-tools.sh` installs the Rust toolchain.
- **Docs:** `cli/README.md` becomes the command reference. The getting-started guide gains "Using the CLI": the CLI equivalents of its `curl` commands in "Use FF" and "Everyday tasks", starting with the API key.
- **Done when:** on the dev stack, `ff deploy examples/hello.py --name hello && ff invoke hello --data '{"name": "x"}'` works, and `hack/cli-e2e.sh` is green in CI.

#### C-09: Account, usage, balance and metrics
- **`ff whoami`** came with C-02: `GET /me`, the user (or the key's name and scopes) and the current account with its role. **`ff accounts`:** the user's accounts, from the same call.
- **`ff account`:** `GET /accounts/:id` for the current account: name, status, plan, role, internet egress (so a developer whose `fetch` fails learns why), and the plan's limits from its view when the API exposes them.
- **`ff usage [--month YYYY-MM] [--csv]`:** `GET /usage?month=`, as a table per function (requests, GB-seconds, estimated cost, the calls not billed), or the API's CSV with `Accept: text/csv`.
- **`ff balance`:** `GET /billing/balance`, with the low-balance state when the API reports one.
- **`ff metrics [<name>] [--period 60|300|3600] [--since 1h]`:** `GET /functions/:id/metrics` or `GET /metrics`, a table with a row per period: invocations, errors, throttles, duration (average, p50, p95, p99, maximum), cold starts, instances.
- **Scopes:** `metrics:read` and `usage:read`; `ff whoami` and `ff account` need none beyond a valid token. A missing scope is named, exit 6.
- **Tests:** L1 for the month and period parsing; L2 against the mock; L3 for `ff usage` after the e2e invocations, and `ff metrics hello` showing them.

### Phase 2: packages with dependencies

#### C-20: Spike and ADR 0003, code delivery
- **Prototype option A on k3d:**
  - add a registry to the dev cluster (`k3d registry create`, then `--registry-use` in `cluster-up.sh`);
  - push a runtime image, append a code layer with `crane append` (for the spike only);
  - deploy by digest with the production pod settings.
- **Measure:**
  - cold start against the ConfigMap path;
  - that numpy and a native Node.js module load under `readOnlyRootFilesystem`;
  - that kubelet can re-pull after image GC.
- **Check briefly:** option B's expiry and NetworkPolicy issues, and whether option C's image volumes are `noexec`.
- **Done when:** ADR 0003 records the choice, with the measurements.

#### C-21: Function model v2 (backend)
- **New fields:**
  - `packageType` (`inline` or `zip`);
  - `handler`: `function.handler` for inline code; Lambda's `file.export` or `module.function`, with subdirectories, for zips;
  - `codeSha256` (base64, as Lambda reports it), and `codeSize`;
  - `imageDigest`, if option A is chosen.
- **Wiring:** `FF_HANDLER` comes from `handler` in the manifests. The Node.js worker also looks for `.mjs`, besides `.ts`, `.js`, and `.cjs`.
- **Plus:** validation, a migration, and the fields in API responses.
- **Tests:** L1 for the DTOs and manifests (`FF_HANDLER`); Node.js runtime L1 for an `.mjs` handler.

#### C-22: Upload and validation (backend)
- **Upload:**
  - `PUT /functions/:id/code` with `Content-Type: application/zip`, under the `functions:write` scope;
  - streamed to disk and refused beyond 50 MB, Lambda's direct-upload limit;
  - for larger packages (up to 250 MB unzipped), later: `POST /uploads` returns a pre-signed S3 URL, then `PUT /functions/:id/code {"uploadId": …}`.
- **Validation** with `yauzl` (a new backend dependency), refusing:
  - absolute paths, `..`, backslashes, and NUL bytes in names;
  - symbolic links (in v1);
  - more than 250 MB unzipped, or more than 20,000 files;
  - compression ratios that suggest a zip bomb;
  - a handler module that doesn't exist (for example `src/app.handler` needs `src/app.js|.mjs|.cjs|.ts` or `src/app.py`).
- **Storage:** content-addressed, `artifacts/<account>/<function>/<sha256>.zip`. An identical upload is a no-op.
- **Tests:** L1 with crafted zips (zip-slip, a bomb, symlinks, a missing handler, too large, an empty zip); L3 uploading through the API.

#### C-23: Version images and the registry (backend; option A)
- **Layer:**
  - built from the validated zip: a tar of the entries under `var/task/`, owned by 0:0, mode 0444 for files, 0555 for folders and executables;
  - gzip-compressed, with the layer digest and `diff_id` computed;
  - deterministic.
- **OCI push:**
  - mount the base layers from the runtime image's repository (the same registry), and upload the code layer;
  - write a config: the base config plus the new `diff_id`, history, and the labels `ff.dev/function-id` and `ff.dev/code-sha256`;
  - write the manifest and record its digest.
- **Deployment:** the image by digest. The code ConfigMap is not used for zip packages.
- **Garbage collection:** keep the current and the previous version per function; delete older manifests through the registry API. Zot also collects garbage itself.
- **Dev cluster:**
  - `cluster-up.sh` creates the registry;
  - `load-images.sh` pushes the runtime images to it instead of importing them.
- **Tests:**
  - L1: layer determinism, and the manifest and config against fixtures;
  - L1: the push against an in-process fake registry (mounts, uploads, a retry after an interruption);
  - L3: a zip function deployed through the real registry.

#### C-24: Inline code on the same path (decided in ADR 0003)
- If option A is chosen, turn inline code into a one-file zip inside the backend, so there is one delivery path. ConfigMaps for code, and their 900 KiB limit, then disappear.
- The API's `code` field stays, for the console and quick edits.

#### C-25: Node.js runtime on glibc
- Move to `node:24-slim`, keeping the same hardening. Record the size difference in the runtime README.
- **Tests:** runtime L1 and L2; L3 for a zip whose native module (for example `bcrypt`, prebuilt for linux-x64-gnu) loads.

#### C-26: `ff package` and zip deploys (CLI)
- **Project detection:** `package.json` means Node.js; `requirements.txt` or `pyproject.toml` means Python.
- **Build in a staging copy,** never in the user's folder:
  - Node.js: `npm ci --omit=dev` (or `npm install --omit=dev` when there is no lockfile), and `npm run build` when that script exists;
  - Python: `pip install -r requirements.txt -t <staging> --platform manylinux2014_x86_64 --python-version 3.13 --only-binary=:all:`, so the wheels match the runtime, not the developer's machine.
- **`--container`** runs the same build inside the runtime image. Its platform then matches exactly, like `sam build --use-container`.
- **TypeScript:** FF runs `.ts` files directly, but AWS needs JavaScript. `ff package` keeps `.ts` by default; `--compile` (and `ff export`) runs the project's `tsc`.
- **The zip:** follows D5, with the size checks run before uploading.
- **`ff deploy <dir>`:** package, compare `CodeSha256`, upload if changed, wait, print.
- **Tests:**
  - L1: rules, exclusions, and determinism (the same input gives the same `CodeSha256`, twice);
  - L2: against the mock;
  - L3: a Node.js function using an npm package, a Python function using `requests`, and a Python function using numpy (native wheels).

#### C-27: Phase-2 docs and e2e
- `hack/cli-e2e.sh` gains the zip cases.
- The getting-started guide gets "Functions with dependencies".
- The runtime READMEs describe handlers in subfolders and the zip layout.

### Phase 3: AWS projects and the exit kit

#### C-30: Deploying from a SAM `template.yaml` (parent ADR-009)
- **`ff init --template sam`** creates the layout of `sam init`: `template.yaml`, `src/`, `events/`.
- **`ff deploy`**, with no argument, reads the template's documented subset:
  - `Globals`;
  - `AWS::Serverless::Function` with `CodeUri`, `Handler`, `Runtime`, `MemorySize`, `Timeout`, `Environment.Variables`, and `Architectures` (`x86_64` only);
  - `Parameters`;
  - `!Ref` and `!Sub` within that subset.
- **Runtime names map** as follows: `nodejs22.x` and `nodejs24.x` → `nodejs`; `python3.12` and `python3.13` → `python`. Other runtimes are refused, with the supported list.
- **Anything outside the subset** fails with one message listing every unsupported key and resource. `Events` (schedules, queues, URLs) join the subset in phase 5, with parent E-10.
- **Tests:** L1 for template fixtures (valid, unsupported, malformed); L3 for a `sam init` hello world deployed unchanged; L4 `sam validate` on the fixtures, where available.

#### C-31: Function environment variables (backend and CLI)
- **The backend part is the [step-1 plan](step-1-plan.md)'s U-01** (its D1, D3 and D4): `environment`, a map of names to values, Lambda's rules for names, the names Lambda reserves and FF's own refused, at most 4 KB as Lambda measures it, encrypted at rest, delivered through a Kubernetes Secret that the backend writes and never reads. Variables are readable like the code; values no one may read back are secrets (U-02, and C-53 here).
- **CLI:** `--env KEY=value` on `ff deploy` (repeatable), and `ff env list|set|unset <name>`: `list` hides values unless `--show`; `set` reads a value from stdin when none is given, so secrets stay out of the shell's history. `ff local` passes `--env` to the container.
- **Secrets:** `ff secrets`, C-53, on the step-1 plan's U-02.
- **Tests:** L1 for validation and manifests, and the CLI's parsing; L3 for a function reading its variable, deployed with `--env` and changed with `ff env set`.

#### C-32: `ff export --target aws` (parent §7.1, first slice)
- For each function, `ff export` writes a SAM `template.yaml`: runtime names mapped back, `Handler`, `MemorySize`, `Timeout`, `Environment` (names only, unless `--with-values`), and `minInstances` as provisioned concurrency.
- A name from before Lambda's rule became the API's, outside it, becomes a logical ID made of its letters, digits, `_` and `-`, and the export's checklist lists each such rename (D3).
- It also writes the code zips, compiled to JavaScript for Node.js. The backend gains `GET /functions/:id/code` for this.
- It adds a `MIGRATION.md` checklist. Terraform output comes later.
- **Tests:** L1 for the generated template against fixtures, including a renamed function; L4 `sam validate` on the output; L3 for an export after a deploy.

#### C-33: `ff doctor` (parent §7.4, first slice)
- **Static checks on a project:**
  - memory, timeout, and payload beyond Lambda's limits;
  - a function name from before the API took Lambda's rule, outside it (D3);
  - writes outside `/tmp` (heuristic);
  - FF-only environment variables and hard-coded FF endpoints;
  - deprecated runtimes;
  - **reading the payload from `event.body`**, FF's original event, which a function made before 2026-10-21 keeps until it is switched ([ADR 0007](adr/0007-function-events.md)), and which differs from Lambda's.
- **Output:** a list with file and line. `--strict` makes warnings fail with exit 1.
- **Tests:** L1 for fixtures, one per check.

### Phase 4: customer-ready

#### C-40: `ff login` and API keys
- **The device flow** (RFC 8628) against Keycloak's `ff-cli` client, which both realm files already define as a public client with the device grant turned on and the `ff-api` audience. The CLI prints the verification address and the code, opens the browser when there is one, and polls the token endpoint at the interval Keycloak gives. Tokens go in `credentials.toml` (0600), with the refresh token; a refresh happens before a call when the access token is about to expire, and a failed refresh says to log in again.
- **`ff logout`** removes the profile's tokens. `ff whoami` (C-02) then shows the user and the chosen account.
- **`ff api-keys create --name <n> --scopes a,b [--expires 90d]`, `list`, `revoke <id>`:** `POST`, `GET` and `DELETE /api-keys`. Only an owner's user token may manage keys, which is why this task comes with the login. The new key is printed once, and `--output json` gives it in a field, for scripts.
- **Not blocked any more:** this task was waiting for the parent's F-01/R-08, done by the client-readiness plan's P-11 and P-13. It can move to phase 1 (§10, question 7).
- **Tests:** L2 for the device flow against a mock authorization server (pending, slow-down, expired, success), the refresh, and the keys; L3 against the development realm (`docker compose --profile auth`), when it is up.

#### C-41: Distribution
- **Builds:** Linux x64 and arm64 (static musl), macOS x64 and arm64, Windows x64.
- **Releases:** SHA-256 checksums and signatures (minisign or cosign), and an install script. Everything is downloadable from FF's own site as well, so customers can install offline, without depending on GitHub.
- **Updates:** `ff version` reports when a newer release exists (opt-out).

#### C-42: Published runtime images
- The runtime images go to a public registry, under the names and digests that each CLI release pins.
- `ff local` then works outside this repository.

#### C-43: CI usage
- Examples for GitHub Actions and GitLab CI: install, an API key with the scopes a deploy needs in `FF_TOKEN`, deploy with `--output json`, and the exit codes (a 6 fails the job with the account's message, not the function's).

### Phase 5: the services after functions

The CLI side of steps 1 to 3 of [What to build next](what-to-build-next.md). Each task starts when its service's API exists, and each follows the same rules: the AWS shape where there is one, `--output json`, exit codes, L2 against the mock, L3 against the stack, and the SAM subset of C-30 extended so `template.yaml` carries the new resource (parent E-10).

#### C-50: Function URLs and custom domains (parent E-01)
- `ff url enable <name> [--auth none|key]`, `ff url disable`, `ff url show`: the function's public address, and `ff domains add|remove|list` with the DNS record to set and the certificate's state.
- `ff invoke --http GET /path?x=1` sends an API Gateway v2 event through the URL, for testing; `ff local start` serves the same event shape on its port.
- `ff export` writes `FunctionUrlConfig` and `HttpApi` events.

#### C-51: Schedules (parent E-02)
- `ff schedule set <name> "rate(5 minutes)"|"cron(…)" [--input @event.json]`, `ff schedule remove`, `ff schedule list`, with the next runs printed.
- `ff export` writes `Schedule` events.

#### C-52: Async invokes, queues and event sources (parent E-03, E-05)
- `ff invoke --async <name>` returns the request ID at once; `ff history` shows the retries and the dead-letter outcome.
- `ff queues create|list|purge|delete`, `ff queues send <queue> --data …`, `ff queues receive <queue>` for debugging, and `ff event-sources add <queue> <function> [--batch-size] [--batching-window]`, `remove`, `list`.
- `ff export` writes `SQS` events and the queues as `AWS::SQS::Queue`.

#### C-53: Buckets and secrets (parent E-04, and step 1's secrets)
- `ff buckets create|list|delete`, `ff buckets keys` for the account's access keys, `ff buckets notify <bucket> <function> [--prefix] [--suffix]`.
- `ff secrets set|list|unset <function> <NAME>` for values that must not live in `environment`, read from stdin or a prompt.
- `ff export` writes `S3` events and the buckets as `AWS::S3::Bucket`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The registry (option A) adds an operated component | The C-20 spike measures it first. Zot is a single binary with built-in GC. It also fixes the dev cluster's image GC problem. |
| Native modules built for the wrong platform | D6 (glibc Node.js runtime), `--container` builds, and pip's `--platform` wheels |
| Portability is only skin-deep while handlers read `event.body` | §10, question 1, answered by the step-1 plan's U-03; `ff doctor` flags functions still on the wrapper |
| Function names outside Lambda's rule reach AWS and `sam deploy` fails | The API refuses them since `1bd102e`; for a name from before, `ff doctor` flags it and `ff export` renames it and says so (D3) |
| A token lands in the shell history or in logs | No `--token` flag (D2); `set-token` and `env set` read from stdin; `config show` masks the token; `--verbose` never prints headers |
| Cold starts at the smallest size (6 to 11 s under gVisor, client-readiness P-62) make `deploy` and `local` feel slow | `ff local start` keeps a container warm while developing; the migration plan's K-13 continues on the platform side |
| The live tail doesn't work through a proxy that buffers responses | `--follow --poll` falls back to polling (C-05) |
| SAM scope creep | A documented subset, with one clear error listing everything unsupported |
| Docker Desktop differences on macOS (file mounts, ports) | `ff local` tested on Linux first; macOS in phase 4, with C-41 |
| Customers' TLS-inspecting proxies | The operating system's certificate store (D1); `HTTPS_PROXY` honoured |

## 10. Open questions for you

1. **Event shape.** Today both runtimes hand the payload to the handler as `event.body`, inside `{body, headers, method, query, path}` built from the HTTP request to `/invoke`. That is the old wrapper's format, kept in K-05. On AWS Lambda, a direct invoke passes the payload as `event` itself, and the parent plan's runtime contract (§6.2, task R-04) follows Lambda. Code written for FF today therefore needs changes on Lambda. Function URLs (step 1 of [What to build next](what-to-build-next.md)) will need the API Gateway v2 shape too, where `body` is a string and `isBase64Encoded` says how to read it. **Recommendation:** add runtime protocol v3, where the payload is the event for direct invokes and the API Gateway v2 shape for URLs, as the default for new functions, and keep the wrapper per function for existing ones. `ff init` templates follow it, which is why this question comes before C-07. **Done by the [step-1 plan](step-1-plan.md)**'s U-03, with this recommendation ([ADR 0007](adr/0007-function-events.md)): new functions get the payload itself, those made before keep the wrapper until switched. Its §9 asks you to confirm it.
2. **Code delivery.** May the C-20 spike go ahead with option A? It adds a registry to the platform.
3. **Where releases and images live.** Which domain or registry should host the CLI downloads and the public runtime images, given that customers may not rely on GitHub?
4. **Inline code long-term.** Should the API's `code` field stay as a convenience for the console, with C-24 making it a zip internally? That is the recommendation.
5. **Windows.** Is it needed in phase 4, or only when a customer asks?
6. **Function names.** ~~Should the API adopt Lambda's rule, or keep its own while the CLI warns?~~ **Decided on 2026-10-21:** the API adopted Lambda's rule, 1 to 64 letters, digits, hyphens or underscores, with unique names per account (commit `1bd102e`). A name given before is kept until the function is renamed, which `ff doctor` and `ff export` handle (D3).
7. **`ff login` sooner.** Its Keycloak client exists, and nothing blocks it. Phase 1 works with API keys. Should C-40 move right after C-09, so the first customers never paste a key? **Recommendation:** yes, if the first pilot customers are teams that log in to the console anyway; otherwise keep the order.

## 11. Effort (rough estimates)

| Phase | Working days | Notes |
|---|---|---|
| 0 | 1–2 | Mostly deleting and moving code |
| 1 | 10–13 | Authentication and the account commands are new since the first estimate; C-03 touches the backend; C-06 needs Docker in the tests; C-05 is CLI-only now |
| 2 | 15–20 | The spike, upload and validation, the OCI push, the glibc runtime, packaging |
| 3 | 11–16 | The SAM subset is the largest part; `ff env` is new |
| 4 | 4–6 | The login is unblocked and its client exists |
| 5 | 2–4 per task | Each one waits for its service |

## 12. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| C-00 Preparation and ADR 0002 | ✅ Done | `40f3818` | • **[ADR 0002](adr/0002-cli.md)** records D1 (one Rust binary that talks only to the API, its crates, no async runtime and no S3 client), D2 (profiles, the credentials file, precedence, no `--token`, the TLS rule), D3 (names), D5 (Lambda's packaging rules), D7 (exit codes) and D8 (an API key first, `ff login` later), naming the parent's ADR-007 and ADR-009 and [ADR 0004](adr/0004-identity-and-tenancy.md)'s `ff-cli` client. It checked D1 against today's crates: `ureq` 3.4 has the `platform-verifier` feature for the system's certificates.<br>• **The branch:** the work is the step-1 plan's U-08, so it goes on that plan's branch, `feat/step-1` (§7 says so), not on a `feat/cli` of its own.<br>• The docs' index lists ADR 0002; ADR 0004's row reserves only 0003 now.<br>• `hack/check-docs.py`: OK. |
| C-01 One CLI | ✅ Done | `e645148` | • **`cli/`**, the crate `ff` (edition 2024, Rust 1.91): `main.rs`; `cli.rs`, the commands and flags as clap reads them; `error.rs`, the error's kinds and their exit codes (D7), the API's request ID with the message; `output.rs`, the result on stdout as text or one pretty JSON document, the error on stderr as `error: …` (red on a terminal, unless `--no-color` or `NO_COLOR`) or as `{"error": {"message", "exitCode", "requestId"}}`; `commands/`, one file per command. A reader that goes away (`ff … \| head`) ends the command quietly with 0.<br>• **Commands:** `ff version` (the version and the commit, from git at build time or `FF_BUILD_COMMIT`; `--verbose` adds the target it was built for) and `ff --version`; `ff completion <shell>` for bash, zsh, fish, elvish and PowerShell.<br>• **Global flags:** `--output text\|json`, `--verbose`, `--no-color`. The others come with what reads them: `--profile`, `--endpoint`, `--account` and `--allow-http` with the configuration (C-02), `--quiet` with the first progress notes. Likewise each crate of D1 comes with the task that uses it: here `clap`, `clap_complete`, `serde` and `serde_json`; `assert_cmd` and `predicates` for the tests. `rustfmt.toml`: lines of 120, close to the repository's other code.<br>• L0: `cargo fmt --check` clean, `cargo clippy --all-targets --locked -- -D warnings` clean, `cargo build --release --locked` makes `target/release/ff` (914 KB, stripped, LTO); the static build for `x86_64-unknown-linux-musl` too (static-pie, with the system's `musl-gcc`). `cargo tree`: four direct crates, no `tokio`, no S3 or AWS crate.<br>• L1: 4 tests: each kind's exit code; an output that fails is a failure unless its reader went away; an error as text, with its request ID, colored only when asked; an error as JSON with the same keys always.<br>• L2 (`tests/cli.rs`, the built binary): 7 tests: `--help` lists the commands and flags; an unknown command and an unknown format exit 2; `ff version` names the commit, `--verbose` the platform; its JSON is one document with its three fields; completion scripts for bash and zsh, an unknown shell exits 2.<br>• **No more Node.js CLI:** nothing in the repository refers to it, but the parent plan's review of the repository as it was then (its scope, the architecture it found, findings H-10 and H-12, its ADR-007), which stays as that record.<br>• Docs: `cli/README.md` (the commands so far, the exit codes, how to build and test; the command reference in C-08), the README's layout and its plans' list. |
| C-02 Configuration, authentication and API client | ✅ Done | `4ded753` | • **Settings (D2, `config.rs`):** `config.toml` and `credentials.toml`, `[profiles.<name>]` tables, in the system's configuration folder or `FF_CONFIG_DIR`; read and rewritten with `toml_edit` rather than `toml`, so a change keeps the file's comments and other profiles; written whole through a file renamed over it; the credentials 0600 in a folder made 0700, with a warning when others may read them. Precedence flag, environment, profile, default, each setting with its source. A profile named by `--profile` or `FF_PROFILE` must exist, but `ff config set` makes one. An endpoint is `http(s)://host[:port][/path]`, no user, no query; plain http only to `localhost`, `127.0.0.1` or `[::1]` unless `--allow-http` or the profile's `allow_http`. Accounts are 12 digits wherever they come from.<br>• **Tokens (D8, `auth.rs`):** `Authorization: Bearer` from `FF_TOKEN` (any token, a user's too) or the profile's credentials; `X-FF-Account` from `--account`, `FF_ACCOUNT` or the profile; `X-FF-Dev-Account` from the profile's `dev_account`. A token is never printed whole, its `Debug` too: an API key shows as `ffk_<key ID>_…`, as the console lists it. Without a token or a development account, ff says how to get a key and calls nothing.<br>• **The client (`api/`):** `ureq` 3.4 over rustls, certificates checked by the system's verifier, proxies from the environment with `NO_PROXY`; connect 5 s, an answer within 30 s unless a call says otherwise; `User-Agent: ff-cli/<version>`. The API's error body read as NestJS writes it (`message` a string or a list), its request ID from the body or `X-FF-Request-Id`; 402, 403 and 429 exit 6, any other refusal 3; a 401 says to save another key; an answer that isn't the API's says its status. A read refused with 429 is tried once more after its `Retry-After` (at most 30 s), never a write. No answer at all names the address and why: refused, unknown host, or no answer within the timeout.<br>• **Commands:** `ff config set\|unset\|show\|set-token` (the key from a prompt that doesn't echo, via `rpassword`, or stdin; `set token` refused, since the shell would keep it); `ff whoami`, moved here from C-09 (the task's description says why), with the global flags `--profile`, `--endpoint`, `--account` and `--allow-http`. `--output json` gives `ff whoami` the API's answer, and errors gain the API's `status`.<br>• **Backend:** `GET /me` answers an API key, whatever its scopes (`@AllowAnyApiKey()`, a route rule the guard reads): `user` null, `key` (ID, name, scopes) and the key's account with its creator's role; a user's and development mode's answers gain `key: null`. Every other route a key couldn't call, it still can't. [ADR 0004](adr/0004-identity-and-tenancy.md) and the getting-started guide say so.<br>• **Not taken from the plan:** `httpmock` for L2. The binary's tests use a scripted API of their own (`tests/common/mod.rs`, about 150 lines): it answers each request with the next reply, in order, which a retry needs and `httpmock` can't do, records what it was sent, then stops listening; and it needs no async runtime.<br>• L0: `cargo fmt --check` and `clippy -D warnings` clean; release build 3.2 MB, static musl 3.4 MB (static-pie: `ring` builds with the system's `musl-gcc`); `cargo tree`: eight direct crates, no `tokio`, AWS or S3 crate. Backend `tsc` and lint clean.<br>• L1: CLI **23 tests** (was 4): precedence and sources, profiles that must exist, tokens from `FF_TOKEN` or the credentials, the TLS rule, endpoints, accounts, a file changed keeping its comments; keys' shape and mask, the headers, the refusal without a token; the error mapping (the API's message as written, validation lists, the account's codes, a 401's advice, a proxy's answer, `Retry-After`); `ff whoami`'s text for a key, a user with several accounts, development mode. Backend **99 suites / 1404 tests**: the guard lets any key call a route open to any key, still not one without a scope, and an invalid key nowhere.<br>• L2: CLI **25 tests** of the binary (was 7): `ff config` (9: precedence through the binary, the TLS rule and `allow_http`, a key from stdin kept 0600 in a folder made 0700 and never shown, refusals, profiles, unset, comments kept, JSON, the permissions warning) and `ff whoami` (9: the key and user agent sent, JSON, the account headers, no token and no call, an unreachable API, plain http refused, a 403 exits 6 with its request ID, a 401's advice, a 429 read tried once more, and not a third time). Backend database tests of accounts: 2 suites / 30 tests, among them a key's `GET /me`.<br>• L5 (`hack/e2e-tenancy.sh`): **635 checks passed**: a key reads `GET /me`, itself and only its own account with its creator's role; it still can't read the keys, the members or the audit log.<br>• Docs: `cli/README.md` (the commands, the settings and their precedence, what ff sends, the exit codes and the error's JSON, the tests), D2 here (`FF_CONFIG_DIR`), §6, C-09 and C-40 (`ff whoami` came with C-02). |
| C-03 Backend: request limits and names | ✅ Done | `1bd102e` (the names' rule), (this commit) | • **Bodies by route:** JSON is read with a limit per route (`app-setup.ts`): 7 MB for `POST /functions`, `PUT /functions/:id` and `POST /functions/:id/invoke`, 100 KB everywhere else, body-parser's default, kept so that the fields without a limit of their own stay bounded as they were. Past it, 413 saying which limit; read after CORS, so that the console reads the refusal.<br>• **Code:** 900 KiB of UTF-8 at most (921,600 bytes, `MAX_CODE_BYTES`, now in `functions/limits.ts`, which the manifests import), checked by the DTO on create and update (`MaxUtf8Bytes`, counting bytes as stored), the message saying how many the code has; the orchestrator's own check stays behind it.<br>• **Input:** 6 MB as JSON (6,291,456 bytes), as Lambda's synchronous calls: more answers 413 with `error: "RequestEntityTooLargeException"` and Lambda's words ("Request must be smaller than 6291456 bytes for the InvokeFunction operation"), before the function or the credit is read.<br>• **Metadata:** must be an object of 4 KB as JSON at most (`MaxJsonBytes`); it was unchecked, bounded only by the 100 KB body, which a create no longer has.<br>• **Names:** `GET /functions?name=<name>`, compared exactly, the account's own: none or one.<br>• **Found and fixed:** the API's global error filter answered every error that isn't Nest's own with 500 "Internal error" and a log line, so an error Express's middleware made for the caller did too: a JSON body over 100 KB got 500, not 413, and so did a withholding certificate over its limit. An error that says it is the caller's (a 4xx with `expose`, as body parsers' are) now answers its own status and message, with the request ID. The filter's test fails without the fix (500) and passes with it.<br>• L1 backend: **99 suites / 1415 tests** (was 99 / 1404): bodies of 6 MB taken on the three routes, refused past 7 MB with CORS, past 100 KB elsewhere; code of 900 KiB taken, 921,602 bytes of two-byte characters refused, on create and update; metadata an object, 4 KB; an input over 6 MB refused as Lambda refuses it with nothing read, 6 MB exactly taken; the name filter exact and the account's own; the filter's 413 and a body that is no JSON, 400.<br>• L4 (`hack/e2e.sh`): **172 checks passed**: a function with 150 KB of code made and found by `?name=`, another case finding none; 1 MiB of code refused, saying the limit, the function left as it was; an input of 1 MB answered whole; one over 6 MB refused in Lambda's words with nothing run; a body over 7 MB refused saying the limits; a schedule's body over 100 KB refused with 413 and a request ID, where the API answered 500 before.<br>• Docs: the getting-started guide's "What a function can be", the README, `how-it-works.html` (the limits' table, the validation step), §6 here. |
| C-04 Core commands | ⏳ Planned | | |
| C-05 Logs | 🔶 Backend done (client-readiness P-40, P-43); the CLI part is planned | | |
| C-06 Local runs | ⏳ Planned | | |
| C-07 `ff init` and examples | ⏳ Planned | | |
| C-08 Phase-1 release and docs | ⏳ Planned | | |
| C-09 Account, usage, balance and metrics | ⏳ Planned | | |
| C-20 Spike and ADR 0003 | ⏳ Planned | | |
| C-21 Function model v2 | ⏳ Planned | | |
| C-22 Upload and validation | ⏳ Planned | | |
| C-23 Version images and registry | ⏳ Planned | | |
| C-24 Inline code on the same path | ⏳ Planned | | |
| C-25 Node.js runtime on glibc | ⏳ Planned | | |
| C-26 `ff package` and zip deploys | ⏳ Planned | | |
| C-27 Phase-2 docs and e2e | ⏳ Planned | | |
| C-30 SAM `template.yaml` | ⏳ Planned | | |
| C-31 Environment variables | ⏳ Planned; its backend part is the step-1 plan's U-01 | | |
| C-32 `ff export --target aws` | ⏳ Planned | | |
| C-33 `ff doctor` | ⏳ Planned | | |
| C-40 `ff login` and API keys | ⏳ Planned, unblocked (the `ff-cli` client exists) | | |
| C-41 Distribution | ⏳ Planned | | |
| C-42 Published runtime images | ⏳ Planned | | |
| C-43 CI usage | ⏳ Planned | | |
| C-50 Function URLs and custom domains | ⏳ Waits for the platform: the step-1 plan's U-04 and U-06 | | |
| C-51 Schedules | ⏳ Waits for the platform: the step-1 plan's U-07 | | |
| C-52 Async invokes, queues and event sources | ⏳ Waits for the platform (parent E-03, E-05) | | |
| C-53 Buckets and secrets | ⏳ Waits for the platform: secrets, the step-1 plan's U-02; buckets, step 2 (parent E-04) | | |
