# FF client-readiness plan: accounts, usage billing, and customer logs

| | |
|---|---|
| **Status** | In progress since 2026-10-17, on the branch `feat/client-ready`. What is done is in the progress log (§11). Your decisions of 2026-10-16, the points the accountant must confirm, and the actions waiting for you are in §9. |
| **Goal** | The parent plan's paid private beta: "a pilot customer can sign up, top up in TND, run functions, and receive a compliant invoice", plus logs and alarms the customer can read without cluster access |
| **Parent plan** | [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): findings C-1 to C-3, C-7, H-4, H-5, M-1; tasks F-01, F-04, F-05, F-09 to F-11, R-08, R-09, B-01 to B-07, B-10, B-11; ADR-006 and ADR-008; §4.8, §4.9, §8, §9.2, §11 |
| **Builds on** | The [Kubernetes migration](kubernetes-migration-plan.md) (K-00 to K-12) and the [CLI plan](cli-plan.md) (C-05 logs endpoint, C-40 login) |
| **Decision records** | ADR 0004 (identity and tenancy) in P-00, ADR 0005 (log pipeline) in P-41. ADR 0002 and 0003 are reserved by the CLI plan. |

The function engine works: functions deploy to Kubernetes, scale to zero, run in hardened pods, and report their duration and memory. The business layer around it doesn't exist yet. There are no accounts, nothing stops one caller from using another's functions, the usage data can't be billed from, and logs live only in pods that disappear. This plan builds that layer, in the order the risks demand: first the engine's defects (§1.6) and isolation between customers, then metering and prepaid credit, then logs, metrics and alarms, then the launch work.

| Phase | You get | Needs |
|---|---|---|
| **0. Groundwork** | Migrations that work in production, a validated configuration that refuses the development tenant in production, ADR 0004, the defects of §1.6 fixed (function updates and failures, the runtimes, the console, scaling, and cluster permissions), and the dependencies' known vulnerabilities (§1.7) | nothing |
| **1. Accounts and isolation** | Sign-up and login (console, CLI, API keys); every route limited to the caller's account; plans, quotas and rate limits | Keycloak; an SMTP server |
| **2. Metering** | One usage record per invocation, which deleting or editing a function can't change; usage per month in the API and console; idle capacity measured | phase 1 |
| **3. Prepaid credit** | AWS Lambda's prices in dinars as a configurable price book; wallet and ledger; top-ups through Konnect and bank transfer; a balance check before each invoke; low-balance e-mails; monthly invoices | phase 2; a Konnect merchant account; the accountant's confirmations (§9) |
| **4. Customer logs** | Durable function logs per account: time range, text search, request ID, live tail, retention per plan, in the API and the console | phase 1 (it can run in parallel with phases 2 and 3) |
| **5. Metrics and alarms** | CloudWatch-style metrics per function and account; alarms by e-mail and webhook; monitoring for you as the operator | phase 2 |
| **6. Pilot launch** | The platform deployed with TLS, backups, gVisor and CI; a security review; the legal and support pack | all of the above |
| **Admin dashboard** (alongside phases 1 to 5) | A separate web app for you: approvals, accounts, support lookup, prices and plans, payments, credit and invoices, an overview, and the operator audit log | each part ships with the phase it serves (§7) |

**Two milestones:**
- **A. Free pilot:** phases 0 and 1, P-20, P-40, phase 6, and the admin dashboard's foundation and approvals (P-70, P-71). Invited customers use FF free of charge, within their plan's limits, and their usage is already recorded.
- **B. Paid beta:** everything. It matches the parent plan's exit criteria for its Phase 2.

---

## 1. Where FF stands

Checked against the code on 2026-10-16 (commit `c87df16`).

### 1.1 Accounts and access

| Finding | Where | Consequence |
|---|---|---|
| **No accounts or users.** **Fixed in P-11 and P-12:** a global guard checks Keycloak's tokens, and accounts, users and memberships exist. The database has three tables: `functions`, `function_invocations` and `function_metrics`. No guard is registered anywhere. The console routes only the function pages. | `BE/src/app.module.ts`, `FE/src/App.tsx` | Nobody can sign up or log in. |
| **The tenant is whatever `@User()` returns:** `request.user.sub`, which nothing sets, else `FF_DEV_USER_ID` (`1` in `BE/.env.example`). **Partly fixed in P-02:** the development tenant is now `FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID`, which production refuses. **Fixed in P-10:** `@Principal()` replaces `@User()`; without a principal, every route answers 401. | `BE/src/auth/decorators/user.decorator.ts:22` | If the variable is set in production, every anonymous caller is that tenant. If it isn't, every request gets 401. |
| **Ownership is checked only on update and delete,** and a mismatch answers 401 instead of 404. **Fixed in P-10:** every query includes the account, and the L5 suite checks every route. Get (which returns the code), invoke, invocation history (inputs and outputs) and scaling configuration check nothing. The metrics route doesn't even ask for a tenant. | `BE/src/functions/functions.controller.ts:49,63,74,82,93,106`, `BE/src/metrics/metrics.controller.ts` | As soon as there are two tenants, anyone who knows a function ID can read its code and its callers' data, and run it on the owner's bill (parent C-3). |
| `?limit=` on the invocation history has no maximum. **Fixed in P-10** (1 to 100). | `functions.controller.ts:95` | One request can dump a function's whole history. |
| No rate limits. The tenant quota (20 pods, 8 CPU, 8 GiB) is the same for every tenant. **Fixed in P-15:** each account's plan sets its quota, its function limits and its rates of changes and invocations. | `BE/src/config/configuration.ts:52` | No plans. One tenant can use the cluster up to that quota. |

### 1.2 Usage data

The raw data is there. Each invocation stores its duration as the runtime measured it (on success) and its peak memory, and each function stores its tenant and memory size. So a Lambda-style bill (requests plus GB-seconds, per tenant and month) is one query:

```sql
SELECT f."userId", date_trunc('month', i."createdAt") AS month, count(*) AS requests,
       sum(ceil(i.duration) / 1000.0 * f.memory / 1024.0) AS gb_seconds
FROM function_invocations i JOIN functions f ON f.id = i."functionId"
GROUP BY 1, 2;
```

It isn't reliable enough to bill from:

| Finding | Where | Consequence |
|---|---|---|
| Deleting a function cascades to its invocations and metrics. **Fixed in P-20** for billing: its usage records have no foreign key, and outlive it. | `BE/src/functions/entities/function-invocation.entity.ts:30`, `BE/src/metrics/entities/function-metrics.entity.ts:20` | A customer can erase a month's usage before it is billed. |
| An invocation doesn't record the memory size it ran with. **Fixed in P-20:** its usage record does. | `function-invocation.entity.ts` | Changing a function's memory reprices its past calls. |
| The row is saved as `RUNNING` before the call and updated after. **Fixed in P-20:** the backend marks such a row `LOST`, unbilled. | `BE/src/functions/functions.service.ts:129` | If the backend crashes or restarts during a call, the row stays `RUNNING` forever. |
| On errors and timeouts the stored duration is the end-to-end time, including any cold start. Both runtimes return `X-FF-Duration-Ms` on errors too, but the orchestrator drops it. **Fixed in P-20.** | `functions.service.ts:162`, `BE/src/orchestrator/kubernetes/kubernetes.orchestrator.ts:237` | Failed calls are mismeasured. |
| A runtime's `429 TooManyRequestsException` (more than `FF_MAX_QUEUE`, 32, calls waiting) becomes a generic error. | `kubernetes.orchestrator.ts:239` | Throttled calls are recorded, reported and would be charged as function errors. |
| `synchronize` is on outside production, and the migrations don't match the entities (parent C-7). **Fixed in P-01.** | `configuration.ts:9`, `BE/src/migrations/*` | A production database breaks today, and every table this plan adds needs migrations that really run. |
| There are no plans, prices, balances, payments or invoices. | | |

### 1.3 What a call really costs

Pricing by run time alone loses money, because what a call costs you is not its run time:
- **A pod reserves its full memory and CPU** for as long as it exists. Requests equal limits (`BE/src/orchestrator/kubernetes/manifests.ts:236`).
- **A pod stays up 15 minutes after the last call** (`FF_SCALE_TO_ZERO_IDLE_SECONDS`, 900 s, `configuration.ts:28`; since P-15, the plan's `idleSeconds`).
- **The cold start isn't billed.** It takes about 10 s at 128 MB, and 12–15 s under gVisor (migration plan K-13). It isn't part of the runtime's duration.

A single 1 ms call at 128 MB therefore holds 0.125 GB × 900 s ≈ 112 GB-s of server memory, and bills 0.000125 GB-s: 900,000 times less. D8 adopts AWS's prices anyway, and keeps this gap measured and visible, so you can change the prices with real numbers.

### 1.4 Logs and monitoring

| Finding | Where | Consequence |
|---|---|---|
| The runtimes print Lambda-style `START`/`END`/`REPORT` lines, the function's own output, and JSON error lines to the pod's stdout. | `runtimes/*/README.md` | Only someone with cluster access can read them (`kubectl logs`). They disappear with the pod: after 15 idle minutes, on every update, and on delete. |
| The backend never sends `X-FF-Request-Id`, so the runtime invents its own ID. **Fixed in P-20:** it sends the invocation's ID. | `runtimes/nodejs/src/main.ts:305`, `kubernetes.orchestrator.ts:248` | A log line can't be matched to its invocation row. |
| No logs API, console view, search, or retention. | | |
| Metrics: one row per function per minute *that had traffic* (requests, errors, p50/p95/p99, average memory, ready instances), collected in memory between minutes. The function page draws four charts from it. | `BE/src/metrics/metrics.service.ts`, `FE/src/components/MetricsDashboard.tsx` | Close to CloudWatch's Invocations, Errors and Duration. Missing: throttles, cold starts, concurrency, rows for quiet minutes, alarms, and the ownership check. A backend restart loses the current minute. |
| No operator metrics, health endpoints, or dashboards (parent M-1, F-09). | `BE/src/main.ts` | You can't see the platform's health either. |

### 1.5 Not deployable yet

- **No image or manifest** for the backend, the console, or PostgreSQL. `deploy/k8s/base` holds only the cluster permissions.
- **The console** has its API URL hard-coded to `http://localhost:3000` (`FE/src/services/api.ts:4`), and reads a token from `localStorage` that nothing writes. **Fixed in P-14:** `VITE_API_URL`, and the token comes from the login.
- **No CI** (parent F-11).
- **gVisor is optional** (K-11). The parent plan says to run no untrusted third-party code until sandboxing is on.

### 1.6 Defects in the function engine

Found on 2026-10-16 while checking [How FF works](how-it-works.html) against the code (commit `8f934d5`). Customers would run into each of them, so phase 0 fixes them (P-03 to P-08) before the client-facing work starts. The other problems that review found already have tasks: ownership (P-10), the migrations (P-01), `X-FF-Request-Id` and the durations of failed calls (P-20).

| Finding | Where | Consequence |
|---|---|---|
| **An update never changes the status.** A successful rollout saves the record as it was, so a function in `ERROR` stays in `ERROR`. **Fixed in P-03.** | `BE/src/functions/functions.service.ts:99`, `:122` | A function that failed to load can't be repaired: even with fixed code, every invoke gets 400 "Function is not active". The only way out is to delete it and create it again, under a new ID. |
| **A failed update is half applied.** The new code goes to S3 and to the Deployment before the wait; when the wait fails, the record keeps the old code. **Fixed in P-03.** | `functions.service.ts:81-96` | The Deployment is left on the broken version. The old pod keeps serving only until it is replaced: after the next scale to zero, every cold start runs the broken code, while the record shows the old one. |
| **An update of a function scaled to zero checks nothing.** `isRolledOut` is true at zero replicas, so the wait returns at once. **Fixed in P-03.** | `BE/src/orchestrator/kubernetes/kubernetes.orchestrator.ts:54,114` | Broken code is accepted with 200, and fails at the next invocation after a 90 s wait. The interface promises a wait for "at least one instance" (`orchestrator.types.ts:42`); the code waits for every desired replica. |
| **A failed create leaves its pod running.** The function becomes `ERROR`, but its Deployment, its pod that can never become ready, and its S3 copy stay, and the idle sweep only scales `ACTIVE` functions. **Fixed in P-03.** | `functions.service.ts:55-59`, `BE/src/metrics/metrics.service.ts:144` | Each failed create holds its memory and CPU in the tenant's quota until the function is deleted. |
| **Node.js functions run in `/opt/ff`.** The Node.js runtime never changes directory; the Python runtime and Lambda run in `/var/task`. **Fixed in P-04.** | `runtimes/nodejs/src/main.ts`, `runtimes/python/ff_runtime/worker.py:210` | A Node.js function that reads a file next to its code works on Lambda but not on FF. |
| **"Max Memory Used" means two things:** in Node.js, the memory in use when the call ends; in Python, the peak, as on Lambda. **Fixed in P-04.** | `runtimes/nodejs/src/main.ts:99`, `runtimes/python/ff_runtime/main.py:67` | Node.js under-reports what a call needed, in `REPORT` lines and in the history. |
| **The runtimes log errors differently.** Node.js doesn't log a handler's exception, while Python writes a `function error` line with the stack trace. Python doesn't log an out-of-memory replacement, while Node.js does. **Fixed in P-04.** | `runtimes/nodejs/src/worker.ts:90`, `runtimes/python/ff_runtime/worker.py:150`, `main.py:201` | Customer logs (phase 4) would show nothing for a failed Node.js call. |
| **A worker that fails to reload leaves the pod unready for good.** `/readyz` stays 503 and `/healthz` stays 200, so kubelet never restarts the container. **Fixed in P-04.** | `runtimes/nodejs/src/main.ts:125-160`, `runtimes/python/ff_runtime/main.py:84-135` | After a timeout or a crash, a reload that fails (an init timeout at 0.1 CPU, for example) takes the instance out of service until its pod is deleted. |
| **A Node.js result that JSON can't hold** (a function, a `Symbol`) leaves the response body undefined, and the main process then measures it. This is read from the code; no test covers it. Python answers `Runtime.MarshalError`. **Fixed in P-04.** | `runtimes/nodejs/src/worker.ts:87`, `main.ts:184` | The main process can crash, failing the calls waiting behind it. |
| **Callback-style handlers fail.** The context sets `callbackWaitsForEmptyEventLoop`, but no callback is passed. **Fixed in P-04.** | `runtimes/nodejs/src/worker.ts:83` | A Lambda handler written as `(event, context, callback)` fails with `TypeError`. |
| **Four console calls are broken.** The invocation history expects an array (the API returns `{ invocations, total }`). The invoke result reads `response.data.metrics.*`, which doesn't exist. An edit sends the whole function, which the API rejects with 400. The scaling form calls `PUT /functions/:id/scaling-config`, which doesn't exist. **Fixed in P-05.** | `FE/src/components/FunctionDetail.tsx:33,68-72,88`, `FE/src/services/api.ts:81,102` | The history stays empty, an invoke shows no duration or memory, and editing or scaling a function fails. |
| **Autoscaling never adds a pod.** **Fixed in P-06 (D14).** `maxInstances` defaults to 1, and no API field changes it. The rule counts requests per minute (more than 2 per instance scales up), and its p95 includes cold starts. | `BE/src/functions/dto/`, `BE/src/metrics/scaling.ts:34-36`, `metrics.service.ts:133` | Each function runs on one pod, one call at a time. In a burst, calls wait in the pod's queue, and the backend gives up on those that wait longer than the function's timeout plus 2 s while the pod is still working through the queue. |
| **Unused columns.** **Fixed in P-06.** `functions.cpu` and `targetConcurrency` are never read, `function_invocations.cpuUsed` is always NULL, and `function_metrics.cpuUsage` is always 0. | the entities, `functions.service.ts:140-146` | Fields in the API and the console that mean nothing. |
| **The invoke mode changes how a timeout is recorded.** **Fixed in P-08.** When the backend gives up waiting, proxy mode (development) records `ERROR`, and direct mode (production) `TIMEOUT`. | `kubernetes.orchestrator.ts:209-218` | Development doesn't show what production records. |
| **The OpenAPI document says invoke answers 200.** **Fixed in P-08.** It answers 201, which `hack/e2e.sh` checks. | `BE/src/functions/functions.controller.ts:81` | Generated clients, and the L5 suite that reads the document, expect the wrong status. |
| **The controller's permissions reach further than the admission policy.** **Fixed in P-07,** except the reads, which the beta accepts (`deploy/k8s/README.md`). `services/proxy` is granted cluster-wide, although the role says it is for development only, and the policy doesn't check proxy calls. Every read (pods, pod logs, ConfigMaps) is cluster-wide. The policy hard-codes `ff-t-`, while `K8S_NAMESPACE_PREFIX` can be changed. | `deploy/k8s/base/20-clusterrole.yaml:28-31`, `30-clusterrolebinding.yaml`, `40-admission-policy.yaml:45`, `BE/src/config/configuration.ts:39` | A stolen backend token can call any Service in the cluster and read every ConfigMap and pod log. Another prefix makes every deploy fail. |

### 1.7 Dependencies

Found on 2026-10-17 while adding Zod for P-02. P-09 upgrades them.

| Finding | Where | Consequence |
|---|---|---|
| `npm audit --omit=dev` reports **26 known vulnerabilities** in the backend's production dependencies: 3 critical, 11 high, 11 moderate, 1 low. **P-09 brought them to one moderate finding,** accepted in P-09's notes. | `BE/package-lock.json` | Each is an exposure as soon as a customer can reach the API. The main ones follow. |
| **TypeORM 0.3.20:** SQL injection through crafted values passed to `save` or `update`, fixed in 0.3.26; a non-breaking update. **Fixed in P-09** (0.3.31). | `typeorm` | FF calls `save` with request data. |
| **Express 4 under NestJS 10:** `proxy-addr` (IP spoofing, critical), `path-to-regexp` (ReDoS), `body-parser` and `multer` (denial of service). The audit's fix is NestJS 12, two major versions up, with Express 5. **Fixed in P-09** with NestJS 11.2.7, which has the same fixed Express 5.2.1, `path-to-regexp` 8.4.2, `multer` 2.4.0, `body-parser` 2.3.0 and `qs` 6.16.0. | `@nestjs/platform-express`, `express` | Crafted requests can stall the backend, and spoofed client addresses would defeat P-15's limits by IP. |
| **minio 7:** `fast-xml-parser` (critical: entity expansion and an encoding bypass). The fix is minio 8. **Fixed in P-09:** minio 8 still had moderate findings and no release since February 2026, so the backend now uses the AWS SDK's S3 client. | `minio` | The object store's XML answers are parsed with it. |
| **The backend's linter has no configuration** (found in P-08). **Fixed in P-09** (ESLint 10, with type information). `npm run lint` in `BE/` stops with "ESLint couldn't find a configuration file": `BE/` has never had one. ESLint 8 is past its end of life. | `BE/package.json` | Nothing lints the backend, although the console is linted. |

## 2. Goals and non-goals

**Goals:**
- **Isolation.** A customer can't see, run, change or be billed for another customer's resources. Every route is checked, and a test proves it for every route.
- **Self-service sign-up and login,** without FF storing passwords, and with every copy of personal data in Tunisia (parent §9.2).
- **Exact metering.** Every invocation produces exactly one usage record, which the customer can't alter. Any bill can be recomputed from those records.
- **No bill shock.** Customers prepay in TND, see their balance and usage, and get warned before they run out.
- **Customer observability.** Customers read their own logs and metrics, and set alarms, without cluster access.
- **Operator observability.** You see the platform's health and get alerted before customers notice.
- **Operations without database or cluster access.** Approvals, account changes, support lookups, prices, plans, payments, credit and invoices are all done from an admin dashboard, and every action is audited.

**Non-goals (for now):**
- Postpaid invoicing, direct debit, and international card processors (parent §8.1, §8.8).
- The Lambda API facade with SigV4, and execution credentials for functions (parent §4.8, §6.6).
- Projects inside accounts, SSO federation, and the Admin and Billing roles (parent §4.8). The data model leaves room for them.
- **More than one backend replica.** That needs leader election for the scaler (parent R-06). The pilot runs one replica, and this plan keeps everything that must survive a restart in PostgreSQL.
- The invocation gateway (parent R-05).

## 3. Decisions

D1 to D5 and D12 are recorded in ADR 0004 (task P-00). D10 is confirmed by a spike and recorded in ADR 0005 (P-41).

### D1. The tenant is an account, not a user
- **Accounts** have a random 12-digit ID (the AWS-shaped format of parent ADR-006), a name, a status (`pending`, `active`, `rejected`, `suspended`, `closed`), a plan, a country, and an optional tax ID for B2B invoices.
- **Users** belong to accounts through memberships with a role (D4). A user can belong to several accounts.
- **Functions belong to the account.** `functions.userId` becomes `accountId`, and the tenant namespace becomes `ff-t-<first 12 hex of sha256(account ID)>`.
- **Why now:** changing the tenancy key later means moving every customer's namespace and Deployments. Pilot customers (agencies, startups, a university lab) are teams.
- **Existing development data is reset.** No customer data exists yet. The e2e test already creates a fresh tenant on every run.

### D2. Identity: Keycloak, with the backend checking tokens
- **Keycloak** (Apache-2.0), self-hosted in-country, one realm `ff`. It is the parent plan's choice (§4.8, §4.10). FF stores no passwords and keeps no sessions.
- **Clients:**
  - the console: Authorization Code with PKCE (public client);
  - the CLI: the OAuth device flow (CLI plan C-40);
  - the backend: a resource server. It checks each access token's signature against the realm's published keys, plus `iss`, `aud`, `exp` and `email_verified`, using `jose`.
- **Sign-up:**
  1. Keycloak's self-registration, with e-mail verification and acceptance of the terms.
  2. The backend creates the user record on the first authenticated call.
  3. `POST /accounts` creates an account with the caller as owner.
  4. **During the beta, new accounts start `pending`** until you approve them in the admin dashboard (decided 2026-10-16; P-71). That replaces phone verification and abuse controls (parent B-10) until the public launch.
- **E-mail:** Keycloak and the backend send through a local SMTP provider or FF's own mail server (parent §4.10). Development uses Mailpit in docker-compose.
- **Development mode** stays: `FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID`, and a header `X-FF-Dev-Account` to act as a second account in tests. Production refuses to start in this mode (P-02).

### D3. API keys for scripts, CI and the CLI
- **Format:** `Authorization: Bearer ffk_<key ID>_<secret>`, with 32 random bytes of secret. The guard tells keys from tokens by the prefix, which secret scanners can also match. ADR 0004 fixes the exact format.
- **Storage:** the SHA-256 of the secret. The secret is random and long, so a slow password hash isn't needed. It is shown once, at creation.
- **Scopes:** `functions:read`, `functions:write`, `functions:invoke`, `logs:read`, `metrics:read`, `usage:read`. A key never gets more than its creator's role. This is checked on every request, so a key loses access when its creator's role is lowered or its creator leaves the account.
- **Life cycle:** an optional expiry, `last_used_at`, and revocation. At most 20 keys per account.

### D4. Authorization: queries scoped to the account
- **The guard is global** (`APP_GUARD`) and denies by default. `@Public()` marks the few open routes: health checks and payment webhooks.
- **The principal** is `{ accountId, userId or keyId, role, scopes }`, set by the guard. `@User()` is replaced by `@Principal()`.
- **Choosing the account** (added by ADR 0004, because a user can belong to several accounts): an API key acts on its own account. A user's token acts on the account named by the `X-FF-Account` header, or on the user's only account when there is no header. A user with several accounts and no header gets 400; naming an account the user doesn't belong to gets 404.
- **Services take the account ID,** and every query includes it (`where: { id, accountId }`). A resource of another account answers **404**, exactly like one that doesn't exist. Controllers never load a resource by ID alone.
- **Roles for the pilot:**

  | Role | Functions and invocations | Logs, metrics, usage | Keys, members, billing, account |
  |---|---|---|---|
  | `owner` | read and write | read | manage |
  | `developer` | read and write | read | none |
  | `viewer` | read | read | none |

- **Error messages:** a function's own error goes back to the caller as today. A platform failure answers with a generic message and the request ID, and the details (namespace names, Kubernetes errors) go only to the server log.

### D5. Plans, quotas and rate limits
- **A plan** holds the account's limits: number of functions, memory and timeout per function, concurrent instances, API and invoke request rates, log and history retention, the idle time before scale to zero, and whether functions may reach the internet. Prices and the free tier are not in the plan: they are in the price book (D8).
- **The tenant ResourceQuota comes from the plan.** The backend already writes it into each namespace (`ensureTenant`). A plan change rewrites it.
- **Rate limits** use `@nestjs/throttler`, keyed by account (by IP before login), stored in memory while there is one backend replica, and in Valkey when there are more. Over the limit: `429 TooManyRequestsException` with `Retry-After`, Lambda's error name.
- **Internet egress is off by default** (decided 2026-10-16, the safe choice). Functions can still be invoked, but can't open connections to the internet. You turn it on for one account from the admin dashboard when its owner asks, with a reason (P-71). Today `K8S_EGRESS_INTERNET` is one switch for all tenants; P-62 makes it per account, in the tenant's NetworkPolicy.

### D6. Usage records are written once and never changed
- **One row per invocation** in a new `usage_records` table (§4), written when the invocation ends, in the same transaction as the invocation's final state.
- **The invocation ID is the request ID.** It is the primary key, which makes the write idempotent. The backend sends it to the runtime as `X-FF-Request-Id`, so history, usage and logs share one ID.
- **The record copies what the price depends on:** account, function ID and name, runtime, the configured memory at invoke time, the duration, the billed duration, the cold-start time, and the status.
- **Deleting or editing a function doesn't touch it:** no foreign key, no cascade. A database trigger refuses `UPDATE` and `DELETE`. The table is partitioned by month; old partitions are archived whole, after the retention the accountant confirms.
- **Lost calls:** at startup and every minute, invocations `RUNNING` for longer than their timeout plus the cold-start limit plus 30 s become `lost`, with a usage record that bills nothing. As built in P-20: two timeouts, since a call may first wait one for a free instance (D14).
- **Idle capacity is measured from day one.** Every minute, the backend lists the function Deployments with ready replicas (one Kubernetes API call) and records instances × memory per function in `capacity_samples`. This feeds D8's cost model, and warm-instance billing if you choose it.

### D7. What is billed

| Outcome | Status | Request billed | Duration billed |
|---|---|---|---|
| Success | `success` | yes | the runtime's duration, rounded up to 1 ms |
| The function raised, crashed, or ran out of memory | `error` | yes | the runtime's duration, rounded up to 1 ms |
| Timeout | `timeout` | yes | the function's timeout |
| Throttled: runtime queue full, rate limit, quota, no credit | `throttled` | no | 0 |
| Platform failure: the cold start failed, the pod was unreachable | `platform_error` | no | 0 |
| Lost: the backend restarted during the call | `lost` | no | 0 |

This follows Lambda: errors count as requests, throttles don't. **The cold start is recorded (`init_ms`) but not billed.** Lambda has billed its own init phase since August 2025, but FF's cold start is mostly platform start-up (scheduling, image, runtime boot), not the customer's code.

### D8. Prices: AWS Lambda's price list, in dinars, and configurable
**Decided 2026-10-16.** FF charges what Lambda charges, converted to TND, with the same units and the same free tier, so customers can compare directly with AWS.

| SKU | AWS list price (US East, x86, on demand) | In TND, at 2.9123 TND per US$ (example) |
|---|---|---|
| Requests | US$0.20 per million | 0.58246 per million |
| Duration, first 6 billion GB-s a month | US$0.0000166667 per GB-s | 0.0000485384 per GB-s |
| Duration, next 9 billion GB-s | US$0.0000150000 per GB-s | 0.0000436845 per GB-s |
| Duration, above 15 billion GB-s | US$0.0000133334 per GB-s | 0.0000388309 per GB-s |
| Provisioned concurrency (FF: `minInstances`) | US$0.0000041667 per GB-s while enabled | 0.0000121347 per GB-s |
| Duration on provisioned concurrency | US$0.0000097222 per GB-s | 0.0000283140 per GB-s |
| Free tier, per account and month | 1 million requests and 400,000 GB-s; none for functions with provisioned concurrency | the same |

- **Sources:** AWS's Lambda pricing page, read on 2026-10-16, for every price except the two higher duration tiers. Those are AWS's long-standing tier prices; P-30 re-checks all of them on the day it creates the book. The rate is the BCT's quote of 7 September 2026, as republished by Tunisie Numérique; the most recent one found. P-30 uses the BCT rate of the day it creates the first price book, and records it in the book.
- **How FF maps Lambda's model:**
  - `minInstances > 0` is FF's provisioned concurrency. The minimum instances are billed at the provisioned price, from the one-minute samples of P-21 (AWS rounds up to five minutes). That function's invocations are billed at the provisioned duration price, without the free tier, as on AWS.
  - Ephemeral storage isn't priced: FF functions have no configurable `/tmp` size.
  - The cold start stays unbilled (D7). AWS bills the customer's own initialization code; FF's runtimes don't measure it separately yet.
- **Configurable without code or deploys:**
  - prices live in versioned price books, each with a start date (`valid_from`), created and previewed in the admin dashboard (P-73);
  - a new book applies from its start date, and past usage keeps the prices that were valid when it happened;
  - the exchange rate is a value of the book, so following the dinar is a new book too.
- **Knobs prepared, off by default** (AWS has none of them): a minimum billed duration per request, a price per GB-s of idle instance time, and a monthly fee per plan. If you later decide that prices must cover idle instances (§1.3), that is a new price book, not new code.
- **The cost gap stays visible.** AWS's prices don't pay for idle instances. P-21 measures reserved against billed GB-s, and the admin overview shows the gap per day (P-75).

### D9. Money: FF's own ledger, prepaid first
- **The ledger follows parent §8.3:**
  - integer minor units (TND has three decimals), `BIGINT` in SQL and `bigint` in TypeScript;
  - double entry, with every transaction summing to zero;
  - idempotency keys on every movement;
  - gapless invoice numbers per fiscal year;
  - versioned price books.
- **Rating, every hour:**
  1. usage records are summed into `usage_hourly`;
  2. the price book's free tier for the month is applied first;
  3. the rest is priced, pre-tax, with the price book valid at the time of use;
  4. one ledger transaction is written per account and hour, with the idempotency key `usage:<account>:<hour>`.
- **Shadow billing first.** For the first two weeks, rating runs and is shown to customers, but nothing is debited. That catches metering bugs before they cost anyone money.
- **The balance check before each invoke:**
  - the spendable balance is cached in the backend and refreshed on every ledger write;
  - calls are allowed down to a small negative buffer, so metering lag never blocks a paying customer;
  - after the buffer and a grace period, invokes answer `402 InsufficientCreditException`. Reads, logs and deploys keep working, and nothing is deleted for non-payment (parent §8.1).
- **Top-ups:**
  - **Konnect** first (parent Appendix G): cards, including international ones, its wallet, and e-DINAR. Its webhook is a plain GET notification, so the backend always re-queries the payment before crediting it, and never trusts the browser's redirect.
  - **Bank transfer** for B2B: a pro-forma invoice with a payment reference, then you record the payment in the admin dashboard. Importing bank statements is parent B-04, later.
  - **Flouci** second, after pilot feedback.
- **Lago was considered and is not used for now.** It would add a service to run, and FF would still need its own code for the local gateways and the Tunisian invoice rules (stamp duty, withholding tax, El Fatoora). Revisit it for postpaid B2B invoicing.

**Tax and invoices.** You decided on monthly invoices. The rest was left to this plan; the accountant confirms it in P-00 (§9), and none of it blocks phases 0 to 2.
- **Invoices are monthly.** On the 1st, the backend drafts one invoice per account for the previous month. You review and issue them from the admin dashboard (P-74), with a reminder if they aren't issued by the 3rd.
- **VAT is charged when credit is bought.** A top-up buys credit at its pre-tax value, and the customer pays 19% VAT on top: 50.000 TND of credit costs 59.500 TND. Usage is then debited at D8's pre-tax prices.
  - Why: VAT on services may be due when the price is collected rather than when the service is used. Charging it at payment means it is never declared late. If the accountant says it is due on use, it was only declared early: a cash-flow cost, not a penalty.
- **The monthly invoice** lists the credit bought that month (one line per payment: pre-tax amount and VAT) and the 1 TND stamp duty, which is debited from the balance when the invoice is issued. A usage statement is attached: requests, GB-seconds and amount per function. A month without payments gets a statement but no invoice.
- **Fallback:** if the accountant requires invoices for consumption instead, only P-36's invoice content changes. The ledger records both payments and consumption anyway (about 3–5 more days).
- **Withholding tax** on B2B bank transfers (parent §8.5): only the share actually received is credited at first. The withheld share is credited when you upload the withholding certificate in the admin dashboard.
- **Payment fees** (Konnect: 1.3% for local cards, 2.9% for international ones) are FF's cost, not passed on.
- **Unused credit doesn't expire.** A refund is a credit note issued from the admin dashboard.
- **El Fatoora:** the first paid invoices are PDFs. The joint note of 23 January 2026 lets providers not yet connected keep issuing paper invoices for now (parent §8.6). P-37 starts at once, because the TunTrust certificate takes time. It must be live before GA, or as soon as that tolerance ends.

### D10. Logs: a collector, VictoriaLogs, and access only through the backend
- **The path:**
  1. Function pods write to stdout, as now.
  2. A collector DaemonSet (Vector or Fluent Bit, chosen in the P-41 spike) reads the container logs of `ff-t-*` namespaces only.
  3. It adds the namespace (the tenant), the pod, the function ID (pod label `ff.dev/function-id`), the stream, and the request ID parsed from `START`/`END`/`REPORT` and the runtimes' JSON lines.
  4. It writes to **VictoriaLogs** in `ff-system`.
- **Why VictoriaLogs:** it is the parent plan's choice (ADR-008): Apache-2.0, a single binary, cheap storage. Loki (AGPL, used unmodified) remains acceptable if the spike finds a blocker.
- **Customers never reach the log store.** A NetworkPolicy lets only the backend query it. The backend builds every query itself and always adds the caller's namespace and function. Search text is passed as a quoted phrase, never as raw query language.
- **Retention:** the store keeps logs for the longest plan's retention, and the API limits each account to its plan's window. How to delete one account's logs (account closure, data-subject requests) is confirmed in the spike.
- **Flood protection:** long lines are truncated, and the collector limits the ingestion rate per namespace, so a function printing in a loop can't fill the store.
- **Interim:** the CLI plan's C-05 (pod logs through the Kubernetes API, which the backend may already read) ships first, with the same API shape. The store then replaces its source, and the API doesn't change.

### D11. Customer metrics come from the usage records
- **Source:** `usage_records`, so the metrics are exact, survive restarts and deletes, and match the bill. Instances come from `capacity_samples`.
- **Metrics,** named as in CloudWatch (parent §6.8): `Invocations`, `Errors`, `Throttles`, `Duration` (average, maximum, p50, p95, p99), plus FF's `ColdStarts` and `Instances`.
- **Periods** of 1, 5 and 60 minutes. Quiet periods are filled with zeros when queried, not stored.
- **`function_metrics` stays internal,** for the scaler. `/metrics/:functionId` is removed.
- **Alarms** follow CloudWatch's shape:
  - a metric, a statistic, a period, a threshold and a comparison;
  - "M out of N" evaluation periods;
  - the states `OK`, `ALARM` and `INSUFFICIENT_DATA`;
  - actions: e-mail, or a webhook signed with HMAC-SHA256, with retries.

  They are evaluated every minute in the backend. Billing alerts (balance below a threshold, monthly spend above one) use the same mechanism, which covers parent B-07's alerts.
- **Operator monitoring is separate:** Prometheus, Grafana and Alertmanager (parent F-09). Customers never see it.

### D12. An admin dashboard, separate from the customer console
- **A separate web app,** `admin/`, built with the console's stack (React, Vite) so components can be shared. It never ships in the customer console's bundle.
- **Its own hostname** (`admin.<domain>`). The edge proxy accepts it only from your IP addresses or VPN.
- **Login:** through Keycloak, with the client `ff-admin`, the realm role `ff-operator`, and a one-time-password second factor that Keycloak requires for that role.
- **Backend:** an `AdminModule` under `/admin`, behind an `OperatorGuard`. The guard checks the role and that the token was issued to `ff-admin` (the `azp` claim), so a console token can't call admin routes, even an operator's.
- **Every write needs a reason** and goes to the audit log with the operator's identity. A credit grant above a configurable amount needs a second confirmation.
- **Looking at customer data needs a reason too.** Viewing a function's code, its invocation inputs and outputs, or its logs is recorded in the customer's own audit log (P-17), so customers can see when FF staff looked.
- **No impersonation.** Operators see accounts read-only and act only through explicit admin actions.
- **Settings live in the database, not in environment variables:** the billing buffer, grace period, shadow mode, low-balance defaults, invoice reminder, and the large-credit threshold. They are kept in `platform_settings`, with every change in the audit log, and edited from the dashboard.

### D13. PostgreSQL in production: environment variables, once three tasks are done
You asked whether production PostgreSQL is only a matter of environment variables. **Mostly yes.** The backend already reads `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` and `DB_NAME`, so it can use any PostgreSQL: one managed by the data center, or one you run. Today that would still fail, for reasons this plan fixes:
1. **The schema.** In production, schema sync is off and the migrations are out of date, so a fresh production database stays empty and the backend breaks on first use (§1.2). P-01 fixes it.
2. **TLS to the database.** The backend has no TLS settings for its database connection. P-02 adds `DB_SSL` and `DB_SSL_CA`, and refuses the default credentials.
3. **Backups.** Usage, ledger and invoices are money. P-61 adds point-in-time recovery: from the provider, or pgBackRest if you run the server yourself.

Keycloak needs a database too: a second database and user on the same server, set through its `KC_DB_*` variables (P-60). Use PostgreSQL 15 or newer; development uses 15. **Decided:** no database operator in the cluster for now; you pick the server when you pick the hosting.

### D14. Scaling: concurrency, counted by the backend
**Decided 2026-10-17, in P-06.** It replaces the rule that counted requests per minute and never added an instance.
- **One call per instance,** as on Lambda. The signal is concurrency: a function's calls in flight. The backend sends every call, so it counts them exactly while there is one backend replica; several replicas would need the runtimes to report their queues.
- **Scale up at once.** A call that finds every instance busy raises the Deployment to one instance per call in flight, up to `maxInstances`. A cold start never lowers a count that the scaler raised.
- **Scale down slowly.** Once a minute, a function steps down one instance towards what its busiest moment needed, and never below one while it has instances. The idle sweep still takes it to zero after the idle window.
- **Waiting is bounded.** A call waits at most one function timeout for a free instance (`FF_MAX_QUEUE_WAIT_MS` in the runtimes), then gets `429 TooManyRequestsException`. The backend's own timeout covers that wait plus the run, so it never gives up on a call that is only waiting. Calls already queued in a pod don't move to a new one: that needs the invocation gateway (parent R-05).
- **Customers set** `minInstances` (0–10) and `maxInstances` (1–10, 3 by default) with `PUT /functions/:id/scaling-config`. Since P-15, the plan's `instancesPerFunction` replaces the 10. `scaleToZero` isn't settable: a function scales to zero exactly when its `minInstances` is 0, so warm instances are always `minInstances`, which D8 bills as provisioned concurrency.
- **No p95 rule.** With one call per instance, more instances don't help a slow function that gets one call at a time, and concurrency already shows calls that wait.

## 4. Data model

New tables, as a sketch. Names follow the parent's Appendix E, with `orgs` renamed `accounts`. P-01 switches the schema to snake_case columns (TypeORM's naming strategy) while there is no production data; the API's JSON fields don't change.

