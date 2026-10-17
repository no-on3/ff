# FF CLI plan: one `ff` command for developers

| | |
|---|---|
| **Status** | Proposed, not started. Open questions for you are in §10. |
| **Replaces** | The plan in `cli/README.md`, which no longer matched the platform (§1). It was removed with the prototypes; git history has it, for example at commit `fb9d833`. |
| **Parent plan** | [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): finding H-10; tasks R-02 (in part) and R-10; ADR-007 (Rust) and ADR-009 (SAM); §6.1 packaging, §7.1 `ff export`, §7.4 `ff doctor` |
| **Builds on** | The [Kubernetes migration](kubernetes-migration-plan.md) (K-00 to K-12) and the [getting-started guide](getting-started.md) |
| **Decision records** | ADR 0002 (the CLI) in C-00, ADR 0003 (code delivery) in C-20 |

FF needs one command-line tool for developers. With it you write a function, run it locally in the same runtime it gets in production, deploy it, invoke it, read its logs, and later package it with dependencies, all with the packaging rules of AWS Lambda. That way a project built on FF can move to AWS without changes. Today that work is done with the `curl` commands in the getting-started guide. The two CLI prototypes in the repository can't do it (§1).

The plan has four phases. Each delivers something usable on its own:

| Phase | You get | Needs from the platform |
|---|---|---|
| **0. Groundwork** | One Rust CLI skeleton; the Node.js CLI and the direct-to-storage upload retired | nothing |
| **1. The CLI on today's API** | `ff deploy`, `invoke`, `list`, `get`, `history`, `logs`, `delete`, `init`, `local invoke` / `local start` for single-file functions | larger request limit, unique names, a logs endpoint (small backend changes) |
| **2. Packages with dependencies** | `ff package` and `ff deploy <dir>`: zips with `node_modules` or pip packages, Lambda-compatible | the code artifact pipeline (upload, validation, delivery to pods) and a glibc Node.js runtime |
| **3. AWS projects and the exit kit** | `ff deploy` from an AWS SAM `template.yaml`; `ff export --target aws`; `ff doctor` | function environment variables; the Lambda event shape (§10, question 1) |
| **4. Customer-ready** | `ff login`, signed releases for Linux, macOS, and Windows, published runtime images, CI usage | authentication on the API (parent F-01/R-08) |

---

## 1. Why the old plan is replaced

A review of the two prototypes, `cli/` (Node.js, 234 lines) and `cli-rust/` (Rust, 383 lines), against the platform as it is now. Both were then removed as dead code, and they remain in git history (for example at commit `fb9d833`):

| The old plan assumed | What is true now | Consequence |
|---|---|---|
| `ff upload` puts a zip in the MinIO bucket, and that deploys it | The backend deploys from the `code` string of `POST /functions` into a Kubernetes ConfigMap. It only *writes* an archive copy to storage and never reads zips back. | `ff deploy` would upload and report success, while nothing changes. SeaweedFS speaks the same S3 API MinIO did, so the upload even succeeds. |
| The CLI holds the storage credentials | They are the platform's storage keys | Fine on your laptop; never shippable to customers (parent finding H-10). A CLI must talk to the FF API only. |
| Zip layout: `dist/`, `node_modules/`, `package.json`, `tsconfig.json` | The runtimes, like Lambda, load the handler from the root of `/var/task`, with `node_modules/` (or Python packages) next to it | Packages built this way would not load |
| Two CLIs, Node.js and Rust | Parent ADR-007 chose **Rust**: a single static binary, easy to install offline, no Node.js needed | Two code bases for one job |
| Node.js 18, `npm install --production` | Node 18 is end of life; the flag is deprecated (`--omit=dev`). The CLI also ran it in the user's own folder, mutating their `node_modules`. | Rework in any case |
| No limits | **Measured:** the backend rejects request bodies over about 100 KB with `413 request entity too large`, for function code and for invoke input alike. The runtimes accept 900 KiB of code and 6 MB payloads. | Deploys and payloads over 100 KB fail today (fixed in C-03) |

Both prototypes are small, so starting cleanly costs little. The new CLI can borrow the Rust prototype's `clap` command structure and error type from git history.

## 2. Goals and non-goals

