# FF: a serverless functions platform

FF deploys and runs Node.js (TypeScript or JavaScript) and Python functions with AWS Lambda's handler contract, on Kubernetes. It targets markets where international payments and the big clouds are hard to use, such as Tunisia. Customers there get a local platform, and their functions stay portable to AWS Lambda when they move. See the [local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md).

## What works today

- **Functions API** (NestJS, PostgreSQL, S3-compatible storage). You can:
  - create, update, delete, and invoke functions;
  - give a function environment variables, as on AWS Lambda, and secrets, variables whose values nobody reads back: 4 KB at most together, encrypted at rest, delivered to its pods through a Kubernetes Secret that the backend writes and never reads;
  - give a function a URL, a web address as AWS Lambda's function URLs have: any request to it calls the function with Lambda's event for them, and the function's answer is the response; open to anyone or only to the account's API keys, with CORS, counted and billed as an invoke, and at the customer's own domains once DNS proves them theirs. The backend answers URLs on a port of its own, `http://<id>.fn.localhost:3001/` in development, and in a cluster the edge serves them over HTTPS, with a wildcard certificate it gets through FF's DNS (RFC 2136) or one per host on demand;
  - run a function on a schedule, with EventBridge's expressions (`rate(5 minutes)`, `cron(0 2 * * ? *)`) and its Scheduled Event, each run at most once and counted, billed and kept as an invoke;
  - see the invocation history with durations, kept for the plan's retention with up to 64 KiB of each input, output and error;
  - read a function's or the account's metrics, named as CloudWatch names Lambda's (invocations, errors, throttles, cold starts, the duration's percentiles, instances), a point a minute, five minutes or an hour, from the usage records the bill is made of;
  - be notified by e-mail, each owner in their language, and by webhooks signed with the account's secret and tried again when they fail: a test, from the API or the console's Notifications page;
  - set alarms, as CloudWatch's, on a function's or the account's metrics and on its money, "M out of N" periods, evaluated every minute and telling their e-mail and webhooks when they go into ALARM and out of it, from the API or the console's Alarms page.

  Functions scale out when calls arrive together (one instance per call in flight, up to `maxInstances`), scale to zero when idle, and start again on the next invocation.
- **Kubernetes orchestration** ([ADR 0001](docs/adr/0001-orchestrator-kubernetes.md)):
  - each tenant gets its own namespace with a quota, container limits, and a default-deny network policy: its functions reach the internet only once you turn the account's egress on, and never FF's own network;
  - the backend uses a least-privilege ServiceAccount, confined to tenant namespaces by an admission policy;
  - every function's code runs as an image in the cluster's registry, which its pods mount read-only at `/var/task` ([ADR 0003](docs/adr/0003-code-delivery.md)): a package's, a zip with its libraries as AWS Lambda takes one (50 MB, 250 MB unpacked), checked entry by entry when it is uploaded; and inline code's, one file of up to 3 MiB, as AWS Lambda's console takes, which the backend makes a one-file package of. An invocation's input may have 6 MB as JSON, as on AWS Lambda.
- **Runtimes** `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`, runtime protocol 3 ([Node.js](runtimes/nodejs/README.md), [Python](runtimes/python/README.md)):
  - Lambda's `handler(event, context)`, error names, and log lines, with the code's directory as the working directory and the peak memory as `Max Memory Used`;
  - real timeouts;
  - out-of-memory and crashes are handled per invocation, without restarting the container; a replacement that can't load the code again restarts it;
  - non-root, read-only images that install nothing at start; the Node.js image keeps a code cache of the TypeScript compiler, so that a 128 MB function loads in gVisor in 2 to 5 s of its 10 s limit.