```sql
-- Accounts and access (phase 1)
create table plans (id text primary key, name text not null, limits jsonb not null);       -- D5
create table accounts (id char(12) primary key,                                             -- random 12 digits
  name text not null, status text not null default 'pending'
    check (status in ('pending', 'active', 'rejected', 'suspended', 'closed')),
  plan_id text not null references plans, country char(2) not null default 'TN', tax_id text,
  internet_egress boolean not null default false,                                           -- D5: off until you turn it on
  created_at timestamptz not null default now());
create table users (id uuid primary key default gen_random_uuid(), oidc_sub text unique not null,
  email text not null, name text, locale text not null default 'fr-TN', created_at timestamptz not null default now());
create table memberships (account_id char(12) references accounts, user_id uuid references users,
  role text not null check (role in ('owner', 'developer', 'viewer')), primary key (account_id, user_id));
create table api_keys (id text primary key,                                                 -- the <key ID> in ffk_<key ID>_<secret>
  account_id char(12) not null references accounts, created_by uuid not null references users,
  name text not null, secret_sha256 bytea not null, scopes text[] not null,
  expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz);
create table audit_log (id bigserial primary key, account_id char(12), actor text not null, action text not null,
  resource text, at timestamptz not null default now(), details jsonb);
-- functions: user_id → account_id char(12) not null references accounts

-- Metering (phase 2)
create table usage_records (
  request_id uuid not null,              -- = the invocation ID, sent to the runtime as X-FF-Request-Id
  account_id char(12) not null,
  function_id uuid not null,             -- no foreign key: deleting the function keeps the record
  function_name text not null,
  runtime text not null,
  memory_mb int not null,                -- configured memory at invoke time
  duration_ms numeric(12,3) not null,    -- as measured by the runtime
  billed_ms int not null,                -- D7
  init_ms int,                           -- cold start: recorded, not billed
  status text not null check (status in ('success', 'error', 'timeout', 'throttled', 'platform_error', 'lost')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  primary key (request_id, started_at)   -- the partition key must be part of the primary key
) partition by range (started_at);
-- + a trigger that rejects UPDATE and DELETE
create index on usage_records (account_id, started_at);
create index on usage_records (function_id, started_at);
create table capacity_samples (function_id uuid not null, account_id char(12) not null, minute timestamptz not null,
  instances int not null, min_instances int not null, memory_mb int not null,              -- min_instances: D8's provisioned time
  primary key (function_id, minute));

-- Prepaid credit (phase 3): currencies, price_books, usage_hourly, ledger_accounts, ledger_transactions,
-- ledger_entries, payments, webhook_events, invoice_counters, invoices, invoice_lines,
-- as in the parent's Appendix E, with org_id → account_id. price_books.prices holds the document shown below.

-- Alarms (phase 5)
create table alarms (id uuid primary key default gen_random_uuid(), account_id char(12) not null references accounts,
  function_id uuid references functions on delete cascade,   -- null: an account-wide or billing alarm
  name text not null, metric text not null, statistic text not null, period_s int not null,
  comparison text not null, threshold numeric not null, evaluation_periods int not null, datapoints_to_alarm int not null,
  state text not null default 'INSUFFICIENT_DATA', state_changed_at timestamptz, actions jsonb not null);
create table notification_deliveries (id bigserial primary key, alarm_id uuid, channel text not null, target text not null,
  status text not null, attempts int not null default 0, last_error text, created_at timestamptz not null default now());

-- Admin dashboard (D12)
create table platform_settings (key text primary key, value jsonb not null,
  updated_by text not null, updated_at timestamptz not null default now());   -- every change is also in audit_log
```

**The first price book** (D8), as P-30 created it (migration `PriceBooks`, `FIRST_PRICE_BOOK`): valid from 2026-10-01, AWS's list read on 2026-10-17, at the BCT's average interbank rate of 2026-10-14, 3.0080 TND per US$. Prices are decimal strings, never floating-point numbers, each exactly the US$ price times the rate, unrounded; money is rounded only where it is shown or debited (parent §8.3):

```json
{
  "currency": "TND",
  "source": { "kind": "aws-lambda", "region": "us-east-1", "architecture": "x86_64", "readOn": "2026-10-17",
              "priceList": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json",
              "priceListPublished": "2026-10-16T18:23:59Z",
              "usdPrices": { "requestsPerMillion": "0.20", "gbSecond": [ … "0.0000166667", "0.0000150000", "0.0000133334" … ],
                             "provisionedGbSecond": "0.0000041667", "provisionedDurationGbSecond": "0.0000097222" },
              "usdRate": "3.0080", "usdRateDate": "2026-10-14", "usdRateSource": "BCT: cours moyens … marché des changes interbancaire" },
  "freeTier": { "requests": 1000000, "gbSeconds": 400000 },
  "prices": {
    "requestsPerMillion": "0.6016",
    "gbSecond": [
      { "upToGbSeconds": 6000000000, "price": "0.0000501334336" },
      { "upToGbSeconds": 15000000000, "price": "0.00004512" },
      { "upToGbSeconds": null, "price": "0.0000401068672" }
    ],
    "provisionedGbSecond": "0.0000125334336",
    "provisionedDurationGbSecond": "0.0000292443776",
    "minimumBilledMs": 0,
    "idleInstanceGbSecond": "0",
    "monthlyPlanFee": "0"
  }
}
```

The last three are D8's prepared knobs, set to AWS's behaviour.

## 5. API changes

| Route | What | Task |
|---|---|---|
| Every `/functions` route | Scoped to the caller's account; 404 for other accounts; `limit` at most 100 | P-10 |
| `GET`, `PUT /functions/:id/scaling-config` | Instance limits: `minInstances` and `maxInstances` (D14). ✅ Built | P-06 |
| `GET /me` | The user, their accounts and roles. ✅ Built | P-12 |
| `POST /accounts`, `GET /accounts/:id`, `PATCH /accounts/:id` | Create an account (the caller becomes owner), read it, rename it, set the tax ID. ✅ Built | P-12 |
| `GET`, `POST`, `DELETE /api-keys` | List, create (the secret is shown once), revoke. ✅ Built | P-13 |
| `GET`, `POST /members`, `PATCH`, `DELETE /members/:userId`, `DELETE /members/invitations/:id` | Members and invitations; the invited address's user joins at its next call. ✅ Built | P-16 |
| `GET /audit-log` | The account's audit log (owners), newest first, with a cursor. ✅ Built | P-17 |
| `GET /usage?month=YYYY-MM` | Requests, GB-seconds and cost per function; CSV with `Accept: text/csv`. ✅ Built; its estimated cost from P-30 | P-22, P-30 |
| `GET /billing/balance`, `GET /billing/transactions` | Balance, top-ups and debits. ✅ Built: the balance, the month's charges, how far the rating has come; the wallet's transactions; the credit state since P-33 | P-32 |
| `GET`, `PUT /billing/alerts` | The low-balance e-mails' shares of the last credit; owners change them. ✅ Built | P-33 |
| `POST /billing/top-ups` | Start a Konnect payment and return its `payUrl` | P-34 |
| `GET /webhooks/konnect` (public) | Konnect's payment notification | P-34 |
| `GET /billing/invoices`, `GET /billing/invoices/:id/pdf` | Invoices | P-36 |
| `GET /functions/:id/logs` | Logs by time range, text and request ID, with a cursor | P-40, P-43 |
| `GET /functions/:id/logs/stream` | Live tail (Server-Sent Events) | P-43 |
| `GET /functions/:id/metrics`, `GET /metrics` | Function and account metrics (D11); replaces `GET /metrics/:functionId` | P-50 |
| `GET`, `POST`, `PUT`, `DELETE /alarms` | Alarms | P-52 |
| `GET /healthz`, `GET /readyz` (public) | Liveness and readiness | P-53 |
| `/admin/*` | The admin dashboard's routes, for you only (D12): the table below | P-70 to P-76 |

**Admin routes.** Every one needs the `ff-operator` role and a token issued to `ff-admin`. Every write takes a `reason` and goes to the audit log.

| Route | What | Task |
|---|---|---|
| `GET`, `PUT /admin/settings` | Billing and platform settings (D12). ✅ Built | P-70 |
| `GET /admin/accounts`, `GET /admin/accounts/:id`, `GET /admin/accounts/:id/audit-log` | Search, filters, the account page, and its whole audit log. ✅ Built; the page has the balance since P-31 | P-71 |
| `POST /admin/accounts/:id/approve`, `/reject`, `/suspend`, `/reactivate`, `/close` | Status changes, with an e-mail to the owners. ✅ Built | P-71 |
| `PUT /admin/accounts/:id/plan`, `PUT /admin/accounts/:id/egress` | Plan, and internet egress (D5). ✅ Built; the NetworkPolicy follows egress from P-62 | P-71 |
| `GET /admin/lookup?q=`, `GET /admin/functions/:id` | Find a function, request ID, account or e-mail across accounts | P-72 |
| `POST /admin/functions/:id/access` | View code, inputs and outputs, or logs, with a reason that the customer can see | P-72 |
| `GET`, `POST /admin/price-books`, `POST /admin/price-books/preview`, `DELETE /admin/price-books/:id` | Price books, and re-rating last month with a draft. ✅ Built | P-73 |
| `GET`, `POST /admin/plans`, `PUT /admin/plans/:id` | Plan limits. ✅ Built: `GET` in P-71, for the plan picker | P-73 |
| `GET /admin/payments`, `POST /admin/bank-transfers`, `POST /admin/withholding-certificates` | Payments, transfers, withholding | P-74 |
| `POST /admin/credits` | Promotional credit and corrections | P-74 |
| `GET /admin/invoices`, `POST /admin/invoices/issue`, `POST /admin/invoices/:id/credit-note` | Monthly drafts, issuing, credit notes | P-74 |
| `GET /admin/stats/overview` | The overview's figures | P-75 |
| `GET /admin/audit-log` | Every operator action, filtered, and as CSV. ✅ Built | P-76 |

## 6. Working rules

The same as the Kubernetes migration and the CLI plan:
- `hack/check-resources.sh` runs before every heavy step, and only one heavy operation runs at a time.
- Work on a branch `feat/client-ready`, with one commit per task: `type(scope): summary (P-xx)`.
- Each commit passes `npx tsc --noEmit` and `npm test` in `BE/`, plus the task's own tests.
- Each task's progress row records its tests and the documents it changed. Changed documents pass `hack/check-docs.py`.

**Test levels** (as in the migration plan, with two additions):

| Level | What | Tool |
|---|---|---|
| L0 | Type-check and build, backend and console | `tsc --noEmit`, `nest build`, `npm run build` in `FE/` |
| L1 | Unit tests | Jest |
| L2 | Against real PostgreSQL: migrations, triggers, ledger invariants, concurrent writes | `npm run test:db` in `BE/`: Jest, each case in its own scratch database on the compose server |
| L3 | Cluster integration | the `K8S_IT=1` Jest suite on k3d |
| L4 | End to end through the public API, with Keycloak in docker-compose | `hack/e2e.sh` |
| L5 | **Cross-account suite:** for every route in the OpenAPI document, account B gets 404 (or 403 for a missing role) on account A's resources, and anonymous calls get 401 | `hack/e2e-tenancy.sh`, in CI from P-63 |

## 7. Tasks

### Phase 0: groundwork

#### P-00: Preparation and ADR 0004
- Create the branch. Write `docs/adr/0004-identity-and-tenancy.md`, recording D1 to D5 and D12.
- **External lead times, started now:** the Konnect merchant onboarding (sandbox first), the accountant's questions in §9, and the TunTrust certificate for El Fatoora (parent §16).
- **Done when:** the ADR passes `hack/check-docs.py`.