**Goals:**
- **One static binary, `ff`,** for Linux and macOS (Windows in phase 4). It needs no Node.js or Python to run, and it installs offline.
- **API only.** No storage keys, cluster credentials, or kubeconfig on developer machines. Later, a user token from `ff login`.
- **Lambda-compatible packages.** A zip built by `ff package` follows Lambda's rules: handler at the root, dependencies inside, the same size limits, and the same `CodeSha256`. Later, the project file is an AWS SAM `template.yaml` (parent ADR-009), so leaving FF is `sam deploy` with the same file.
- **Local runs equal production runs.** `ff local` uses the same runtime images and the same hardening as function pods: read-only root, uid 10001, no capabilities, the memory limit.
- **Scriptable.** Stable exit codes, `--output json` on every command, and non-interactive use in CI.

**Non-goals (for now):**
- **Replacing the AWS CLI.** The Lambda API facade (parent §6.6) is what will make `aws lambda …`, the SDKs, and Terraform work against FF. `ff` adds what AWS tools can't: local runs against FF's runtimes, FF logs, packaging checks, export, and doctor.
- Server-side builds ("deploy from source"). Parent §6.1 keeps builds on the developer's side, with a build service later.
- Layers, versions and aliases (until parent R-01), event sources (parent phase 3), and a terminal UI.

## 3. Decisions

Decisions D1–D3, D5 and D7 are recorded in ADR 0002 (task C-00). D4 is decided by a spike and recorded in ADR 0003 (C-20).

### D1. Rust, one binary, talking only to the API
- **Crates:**
  - `clap` (derive) and `clap_complete`;
  - `ureq` for HTTP: blocking and small, using `rustls` with the operating system's certificate store, so company CAs and TLS-inspecting proxies work. `HTTPS_PROXY` and `NO_PROXY` are honoured.
  - `serde` / `serde_json` (`serde_yaml` in phase 3);
  - `zip` (writer, deflate), with `sha2` and `base64` for `CodeSha256`;
  - `walkdir` and `ignore` (`.ffignore` in gitignore syntax);
  - `directories` (config paths), `anyhow` / `thiserror`, and `notify` (watch mode);
  - versions: the latest stable at implementation time, locked in `Cargo.lock`, built with `--locked`.
- **Not carried over from the Rust prototype:** `tokio` (no async runtime is needed for a CLI that does one request at a time), `s3`, and `dotenv`.
- **Static builds:** `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`; macOS and Windows targets in phase 4. The toolchain on the reference machine is Rust 1.91, so edition 2024 is available.

