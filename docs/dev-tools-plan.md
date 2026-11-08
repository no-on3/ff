# Developer tools plan: `ff` for everyone, the whole app on a laptop, and what customers see first

| | |
|---|---|
| **Status** | Proposed on 2026-11-04, the day step 5 closed, when you asked what to add while the company that step 6's payments and invoices wait for doesn't exist yet. Checked against the code the same day by a read-only survey (§1), on `feat/step-5` at `babaca6`, `master` at `05f459e`. **Confirmed and started on 2026-11-08** with its fourteen choices as recommended (§9; the [decision log](decisions.md)'s 70 to 83), on `feat/dev-tools`; the progress log (§11) says what is built. It takes the four tasks of the [step-6 plan](step-6-plan.md) that wait for no company (`ff login`, `ff`'s builds and downloads, the runtime images published, the development server updating itself) and leaves step 6 what does: card top-ups, El Fatoora, the content domain's switch and production's certificates. Its [task list](dev-tools-tasks.md) keeps the order. |
| **Goal** | Tools a developer uses on their own machine, and what a customer sees of FF before paying anything. A customer logs in to `ff` with the browser, installs it from FF's own site on Linux, macOS or Windows, and runs it in a CI. A developer runs a whole app on a laptop, offline, with the same `template.yaml` that deploys on FF and on AWS: functions, URLs, schedules, queues, buckets, sites, a database, a cache, mail captured. Six templates start the common apps. An AI coding agent works with FF through `ff mcp`. A shop's payment code is tested against a double of Konnect. FF has a status page, its development server updates itself, and the content domain is registered and requested from the Public Suffix List, so that step 6's switch waits for nothing. And one request can be followed through a URL, a queue and a second function |
| **Parent plans** | The [CLI plan](cli-plan.md): its phase 4 (C-40 to C-43) and its §10's questions 3, 5 and 7; [What to build next](what-to-build-next.md): §9.6 (developer tools: local development, templates, tracing, a status page), §9.7 (payment integrations), §12's rows 6 and 9; the [step-5 task list](step-5-tasks.md)'s §4: group A's `ff login`, distribution, updater and domain, group C's payment integrations, group D's local development, templates and tracing; the [step-6 plan](step-6-plan.md)'s D6, D7 and D9, which this plan takes; the [local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): §6.10 (the conformance suite's local target), §7 (the exit kit), §10 (templates); the [decision log](decisions.md)'s 39 and 42 |
| **Builds on** | `ff local` and its URL event (the CLI plan's phase 1, [ADR 0007](adr/0007-function-events.md)); the SAM reader and the stacks ([ADR 0016](adr/0016-sam-templates.md), step 5's X-12 and X-13); `ff sites deploy` and its signed S3 client (step 4); the front doors' L1 fixtures (steps 2 to 5); Keycloak's `ff-cli` client ([ADR 0004](adr/0004-identity-and-tenancy.md)); the development server's install ([`deploy/dev-server`](../deploy/dev-server/README.md)); the operator's monitoring ([ADR 0006](adr/0006-operator-monitoring.md)); the pipeline's stages and caches (the step-5 task list's T-01 to T-11) |
| **Decision records** | ADR 0017 (the whole app on a laptop: `ff local` as FF's emulator, what it answers and what it leaves out), ADR 0018 (`ff`'s releases: built, signed and served by FF), each from M-01's spikes. The step-6 plan's three ADRs then take 0019 to 0021 |

Task numbers start with M, for the developer's *machine*: what runs there (`ff login`, `ff local`, `ff mcp`, the templates), or is seen from there (the downloads, the status page). The CLI plan's C-40 to C-43 are M-02 to M-04; the step-6 plan's G-02 to G-04 and G-10 are M-02 to M-04 and M-11, named in each. As with every plan: no task number in the code, its comments or its tests.

## 1. Where FF stands

Checked against the code on 2026-11-04 (`feat/step-5` at `babaca6`; `master` at `05f459e`, step 5 merged).