- **gVisor sandbox** for customers' code: `K8S_RUNTIME_CLASS=gvisor`, optional in development and required in production. See the [dev guide](docs/kubernetes-dev-guide.md#sandboxing-with-gvisor); `hack/k8s/cold-start-benchmark.sh` times cold starts in it.
- **Logs** ([ADR 0005](docs/adr/0005-log-pipeline.md)): Fluent Bit on every node collects the functions' output into VictoriaLogs, which keeps it 31 days. Each line has its account, function, pod, stream and call's request ID; each account keeps 2,000 lines and 1 MiB a second, and a line says how many were dropped. Only the collector and the backend reach the store. `GET /functions/:id/logs` reads it: a page of a window within the plan's retention, a phrase, one call's lines, and a cursor to older ones; `GET /functions/:id/logs/stream` follows the new lines live, as Server-Sent Events. The development cluster has it too (`hack/k8s/cluster-up.sh`).
- **Accounts and login:** users sign up and log in through Keycloak (`docker compose --profile auth` starts the development realm), in the console or with tokens. They create accounts that wait for your approval, and act for one account per request. Owners invite members by e-mail, as owners, developers or viewers, make API keys for scripts and CI, limited to scopes, and read the account's audit log of who changed what. Their e-mails come in French, or in English for whoever chooses it. Another account's functions answer 404 on every route (`hack/e2e-tenancy.sh`). Closing an account deletes its functions, their invocation history and logs once a notice period has passed (30 days by default), keeping its usage, payments and invoices, which the law requires. Development acts as one account (`FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID`, or another one named by `X-FF-Dev-Account`), which production refuses.
- **Plans:** each account's plan sets its limits: how many functions, each one's memory, timeout and instances, its namespace's quota, and its rates of changes and invocations, which answer 429 with `Retry-After` beyond them. One plan, `beta`, to start; operators change plans and make new ones in the admin dashboard.
- **Usage records:** every invocation leaves one record when it ends, written with its final state: what it ran on, how long, what is billed (by Lambda's rules: errors and timeouts count, throttles and platform failures don't), and its cold start, which isn't billed. The invocation's ID is the call's request ID in the runtime and its log. Records are never changed or deleted, and outlive their function. Calls lost when the backend stops are marked `LOST` and not billed. `GET /usage?month=YYYY-MM` adds a month up per function, as JSON or CSV, with its estimated cost at FF's prices: AWS Lambda's, in TND, with the same free tier, from versioned price books that never change once they start. The console's "Usage" page shows this month and last month. Every minute, the backend also records each function's ready instances: `npm run capacity:report` (in `BE/`) weighs the capacity they held against what was billed, per account and day.
- **Money:** a double-entry ledger in PostgreSQL, in millimes as `bigint`, never a float. Every movement is a transaction whose entries sum to zero, which the database checks when it commits, with an idempotency key that makes a retry a no-op; nothing in it is ever changed or deleted. Each account's wallet holds its credit, and the admin dashboard's account page shows its balance. Every hour, once the hour has settled, its usage is rated with the price books and each account charged: the month so far, rounded once, less the earlier hours. For the first two weeks (shadow mode) the charges are only shown; then each is debited, one ledger transaction per account and hour. `npm run billing:reconcile` (in `BE/`) checks the charges against the raw usage. Before each invoke the balance is checked: calls go on down to a small negative buffer, then for a grace period, then answer 402 until credit comes; the owners get low-balance e-mails at shares of the last credit they choose. Credit comes by bank transfer: an owner asks for a pro-forma on the console's Billing page (the credit, 19% VAT on top, FF's bank account, and a reference for the transfer's label), and an operator records the transfer from the bank statement; a share the buyer withheld at source is credited with the withholding certificate. Each month an account bought credit in gets an invoice in French, issued by an operator early the next month, its stamp duty taken from the credit and the month's usage statement attached; corrections are credit notes, and invoice numbers have no gaps. The console shows the balance on every page, a banner when invokes are about to stop, and a Billing page with the pro-formas, each printable in French, the invoices and the usage statements.
- **Operator monitoring:** the backend logs one JSON object a line in production, each naming the request it was written for; `GET /readyz` says whether it can serve (its database and the cluster answer), for a load balancer; and its metrics, in Prometheus's text format on a port of their own (9464), never the API's: invocations by outcome, refusals, durations and cold starts, notification attempts, alarm evaluations, answers by status class, the rating's and the alarm evaluator's lag, the deliveries pending, the accounts whose month doesn't reconcile and the database's size. On the cluster ([ADR 0006](docs/adr/0006-operator-monitoring.md), opt-in in development): VictoriaMetrics scrapes them with the cluster's (kube-state-metrics, the kubelets, the log pipeline), alert rules in git, unit-tested, e-mail the operator through Alertmanager, and Grafana shows two dashboards in git.
- **Deployment:** images for the backend, the console, the admin app and the edge, each non-root on a read-only root; `deploy/k8s/platform` deploys them with Keycloak and a Caddy edge proxy (Let's Encrypt, an admin allowlist), migrations first, every workload behind its own NetworkPolicy, PostgreSQL and S3 outside the cluster. `hack/e2e-platform.sh` deploys it on a cluster of its own and takes a customer's path through the edge.
- **Backups** ([deploy/backup](deploy/backup/README.md)): point-in-time recovery of FF's and Keycloak's databases to a second site, encrypted, with at most 5 minutes of WAL at risk; the invoices and withholding certificates mirrored hourly; a restore runbook, and a monthly drill (`hack/backup-drill.sh`) recorded in `docs/backup-drills.md`.
- **Admin dashboard:** a separate web app in `admin/`, for you as FF's operator: Keycloak's client `ff-admin`, the realm role `ff-operator` and a one-time password. It opens on the accounts waiting for your approval; every account has a page with its members, functions, usage, balance and history, where you approve, reject, suspend, reactivate or close it, and change its plan or internet egress, and its owners get an e-mail. Its Payments page finds a pro-forma by the reference on the bank statement, records the transfer, and takes the withholding certificate; its Invoices page issues a month's invoices and their credit notes; its Prices page makes new price books, tried first on last month; its Plans page edits plans' limits, which apply at once. Every change takes a reason, which the audit log keeps; the operator audit log lists every operator's actions, filtered by operator, account, action and date, and exports them as CSV. The platform's settings are there too.
- **The `ff` command** ([`cli/`](cli/README.md), Rust, one static binary that talks to the API only): `ff deploy` a file, or a folder as a package with its libraries, creating the function or updating what changed, and `ff package`, the same zip for AWS Lambda too; `ff invoke`, `ff logs` with the live tail, `ff list`, `get`, `history`, `scale` and `delete`, by the function's name; `ff local invoke` and `ff local start`, a function run on this machine in Docker as its pod runs it; `ff init`, a new function's folder; `ff config` and `ff whoami`, with an API key or, in development, the account to act as. Its exit codes tell a failed deploy (4) and a failed call (5) from the account's refusal (6). `hack/build-cli.sh` makes the static Linux binary, `hack/cli-e2e.sh` tests it against the stack. The [CLI plan](docs/cli-plan.md) builds it, task by task.
- **Console:** a React + Vite web app in `FE/`: login and sign-up, the new account's onboarding and approval, account settings, members, API keys, the function pages, which show each role only what it may do, with each function's variables and secrets, its URL and its domains, its schedules, its logs, searched or followed live, its metrics and its alarms; the account's alarms, notifications and usage; and billing: the balance on every page, credit by bank transfer against a pro-forma, the invoices and the usage statements.

**Not implemented yet**, despite what older documents say:
- Paying: usage is rated and charged hourly (debited once you turn shadow mode off), credit comes by bank transfer and from FF's grants, and each month's credit is invoiced as a PDF, but there are no refunds yet, no card payments, and no El Fatoora e-invoicing (skipped for now). See phase 3 of the client-readiness plan.
- Function versions and aliases.

Nomad is no longer used; its development VM was removed.

## Repository layout

| Path | Contents |
|---|---|
| `BE/` | Backend: functions API, metrics, scaling, and the orchestrator (`src/orchestrator/kubernetes`) |
| `FE/` | Console (React, Vite, Tailwind) |
| `admin/` | Admin dashboard for FF's operators (React, Vite, Tailwind): a separate app, behind its own login (P-70) |
| `runtimes/` | Function runtime images, `nodejs/` and `python/`, runtime protocol 3 |
| `cli/` | The `ff` command (Rust): one binary that works through the API only, being built as the [CLI plan](docs/cli-plan.md) says |
| `deploy/k8s/` | Cluster manifests: `base/` (namespace, RBAC, admission policy), `dev/` (base plus the Service proxy a backend outside the cluster needs), `logging/` (the log pipeline), `monitoring/` (the operator's metrics, alerts and dashboards), `platform/` (the backend, the apps, Keycloak and the edge proxy, with their deploy script), `backup/` (the legal records' mirror) and `optional/` (gVisor) |
| `hack/` | Development scripts: tools, dev cluster, image import, tests, resource guard |
| `infrastructure/` | SeaweedFS (S3) identities for `docker-compose.yml` |
| `docs/` | The [getting-started guide](docs/getting-started.md), plans, ADRs, and the [Kubernetes dev guide](docs/kubernetes-dev-guide.md) |
| `examples/` | Example functions (Node.js and Python) used by the getting-started guide |

## Quick start (development)

For a step-by-step setup and the everyday commands (create, invoke, update, logs, cold starts, tests, reset), follow **[Getting started](docs/getting-started.md)**. The short version:

You need Docker 24+, Node.js 24.15 or newer, Python 3.11+ (for the Python runtime tests), `curl`, and `jq`. Plan for at least 3.5 GB of free memory and 6 GB free on Docker's disk; the [dev guide](docs/kubernetes-dev-guide.md) has the details. The scripts check resources before every heavy step (`hack/check-resources.sh`).

```bash
docker compose up -d --wait                 # PostgreSQL (127.0.0.1:5432) + SeaweedFS S3 (127.0.0.1:9003)
hack/k8s/cluster-up.sh                      # k3d cluster (k3s v1.37.1), RBAC, admission policy, credentials
runtimes/nodejs/test/container-smoke.sh     # builds ff-runtime-nodejs:24-v3 and checks it
runtimes/python/tests/container-smoke.sh    # builds ff-runtime-python:3.13-v3 and checks it
hack/k8s/load-images.sh                     # imports the runtime images into the cluster
cp BE/.env.example BE/.env                  # first time only; the defaults match the steps above
cd BE && npm install && npm run migration:run   # the database schema comes from migrations
npm run start:dev                           # API on http://localhost:3000, Swagger UI on /api
```

Create a function and invoke it:

```bash
curl -s localhost:3000/functions -H 'content-type: application/json' -d @- <<'EOF'
{"name": "hello", "runtime": "nodejs", "memory": 128, "timeout": 5,
 "code": "export async function handler(event) { return { message: `Hello ${event.name ?? 'world'}` }; }"}
EOF
curl -s -X POST localhost:3000/functions/<id>/invoke -H 'content-type: application/json' -d '{"input": {"name": "FF"}}'
# → {"status": "COMPLETED", "output": {"message": "Hello FF"}, "duration": 0.48, …}
```

For Python, use `"runtime": "python"` and code such as `"def handler(event, context):\n    return {\"message\": \"Hello \" + event[\"body\"].get(\"name\", \"world\")}\n"`. Creating a function returns once it is running (`"status": "ACTIVE"`). When its code fails to load, the answer comes within about 10 s with the runtime's reason, and `functionId` names the function, saved as `ERROR`, to fix with `PUT /functions/<id>`. A name follows AWS Lambda's rule, 1 to 64 letters, digits, hyphens or underscores, and belongs to one function of the account: another create or rename with it answers 409. On the beta plan, the memory range is 128–1024 MB and the timeout 1–300 s: each account's plan sets its limits and rates ("Plans and limits" in [Getting started](docs/getting-started.md)).

To start the console: `cd FE && npm install && npm run dev`. It runs on http://localhost:5199 and calls the API on localhost:3000, which allows that origin (`CORS_ORIGIN`). Without a login, it acts as the backend's development account. With `VITE_OIDC_AUTHORITY` set (`FE/.env.example`), users log in through Keycloak, sign up, create their account, and manage API keys: see "Log in with Keycloak" in [Getting started](docs/getting-started.md).

## Tests

| Level | Command | What it covers |
|---|---|---|
| L0 backend | `cd BE && npx tsc --noEmit && npm run lint` | Types, and ESLint with type information: promises nobody awaits, unchecked `any` values |
| L1 backend | `cd BE && npm test` | Unit tests: orchestrator against a fake API server, manifests, scaling, services |
| L1 runtimes | `cd runtimes/nodejs && npm test`; `cd runtimes/python && python3 -m unittest discover -s tests` | The runtime protocol on real processes |
| L1 log filter | `hack/k8s/test-logging-filter.sh` | The log collector's configuration and Lua filter (each line's call, the limit, the notices, the cut), in the Fluent Bit image (Docker) |
| L1 console | `cd FE && npm test` | What the console sends and shows: the fields of an edit, invoke input, API error messages, units; the token and account on each request, token renewal, the account it acts for, API keys; and that its port, client and scopes match the realm and the API (Vitest) |
| L1, L2 `ff` | `cd cli && cargo test --locked` | The `ff` command: its settings and their precedence, its API client and error mapping, its exit codes, the container `ff local` starts; then the built binary against a scripted API that answers in order and records what it was sent |
| L2 database | `cd BE && npm run test:db`; `npm run migration:check` | The migrations against real PostgreSQL, each case in its own scratch database; no drift between the migrations and the entities |
| L2 images | `runtimes/*/test*/container-smoke.sh` | Images run hardened: read-only, uid 10001, no capabilities, no package manager |
| L3 | `hack/k8s/test-it.sh` | The Kubernetes driver against the dev cluster (deploy, rollout, scale to zero, network policy, memory, gVisor), the function lifecycle (repair, rollback, updates at zero, a runtime that never answers), and, where it is installed, the log pipeline (what functions print reaches the store, limited, and only the backend may query it) |
| RBAC | `hack/k8s/test-rbac.sh` | What the backend's ServiceAccount may and may not do |
| L4 | `hack/e2e.sh` | The whole stack through the REST API, with both runtimes, and the code archive in object storage; an alarm that fires on a function's error and recovers, telling a local webhook receiver |
| Pipeline | `hack/ci.sh static unit db security cluster` | All of the above in stages, as the CI server runs them (`.github/workflows/ci.yml`): plus the builds, the docs, gitleaks on every commit, `npm audit`, and every image scanned by Trivy with its SBOM ([getting started](docs/getting-started.md), "The pipeline") |
| L5 | `hack/e2e-tenancy.sh` | Every route of the OpenAPI document, as another account (404, nothing changes) and anonymously (401); sign-up through Keycloak and Mailpit; isolation between two real accounts; a function's metrics against its usage records; a test notification to a local receiver, signed, and to the owner's e-mail; each account's alarms its own; closing an account, and its data deleted once its notice period has passed |
| L3 `ff` | `hack/cli-e2e.sh` | The built `ff` against the stack, in development mode with a profile per account: deploy, invoke, logs and the live tail, update, scale, history, delete for both runtimes; the exit codes of a failed load, an error and a timeout; another account's view; `ff init`; `ff local` in Docker, with a failed load, a timeout, a call over its memory, and Ctrl-C |