### D2. Configuration
- **Files:**
  - `~/.config/ff/config.toml` on Linux (`~/Library/Application Support/ff/` on macOS, `%APPDATA%\ff\` on Windows), with profiles:

    ```toml
    [profiles.default]
    endpoint = "http://localhost:3000"

    [profiles.staging]
    endpoint = "https://api.staging.ff.example"
    ```

  - tokens go in a separate `credentials.toml`, created with mode 0600 and never printed (phase 4).
- **Precedence:** command-line flags, then environment variables (`FF_ENDPOINT`, `FF_PROFILE`, `FF_TOKEN`), then the profile, then the default `http://localhost:3000`.
- **TLS:** plain `http://` is accepted only for `localhost` and `127.0.0.1`, unless `--allow-http` is given.

### D3. Functions are addressed by name, as on Lambda
`ff invoke hello`, not a UUID. Names must therefore be unique per tenant, and they follow Lambda's rule `^[A-Za-z0-9_-]{1,64}$` (parent M-4). Both are backend changes (C-03). Until then the CLI resolves names on the client and refuses ambiguous ones.

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
| 3 | Configuration, connection, or API error (the API was unreachable or refused the request) |
| 4 | Deploy failed: the function did not become ready. The diagnostics are printed. |
| 5 | The invocation failed: the function raised (`ERROR`) or timed out (`TIMEOUT`) |

Text output is for people. `--output json` prints one JSON document per command, with a documented, stable shape. Errors always go to stderr.

## 4. Commands (target)

| Command | What it does | Phase |
|---|---|---|
| `ff config set <key> <value>`, `ff config show` | Endpoint and profile settings | 1 |
| `ff init <name> --runtime nodejs\|python` | A function folder: handler, `events/event.json`, README | 1 (SAM layout in 3) |
| `ff deploy <file\|dir> [--name] [--memory] [--timeout] [--handler]` | Create, or update by name. Sends only what changed, waits until the new version is live, and prints the diagnostics if it never gets there. | 1: one file; 2: folder as zip; 3: `template.yaml` |
| `ff list`, `ff get <name>` | Functions and their state; `get` shows the error of a function in `ERROR` | 1 |
| `ff invoke <name> [--data JSON\|@file\|-] [--raw]` | Invoke and print the output, the duration, and the error if any (exit 5) | 1 |
| `ff history <name> [--limit N]` | Recent invocations: time, status, duration, error | 1 |
| `ff logs <name> [--tail N] [--follow]` | The function pods' logs: START/END/REPORT lines, user output, errors | 1 |
| `ff delete <name> [--yes]` | Delete (asks first in a terminal) | 1 |
| `ff local invoke <file\|dir> [--data …]` | Run once in the production runtime image on Docker, and print the output and logs | 1 |
| `ff local start <file\|dir> [--port] [--watch]` | Keep it running on a local port; `--watch` restarts it when files change | 1 |
| `ff package <dir> [-o file.zip] [--container]` | Build a Lambda-compatible zip; `--container` builds inside the runtime image for an exact platform match | 2 |
| `ff export --target aws [<name>…]` | `template.yaml`, code zips, and a migration checklist (parent §7.1, first slice) | 3 |
| `ff doctor [<dir>]` | Portability linter (parent §7.4, first slice) | 3 |
| `ff login`, `ff logout`, `ff whoami` | Device-flow login and tokens | 4 |
| `ff version`, `ff completion <shell>` | | 1 |

**Global flags:** `--profile`, `--endpoint`, `--output text|json`, `--quiet`, `--verbose`, `--no-color`.

**What a phase-1 session looks like:**

```text
$ ff init hello --runtime python
created hello/function.py, hello/events/event.json
$ ff local invoke hello --data @hello/events/event.json
{"message": "Hello world", "requestId": "…"}        0.21 ms · 36 MB
$ ff deploy hello/function.py --name hello
creating hello (python, 128 MB, 5 s) … ACTIVE in 6.4 s
$ ff invoke hello --data '{"name": "Tunis"}'
{"message": "Hello Tunis", "requestId": "…"}        0.17 ms
$ ff logs hello --tail 4
START RequestId: … Version: $LATEST
greeting Tunis
END RequestId: …
REPORT RequestId: …  Duration: 0.17 ms  Billed Duration: 1 ms  Memory Size: 128 MB  Max Memory Used: 36 MB
```

## 5. Architecture

```
developer machine                                   FF platform
┌────────────────────────────┐   HTTPS + token  ┌─────────────────────────────────────────────┐
│ ff                         │ ───────────────▶ │ backend API                                 │
│  ├─ API client             │                  │  ├─ functions, invocations, logs            │
│  ├─ packager (zip, D5)     │                  │  ├─ artifact pipeline (phase 2): validate,  │
│  └─ local runner ──┐       │                  │  │   store in S3, build the version image   │
└────────────────────│───────┘                  │  └─▶ Kubernetes: Deployment per function    │
                     ▼                          └─────────────────────────────────────────────┘
        docker: ff-runtime-* image                       registry ◀── kubelet pulls (phase 2)
        (same hardening as production pods)
```

- **Source layout.** The CLI lives in `cli/`:
  - `src/main.rs` (clap);
  - `config.rs`;
  - `api/` (client, types, error mapping);
  - `commands/` (one file per command);
  - `package/` (rules, zip writer, builders);
  - `local/` (docker runner);
  - `output.rs`;
  - tests under `tests/`.
- **Deploy in phase 1.** `POST /functions` or `PUT /functions/:id` with the code inline, as the guide's `curl` commands do. The API already waits until the version is live (up to `FF_READY_TIMEOUT_SECONDS`, 90 s). The CLI's read timeout is therefore longer than that.
- **Invoke.** `POST /functions/:id/invoke {"input": …}`. The API answers 400 when the function raises or times out, and the CLI maps that to exit code 5. The Lambda-shaped answer (200 with `X-Amz-Function-Error`) belongs to the API facade (parent §6.6), not to this API.
- **Deploy in phase 2.** `ff package` builds the zip, then `ff deploy` compares its `CodeSha256` with the function's, uploads only when it differs, and waits for the rollout.
- **Local runs.** The CLI starts the runtime container with production's flags:
  - `--read-only --tmpfs /tmp --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --memory <m>m`;
  - the `FUNCTION_*` and `FF_HANDLER` variables;
  - the code mounted read-only at `/var/task`, and the port published on `127.0.0.1` only.

  It then waits for `/readyz` (showing the init error if loading fails) and posts the event to `/invoke`, the same protocol the platform uses.

## 6. Platform changes the CLI needs

| Change | Why | Task |
|---|---|---|
| Raise the API's JSON body limit to 7 MB. Check code against the real 900 KiB limit, and invoke input against Lambda's 6 MB, with clear messages. | The measured 100 KB default blocks both | C-03 |
| Unique function names per tenant, Lambda naming rules, `GET /functions?name=` | Address functions by name (D3) | C-03 |
| `GET /functions/:id/logs?tail=&sinceSeconds=` | `ff logs` without cluster access. The backend's ServiceAccount can already read pod logs. | C-05 |
| Function fields `packageType`, `handler`, `codeSha256`, `codeSize`; handler resolution with `.mjs` | Zip packages; Lambda handler names | C-21 |
| Upload, validation, and artifact storage | Zip packages, safely | C-22 |
| Version images and a registry (if ADR 0003 picks option A) | Delivering zips to pods (D4) | C-23 |
| Node.js runtime on glibc | Native modules (D6) | C-25 |
| Function environment variables (Lambda limit: 4 KB) | SAM `Environment`, and everyday configuration | C-31 |
| `GET /functions/:id/code` (the zip, or the inline file) | `ff export` | C-32 |
| The Lambda event shape | Portability of handler code (§10, question 1) | Parent R-04 |
| Authentication and API tokens | `ff login`, customers, CI | Parent F-01/R-08 → C-40 |

## 7. Working rules

These are the same as the Kubernetes migration:
- `hack/check-resources.sh` runs before every heavy step: builds, Docker runs, cluster tests.
- One heavy operation at a time.
- Work on a branch `feat/cli`, with one commit per task: `type(scope): summary (C-xx)`.
- Each task's progress row records its tests and documentation.

**Test levels:**

| Level | What | Tool |
|---|---|---|
| L0 | `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build --locked` | cargo |
| L1 | Unit tests: config precedence, error mapping, name rules, packaging rules, zip determinism, docker argument building | `cargo test`, `insta` snapshots |
| L2 | The real `ff` binary against a mock API: commands, outputs, and exit codes, black-box | `assert_cmd`, `predicates`, `httpmock`, `tempfile` |
| L3 | Against the dev stack (backend plus k3d) and Docker: `hack/cli-e2e.sh` deploys, invokes, logs, updates, deletes, and runs locally, for both runtimes | bash, like `hack/e2e.sh` |
| L4 | Portability (phases 2 and 3): zips checked against Lambda's packaging rules, and the exported `template.yaml` against SAM's schema (`sam validate`, where the SAM CLI is available) | bash |

A task is done when its tests pass at the levels listed, the docs it touches pass `hack/check-docs.py`, and the progress log row is filled in.

## 8. Tasks

### Phase 0: groundwork

#### C-00: Preparation and ADR 0002
- **Steps:**
  - Create the branch.
  - Write `docs/adr/0002-cli.md`, recording D1, D2, D3, D5, and D7 and naming the parent's ADR-007 and ADR-009.
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

#### C-02: Configuration and API client
- **Config:** files, profiles, and precedence (D2); `ff config set` and `ff config show`. The TLS rule: refuse `http://` outside localhost unless `--allow-http`.
- **API client:**
  - timeouts: connect 5 s; read 120 s for deploys (the API waits up to 90 s for readiness); for invokes, the function timeout plus 90 s (cold start) plus a margin;
  - sends `User-Agent: ff-cli/<version>`, and `Authorization: Bearer` when a token is configured;
  - maps NestJS error bodies (`{statusCode, message, error}`) to typed errors.
- **Tests:** L1 for precedence, the TLS rule, and error mapping; L2 against `httpmock` (an unreachable API exits 3 with the address in the message).

#### C-03: Backend: request limits and function names
- **Limits:**
  - `app.useBodyParser('json', { limit: '7mb' })` in `BE/src/main.ts`, with the app created as a `NestExpressApplication` (NestJS 11.2 is installed since P-09 of the [client-readiness plan](client-readiness-plan.md));
  - code limited to 900 KiB (in bytes, checked in the DTO, with a message that names the limit);
  - invoke input limited to 6 MB once serialized, answered with 413 and `RequestEntityTooLargeException`, Lambda's name.
- **Names:**
  - Lambda's naming rule on create and update;
  - a unique index on `(account_id, name)`, with `409 Conflict` for duplicates (the tenant column is `user_id` until the client-readiness plan's P-12 renames it);
  - `GET /functions?name=<name>`;
  - a TypeORM migration. Every environment builds its schema from migrations since the client-readiness plan's P-01. Databases that already hold duplicate names need them renamed first, which the migration reports.
- **Tests:**
  - L1: DTO validation, and the conflict on create and on rename.
  - The e2e script gains checks that 150 KB of code is accepted, 1 MB is refused with the clear message, and a 1 MB input is accepted.
- **Docs:** the limits in the getting-started guide and the README.

#### C-04: Core commands
- **`ff deploy <file>`:**
  - the name comes from `--name`, else the file name without its extension;
  - the runtime comes from the extension (`.ts`, `.js`, `.cjs` → `nodejs`; `.py` → `python`), or `--runtime`;
  - the CLI looks the name up, then creates the function or updates it with only the changed fields;
  - "no changes" when the SHA-256 of the code equals the server's;
  - a spinner while the API waits for the rollout, and on failure the API's diagnostics with exit 4;
  - a 409 from a concurrent create is retried as an update.
- **`ff invoke`:**
  - `--data` takes inline JSON, `@file`, or `-` for stdin;
  - prints the output (pretty-printed in text mode) and the duration;
  - on `ERROR` or `TIMEOUT`, prints the error on stderr and exits 5;
  - `--raw` prints only the output, for pipes.
- **`ff list`, `ff get`, `ff history`** print tables, or JSON. `get` shows the stored error of a function in `ERROR`.
- **`ff delete`** asks for confirmation in a terminal, unless `--yes` is given. With no terminal (CI), it requires `--yes`.
- **Tests:**
  - L1: name and runtime inference, and change detection;
  - L2: each command against the mock, including the exit codes;
  - L3: `hack/cli-e2e.sh` runs deploy → invoke → update → history → delete for `examples/hello.ts` and `examples/hello.py`, plus the error and timeout paths with `examples/slow.py`.

#### C-05: Logs
- **Backend:**
  - `GET /functions/:id/logs?tail=200&sinceSeconds=` lists the function's pods by label (`ff.dev/function-id`) and reads each one's `function` container log with timestamps;
  - lines are prefixed with the pod name when there are several pods;
  - an ownership check is made.
- **CLI:** `ff logs <name> [--tail N] [--follow]`. `--follow` polls every 2 s with `sinceSeconds` and drops lines it has already printed, using their timestamps. Streaming can come later.
- **Tests:** L1 backend against the fake Kubernetes API (several pods, no pods, a pod with no log yet); L2 CLI; L3 for a `print` in a function showing up in `ff logs`.

#### C-06: Local runs (`ff local invoke`, `ff local start`)
- **Docker:** checks `docker version` and says clearly when Docker is missing.
- **Image:**
  - from `FF_RUNTIME_IMAGE_NODEJS` / `_PYTHON`, else `ff-runtime-nodejs:24-v2` and `ff-runtime-python:3.13-v2`;
  - built locally in this repository; published images come in C-42.
- **The container gets production's hardening and settings** (§5):
  - memory from `--memory`, default 128 MB;
  - the timeout from `--timeout`, default 5 s;
  - a single file is mounted as `/var/task/function.<ext>`, a folder as `/var/task`, both read-only;
  - a random port on `127.0.0.1`.
- **`ff local invoke`:**
  - waits for `/readyz` and prints the init error if loading fails;
  - posts the event and prints the output, the `x-ff-duration-ms` and `x-ff-max-memory-used-mb` headers, and the container's log lines;
  - removes the container, even after Ctrl-C.
- **`ff local start`** keeps the container running and prints its address. `--watch` restarts it when a file changes (about 1 s, debounced).
- **Tests:** L1 for the docker argument builder; L3 with real Docker: hello in both runtimes, an init error, a timeout, and an out-of-memory error (the runtimes report all of these).

#### C-07: `ff init` and examples
- `ff init <name> --runtime nodejs|python` creates `<name>/function.<ext>`, `<name>/events/event.json`, and `<name>/README.md` from templates embedded in the binary. The templates follow the event shape decided in §10, question 1.
- **Tests:** L1 snapshots of the generated files; L3 for init → local invoke → deploy → invoke.

#### C-08: Phase-1 release and docs
- **Build:** `hack/build-cli.sh` makes the static Linux build (`x86_64-unknown-linux-musl`), writes a SHA-256 checksum, and runs the resource check first. It can build inside `rust:alpine` when the musl target isn't installed.
- **Docs:** `cli/README.md` becomes the command reference. The getting-started guide gains "Using the CLI", the CLI equivalents of its `curl` section.
- **Done when:** on the dev stack, `ff deploy examples/hello.py --name hello && ff invoke hello --data '{"name": "x"}'` works, and `hack/cli-e2e.sh` is green.

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
  - `PUT /functions/:id/code` with `Content-Type: application/zip`;
  - streamed to disk and refused beyond 50 MB, Lambda's direct-upload limit;
  - for larger packages (up to 250 MB unzipped), later: `POST /uploads` returns a pre-signed S3 URL, then `PUT /functions/:id/code {"uploadId": …}`.
- **Validation** with `yauzl` (a new backend dependency), refusing:
  - absolute paths, `..`, backslashes, and NUL bytes in names;
  - symbolic links (in v1);
  - more than 250 MB unzipped, or more than 20,000 files;
  - compression ratios that suggest a zip bomb;
  - a handler module that doesn't exist (for example `src/app.handler` needs `src/app.js|.mjs|.cjs|.ts` or `src/app.py`).
- **Storage:** content-addressed, `artifacts/<tenant>/<function>/<sha256>.zip`. An identical upload is a no-op.
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
- The API's `code` field stays, for the dashboard and quick edits.

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
- **Anything outside the subset** fails with one message listing every unsupported key and resource.
- **Tests:** L1 for template fixtures (valid, unsupported, malformed); L3 for a `sam init` hello world deployed unchanged; L4 `sam validate` on the fixtures, where available.

#### C-31: Function environment variables (backend)
- **Field:** `environment`, a map of names to values, limited to 4 KB in total, as on Lambda.
- **Names:** must be valid variable names. The reserved prefixes `AWS_`, `LAMBDA_`, `FF_`, and `FUNCTION_` are refused (parent §6.2).
- **Delivery:** injected into the Deployment. Values are never logged.
- **Secrets:** later, from the secrets store (OpenBao, parent §4.10).
- **Tests:** L1 for validation and manifests; L3 for a function reading its variable.

#### C-32: `ff export --target aws` (parent §7.1, first slice)
- For each function, `ff export` writes a SAM `template.yaml`: runtime names mapped back, `Handler`, `MemorySize`, `Timeout`, `Environment`.
- It also writes the code zips, compiled to JavaScript for Node.js. The backend gains `GET /functions/:id/code` for this.
- It adds a `MIGRATION.md` checklist. Terraform output comes later.
- **Tests:** L1 for the generated template against fixtures; L4 `sam validate` on the output; L3 for an export after a deploy.

#### C-33: `ff doctor` (parent §7.4, first slice)
- **Static checks on a project:**
  - memory, timeout, and payload beyond Lambda's limits;
  - writes outside `/tmp` (heuristic);
  - FF-only environment variables and hard-coded FF endpoints;
  - deprecated runtimes;
  - **reading the payload from `event.body`**, which is FF's current event shape and differs from Lambda's (§10, question 1).
- **Output:** a list with file and line. `--strict` makes warnings fail with exit 1.
- **Tests:** L1 for fixtures, one per check.

### Phase 4: customer-ready

#### C-40: `ff login` (requires the parent's F-01/R-08)
- An OAuth 2.0 device flow against the identity provider (Keycloak, parent §4.10). Tokens go in `credentials.toml` (0600), with refresh.
- Plus `ff logout`, `ff whoami`, and API keys for CI (`FF_TOKEN`).
- **Tests:** L2 for the device flow against a mock token endpoint.

#### C-41: Distribution
- **Builds:** Linux x64 and arm64 (static musl), macOS x64 and arm64, Windows x64.
- **Releases:** SHA-256 checksums and signatures (minisign or cosign), and an install script. Everything is downloadable from FF's own site as well, so customers can install offline, without depending on GitHub.
- **Updates:** `ff version` reports when a newer release exists (opt-out).

#### C-42: Published runtime images
- The runtime images go to a public registry, under the names and digests that each CLI release pins.
- `ff local` then works outside this repository.

#### C-43: CI usage
- Examples for GitHub Actions and GitLab CI: install, deploy with `FF_TOKEN`, and `--output json` with exit codes.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The registry (option A) adds an operated component | The C-20 spike measures it first. Zot is a single binary with built-in GC. It also fixes the dev cluster's image GC problem. |
| Native modules built for the wrong platform | D6 (glibc Node.js runtime), `--container` builds, and pip's `--platform` wheels |
| Portability is only skin-deep while handlers read `event.body` | §10, question 1; `ff doctor` flags it meanwhile |
| Cold starts at the smallest size (about 10 s, migration plan K-13) make `deploy` and `local` feel slow | K-13 (CPU burst); `ff local start` keeps a container warm while developing |
| SAM scope creep | A documented subset, with one clear error listing everything unsupported |
| Docker Desktop differences on macOS (file mounts, ports) | `ff local` tested on Linux first; macOS in phase 4, with C-41 |
| Customers' TLS-inspecting proxies | The operating system's certificate store (D1); `HTTPS_PROXY` honoured |

## 10. Open questions for you

1. **Event shape.** Today FF hands the payload to the handler as `event.body`, inside `{body, headers, method, query, path}`. That is the old wrapper's format, kept in K-05. On AWS Lambda, a direct invoke passes the payload as `event` itself, and the parent plan's runtime contract (§6.2, task R-04) follows Lambda. Code written for FF today therefore needs changes on Lambda. **Recommendation:** add runtime protocol v2, where the payload is the event, as the default for new functions, and keep v1 per function for existing ones. `ff init` templates follow v2.
2. **Code delivery.** May the C-20 spike go ahead with option A? It adds a registry to the platform.
3. **Where releases and images live.** Which domain or registry should host the CLI downloads and the public runtime images, given that customers may not rely on GitHub?
4. **Inline code long-term.** Should the API's `code` field stay as a convenience for the dashboard, with C-24 making it a zip internally? That is the recommendation.
5. **Windows.** Is it needed in phase 4, or only when a customer asks?

## 11. Effort (rough estimates)

| Phase | Working days | Notes |
|---|---|---|
| 0 | 1–2 | Mostly deleting and moving code |
| 1 | 7–9 | C-03 and C-05 touch the backend; C-06 needs Docker in the tests |
| 2 | 15–20 | The spike, upload and validation, the OCI push, the glibc runtime, packaging |
| 3 | 10–15 | The SAM subset is the largest part |
| 4 | 5–8 | Once authentication exists (parent F-01/R-08) |

## 12. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| C-00 Preparation and ADR 0002 | ⏳ Planned | | |
| C-01 One CLI | ⏳ Planned | | |
| C-02 Configuration and API client | ⏳ Planned | | |
| C-03 Backend: request limits and names | ⏳ Planned | | |
| C-04 Core commands | ⏳ Planned | | |
| C-05 Logs | ⏳ Planned | | |
| C-06 Local runs | ⏳ Planned | | |
| C-07 `ff init` and examples | ⏳ Planned | | |
| C-08 Phase-1 release and docs | ⏳ Planned | | |
| C-20 Spike and ADR 0003 | ⏳ Planned | | |
| C-21 Function model v2 | ⏳ Planned | | |
| C-22 Upload and validation | ⏳ Planned | | |
| C-23 Version images and registry | ⏳ Planned | | |
| C-24 Inline code on the same path | ⏳ Planned | | |
| C-25 Node.js runtime on glibc | ⏳ Planned | | |
| C-26 `ff package` and zip deploys | ⏳ Planned | | |
| C-27 Phase-2 docs and e2e | ⏳ Planned | | |
| C-30 SAM `template.yaml` | ⏳ Planned | | |
| C-31 Environment variables | ⏳ Planned | | |
| C-32 `ff export --target aws` | ⏳ Planned | | |
| C-33 `ff doctor` | ⏳ Planned | | |
| C-40 `ff login` | ⏳ Planned | | |
| C-41 Distribution | ⏳ Planned | | |
| C-42 Published runtime images | ⏳ Planned | | |
| C-43 CI usage | ⏳ Planned | | |