| Finding | Where | Consequence |
|---|---|---|
| **`ff` logs in with an API key alone:** `ff config set-token` or `FF_TOKEN`, with profiles in `config.toml` and `credentials.toml` (0600). Keycloak's `ff-cli` client is in both realm files: public, the device grant on, the `ff-api` audience. The backend takes any of the realm's tokens but the admin app's. There is no `ff login`, no refresh and no `ff api-keys`; `ff keys` manages the access keys AWS's tools use. | `cli/src/auth.rs`, `cli/src/config.rs`; `deploy/keycloak/ff-realm.json` (`ff-cli`, `oauth2.device.authorization.grant.enabled`); `BE/src/auth/auth.guard.ts`; `BE/src/api-keys/` | `ff login` needs nothing new on the server (M-02). |
| **`ff` is built for Linux on x86_64 only,** by hand: `hack/build-cli.sh` makes a static binary (musl) with its SHA-256 beside it, the commit built in, and the guide tells a customer to run that script. No release, no signature, no install script, no update notice; the workflow has no release job. Its Unix-only code is in four places: the files' modes (0700, 0600), a package's file modes and its symlinks, an exported script's mode. Its dependencies (ureq with rustls and the platform's verifier, ring, notify, ctrlc, rpassword, directories) build on Windows and macOS. The toolchain is pinned, 1.91.0. | `hack/build-cli.sh`; `cli/Cargo.toml`, `cli/rust-toolchain.toml`; `cli/src/config.rs:287`, `cli/src/package/mod.rs:92`, `cli/src/commands/export/mod.rs:67`; [getting started](getting-started.md) §3; `.github/workflows/ci.yml` | Five builds, a release job, signatures, a downloads site (M-03). |
| **The runtime images are built where they run** and never published: the development cluster imports them (`hack/k8s/load-images.sh`), the development server builds them; `ff local` names `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3` and, when the image isn't on the machine, says to build it from the repository. | `cli/src/local.rs:16`, `cli/src/local.rs:161`; `deploy/dev-server/server.sh`; `runtimes/*/Dockerfile` | Published with each release, pinned by digest (M-04). |
| **`ff local` runs one function:** `invoke` once, or `start` on a port, in Docker, in the runtime image with the pod's hardening, `--watch` restarting it when its code changes, `--url` serving it as its URL would, the URL event built as the backend's gateway builds it. Nothing else runs locally: no queue, bucket, schedule, database or second function; the variables come from `--env`. | `cli/src/commands/local.rs`, `cli/src/local.rs`, `cli/src/local_url.rs` | The whole app on a laptop builds on it (M-05 to M-07). |
| **A template deploys on FF with its functions, URLs, aliases, schedules, SQS and S3 events, queues, and buckets with sites and notifications,** read by `ff`'s own reader within FF's subset of SAM. The small app is one template: three functions, a URL with CORS, a queue read in batches with partial failures, a nightly schedule, two buckets, one a site; its database, cache and mail made apart, their strings the functions' secrets. `ff` has no reader of schedule expressions: it asks the API; the backend's reads EventBridge's `cron()` and `rate()`, with its tests. | `cli/src/sam/` (`subset.rs`, `plan.rs`, `resolve.rs`, `parameters.rs`); [`examples/orders-app/template.yaml`](../examples/orders-app/template.yaml); `cli/src/commands/schedule.rs`; `BE/src/schedules/schedule-expression.ts` | `ff local start template.yaml` reads what `ff deploy` reads, and needs a reader of expressions of its own, the backend's ported with its tests (D3). |
| **Each front door is the backend's TypeScript, one port each:** function URLs (3001), S3 (3002), SQS (3003), sites (3004), SES (3005) and Lambda's API (3006), behind one Signature Version 4 check; their L1 tests hold each operation's requests and answers. `ff` signs requests the same way, for `ff sites deploy`. | `BE/src/function-urls/function-url.gateway.ts`, `BE/src/storage/front-door.ts`, `BE/src/queues/sqs-operations.ts`, `BE/src/email/ses-operations.ts`, `BE/src/lambda/`; `cli/src/s3.rs` | A laptop's copy of them is a port of a subset, or that code run in a container: M-01's spike measures both (D3; §9, 5). |
| **`ff init` makes three things:** a function (hello world), a Terraform project of four modules, and `sam init`'s hello world as FF takes it. Every command answers `--output json` as one JSON document through one `Output`, and exits 3 to 6 by kind. | `cli/src/commands/init.rs`, `cli/templates/`; `cli/src/output.rs`, `cli/src/error.rs` | Templates are files the binary holds (M-08); an MCP server is each command's JSON given to an agent (M-09). |
| **Nothing of FF speaks to AI coding agents.** The [code-search plan](code-search-plan.md), proposed and not confirmed, would, through CIAK, and waits for card top-ups. | `cli/src/`; `docs/` | `ff mcp` (D5). |
| **Request IDs run end to end; traces don't.** Each call has its ID, in the runtime's START, END and REPORT lines, in `context.awsRequestId` and in the history; a queue message may carry `AWSTraceHeader`, kept and given to the reader's event, as SQS does; `_X_AMZN_TRACE_ID` is reserved in a function's environment and never set; a URL's response carries no `X-Amzn-Trace-Id`; `function_invocations` has no trace ID. | `runtimes/nodejs/src/main.ts`, `runtimes/python/ff_runtime/main.py`; `BE/src/queues/sqs-messages.ts:93`, `BE/src/event-sources/sqs-event.ts:40`; `BE/src/functions/environment.ts:17` | A trace ID given at each entry and kept with each call (D8). |
| **Monitoring is the operator's:** VictoriaMetrics, vmalert's rules, Alertmanager to e-mail, Grafana's dashboards; the backend's `/healthz` is public and answers `{"status":"ok"}` with no check behind it. There is no status page. The development server's own proxy routes FF's eight fixed names and three wildcards from one route file of FF's. | `deploy/k8s/monitoring/`; `BE/src/health/health.controller.ts`; `deploy/dev-server/ff.caddy` | A status page from probes outside the backend (D7). |
| **The development server updates only when someone runs `install.sh` from a checkout:** the files copied, `server.sh` as root, each step doing nothing when already done, then the smoke test. It has held a customer since 2026-11-01; its databases were dumped by hand before each install (`/data/ff/backups`). Nothing pulls updates, and GitHub holds no key to the server. | `deploy/dev-server/install.sh`, `server.sh`, `smoke.sh`, `README.md` | An updater on the server (D9, M-11). |
| **Every name is under one domain,** `dev.ffunc.cloud` on the development server; the content domain the decision log's 42 asks about isn't registered. The Public Suffix List takes weeks to list one. | `deploy/dev-server/k8s/edge.env`; the [decision log](decisions.md), 42 | Registered and requested now, switched in step 6 (D10). |
| **No payment provider has code;** the step-6 plan's D1 wants a stand-in Konnect for FF's own suites. Konnect's sandbox credentials come with a merchant's onboarding, which asks for a company's documents: a developer here can't test a shop's payments offline either. | `BE/src/billing/payments/`; the [step-6 plan](step-6-plan.md), D1 | One stand-in, in `ff`, for FF's suites and for customers' shops (D6). |
| **The pipeline:** `static`, `unit`, `db`, `security` with the images, the cluster's five stages each on a runner of its own, `platform` and `tools` nightly; no release job. The repository is public for now (the decision log's 68), its minutes free; a private one's Windows and macOS runners count 2 and 10 minutes a minute. | `.github/workflows/ci.yml`; `hack/ci.sh` | A release job that builds on Linux where it can, at a release's rate (D2). |

## 2. Goals and non-goals

**Goals:**

1. **`ff` for everyone.** A customer logs in with the browser (`ff login`), installs `ff` from FF's own site on Linux, macOS or Windows with one command, is told when a newer one exists, and runs it in a CI with a key made by `ff api-keys`.
2. **The whole app on a laptop.** `ff local start template.yaml` runs a template's functions, URLs, schedules, queues, buckets and sites on the developer's machine, offline, with FF's runtime images, a PostgreSQL and a Valkey when asked, and mail captured; the same template then deploys on FF and on AWS unchanged.
3. **A start for every common app.** Six templates, each deploying on FF and on AWS, running locally, with tests.
4. **FF reachable by AI coding agents.** `ff mcp`, a server of the Model Context Protocol that gives an agent `ff`'s commands: reads by default, writes when allowed, never a delete.
5. **A payment provider's double.** `ff local konnect` answers as Konnect's API does, for customers' shops and for FF's own suites.
6. **What customers see first.** A status page from probes outside the backend; the development server updating itself from `master`'s commits whose tests passed; the content domain registered and requested from the Public Suffix List.
7. **One request's trail.** A trace ID given at each entry, kept with each call and passed on as AWS passes it, read by `ff trace`, `ff logs --trace` and the console.

**Non-goals:**
- Card top-ups, El Fatoora, the content domain's switch, production's certificates and two sites: step 6's.
- `ff local` as a copy of FF: no plans, keys of several levels, metrics, alarms, versions in pods of their own, gVisor or usage records; the guide's table says what it is and isn't.
- A self-updating `ff` (`ff update`): the notice names the command; the install script installs again.
- Apple's notarization: Apple's program is paid by card, every year.
- An MCP server that holds a login of its own, or runs on FF's servers: it runs on the developer's machine, as the developer.
- OpenTelemetry's export of traces, spans inside a function, a tracing store: the trail is read from the records FF keeps.
- Flouci's double, and the e-invoicing API.
- The code-search plan, which has a plan of its own.