#### P-01: Schema baseline (parent F-04)
- **Baseline:** squash the migrations into one generated from the entities, with snake_case columns and `gen_random_uuid()`.
- **`synchronize: false`** in every environment. Migrations run as a separate deploy step (`npm run migration:run`), and the backend refuses to start when migrations are pending.
- **Drift check:** `npm run migration:check` fails when `migration:generate` would produce anything.
- **Tests:** L2: a fresh database, then the migrations, then L1 and L4 with sync off.
- **Docs:** the getting-started guide (development databases are reset once).
- **As built** (2026-10-17):
  - `BE/src/database/` holds one options builder, shared by the backend and the TypeORM CLI, with explicit lists of entities and migrations. A file glob over `dist/` would also match the compiled `.d.ts` files.
  - `SnakeNamingStrategy` is FF's own (about 40 lines, tested), not a dependency. `uuidExtension: 'pgcrypto'` gives `gen_random_uuid()`, and `installExtensions: false` keeps TypeORM from creating extensions, which managed servers may forbid.
  - Two changes that are free while no production data exists: every timestamp is `timestamptz`, and `function_invocations` has an index on `(function_id, created_at)` for the history and for cascade deletes.
  - Commands in `BE/`: `migration:run`, `migration:run:prod` (from the build, for P-60's Job), `migration:revert`, `migration:show`, `migration:generate`, `migration:check`, and `test:db`. The drift check and the L2 tests work in scratch databases and never touch the configured one.

#### P-02: Validated configuration (parent F-05)
- **One schema** for every variable (Zod), checked at boot, failing with a message that names the variable.
- **Production refuses:**
  - `FF_AUTH_MODE=dev`;
  - the default database and storage credentials;
  - a missing Keycloak issuer or audience.
- **Database TLS:** `DB_SSL` and `DB_SSL_CA` (D13).
- **`FF_DEV_USER_ID`** is replaced by `FF_AUTH_MODE=dev` and `FF_DEV_ACCOUNT_ID` (D2).
- **Tests:** L1 for each refusal.
- **As built** (2026-10-17):
  - `BE/src/config/configuration.ts` holds the schema (Zod 4.6.5) for all 39 variables. `databaseConfiguration()` reads only `DB_*` and `NODE_ENV`, for the TypeORM CLI, the drift check and the L2 tests, so a migration job needs no other setting.
  - **`FF_AUTH_MODE` defaults to `oidc`,** so the dev mode must be asked for. A deployment that forgets `NODE_ENV=production` still doesn't run open. Until P-11, `oidc` answers 401 to every request.
  - The dev account is `000000000001` (namespace `ff-t-27d6fbbe5c7d`). A leftover `FF_DEV_USER_ID` is refused with an explanation.
  - Production also refuses an `http://` issuer and a missing `CORS_ORIGIN` (P-60's "CORS limited to the console's origin"). `CORS_ORIGIN` is a checked list of origins.
  - `DB_SSL` always verifies the server, against `DB_SSL_CA` or the system's CAs. There is no switch to skip verification.
  - Messages name the variable and what it expects, and never repeat a credential.

#### P-03: Function lifecycle fixes
- **An update repairs a failed function.** A successful rollout sets `status = ACTIVE` and clears `error`. An update of a function in `ERROR` always rolls out, even when no rollout field changed, so the same code can be retried after a passing failure (a full quota, a missing image).
- **A failed update is rolled back:**
  - the code goes to S3 only after the rollout succeeds;
  - when the wait fails, the backend re-applies the previous version and waits for it, so the Deployment matches the record again (its ConfigMap still exists, because `collectOldConfigMaps` keeps one previous version);
  - the answer is 400 with the diagnosis, as today. If the rollback fails too, the function becomes `ERROR`, with both messages.
- **An update checks new code even at zero.** When the code changes, `apply()` rolls out with at least one replica, and the wait checks that pod; the idle sweep scales it back to zero after the idle window. The `waitUntilReady` comment (`orchestrator.types.ts:42`) is corrected: the wait covers every desired replica.
- **A failed create releases its pod.** The Deployment is scaled to zero. The objects and the diagnosis stay, so an update can repair the function, or a delete removes everything.
- **Tests:**
  - L1 (`functions.service.spec.ts`, with the fake orchestrator): an update of an `ERROR` function ends `ACTIVE`; a failed update re-applies the previous version and uploads nothing; a failed create scales to zero; an update at zero rolls out with one replica;
  - L3 (`K8S_IT=1`): a broken create ends `ERROR` with no pod, and an update with fixed code makes it `ACTIVE` and invocable; a broken update of a working function answers 400, and after a scale to zero the next cold start still runs the old code; an update at zero starts a pod and checks it.
- **Docs:** `how-it-works.html` (the update and failed-load scenarios, the lifecycle diagram), and the getting-started guide's troubleshooting.
- **As built** (2026-10-17), with two refinements:
  - **A failed update of a function that isn't `ACTIVE` keeps the attempt.** It has no working version to go back to, and rolling back would wait another 90 s for code that fails anyway. So the record takes the attempted code with the new diagnosis, which is what the user needs to see, the Deployment keeps it too, scaled to zero, and S3 gets its copy.
  - **Every rollout runs at least one replica,** not only a code change: a memory or runtime change can break loading as well. `apply()` uses `max(current replicas, minInstances, 1)`.
  - When the rollback fails as well, the function is `ERROR` with both messages, and its pod is released. A `CodeTooLargeError` changes nothing, since it is raised before any object is applied.
  - The S3 copy is written after the record, and a failure there is logged rather than failing the update: nothing reads the copy yet. A runtime change moves it (`code.ts` ↔ `code.py`).

#### P-04: Runtime fixes: Lambda parity and robustness
- **Working directory:** the Node.js runtime changes to `LAMBDA_TASK_ROOT` (`/var/task`) when it starts, in the main thread, because worker threads can't call `process.chdir()`. The worker script is already loaded by an absolute path (`main.ts:129`).
- **Max memory used:** Node.js reports the process's peak resident memory (`process.resourceUsage().maxRSS`, in KiB) instead of the current one, so both runtimes report the peak, as Lambda does.
- **Error logs:** the Node.js worker writes the same `function error` JSON line as Python, with `requestId`, `errorType`, `errorMessage` and `stackTrace`. Python logs an out-of-memory replacement, as Node.js does. Phase 4's request-ID parsing relies on both.
- **Failed reloads:** when a worker fails to load after the first successful start, the main process exits with a non-zero code, so kubelet restarts the container. A failure of the very first load stays reported on `/readyz`, as today.
- **Results that JSON can't hold:** the Node.js worker answers `Runtime.MarshalError` ("Unable to marshal response: …"), as Python does, when `JSON.stringify` throws or returns nothing. The main process checks the body before measuring it.
- **Callback-style handlers:** do what Lambda's Node.js 24 runtime does: accept `(event, context, callback)` handlers, or reject them at load with a clear error. Without callbacks, the context stops offering `callbackWaitsForEmptyEventLoop`.
- **A flaky L3 case:** on 2026-10-17, "turns a Node.js heap hog into Runtime.OutOfMemory" got `Sandbox.Timedout` once in two runs: at 0.1 CPU, garbage collection near the heap limit can outlast the 10 s timeout. Make the outcome deterministic, in the runtime or in the test.
- **Tests:** a case for each item in `runtimes/nodejs/test/runtime.test.mjs` and `runtimes/python/tests/test_runtime.py`; both container smoke tests; L3 for a function that reads a file next to its code.
- **Images:** new tags (`24-v2`, `3.13-v2`), with the defaults in `configuration.ts` and `BE/.env.example` and every script that names the old tags (`grep -rn -- -v1`). Running functions keep the old image until their next update.
- **Docs:** both runtime READMEs. The Python README's examples show the spaced JSON (`{"status": "ok"}`) that the runtime really writes.
- **As built** (2026-10-17):
  - **Callback handlers are refused at load,** with `Runtime.CallbackHandlerDeprecated`, as on Lambda's Node.js 24 runtime. AWS's launch post of 25 November 2025 says that runtime no longer supports the callback signature and removed `context.callbackWaitsForEmptyEventLoop`; a test published three days later shows the error type. AWS doesn't say whether an async handler with a third parameter is spared, so FF refuses any handler that declares one, with a message that says what to write instead. Refusing at load makes the deploy fail with that message (P-03), rather than every invocation.
  - **Stack traces are source-mapped:** the `function error` line points at the lines of the user's TypeScript, without the runtime's frames or Node's internals.
  - **The `v2` in the tags is the runtime protocol's version,** as the READMEs already defined `v1`. The HTTP interface is unchanged, so the backend works with both; each README has a "What changed in v2" section. The startup line says `"protocol": 2`.
  - After a failed reload, the runtime answers the waiting invocations, then exits 200 ms later, so their answers get out.
  - The flaky L3 case was the test's: at 0.1 CPU, V8's last collections near the heap limit can take longer than 10 s. Its memory hog now has 30 s.

#### P-05: Console fixes
- **Moved here from P-14,** so the console works before its new pages are built (parent H-11):
  - the invocation history reads `{ invocations, total }` (`FE/src/components/FunctionDetail.tsx:33`, `FE/src/services/api.ts:81`);
  - the invoke result shows the invocation's `duration`, `memoryUsed`, `createdAt` and `updatedAt`, instead of `response.data.metrics.*` (`FunctionDetail.tsx:68-72`);
  - an edit sends only the changed fields that the API accepts (`FunctionDetail.tsx:88`);
  - the scaling form is read-only until P-06 decides what customers may change, because `PUT /functions/:id/scaling-config` doesn't exist (`api.ts:102`);
  - the debug `console.log` goes (`FunctionDetail.tsx:31`).
- **Tests:** L0 (`npm run build`); a manual check of create, invoke, history and edit against the development stack, recorded in the progress log.
- **As built** (2026-10-17):
  - Fixed as well, in the same pages, because the check of create, invoke, history and edit needs them:
    - memory showed `memoryUsed / 1024 / 1024`, though the API sends MB, so every invocation read 0.00 MB;
    - a function's error replaced the whole page with axios's "Request failed with status code 400", instead of the API's message;
    - an empty invoke input was refused as invalid JSON (it now means `{}`, and a JSON value that isn't an object is refused before sending, as the API would);
    - the edit form and the list showed a "Description" that the API doesn't have.
  - The edit form has name, code, memory and timeout. The overview shows the status and, for `ERROR`, the diagnosis with what to do (P-03): an unchanged update of an `ERROR` function is sent, so it retries.
  - The API types in `FE/src/services/api.ts` match what the backend returns, so the compiler catches the next drift. The Redux thunks reject with the API's message.
  - **Unit tests for the console:** Vitest 3.2.7 (`npm test`) on the helpers behind the fixes (`FE/src/lib/functions.ts`). Vitest 4.1.11 needed `--legacy-peer-deps`, because npm 11.4.2's resolver crashes on its optional peers.
  - **The manual check is scripted:** headless Chrome through `puppeteer-core`, kept outside the repository, drives the real console against the real backend and cluster.
- **Decide the beta's scaling model,** and record it in §3:
  - which settings customers may change (`minInstances`, `maxInstances`), within the plan's limits (P-15);
  - the default `maxInstances`, which is 1 today, so autoscaling never adds a pod;
  - the signal that adds a pod: requests per instance and minute, as today (`MAX_REQUESTS_PER_INSTANCE`, 2), or concurrency, meaning calls running or waiting per instance. Only the runtime knows its queue; it would report it, for example in a response header.
- **Build it:** validated DTO fields; `decideReplicas` with the chosen signal; a p95 rule on the runtime's duration, without cold starts; a `scaling-config` route that writes as well as reads. P-05's form then becomes editable.
- **Calls waiting in a pod's queue:** the backend's timeout (the function's timeout plus 2 s) also counts the time a call waits behind others. Either the backend waits longer when the pod reports a queue, or the pod answers 429 before queueing, recorded as `throttled` (P-15).
- **Unused columns:** a migration drops `functions.cpu`, `function_invocations.cpuUsed` and `function_metrics.cpuUsage`, and `targetConcurrency` unless the chosen model uses it.
- **Tests:** L1 for `decideReplicas` with the new inputs; L3: a burst of slow calls to one function scales it to two pods, and no call fails while the second pod starts.
- **Docs:** `how-it-works.html` (the metrics scenario and the limits), and the getting-started guide's limits.
- **As built** (2026-10-17): the model is D14.
  - **Backend:** a `ConcurrencyTracker` counts calls in flight; `MetricsService` scales up at once for a burst, reading the Deployment once per new high, and steps down once a minute, including functions scaled up earlier that have gone quiet. The sweep never takes a function with calls in flight to zero. `decideReplicas` takes the peak concurrency and the Deployment's desired replicas. `function_metrics.max_concurrency` keeps each minute's peak.
  - **Driver:** `desiredInstances()`; one read gives desired and ready replicas. A cold start scales only from zero, and waits for one instance rather than the whole rollout. The call's timeout is one queue wait plus the function's timeout plus 2 s. A replica count that isn't a number is refused, instead of going out as `null`, which Kubernetes takes as zero.
  - **Runtimes:** `FF_MAX_QUEUE_WAIT_MS`, one timeout by default and set so by the manifests. The v2 images are rebuilt with it; v2 has never been released.
  - **API:** `PUT /functions/:id/scaling-config`, validated. It brings the running instances within the new limits at once, without a rollout. The console's scaling tab is editable.
  - **Migration** `ScalingModel`, written by hand because TypeORM's generator guessed a rename: it drops `functions.cpu`, `functions.target_concurrency`, `function_invocations.cpu_used` and `function_metrics.cpu_usage`, adds `max_concurrency`, and sets the default `max_instances` to 3. Existing functions keep their limit. `MAX_REQUESTS_PER_INSTANCE` is no longer read.

#### P-07: Cluster permissions
- **`services/proxy`** moves from `deploy/k8s/base` to a development-only overlay that `hack/k8s/cluster-up.sh` applies. Production invokes in direct mode (P-60) and doesn't need it.
- **The namespace prefix:** the configuration schema (P-02) refuses a `K8S_NAMESPACE_PREFIX` other than `ff-t-`, because the admission policy checks that prefix (`40-admission-policy.yaml:45`).
- **Cluster-wide reads:** decide, and record the decision in `deploy/k8s/README.md`. Either accept them for the beta and say what they expose, or bind the read permissions per tenant namespace, which needs a separate provisioner because the backend must not manage RBAC. The `pods/log` permission goes once P-43 serves logs from the log store. P-64 reviews the decision.
- **Tests:** `hack/k8s/test-rbac.sh`: with the production manifests, the controller can't proxy to a Service, in a tenant namespace or anywhere else; with the development overlay, it can.
- **Docs:** `deploy/k8s/README.md`, the Kubernetes dev guide.
- **As built** (2026-10-17):
  - `deploy/k8s/dev/` is `base/` plus a separate ClusterRole and binding, `ff-controller-dev-proxy`, for `services/proxy`. A patch of the base role would have replaced its whole rule list. `hack/k8s/cluster-up.sh` applies `dev/`.
  - **The admission policy now checks proxy calls too.** They reach admission as `CONNECT`, which a ValidatingAdmissionPolicy can match, so with the dev overlay the backend proxies only into its `ff-t-*` namespaces. This was checked on the cluster: without the rule, a proxy call into `default` passes admission.
  - **Cluster-wide reads are accepted for the beta,** under four rules recorded in `deploy/k8s/README.md`: FF has its own cluster; platform credentials live only in Secrets, never in ConfigMaps, environment values, command lines or logs; the backend uses its short-lived projected token; and `pods/log` goes with P-43. The README also describes the narrower option for P-64: per-tenant RoleBindings that the backend could create itself with `bind` on a single ClusterRole, without a separate provisioner.
  - `K8S_NAMESPACE_PREFIX` accepts only `ff-t-`.

#### P-08: API and documentation fixes
- **The OpenAPI document** says invoke answers 201, as it does (`functions.controller.ts:81`).
- **One timeout, one status:** when the backend gives up waiting in proxy mode, the error becomes a `FunctionTimeoutError`, as in direct mode. P-20 then maps it to the usage status.
- **The migration plan's KubeClient names** match the code: `scaleDeployment`, `list`, and `podLog(ns, pod, container, tailLines)` (`docs/kubernetes-migration-plan.md:400-401`).
- **Tests:** L1 for the timeout mapping; `hack/e2e.sh` unchanged.
- **As built** (2026-10-17):
  - `BE/src/api-document.ts` builds the OpenAPI document that `main.ts` serves at `/api`. The L1 test builds it with the same function, starts the controllers on a local port with stub services, calls every documented route, and compares the status each answers with the documented one. Only invoke differed.
  - The KubeClient raises `KubeRequestTimeoutError` when a request gets no answer in time. In proxy mode, the driver turns it into the same `FunctionTimeoutError` as a direct call: `No response within N ms`, where N is one timeout of waiting for a free instance, plus the timeout, plus 2 s.
  - Checked on the cluster: the API server's Service proxy keeps a call that gets no answer open past its own 60 s request limit (75 s tried). The backend's wait is what ends it, so the mapping also works for long timeouts.
  - The migration plan's K-06 lists the client's methods as built; K-03 notes P-06's interface changes.
  - In `how-it-works.html`, the limits table and the 429 row still described the limits from before P-06 (one instance at most, "the API can't change them", no queue wait). They are corrected.

#### P-09: Dependency upgrades
- **Why:** the known vulnerabilities of §1.7, found on 2026-10-17.
- **Do:**
  - the non-breaking fixes first (`npm audit fix`): TypeORM 0.3.26 or newer, `@nestjs/common` 10.4.16 or newer, `proxy-addr`, `sha.js`;
  - NestJS 10 to 12, all `@nestjs/*` packages together, with Express 5;
  - minio 7 to 8. If the client stays affected, replace it with the AWS SDK's S3 client: FF only uploads and deletes objects;
  - the same audit for the console (`FE/`) and the Node.js runtime (`runtimes/nodejs`);
  - a linter for the backend: ESLint with a flat configuration and the matching `typescript-eslint`, so that `npm run lint` runs and becomes part of L0.
- **Done when:** `npm audit --omit=dev` reports no critical or high finding in any of the three, or each remaining one is accepted in writing with a reason; `npm run lint` passes in `BE/`.
- **Order:** before phase 1, because P-11 adds `jose` and P-15 adds `@nestjs/throttler`, which must match the NestJS version.
- **Tests:** L0 to L4 green, unchanged; the audit's output in the progress log.
- **As built** (2026-10-17), in parts, one commit each. Every version is the newest one published at least two weeks earlier (`npm … --before=2026-10-03T23:59:59Z`), as for Zod in P-02.
  - **Part 1, the backend's non-breaking fixes:** `npm audit fix` updated the lockfile: TypeORM 0.3.31, `@nestjs/common` 10.4.22, `proxy-addr` 2.0.8, `sha.js` 2.4.12, `validator` 13.15.35. `package.json` now asks for TypeORM 0.3.31 or newer. The production audit went from 3 critical and 11 high to **0 critical and 4 high**. The rest needs the major upgrades: `qs` comes with Express 5, and `file-type` with `@nestjs/common` 12.
  - **Part 2, NestJS 11.2.7, not 12.**
    - Why not 12: NestJS 12's packages are ESM-only, and Jest loads them only on Node.js 24.9 or newer. Its CLI also wants Node.js 24.15 or newer and TypeScript 6. This machine runs Node.js 24.4.0.
    - Why 11.2.7 is enough: it is maintained alongside 12 (both released on 2026-09-30) and ships the same fixed Express 5.2.1, `multer`, `path-to-regexp`, `body-parser` and `qs`, so it closes the same findings. Its `@nestjs/common` brings `file-type` 21.3.4, which is fixed too.
    - The move to 12 is now part of P-64, once every machine that runs the backend or its tests has Node.js 24.15 or newer (§9).
    - With it: `@nestjs/swagger` 11.4.7, `@nestjs/config` 4.0.4, `@nestjs/typeorm` 11.0.3, `@nestjs/cli` 11.0.24, `reflect-metadata` 0.2.2, and `@types/express` 5.
    - Code changes: `@nestjs/swagger` 11's types want `additionalProperties` on a free-form object. So `metadata` and `input` are now documented as any JSON object, and `input` as optional, as the API already accepted it. `@nestjs/config` 4 reads the loaded values before `process.env`; FF only reads lowercase, nested keys, which no variable shadows.
    - The production audit: **0 critical, 0 high, 6 moderate.** Five are minio's (part 3). The sixth is `js-yaml` in `@nestjs/swagger`, which only writes the document as YAML; it never parses input.
  - **Part 3, the AWS SDK's S3 client instead of minio.**
    - Why: minio 8.0.7, the latest release (February 2026), still had moderate findings that it can't fix without a new release: `stream-json` (prototype pollution, quadratic parsing) and `decode-uri-component` through `query-string`. So, as this task planned, the backend now uses `@aws-sdk/client-s3` 3.1146.0. It adds 26 packages, and its audit is clean.
    - The client puts the bucket in the path (`forcePathStyle`), as an S3-compatible store needs on a host name. It sends checksums only where S3 requires them, because not every S3-compatible store accepts the SDK's default ones.
    - When the bucket check fails, the log now carries the HTTP status. An answer to `HEAD` has no body, so a wrong key would otherwise only say "UnknownError".
    - Nothing else changes: `MinioClientService` and the `MINIO_*` variables keep their names. `onModuleDestroy` closes the client's connections.
    - New L1 suite, on a local fake S3 server: the bucket is created only when it is missing; startup goes on when the storage is unreachable or refuses; uploads go to `/functions/<path>`, signed, without the extra checksums; deletes; a refused upload fails the caller. Each of these settings, turned back to the SDK's default, fails a test.
    - `hack/e2e.sh` reads the archive through SeaweedFS's filer: after create (the code), after update (the new code), and after delete (gone). It passed on minio 7 first, then on the new client.
    - **Accepted** (2026-10-17): `js-yaml` 5.3.0 inside `@nestjs/swagger` (GHSA-r3ph-w7gj-g6xm, moderate). The advisory is about CPU use when *parsing* YAML merge keys. Swagger only *writes* the backend's own document as YAML, at `/api-yaml`, and production turns Swagger off (P-60). NestJS 12 removes it (P-64).
  - **Part 4, the backend's linter.**
    - The tools: ESLint 10.12.0, rather than 9, whose last release was in July. With it, `typescript-eslint` 8.71.0 (the recommended rules, with type information), `@eslint/js` and `globals`, in a flat configuration (`BE/eslint.config.mjs`). `npm run lint` checks `src/` and `scripts/`.
    - What it leaves out: in tests, the rules on unchecked `any` values, unbound methods and `async` without `await`, which test doubles break by design. It doesn't check formatting either: the backend has no Prettier configuration, and Prettier's defaults would rewrite 65 files. The ESLint 8 packages and the Prettier plugins are gone.
    - The first run: 218 findings, 171 in tests and 47 in production code, and no promise left unawaited in production code. The 47 are fixed. They showed four problems:
      - **Error logs that lost their reason.** The console format read a `trace` field, which nest-winston never sets (it passes `stack`), so stack traces never printed. The metrics service passed its errors as a second argument, which nest-winston files as a stack, so they printed nowhere; the JSON log files got `{}`. Now the console prints stacks, and the metrics service writes the reason into the message.
      - **Errors without a message of their own.** A refused connection to every address of a host name is an `AggregateError` with an empty message. The invocation's error, the function's error and the 400 answer would have been empty. They use `describeError` now.
      - **A token subject that isn't a string** would have become the tenant `"[object Object]"`. It is refused now.
      - **Unchecked JSON:** JSON fields are `unknown` rather than `any` (an invocation's `output` is any JSON value), and the runtime's error body and Kubernetes' `Status` are checked before use. Also, `recordMetric` is synchronous, and routes that need a tenant but don't use it yet call it `_userId`.
  - **Part 5, the console and the runtime.**
    - The console's `dependencies` now list exactly what ships in the bundle. axios, React Router and Redux were filed as dev dependencies, so the production audit skipped them, although axios had an SSRF and credential-leak finding and React Router an XSS one. The Tailwind plugins, which are build tools, went the other way. `@headlessui/react` and `@heroicons/react` were never imported, so they are gone.
    - `npm audit fix`: axios 1.20.0 and React Router 7.18.4, with fixes in Vite, PostCSS, Rollup and others. Vitest 3.2.7 to 5.0.3: its pool (`tinypool`) and mocker had two critical findings. npm installed it this time; in P-05 it crashed on Vitest 4.
    - The console's audit is **clean, dev tools included.** The Node.js runtime's is clean too; it only depends on the TypeScript compiler.
    - The backend's dev tools: Jest 29 to 30.5.2, which removes 29 high findings in its file-matching libraries. ts-jest 29.4.14 supports it, and the test-path filters of `test:it` and `test:db` still work.
    - **Open, dev only:** `handlebars` 4.7.9, which ts-jest pulls in, has a critical finding about compiling untrusted templates. ts-jest only compiles its own. The fix, 4.7.10, was published on 2026-10-05, inside the two-week window; it is taken with P-11's dependency change. Also 21 moderate findings in the dev tools: the old `js-yaml` of Jest's coverage tools, and `@nestjs/swagger`'s.
  - **Done when, checked:** `npm audit --omit=dev` finds no critical or high in the backend (2 moderate, one accepted finding), the console (none) or the runtime (none).

### Phase 1: accounts and isolation

#### P-10: Principal and account-scoped services
- **Principal:** `@Principal()` replaces `@User()`. In development mode it comes from `FF_DEV_ACCOUNT_ID`, or from `X-FF-Dev-Account`.
- **Scoping:**
  - every `FunctionsService` method takes the account ID, and every query includes it;
  - update and delete answer 404, not 401;
  - get, invoke, history and scaling configuration are scoped;
  - the metrics route is scoped until P-50 replaces it;
  - `limit` is capped at 100, and `offset` must be at least 0.
- **Generic platform errors** (D4).
- **Tests:** L1 for every method, called with another account's ID; L5, first version, with two development accounts.
- **Done when:** the L5 suite passes for every current route. This closes parent C-3 before any login exists.
- **As built** (2026-10-17):
  - **The principal:** `BE/src/auth/principal.ts` holds `Principal`, both the type and the decorator. It uses `request.principal` when there is one; P-11's guard sets it. In development mode, without one, the caller is the owner of `FF_DEV_ACCOUNT_ID`, or of the account an `X-FF-Dev-Account` header names (12 digits, else 400). Otherwise the caller gets 401.
  - **Scoping:** every `FunctionsService` method takes the account first, and its queries include it (`userId` until P-12 renames it). The history query carries the account itself, through the function relation, not only in the check before it. Controllers no longer check ownership; another account's function answers `Function with ID … not found`, the same 404 as a missing one. Function IDs must be UUIDs (400 otherwise; PostgreSQL used to answer 500). The metrics route checks the account and validates `start` and `end`; the history's `limit` is 1 to 100 and `offset` at least 0.
  - **Errors (D4):**
    - Every answer carries `x-ff-request-id`. A global interceptor gives each request its ID, and the code serving it can read it through `AsyncLocalStorage`.
    - A global filter adds the ID to every error answer. Any error that isn't an `HttpException` becomes 500 `Internal error. Request ID: …`, with the details only in the log.
    - The service decides what the caller sees (`BE/src/functions/failures.ts`). The function's own errors are shown as they are. Platform failures become `<action> failed because of an internal error (request …).`, in the function's or the invocation's record too, so the history never shows namespace names or Kubernetes errors.
    - The function's own errors include a new `FunctionLoadError`. The driver now reads the runtime's `function initialization failed` log line, so a failed load says `The function failed to load: Runtime.ImportModuleError: Error: boom at init` instead of the raw log lines.
    - The runtime's 429 is now a `FunctionThrottledError`, answered with 429 and `TooManyRequestsException: Rate exceeded: …`. It was a generic platform error, and P-15 records it as `throttled`.
  - **L5:**
    - `hack/e2e-tenancy.sh` reads the OpenAPI document and calls every route as account B on account A's function. Each must answer the same 404 as a missing function, and A's function, history and limits must not change. B's list doesn't show A's function, and the function B creates is B's alone.
    - It then calls every route on a second backend in OIDC mode, which has no principal until P-11, and expects 401 everywhere, even with the development header.
    - A route without a rule fails the suite.
    - The stack it shares with `hack/e2e.sh` is now `hack/lib/e2e-stack.sh`.
  - Removed: `@User()` and its file. Its test of a non-string `sub` moves to P-11's guard.

#### P-11: Keycloak and the global guard
- **Development stack:** Keycloak and Mailpit in docker-compose, with the `ff` realm imported from `deploy/keycloak/ff-realm.json`:
  - clients `ff-console` (public, PKCE), `ff-cli` (device flow), and `ff-e2e` (password grant, development realm only);
  - an audience mapper for the API;
  - self-registration and e-mail verification on.
- **Backend:**
  - the global `APP_GUARD` and `@Public()`;
  - token checks with `jose` (D2), with the realm's keys cached and refreshed when a token names an unknown key;
  - only asymmetric algorithms accepted.
- **Dependencies:** with `jose`, take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, which is old enough from 2026-10-19. *(P-11 ran on 2026-10-17, so this moved to P-12.)*
- **The principal:** the guard sets `request.principal` (P-10's `Principal`), which `@Principal()` already reads. A token whose subject isn't a non-empty string is refused: P-09 found that the old decorator would have made such a subject the tenant `"[object Object]"`. The L5 suite's anonymous half then runs against the guard instead of OIDC mode without one.
- **Tests:**
  - L1 with locally signed tokens: valid, expired, wrong issuer, wrong audience, unverified e-mail, `alg: none`, a wrong key;
  - L4: log in as two users through `ff-e2e`, and anonymous calls get 401.
- **As built** (2026-10-17):
  - **The development stack:**
    - `docker compose --profile auth` adds Keycloak 26.7.5 (`start-dev`, admin `admin`/`admin`, port 8180, about 600 MB) and Mailpit 1.31.4 (SMTP 51025, web UI 58025). Your other project's Mailpit holds 1025/8025.
    - `KC_HOSTNAME` fixes the issuer at `http://localhost:8180/realms/ff`, whichever address a client used.
    - The realm, `deploy/keycloak/ff-realm.json`, is the development realm, as this task says. It has `ff-console` (PKCE, `http://localhost:5173`; 5199 since P-14), `ff-cli` (device flow) and `ff-e2e` (password grant), each with an `ff-api` audience mapper; self-registration, verified e-mail, and SMTP to Mailpit. Keycloak's default client scopes are kept, so tokens carry `sub`, `email` and `email_verified`.
    - Keycloak's data persists in a volume at `/opt/keycloak/data`. A volume at `…/data/h2` came out owned by root, and Keycloak, which runs as uid 1000, couldn't start.
  - **The guard:**
    - `AuthGuard` is the global `APP_GUARD`. A `@Public()` route passes, and development mode passes everything to `@Principal()`, as in P-10. Otherwise it needs `Authorization: Bearer`; a key in the `ffk_` format gets 401 until P-13.
    - `TokenVerifier` finds the realm's keys through OpenID discovery, which must name the same issuer, and caches them with `jose`'s `createRemoteJWKSet`. A key the backend lacks is fetched again once a 30 s cooldown has passed. So forged key IDs can't make it hammer the realm, and a rotated key is picked up within 30 s at the latest.
    - It accepts asymmetric algorithms only, and checks the issuer, the `ff-api` audience, `exp` and `nbf` with 30 s of skew, a string subject, and `email_verified`.
    - An invalid token is a 401 that says why, for example `The token has expired`, with `WWW-Authenticate: Bearer realm="ff"`. An unverified e-mail is a 403. Keys that can't be read are a platform failure, so the answer is a generic 500, not a 401.
  - **The principal:** the guard records the token's user as `request.identity`, and `@Principal()` answers such a user with 403 `This user has no account yet` until P-12 gives users accounts.
  - **`GET /healthz`:** the first `@Public()` route, for probes (P-60). It was `/health` in P-11's commit and was renamed right after, to the name §5 plans for P-53, which adds `/readyz`.
  - **`jose` 6.2.12:** it is ESM only. Node 24 loads it with `require(esm)`, but Jest on this Node (24.4) can't. So Jest passes `jose` through Babel's CommonJS module transform alone (`@babel/plugin-transform-modules-commonjs`). Compiling it with ts-jest moved `jose`'s class fields before `super()`, and every token error became a `ReferenceError`.
  - **`handlebars` 4.7.10** was still inside the two-week window on 2026-10-17: it moves to P-12.
  - **L4/L5:** the L4 item runs in `hack/e2e-tenancy.sh`, which now starts Keycloak. Through the guard, anonymous calls get 401 on every route but `GET /healthz`. Two users made through Keycloak's admin API log in through `ff-e2e`, and get 403 `This user has no account yet` on every account route. A tampered token and an `admin-cli` token, which has no `ff-api` audience, get 401.

#### P-12: Accounts, users and sign-up
- **Tables:** `plans`, `accounts`, `users`, `memberships` (§4).
- **Rename the tenancy key** to `accountId` in the entities, the orchestrator's `FunctionWorkload`, the namespace naming, and the `ff.dev/tenant-id` annotation.
- **Sign-up flow:**
  - the user record is created on the first authenticated call;
  - `POST /accounts` creates the account, with the caller as owner;
  - `GET /me`.
- **Beta approval:** the account is `pending` until you approve it in the admin dashboard (P-71). A pending account can't deploy or invoke. Sign-up also asks what the customer plans to build, for your review. You get an e-mail for each new sign-up, with a link to the approvals queue.
- **The principal** (left by P-11): `resolvePrincipal` turns `request.identity` into an account through the user's memberships and `X-FF-Account` (D4), instead of answering 403 `This user has no account yet`. The L5 suite's token half then acts as accounts, and its 403 checks become isolation checks between two real accounts.
- **Dependencies:** take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19. *(P-12 also ran on 2026-10-17: moved to P-13.)*
- **Tests:** L1 for the flows and role checks; L2 for the migration; L4 from registration (Mailpit) to a pending account that can't deploy. P-71's test continues from there.
- **As built** (2026-10-17):
  - **The tables:**
    - `plans` (with `beta`, whose limits P-15 fills), `accounts`, `users` and `memberships`, as in §4. Accounts carry `use_case`, the "what you plan to build" that the beta asks for.
    - `functions.user_id` became `account_id char(12)`, a foreign key to `accounts`. The migration was written by hand on TypeORM's generated SQL, because the generated one dropped the column.
    - It makes each existing tenant an active account, so its functions keep working. It stops, changing nothing, at a tenant that isn't a 12-digit ID, from before 2026-10-17.
  - **The tenancy key is `accountId` everywhere:** the entities and the API's JSON, `FunctionWorkload`, `accountHash()`, `accountNamespace()`, and the namespace's `ff.dev/account-hash` label and `ff.dev/account-id` annotation. The `ff-t-` prefix and the hash are unchanged.
  - **The guard resolves the principal**, because a parameter decorator can't wait for the database:
    - **A token's user:** found, or created on the first call (two first calls at once still make one user). The account is the user's only one, or the one `X-FF-Account` names. Otherwise `@Principal()` answers 403 to a user without an account (`create one with POST /accounts`), 400 for one with several and no header, and 404 for an account the user isn't a member of.
    - **Development mode:** the account is `FF_DEV_ACCOUNT_ID`, or the one `X-FF-Dev-Account` names, created active the first time it is used.
  - **Route rules** (`@RequireRole`, `@RequireActiveAccount`): creating, updating, invoking and changing a function's limits need the owner or developer role and an active account. Deleting needs the role only, so an account that isn't active can still free what it holds. Reading is open to every member. A refusal says why, for example `Your account is waiting for approval: you can deploy and invoke functions once it is approved`.
  - **Sign-up:**
    - `GET /me`, `POST /accounts` (pending, with the caller as owner), `GET` and `PATCH /accounts/:id`. Members see the account; only the owner changes it; anyone else gets 404.
    - Each user may have one account waiting for approval at a time, so a spammer can't fill your inbox.
    - Each new account sends you an e-mail (`FF_OPERATOR_EMAIL`) with who signed up, what for, and a link to the approvals queue (`FF_ADMIN_URL`). It goes through `nodemailer` 10 (`FF_SMTP_URL`); without SMTP it is logged. Production requires both settings.
    - In development mode, the account routes answer 400: there is no user.
  - **L4, in `hack/e2e-tenancy.sh`:** sign-up as a person does it, with curl. Keycloak 26.7's registration form asks only for the e-mail address and names; the verification e-mail comes through Mailpit's API; its single-use link leads to setting a password. Two details mattered: the e-mail's lines end in `\r`, and the link works once.
  - **Approvals:** until P-71's admin routes exist, accounts are approved in SQL.

#### P-13: API keys

#### P-13: API keys
- D3: create, list, revoke, scopes, expiry, `last_used_at`. Comparisons run in constant time.
- **The guard** (P-11, P-12) answers keys in the `ffk_` format with 401 for now. P-13 resolves a key to a principal with its account, the creator's current role, and its scopes, in place of that refusal.
- **Dependencies:** take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19. *(P-13 also ran on 2026-10-17: moved to P-15, which adds a backend dependency anyway.)*
- **Tests:** L1 for parsing, hashing and scope checks; L4 for invoking with a key, and 401 after revocation; L5 for keys of account B used on account A.
- **Docs:** the getting-started guide's `curl` section uses a key.
- **As built** (2026-10-17):
  - **The table:** `api_keys`, as in §4, with `created_at`. A key goes with its account (cascade); its creator stays. Only the SHA-256 of the secret is kept, compared in constant time.
  - **Keys:** `ffk_<12 hex>_<43 base64url>`, from 6 and 32 random bytes; the whole key is in `POST /api-keys`' answer only.
  - **Routes:** `GET`, `POST` and `DELETE /api-keys` are the owners', with a user's token (D4's table). Development mode, which has no user, answers 400.
  - **At most 20 working keys** per account; revoked and expired ones don't count. `expiresAt` must be in the future.
  - **Every request checks the key**, in order:
    1. the secret;
    2. revocation and expiry;
    3. that its creator is still a member, whose current role becomes the key's.
    So a key stops at once when it is revoked, when it expires, or when its creator leaves, and does less at once when its creator is demoted.
    A wrong secret, an unknown key and a malformed one all get the same 401, `The API key is invalid`. Only a key whose secret matched learns that it was revoked or expired.
  - **`last_used_at`** is written at most once a minute per key, without holding up the request.
  - **Scopes:** every function route names the scope a key needs (`functions:read`, `functions:write`, `functions:invoke`), and so does the metrics route (`metrics:read`). A route without one, such as the accounts and keys routes, refuses keys, so a new route is closed to keys until it names a scope. A missing scope is a 403 that names it.
  - **Keys work in OIDC mode only:** development mode reads no `Authorization` header.

#### P-14: Console login and account pages (parent F-10, in part)
- **API URL:** `VITE_API_URL` replaces the hard-coded `localhost`.
- **Login:** `react-oidc-context` with PKCE, a sign-up link, logout, and token renewal.
- **Pages:**
  - onboarding (create the account);
  - "waiting for approval";
  - account settings;
  - API keys.
- **The console's broken calls** (parent H-11) are fixed first, in P-05.
- **Layout,** seen in P-05's check: the whole console renders in a narrow column at any window width, and the primary button's text is barely readable.
- **Redirect URIs:** the development realm's `ff-console` allows only `http://localhost:5173` (P-11). Add the port the console really uses, or a variable for it.
- **The API is ready** (P-12): `GET /me` for the user and their accounts, `POST /accounts` for onboarding, the account's status for the "waiting for approval" page, and `X-FF-Account` for an account switcher.
- **Tests:** L0 (`npm run build`); a manual check of the full flow, recorded in the progress log.
- **As built** (2026-10-17):
  - **Settings** (`FE/.env.example`): `VITE_API_URL`, `VITE_OIDC_AUTHORITY` and `VITE_OIDC_CLIENT_ID`. An empty authority is development mode: no login, and the console acts as the backend's development account, as before.
  - **The console's port is fixed at 5199** (`strictPort`), the port P-05's check already used. Vite's 5173 is where most other Vite apps run, and a console that drifted to another port would fail both its login (the realm's redirect URIs) and every call (CORS). The development realm, the backend's development CORS default and `BE/.env.example` follow. `FE/src/contract.test.ts` reads the realm file, the Vite config and the backend's files, and fails when they disagree.
  - **Login:** `oidc-client-ts` with `react-oidc-context`: the code flow with PKCE, and tokens in the tab's session storage.
    - "Sign up" sends `prompt=create`, which opens Keycloak 26.7's registration form.
    - The access token is renewed with the refresh token a minute before it expires. A request about to leave with an expiring token waits for a renewal, one for all the requests of that moment.
    - A 401 from the API ends the session: the console forgets the user, and the login page gives the API's reason.
    - "Log out" ends the Keycloak session, and comes back through `/logged-out`. A deep link comes back to its page after login.
  - **The account:** the console reads `GET /me`, acts for the account chosen last in this browser (else the first active one), and sends `X-FF-Account` on every request. Switching accounts reloads the page, so no list, page or request of the other account survives. The pages:
    - onboarding, which creates the account;
    - "waiting for approval", with "Check again";
    - "not approved";
    - for a suspended or closed account, a banner over its functions, which it can still read and delete, as the API allows;
    - account settings, where owners rename the account and set its tax ID; only the changed fields are sent;
    - API keys, for owners: name, scopes and expiry, the key shown once, the list by prefix, and revoking.
  - **The backend's CORS** (`BE/src/cors.ts`) now allows `X-FF-Account` and `X-FF-Dev-Account`, and exposes `x-ff-request-id`. Without it, the browser's preflight refused every request that named an account.
  - **The layout's causes:**
    - the narrow column was `body { display: flex; align-items: center }` in `index.css`;
    - `.btn`, `.btn-primary`, `.btn-secondary`, `.card` and `.input` never had any style. They were in `src/styles/main.scss`, which Tailwind never processed, so the bundle shipped raw `@apply` lines that browsers drop. The primary button only had the global `button` rule: white text on light grey;
    - that global rule, unlayered, would have beaten the component classes anyway.

    The page's defaults now sit in Tailwind's base layer, and the classes in its components layer, both in `index.css`. `main.scss` and Sass are gone. The CSS bundle fell from 52.8 kB to 34.0 kB, because `main.scss` had included Tailwind a second time.
  - **Development mode** still has no login. The account and API key pages say why they can't change anything there.
  - **An existing development Keycloak keeps its old realm.** Keycloak imports the realm file only at its first start, so a Keycloak volume from before this task still allows only port 5173. Getting started says how to reset it: `docker compose --profile auth down -v keycloak`.
  - **Fixed in the docs:** getting started said that `docker compose --profile auth down -v` resets Keycloak. A dry run shows that it also deletes the PostgreSQL and S3 volumes; naming the service removes Keycloak's volume alone.

#### P-15: Plans, quotas and rate limits
- **Plans** as data (D5), assigned per account. One `beta` plan to start, with today's limits:
  - 25 functions, each up to 1,024 MB and 300 s (the current validation limits);
  - the current quota of 20 pods, 8 CPU and 8 GiB;
  - 14 days of logs and 30 days of history;
  - a 15-minute idle window, and no internet egress.

  You change any value in the admin dashboard (P-73).
- **`ensureTenant`** writes the account's plan quota. A plan change rewrites it in the account's namespace.
- **Function limits** (count, memory, timeout) are checked on create and update, with messages that name the plan's limit.
- **Dependencies:** with `@nestjs/throttler`, take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **`@nestjs/throttler`** per account, with separate limits for control-plane writes and invokes. A runtime's 429 is already answered as `429 TooManyRequestsException` (P-10); P-15 records it as `throttled`.
- **Tests:** L1 for limits and the 429 mapping; L3 for the plan quota on a namespace; L4 for exceeding a rate limit.
- **As built** (2026-10-17):
  - **Plans as data:** `plans.limits` holds eleven limits, checked with a schema before use (`BE/src/plans/plan-limits.ts`). A plan that lacks one, or has a wrong one, fails its accounts' requests (500), and the log names the plan and the limit. The migration `PlanLimits` gives `beta` the values above, with 60 changes a minute and 100 invocations a second. `PlansService` reads a plan at most once a minute.
  - **Two levels of limits:** the DTOs check what any function may be (128–10,240 MB, 1–900 s, 100 instances). The plan then sets lower limits, and a refusal names it, as in `memory must be at most 1024 MB on the Beta plan`. Only values that change are checked, so a function keeps what an older, larger plan gave it.
  - **The function count** is checked in a transaction that locks the account's row (`FOR NO KEY UPDATE`), so two creates at once can't both take the last place. The L2 test slows each insert by 200 ms with a trigger; without the lock, all three creates pass.
  - **The quota comes from the plan.** `deploy` and `update` take the account's limits as a required argument, so no call can forget them, and write the quota on every deploy and update. `PlansService.assign` moves an account to another plan and applies its quota at once, for P-71's route. A plan change made in SQL reaches the namespace at the account's next deploy or update.
  - **The idle window** is the plan's `idleSeconds`; the sweep reads every candidate's plan in one query.
  - **Retired settings:** `FF_SCALE_TO_ZERO_IDLE_SECONDS` and `K8S_TENANT_QUOTA_*`. As for `FF_DEV_USER_ID`, the backend refuses to start while they are set, and says what replaced them.
  - **Rate limits** (`BE/src/plans/rate-limits.ts`): `@nestjs/throttler` 6.7.1, as a second global guard, after the AuthGuard, so a request counts against the account the AuthGuard found.
    - Two windows: changes (POST, PUT, PATCH and DELETE) per minute, and invocations (the routes marked `@Invocation()`) per second. Reads aren't limited.
    - One count per account across every route; the throttler counts per route by default. A user without an account yet is counted alone, a caller without a login by address.
    - Beyond: 429 `TooManyRequestsException`, with the plan's limit in the message and `Retry-After` in seconds.
    - The counts are in memory, which suits one backend replica (D5).
  - **`THROTTLED`:** an invocation the runtime refused (429) is now recorded `THROTTLED`, a new status, which D7 doesn't bill. The migration adds it; reverting it turns such rows into `ERROR`.
  - **`GET /me`** gives each account's plan and limits. The console's create, edit and scaling forms take their maximums from it, and the account page lists the limits.
  - **Stored, applied later:** `historyRetentionDays` (P-45), `logRetentionDays` (P-43) and `internetEgress` (P-62).
  - **handlebars 4.7.10** isn't two weeks old until 2026-10-19, so it moves to P-16.

#### P-16: Members and invitations
- An owner invites a member by e-mail with a role. The invitation is accepted at the next login with that e-mail, and expires after 7 days.
- Owners change roles and remove members. The last owner can't be removed.
- **Dependencies** (moved from P-15): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **The console** (from P-14): a members page for owners, and pages that hide what the user's role can't do. P-14 shows the API keys page and the account's edit form to owners only; for function writes, a viewer sees the API's 403 message.
- **Tests:** L1 for the rules; L4 for an invite accepted by a second user. This task can slip until after the beta starts.
- **As built** (2026-10-17):
  - **Routes:** `GET /members` (the members, and the invitations not accepted yet), `POST /members` (invite, or renew an open invitation with the new role), `PATCH /members/:userId` (a role), `DELETE /members/:userId`, and `DELETE /members/invitations/:id`. Owners only, with a user's token: no route names a scope, so API keys can't call them, and development mode, which has no users, refuses them with 400.
  - **Joining at the next call, without a token.** §5 planned `POST /invites/:token/accept`. Instead, the global guard lets each token's user join the accounts that invited its address, before it chooses the account. Keycloak has verified the address (P-11), so a token in the e-mail would prove nothing more, and there is no link to leak. It costs one indexed query per request.
  - **Invitations** (the `invitations` table) hold the address in lowercase, the role, who sent it, and seven days. An account has one open invitation per address, through a partial unique index: inviting again renews it, even when two invitations cross. At most 50 are open per account, since each sends an e-mail. Accepted ones stay, for the record and for P-17.
  - **The e-mail** links to the console: `FF_CONSOLE_URL`, a new setting that production refuses to leave at its development default.
  - **An account keeps an owner.** Changing or removing a member locks the account's row, as P-15's function count does, so two owners can't demote each other at once; the L2 test proves it with a slowed update. An owner may leave while another owner stays.
  - **A removed member's API keys stop at once,** through P-13's check of the key's creator. A member invited again keeps their role; the invitation is only marked accepted.
  - **The console** has "Members" for owners, and shows each role only what it may do: a viewer gets no control to create, delete, edit or invoke a function, or to change its scaling.
  - **handlebars 4.7.10** moves on to P-17: it is two weeks old from 2026-10-19.

#### P-17: Audit log
- **Recorded:** creating, updating and deleting functions; key and member changes; plan, credit and status changes; every `/admin` call. Each row has the actor (user or key) and the source IP.
- **Readable by owners** through `GET /audit-log`. Append-only, with the same trigger as `usage_records`.
- **Dependencies** (moved from P-15 and P-16): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **Members** (from P-16): record invitations sent, renewed, cancelled and accepted, role changes and removals. The `invitations` table already keeps who invited whom, and when each was accepted.
- **Tests:** L1, and L2 for the trigger.
- **As built** (2026-10-17):
  - **The table** `audit_log`, as §4 sketched it, plus `actor_label` (the user's e-mail, or the key's name, as they were then), `ip` and `request_id`, and no foreign key, so an entry outlives what it describes. A trigger function, `ff_refuse_change()`, refuses `UPDATE`, `DELETE` and `TRUNCATE`, even for the database's owner; P-20's `usage_records` reuses it.
  - **Recorded where the change is made,** in the services rather than around the routes: a function whose deploy fails still has the record of its creation. A function's creation, an account's creation, and role changes and removals are written in the same transaction as the change; the others right after it, and a record that can't be written is logged as an error, while the change stands.
  - **Recorded so far:** `account.create`, `account.update` (the changed fields, before and after), `account.plan` (from `PlansService.assign`), `function.create`, `function.update` (the changed fields and their new values, never the code; for a failed update, whether it was kept), `function.delete`, `function.scaling`, `api_key.create`, `api_key.revoke`, `member.invite` (sent or renewed), `member.invitation_cancel`, `member.join`, `member.role` and `member.remove`. Credit, status and `/admin` actions come with their tasks.
  - **The actor** comes from the request: `user:<id>` with the e-mail, `key:<id>` with the key's name (an API key acts, not its creator), `dev` in development mode, and `system` outside a request. The request interceptor, which runs after the guards, puts the caller and address in the request context; a join happens in the guard, before that context exists, so the guard passes the joining user, the address and the request's ID itself.
  - **`GET /audit-log`:** owners, with a user's token (no scope, so no key), newest first, `limit` up to 100, and a cursor: `next`, given back as `before`.
  - **The console** doesn't show it yet.
  - **handlebars 4.7.10** moves on to P-20: it is two weeks old from 2026-10-19.

### Phase 2: metering

#### P-20: Usage records
- **Table, trigger and monthly partitions** (§4, D6). A job creates the next month's partition ahead of time. The trigger function `ff_refuse_change()` exists since P-17.
- **Dependencies** (moved from P-15 to P-17): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19. Moved on to P-21.
- **Invoke path:**
  - send `X-FF-Request-Id` with the invocation ID;
  - read the duration and memory headers on errors too: `FunctionRuntimeError` carries them;
  - map 429 to `throttled` (the invocation is already `THROTTLED` since P-15), and orchestrator failures to `platform_error`;
  - record `init_ms` when the call had to scale from zero;
  - write the invocation's final state and the usage record in one transaction.
- **The `lost` reaper** (D6).
- **Tests:**
  - L1 for D7's table, one case per row;
  - L2: deleting a function keeps its records; changing memory doesn't change past records; `UPDATE` and `DELETE` are refused; a duplicate request ID is a no-op;
  - L4: kill the backend during a slow call; after the restart, the row is `lost` and bills nothing.
- **As built** (2026-10-17):
  - **The table** `usage_records`, as §4 sketched it, partitioned by month on `started_at`. `ff_ensure_usage_partition(month)` creates a month's partition with UTC bounds, whatever the session's time zone. The migration creates this month's and the next; the backend creates the current month's and the next two at startup, before it takes calls, and then daily.
  - **Append-only:** P-17's `ff_refuse_change()` refuses `UPDATE`, `DELETE` and `TRUNCATE`, even to the database's owner. Row triggers reach the partitions, but the table's `TRUNCATE` trigger doesn't reach a partition emptied on its own, so each partition gets its own. Detaching or dropping a partition stays possible: that is how a month is archived after its retention (P-45).
  - **The invoke path:**
    - the invocation's ID goes to the runtime as `X-FF-Request-Id`, in proxy and direct mode, so the handler's `context.awsRequestId`, the runtime's `START`, `END` and `REPORT` lines, the history and the record share one ID;
    - the runtime's duration and memory headers are read on every answer, failed ones too, and the history shows them; a measure of `0.00` counts as one;
    - `init_ms` is the time spent scaling from zero and waiting for an instance, kept even when the cold start fails. Without the runtime's measure, the duration is the backend's end-to-end time without the cold start;
    - the statuses: `success`; `error` (it threw, crashed or ran out of memory); `timeout` (in the runtime, or no answer within the backend's wait); `throttled` (the runtime's 429); `platform_error` for anything else, including a cold start that fails on the function's own load error, since D7 doesn't bill cold starts;
    - `finish()` locks the invocation (`SELECT … FOR UPDATE`), saves its final state and writes the record in one transaction. A call the reaper already marked stays `LOST`. A call whose function was deleted while it ran has no history left, but its record is written: it ran.
  - **The record's times** are the invocation's `created_at` and `updated_at` to the millisecond, as JavaScript reads them; PostgreSQL keeps microseconds. Every writer takes `started_at` the same way, so the key (`request_id`, `started_at`) makes a second write a no-op.
  - **The lost-call reaper** (D6), at startup and every minute: invocations `RUNNING` past two timeouts, the cold-start limit (`K8S_READY_TIMEOUT_SECONDS`) and 30 s become `LOST`, with a record that bills nothing. A function changed since the call started gets the platform's longest timeout, 900 s, as its timeout then is no longer known. The times compared are the database's, never the backend's clock. Each call is marked in its own transaction, and only while it is still `RUNNING`, so a call that ended meanwhile keeps its outcome.
  - **Not recorded:** requests refused before an invocation exists (the rate limits' 429 from P-15, a function that isn't `ACTIVE`, another account's function). They are not invocations, and bill nothing.
  - **The console** shows `THROTTLED` (amber) and `LOST` (grey) in the history; its list of statuses is checked against the backend's.
  - **handlebars 4.7.10** moves on to P-21: it is two weeks old from 2026-10-19.

#### P-21: Capacity samples
- Every minute: one list of FF's Deployments (label `app.kubernetes.io/managed-by=ff-controller`), then one `capacity_samples` row per function with ready replicas, including its `minInstances` (the provisioned time of D8).
- An operator report: reserved GB-s against billed GB-s, per account and day. It is the input for D8.
- **Dependencies** (moved from P-15 to P-20): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19. Moved on to P-22.
- **Tests:** L1 against the fake Kubernetes API; L3 for a function at 0, 1 and 2 replicas.
- **As built** (2026-10-17):
  - **The sampler** runs 5 s into every minute, scheduled minute by minute, so a sample that runs late skips a minute rather than doubling one. It makes one list of FF's Deployments across the cluster (label `app.kubernetes.io/managed-by=ff-controller`; only those in `ff-t-*` namespaces count, since a label is easy to copy), then one `INSERT … SELECT` that joins the ready counts with `functions` for each one's account, `min_instances` and memory. A function the database doesn't know is skipped. The minute is the database's, and a minute sampled twice, say by two backends, keeps its first row.
  - **Instances** are the Deployment's `readyReplicas`: a pod still starting isn't counted, and a function without a ready instance has no row that minute.
  - **The table** `capacity_samples`, as §4 sketched it, partitioned by month and append-only like `usage_records`, since D8 bills provisioned time from it, with no foreign key. One SQL function, `ff_ensure_month_partition(table, month)`, now creates both tables' months, each with its own `TRUNCATE` trigger; it replaces P-20's `ff_ensure_usage_partition`, which the migration's `down()` puts back.
  - **The operator report,** `npm run capacity:report -- --days N` in `BE/`: per account and UTC day, the GB-s reserved (ready instances × memory × 60 s per sample), provisioned (`minInstances` × memory × 60 s per sample), billed (billed duration × memory, from `usage_records`), the requests billed, and reserved ÷ billed. It only reads. `capacityReport()` in `BE/src/usage/capacity-report.ts` is what P-75's overview can call.
  - **Permissions:** listing Deployments across namespaces was already granted (the cluster-wide reads of P-07); `hack/k8s/test-rbac.sh` now checks it.
  - **handlebars 4.7.10** moves on to P-22: it is two weeks old from 2026-10-19.

#### P-22: Usage API and console page
- **`GET /usage?month=`:** requests, GB-seconds and billed duration per function, totals, and the estimated cost once prices exist (P-30). CSV export.
- **Console:** a "Usage" page with this month, last month, and the per-function table.
- **Dependencies** (moved from P-15 to P-21): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19. Moved on to P-30.
- **From P-20:** read `usage_records` by `started_at`, a month being a UTC month as the partitions are. Requests billed are `success`, `error` and `timeout` (D7); show `throttled`, `platform_error` and `lost` apart. GB-s is `memory_mb` / 1,024 × `billed_ms` / 1,000. `request_id` is the invocation's ID, so a row can link to the history while the function exists.
- **Tests:** L2: the API's totals equal the sum of the raw records, exactly; L4 for invoke, then usage.
- **As built** (2026-10-17):
  - **`GET /usage?month=YYYY-MM`**, this month without it, by the UTC calendar: per function (its latest name, and whether it was deleted since) and in total, the requests billed, the billed duration, the GB-seconds, and the throttled, failed and lost calls apart, unbilled. Every role reads it, in an account in any state; an API key needs `usage:read`.
  - **Exact:** one query with `GROUPING SETS` gives the functions and the total from the same read, so the totals are the records' own sums. GB-seconds is billed MB-ms over 1,024,000, which always has a finite decimal form; the API gives it as a decimal string, as AWS's Cost Explorer gives its amounts, so no float rounds it.
  - **CSV** with `Accept: text/csv`: a download with a line per function and no total line, which a spreadsheet would count twice; quoted per RFC 4180; a function name that a spreadsheet would run as a formula gets a leading apostrophe, as OWASP advises.
  - **The console's "Usage" page:** this month and last month, the totals, the calls not billed, the per-function table with a link to each function still there, and the CSV. The header's links now wrap on a phone, where the new link made them overflow.
  - **No cost yet:** P-30 adds it, to the API and the page.
  - **handlebars 4.7.10** moves on to P-30: it is two weeks old from 2026-10-19.

### Phase 3: prepaid credit

#### P-30: AWS price book (parent B-11)
- **Data:** `currencies` (TND, exponent 3) and `price_books` with `valid_from`, as data, never as code.
- **The first book** (§4): AWS's current Lambda prices (D8) at the BCT rate of the day, with the source and the rate recorded in it.
- **The rater** supports every SKU in the book: requests, tiered GB-s, provisioned time and provisioned duration, the free tier (not for functions with `minInstances > 0`), and the three knobs at zero.
- **Tests:**
  - L1: a fixture month rated by FF equals the same month computed by hand with AWS's published formula and the book's rate;
  - L1 for each knob set above zero;
  - L2 for a book that changes in the middle of a month.
- **Dependencies** (moved from P-15 to P-22): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **From P-22:** `GET /usage` and the console's Usage page add the estimated cost per function and in total, from the book valid when each call started. `gbSeconds` stays an exact decimal; round money once, to the minor unit.
- **Done when:** the book is loaded, and the usage page shows costs.
- **As built** (2026-10-17):
  - **The data** (migration `PriceBooks`): `currencies` (`TND`, exponent 3) and `price_books` (`currency`, a unique `valid_from`, the document in `prices`, `created_by`, `created_at`), with the first book in §4. A trigger takes only books that start in the future, and refuses to change or delete one that has started, or to empty the table: past usage keeps its prices. P-73's books go through it.
  - **The rates of the day:** AWS's prices re-read from its price list API (published 2026-10-16) equal D8's, the two higher tiers included. The BCT's average interbank rate was 3.0080 TND per US$ on 2026-10-14, the latest it had published by 2026-10-17, against D8's example of 2.9123 on 2026-09-07. Each TND price is the US$ price times that rate, exactly; an L1 test checks every one.
  - **What a call's price depends on** (D6): `usage_records.min_instances`, the function's minInstances when it was invoked, written by every writer (the invoke path and the lost-call reaper). Records from before have 0.
  - **The rater** (`BE/src/billing/rating.ts`, pure, in exact decimals, `Decimal`, on BigInt, with no float and no new dependency):
    - a month splits at each book's start, and each part is priced with its book;
    - the free tier and the duration tiers count the account's on-demand usage from the month's start, through the books;
    - calls on provisioned concurrency get their own duration price, and neither tiers nor free tier;
    - provisioned time is the minInstances that were ready, from the minute samples.
  - **D8's knobs:**
    - the minimum billed duration applies to each call, in the aggregation's SQL;
    - idle time is instance time above minInstances, from the samples, that on-demand calls didn't use;
    - the monthly fee comes from the book valid at the month's start, else from the month's first.
  - **What the estimate shows:** each function's cost is at the first tier's price, before the free tier. The free tier and the higher tiers come off the account's total, as their own lines. Each amount is rounded once, half away from zero, to the currency's minor unit, so the lines may differ from the total by a millime.
  - **`GET /usage`:** each function's `cost` (the CSV has it too), and `estimate`: `usage`, `freeTier`, `volumeTiers`, `monthlyFee`, `total`, `pricedFrom` and `priceBooks`; null for a month that no book covers. A function that cost something without a call, such as minInstances held, gets its own line. The console's Usage page shows the estimated cost, the estimate's lines and a cost column.
  - **Checked against AWS:** AWS's two examples on its pricing page, rated by FF with the first book, equal AWS's formula in US$ times the rate, to every decimal: 8.221880704 TND, and 60.047633152 TND with provisioned concurrency.
  - **Dependencies:** `handlebars` 4.7.10 is still in the two-week window on 2026-10-17: it moves to P-31.

#### P-31: Ledger and wallet (parent B-02)
- **Tables** from Appendix E. A deferred constraint trigger checks that each transaction sums to zero.
- **Accounts:** customer wallet, revenue, VAT payable, stamp duty, payment-provider clearing, and promotional credit.
- **Movements:** credit grants for promotions and corrections, made in the admin dashboard (P-74).
- **Money** is `bigint` from the database to the API, never `number`.
- **Tests:**
  - L1 for the money arithmetic and rounding (half-up to the minor unit, once per debit);
  - L2 for the zero-sum trigger, idempotency keys, and concurrent debits on one wallet.
- **Dependencies** (moved from P-30): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **From P-30:** `currencies` holds TND's exponent; `Decimal` (`BE/src/billing/decimal.ts`) computes exactly and rounds half away from zero, once. A debit is a `Decimal` rounded to the minor unit, then whole millimes as `bigint`.
- **As built** (2026-10-17):
  - **The tables** (migration `Ledger`):
    - `ledger_accounts`: a customer account's wallet, or one of FF's own, whose `account_id` is null. The six types above, checked; a wallet has an account and FF's accounts have none. One wallet per account and currency, and one of each of FF's accounts per currency (two partial unique indexes);
    - `ledger_transactions`: `kind` (Appendix E's eight), a unique `idempotency_key`, `occurred_at` (when what it records happened), `metadata`, `created_at`;
    - `ledger_entries`: `amount_minor`, `bigint`, signed, never 0, added to its account's balance. A wallet's balance is the sum of its entries.
  - **The database's own rules,** whoever writes:
    - a constraint trigger, deferred to the commit, on both entries and transactions: each transaction has two entries at least and sums to zero in each currency. A transaction written without them fails as a whole when it commits; so does an entry added later that unbalances one;
    - P-17's `ff_refuse_change()` on the three tables: nothing is updated, deleted or emptied. A correction is another transaction.
  - **The sign of an entry:** a credit to a wallet is positive. FF's accounts follow the same rule: revenue, VAT payable and stamp duty grow positive (earned, or owed to the state); the provider's clearing and promotional credit grow negative (money a provider holds for FF, credit FF paid for). D9's top-up of 50.000 TND of credit: wallet +50.000, VAT payable +9.500, provider clearing −59.500. A usage debit: wallet −x, revenue +x.
  - **Money** (`BE/src/billing/money.ts`): minor units as `bigint`. `toMinor()` rounds an exact `Decimal` once, half away from zero; `formatMinor()` writes minor units with every decimal of the currency (`"8.222"`, `"-0.250"`), which is how the API gives money, as a string; `parseMinor()` reads an amount as typed, and refuses more decimals than the currency has rather than rounding them.
  - **`LedgerService`** (`BE/src/billing/ledger/`):
    - `post(posting, { floorMinor? })` writes one transaction with its entries. It checks them before the database: two entries at least, each account once, none 0, summing to 0. A ledger account is created with its first entry (`INSERT … ON CONFLICT DO NOTHING`), in one order, so two postings that create the same ones never wait on each other in a circle;
    - the posting's wallets are locked (`FOR UPDATE`, in ID order), so postings on one wallet go one after the other. FF's own accounts aren't locked, so postings on different wallets never wait for each other;
    - idempotent by key: a replay (the same kind, currency and entries) writes nothing and answers with the first posting (`created: false`, its time and metadata kept); the key with other entries is refused with 409 (`IdempotencyKeyConflictException`). The same key posted at the same moment is written once: postings on a wallet wait on its lock, the others on the key's unique index (`ON CONFLICT DO NOTHING`), and the later ones answer as replays;
    - the floor: no wallet the posting lowers may end below it (`BalanceFloorException`, 409, naming the balance), as a refund or a correction against a customer needs. Without a floor a wallet may go below zero: usage that happened is debited whatever the balance (D9);
    - `postIn(manager, …)` writes in the caller's database transaction, for a posting that goes with other writes (P-34, P-36);
    - `balance(accountId, currency)` and `balances(accountId)`; `grantCredit()` for P-74: a promotion (above 0) or a correction (either way), against promotional credit.
  - **The admin account page** (P-71's hand-off): `GET /admin/accounts/:id` gives `balances`, each wallet's, as a string with the currency's decimals. The page's Balance section shows it ("Credit left", or "Owed" below zero), or "No credit or debit yet".
  - **Not in P-31:** parent §8.3's receivables and withholding-tax receivable are not among the types. P-35 adds the withholding-tax receivable, with a migration that widens the type check, when it books withholding; receivables wait for postpaid invoicing. Nothing calls `post()` outside the tests yet: P-32's debits, P-34's top-ups and P-74's grants are its first callers.
  - **Dependencies:** `handlebars` 4.7.10 is still in the two-week window on 2026-10-17 (eligible from 2026-10-19): it moves to P-32.

#### P-32: Rating and debits (parent B-01)
- **The hourly job** (D9): usage records → `usage_hourly` → the free tier → the price book → one transaction per account and hour. Re-running an hour is a no-op. An hour is the hour of `started_at`, and its records can arrive after it ends: a call's when it ends, a lost call's when P-20's reaper marks it, up to two timeouts, the cold-start limit and 30 s after its start, and a minute more (33 minutes at the platform's limits). Rate an hour only once that has passed.
- **Provisioned time** (D8, from P-21): each `capacity_samples` row bills the minInstances that were ready, `LEAST(instances, min_instances)` × `memory_mb`, for its minute at the provisioned price, as P-30's estimate does. A minute without a row (no ready instance, or a missed sample) bills none.
- **Shadow mode** first (D9), switched off by configuration after two weeks without differences.
- **APIs:** `GET /billing/balance` and `GET /billing/transactions`. The console shows the balance on every page.
- **Tests:** L2: rating an hour twice; an hour that spans a price change; the free tier across a month boundary; the parent's reconciliation criterion (rated usage equals raw usage).
- **From P-30:** `rateMonth()` prices any span with the books valid in it, the free tier and tiers counted from the month's start; `PricingService.estimate()` gathers a month's usage per book. The hourly job can rate the month so far each hour and debit the difference, so tiers and the free tier stay exact.
- **From P-73:** the preview (`AdminPricesService.preview()`) sets each account's draft beside the books' estimate; once debits exist, the account's debits for the month are what was actually charged, and belong beside them.
- **From P-31:** an hour's debit is `LedgerService.post()` with kind `usage`, the key `usage:<account>:<hour>`, wallet −x and revenue +x, `occurredAt` the hour, and no floor. `toMinor()` rounds the hour's amount once. Rating an hour again is a replay; the same hour with another amount is refused (409), so a correction is a transaction of its own. `GET /billing/balance` reads `balance()`, and writes money with `formatMinor()`.
- **Dependencies** (moved from P-31): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **As built** (2026-10-17):
  - **When an hour is rated:** 33 minutes after it ends, at the platform's limits: two 900 s timeouts, the 90 s cold start (`K8S_READY_TIMEOUT_SECONDS`), 30 s, as P-20's reaper counts a call's longest life, then a minute for the last sample. A timer looks every minute; the hours after the last one rated go in order, so a stop only delays them, and the first run starts at the first book's start. One backend at a time: the turn holds PostgreSQL's advisory lock, and another backend's turn does nothing (parent §4.3).
  - **The tables** (migration `Rating`, all three written once, through P-17's `ff_refuse_change()`):
    - `usage_hourly`: per account, hour and function, the hour's billed calls without and with provisioned concurrency and their MB-ms (the book's minimum billed duration applied to each call), the minInstances held and the instances above, from the minute samples, and the hour's book. The SQL is P-30's estimate's (`BE/src/billing/usage-sql.ts`), so the two never count differently;
    - `usage_charges`: per account and hour, the charge in minor units, the month so far (rounded once), shadow or not, and the debit's ledger transaction;
    - `rating_runs`: the hours rated, with how many accounts were charged and whether in shadow mode.
  - **An hour's charge:** for each account with usage in the hour, its month to the hour's end, from `usage_hourly`, priced with P-30's `rateMonth()`: each book its own hours, the free tier and tiers from the month's first hour, the monthly fee the first book's. Rounded once to the millime, less the month's earlier charges. A month's charges add up to its total rounded once: three hours of 0.0004 TND give 0, 1 and 0 millimes, where rounding each hour alone would give none. An hour without usage has no charge; only the idle-time knob could make one negative, which then credits the wallet.
  - **A price change within an hour** can't happen: a book starts at a whole hour, UTC, which the database now checks (`price_books`' check, as P-73's route already did). The migration names any book that doesn't, and stops.
  - **Debits:** with shadow mode off, the charge's ledger transaction is written in the same database transaction as the charge: kind `usage`, key `usage:<account>:<hour>`, at the hour, wallet −x and revenue +x, no floor (D9). A charge of 0 debits nothing. Again, an hour writes nothing: its sums and each account's charge are written once, and a run stopped half way finishes the accounts left.
  - **Shadow mode** is the platform setting `billingShadowMode` (P-70), read each hour: its charges are recorded and not debited. Turning it off debits from the next hour rated, the hour that ended up to 33 minutes before included; usage rated in shadow mode is never debited later, as the month so far counts the shadow charges.
  - **The reconciliation** (`npm run billing:reconcile -- --month YYYY-MM`, `BE/src/billing/reconciliation.ts`): per account, the month's charges against the same hours priced again from the usage records and samples (P-30's estimate, now with an end), and the billed calls counted both ways. Two weeks of agreement is D9's signal to turn shadow mode off. A difference means usage reached the database after its hour was rated: not charged.
  - **APIs:** `GET /billing/balance` (the balance, in the currency of the book valid now; shadow mode; this month's charges; the end of the last hour rated) and `GET /billing/transactions` (what moved the wallet, newest first, 50 a page, `next` as `before`). Every member, and an API key with `usage:read` (D3's scopes stay six). Money is a string with every decimal.
  - **Console:** the header shows the balance on every page, read again at each page; "Billing trial" while shadow mode is on, its title giving the month's charges so far.
  - **P-73's preview** shows each account's charges for last month beside the books' estimate and the draft ("–" before the month was rated).
  - **The settings module:** `PlatformSettingsService` has its own module, which the admin module and the billing module both import.
  - **Dependencies:** `handlebars` 4.7.10 is still in its window on 2026-10-17 (eligible from 2026-10-19): it moves to P-33.

#### P-33: Balance check and spend controls (parent B-07, in part)
- **The spendable-balance cache,** the negative buffer, the grace period, and `402 InsufficientCreditException` on invoke (D9). The console shows a banner with a top-up link.
- **Low-balance e-mails** at thresholds the owner sets (by default 50%, 20% and 0% of the last top-up).
- **Tests:** L1 for the policy; L4 for a wallet run down to zero, then invokes refused, then a top-up, then invokes accepted.
- **Dependencies** (moved from P-32): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.
- **From P-32:** the hourly rating debits a wallet up to 33 minutes after an hour ends, so the spendable balance lags usage by about an hour and a half at most: the negative buffer must cover that much usage. Refresh the cache after a charge's transaction commits (`HourlyRatingService.chargeHour()`), as after any posting. `GET /billing/balance` gives the balance and the month's charges; its `ratedUntil` says how far the rating has come.
- **From P-31:** a wallet changes only through `LedgerService.post()` or `postIn()`: refresh the spendable-balance cache once such a write commits. `balance()` sums the wallet's entries (indexed by ledger account). The posting floor is for movements that must not overdraw, such as refunds and corrections; usage is debited whatever the balance, and the buffer belongs to the invoke check.
- **As built** (2026-10-17):
  - **The rule** (`BE/src/billing/credit-policy.ts`, pure): in shadow mode nothing is refused; otherwise a balance at or above minus the buffer (`negativeBuffer`, 1.000 TND) is fine; below it, invokes go on for the grace period (`gracePeriodHours`, 24) from when the balance fell below, then stop. A stop is `402 InsufficientCreditException`, with the balance, since when, when invokes stopped, and what to do. The settings are read at each call, so a change applies at once.
  - **The standing** (`CreditService`): the wallet's balance, and when the current stretch below the buffer began, from the ledger in one query (a running sum by window function): no other state to keep. It is cached per account, and dropped on each write to the wallet; the cache lasts a minute at most, which covers a lost notification.
  - **The ledger's NOTIFY** (migration `CreditControls`): a trigger on `ledger_entries` NOTIFYs `ff_ledger` with the account's ID; PostgreSQL delivers it when the write commits, never on a rollback, to every backend that LISTENs (`LedgerEvents`), whoever wrote: a service, another backend, SQL by hand. A broken listening connection is opened again after 5 s.
  - **The invoke path:** `FunctionsService.invoke()` checks the account after the function and before the invocation's record, so a refused call leaves nothing. Shadow mode costs one settings read.
  - **Low-balance e-mails** (`LowBalanceService`): after each write a backend hears, the shares of the last credit (a top-up, a payment, a promotion or a correction in the customer's favour; a usage charge given back is none) that the balance has fallen to: each is written once to `low_balance_notices` (account, credit, share), so of the backends that hear the write only one sends, and the owners get one e-mail naming the lowest share reached. The next credit starts again. The shares are the owners' (`accounts.low_balance_percents`, `GET` and `PUT /billing/alerts`, owners only, with a login, in the audit log as `billing.alerts`) or the platform's `lowBalancePercents`. "Of the last top-up" became "of the last credit": top-ups come with P-34, and credit from FF counts too.
  - **APIs:** `GET /billing/balance` gains `credit`: the state (ok, grace, stopped), the buffer, since when, and when invokes stop.
  - **Console:** a banner under the header of every page once the balance is below the buffer, amber in the grace period with the time invokes stop, red once they stopped, linking to a new Billing page: the balance, this month's charges, whether invokes go on, the low-balance shares (an owner edits them), and what moved the balance. Until P-34, the page says FF adds credit on request.
  - **Not built:** budgets, alerts by SMS, hard caps per function (parent B-07's rest): later.
  - **Dependencies:** `handlebars` 4.7.10 is still in its window on 2026-10-17 (eligible from 2026-10-19): it moves to P-34.

#### P-34: Konnect top-ups (parent B-03, first adapter)
- **The `PaymentProvider` interface** from the parent's Appendix F, and the Konnect adapter:
  - `init-payment` returns a `payUrl`;
  - the GET notification is answered by re-querying the payment;
  - the amount, the currency and our payment ID are checked against the pending payment;
  - raw payloads are kept in `webhook_events`.
- **Reconciliation:** a job polls pending payments every 10 minutes and expires them after a day.
- **Console:** top-up amounts (the parent's prepaid packs), each showing the credit, the 19% VAT and the total (D9); the redirect; and the result page, which shows the confirmed state from the backend, not the redirect's parameters.
- **Tests:**
  - L1 with recorded Konnect responses: success, failure, an amount mismatch, a duplicate notification, a forged notification for a payment that doesn't exist;
  - L4 against Konnect's sandbox, when credentials exist.
- **From P-31:** a confirmed top-up is one posting, kind `topup`, key `konnect:<payment>`: wallet +credit, VAT payable +19% of it, provider clearing −the total, with `postIn()` in the transaction that marks the payment confirmed. A duplicate notification is then a replay.
- **From P-33:** the top-up page belongs on the console's Billing page (`FE/src/components/Billing.tsx`), where "Adding credit" says FF adds it on request until then; the banner's "Add credit" links there. A confirmed top-up lets invokes in again at once, as the ledger's NOTIFY refreshes every backend's cached balance, and it is the base of the next low-balance e-mails.
- **Dependencies** (moved from P-33): take `handlebars` 4.7.10 (`npm audit fix`), P-09's last open dev-tool finding, old enough from 2026-10-19.

#### P-35: Bank transfers and manual credit (parent B-04, light)
- **Pro-forma:** the owner asks for one; it carries a unique payment reference.
- **Recording the payment:** you record it in the admin dashboard (P-74), which credits the wallet and is audit-logged. Withholding tax follows D9: the withheld share is credited when you upload the certificate.
- **Tests:** L1 and L2 for the ledger entries, including a payment net of withholding tax.
- **From P-31:** the withholding-tax receivable (parent §8.3) is not among the ledger's types yet: add it to the `ledger_accounts` type check, with a migration, for the withheld share.

#### P-36: Monthly invoices (parent B-05)
- **The monthly run** (D9): on the 1st, one draft per account that paid anything in the previous month, and a usage statement for every active account. You issue the drafts from the admin dashboard (P-74).
- **Numbering:** gapless per fiscal year, from a locked counter row, assigned only when a draft is issued. Issued invoices are immutable, and corrections are credit notes.
- **Content:** a French PDF with one line per payment (pre-tax credit and VAT at 19%), the 1 TND stamp duty, the buyer's tax ID for B2B, and the usage statement attached. Tax rates are dated data (parent §8.6).
- **Tests:** L2 for a month with two top-ups and a bank transfer net of withholding, a month without payments, numbering under concurrency, and credit notes; PDF snapshots.
- **From P-32:** the usage statement's requests, GB-seconds and amount per function come from `usage_hourly` (each hour's sums, with its book) and `usage_charges` (each account's hourly charges, which add up to the month's total rounded once).
- **From P-31:** the stamp duty of an issued invoice is a posting (wallet −1.000, stamp duty +1.000) written with `postIn()` in the transaction that numbers the invoice. A refund posts with `floorMinor: 0n`, so it never takes more than the credit left.

#### P-37: El Fatoora e-invoicing (parent B-06)
- **Scope:** TEIF XML, a XAdES signature with the TunTrust certificate, submission to TTN, and the reference and QR code on the PDF.
- **Planned on its own** because of the external dependencies (the certificate, TTN registration and test access).
- **Gate (D9):** it must be live before GA, or before the next invoice run once paper invoices are no longer tolerated.

### Phase 4: customer logs

#### P-40: Interim logs endpoint (the CLI plan's C-05, backend part)
- `GET /functions/:id/logs?tail=&sinceSeconds=` reads the function pods' logs through the Kubernetes API, scoped to the account. The response already has the final shape of P-43.
- If C-05 is already done, this task only adds the account scope.
- **Tests:** L1 against the fake Kubernetes API; L5.

#### P-41: Spike and ADR 0005: the log pipeline
- **On k3d:** Vector and Fluent Bit (one each), with VictoriaLogs.
- **Measure:**
  - the delay from `print` to a query result (target: under 5 s);
  - the collector's and the store's memory and CPU;
  - the per-namespace rate limit;
  - the request-ID parsing for both runtimes;
  - how to delete one account's logs;
  - retention.
- **Done when:** ADR 0005 records the choice, with the measurements.

#### P-42: Log pipeline in the cluster
- **Manifests** in `deploy/k8s/logging/`:
  - VictoriaLogs as a StatefulSet with a volume;
  - the collector as a DaemonSet, with read-only permissions for pod and namespace metadata;
  - NetworkPolicies: the collector may write and only the backend may query.
- **Development:** `hack/k8s/cluster-up.sh` installs the stack, behind a flag.
- **Tests:** L3: a function's `print` arrives with its function ID and request ID; a function printing in a loop is rate-limited without affecting another namespace.

#### P-43: Logs API
- **`GET /functions/:id/logs`:** `start`, `end` (limited to the plan's retention), `q` (a quoted phrase), `requestId`, `limit` (at most 1,000 lines), and a cursor.
- **`GET /functions/:id/logs/stream`:** a live tail through Server-Sent Events, closed after 30 minutes.
- **Scope:** the backend always adds the account's namespace and the function.
- **Load errors:** since P-10, a failed load is reported from the runtime's `function initialization failed` line, which the driver reads from the pod's log. When `pods/log` goes, the driver reads that line from the log store instead.
- **The CLI's `ff logs`** keeps working unchanged.
- **Tests:**
  - L1 for the query builder, including injection attempts in `q`;
  - L3 for a search, a request ID, and the tail;
  - L5.

#### P-44: Console logs tab
- **Function page:** time range, search, and live tail. Each history row links to its logs by request ID.
- **Tests:** L0; a manual check recorded in the progress log.

#### P-45: Retention of history and logs
- **Invocation inputs and outputs** are personal data of the customer's end users (parent §9.2):
  - they are kept for the plan's history retention (30 days by default), then cleared by a daily job;
  - each one is stored only up to 64 KiB, with a flag when truncated.
- **Closing an account** deletes its functions, history and logs after a notice period. Usage, ledger and invoices stay for the legal retention period.
- **Usage records** (from P-20) and **capacity samples** (P-21) are archived a month at a time once the retention has passed: detach the month's partition, export it, then drop it. The triggers refuse deleting rows, not that. Samples grow by a row per warm function and minute, about 525,000 a year for one that is always warm.
- **The audit log** (from P-17) keeps e-mail addresses (`actor_label`, member events) and IP addresses, and refuses deletion. Decide its retention with the accountant's answers, and how to redact a person who asks: a migration that disables the trigger for that one statement, recorded.
- **Tests:** L2 for the purge job; L3 for log deletion as decided in P-41.
- **From P-71:** an operator closes an account from the admin dashboard: `closed`, final, with an e-mail to its owners. Its functions scale to zero, and the metrics tick's `holdStoppedAccounts()` reads each one every minute until this task deletes them. Deleting them also ends those reads.

### Phase 5: metrics and alarms

#### P-50: Metrics API
- **`GET /functions/:id/metrics?start=&end=&period=&stat=` and `GET /metrics`** (account totals), from `usage_records` and `capacity_samples` (D11), with quiet periods filled with zeros.
- **Console:** the charts switch to this API. `GET /metrics/:functionId` is removed.
- **Instances** (from P-21): `capacity_samples` has a row for each minute with a ready instance; a minute without one is 0.
- **Tests:** L2 for the aggregates against hand-computed fixtures (percentiles, empty periods, throttles); L5.
- **Throttles apart** (from P-15): `function_metrics` still counts a throttled call as an error. Count throttles apart, as Lambda's `Throttles` metric does. In `usage_records` (P-20), `throttled` is the runtime's 429 only: invocations the rate limits refused (P-15) have no record, so count those apart too if the metric should include them.

#### P-51: Notifications
- **E-mail** through the SMTP settings, with French and English templates.
- **Webhooks:** signed with HMAC-SHA256 (a per-account secret), with a timeout, and up to 5 retries with backoff. Each delivery is recorded in `notification_deliveries`.
- **Tests:** L1 for signing and retries against a local HTTP server.

#### P-52: Alarms
- **The API, the evaluator and the states** (D11). A notification is sent only on a state change.
- **Billing alarms:** balance below a threshold, month's spend above one.
- **Console:** a page to create alarms, and their state on the function page.
- **Tests:** L1 for evaluation with "M out of N" and missing data; L4 for an error alarm that fires and recovers, with a webhook.

#### P-53: Operator monitoring (parent F-09)
- **Backend:**
  - JSON logs to stdout, with the request ID on every line;
  - `/healthz` and `/readyz`;
  - Prometheus metrics on an internal port: invokes, errors and throttles by outcome, cold-start time, rating lag, webhook failures, reconciliation mismatches, alarm evaluator lag.
- **Cluster:** Prometheus (or VictoriaMetrics), kube-state-metrics, Grafana dashboards in git, and Alertmanager rules for the platform (invoke error rate, cold-start p95, node memory, database disk, the log pipeline's delay, payment failures). Alerts go by e-mail, and by SMS later.
- **Tests:** L3: the dashboards show real values after the e2e run.

### Phase 6: pilot launch

#### P-60: Images and platform manifests
- **Images:**
  - the backend: Node.js 24, non-root, read-only root;
  - the console: a static build, with its production `VITE_API_URL`, `VITE_OIDC_AUTHORITY` and `VITE_OIDC_CLIENT_ID`, which the build bakes into the bundle (P-14).
- **`deploy/k8s/platform/`:**
  - the backend in `ff-system` (ServiceAccount `ff-controller`, `direct` invoke mode, one replica, migrations as a Job before each rollout);
  - the console;
  - Keycloak, with its database on the same PostgreSQL server (`KC_DB_*`), started with `start` (not `start-dev`), TLS at the edge, and `KC_HOSTNAME` set to the login hostname. Its realm comes from `deploy/keycloak/ff-realm.json`, the development realm (P-11), without the `ff-e2e` client, with the production redirect URIs, and with the real SMTP server. `ff-console` lists the console's address as its redirect URI (`https://<console>/*`), post-logout redirect URI and web origin; the API's `CORS_ORIGIN` is that same origin (P-14);
  - the admin app (D12), a static build with its production `VITE_API_URL`, `VITE_OIDC_AUTHORITY` and `VITE_OIDC_CLIENT_ID`. In the production realm, `ff-admin` has no password grant and lists only the admin hostname; the development operator `operator@ff.test` doesn't exist there. The API's `CORS_ORIGIN` lists the admin origin too;
  - an edge proxy (Traefik or Caddy) with ACME TLS for the API, console, admin and login hostnames, and an IP allowlist on the admin hostname.
- **PostgreSQL is not deployed** by these manifests. The backend and Keycloak reach it through environment variables (D13).
- **Production settings:** Swagger off, CORS limited to the console's origin, and Express's `trust proxy` set to the edge proxy, so that the audit log's `ip` (P-17) and the rate limits by address (P-15) see the caller, not the proxy.
- **Tests:** L4 against a fresh k3d cluster deployed only from these manifests.

#### P-61: Backups and restore
- **What:** PostgreSQL point-in-time recovery, with WAL archived to a second site, covering FF's database and Keycloak's. Usage, ledger and invoices are money.
- **Targets** (parent §11.3): recovery point 15 minutes, recovery time 4 hours.
- **A restore drill,** recorded in the progress log, then monthly.

#### P-62: Sandbox on, egress per plan
- **gVisor is required in production** (`K8S_RUNTIME_CLASS=gvisor`, K-11). It adds 2–5 s to cold starts until K-13.
- **Measure start-up under gVisor first.** In one L3 run on 2026-10-17 (P-09), a 128 MB Node.js function, which gets 0.1 CPU, took more than the 10 s start-up limit to load and compile its TypeScript inside gVisor; it passed when run again. Before the beta, measure start-up at the smallest size under load. If it stays close to the limit, precompile the code at deploy (K-13) or give start-up more CPU.
- **Internet egress per account** (D5): `networkPolicyManifest` takes the account's `internet_egress` flag instead of the global `K8S_EGRESS_INTERNET`. The plan's `internetEgress` (P-15, false on beta) is the flag's default for new accounts. Turning it on or off in the admin dashboard rewrites the tenant's NetworkPolicy. Off by default.
- **Tests:** L3 for the K-11 suite under the production settings; L3 for a function that can't reach the internet, then can once the flag is on, while private addresses stay blocked either way.
- **From P-71:** the admin dashboard already sets `accounts.internet_egress` (`PUT /admin/accounts/:id/egress`), with a reason and an `account.egress` audit entry; `AdminAccountsService.setEgress()` is where the NetworkPolicy's rewrite goes.

#### P-63: CI (parent F-11)
- **Pipeline:**
  - lint and type-checks, for `BE/`, `FE/` and `admin/` (P-70);
  - L1 and L2, and the console's and the admin app's Vitest suites;
  - the migration drift check;
  - L4 and L5 on k3d;
  - Trivy image scans, an SBOM, and gitleaks.
- **Hosting:** self-hosted (Gitea and Woodpecker), or the GitHub free tier (parent §4.10).
- **Done when:** the pipeline is green on the branch, and a pull request can't merge without it.

#### P-64: Security review
- **Internal review** before the beta:
  - authentication, API keys, the payment webhooks, the log query builder, the `/admin` routes, and the realm's operator one-time password flow (P-70);
  - dependency audit, and the L5 suite.
- **An external penetration test before GA** (parent §11.4).
- **NestJS 12** (P-09 stopped at 11.2.7), once Node.js 24.15 or newer runs the backend and its tests everywhere (§9). Its packages are ESM-only: Jest needs Node.js 24.9 or newer, or the tests move to Vitest. It also clears the last moderate finding in `@nestjs/swagger`.
- **Done when:** the findings are fixed or accepted in writing.

#### P-65: Legal and support pack (parent §9, mostly external)
- **Documents:** terms of service, privacy policy, a data-processing agreement, and the INPDP declaration. The lawyer drafts them in French, with an English courtesy copy.
- **Customer-facing pages:** the pricing page, a support e-mail, and a status page.
- **Runbooks:** incident, payment dispute, data-subject request, and breach notification within 72 hours.

#### P-66: Beta rehearsal
- **With a test customer, end to end:** sign-up; approval in the admin dashboard; a Konnect sandbox top-up; deploy; invoke; logs; an alarm firing; the month-end invoice issued from the admin dashboard; account closure.
- **Done when:** every step works on the production setup, and the parent's Phase 2 exit criteria hold.

### Admin dashboard (alongside the phases)

Each task ships with the phase it serves:

| Task | Ships with | Why then |
|---|---|---|
| P-70 Foundation | phase 1, right after P-11 | P-71 needs it |
| P-71 Accounts and approvals | phase 1, right after P-12 | Milestone A: you approve the first pilot accounts |
| P-72 Support lookup | phase 4 | It shows logs |
| P-73 Prices, plans and settings | phase 3, with P-30 | Price books are edited here |
| P-74 Payments, credit and invoices | phase 3, with P-34 to P-36 | Bank transfers and invoices are handled here |
| P-75 Overview | phase 5 | It needs the usage, capacity and billing data |
| P-76 Operator audit view | with P-70 | Every admin action is audited from the start |

#### P-70: Admin dashboard foundation
- **Backend:**
  - `AdminModule` under `/admin`, with the `OperatorGuard` (D12);
  - a required `reason` on every write, written to the audit log with the operator: an `operator:<id>` actor next to P-17's `user`, `key`, `dev` and `system`, and an `AuditAction` for each admin action;
  - `platform_settings`, with `GET` and `PUT /admin/settings`.
- **Keycloak:**
  - the client `ff-admin` (public, PKCE) and the realm role `ff-operator`;
  - a conditional one-time-password flow for that role;
  - an operator user in the development realm.
- **Frontend:** the `admin/` app:
  - login, layout and navigation;
  - paginated tables with filters and search;
  - a confirmation dialog with a reason field, plus error and empty states;
  - built in CI (L0).
- **Tests:**
  - L1 for the guard: a customer token gets 403, an operator's console token 403, an operator's admin token 200, and a write without a reason 400;
  - L5 covers every `/admin` route with customer tokens and API keys.
- **As built** (2026-10-17, after phase 2: the plan schedules it right after P-11, and it caught up here):
  - **The guard:** `@AdminRoutes()` marks a controller's routes; the global guard then takes them apart. A route there needs a realm token issued to `ff-admin` (`azp`) whose user has the realm role `ff-operator`: a customer gets 403, an operator's console token 403, an API key 403, and development mode 400, as for the other routes that need a login. It never creates a user, joins invitations or chooses an account. In the other direction, a token issued to `ff-admin` calls no customer route (403), so an operator's dashboard session never acts as a customer.
  - **A reason for every change:** any method but `GET`, `HEAD` and `OPTIONS` needs `reason`, 3 to 500 characters, in the body (400 otherwise), asked for only once the caller is known to be an operator; `AdminChange` declares it for the DTOs. The audit log names the operator `operator:<Keycloak ID>`, with the e-mail, and keeps the reason in `details.reason`.
  - **`platform_settings`:** a row per changed setting (`key`, `value` jsonb); a setting without one has its default. The six settings of D12, each read by a task to come: `billingShadowMode` (on; P-32), `negativeBuffer` (1.000 TND; P-33), `gracePeriodHours` (24; P-33), `lowBalancePercents` (50, 20, 0; P-33), `invoiceReminderDay` (3; P-36) and `largeCreditThreshold` (100.000 TND; P-74). D9 and D12 gave no numbers for the buffer, the grace period and the threshold: these are starting values for those tasks to revisit. Amounts are TND with three decimals, as strings, until P-31 sets the money format. `PUT /admin/settings` takes any of them with a reason; one transaction writes them with an audit entry that has each change's from and to; an advisory lock takes changes one after the other; a change to the values already set writes nothing.
  - **Keycloak (the development realm):** the client `ff-admin` (public, PKCE, at http://localhost:5198, the `ff-api` audience), the realm role `ff-operator`, a browser flow `ff browser` whose password step is followed by a one-time password for that role (`conditional-user-role`, then `auth-otp-form`; an operator sets one up at the first login), bound as the realm's browser flow, and the operator `operator@ff.test`. `ff-admin` allows the password grant in this realm only, for the tests.
  - **The admin app** in `admin/`: React, Vite and Tailwind like the console, at http://localhost:5198 (`strictPort`; `FF_ADMIN_URL` and the development `CORS_ORIGIN` follow, from 5174). The login, the layout and navigation, the reason dialog every change goes through, a data table with filters, search and pages for P-71 and P-76, the loading, error and empty states, and the Settings page. It has no development mode: without `VITE_OIDC_AUTHORITY` it says so.
  - **Rate limits:** each operator has its own count, on the plan new accounts get, rather than sharing their address's.

#### P-71: Accounts and approvals
- **Approvals queue:**
  - pending accounts, with what sign-up collected: the owner's name and e-mail, the account name, country, tax ID, and what they plan to build;
  - approve or reject, with a reason; the owner gets an e-mail either way;
  - your new-sign-up e-mail (P-12) links here: `FF_ADMIN_URL/accounts?status=pending`.
  - the console's "waiting for approval" page (P-14) then says that the owner will get an e-mail; until then it only offers "Check again".
  - until this exists, accounts are approved in SQL (P-12); `hack/e2e-tenancy.sh` does so, and its test of this task continues from there.
- **Accounts:**
  - search by ID, name or e-mail, and filter by status and plan;
  - an account page: members, functions (name, runtime, memory, status, last invocation), this month's usage, balance, payments, invoices, the audit log, and the status history.
- **Actions:**
  - **suspend and reactivate:** a suspended account's invokes and deploys get `403 AccountSuspended`, and its functions are scaled to zero. Nothing is deleted.
  - **close:** P-45's deletion flow;
  - **change plan:** `PlansService.assign` (P-15) moves the account and rewrites its quota at once;
  - **internet egress on or off** (D5, P-62).
- **Backend:** the `/admin/accounts` routes, plus the suspension check in the invoke and deploy paths.
- **From P-70:** `@AdminRoutes()` on the controller, an `AdminChange` DTO for each action's reason, and audit entries with the account's ID, so the customer's own log shows FF's actions on it. The app's `DataTable` and `ReasonDialog` are ready, and `hack/e2e-tenancy.sh` already gives each `/admin` route its customer, key and development-mode refusals; it needs the new routes' bodies in `body_for`.
- **From P-76:** each new action goes in the backend's `AuditAction` and in `OPERATOR_ACTIONS` (`admin/src/lib/audit.ts`), whose filter and labels the Audit log page uses; `contract.test.ts` fails when the page names an action the backend lacks, but can't tell when the page misses one, since `AuditAction` holds customers' actions too. A status change's entry with `details.changes` (`status`: from → to) reads well in the page's "What" column. `hack/e2e-tenancy.sh` can then check the approval in `GET /admin/audit-log?action=account.approve`.
- **Tests:**
  - L1 for the status changes: pending to active or rejected, active to suspended and back, any to closed;
  - L4, continuing P-12's test: approve, then deploy and invoke; suspend, and the invoke is refused; reactivate.
- **As built** (2026-10-17, after P-76: the plan schedules it right after P-12, and it caught up here):
  - **Routes** (`AdminAccountsController`, operators only):
    - `GET /admin/accounts`: newest first; `q` matches part of the ID, the name or any member's e-mail, in any case, `%` and `_` taken as themselves; `status` and `plan` filters. Its pages follow a cursor of the creation time, to PostgreSQL's microsecond, and the ID, so accounts created in the same millisecond are neither lost nor repeated.
    - `GET /admin/accounts/:id`: the account page. What sign-up collected, the owners and members, the functions with their last call, this month's usage totals (UTC), and the status history, read from the audit log.
    - `GET /admin/accounts/:id/audit-log`: the account's whole log, operators named.
    - `POST …/approve`, `/reject`, `/suspend`, `/reactivate`, `/close`, answering 200 with the account page; `PUT …/plan`, `PUT …/egress`.
    - `GET /admin/plans`, read-only, for the plan picker: P-73 edits plans.
  - **Status changes** (`BE/src/admin/account-status-changes.ts`):
    - pending → active (approve) or rejected (reject); active → suspended (suspend) → active (reactivate); any but closed → closed (close), which is final.
    - A change that doesn't apply gets 409, naming the status.
    - Each runs in one transaction with its audit entry: `account.approve` to `account.close`, with the reason and `changes.status` from → to. The account's row is locked, so two operators' changes go one after the other. An audit entry that can't be written rolls the change back.
  - **What a status means for the functions:**
    - Suspending or closing scales every ACTIVE function to zero once committed. A call under way finishes first: the runtime drains it, within the function's timeout.
    - The guard already refused a suspended or closed account's deploys, invokes and changes, from tokens and API keys alike: P-12's `@RequireActiveAccount`, 403 `Your account is suspended`. FF's errors have no `AccountSuspended` name to carry.
    - Each metrics tick, `holdStoppedAccounts()` scales back to zero any function of a suspended or closed account that has instances anyway: a call that was past the guard, or a scale-down that failed. The autoscaler leaves such functions alone.
    - Reactivating scales functions with `minInstances` back to it; the others start at their next call.
  - **The owners:**
    - Each owner gets an e-mail for each status change; a rejection, suspension or closure gives the reason.
    - FF's actions are in the account's own audit log (`GET /audit-log`) as FF's: actor `operator`, label `FF`, and no address. The reason and the change stay.
    - The console's waiting page says that the owners get an e-mail once the account is approved, or if it isn't.
  - **Plan:** `PlansService.assign(accountId, planId, reason)` writes the account and its `account.plan` entry (`changes.planId`) in one transaction, then applies the plan's quota at once. The same plan writes nothing but applies the quota again, so a retry heals a refused apply.
  - **Internet egress:** `PUT …/egress` records `accounts.internet_egress`, with an `account.egress` entry. The tenant's NetworkPolicy follows it from P-62; until then, `K8S_EGRESS_INTERNET` decides for every account.
  - **The admin app:**
    - It opens on Approvals (`/accounts?status=pending`), where the new-account e-mail links.
    - Accounts has a search and filters.
    - The account page has its sections, and the changes, each through the reason dialog, which says what the change does and what the owners learn.
    - `admin/src/lib/accounts.ts` mirrors the statuses and the changes; the contract test reads the backend's.
  - **Not yet on the account page:** the balance, payments and invoices, which P-31, P-34 and P-36 add. P-31 added the balance.

#### P-72: Support lookup
- **Search across accounts** by function ID or name, request ID, account ID, or e-mail.
- **A function page** shows its account, configuration, status, recent errors, and recent invocations (status and duration, without inputs or outputs).
- **Viewing customer data:** the code, invocation inputs and outputs, and logs open only with a reason. Each access is recorded in the customer's audit log (D12).
- **Tests:** L1; L4 for a lookup by request ID; L2 that an access shows up in the customer's audit log.
- **From P-71:** an account's page is `/accounts/:id` in the admin app (`GET /admin/accounts/:id`), for a lookup to link to. An operator's entry with the account's ID shows in the customer's audit log as FF's, with its reason (`asCustomerSees()`), which suits the data accesses.

#### P-73: Prices, plans and settings
- **Price books:**
  - list and view them;
  - create a new version by editing the current one, or from "AWS's US$ prices × an exchange rate";
  - the start date must be in the future (the next hour at the earliest); active and past books are read-only.
- **Preview:** last month's usage re-rated with the draft book, per account and in total, next to what was actually charged.
- **Plans:** edit every limit of D5. Quota changes are applied at once to every account on the plan: `applyTenantLimits` for each (P-15), and `PlansService` reads the plan fresh, rather than within its minute.
- **Settings:** shadow mode, the negative buffer, the grace period, low-balance thresholds, the invoice reminder, and the large-credit threshold. ✅ Built in P-70, with their page.
- **Tests:** L1 for book validation (every SKU present, tiers in order, start in the future); L2 for the preview against a fixture month.
- **From P-71:** `GET /admin/plans` lists the plans with their limits (`PlansService.list()`), and `PlansService.assign()` takes the operator's reason. The plan edits remain: `PUT /admin/plans/:id` and a Plans page.
- **From P-30:** `priceDocumentSchema` checks a book (every SKU, tiers in order); the database takes only books that start in the future. The first book's `source.usdPrices` and `usdRate` are what "AWS's US$ prices × a rate" starts from. `PricingService.estimate()` rates a month, so a preview prices last month with the draft as an extra book.
- **As built** (2026-10-17, right after P-30, as its schedule says):
  - **Price books:**
    - `GET /admin/price-books`: oldest first, each past, active or scheduled;
    - `POST`: a new book, from a whole hour, UTC, the next one at the earliest, so no hour is priced by two books. The book is checked: every SKU, tiers in order, a currency FF has. A book whose source says AWS's US$ prices times a rate (`aws-lambda`) must be exactly that, each price named where it isn't; a `manual` one takes TND prices as given. It is written in one transaction with its `price_book.create` entry and the reason; `created_by` is the operator. Two at the same hour: 409;
    - `DELETE /admin/price-books/:id`: only a scheduled book, with its `price_book.delete` entry. One that has started gets 409, and the database refuses it anyway (P-30).
  - **The preview** (`POST /admin/price-books/preview`): last month's usage priced with the draft as if it had been valid all month (`PricingService.estimate()` with the draft as its books), per account that used anything, next to the books valid then, and the totals. It saves nothing, so it takes no reason: `@ChangesNothing()` marks such an admin POST for the guard. Nothing is charged before P-31, so "what was actually charged" is the books' estimate until P-32.
  - **Plans:**
    - `PUT /admin/plans/:id`: every limit of D5, and the name, in one transaction with the `plan.update` entry (each change, from → to), the plan's row locked;
    - this process reads the plan fresh at once, and a changed quota goes to every account on the plan, the answer counting those whose namespace took it and those that didn't (their next deploy writes it). Unchanged, nothing is written;
    - `POST /admin/plans` creates a plan from limits (`plan.create`): P-71's plan picker had only beta.
  - **The admin app:**
    - **Prices** lists the books and shows one's prices in TND, and in US$ where they come from AWS's. A new book starts from the active one: US$ prices times a rate, multiplied exactly with BigInt as the API checks them, or TND prices as set. "Try it on last month" previews it; saving and removing go through the reason dialog;
    - **Plans** lists the plans and edits one, the dialog listing each change; "New plan from it" starts from another plan's limits.
    - `contract.test.ts` checks the limits and the SKUs against the backend's schemas, and the first book's TND prices against the app's own multiplication.

#### P-74: Payments, credit and invoices
- **Payments:** every payment with its provider, status and amount. Reconciliation mismatches are listed first.
- **Bank transfers:** record a payment against a pro-forma reference, with the withheld amount; upload the withholding certificate later (D9).
- **Credit:** grant promotional credit, or a correction, with a reason. Above the threshold, a second confirmation.
- **Invoices:**
  - the monthly drafts (D9): review, then issue all or one;
  - download the PDFs, and issue credit notes for refunds;
  - El Fatoora status, once P-37 exists.
- **Tests:** L2 for every action's ledger entries; L4 for a month-end run with a fixed clock: drafts, issue, PDF.
- **From P-71:** the account page (`GET /admin/accounts/:id`, `admin/src/pages/Account.tsx`) waits for the balance, payments and invoices, each a section like its usage.
- **From P-32:** the account page can show the month's charges (`usage_charges`), and whether they were debited; `npm run billing:reconcile` is the operators' check until a page shows it.
- **From P-33:** a grant is credit: it lets a stopped account invoke again at once, and becomes the base of its low-balance e-mails. The account page can show the credit state (`CreditService.view()`: ok, grace or stopped, and until when).
- **From P-31:** the account page has the balance. `LedgerService.grantCredit()` posts a promotion or a correction against promotional credit; the route adds the reason, the audit entry and the threshold's second confirmation, reads the amount with `parseMinor()`, and passes a key of its own, so a retried request grants once. A correction against a customer takes `floorMinor: 0n` unless you mean to leave a debt.

#### P-75: Overview
- **Figures:**
  - accounts by status, and pending approvals;
  - functions, invocations, errors and throttles today;
  - top-ups and consumption this month (consumption: the month's `usage_charges`, P-32);
  - the total of customer balances (the unused credit FF owes);
  - reserved against billed GB-s per day: D8's cost gap, which `capacityReport()` (P-21) already computes per account and day.
- **Links** to the operator dashboards (P-53).
- **Backend:** `/admin/stats/overview`, cached for a minute.
- **Tests:** L2 for the figures against fixtures.
- **From P-71:** the pending approvals are `GET /admin/accounts?status=pending`, and the accounts by status a count of the `accounts` table by `status`.

#### P-76: Operator audit view
- Every operator action, filtered by operator, account, action and date, with CSV export.
- **From P-70:** operator entries are `actor LIKE 'operator:%'`, with the reason in `details.reason`; the app's `DataTable` takes the filters and pages.
- **Tests:** L1.
- **As built** (2026-10-17, right after P-70, as its schedule says):
  - **`GET /admin/audit-log`:** the entries an operator made (actor `operator:<id>`), newest first, 50 a page (`limit` up to 100; the next page with `before`, the last page's `next`). Each has the operator's Keycloak ID and e-mail, the action, the account (null for the platform), the resource, the reason (`details.reason`), the details, the address and the request ID. Filters: `operator`, part of the e-mail in any case, `%` and `_` taken as themselves; `accountId`; `action`; and `from` (included) and `to` (excluded), as ISO 8601 instants. A customer's entries never show, not even one with an operator's e-mail. The guard is P-70's: operators only.
  - **CSV:** with `Accept: text/csv`, the newest 10,000 entries that match, a line each (`at`, `operator_id`, `operator_email`, `action`, `account_id`, `resource`, `reason`, `ip`, `request_id`, `details` as JSON), in `ff-operator-audit-<UTC date>.csv`. Free text gets P-22's formula guard, whose CSV helpers moved to `BE/src/common/csv.ts` for both. When more matched, the answer has `X-FF-Truncated: true`, which CORS lets the dashboard read.
  - **The "Audit log" page** of the admin app (`admin/src/pages/AuditLog.tsx`), first in the navigation: the table, its filters (operator, account, action, and from and to as UTC days, both included), pages, and "Download as CSV" with the same filters, which says when the file holds only the newest 10,000. Times are in UTC, like the filters and the CSV; a settings change reads as the Settings page's dialog says it (`Grace period: 24 → 48`), and any other change as the API names it, a value with parts as JSON and an empty one as "none". Actions show by name, from `OPERATOR_ACTIONS` in `admin/src/lib/audit.ts`; `contract.test.ts` checks each against the backend's `AuditAction`.
  - **No index for these filters yet:** `audit_log` has its primary key and `(account_id, id)`, so a page without an account walks back from the newest entry past customers' entries. Those come from changes, not invocations, so the beta's log stays small; if the page slows, a partial index on `id` where `actor LIKE 'operator:%'`, with that predicate written as a literal in the query, fixes it.
  - **For the tasks that add operator actions** (P-71 to P-74): add each to `AuditAction`, and to `OPERATOR_ACTIONS` with what the page calls it. The "What" column shows `details.changes` as from → to, else the resource.

## 8. Risks

| Risk | Mitigation |
|---|---|
| AWS's prices don't pay for idle instances (§1.3), so revenue may not cover the servers | P-21 and the admin overview show the gap every day; D8's knobs (minimum billed duration, idle time, plan fee) change prices without code; manual approval and plan quotas limit the exposure during the beta |
| AWS's free tier (1 million requests and 400,000 GB-s per account and month) is generous for a small cluster | Manual approval during the beta; plan quotas; the free tier is a price-book value you can lower |
| An operator login is stolen | A separate app and Keycloak client, a second factor, an IP allowlist, a reason and an audit entry for every action, no impersonation, large credits confirmed twice (D12) |
| A new route forgets the account check | The global guard denies by default; services require the account ID; the L5 suite covers every route in the OpenAPI document, in CI |
| Metering bugs produce wrong bills | Append-only records; idempotent rating; reconciliation tests; two weeks of shadow billing (D9) |
| Forged or replayed payment notifications | Always re-query the provider; check the amount, currency and payment ID; unique event IDs; never trust the browser redirect |
| Keycloak becomes one more system to run | One realm, kept as configuration in git; a pinned version; its database in the same backups |
| One backend replica: in-memory caches (balance, rate limits) and the evaluators | State that matters lives in PostgreSQL, so a restart loses nothing; Valkey and leader election (parent R-06) before a second replica |
| A tenant floods the log store | Collector rate limits per namespace, line truncation, retention per plan; ingestion is metered for later billing (parent §8.2) |
| Personal data in logs and history | In-country storage, retention per plan, deletion on account closure, the data-processing agreement (P-45, P-65) |
| Tunisian invoicing rules are uncertain | The accountant confirms D9 in P-00; VAT is charged at payment, so it is never declared late; tax rules are dated data (parent §8.6); El Fatoora is planned on its own (P-37) |
| gVisor makes slow cold starts slower (12–15 s) | K-13's CPU burst decision; `minInstances` billed as warm time (D8) |
| A burst of calls to one function queues on its only pod, and calls fail while it works through the queue | D14 (P-06): instances are added as soon as calls wait, and a call waits at most one timeout, then gets 429; P-15's rate limits and the `throttled` status |

## 9. Decisions of 2026-10-16

| Question | Decision | Decided by |
|---|---|---|
| Pricing | AWS Lambda's price list in TND, with the same free tier, configurable from the admin dashboard (D8) | you |
| Beta access | You approve every new account, in the admin dashboard (D2, P-71) | you |
| Admin work | A separate admin dashboard, from backend to frontend (D12, P-70 to P-76) | you |
| Invoices | Monthly (D9) | you |
| PostgreSQL in production | Any PostgreSQL, through environment variables, once P-01, P-02 and P-61 are done; no operator in the cluster (D13) | this plan, after your question |
| Internet egress for beta ("pilot") customers' functions | Off by default; you turn it on per account (D5) | this plan: the safe choice you asked for |
| Accounts | Functions belong to an account with members, not to a user (D1) | this plan |
| VAT on prepaid credit | Charged when credit is bought, on top of its pre-tax value (D9) | this plan; the accountant confirms |
| What the monthly invoice lists | The credit bought that month, with a usage statement attached (D9) | this plan; the accountant confirms |
| El Fatoora | PDF invoices while paper invoices are tolerated; live before GA (D9, P-37) | this plan; the accountant confirms |
| Payment fees, unused credit, withholding | FF absorbs the fees; credit doesn't expire; the withheld share is credited on the certificate (D9) | this plan |
| Log store | VictoriaLogs; the P-41 spike can still compare Loki (D10) | this plan, following parent ADR-008 |

**For the accountant, in P-00.** None of these blocks phases 0 to 2, and each answer changes only the task named:
1. Is VAT on FF's services due when the price is collected, or when the service is used? (D9's VAT point; P-34 and P-36.)
2. Is a monthly invoice for the credit bought, with a usage statement, acceptable, or must it list consumption? (P-36, using the fallback in D9.)
3. Until when may a provider not yet connected to El Fatoora issue paper invoices? (P-37's gate.)
4. Which withholding rate applies to cloud services, 1.5% or 3% (parent §8.6)? How are refunds of unused credit handled? (P-35, P-74.)
5. What are the mandatory invoice details, and how long must usage records and invoices be kept? (P-36, D6.)

**Actions waiting for you.** P-00 lists them because each has a long lead time. None blocks phases 0 to 2, and only you can start them:

| Action | Why now | Needed by | Status |
|---|---|---|---|
| Start Konnect's merchant onboarding, sandbox first. Its know-your-business checks ask for the company's documents (parent §9.1) | P-34's tests need sandbox credentials: an API key and a wallet ID | P-34 | ⏳ Not started |
| Send the five questions above to the accountant | Each answer changes one task, from P-34 to P-37 | P-34 | ⏳ Not started |
| Order the TunTrust certificate, and register on TTN's El Fatoora (parent §8.6) | The certificate takes time, and P-37 can't be tested without TTN's test access | P-37 | ⏳ Not started |
| Update Node.js on your machine to 24.15 or newer (it runs 24.4.0) | NestJS 12's tests and CLI need it. Until then the backend stays on NestJS 11, which is maintained and has the same security fixes (P-09) | P-64 | ⏳ Not started |

When one of these moves, its status changes here.

## 10. Effort (rough estimates, one developer)

| Phase | Working days | Notes |
|---|---|---|
| 0 | 14–22 | The schema baseline, the lifecycle fixes (P-03), the scaling model (P-06) and the NestJS upgrade (P-09) are most of it |
| 1 | 15–20 | Keycloak, the rename to accounts, and the console pages are the largest parts |
| 2 | 6–8 | |
| 3 | 20–28 | Plus 10–15 for El Fatoora (P-37), with external lead times |
| 4 | 8–12 | Including the spike |
| 5 | 8–10 | |
| 6 | 10–15 | Plus the external legal work |
| Admin dashboard | 18–24 | Spread over phases 1, 3, 4 and 5; P-70 is the largest part |
| **Total** | **99–139** | Milestone A (free pilot) is about 51–72 of these |

Without the fixes of P-03 to P-08, this is smaller than the parent plan's Phase 2 (about 24 person-weeks): one payment provider, bank transfers recorded by hand, a console in French and English only, and no SMS.

## 11. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| P-00 Preparation and ADR 0004 | ✅ Done | `9326077` | • Branch `feat/client-ready` created from `master` at `5434ad9`. Baseline before any change: `tsc --noEmit` exit 0, `npm test` **12 suites / 122 tests**.<br>• [ADR 0004](adr/0004-identity-and-tenancy.md) records D1 to D5 and D12. It adds three precisions that the later tasks need: how a request chooses its account (`X-FF-Account`, now in D4), the exact API-key format, and that a key's limit to its creator's role is checked on every request (now in D3).<br>• D1 lists the `rejected` status, as §4 already did.<br>• The external actions are listed in §9, waiting for you.<br>• `hack/check-docs.py` passes on the ADR, this plan, and the docs index. |
| P-01 Schema baseline | ✅ Done | `e3493b3` | • L0: `tsc --noEmit` exit 0; `nest build` has no tests in `dist/`.<br>• L1 `npm test`: **15 suites / 153 tests** (was 122). New: the naming strategy; the options (no sync in any `NODE_ENV`, `gen_random_uuid()`, the explicit lists); the entity mapping built offline (snake_case, camelCase properties kept, one `function_id` column per table, `timestamptz` everywhere); `describeError`. Undoing each change by hand makes its test fail.<br>• L2 `npm run test:db`: **7/7** on PostgreSQL 15.19. A fresh database is refused; after the migrations there is no drift; `information_schema` shows snake_case, `gen_random_uuid()` and `timestamptz`; repositories round-trip with the API's names; deletes still cascade; a second run does nothing; the baseline reverts completely and applies again.<br>• `migration:check`: exit 0; exit 1 for an entity changed without a migration, and for a migration missing from `index.ts`; exit 2, naming the cause, when the server is unreachable.<br>• Manual: the build refuses a fresh database (exit 1, naming the pending migration); `migration:run:prod` applies the baseline; the backend then answers `GET /functions` with 200.<br>• L4 `hack/e2e.sh`: **21/21** in 67 s, with two new checks (the refusal, and the migrations from the build). No leftovers.<br>• Found while verifying: `pg` reports a refused connection as an `AggregateError` with an empty message, so failures printed nothing. `describeError` now names the cause in `main.ts` and in the check.<br>• Docs: getting-started (migration step, one-time reset, schema changes, tests, troubleshooting), README, the Kubernetes dev guide, `how-it-works.html` (SQL and diagram in snake_case), CLI plan C-03, parent Appendix A (C-7). |
| P-02 Validated configuration | ✅ Done | `ae23168` | • L0: `tsc --noEmit` exit 0; `nest build`.<br>• L1 `npm test`: **15 suites / 204 tests** (was 153). The configuration suite has 48: each production refusal, a format error per kind of variable that names it, every problem listed at once, credentials never repeated, the CA file loaded or refused, `BE/.env.example` valid and documenting exactly the 39 variables, and the database-only parse. Disabling two rules by hand fails the intended tests.<br>• L2 `npm run test:db` **7/7** and `migration:check` OK, both now reading only the database variables.<br>• Manual, with the build: an old `.env` (`FF_DEV_USER_ID=1`) exits 1 with three lines that say what to change; production with the development defaults exits 1 naming four variables; the new dev `.env` starts, answers `GET /functions` with 200, and CORS answers only the console's origin.<br>• L4 `hack/e2e.sh`: **22/22**, with a new check that production refuses development settings at boot. Each run uses a random 12-digit account.<br>• Zod 4.6.5 added (MIT, no dependencies): the newest release that was more than two weeks old.<br>• Found while adding it: 26 known vulnerabilities in the production dependencies, now §1.7 and the new task P-09.<br>• Your `BE/.env` was identical to the old example, so it was replaced by the new one.<br>• Docs: `BE/.env.example`, getting-started, README, the dev guide, `how-it-works.html` (the dev account), the migration plan's §4.5, parent Appendix A (M-2). |
| P-03 Function lifecycle fixes | ✅ Done | `b639aa2` | • L1 `npm test`: **15 suites / 215 tests** (was 204). New in `functions.service.spec.ts`: repair of an `ERROR` function, retry without changes, rollback (nothing saved or archived), a rollback that fails too (both messages, pod released), a failed repair keeps the attempt, oversized code changes nothing, the archive written after the rollout and moved on a runtime change, an archive failure doesn't fail the update, a failed create releases its pod. In the driver's spec: one replica at least, even at zero. **Against the old code, 11 of these fail**, one or more per defect of §1.6.<br>• L3 (new `functions.lifecycle.it.spec.ts`, the service with the real driver on k3d): **3/3** in 2 min 36 s. A broken create ends `ERROR` with 0 desired replicas and no pod, and an update with fixed code makes it `ACTIVE` and invocable. A broken update of a working function answers 400, and after a scale to zero the cold start still runs the old code. At zero, broken code is refused and good code goes live on a real pod.<br>• L3 driver suite: **11/11**. The Node.js heap-hog case failed once with `Sandbox.Timedout`, which is a runtime timing issue: recorded under P-04.<br>• L4 `hack/e2e.sh`: **22/22**.<br>• Found while verifying: `npm run test:it -- <pattern>` silently ran the wrong suites, because Jest's list options swallow the arguments after them. `test:it` and `test:db` now end with a boolean flag, so a path filter works.<br>• Docs: `how-it-works.html` (update and failed-load scenarios, the lifecycle diagram, checked in a headless Chrome screenshot; a P-01 leftover in camelCase), the getting-started guide (update, load failures, troubleshooting), the dev guide and README (the L3 suite). |
| P-04 Runtime fixes | ✅ Done | `fdf89ca` | • L1 Node.js runtime: **29/29** (was 23). New: working directory, peak memory measured after the allocating thread exited, the `function error` line (source-mapped, before `END`), `Runtime.MarshalError` for a function, a symbol, a `BigInt` and a cycle, callback handlers refused, a first-load failure keeps the runtime up, a failed reload exits 1. **Against the old runtime, 7 of these fail.**<br>• L1 Python runtime: **27/27** (was 26). New: the out-of-memory replacement is logged; a failed reload exits 1; a first-load failure keeps the runtime up. Against the old runtime, 2 fail.<br>• L2: `ff-runtime-nodejs:24-v2` **8/8** (194 MB), with two new checks: protocol 2, and `/var/task` with a file read next to the code under the hardened image. `ff-runtime-python:3.13-v2` **11/11** (119 MB), with the protocol check.<br>• L3 `hack/k8s/test-it.sh`: **15/15** in 5 min 23 s, with a new case: a Node.js function in `/var/task` reads its own file. The heap-hog case passed 4 times out of 4 at 30 s.<br>• L4 `hack/e2e.sh`: **22/22** on the v2 images. Backend `npm test` **215/215**.<br>• `how-it-works.html` checked with its own `validateScenarios()` in Node: 10 scenarios, 114 steps, no problem.<br>• Your `BE/.env` still equalled the committed example, so it now names the v2 images.<br>• Docs: both runtime READMEs (protocol v2, "What changed in v2", spaced JSON for Python), README, the dev guide, `how-it-works.html`, the CLI plan, the migration plan's §4.5. |
| P-05 Console fixes | ✅ Done | `ace7352` | • L0: `npm run build` in `FE/` passes (type-check and bundle). `npm run lint`: 2 problems left, both in `MetricsDashboard.tsx`, which P-50 replaces (16 before).<br>• L1 (new, `npm test` in `FE/`, Vitest): **16/16**: the fields an edit sends, never one the API refuses; the API's error message, including validation lists; invoke input; memory in MB as sent.<br>• The check of create, invoke, history and edit, scripted in headless Chrome against the dev stack (backend on a scratch database, k3d, the console on Vite): **16/16**. Create from the form; the list card; invoke with input (`{"input":…}` sent), with empty input (`{}`), with a function error (the API's message inline, the page kept, the `ERROR` entry in the reloaded history); a JSON array refused without a request; an edit sends only `{"name":…}`; scaling read-only; no page errors. **Against the old console, it fails at the list card, memory, duration and the empty input.**<br>• Backend `npm test` 215/215 (unchanged).<br>• Found while checking, and handed on: the narrow layout and the unreadable primary button (P-14); a failed invocation's memory and duration (P-20 already covers them).<br>• Docs: README (the dashboard's state, the L1 row), getting-started (step 8, tests), `how-it-works.html` (the history request, checked with `validateScenarios()`). |
| P-06 Concurrency and autoscaling | ✅ Done | `e44d711` | • The model is recorded as D14.<br>• L1 backend `npm test`: **16 suites / 247 tests** (was 215). New: `decideReplicas` on concurrency (13 cases), `burstTarget`, the tracker; the burst scale-up (one read per new high, the cap, a retry after a failure, a count that's already enough left alone); the per-minute step-down, including quiet functions; no sweep while a call runs; the scaling route's rules; the driver's cold start (scales only from zero, waits for one instance), timeout, NaN refusal and the 429 mapping.<br>• L1 runtimes: Node.js **31/31**, Python **29/29**, each with two new cases for the queue wait (a 100 ms limit, and the one-timeout default).<br>• L1 console: **22/22** (6 new, for the limits form).<br>• L2 `npm run test:db`: **8/8**. New: the migration keeps existing rows and their limits, and reverts with rows in every table, where the generated `down()` would have failed. `migration:check` OK with 2 migrations.<br>• L2 images: 24-v2 **8/8**, 3.13-v2 **11/11**, rebuilt.<br>• L3 (new `functions.scaling.it.spec.ts`): four 3 s calls at once all succeed and the function reaches two instances; twelve later calls are spread over both; a quiet minute steps it back to one. **4 runs out of 4.** Whole L3 suite **17/17** in 5 min 48 s.<br>• L4 `hack/e2e.sh`: **25/25**, with three new checks of the scaling route (a change, min above max, max above 10).<br>• The console check in headless Chrome: **17/17**, with the editable limits.<br>• Found while verifying: the L3 fixture had no database defaults, so `minInstances` was `undefined`, a computed replica count was `NaN`, and the driver sent `null`, which Kubernetes took as zero. The fixture now has the defaults, and the driver refuses such counts. P-03's lifecycle suite had been passing with `NaN` replicas, which Kubernetes read as one.<br>• Docs: D14, `how-it-works.html` (data model, defaults, the metrics scenario, the queue and timeout; checked with `validateScenarios()`), getting-started (scaling, limits, troubleshooting), both runtime READMEs, README, dev guide. |
| P-07 Cluster permissions | ✅ Done | `9448c32` | • `hack/k8s/test-rbac.sh`: **31/31** (was 25), twice: after applying `dev/` by hand, and after `cluster-up.sh` applied it. New checks: the base ClusterRole lists no `services/proxy`; without the dev binding there is no Service proxy, in a tenant namespace or elsewhere; the overlay grants it again; a proxy call into a managed namespace passes the policy, and one into `default` is denied.<br>• Without the new `CONNECT` rule, applied for a moment, the proxy call into `default` got past admission: the check would fail.<br>• L1 `npm test`: **248/248**, with a new case refusing a valid but different prefix (`ff-u-`).<br>• L4 `hack/e2e.sh`: **25/25**, invoking through the overlay's proxy and the policy.<br>• Your `BE/.env` still equalled the committed example, so it now has the prefix comment too.<br>• Docs: `deploy/k8s/README.md` (the overlay, the proxy policy, the decision on reads), the dev guide, getting-started, README, `how-it-works.html` (checked with `validateScenarios()`), `BE/.env.example`. |
| P-08 API and documentation fixes | ✅ Done | `edb8023` | • L1 `npm test`: **17 suites / 253 tests** (was 16 / 248). New: the OpenAPI document, where every documented route (10) is called on a local server and must answer the documented status, and invoke is documented as 201; `KubeRequestTimeoutError`, and a refused connection that isn't one; a proxied call that gets no answer becomes `FunctionTimeoutError`, while other proxy failures pass unchanged.<br>• **Against the old code:** the document test fails at exactly `POST /functions/{id}/invoke` (documented 200, answered 201). With the mapping removed, the client and driver tests fail.<br>• L3 `functions.lifecycle`: **4/4** in 3 min. New: a runtime that answers its probes but never an invocation. Through the API server proxy, the call is recorded as `TIMEOUT` with `Sandbox.Timedout: No response within 8000 ms`. **Without the mapping, it is `ERROR` with the Kubernetes request message: the finding of §1.6, reproduced.**<br>• A probe of the API server proxy with a Service that never answers: the client gave up at 4,031 ms and 75,075 ms, and the API server never answered first.<br>• L4 `hack/e2e.sh`: **25/25**, unchanged.<br>• `how-it-works.html`: `validateScenarios()` finds no problem (10 scenarios, 114 steps).<br>• Found while checking: the backend's linter has no configuration. It is now in §1.7, and P-09 adds one.<br>• Docs: the migration plan (K-03, K-06), `how-it-works.html` (the backend's wait, the limits, the 429 row), the dev guide and README (the new L3 case). |
| P-09 Dependency upgrades | ✅ Done | Part 1: `66921b5`<br>Part 2: `bef41a6`<br>Part 3: `9759a96`<br>Part 4: `f2b7988`<br>Part 5: `676298b` | • Part 1, the backend's non-breaking fixes. `npm audit --omit=dev`: **0 critical, 4 high, 12 moderate, 1 low** (was 3 critical, 11 high, 11 moderate, 1 low).<br>• L0 `tsc` exit 0. L1 `npm test` **253/253**. L2 `npm run test:db` **8/8** and `migration:check` OK on TypeORM 0.3.31: the new version sees the same schema. L4 `hack/e2e.sh` **25/25**.<br>• Part 2, NestJS 11.2.7 with Express 5.2.1. `npm audit --omit=dev`: **0 critical, 0 high, 6 moderate.**<br>• L0 `tsc` exit 0 and `nest build`. L1 `npm test` **254/254**, with a new test: the document and its viewer are served at `/api-json` and `/api`, as `main.ts` serves them. L2 `npm run test:db` **8/8**, `migration:check` OK. L3 `hack/k8s/test-it.sh` **18/18** in 6 min 19 s. L4 `hack/e2e.sh` **25/25**.<br>• Part 3, the AWS SDK's S3 client instead of minio. `npm audit --omit=dev`: **0 critical, 0 high, 2 moderate**: one finding, `js-yaml` in `@nestjs/swagger`, accepted.<br>• L0 `tsc` exit 0. L1 `npm test` **18 suites / 261 tests**, with the new storage suite (7). Undoing the checksum setting, or the path-style addressing, fails it. Found while writing it: under Jest, the SDK wraps Node's connection errors (they come from another realm), so that test checks the log line, not the reason.<br>• L4 `hack/e2e.sh` **28/28**, with three new archive checks. They passed on minio 7 first, then on the new client, against an empty SeaweedFS: the bucket was created at startup.<br>• `how-it-works.html`: the archive requests as the SDK sends them, captured from a local server; `validateScenarios()` finds no problem.<br>• Part 4, the backend's linter. `npm run lint`: **0 problems** (218 at first: 171 in tests, 47 in production code).<br>• L0 `tsc` exit 0. L1 `npm test` **19 suites / 266 tests**. New: the console log format (3); a token subject that isn't a string or a number; an error without a message of its own, recorded with its causes. **Each fails when its fix is undone.**<br>• L3 `hack/k8s/test-it.sh` **18/18** in 6 min 2 s. L4 `hack/e2e.sh` **28/28**.<br>• Part 5, the console, the runtime, and the backend's dev tools. `npm audit --omit=dev`: console **0** (was 1 critical, 5 high, 3 moderate once the bundled libraries counted), runtime **0**. With dev tools: console **0** (was 41), backend 1 critical (`handlebars`, open until P-11) and 21 moderate (was 36 with 30 high).<br>• Console: L0 `npm run build`; L1 `npm test` **22/22** on Vitest 5.0.3; `npm run lint` the same 2 errors in `MetricsDashboard.tsx` (P-50). The browser check of create, invoke, history, edit and scaling against the backend on NestJS 11 (cross-origin, so CORS on Express 5 too): **17/17**.<br>• Backend on Jest 30.5.2: L1 **266/266**, `npm run lint` 0, L2 **8/8** and `migration:check` OK, and both test-path filters still select the right files. L3: the first run had **17/18**; the gVisor network case's 128 MB Node.js function passed its 10 s start-up limit. Its suite passed **12/12** when run again; the start-up time is now a P-62 item.<br>• Docs: `FE/README.md` (commands; dependencies are what ships; the known gaps, three of which P-05 and P-06 had fixed), P-11 and P-62. |
| P-10 Principal and account-scoped services | ✅ Done | `6ab4be8` | • L0: `tsc` exit 0, `npm run lint` 0 problems.<br>• L1 `npm test`: **20 suites / 295 tests** (was 19 / 266). New: every scoped method called with another account's ID gives the same 404 as a missing function, with nothing written or called (6), while each works for the owner (6); the list; the account in the history query itself; the principal (dev account, `X-FF-Dev-Account`, its format, 401 outside development); request IDs and error answers over HTTP (5); load errors from the runtime's log and from `waitUntilReady`; platform failures generic, with the details in the log; 429; metrics scoped.<br>• **Mutation checks:** without the account in `findOne`, 6 tests fail; without it in the history query, 1; with the handler outside the request context, 1; with a platform error's details in the answer, 1.<br>• L3 `hack/k8s/test-it.sh`: **18/18** in 5 min 59 s. A real broken function now ends `ERROR` with `The function failed to load: Runtime.ImportModuleError: Error: boom at init`.<br>• L4 `hack/e2e.sh`: **28/28**, after moving its stack to `hack/lib/e2e-stack.sh`.<br>• **L5 `hack/e2e-tenancy.sh` (new): 28/28** in 57 s: 10 routes as account B, 10 anonymously, plus the setup and invariant checks. **With the account taken out of `findOne`, it fails at once**: A could read B's new function.<br>• The console in headless Chrome: **17/17**. The metrics route answers the console's dates, 400 without a period, and 404 for another account.<br>• Docs: `how-it-works.html` (the principal, the account in the queries, the load error, request IDs; `validateScenarios()` no problems), getting-started (`X-FF-Dev-Account`, errors, troubleshooting, L5), README (status, L5 row), the dev guide, the CLI plan, and this plan (§1.1, P-11, P-15, P-43). |
| P-11 Keycloak and the global guard | ✅ Done | `ad7ce60`, and the route's rename to `/healthz` in `058ae32` | • L0: `tsc` exit 0, `npm run lint` 0 problems.<br>• L1 `npm test`: **21 suites / 318 tests** (was 20 / 295). The guard's suite (23), through HTTP, with tokens signed locally and keys served by a fake issuer: a valid token's user recorded, and 403 for an account route; 401 without a token, for another scheme, an empty bearer, an API key, an expired token, another issuer, another audience, `nbf` ahead, no or a non-string subject, a key that isn't the realm's, a key the realm never had, `alg: none`, an HMAC token signed with the public key, a broken signature; 30 s of skew accepted; 403 for an unverified e-mail; the key cache, refetched after the cooldown for a rotated key, not for forged key IDs; `@Public()`; development mode; a generic 500 when the keys can't be read. Five runs in a row pass.<br>• **Mutation checks:** without the audience check, the e-mail check, or the `@Public()` check, one test fails each.<br>• **L5 `hack/e2e-tenancy.sh`: 44/44** in 1 min 18 s (was 28), now with Keycloak 26.7.5: 401 through the guard on every route but `GET /healthz` (named `/health` in that commit); two real users logged in through `ff-e2e` get 403 `This user has no account yet` on every account route; a tampered token and an `admin-cli` token get 401.<br>• L4 `hack/e2e.sh`: **28/28** (development mode passes through the guard).<br>• By hand: the development realm imported, a user created through the admin API, and a token through `ff-e2e` with `iss` `http://localhost:8180/realms/ff`, `aud` `ff-api`, `email_verified`. The probe user was deleted afterwards.<br>• `how-it-works.html`: `validateScenarios()` finds no problem, and headless Chrome no page error. The validator caught two unescaped apostrophes first.<br>• Your `BE/.env` still equalled the committed example, so it now has the new authentication notes.<br>• The OpenAPI document test covers the health route too.<br>• Docs: getting-started ("Log in with Keycloak", troubleshooting), README, the dev guide, `BE/.env.example`, `how-it-works.html`, and this plan (§1.1, P-11, P-12, P-14, P-60). |
| P-12 Accounts, users and sign-up | ✅ Done | `7b93545` | • L0: `tsc` exit 0, `npm run lint` 0 problems.<br>• L1 `npm test`: **22 suites / 340 tests** (was 21 / 318). New: the guard with accounts, roles and approval (a user acting for a member's account; owners and developers deploy, a viewer can't; pending, rejected, suspended and closed accounts each refused with their reason; development mode's account created, and `X-FF-Dev-Account` checked); each real function route's rules; the e-mail settings, refused in production when missing, an SMTP URL never echoed; the one-column foreign keys.<br>• L2 `npm run test:db`: **21/21** (was 8). New: the accounts migration keeps every function and makes its tenant an active account, refuses an old tenant and changes nothing, and reverts with rows present. The accounts service on real PostgreSQL (12): the user created once, even by two first calls at once, and following an e-mail change; a pending account with its owner and your e-mail; one waiting account per user; choosing among accounts (none, one, several, a named one, one that isn't yours); members read and only owners change; `GET /me`; development accounts created once. `migration:check` OK with 3 migrations.<br>• **Mutation checks:** `X-FF-Account` able to name any account fails 2 L2 tests; invoke without the approval rule fails the route-rules test.<br>• **L5 `hack/e2e-tenancy.sh`: 71/71** (was 44). New: sign-up through Keycloak's own form, with the e-mail verified through Mailpit and the password set; the user created on the first call; a pending account that can't deploy, and your e-mail about it; approval in SQL; then account 2 on account 1's function and account, on all 15 routes: 404 each time, and nothing changes; `X-FF-Account` naming another's account: 404; a user in two accounts asked to name one.<br>• L4 `hack/e2e.sh` **28/28**. L3 `hack/k8s/test-it.sh` **18/18** in 6 min 10 s, on the account naming.<br>• Console: `npm test` 22/22 and the build, with `accountId`.<br>• `how-it-works.html`: the data model drawn with the seven tables and their keys (checked in a headless Chrome screenshot), `accountId` in the SQL and JSON, the guard's account choice; `validateScenarios()` no problem, no page error.<br>• Your `BE/.env` still equalled the committed example, so it now has the e-mail settings.<br>• Docs: getting-started (accounts, approval, `X-FF-Account`, troubleshooting), README, the dev guide, `BE/.env.example`, and this plan (§1.1, §5, P-12, P-13, P-14, P-71). |
| P-13 API keys | ✅ Done | `ba4fdf5` | • L0: `tsc` exit 0, `npm run lint` 0 problems; `migration:check` OK with 4 migrations.<br>• L1 `npm test`: **23 suites / 352 tests** (was 22 / 340). New: the key format (exact pattern, random IDs and secrets, parsing, only a hash kept, constant-time check); the guard with keys (their own account and scopes, the scope a route names, a route that names none refused, an invalid key); each function route's scope; the key routes in the OpenAPI document test.<br>• L2 `npm run test:db`: **28/28** (was 21). New (7): a key shown once with only its hash stored, never listed; the creator's current role, demoted at once, and a creator who left; one answer for a wrong secret, an unknown key and a malformed one; revocation, not by another account, the first one standing; expiry; the 20-key limit; `last_used_at` at most once a minute. The older migration tests now step back to a named migration, so new migrations don't move where they start.<br>• **Mutation checks:** without the scope check, a guard test fails; without the secret check, an L2 test fails.<br>• **L5 `hack/e2e-tenancy.sh`: 97/97** (was 71) in 1 min 38 s. New: account 1's key lists and invokes its functions (P-13's L4), but can't change one without `functions:write`, nor call `/me` or `/api-keys`; account 2's key gets 404 on every route of account 1's function; account 2 neither sees nor revokes account 1's key; revoked, the key stops at once; the key routes in development mode and anonymously.<br>• Docs: getting-started (keys with curl, troubleshooting), README, `how-it-works.html` (`validateScenarios()` no problem), and this plan (§5, P-13, P-15). |
| P-14 Console login and account pages | ✅ Done | `2ae1001` | • L0: `npm run build` in `FE/` passes (type-check and bundle); `npm run lint` 2 problems, both in `MetricsDashboard.tsx` (P-50), as before. Backend `tsc` exit 0, `npm run lint` 0 problems.<br>• L1 console `npm test`: **8 files / 88 tests** (was 1 / 22). New: the settings; through the real axios client, the token and `X-FF-Account` on each request, a renewed token used at once, a 401 that ends the session with the API's reason, and a 403 that doesn't; renewal before expiry, one renewal for the requests of a moment, none without a user, no token after a failed one; the account chosen (remembered, else the first active one, else none); what each status shows; a return path that never leaves the site; the login page's notices; the onboarding and settings bodies; key states, expiries and prefixes; and `contract.test.ts`: the console's port, client and scopes against the realm and the backend's files.<br>• **Mutation checks:** without `X-FF-Account`, the shared renewal, the remembered account, the `//` check, the 401 hook or `<=` for expiry, with the realm back on 5173, or with `''` for an emptied tax ID: 1 to 3 tests fail each.<br>• L1 backend `npm test`: **24 suites / 355 tests** (was 23 / 352). New: a real preflight from the console's origin: the token, `X-FF-Account` and JSON allowed, the request ID readable, another origin refused. With the old CORS options, 2 of the 3 fail.<br>• **The full flow, scripted in headless Chrome** (puppeteer-core, kept outside the repository) against a throwaway stack: its own PostgreSQL, S3, Keycloak 26.7.5 and Mailpit, the backend in both modes, and the k3d cluster, all removed after: **53/53**. Development mode (15): no login, the development account in `X-FF-Account`, the layout at 1280 and 390 px wide, white-on-blue primary buttons and links, the account and key pages' notes. With the login (38): sign-up through Keycloak's form (`prompt=create`), the address verified through Mailpit and the password set, back in the console without the code in the address; onboarding; the pending page, and your e-mail; account settings sending only the changed tax ID; approval in SQL, then "Check again"; a function created and invoked with the token and `X-FF-Account`; the token renewed with the refresh token, and the new one used; an API key shown once, used to read and invoke, refused outside its scopes, listed by its prefix, revoked and refused at once; a second account and the switcher; a deep link in a new tab, logged in through the existing session; logout ending the Keycloak session; logging in again to the account chosen last; the session ended at the realm, and the login page with the API's reason; no script error in the console. Keycloak's own registration page logs one script error (`Cannot read properties of null (reading 'addEventListener')`), which doesn't stop sign-up.<br>• **L5 `hack/e2e-tenancy.sh`: 97/97** in 1 min 33 s, its sign-up now coming back to port 5199.<br>• Your `BE/.env` still equalled the committed example, so its `CORS_ORIGIN` now says 5199. Your development Keycloak still holds the realm it imported with port 5173: reset it before logging in to the console (getting started, "Reset Keycloak").<br>• Docs: getting started (the console with a login, resetting Keycloak, troubleshooting), README, `FE/README.md` (settings, how the login works), `FE/.env.example`, the dev guide, `how-it-works.html` (a "Log in to the console" scenario with Keycloak, and Keycloak on the map; `validateScenarios()` no problem, no page error in headless Chrome), and this plan (§1.5, P-11, P-14, P-16, P-60, P-71). |
| P-15 Plans, quotas and rate limits | ✅ Done | `0f0d6e3` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 5 migrations; console `npm run build` passes, and `npm run lint` has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **26 suites / 393 tests** (was 24 / 355). New: plan limits checked, a missing, unknown, too large or misshapen one refused with the plan named; the plan's limits on create, update and scaling, each refusal naming the limit, only changed values checked, a larger plan's limits accepted, the count under the account's lock, and "1 function"; the plan's quota on deploy and update, and at once on a plan change, but not before the account's first function; `THROTTLED` for a runtime's 429; the idle window per plan, with one query for every candidate; the retired variables refused. Through HTTP, the rate limits: one count per account across routes, reads free, invocations apart and per second, each account its own count from the same address, the plan's sizes, callers without an account by address, 429 `TooManyRequestsException` with `Retry-After`; only invoke counts as an invocation.<br>• **Mutation checks:** without the account lock (L2), the per-account key, the account tracker or the reads exemption; with a fixed quota, `ERROR` instead of `THROTTLED`, unchanged values checked, a fixed idle window, or `>` for the count: 1 to 4 tests fail each.<br>• L2 `npm run test:db`: **36/36** (was 28). New: the migration gives beta its limits and adds `THROTTLED`, and reverts with a throttled invocation present; plans read, kept a minute or read fresh, per account and for several accounts in one query; a broken plan refused; a plan change applied to the namespace; unknown plans and accounts refused; three creates at once for an account's last function, of which one passes (a trigger slows each insert by 200 ms, so without the lock all three would).<br>• L3 `hack/k8s/test-it.sh`: **19/19** (was 18) in 6 min 14 s: the plan's quota in a real namespace, rewritten at once by a plan change.<br>• L4 `hack/e2e.sh`: **39/39** (was 28) in 73 s. New: the beta plan's quota and instance limit; an account moved to a small plan in SQL: memory over its limit refused, its one function created and a second refused, its namespace's quota, five changes then 429 with `Retry-After` and the plan's limit, reads free, two invocations a second then 429, and another account from the same address unaffected.<br>• L5 `hack/e2e-tenancy.sh`: **97/97** in 1 min 41 s.<br>• Console `npm test`: **9 files / 92 tests** (was 8 / 88): plan-aware scaling checks, the limits list, and the plan's limit names against the backend's. P-14's browser check again, against a throwaway stack: **55/55**, with the plan's limits on the create form and the account page.<br>• Your `BE/.env` equalled the committed example, so it no longer sets the retired variables.<br>• Docs: getting started ("Plans and limits", changing plans in SQL until P-73, troubleshooting), README, `FE/README.md`, `BE/.env.example`, `how-it-works.html` (the limits table, the create and idle steps, the guardrails; `validateScenarios()` no problem, no page error), and this plan (§1.1, §1.2, D14, P-15, P-16, P-20, P-50, P-62, P-71, P-73). |
| P-16 Members and invitations | ✅ Done | `ae51704` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 6 migrations; console `npm run build` passes, `npm run lint` as before (2 in `MetricsDashboard.tsx`, P-50).<br>• L1 backend `npm test`: **27 suites / 401 tests** (was 26 / 393). New: the five member routes, owners only and with no scope, so no API key; the guard lets a token's user join the accounts that invited its address before choosing the account, and never for a key or in development mode; `FF_CONSOLE_URL` refused at its development default in production.<br>• L2 `npm run test:db`: **48/48** (was 36). New (12): an invitation in lowercase, for seven days, e-mailed with the console's link; inviting again renews it with the new role; a member can't be invited, whatever the case; 50 open invitations at most; the invited user joins on the next call, once; nobody joins with an expired invitation or another address; a member invited again keeps their role; the list, and cancelling, not another account's invitation; roles changed and members removed, always keeping an owner; two owners demoting each other at once leave one owner (a trigger slows each update by 200 ms); a removed member's API keys stop at once; another account's member: 404.<br>• **Mutation checks:** without the account lock, with `< 1` for the last owner, without the expiry, without lowercasing, without `orIgnore`, or without the guard's call: 1 or 2 tests fail each.<br>• **L5 `hack/e2e-tenancy.sh`: 126/126** (was 97) in 1 min 41 s, P-16's L4 among them: account 1's owner invites user 2's address, user 2 gets the e-mail with the console's address and joins on the next call as a viewer, reads but can't invoke, invokes once a developer, can't manage members, and is removed; the last owner can't leave; the member routes in development mode, anonymously and across accounts, where they never reach account 1's members or invitations.<br>• L4 `hack/e2e.sh`: **39/39**. L3 not run again: no change to the cluster code.<br>• Console `npm test`: **9 files / 94 tests** (was 92): what each role may do. The browser check: **65/65**, with a members phase (10): the owner invites a second user, who joins at login as a viewer without create or delete buttons, nor the members page; made a developer, they can create; the last owner can't leave, the page says why and stays (the check found the page leaving even then, now fixed); removed, the member gets the onboarding page.<br>• Your `BE/.env` equalled the committed example, so it now has `FF_CONSOLE_URL`.<br>• Docs: getting started (members with curl, the console's "Members", troubleshooting), README, `FE/README.md`, `BE/.env.example`, `how-it-works.html` (the `invitations` table in the data model, `THROTTLED` in the invocation lifecycle; `validateScenarios()` no problem, no page error), and this plan (§5, P-16, P-17). |
| P-17 Audit log | ✅ Done | `db4d11a` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 7 migrations.<br>• L1 backend `npm test`: **28 suites / 415 tests** (was 27 / 401). New: through HTTP and the real request interceptor, an entry names a user by ID and e-mail, an API key by ID and name, development mode, or FF outside a request, with the address and the request's ID; an actor given explicitly is kept; a record that can't be written is logged without failing the change; one written through the caller's transaction fails with it; `GET /audit-log` is the owners' and takes no key. The functions service records a creation in the transaction that saves it, even when the deploy fails later; an update's changed fields and values, never the code; a rename; nothing for an update that changes nothing or is rolled back; a failed attempt that was kept; deletions and scaling changes; nothing for a failed delete.<br>• L2 `npm run test:db`: **52/52** (was 48). New: `UPDATE`, `DELETE` and `TRUNCATE` refused, even to the database's owner; each account's entries only, newest first, a page at a time; FF as the actor outside a request; the member events with their actors, the joining user with the address and request ID.<br>• **Mutation checks:** without the trigger, the key's actor or the request's ID, with a function's creation recorded outside its transaction, with pages not scoped to the account, or with the joining user not named: 1 or 2 tests fail each.<br>• L5 `hack/e2e-tenancy.sh`: **134/134** (was 126) in 1 min 51 s. New: account 1's log has each change in order (`account.create`, `function.create`, `api_key.create`, `member.invite`, `api_key.revoke`, `member.invite`, `member.join`, `member.role`, `member.remove`), naming user 1 or user 2 who joined, with addresses and request IDs; account 2's log and development mode's name nothing of the other accounts; keys and anonymous callers refused; a page of nothing refused.<br>• L4 `hack/e2e.sh`: **39/39** in 80 s. L3 `hack/k8s/test-it.sh`: **19/19** in 6 min 16 s.<br>• Docs: getting started (the audit log with curl), README, `how-it-works.html` (`audit_log` in the data model; `validateScenarios()` no problem, no page error), and this plan (§5, P-17, P-20, P-45, P-60, P-70). |
| P-20 Usage records | ✅ Done | `3b3e750` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 8 migrations; console `npm run build` passes, and `npm run lint` has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **30 suites / 453 tests** (was 28 / 415). New: D7's table, one case per row, and how each failure ends; the record copies the function as invoked, with the cold start apart; the driver sends `X-FF-Request-Id` through the proxy and, against a local server, on a direct call; failed calls keep the runtime's measures, and `0.00` ms counts; the cold start's time, on success, after a failure, and when it never became ready; the service writes the record in the transaction that ends the call, locks the row first, leaves a `LOST` call as it is, bills a call whose function was deleted, and times a call itself without the cold start; the partitions by the UTC calendar on both sides of a month's end, before the first call, and the jobs' timers.<br>• L2 `npm run test:db`: **65/65** (was 52). New: the record written with the final state through the real invoke path; untouched when the function changes or is deleted; `UPDATE`, `DELETE` and `TRUNCATE` refused, on the table and on a month's partition; a second write a no-op; neither written when the record fails, nor when the final state fails at commit; the reaper's deadline (two timeouts, the configured cold-start limit, 30 s; the platform's maximum for a function changed since), each lost call with an unbilled record, and a second pass that finds nothing; a call that ends after the reaper, or while it writes, stays `LOST`; a call that ended while the reaper looked keeps its outcome; partitions with UTC bounds from a session 14 hours ahead, and a month without one refused; the migration adds `LOST` and reverts with a lost invocation present.<br>• **Mutation checks:** 23 in the backend (the request ID in either mode, the measures, `0.00`, the cold start on a failure, D7's rows, the load error's status, the lock, the deleted function, the transaction, the reaper's deadline, its changed-function rule, its setting and its guard, the partitions' trigger and bounds, the append-only trigger, a second write, the migration's down), and 2 in the console: each one fails 1 to 5 tests.<br>• L4 `hack/e2e.sh`: **55/55** (was 39) in 167 s. New: a cold start, recorded and not billed; the handler's `context.awsRequestId` is the invocation's ID, and the runtime's log names the call by it; records for a success, an error (with the runtime's memory now in the history) and a timeout (billed 3,000 ms), matching the history to the millisecond; the backend killed with `SIGKILL` during a call, restarted at once, marks it `LOST` within the minute, unbilled, and every invocation has exactly one record.<br>• L3 `hack/k8s/test-it.sh`: **19/19** in 6 min 14 s, with a new check: a call the runtime never answers is recorded as a timeout, billed the function's 3 s. L5 `hack/e2e-tenancy.sh`: **134/134** in 1 min 38 s.<br>• Console `npm test`: **9 files / 95 tests** (was 94): its invocation statuses equal the backend's, with `THROTTLED` (P-15) and `LOST` (P-20) added; a status without a style fails the type check.<br>• Found while verifying: a partition can be emptied on its own (`TRUNCATE usage_records_2026_10`), which the table's trigger doesn't stop, so each partition gets its own trigger; the record's times lose PostgreSQL's microseconds, the same way for every writer, so a record is still written once. The first L3 run caught that its in-memory repository lacked the `findOne` that `finish()`'s lock needs. L4's cold start first raced the backend's autoscaler, which steps up a function that had calls in the last minute, so the check now runs before the function's first call.<br>• Your `BE/.env` equalled the committed example, so it has the new comment on `K8S_READY_TIMEOUT_SECONDS`.<br>• Docs: getting started (the request ID, usage records, lost calls, troubleshooting, L4's time), README, `FE/README.md`, the dev guide (L4's steps), `BE/.env.example`, `how-it-works.html` (the request ID, the metered invoke, cold start, error and timeout, a new scenario for a lost call, `usage_records` and `api_keys` in the data model, `LOST` in the lifecycle, the limits; `validateScenarios()` no problem in 12 scenarios and 135 steps, no page error, diagrams checked in screenshots), and this plan (§1.2, §1.4, D6, P-20 as built, P-21, P-22, P-32, P-45, P-50). |
| P-21 Capacity samples | ✅ Done | `488f354` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 9 migrations.<br>• L1 backend `npm test`: **32 suites / 467 tests** (was 30 / 453). New: against the fake Kubernetes API, one list of FF's Deployments in every namespace, by their label, counting ready instances, and leaving out a Deployment without a ready one, without a function ID, or outside `ff-t-*` namespaces with a copied label; the sample's timing, 5 s into each minute, this one's if still to come; one call and one statement a minute; nothing written without a ready instance, and an ID that isn't one left out; a failed sample logged, and the next minute sampled all the same; no sample once the module stops, even one in flight; the report's table, total, gap and empty case; its window by the UTC calendar; `--days`.<br>• L2 `npm run test:db`: **71/71** (was 65). New: a sample copies the account, `minInstances` and memory from `functions`, and skips a function the database doesn't know; a minute written once, the next one apart; the database's minute; a deleted function's samples kept; `UPDATE`, `DELETE` and `TRUNCATE` refused, on the table and a month's partition; the report's GB-s reserved, provisioned and billed per account and UTC day, exactly, with the requests billed, the window's edges, and the same days from a session 14 hours ahead; the migration replaces P-20's partition function and reverts with samples present.<br>• **Mutation checks:** 17 (the namespace check, a Deployment with no ready instance, the label selector, the minute's timing, the ID check, sampling after stop, scheduling after a failure, a minute written twice, the minute's truncation, `minInstances`, provisioned = reserved, throttled calls as requests, days by the session's time zone, the window's end, the append-only trigger, a partition's `TRUNCATE` trigger, the migration's down): each fails 1 to 6 tests. One more, `.then` for `.finally` after the `catch`, behaves the same and was replaced by scheduling only after a success.<br>• L3 `hack/k8s/test-it.sh`: **20/20** (was 19) in 6 min 23 s. New: the cluster-wide list counts the function at 1, 2 and 0 replicas, through the real API server, with the backend's token.<br>• L4 `hack/e2e.sh`: **57/57** (was 55) in 168 s. New: the warm function sampled each minute, with its instances, memory, account and `minInstances`; `npm run capacity:report -- --days 1` shows the account's day with capacity reserved and billed.<br>• `hack/k8s/test-rbac.sh`: **32/32** (was 31), with the cluster-wide list of Deployments the sampler needs.<br>• Docs: getting started (capacity samples, the report, troubleshooting), README, `deploy/k8s/README.md`, the dev guide (L4's steps, RBAC's count), `how-it-works.html` (the sample in the minute's scenario, `capacity_samples` in the data model, where data lives, the reference; `validateScenarios()` no problem in 12 scenarios and 137 steps, no page error, checked in screenshots), and this plan (P-21 as built, P-22, P-32, P-45, P-50, P-75). |
| P-22 Usage API and console page | ✅ Done | `3356fa2` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 9 migrations (none new); console `npm run build` passes, and `npm run lint` has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **34 suites / 490 tests** (was 32 / 467). New: the route lets every member read, in any account state, and a key with `usage:read`; through HTTP with `main.ts`'s validation, this month by the UTC calendar without a `month`, the month asked for, 400 for one that isn't `YYYY-MM` and for another parameter, and CSV for `Accept: text/csv`, as a download named after the account and month; the CSV's header, CRLF lines, RFC 4180 quoting and formula guard; `GET /usage` in the OpenAPI document test.<br>• L2 `npm run test:db`: **75/75** (was 71). New: per function, the most GB-seconds first, with its latest name and whether it was deleted; requests billed apart from throttled, failed and lost calls; the totals equal the raw records' sums, exactly, checked in BigInt arithmetic, and the functions add up to them; GB-seconds that need all 13 decimals; a month's first and last instants by the UTC calendar; only the account's records; an empty month.<br>• **Mutation checks:** 15 (no total row, every call as a request, every account's records, the next month's first instant, the deleted flag, the oldest name, GB-s rounded to 6 decimals, the formula guard, the quoting, CSV never chosen, another scope, any two digits as a month; in the console, 0 shown for a tiny use, an amount the API lacks, last month by the local calendar): each fails 1 to 7 tests.<br>• Console `npm test`: **10 files / 113 tests** (was 9 / 95): the months by the UTC calendar, their labels, durations and GB-seconds to read, never 0 for a use, why calls weren't billed, the CSV's name; the amount names against the API's.<br>• Browser check of the Usage page in headless Chrome, against a throwaway stack (backend in development mode, k3d, the console on Vite): **10/10**. The header's Usage link, this month selected, the totals and the function's row with its link, the CSV downloaded under its name with the function's line, last month empty, a deleted function kept without a link, no sideways scrolling on a desktop or a phone, no page errors. Its first run found the header's links overflowing a phone with the new link; they now wrap.<br>• L4 `hack/e2e.sh`: **64/64** (was 57) in 170 s. New: `GET /usage` against the raw records for the metering function and the account's totals, exactly; the deleted Python function's usage, marked deleted; CSV; an empty month; a malformed one refused.<br>• L5 `hack/e2e-tenancy.sh`: **142/142** (was 134) in 1 min 43 s. New: A's usage counts its call; B's and account 2's never count the other account's function; 401 without a login; a key without `usage:read` refused, one with it reading its own account only; a viewer reads the account's usage.<br>• Docs: getting started (the month's usage, with curl), README, `FE/README.md`, the dev guide (L4's steps), `how-it-works.html` (a scenario for reading the month's usage, where data lives, the reference; `validateScenarios()` no problem in 13 scenarios and 141 steps, no page error, checked in a screenshot), and this plan (§5, P-22 as built, P-30). |
| P-30 Prices and price book | ✅ Done | `e5e915f` | • The rates of the day, on 2026-10-17: AWS's Lambda prices re-read from its price list API (published 2026-10-16) equal D8's, the higher tiers included; the BCT's latest average interbank rate was 3.0080 TND per US$, of 2026-10-14 (its archive gives that day for the 15th to the 17th, and 2.9123 for D8's 7 September).<br>• L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 11 migrations; console `npm run build` passes, and `npm run lint` has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **41 suites / 579 tests** (was 39 / 555). New: exact decimals (sums, products, divisions by powers of 2 and 5 only, rounding half away from zero once, never `-0.000`); AWS's two examples from its pricing page, rated with the first book, equal AWS's formula in US$ times the rate to every decimal (8.221880704 and 60.047633152 TND); no free tier for calls on provisioned concurrency; each function before the free tier, which comes off the total; the second and third duration tiers; the free tier and tiers counted through a book that starts mid-month; the idle-time and monthly-fee knobs; the first book's TND prices, each the US$ price times the rate, exactly; refused books, naming the problem. `GET /usage` through HTTP: each function's cost, the estimate, a line for a function that cost something without a call, null without a book, the CSV's costs. The invoke path's record copies minInstances.<br>• L2 `npm run test:db`: **113/113** (was 105). New: TND and the first book as the migration loads them; a started book never changed or deleted, the table never emptied, no book added in the past, a future one changed and deleted; old records' minInstances 0; no estimate without a book; a month priced through a mid-month book, each call with its book, the free tier counted from the month's start, the provisioned call and the minInstances that were ready at their prices, the monthly fee from the book at the month's start, another account's call left out; the minimum billed duration applied to each call, idle instance time, and a monthly fee; the books of a month. The invoke path and the lost-call reaper record minInstances; the schema test knows the two tables and the guard, and P-30 reverts.<br>• Console `npm test`: **10 files / 117 tests** (was 113): amounts with their currency and thousands apart, the estimate's lines with only the deductions there are, the note when prices start mid-month; the estimate's fields and each function's cost against the API's.<br>• **Mutation checks:** 29 (25 backend, 4 console). 28 fail 1 to 6 tests. The 29th, a `-0.000` sign, is equivalent: BigInt has no negative zero, so the guard it removed was dead code, now gone. Among the caught: a free tier per book rather than per month, the free tier for provisioned calls, no minimum billed duration, minInstances billed when not ready, the fee from the month's last book, a started book changed, a book added in the past, the first book rounded.<br>• Browser check of the console's Usage page, against a backend in development mode: **12/12** (was 10). New: the estimated cost of the month, 0.000 TND under the free tier; the estimate's lines and how to read them; the function's estimated cost; the CSV's `cost` column; no price for last month, before the first book.<br>• L4 `hack/e2e.sh`: **68/68** (was 64) in 162 s. New: the usage record's minInstances; no estimate before the first book; the month in TND with the first book; the metering function's cost, recomputed in SQL from the book's prices; the free tier covering the month; the CSV's costs. A first run stopped at its first create: the 128 MB Node.js function's cold start passed the 10 s init limit on 0.1 CPU, as P-62 records; it passed when run again.<br>• L5 `hack/e2e-tenancy.sh`: **227/227** in 1 min 53 s, unchanged: every account's `GET /usage` still counts only its own functions.<br>• Docs: getting started (prices and the estimate, with curl), README, `FE/README.md`, the dev guide (L4's steps), `how-it-works.html` (`price_books`, `currencies` and `usage_records.min_instances` in the data model, where data lives, the reference, two steps of pricing in the usage scenario; `validateScenarios()` no problem in 14 scenarios and 151 steps, no page error, no column running into its type), and this plan (§4's first book as built, §5, P-30 as built, P-32's provisioned time aligned with it, P-31, P-32, P-73). |
| P-31 Ledger and wallet | ✅ Done | `adce69b` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 12 migrations; the admin app's `tsc`, `npm run lint` (0 problems) and `npm run build` pass.<br>• L1 backend `npm test`: **45 suites / 609 tests** (was 43 / 596). New: money in minor units, an amount rounded once, half away from zero (three calls of 0.0004 TND are 1 millime, not 0), written with every decimal and its sign, read as typed with more decimals than the currency's refused, exact past 2^53; what makes a posting (D9's top-up, a usage debit, a promotion), and each refusal named: unbalanced, fewer than two entries, an entry of 0, an account twice, a number for a bigint, an account that is not one, no key, a currency that is no code; a replay's entries in any order.<br>• L2 `npm run test:db`: **151/151** (was 123). New, the database, written around the service in SQL: an unbalanced transaction refused at commit with nothing written; entries in any order; each currency summed apart; fewer than two entries; an entry added later that unbalances a transaction; an entry of 0; nothing updated, deleted or emptied; one wallet per account and currency, one of each of FF's accounts per currency, the types there are, a currency FF has, an account that exists. The service: D9's top-up and its entries; the balance, in each currency apart; when and the metadata; a replay answered with the first, nothing written; a key reused with other entries, another kind or another currency refused (409); a wrong posting refused before the database; a wallet for an account that doesn't exist; a posting in the caller's transaction, and nothing when it rolls back; promotions and corrections; the floor (a debit below it refused and named, the floor reached exactly, a credit taken below it, a replay not checked again). At the same moment: fifty debits on one wallet, exact; twenty first postings creating a wallet and FF's accounts in a new currency once; two postings creating the same two accounts in opposite orders, five times, without deadlock; one key twenty times, written once, with a wallet and with FF's accounts alone; thirty debits of 1.000 TND on 10.000 TND with a floor of 0, ten passing. The admin account page's balance, another account's apart; the schema test knows the three tables and the function, and P-31 reverts with entries present.<br>• Admin app `npm test`: **12 files / 69 tests** (was 11 / 66): money with its currency, thousands apart, exact past 2^53; a balance below zero named.<br>• **Mutation checks:** 26 (23 backend, 3 admin app), each caught. Among them: one sum for all currencies, one entry enough, the check on transactions only or not deferred, accounts not append-only, no wallet lock (13, 14 and 16 of the thirty debits passed a floor that allows ten, in three runs), no `ON CONFLICT` on the key or on a new account, a replay that ignores the entries or the currency, the floor checking credits or refusing itself, accounts created in entry order (a deadlock, 3 times out of 3), the balance of every currency, the admin balance in 2 decimals. One first survived, the key's insert without `ON CONFLICT`: its test's twenty postings also created an account, waited on it, and never met at the key. The test now creates the accounts first, and catches it.<br>• Browser check of the admin dashboard: **39/39** (was 38): the account page's balance, 12.500 TND of credit written as one balanced ledger transaction in SQL.<br>• L5 `hack/e2e-tenancy.sh`: **261/261** (was 259) in 1 min 53 s. New: account 1's page has no balance while account 2's has 7.000 TND, through HTTP.<br>• L4 not run: nothing on its path changed (functions, invoke, usage, the estimate); the backend's start with the new providers is in L5 and the browser check.<br>• `handlebars` 4.7.10 is still in its two-week window (eligible from 2026-10-19): it moves to P-32.<br>• Docs: getting started (credit and the ledger, reading balances, the account page, troubleshooting), README (and three lines left from before P-71 and P-73), `admin/README.md`, `how-it-works.html` (the ledger in the data model and its diagram, where data lives, the code; `validateScenarios()` no problem in 14 scenarios and 151 steps, no page error, no column running into its type in 132), and this plan (P-31 as built; P-32 to P-36 and P-74; §5). |
| P-32 Rating and debits | ✅ Done | `9305dd8` | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 13 migrations; the console's and the admin app's builds pass; the admin app's lint is clean, the console's has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **48 suites / 623 tests** (was 45 / 609). New: an hour settles 33 minutes after it ends at the platform's limits, is rated then and not a millisecond before, and the hours missed come in order; the debit's key; `GET /billing/balance` and `/billing/transactions` through HTTP (every member and a `usage:read` key, money as strings, the page and its refusals); the reconciliation's verdict and table; the API document knows the two routes.<br>• L2 `npm run test:db`: **171/171** (was 151). New: each hour charged the month so far, rounded once (0.0004 TND a call gives 0, 1, 0 and 1 millimes, where rounding each hour would give one), debited with its key at the hour, an hour rated again writing nothing, its sums kept with their book; the balance, this month's charges and the transactions a page at a time, another account's apart; an hour out of order refused; shadow mode recorded and not debited, then the next hour debiting only its own charge; a price change at a whole hour, each hour at its book and the month's fee the first book's; a book within an hour refused; the free tier counted again from a month's first hour; minInstances held and its calls at the provisioned prices without the free tier, the monthly fee once; three accounts' six random hours (a minimum billed duration, provisioned calls, samples, unbilled statuses) agreeing with their usage to the millime, and a record that came after its hour shown as a difference; an hour a failure stopped half way finished, each account charged once; the job's first run from the first book, the settling, the catch-up, two backends at once, and how far the rating has come. The preview's charges; the schema test's three tables, P-32 reverting with charges, and the migration naming a book within an hour; `TRUNCATE price_books` refused by the hourly sums' foreign key first.<br>• Console `npm test`: **11 files / 122 tests** (was 10 / 117): the header's balance and the billing trial's note; the balance's fields against the API's. Admin app: 12 files / 69 tests, unchanged.<br>• **Mutation checks:** 26 (23 backend, 3 console), each caught. Among them: earlier months in the month so far or in its earlier charges, shadow mode ignored, no settling, no advisory lock, hours out of order, samples without calls dropped, every book pricing every hour, the fee from the last book, cents for millimes, the wallet credited, the debit dated now, an account charged twice after a stop, the latest hour rated again, the reconciliation or the estimate without their end. Four first survived, each because its effect stayed under half a millime: the minimum billed duration ignored (1 ms calls at 1,024 MB), the end of the hours rated ignored, by the reconciliation or by the estimate it calls (two mutations; a late call of 0.0002 TND), and the balance's charges of every account (the other account's charge was 0). The tests' data now makes each a whole millime or more, and catches it.<br>• Browser checks: the console **15/15** (was 12): the header's balance, 2.500 TND, with "Billing trial" and its title, on every page; the admin dashboard **39/39**, unchanged.<br>• L4 `hack/e2e.sh`: **72/72** (was 68) in 172 s. New: the balance in shadow mode, rated up to the last hour settled; every hour from the first book rated once, none skipped; no debit; `npm run billing:reconcile` against the stack's database.<br>• L5 `hack/e2e-tenancy.sh`: **271/271** (was 261) in 1 min 55 s. New: both billing routes as another account (none of the other's credit or transactions) and anonymously (401); a key without `usage:read` refused, one with it reading its own account's balance; each account's page with its own balance.<br>• `handlebars` 4.7.10 is still in its two-week window (eligible from 2026-10-19): it moves to P-33.<br>• Docs: getting started (the hourly rating, shadow mode, the balance and the reconciliation with curl, troubleshooting), README, `FE/README.md`, `admin/README.md`, the dev guide (L4's steps), `how-it-works.html` (the rating's tables in the data model and its diagram, where data lives, the code, the new scenario "Rate an hour of usage"; `validateScenarios()` no problem in 15 scenarios and 159 steps, no page error, no column running into its type in 154), and this plan (P-32 as built; P-33, P-36, P-74, P-75; §5). |
| P-33 Balance check and spend controls | ✅ Done | (this commit) | • L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 14 migrations; the console's build passes and its lint has the 2 problems of `MetricsDashboard.tsx` (P-50); the admin app, unchanged, builds.<br>• L1 backend `npm test`: **50 suites / 639 tests** (was 48 / 623). New: the rule (down to the buffer, the buffer itself included; the grace period from the fall, stopped at its end exactly; no grace period; a bigger buffer; shadow mode; read from the settings) and the 402's message; the shares of the last credit reached (at a share exactly, once per credit, in exact minor units, the owners' shares, none at all) and the e-mails' text; `GET` and `PUT /billing/alerts` through HTTP (every member and a `usage:read` key read, only an owner with a login sets them, refusals); an invoke refused before anything is recorded or run.<br>• L2 `npm run test:db`: **189/189** (was 171). New: the standing from the ledger (the balance, and when the current stretch below the buffer began, from the first entry too, again after a credit); the NOTIFY at commit to every listener, from SQL by hand too, never on a rollback nor for FF's own accounts; the cached standing dropped by it, and kept a minute at most without; invokes admitted to the buffer, through the grace period, then refused with 402, and let in at once by credit; shadow mode; the settings as they change, the buffer included; the balance's credit state; the e-mails (the owners only, once per share, the lowest share named, the next credit starting again, the owners' shares, a charge given back being no credit, nothing without a credit or a share, one e-mail when two backends hear the write, sent by itself after a write); the owners' shares, kept with their change in the audit log, the same written once, null back to FF's, refused out of order. The schema test's table and function, and P-33 reverting with e-mails sent and an owner's shares.<br>• Console `npm test`: **11 files / 127 tests** (was 122): the banner, the Billing page's words, a debit's hour, the shares an owner types; the credit state's fields against the API's.<br>• **Mutation checks:** 24 (20 backend, 4 console), each caught. Among them: the buffer itself refused, the grace period's end still admitted, shadow mode enforced, the cache never dropped or kept ten minutes or across buffers, the last entry below rather than the stretch, FF's accounts notified, any positive entry a credit, a share not reached at it or named again, two backends both sending, the highest share named, every member e-mailed, invokes not checked, the owners' shares ignored, the grace counted from now. Three first survived: the buffer refused (the standing never has a "since" at the buffer, so the L1 test now pins the rule's own boundary), the cache across buffers (the test changed the buffer and back, so a stale standing was right again; the order now catches it), and a share named again (run against the DB test, where the share's row stops a second e-mail anyway; the L1 test catches it).<br>• Browser check of the console: **27/27** (was 15): the Billing page (the balance, this month's charges, invokes going on in the trial, the credit, an owner's shares set, refused out of order and set back to FF's); shadow mode off and the balance below the buffer: the red banner and its link, the time invokes stopped, an invoke answering 402, a phone's width; a top-up, the banner gone, and invokes going on. The admin app is unchanged: its check not run.<br>• L4 `hack/e2e.sh`: **77/77** (was 72) in 170 s. New: shadow mode off, no buffer and no grace period; a wallet run below zero; an invoke answering 402 and leaving no invocation; the balance saying so; reads going on; a top-up, and invokes accepted at once.<br>• L5 `hack/e2e-tenancy.sh`: **284/284** (was 271) in 1 min 55 s. New: both alerts routes as another account and anonymously; a `usage:read` key reading the shares and refused setting them; a viewer and a developer refused; account 1's owner getting the low-balance e-mail in Mailpit through the ledger's NOTIFY. Both L5 backends now have the SMTP server, as they share the database and either may send.<br>• `handlebars` 4.7.10 is still in its two-week window (eligible from 2026-10-19): it moves to P-34.<br>• Docs: getting started (the balance check, the low-balance e-mails and the Billing page, with curl; troubleshooting), README, `FE/README.md`, the dev guide (L4's step 13), `how-it-works.html` (the balance check in the warm invoke scenario, `low_balance_notices` and the owners' shares in the data model and its diagram, where data lives, the code; `validateScenarios()` no problem in 15 scenarios and 160 steps, no page error, no column running into its type in 160), and this plan (P-33 as built; P-34, P-74; §5). |
| P-34 Konnect top-ups | ⏳ Planned | | |
| P-35 Bank transfers and manual credit | ⏳ Planned | | |
| P-36 Invoices | ⏳ Planned | | |
| P-37 El Fatoora e-invoicing | ⏳ Planned | | |
| P-40 Interim logs endpoint | ⏳ Planned | | |
| P-41 Spike and ADR 0005 | ⏳ Planned | | |
| P-42 Log pipeline in the cluster | ⏳ Planned | | |
| P-43 Logs API | ⏳ Planned | | |
| P-44 Console logs tab | ⏳ Planned | | |
| P-45 Retention of history and logs | ⏳ Planned | | |
| P-50 Metrics API | ⏳ Planned | | |
| P-51 Notifications | ⏳ Planned | | |
| P-52 Alarms | ⏳ Planned | | |
| P-53 Operator monitoring | ⏳ Planned | | |
| P-60 Images and platform manifests | ⏳ Planned | | |
| P-61 Backups and restore | ⏳ Planned | | |
| P-62 Sandbox on, egress per plan | ⏳ Planned | | |
| P-63 CI | ⏳ Planned | | |
| P-64 Security review | ⏳ Planned | | |
| P-65 Legal and support pack | ⏳ Planned | | |
| P-66 Beta rehearsal | ⏳ Planned | | |
| P-70 Admin dashboard foundation | ✅ Done | `9b5749e` | • Done after phase 2, though the plan schedules it right after P-11: P-71's approvals need it for milestone A.<br>• L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 10 migrations; the admin app's `tsc`, `npm run lint` (0 problems) and `npm run build` pass; the console's build passes.<br>• L1 backend `npm test`: **35 suites / 510 tests** (was 34 / 490). New, through a real HTTP server with tokens signed locally: an operator with a token issued to `ff-admin` is let in, and no user, invitation or account is touched; an operator's console token, a customer's token from either client, an API key and development mode are refused, each with its reason; a change needs a reason (missing, too short, not text, too long), asked for only of an operator; an `ff-admin` token calls no customer route. The audit log names an operator `operator:<id>`; each operator has their own rate-limit count; the settings' rules, each refusal naming the setting; `PUT /admin/settings` in the OpenAPI document test.<br>• L2 `npm run test:db`: **82/82** (was 75). New: the defaults until changed; a change with the operator, the reason and each from → to in the audit log; nothing written for an unchanged value; a value that doesn't fit refused, naming it, with nothing changed; a stored value that doesn't fit stops the read, naming it, and an unknown one is left alone; a change rolls back when its audit entry can't be written; two operators' changes to one setting, slowed down to overlap, one after the other, each entry saying what it replaced.<br>• Admin app `npm test` (Vitest): **6 files / 27 tests**: its configuration, the login's settings and the token's single renewal, the reason's rule, each setting's input read or refused, only the changed settings sent, the table's parameters and pages; and, against the realm and backend files, the client `ff-admin` (PKCE, its addresses, the API's audience), the role, the one-time password for that role, port 5198 in the backend's `FF_ADMIN_URL` and development `CORS_ORIGIN`, the settings' names and the reason's length. Console `npm test`: 113/113, its CORS check now one origin of a list.<br>• **Mutation checks:** 16 (the client check, the role check, development mode, API keys, the reason, `ff-admin` tokens on customer routes, the operator in the audit log, operators counted by address, the advisory lock, an entry for no change, the entry outside the transaction, the percentages' order; in the app, a 2-character reason, every setting sent, empty filters sent, the console's client): each fails 1 to 3 tests.<br>• Browser check of the admin dashboard in headless Chrome, against Keycloak with the development realm and a backend in OIDC mode: **16/16**. The login page; Keycloak through `ff-admin`; the operator's first login sets up a one-time password (the code computed from the secret Keycloak shows); the settings with their defaults; a value that isn't one named, with no dialog; the dialog's from → to, which needs a reason; saved and kept; logging out; the next login asks for the one-time password and lets the operator in with it; a customer logging in through `ff-admin` is asked for none and told they aren't an operator; no sideways scrolling, on a desktop or a phone; no page errors. Before it, a probe of the realm: an operator is sent to set up the one-time password, a customer through `ff-console` goes straight through.<br>• L5 `hack/e2e-tenancy.sh`: **157/157** (was 142) in 1 min 42 s. New: every `/admin` route refused in development mode (400), anonymously (401), with a customer's token (403) and with an API key (403); the operator reads the settings, a change without a reason is refused and one with a reason made, the audit log keeping who, why, and what it replaced; the operator's token from another client refused; the dashboard's token refused on a customer route; a customer logged in through `ff-admin` refused.<br>• L4 `hack/e2e.sh`: **64/64** in 168 s, unchanged.<br>• Your `BE/.env` equalled the committed example, so it has the admin origin in `CORS_ORIGIN` and `FF_ADMIN_URL` at 5198. Your development Keycloak still has the realm it imported before: reset it, as getting started says, to log in as the operator.<br>• Docs: `admin/README.md`, getting started (the admin dashboard, the development operator, troubleshooting), README, `how-it-works.html` (`platform_settings` in the data model, where data lives, the components, the reference; `validateScenarios()` no problem, no page error, checked in a screenshot), and this plan (§5, P-70 as built, P-60, P-63, P-64, P-71, P-73, P-76). |
| P-71 Accounts and approvals | ✅ Done | `94f3b39` | • Done after P-76, though the plan schedules it right after P-12: accounts were approved in SQL until now.<br>• L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 10 migrations (none new); the admin app's `tsc`, `npm run lint` (0 problems) and `npm run build` pass; the console builds, and its lint has the 2 problems of `MetricsDashboard.tsx` (P-50), as before.<br>• L1 backend `npm test`: **39 suites / 555 tests** (was 36 / 520). New, through a real HTTP server: what each account route passes on, 50 a page by default, five refusals of the list's query, an ID that isn't one, a change that needs a reason and takes no other field, a plan ID that isn't one, egress only `true` or `false`, the plans. The status rules: every change from every status, each refusal's message, the statuses that stop functions. The owners' e-mail: the subjects, the reason only for a refusal, suspension or closure, the console's link for the others. An operator's entry as the owners see it, FF's without ID, e-mail or address, and `GET /audit-log` giving it so. The autoscaler leaves a suspended account's function at zero; the minute's hold scales only functions with instances, keeps going past a failure, and runs even when aggregation failed. The OpenAPI document test covers the new routes.<br>• L2 `npm run test:db`: **105/105** (was 87). New: the list newest first with its owners; no account lost between pages for three created in the same millisecond; the status and plan filters; the search by ID, name and a member's e-mail, in any case, `%` and `_` as themselves; the account page (members, the functions' last call, this month's usage, the status history); an approval with the operator, the reason and from → to in the log, and an e-mail to each owner, not to a viewer; a 409 that writes and sends nothing; 404 on every route; suspension and reactivation scaling; a scale that fails; a status change rolled back with an audit entry that can't be written; closing from rejected, and not again; two operators at once, slowed by a trigger: one wins, the other gets 409, one entry, one e-mail; a plan move with its entry and quota; egress with its entry, nothing for the same value; the account's log in pages; the plans. `PlansService.assign()`: the reason in its entry, and the same plan writing nothing but applying the quota again.<br>• Admin app `npm test` (Vitest): **9 files / 47 tests** (was 7 / 38): the changes each status offers, what each says once done, what the owners learn, the labels and owners, an account ID only from 12 digits; an account's changes named in the audit view (`Status`, `Plan`, `Internet egress: off → on`); against the backend's files, the statuses and the five changes. Console `npm test`: 113/113.<br>• **Mutation checks:** 31 (25 backend, 6 admin app), each fails 1 to 3 tests. Among them: no row lock, caught by the two-operator test; the audit entry outside the transaction, by the rollback test; a cursor to the millisecond, by the same-millisecond test; closing that leaves functions running; every member e-mailed; members listed as owners; the operator's address shown to the owners; no hold each minute; and in the app, suspending a pending account, which the contract test also refuses.<br>• Browser check of the admin dashboard in headless Chrome, against Keycloak and a backend in OIDC mode, with a customer's account waiting: **30/30** (was 21). New: it opens on the approvals queue with the account, its owner and use case; the account page offers approve, reject and close; approving says what it does and what the owners learn; the status history names the owner and the operator, with the reason; the owner's e-mail in Mailpit; suspend, whose dialog says a call under way finishes and the e-mail gives the reason; reactivate; egress; the account's audit log, newest first; no sideways scrolling on a phone; the queue empty; the search by the owner's e-mail in capitals; the operator audit log with each account change and its account, filtered by action. A first run stopped on the script's wait, which a column header satisfied too; it now waits for the account page's badge.<br>• L5 `hack/e2e-tenancy.sh`: **227/227** (was 164) in 1 min 58 s. New: the 11 new routes refused in development mode, anonymously, with a customer's token and with an API key; the approvals queue and the approval through the admin route, with the owner's e-mail; account 1's log with FF's approval, as FF, without an address; the operator finds account 1 by e-mail and reads its page; suspends it (its Deployment at 0 replicas, invoke and deploy refused, reads allowed, the e-mail with why, the owner's log showing FF); a 409; reactivates it, and an invoke cold-starts; moves it to a larger plan, its ResourceQuota following at once; an unknown plan refused; egress on; the operator audit log by account, and unfiltered.<br>• L4 `hack/e2e.sh`: **64/64** in 175 s, unchanged.<br>• Docs: `admin/README.md` (Approvals, Accounts), `FE/README.md`, getting started (approving with the operator's route instead of SQL; accounts and approvals, with curl; a troubleshooting row for 409), README, `how-it-works.html` (the scenario "Suspend an account", accounts in "where data lives", the instances row, the reference; `validateScenarios()` no problem with 14 scenarios and 149 steps, no page error, checked in a screenshot), and this plan (§5, P-71 as built, P-45, P-62, P-72, P-73, P-74, P-75). |
| P-72 Support lookup | ⏳ Planned | | |
| P-73 Prices, plans and settings | ✅ Done | `5feb4fd` | • Done right after P-30, as the plan schedules it; the settings were P-70's.<br>• L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 11 migrations (none new); the admin app's `tsc`, `npm run lint` (0 problems) and `npm run build` pass.<br>• L1 backend `npm test`: **43 suites / 596 tests** (was 41 / 579). New, through a real HTTP server: the price book and plan routes are the admin dashboard's, and only the preview changes nothing; a book created for the operator from its instant, with its document and reason, and a book that isn't one refused; the preview passes its draft on and saves nothing; a book removed by its UUID, an ID that isn't one refused; a plan changed (name, limits, reason, the quota's count answered) or created, and a plan ID that isn't one refused; a book's earliest start (the next whole hour, across a year's end) and the preview's month (last month, UTC). A book that says AWS's US$ prices times a rate must be exactly that: each price that isn't named with what it must be, at a new rate too; the US$ prices, the rate and the tiers required; a `manual` book and D8's knobs left to FF. The guard takes no reason for a route that changes nothing, still for operators only.<br>• L2 `npm run test:db`: **123/123** (was 113). New: a book created at a whole hour in the future, made by the operator, with its reason in the audit log; refused mid-hour, at the hour now, in a currency FF lacks, when it isn't AWS's prices, and at an hour taken (409); a scheduled book removed with its reason, a started one refused (409), a missing one 404; the books' statuses on two dates; a draft previewed on last month for two accounts, one past the free tier (982.615 TND at the first book, 1965.231 at the draft), nothing saved; a plan changed for its reason, from what to what, its new quota applied to its two accounts, read fresh; nothing written for unchanged limits, no quota applied when it is the same, an account the cluster refused counted; limits that don't fit named, a missing plan 404, a taken plan ID 409.<br>• Admin app `npm test` (Vitest): **11 files / 66 tests** (was 9 / 47): US$ times a rate exactly, with BigInt; the earliest start; a new book from the active one, the same prices back unchanged, every SKU at a new rate, TND prices as given in manual mode, its problems named; tiers and sources to read; a plan's limits in a form and back, each kind read, each problem named, each change from → to; a plan change and a price book in the audit view; against the backend's files, the limits, the SKUs, and the first book's TND prices as the app's own multiplication of its US$ prices.<br>• **Mutation checks:** 23 (17 backend, 6 admin app), each caught. Two needed a form that compiles; one first survived, as the plan's cache was refreshed anyway by `update()`'s fresh read: the cache deletion was redundant, and is gone. A redundant check for a book at an hour already taken went too, the unique index answering 409 itself.<br>• Browser check of the admin dashboard in headless Chrome, against Keycloak and a backend in OIDC mode: **38/38** (was 30). New: the Prices page with the first book active, its requests at 0.6016 TND next to AWS's 0.20 US$; a new book at another rate, each TND price its US$ price times the rate; tried on last month; saved, scheduled; removed; the Plans page, a plan edited with its change listed, a new plan from its limits; an account moved to the new plan from its page; the operator audit log with every action, newest first.<br>• L5 `hack/e2e-tenancy.sh`: **259/259** (was 227) in 2 min 3 s. New: the six new routes refused in development mode, anonymously, with a customer's token and with an API key; a plan created through the route instead of SQL, and its new quota in the account's ResourceQuota at once; the first book active; a book for next year added, one that says AWS's prices but isn't them refused, a preview with no reason asked, the active book never removed, a scheduled one removed.<br>• L4 `hack/e2e.sh`: **68/68** in 173 s, unchanged: the month's estimate, whose service now takes a draft's books too.<br>• Docs: `admin/README.md` (Prices, Plans), getting started (prices and plans with curl, the plans passage without SQL, a troubleshooting row), README, `how-it-works.html` (the reference; `validateScenarios()` no problem), and this plan (§5, P-73 as built, P-32). |
| P-74 Payments, credit and invoices | ⏳ Planned | | |
| P-75 Overview | ⏳ Planned | | |
| P-76 Operator audit view | ✅ Done | `55af745` | • Done right after P-70, as the plan schedules it.<br>• L0: backend `tsc` exit 0, `npm run lint` 0 problems, `migration:check` OK with 10 migrations (none new); the admin app's `tsc`, `npm run lint` (0 problems) and `npm run build` pass.<br>• L1 backend `npm test`: **36 suites / 520 tests** (was 35 / 510). New, through a real HTTP server: the route is an admin route; a page of operator actions, each with the operator's ID and e-mail, the account, the reason and the details; the filters passed on, the operator trimmed and the dates as instants; five refusals (an account ID that isn't 12 digits, an action that isn't one, a date that isn't ISO 8601, a page over 100, a cursor that isn't a number); the CSV for `Accept: text/csv`, a formula in a reason quoted and guarded; `X-FF-Truncated` when more matched. `GET /admin/audit-log` in the OpenAPI document test; CORS exposes `x-ff-truncated`.<br>• L2 `npm run test:db`: **87/87** (was 82). New: only operators' entries, newest first, in pages; the operator filter in any case, `%` and `_` taken as themselves, never the customer with the same e-mail; account and action; `from` included and `to` excluded (an entry at 23:59:59.999 in, one at midnight out); the export's newest up to the cap, and whether there were more.<br>• Admin app `npm test` (Vitest): **7 files / 38 tests** (was 6 / 27): the filters as the API's parameters, the UTC days with "to" included, across a month's and a year's end; the export without its page; a change read by the setting's label, or as the API names it, with JSON for a value with parts and none for an empty one; an old value of another shape shown as it is; the time in UTC, the tests run in a UTC+1 zone; the labels and the file name; the actions the page names exist in the backend's `AuditAction`. Console `npm test`: 113/113.<br>• **Mutation checks:** 17 (customers' entries listed, `%` and `_` as wildcards, the operator filter in one case, `to` included, the export never cut short, no reason in the view, a reason a spreadsheet would run, a cut-short export not said, the operator untrimmed, the header not exposed by CORS; in the app, the "to" day excluded, the export paged, settings by their keys, no guard for an old value, local time, objects as `[object Object]`, no value as `null`): each fails 1 to 5 tests. Local time instead of UTC fails with `TZ=UTC` too.<br>• Browser check of the admin dashboard in headless Chrome, against Keycloak and a backend in OIDC mode: **21/21** (was 16). New: the audit log shows the settings change (the operator, "Settings changed", `Grace period: 24 → 48`, the reason); a filter that matches nothing says so; filters by operator and action find it again; the CSV downloads, with the change and its reason; the page and the CSV give the same time, in UTC. A first run passed but showed local times next to UTC filters, the setting's key rather than its label, and the account column's header in the IDs' font: all three fixed.<br>• L5 `hack/e2e-tenancy.sh`: **164/164** (was 157) in 1 min 50 s. New: `GET /admin/audit-log` refused in development mode, anonymously, with a customer's token and with an API key, as every `/admin` route; the operator's settings change in the operator audit log, with who, what, from and to, and why; unfiltered, only the operator's action among the customers' many; as CSV.<br>• L4 `hack/e2e.sh`: **64/64** in 163 s, unchanged.<br>• Docs: `admin/README.md` (the Audit log page), getting started (the operator audit log, with curl and CSV), README, `how-it-works.html` (the audit log in "where data lives" and the reference; `operator:…` in the data model's `actor`, missed in P-70; `validateScenarios()` no problem, no page error, no column of the data model running into its type), and this plan (§5, P-76 as built, P-71). |