## Documentation

- [Getting started](docs/getting-started.md): local setup from a fresh clone, and how to use FF day to day.
- [How FF works](docs/how-it-works.html): every feature from request to result, as step-by-step simulations with the messages and records at each hop (open it in a browser).
- [Kubernetes dev guide](docs/kubernetes-dev-guide.md): cluster, images, tests, gVisor, troubleshooting.
- [Client-readiness plan](docs/client-readiness-plan.md): the work that takes FF to its first paying customers, task by task, with its progress log.
- [Kubernetes migration plan](docs/kubernetes-migration-plan.md): the design and the task log K-00 to K-13.
- [Local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md): the product and portability roadmap.
- [CLI plan](docs/cli-plan.md): the `ff` command-line tool, in six phases; phases 0 to 2 done with step 1.
- [What to build next](docs/what-to-build-next.md): what FF adds after functions, in five steps, and the longer view.
- [Step 1 plan](docs/step-1-plan.md): environment variables and secrets, AWS's events, function URLs, schedules, packages and the CLI, task by task, with its progress log; done in development.
- [Step 2 plan](docs/step-2-plan.md): a database and file storage, managed PostgreSQL and buckets behind an S3 front door; proposed, for you to confirm.
- [deploy/k8s](deploy/k8s/README.md): what the backend is allowed to do in a cluster, and why; how to deploy the platform.
- [deploy/backup](deploy/backup/README.md): the backups, the restore runbook and the monthly drill.
- [The documentation's index](docs/README.md), with the architecture decisions (ADRs).

## License

MIT