## 3. Decisions

Proposed; §9 lists the choices to confirm.

### D1. `ff login`, `ff logout` and `ff api-keys` (C-40; the step-6 plan's D6)
- **The device flow** (RFC 8628) against Keycloak's `ff-cli` client: `ff login` asks the device endpoint, prints the address and the code, opens the browser when there is one (`xdg-open`, `open` or `start`: the one place the systems differ), and asks the token endpoint at the interval Keycloak gives, until the user has signed in, slowing down when told, stopping when the code expires and saying so.
- **The tokens** go in `credentials.toml` (0600) under the profile: the access token, the refresh token and when the access token ends. A call made within a minute of its end refreshes it first; a refresh refused says to log in again, and nothing else is tried.
- **The account:** a user with several accounts names one with `ff config set account <id>` or `--account`; with one account, it is chosen; with several and none named, `ff` lists them and stops, as `ff whoami` lists them.
- **`ff logout`** removes the profile's tokens, on this machine; `ff whoami` then says there is none.
- **`ff api-keys create --name <n> --scopes <a,b> [--expires 90d]`, `list` and `revoke <id>`:** `POST`, `GET` and `DELETE /api-keys`, for an owner's user token, which is why they come with the login; the new key is printed once, in a field with `--output json`, for scripts.
- **The order stays:** a key given by `FF_TOKEN` or a profile comes before a login's tokens, so that CI keeps working unchanged; `ff login` on a profile that holds a key says so and keeps the key unless told `--replace`.
- **Nothing changes on the server.**

### D2. `ff` built, signed, served and kept current (C-41 to C-43; the step-6 plan's D7)
- **Five builds:** Linux on x86_64 and arm64 (static, musl, as `hack/build-cli.sh` makes the first), Windows on x86_64 (`x86_64-pc-windows-gnu`), macOS on x86_64 and arm64 (§9, 4).
  - All five are built on one Linux runner by cross-compiling (Windows with MinGW, macOS with `cargo-zigbuild`, zig as the linker) if M-01's spike proves it, `ring`'s C code and the platform verifier's frameworks included; else the two macOS builds come from one macOS runner job at each release, whose minutes count ten a minute on a private repository: at a release's rate, a few hundred a month at most.
  - `cargo test` runs on each system at each release (a Linux, a Windows and a macOS runner), and on Linux at each push, as now.
  - **The Unix-only code gets its Windows counterpart:** the credentials file readable by its owner alone through the file's own permissions, a package keeping Lambda's modes without reading the disk's (0644 for files, 0755 for what starts with `#!`), a symlink in a package refused on Windows saying why.
- **A release** is a tag `ff-v<version>` on `master`, which the release job builds from, `cli/Cargo.toml`'s version being the tag's; the binary names its version and its commit, as now.
  - Each file comes with its SHA-256 and a minisign signature. The signing key is the release job's one secret, made by you with `minisign -G` and put in GitHub's secrets; the public key is in the repository (`cli/release/minisign.pub`), in the install scripts and on the downloads page.
  - `ff` verifies minisign's signatures itself, Ed25519 by `ring` and the prehash by the `blake2` crate, with the public key compiled in: for the update notice's manifest, and for the images' archives it loads. A new key means a new install by the script, which the page says with the key's fingerprint.
- **The downloads are a site of FF's own,** on a bucket of FF's own account, at `get.<domain>` (§9, 3): the install scripts, the binaries, their checksums and signatures, `latest.json` (the newest version, each file's name and SHA-256, signed), the runtime images as archives, and the CI examples. GitHub's releases and `ghcr.io` hold copies. FF serves itself as it serves its customers: the release job deploys the site with `ff sites deploy`, with a key that reaches that bucket alone.
  - **The install script,** `curl -fsSL https://get.<domain>/install.sh | sh`: it names the system and the processor, downloads the binary, checks its SHA-256 against `latest.json`, checks the signature when `minisign` is on the machine, installs into `~/.local/bin` (or `--prefix`), and says what to add to `PATH`. A PowerShell one, `irm https://get.<domain>/install.ps1 | iex`, does the same on Windows. Both refuse a checksum that differs, saying nothing was installed.
- **The update notice:** once a day at most, after a command that reached the API, `ff` reads `latest.json`, verifies it, and says on stderr when a newer version exists, with the one line that installs it; `FF_NO_UPDATE_CHECK=1` or `ff config set update_check false` turns it off; `--output json` and `--quiet` never show it.
- **The runtime images published** (C-42): each release pins its two images by digest; the release job publishes them to `ghcr.io` under FF's name and as archives on the downloads site (`docker save`, zstd, signed). `ff local` pulls the digest it pins and, when it can't, loads the archive, verified. The two constants in `local.rs` become the release's manifest of images.
- **`ff` in a customer's CI** (C-43): two examples, GitHub Actions and GitLab CI, each installing `ff` from the downloads, an API key with the scopes a deploy needs in `FF_TOKEN`, `ff deploy --output json`, and the job failing on `ff`'s exit codes with the account's message. The GitHub one runs in FF's own workflow against the development stack, as its proof.

### D3. The whole app on a laptop: `ff local start <template.yaml>` (ADR 0017)
- **Inside `ff`, in Rust, one process** (§9, 5). `ff local start template.yaml` reads the template as `ff deploy` reads it, with the same reader and the same refusals, then runs each of its resources on this machine:
  - **functions,** each in its runtime container as `ff local start` runs one today, started at its first call and kept while the command runs, stopped after `--idle` (10 minutes) without a call, `--watch` restarting the one whose code changed; its variables the template's, with `!Ref` and `!GetAtt` resolved to local values (a queue's URL on the local port, a bucket's name as written); the variables the backend gives a pod, pointed at the local front door (`AWS_ENDPOINT_URL_S3`, `_SQS`, `_SESV2`, `_LAMBDA`, a local key, FF's region); its secrets from a file, `--secrets .env.local` (`KEY=value` lines, never committed: `ff init`'s `.gitignore` lists it), since secrets have no local counterpart;
  - **one local front door** on one port (`--port`, 3700 by default): Lambda's `Invoke` (waiting; `Event`, with its retries and `EventInvokeConfig`'s destinations; `DryRun`) and `GetFunctionConfiguration`; SQS's `SendMessage`, `SendMessageBatch`, `ReceiveMessage` with its long poll, `DeleteMessage`, `DeleteMessageBatch`, `ChangeMessageVisibility`, `GetQueueUrl`, `GetQueueAttributes` and `PurgeQueue`, the queues' redrive to their dead-letter queue; S3's `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `DeleteObjects`, `ListObjectsV2`, `CopyObject`, the multipart upload (`Create`, `UploadPart`, `Complete`, `Abort`), `HeadBucket` and presigned URLs; SES v2's `SendEmail`, each message kept as a file under `.ff/local/mail/` and said on stderr, none sent; each in the protocol the AWS SDKs speak, as FF's front doors answer it;
  - **function URLs** at `http://<function>.fn.localhost:<port>`, the URL event built as today's `--url` builds it, CORS as the template says; **sites** at `http://<bucket>.site.localhost:<port>`, the bucket's objects with its index and error documents, and `--site <bucket>=<folder>` serving a folder as the bucket's files without a copy. Browsers reach `*.localhost` on this machine; the SDKs take `127.0.0.1` with path-style addressing, as the development stack does;
  - **schedules,** run on time while the command runs, from a reader of EventBridge's expressions ported from the backend's, with its tests as one table of expressions and next runs both read, so that both agree; `ff local run <schedule>` runs one now;
  - **event source mappings,** polling the local queues as the backend's poller does: batches, the batching window, `ReportBatchItemFailures`, the visibility timeout, the dead-letter queue after `maxReceiveCount`;
  - **bucket notifications,** calling their function or queue with S3's event, as the backend builds it;
  - **a PostgreSQL and a Valkey** when asked, `--with postgres`, `--with valkey`: a container each, the images pinned by digest, `DATABASE_URL` and `REDIS_URL` set for every function unless the secrets file names them, their data in Docker volumes of the project's, kept between runs.
- **What it keeps:** the queues' messages in memory; the buckets' objects as files under `.ff/local/buckets/<bucket>/`, so that a developer looks at them; the mail under `.ff/local/mail/`; each function's log under `.ff/local/logs/<function>.log` and on stderr. `ff local reset` empties it.
- **Signatures:** a signed request is checked against the local key, as FF checks one, so that a wrong key shows here; a request without a signature is taken, for `curl`. The local key is printed at start and written to `.ff/local/credentials`, for the shells and tools that read AWS's variables.
- **What it leaves out, said in the guide's table:** versions and aliases (an alias is a name for the function as it is), plans, limits and usage records, metrics and alarms, custom domains and TLS, the log store, gVisor, the account's internet switch, keys of several levels, FIFO queues, S3's versioning, and the operations FF's front doors refuse. An operation outside answers as FF answers one it doesn't offer, in the service's words.
- **Why in `ff`:** the developer has the binary already; it starts in a second, offline, on the three systems with Docker alone; the template reader and the URL event are in it. A backend in Docker would bring PostgreSQL, Keycloak, the store, the registry and a stand-in for Kubernetes to a laptop: the on-premises edition's work (the parent plan's S-06), a plan of its own. The risk is drift, a local answer that differs from FF's. It is met by **shared fixtures:** the backend's L1 holds each front door's requests and answers, and `ff local`'s tests read the same files for every operation it serves, so that a case added on one side fails on the other until both answer alike; and by **the client suites:** the AWS CLI's S3 and SQS cases of L4 run against `ff local` in the `ff` suite, and the small app runs on it end to end. M-01's spike measures the port against the other way, the backend's modules in a container, before ADR 0017 chooses.

### D4. Templates: `ff init --template <name>`
- **Six, besides the three there are** (§9, 7), each for both runtimes unless said, each within FF's subset of SAM, so that `ff deploy`, `ff local start` and `sam deploy` all take it unchanged:
  - `rest-api`: a function with a URL, its routes by path and method, a database through `DATABASE_URL`, CORS for one origin;
  - `cron-job`: a schedule, a report written to a bucket, a queue for its failed runs;
  - `webhook`: a payment provider's notification received right, Konnect's by default: the request kept, the provider asked again, the redirect's parameters never trusted, each payment handled once by its reference; `ff local konnect` as its double (D6);
  - `queue-worker`: a URL that enqueues, a worker reading in batches with partial failures, a dead-letter queue;
  - `image-resize`: an upload to a bucket makes a thumbnail under another prefix; `sharp` for Node.js and Pillow for Python, both native, built by `ff package --container`;
  - `site-with-api`: a site on a bucket and a function with a URL, the site's `config.json` naming it: the small app's shape, smaller.
- **Each one:** `template.yaml`, the code, `events/`, tests outside the code's folder (`node --test`, `python3 -m unittest`), `samconfig.toml`, a `.gitignore`, and a README that says what it does, how it runs locally, deploys on FF and on AWS, and what is the same as on AWS. `ff init --list` names them.
- **Each is a fixture:** `hack/test-sam-fixtures.sh` runs `sam validate --lint` and cfn-lint on each; the `ff` suite deploys each once, calls it and deletes its stack; `ff local`'s tests run each.

### D5. `ff mcp`
- **A server of the Model Context Protocol on stdio,** for the agents that run on the developer's machine (Claude Code, Cursor, VS Code's, and the others that speak it): `ff mcp` reads JSON-RPC requests on stdin and answers on stdout: the handshake, `tools/list` and `tools/call`, at the protocol's current version, written by hand. The protocol is small, and `ff` keeps its dependencies few ([ADR 0002](adr/0002-cli.md)).
- **A tool is a command:** each tool names the command it runs and takes its flags as parameters; its answer is the command's `--output json` document, its error the command's message and exit kind. Nothing is written twice: `Output` writes to a buffer for the server instead of stdout, a refactor that serves the tests too.
- **Reads by default:** the functions, one function, its logs, history and metrics, the account's usage, balance and estimate, the queues, buckets, databases and caches, `doctor` on a folder or a template. **Writes with `--allow-write`:** `deploy`, `invoke`, `env set`, `publish`, `alias set`, `queues send`, `sites deploy`. **Never:** a delete, a key, `api-keys`, `secrets set` (a secret's value would pass through the agent) and `login`: those stay a person's commands.
- **The identity is the developer's:** the profile's token or key, as any command; `--profile` and `--account` as flags. The server runs nowhere but on the developer's machine, holds no state and opens no port.
- **The guide** gives the one line for each agent (`claude mcp add ff -- ff mcp`, Cursor's and VS Code's JSON), and a page of what an agent may do with it.

### D6. The Konnect stand-in: `ff local konnect` (the step-6 plan's D1)
- **A server in `ff`** that answers Konnect's API as its documentation describes it, as P-34 recorded it: the `x-api-key` header; `POST /payments/init-payment`, amounts in millimes, answering `payUrl` and `paymentRef`; `GET /payments/:id`, answering `pending`, `completed` or `failed`. Each answer names the document and section it comes from, in a header, as the step-6 plan's rule says.
- **The payer's page** at `payUrl`: "Pay" and "Fail" buttons, and `?outcome=paid` or `failed` for tests; it then calls the merchant's webhook with `payment_ref`, as Konnect does, and sends the browser to the merchant's success or failure address.
- **Faults on demand:** `--delay`, a notification sent twice, a notification for a payment that doesn't exist, the webhook called before `GET /payments/:id` says `completed`: what the `webhook` template's tests and FF's own top-ups (step 6's G-05) must survive.
- **One stand-in, two users:** customers' shops offline, since Konnect's sandbox comes with a merchant's onboarding; and FF's own L4 in step 6, which runs the built `ff`.

### D7. The status page
- **What it shows:** each piece as a customer meets it, probed every minute: the API, the console, login, the Lambda, S3, SQS and SES endpoints, a canary function at its URL, a site; the last 90 days as a bar a day, the month's uptime, the current state; and incidents, written by hand in a Markdown file the page shows.
- **How:** a probe account of FF's own on the server, with a key that reaches the probe's bucket, queue and function alone; a shell script with `curl` and `jq` (as the smoke test is written), run by a systemd timer as a user of its own, which appends each minute's results to a file; a Python renderer, the standard library alone (as `hack/check-docs.py`), which writes the page from the file. No dependency is installed on the server.
- **Served outside the backend:** on the development server, a directory the server's own proxy serves as `status.<domain>`, FF's ninth fixed name, in FF's route file; when the cluster or the backend is down, the page is up and says so. The probe runs on the server itself, which the page says: a whole server's outage shows as the page's. In production, the probe and the page go to the second site's machine when there is one; until then, to the edge's.
- **Tested:** the probe and the renderer against a stand-in backend in `hack/`, each state (up, down, slow, a certificate about to expire) rendered and checked; on the server, by the smoke test.

### D8. One request's trail
- **A trace ID in X-Ray's format** (`Root=1-<time>-<random>`), the one AWS Lambda gives `_X_AMZN_TRACE_ID`, so that code and tools that read it there read it here.
- **Where it starts:** a function URL's request, from its `X-Amzn-Trace-Id` header when it has one, as API Gateway takes it, else new, and given back in the response; an `Invoke` through Lambda's API or FF's own, from the header, else new; a schedule's run, new; a bucket notification, new, as S3's are; a queue message's `AWSTraceHeader`, which the reader's call joins, as Lambda joins it.
- **Where it is kept:** `function_invocations.trace_id`, with each attempt of an asynchronous call, the destination's record and the batch's call; the runtime sets `_X_AMZN_TRACE_ID` for each call, as Lambda does, and writes it in its structured log lines, so that the log store finds them.
- **How a function passes it on:** as on AWS, the code does: the AWS SDKs add the header only when told. The templates show the two lines, a middleware on the SDK's client in Node.js, botocore's event hook in Python, which read `_X_AMZN_TRACE_ID` and set `X-Amzn-Trace-Id` and `AWSTraceHeader`; the same lines give X-Ray its links on AWS. FF's runtimes do what Lambda's do, no more.
- **What reads it:** `GET /traces/:id`, every call of the account with that trace, in time order, with how each came (the URL, a schedule, a queue and its message's ID, an asynchronous call and its attempt, a notification), its function, version, duration and status; `ff trace <id>` prints it as a timeline, `ff logs --trace <id>` the lines across functions; the console's history row has a "Trace" link. Kept as long as the history. No export and no spans inside a function: later, if asked.

### D9. The development server updating itself (the step-6 plan's D9; decision 39)
- **A timer on the server** (systemd, every 10 minutes) asks GitHub for `master`'s newest commit and that commit's run, with a token that reads the workflow's results alone, or none while the repository is public. When a newer commit has passed every job of its push, the updater fetches it with a read-only deploy key into a new directory, at night, between 01:00 and 05:00 in Tunis, since the server has a customer (§9, 12).
- **An update** dumps FF's databases into `/data/ff/backups`, as the deploys by hand did, runs the new directory's `server.sh`, never the running copy's (a script read as it runs must not change), then the smoke test; then the new directory becomes `/data/ff/src`.
- **A failure stops the updater** until someone looks, with no retry, and is e-mailed to the operator through the server's own mail; each update's commit, time and result go to a log on the server. `install.sh` stays, for the first install and for a commit by hand.
- **GitHub holds no key to the server,** and the repository holds nothing about it: its address stays out, as now.

### D10. The content domain: registered and requested now, switched in step 6 (decision 42)
- **You register the domain** (§9, 13) at OVH, as `ffunc.cloud` is. This plan writes the Public Suffix List's request (the `_psl` TXT record it asks for, and the pull request's text), which M-15 sends with your go-ahead, since the list takes weeks. The switch of function URLs, sites and S3 onto it, with production's certificates, stays step 6's G-09, which then waits for nothing.

### D11. What stays in step 6
- Card top-ups (G-05, G-06), the invoice's details and El Fatoora (G-07, G-08), the content domain's switch and production's certificates (G-09), the accountant's letter and the security test's scope (G-11), and its close. Its G-02 to G-04 and G-10 are this plan's M-02 to M-04 and M-11; its ADRs take 0019 to 0021.

## 4. Data model

Proposed:

- **`function_invocations`:** `trace_id`, text, indexed with the account and the time; the asynchronous calls' events and the destinations' records carry it to each attempt.
- **Nothing else on the server.** On the developer's machine: `credentials.toml` gains, per profile, `access_token`, `refresh_token` and `expires_at`; `config.toml` gains `update_check`; `.ff/local/` holds `ff local`'s buckets, mail, logs and credentials.
- **On the development server:** `/data/ff/status/` (the probe's results, the page, the incidents) and `/data/ff/updater/` (its log and its state), both root's.

## 5. API changes

Proposed:

- **`GET /traces/:id`** (members, `logs:read`): the calls of the trace, as D8 says; its rules in both of L5's loops.
- **`X-Amzn-Trace-Id`** taken on `POST /functions/:id/invoke`, on Lambda's `Invoke` and on function URLs, and given back by URLs; the history's records and `ff history` carry `traceId`.
- **No route** for `ff login` (Keycloak's endpoints), the downloads (a site), the status page (static files), `ff mcp` and the templates (local), or the updater (GitHub's API).

## 6. Working rules

As step 5's, which are the repository's [`CLAUDE.md`](../CLAUDE.md):
- a commit for each task or part, `type(scope): summary (M-xx)`, with its tests, its documents and this plan's log;
- one heavy process at a time, `hack/check-resources.sh` first, the workers capped;
- refactor as you go;
- L1 to L5 for what each part touches, with a new route's rules in both of L5's loops;
- the backend's names mirrored in `ff` and the console;
- the console checked in a browser, at a phone's width too;
- no task or decision number in the code, its comments or its tests.

New with this plan:

- **`ff local` answers as FF answers, proved by the same files.** For every operation it serves, its tests read the backend's L1 fixtures; a case added on one side is added to the other in the same commit, or the suites say so.
- **A tool of `ff mcp` is a command, nothing more:** no code path of its own, no answer the command doesn't give.
- **Every build passes `cargo test` on its own system** at each release; code behind `cfg(unix)` has its Windows counterpart, or refuses on Windows saying why.
- **Three new places hold credentials, each named in the guide with what it can do:** the release job's signing key, the server's deploy key and token, the probe account's key on the server. None is ever printed.
- **No real payment in a test:** the stand-in answers from Konnect's documentation, each answer naming its source.
- **A running script is never edited:** the updater runs the fetched copy, as `install.sh` runs the copied one.

## 7. Tasks

The order follows what waits least and gives most. Phase 1 is small and waits for nothing but your answers. Phase 2 is the step's weight. Phases 3 and 4 follow, each on its own; tracing comes last, as the one phase that changes the backend.

### Phase 0: groundwork

#### M-00: The plan and the baseline
- Your choices confirmed (§9), the decision log written; `feat/dev-tools` made from `master` at `05f459e`, step 5's merge; the baseline from the branch's first green run: each suite's counts and times.

#### M-01: Spikes, and ADRs 0017 and 0018
- **Cross-compiling `ff`:** the five targets from a Linux runner (MinGW; `cargo-zigbuild`), each binary run on its system and `cargo test` on GitHub's Windows and macOS runners; `ring` and the platform verifier included. What fails goes to a macOS runner job.
- **The device flow** against the development realm, from `ff`: pending, slow down, expired, success, the refresh.
- **The local front door's shape:** S3's `PutObject`, `GetObject` and `ListObjectsV2`, and SQS's `SendMessage`, `ReceiveMessage` and `DeleteMessage`, in Rust, against the AWS CLI and both SDKs, their tests reading the backend's L1 fixtures; beside it, the backend's `storage` and `queues` modules run in Node.js without NestJS and the database, measuring what carries them (what they need of TypeORM, the configuration and the audit log), the lines, the start time, the memory, and how many of the fixtures each side passes.
- **A reader of EventBridge's expressions in Rust,** against the backend's tests' table.
- **minisign verified in Rust** (`ring` and `blake2`), against signatures `minisign` makes.
- **An MCP handshake** with Claude Code and one other client, by hand, against a server that lists one tool.
- **ADR 0017** (the whole app on a laptop) and **ADR 0018** (`ff`'s releases), from what the spikes found.

### Phase 1: `ff`, ready for customers

#### M-02: `ff login`, `ff logout` and `ff api-keys` (C-40; the step-6 plan's G-02)
- D1.
- **Tests:** `cargo test` against a stand-in authorization server (pending, slow down, expired, denied, success, the refresh, a refresh refused); the `ff` suite against the development realm (`docker compose --profile auth`); the guide's section.

#### M-03: `ff`'s builds, signatures and downloads (C-41; G-03)
- D2's builds, the release job, the signatures, the downloads' site, the install scripts and the update notice; the Unix-only code on Windows.
- **Parts:** 1, the five builds and `cargo test` on three systems; 2, the release job, minisign and `latest.json`; 3, the downloads site, the install scripts and the notice.
- **Tests:** the install scripts against a changed checksum and a wrong signature; the verifier's tests; `cargo test` on each system at the release; the site's deploy from the job against the development stack.

#### M-04: The runtime images published, and `ff` in a customer's CI (C-42, C-43; G-04)
- The images pinned by digest, published to `ghcr.io` and as archives; `ff local` pulling the digest, or loading the archive, verified.
- The two CI examples, the GitHub one run in FF's workflow against the development stack.

### Phase 2: the whole app on a laptop

#### M-05: The local front door: functions, URLs, schedules and Lambda's invoke
- D3's core: the template read, the functions started at their first call with their variables and secrets, the URLs with CORS, the reader of expressions and the schedules' runs, `Invoke` waiting, `Event` with its retries and destinations, `DryRun`; `.ff/local/`, `--watch`, `--idle` and `ff local reset`.
- **Tests:** `cargo test` with the shared fixtures and the table of expressions; the `ff` suite starts `ff init --template sam`'s application and the small app's functions on it.

#### M-06: Queues and buckets locally
- SQS's operations, the event source mappings and the dead-letter queue; S3's operations, the multipart upload, presigned URLs, the notifications, the sites and `--site`; signatures checked against the local key.
- **Tests:** the backend's fixtures shared; the AWS CLI's S3 and SQS cases of L4 against `ff local`, in the `ff` suite.

#### M-07: Databases, caches, mail, and the small app end to end
- `--with postgres` and `--with valkey`; SES's `SendEmail` captured.
- **The small app on `ff local`:** an order posted at the local URL, its receipt made through the local queue into the local bucket, its e-mail captured, the nightly run by hand; in the `ff` suite.
- The guide's page, with the table of what `ff local` is and isn't; ADR 0017 as built.

### Phase 3: templates, agents and the provider's double

#### M-08: Six templates
- D4; each a fixture of `hack/test-sam-fixtures.sh`; the `ff` suite deploys each, calls it and deletes its stack; `ff local`'s tests run each.

#### M-09: `ff mcp`
- D5; `Output` writing to a buffer.
- **Tests:** a scripted stdio session in `cargo test` (the handshake, the list, a read, a write refused without `--allow-write`, a delete refused always); the `ff` suite with a small client against the stack; the guide's page.

#### M-10: `ff local konnect`, and the `webhook` template's tests
- D6, with its faults; the template's tests through it.

### Phase 4: the server and the public

#### M-11: The development server updating itself (G-10)
- D9: the timer, the updater, its backup, its log and its e-mail; the guide's page.
- **Tests:** the updater's script against a stand-in for GitHub (a commit that passed, one that failed, one installed already, a failed smoke test, outside the night's hours); then once on the server, with your go-ahead.

#### M-12: The status page
- D7: the probe account, the timer, the renderer, the route, the incidents' file.
- **Tests:** against a stand-in backend, each state rendered; the smoke test checks the page.

### Phase 5: one request's trail

#### M-13: Tracing
- **Parts:** 1, the backend: the ID at each entry, `trace_id`, the header given back, the queue's join, `GET /traces/:id`; L1, L2, L4, both of L5's loops. 2, the runtimes: `_X_AMZN_TRACE_ID` for each call, the log lines. 3, `ff trace`, `ff logs --trace`, `ff history`'s column, the console's link, the templates' two lines, the guide.

### Phase 6: close

#### M-14: Documentation
- The guide's pages: installing `ff`, `ff login`, `ff local`, the templates, `ff mcp`, the status page, the trail; the French pages; `cli/README.md`; the CLI plan's C-40 to C-43 marked done; ADR 0018 as built.

#### M-15: The step closed
- The updater live on the development server, and the status page up, with your go-ahead; the Public Suffix List's request sent, with your go-ahead, once the domain is registered.
- What to build next, the decision log, and the step-6 plan trimmed to what stays (D11).

## 8. Risks

| Risk | What lowers it |
|---|---|
| `ff local` answers differently from FF, and a developer learns it at the deploy | The shared fixtures for every operation it serves, the AWS CLI's cases of L4 run against it, the small app on it end to end; the guide's table of what it leaves out; ADR 0017 |
| The macOS builds can't be cross-compiled from Linux (`ring`'s C code, the verifier's frameworks) | M-01's spike first; a macOS runner job at each release otherwise, ten minutes a minute on a private repository, at a release's rate |
| Windows: paths, line endings, the console's colors, the files' modes, Docker Desktop | `cargo test` on a Windows runner at each release; the four Unix-only places given counterparts; `ff local` on Windows needs Docker Desktop with Linux containers, said in the guide |
| The signing key leaks | It signs releases alone, and nothing else is trusted by it; a new key means a new install by the script, whose page shows the key's fingerprint; GitHub's secret is the one copy besides yours |
| A customer's machine doesn't reach `*.localhost` names | Browsers resolve them themselves; the SDKs take `127.0.0.1` with path-style addressing; `ff local` prints every address it serves |
| A laptop's memory: a container for each function | Started at the first call, stopped after `--idle`; `ff local` says what runs |
| The MCP protocol changes under `ff mcp` | One version implemented and named; a client asking another is told which; the handshake is a page of the protocol, cheap to follow |
| An agent writes what the developer didn't want | Writes off by default; deletes, keys and secrets never; each write's answer says what changed |
| The stand-in Konnect differs from Konnect | Written from its documentation, each answer naming its source; checked against the sandbox once step 6 has its credentials, the differences fixed in the stand-in |
| The probe account's key on the server | It reaches the probe's resources alone, as a key of one function's level does; the probe runs as a user of its own |
| The updater installs a commit that breaks the server, which has a customer | Only commits whose every job passed; at night; a backup first; the smoke test after; a failure stops it and is e-mailed |
| The server holds a deploy key and a token | A read-only key; a token that reads the workflow's results alone, or none while the repository is public; both 0600, root's |
| Trace IDs that nobody passes on make trails of one call | The runtimes set `_X_AMZN_TRACE_ID` as Lambda does; the templates pass it on in two lines; the guide says how; a trail of one call is still that call's |
| Release minutes on a private repository | Everything built on Linux; the Windows and macOS runners run `cargo test` at each release alone |

## 9. Choices for you to confirm

Each with what it means and a recommendation. **Confirmed on 2026-11-08, all fourteen as recommended:** the decision log's 70 to 83, in this order.

1. **The scope, and its place.** Options:
   - this plan now, as the developer-tools plan beside the steps (as the code-search plan is named), before step 6's company-bound parts, taking step 6's four tasks that wait for no company;
   - step 6 as proposed, this plan after it;
   - this plan as step 6 and the paying customers as step 7, every document renumbered.

   **Recommended: this plan now, beside the steps.** It waits for nothing but your answers, where step 6's top-ups and invoices wait for the company; and step 6's plan, its number and the decision log's references stay as they are.
2. **`ff login` first** (the CLI plan's question 7; the step-6 plan's 6). Options:
   - first in the plan, as the CLI plan's question 7 recommends;
   - after the local front door.

   **Recommended: first.** It is small, waits for nothing, and the first customers never paste a key.
3. **Where downloads and images live** (the CLI plan's question 3; the step-6 plan's 7). Options:
   - on FF itself: a site on a bucket of FF's own, at `get.<domain>`, with GitHub's releases and `ghcr.io` as copies;
   - GitHub alone;
   - a registry of FF's own for the images, as the code registry is.

   **Recommended: on FF itself.** It needs no new service, works when GitHub isn't reachable, and FF serves itself as it serves its customers.
4. **Windows and macOS** (the CLI plan's question 5; the step-6 plan's 8). Options:
   - both now, cross-compiled on Linux where the spike allows and on a macOS runner otherwise, signed with minisign, Apple's notarization later;
   - Windows when a customer asks;
   - Apple's notarization now.

   **Recommended: both now, notarization later.** Many developers here work on Windows, and `ff` has Unix-only code to settle once. Apple's program is paid by card, every year.
5. **`ff local`'s shape.** Options:
   - inside `ff`, in Rust: one binary, one process, the services as a subset the fixtures prove;
   - the backend's front-door modules in a small container, with `ff` running the functions;
   - the whole backend in Docker Compose, with a Docker executor in place of Kubernetes.

   **Recommended: inside `ff`,** as D3 says, after M-01's spike measures it against the second. The third is the on-premises edition's work, a plan of its own.
6. **What `ff local` runs in this step.** Options:
   - all of D3: functions, URLs, schedules, Lambda's invoke, queues, buckets with notifications and sites, mail captured, a PostgreSQL and a Valkey on request;
   - functions, URLs, schedules, queues and buckets alone, the databases and mail later.

   **Recommended: all of D3.** The small app needs every one of them to run end to end, which is the proof.
7. **The templates.** Options:
   - the six of D4;
   - the first four (`rest-api`, `cron-job`, `webhook`, `queue-worker`);
   - none now.

   **Recommended: the six.** Each is small, each doubles as a fixture and a test, and `image-resize` is the test of native packages on three systems.
8. **`ff mcp`.** Options:
   - a subcommand on stdio, reads by default, writes with `--allow-write`, never a delete, a key or a secret;
   - reads only;
   - not now.

   **Recommended: the first.** An agent that can deploy and read logs is what developers ask for, and the lines that keep deletes and secrets out are few.
9. **The Konnect stand-in.** Options:
   - in `ff`, as `ff local konnect`, for customers' shops and FF's own suites;
   - in `hack/`, for FF's suites alone;
   - not now.

   **Recommended: in `ff`.** One stand-in, two users; and the `webhook` template has its tests offline, where Konnect's sandbox needs a merchant's onboarding.
10. **The status page.** Options:
    - probes outside the backend, a static page on the development server's own proxy, incidents by hand;
    - a hosted status service;
    - later.

    **Recommended: the first.** A hosted service is paid by card abroad; the static page is a day's work and costs nothing to run.
11. **Tracing in this step.** Options:
    - the trail as D8 says, last in the plan;
    - after this plan.

    **Recommended: in this step, last.** The IDs exist, the queue carries `AWSTraceHeader` already, and the first customers' first question when a receipt doesn't arrive is "where did it stop".
12. **How the development server updates** (decision 39; the step-6 plan's 13). Options:
    - by itself, pulling each commit of `master` whose every job passed, at night, with a backup first and the smoke test after, a failure stopping it (D9);
    - by GitHub, through a key to the server;
    - by hand, as now.

    **Recommended: by itself.** GitHub then holds no key to a server that other projects share.
13. **The content domain** (decision 42; the step-6 plan's 10). Options:
    - registered now and requested from the Public Suffix List now, switched in step 6;
    - switched in this plan too;
    - both under `ffunc.cloud`, as now.

    **Recommended: registered and requested now, switched in step 6.** The weeks the list takes pass while this plan is built; the switch belongs with production's certificates.
14. **The development server's certificates** (the step-6 plan's 12). Options:
    - the proxy's own authority, as now;
    - Let's Encrypt by DNS-01, through an OVH key kept on the server that other projects share;
    - one certificate per host on demand, through a line in the shared proxy's main file.

    **Recommended: as now.** It is a development server; the key and the shared file stay untouched.

**Your actions, which no task can do:**

| Action | What it unblocks | When |
|---|---|---|
| The signing key, made with `minisign -G` on your machine, its secret half in GitHub's secrets, its public half committed | M-03's release job | Before M-03's part 2 |
| A read-only deploy key and a token that reads the workflow's results, made by you, put on the server by `install.sh` | M-11 | Before M-11's run on the server |
| The content domain chosen and registered at OVH | The Public Suffix List's request (M-15); step 6's G-09 | As soon as you choose it: the list takes weeks |
| `ghcr.io`'s packages made public for FF's images | M-04's copies | Before M-04 |
| Your go-ahead for each run on the development server: the updater's first, the status page's route | M-11, M-12, M-15 | When each is ready |

## 10. Effort (rough estimates, one developer)

| Part | Weeks |
|---|---|
| M-00 and M-01: the plan, the spikes, two ADRs | 1 to 1.5 |
| `ff` for customers (M-02 to M-04) | 1.5 to 2 |
| The whole app on a laptop (M-05 to M-07) | 3.5 to 5 |
| Templates, `ff mcp`, the Konnect stand-in (M-08 to M-10) | 1.5 to 2.5 |
| The server and the public (M-11, M-12) | 1 to 1.5 |
| Tracing (M-13) | 1 to 1.5 |
| Documentation and the close (M-14, M-15) | 1 to 1.5 |
| **Together** | **10.5 to 15.5** |

That is about 53 to 78 working days. The CLI plan counts 4 to 6 days for C-40 to C-43; the step-6 plan 1.5 to 2 weeks for the same with the console's pieces, and 1.5 to 2 for the names and the updater. The rest, the local front door above all, no parent plan counted. The external lead times aren't in it: the Public Suffix List, and GitHub's secrets and keys, which are yours.

## 11. Progress log

| Task | Status | Commits | Notes |
|---|---|---|---|
| M-00 The plan and the baseline | 🔄 Under way: your choices confirmed on 2026-11-08 (§9); the advisories fixed; minisign pinned; the baseline from the branch's run | The choices: `519ea50`<br>The advisories: `996c76c`<br>The tools: this commit | • **Your choices,** all fourteen as recommended, are the decision log's 70 to 83; the step-6 plan's status says which of its tasks and choices this plan took; the CLI plan's questions 3, 5 and 7 answered. The code-search plan, which named its ADR 0017 too, now names its ADR when it is confirmed.<br>• **The branch,** `feat/dev-tools`, made from `feat/step-5` at `babaca6`: `master`'s `05f459e` with step 5's last two commits, the plan's log of the merge and the install, which `master` didn't have.<br>• **The advisories,** which had turned `master`'s nightly red from 2026-11-05: exceptions that ended on 2026-11-05 and 2026-11-08 (body-parser, multer, follow-redirects) and new advisories in the images (musl, zlib, apt, Go's x/net). Each fixed by a release at least two weeks old where one exists: the three packages, Alpine 3.24.3 under four images, musl 1.2.6-r3 in two; the Debian images' fixes come with their base tags, rebuilt from 2026-11-05; the rest accepted until its fix is two weeks old, x/net in Caddy until 2026-11-10, Alpine's zlib in the backend's and the cache's images until 2026-11-20. The decision log's 35 says what is left.<br>• **The tools,** pinned: minisign 0.12 (2025-01-15), `hack/install-tools.sh minisign`. Its release publishes no checksum file, only each file's signature by its author's key, which its README gives: the three files' signatures were checked here with openssl (Ed25519 over the file's BLAKE2b-512, minisign's format), their SHA-256s copied into the script for Linux and macOS, as the SAM CLI's are. Installed, left alone at its second run, refused with a wrong checksum and with a version it holds none for, nothing installed; the binary then verified its own release's Windows file and refused a changed one. zig and cargo-zigbuild go with M-03's builds, if M-01's spike keeps them. |
| M-01 Spikes, and ADRs 0017 and 0018 | ⏳ Planned | | |
| M-02 `ff login`, `ff logout` and `ff api-keys` | ⏳ Planned | | |
| M-03 `ff`'s builds, signatures and downloads | ⏳ Planned | | |
| M-04 The runtime images published, and `ff` in a customer's CI | ⏳ Planned | | |
| M-05 The local front door: functions, URLs, schedules and Lambda's invoke | ⏳ Planned | | |
| M-06 Queues and buckets locally | ⏳ Planned | | |
| M-07 Databases, caches, mail, and the small app end to end | ⏳ Planned | | |
| M-08 Six templates | ⏳ Planned | | |
| M-09 `ff mcp` | ⏳ Planned | | |
| M-10 `ff local konnect`, and the `webhook` template's tests | ⏳ Planned | | |
| M-11 The development server updating itself | ⏳ Planned | | |
| M-12 The status page | ⏳ Planned | | |
| M-13 Tracing | ⏳ Planned | | |
| M-14 Documentation | ⏳ Planned | | |
| M-15 The step closed | ⏳ Planned | | |
