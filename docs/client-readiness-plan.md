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
| **No accounts or users.** The database has three tables: `functions`, `function_invocations` and `function_metrics`. No guard is registered anywhere. The console routes only the function pages. | `BE/src/app.module.ts`, `FE/src/App.tsx` | Nobody can sign up or log in. |
| **The tenant is whatever `@User()` returns:** `request.user.sub`, which nothing sets, else `FF_DEV_USER_ID` (`1` in `BE/.env.example`). **Partly fixed in P-02:** the development tenant is now `FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID`, which production refuses; P-10 replaces `@User()`. | `BE/src/auth/decorators/user.decorator.ts:22` | If the variable is set in production, every anonymous caller is that tenant. If it isn't, every request gets 401. |
| **Ownership is checked only on update and delete,** and a mismatch answers 401 instead of 404. Get (which returns the code), invoke, invocation history (inputs and outputs) and scaling configuration check nothing. The metrics route doesn't even ask for a tenant. | `BE/src/functions/functions.controller.ts:49,63,74,82,93,106`, `BE/src/metrics/metrics.controller.ts` | As soon as there are two tenants, anyone who knows a function ID can read its code and its callers' data, and run it on the owner's bill (parent C-3). |
| `?limit=` on the invocation history has no maximum. | `functions.controller.ts:95` | One request can dump a function's whole history. |
| No rate limits. The tenant quota (20 pods, 8 CPU, 8 GiB) is the same for every tenant. | `BE/src/config/configuration.ts:52` | No plans. One tenant can use the cluster up to that quota. |

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
| Deleting a function cascades to its invocations and metrics. | `BE/src/functions/entities/function-invocation.entity.ts:30`, `BE/src/metrics/entities/function-metrics.entity.ts:20` | A customer can erase a month's usage before it is billed. |
| An invocation doesn't record the memory size it ran with. | `function-invocation.entity.ts` | Changing a function's memory reprices its past calls. |
| The row is saved as `RUNNING` before the call and updated after. | `BE/src/functions/functions.service.ts:129` | If the backend crashes or restarts during a call, the row stays `RUNNING` forever. |
| On errors and timeouts the stored duration is the end-to-end time, including any cold start. Both runtimes return `X-FF-Duration-Ms` on errors too, but the orchestrator drops it. | `functions.service.ts:162`, `BE/src/orchestrator/kubernetes/kubernetes.orchestrator.ts:237` | Failed calls are mismeasured. |
| A runtime's `429 TooManyRequestsException` (more than `FF_MAX_QUEUE`, 32, calls waiting) becomes a generic error. | `kubernetes.orchestrator.ts:239` | Throttled calls are recorded, reported and would be charged as function errors. |
| `synchronize` is on outside production, and the migrations don't match the entities (parent C-7). **Fixed in P-01.** | `configuration.ts:9`, `BE/src/migrations/*` | A production database breaks today, and every table this plan adds needs migrations that really run. |
| There are no plans, prices, balances, payments or invoices. | | |

### 1.3 What a call really costs

Pricing by run time alone loses money, because what a call costs you is not its run time:
- **A pod reserves its full memory and CPU** for as long as it exists. Requests equal limits (`BE/src/orchestrator/kubernetes/manifests.ts:236`).
- **A pod stays up 15 minutes after the last call** (`FF_SCALE_TO_ZERO_IDLE_SECONDS`, 900 s, `configuration.ts:28`).
- **The cold start isn't billed.** It takes about 10 s at 128 MB, and 12–15 s under gVisor (migration plan K-13). It isn't part of the runtime's duration.

A single 1 ms call at 128 MB therefore holds 0.125 GB × 900 s ≈ 112 GB-s of server memory, and bills 0.000125 GB-s: 900,000 times less. D8 adopts AWS's prices anyway, and keeps this gap measured and visible, so you can change the prices with real numbers.

### 1.4 Logs and monitoring

| Finding | Where | Consequence |
|---|---|---|
| The runtimes print Lambda-style `START`/`END`/`REPORT` lines, the function's own output, and JSON error lines to the pod's stdout. | `runtimes/*/README.md` | Only someone with cluster access can read them (`kubectl logs`). They disappear with the pod: after 15 idle minutes, on every update, and on delete. |
| The backend never sends `X-FF-Request-Id`, so the runtime invents its own ID. | `runtimes/nodejs/src/main.ts:305`, `kubernetes.orchestrator.ts:248` | A log line can't be matched to its invocation row. |
| No logs API, console view, search, or retention. | | |
| Metrics: one row per function per minute *that had traffic* (requests, errors, p50/p95/p99, average memory, ready instances), collected in memory between minutes. The function page draws four charts from it. | `BE/src/metrics/metrics.service.ts`, `FE/src/components/MetricsDashboard.tsx` | Close to CloudWatch's Invocations, Errors and Duration. Missing: throttles, cold starts, concurrency, rows for quiet minutes, alarms, and the ownership check. A backend restart loses the current minute. |
| No operator metrics, health endpoints, or dashboards (parent M-1, F-09). | `BE/src/main.ts` | You can't see the platform's health either. |

### 1.5 Not deployable yet

- **No image or manifest** for the backend, the console, or PostgreSQL. `deploy/k8s/base` holds only the cluster permissions.
- **The console** has its API URL hard-coded to `http://localhost:3000` (`FE/src/services/api.ts:4`), and reads a token from `localStorage` that nothing writes.
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
| **Node.js functions run in `/opt/ff`.** The Node.js runtime never changes directory; the Python runtime and Lambda run in `/var/task`. | `runtimes/nodejs/src/main.ts`, `runtimes/python/ff_runtime/worker.py:210` | A Node.js function that reads a file next to its code works on Lambda but not on FF. |
| **"Max Memory Used" means two things:** in Node.js, the memory in use when the call ends; in Python, the peak, as on Lambda. | `runtimes/nodejs/src/main.ts:99`, `runtimes/python/ff_runtime/main.py:67` | Node.js under-reports what a call needed, in `REPORT` lines and in the history. |
| **The runtimes log errors differently.** Node.js doesn't log a handler's exception, while Python writes a `function error` line with the stack trace. Python doesn't log an out-of-memory replacement, while Node.js does. | `runtimes/nodejs/src/worker.ts:90`, `runtimes/python/ff_runtime/worker.py:150`, `main.py:201` | Customer logs (phase 4) would show nothing for a failed Node.js call. |
| **A worker that fails to reload leaves the pod unready for good.** `/readyz` stays 503 and `/healthz` stays 200, so kubelet never restarts the container. | `runtimes/nodejs/src/main.ts:125-160`, `runtimes/python/ff_runtime/main.py:84-135` | After a timeout or a crash, a reload that fails (an init timeout at 0.1 CPU, for example) takes the instance out of service until its pod is deleted. |
| **A Node.js result that JSON can't hold** (a function, a `Symbol`) leaves the response body undefined, and the main process then measures it. This is read from the code; no test covers it. Python answers `Runtime.MarshalError`. | `runtimes/nodejs/src/worker.ts:87`, `main.ts:184` | The main process can crash, failing the calls waiting behind it. |
| **Callback-style handlers fail.** The context sets `callbackWaitsForEmptyEventLoop`, but no callback is passed. | `runtimes/nodejs/src/worker.ts:83` | A Lambda handler written as `(event, context, callback)` fails with `TypeError`. |
| **Four console calls are broken.** The invocation history expects an array (the API returns `{ invocations, total }`). The invoke result reads `response.data.metrics.*`, which doesn't exist. An edit sends the whole function, which the API rejects with 400. The scaling form calls `PUT /functions/:id/scaling-config`, which doesn't exist. | `FE/src/components/FunctionDetail.tsx:33,68-72,88`, `FE/src/services/api.ts:81,102` | The history stays empty, an invoke shows no duration or memory, and editing or scaling a function fails. |
| **Autoscaling never adds a pod.** `maxInstances` defaults to 1, and no API field changes it. The rule counts requests per minute (more than 2 per instance scales up), and its p95 includes cold starts. | `BE/src/functions/dto/`, `BE/src/metrics/scaling.ts:34-36`, `metrics.service.ts:133` | Each function runs on one pod, one call at a time. In a burst, calls wait in the pod's queue, and the backend gives up on those that wait longer than the function's timeout plus 2 s while the pod is still working through the queue. |
| **Unused columns.** `functions.cpu` and `targetConcurrency` are never read, `function_invocations.cpuUsed` is always NULL, and `function_metrics.cpuUsage` is always 0. | the entities, `functions.service.ts:140-146` | Fields in the API and the console that mean nothing. |
| **The invoke mode changes how a timeout is recorded.** When the backend gives up waiting, proxy mode (development) records `ERROR`, and direct mode (production) `TIMEOUT`. | `kubernetes.orchestrator.ts:209-218` | Development doesn't show what production records. |
| **The OpenAPI document says invoke answers 200.** It answers 201, which `hack/e2e.sh` checks. | `BE/src/functions/functions.controller.ts:81` | Generated clients, and the L5 suite that reads the document, expect the wrong status. |
| **The controller's permissions reach further than the admission policy.** `services/proxy` is granted cluster-wide, although the role says it is for development only, and the policy doesn't check proxy calls. Every read (pods, pod logs, ConfigMaps) is cluster-wide. The policy hard-codes `ff-t-`, while `K8S_NAMESPACE_PREFIX` can be changed. | `deploy/k8s/base/20-clusterrole.yaml:28-31`, `30-clusterrolebinding.yaml`, `40-admission-policy.yaml:45`, `BE/src/config/configuration.ts:39` | A stolen backend token can call any Service in the cluster and read every ConfigMap and pod log. Another prefix makes every deploy fail. |

### 1.7 Dependencies

Found on 2026-10-17 while adding Zod for P-02. P-09 upgrades them.

| Finding | Where | Consequence |
|---|---|---|
| `npm audit --omit=dev` reports **26 known vulnerabilities** in the backend's production dependencies: 3 critical, 11 high, 11 moderate, 1 low. | `BE/package-lock.json` | Each is an exposure as soon as a customer can reach the API. The main ones follow. |
| **TypeORM 0.3.20:** SQL injection through crafted values passed to `save` or `update`, fixed in 0.3.26; a non-breaking update. | `typeorm` | FF calls `save` with request data. |
| **Express 4 under NestJS 10:** `proxy-addr` (IP spoofing, critical), `path-to-regexp` (ReDoS), `body-parser` and `multer` (denial of service). The audit's fix is NestJS 12, two major versions up, with Express 5. | `@nestjs/platform-express`, `express` | Crafted requests can stall the backend, and spoofed client addresses would defeat P-15's limits by IP. |
| **minio 7:** `fast-xml-parser` (critical: entity expansion and an encoding bypass). The fix is minio 8. | `minio` | The object store's XML answers are parsed with it. |

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
- **Lost calls:** at startup and every minute, invocations `RUNNING` for longer than their timeout plus the cold-start limit plus 30 s become `lost`, with a usage record that bills nothing.
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

**The first price book** (D8), as P-30 creates it. Prices are decimal strings, never floating-point numbers, and are rounded only when a debit is written (parent §8.3):

```json
{
  "currency": "TND",
  "source": { "kind": "aws-lambda", "region": "us-east-1", "architecture": "x86_64",
              "readOn": "2026-10-16", "usdRate": "2.9123", "usdRateDate": "2026-09-07" },
  "freeTier": { "requests": 1000000, "gbSeconds": 400000 },
  "prices": {
    "requestsPerMillion": "0.58246",
    "gbSecond": [
      { "upToGbSeconds": 6000000000, "price": "0.0000485384" },
      { "upToGbSeconds": 15000000000, "price": "0.0000436845" },
      { "upToGbSeconds": null, "price": "0.0000388309" }
    ],
    "provisionedGbSecond": "0.0000121347",
    "provisionedDurationGbSecond": "0.0000283140",
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
| `GET /me` | The user, their accounts and roles | P-12 |
| `POST /accounts`, `GET /accounts/:id`, `PATCH /accounts/:id` | Create an account (the caller becomes owner), read it, rename it, set the tax ID | P-12 |
| `GET`, `POST`, `DELETE /api-keys` | List, create (the secret is shown once), revoke | P-13 |
| `GET`, `POST`, `DELETE /members`, `POST /invites/:token/accept` | Members and invitations | P-16 |
| `GET /audit-log` | The account's audit log (owners) | P-17 |
| `GET /usage?month=YYYY-MM` | Requests, GB-seconds and cost per function; CSV with `Accept: text/csv` | P-22 |
| `GET /billing/balance`, `GET /billing/transactions` | Balance, top-ups and debits | P-32 |
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
| `GET`, `PUT /admin/settings` | Billing and platform settings (D12) | P-70 |
| `GET /admin/accounts`, `GET /admin/accounts/:id` | Search, filters, and the account page | P-71 |
| `POST /admin/accounts/:id/approve`, `/reject`, `/suspend`, `/reactivate`, `/close` | Status changes, with an e-mail to the owner | P-71 |
| `PUT /admin/accounts/:id/plan`, `PUT /admin/accounts/:id/egress` | Plan, and internet egress (D5) | P-71 |
| `GET /admin/lookup?q=`, `GET /admin/functions/:id` | Find a function, request ID, account or e-mail across accounts | P-72 |
| `POST /admin/functions/:id/access` | View code, inputs and outputs, or logs, with a reason that the customer can see | P-72 |
| `GET`, `POST /admin/price-books`, `POST /admin/price-books/preview` | Price books, and re-rating last month with a draft | P-73 |
| `GET /admin/plans`, `PUT /admin/plans/:id` | Plan limits | P-73 |
| `GET /admin/payments`, `POST /admin/bank-transfers`, `POST /admin/withholding-certificates` | Payments, transfers, withholding | P-74 |
| `POST /admin/credits` | Promotional credit and corrections | P-74 |
| `GET /admin/invoices`, `POST /admin/invoices/issue`, `POST /admin/invoices/:id/credit-note` | Monthly drafts, issuing, credit notes | P-74 |
| `GET /admin/stats/overview` | The overview's figures | P-75 |
| `GET /admin/audit-log` | Every operator action | P-76 |

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

#### P-05: Console fixes
- **Moved here from P-14,** so the console works before its new pages are built (parent H-11):
  - the invocation history reads `{ invocations, total }` (`FE/src/components/FunctionDetail.tsx:33`, `FE/src/services/api.ts:81`);
  - the invoke result shows the invocation's `duration`, `memoryUsed`, `createdAt` and `updatedAt`, instead of `response.data.metrics.*` (`FunctionDetail.tsx:68-72`);
  - an edit sends only the changed fields that the API accepts (`FunctionDetail.tsx:88`);
  - the scaling form is read-only until P-06 decides what customers may change, because `PUT /functions/:id/scaling-config` doesn't exist (`api.ts:102`);
  - the debug `console.log` goes (`FunctionDetail.tsx:31`).
- **Tests:** L0 (`npm run build`); a manual check of create, invoke, history and edit against the development stack, recorded in the progress log.

#### P-06: Concurrency and autoscaling
- **Decide the beta's scaling model,** and record it in §3:
  - which settings customers may change (`minInstances`, `maxInstances`), within the plan's limits (P-15);
  - the default `maxInstances`, which is 1 today, so autoscaling never adds a pod;
  - the signal that adds a pod: requests per instance and minute, as today (`MAX_REQUESTS_PER_INSTANCE`, 2), or concurrency, meaning calls running or waiting per instance. Only the runtime knows its queue; it would report it, for example in a response header.
- **Build it:** validated DTO fields; `decideReplicas` with the chosen signal; a p95 rule on the runtime's duration, without cold starts; a `scaling-config` route that writes as well as reads. P-05's form then becomes editable.
- **Calls waiting in a pod's queue:** the backend's timeout (the function's timeout plus 2 s) also counts the time a call waits behind others. Either the backend waits longer when the pod reports a queue, or the pod answers 429 before queueing, recorded as `throttled` (P-15).
- **Unused columns:** a migration drops `functions.cpu`, `function_invocations.cpuUsed` and `function_metrics.cpuUsage`, and `targetConcurrency` unless the chosen model uses it.
- **Tests:** L1 for `decideReplicas` with the new inputs; L3: a burst of slow calls to one function scales it to two pods, and no call fails while the second pod starts.
- **Docs:** `how-it-works.html` (the metrics scenario and the limits), and the getting-started guide's limits.

#### P-07: Cluster permissions
- **`services/proxy`** moves from `deploy/k8s/base` to a development-only overlay that `hack/k8s/cluster-up.sh` applies. Production invokes in direct mode (P-60) and doesn't need it.
- **The namespace prefix:** the configuration schema (P-02) refuses a `K8S_NAMESPACE_PREFIX` other than `ff-t-`, because the admission policy checks that prefix (`40-admission-policy.yaml:45`).
- **Cluster-wide reads:** decide, and record the decision in `deploy/k8s/README.md`. Either accept them for the beta and say what they expose, or bind the read permissions per tenant namespace, which needs a separate provisioner because the backend must not manage RBAC. The `pods/log` permission goes once P-43 serves logs from the log store. P-64 reviews the decision.
- **Tests:** `hack/k8s/test-rbac.sh`: with the production manifests, the controller can't proxy to a Service, in a tenant namespace or anywhere else; with the development overlay, it can.
- **Docs:** `deploy/k8s/README.md`, the Kubernetes dev guide.

#### P-08: API and documentation fixes
- **The OpenAPI document** says invoke answers 201, as it does (`functions.controller.ts:81`).
- **One timeout, one status:** when the backend gives up waiting in proxy mode, the error becomes a `FunctionTimeoutError`, as in direct mode. P-20 then maps it to the usage status.
- **The migration plan's KubeClient names** match the code: `scaleDeployment`, `list`, and `podLog(ns, pod, container, tailLines)` (`docs/kubernetes-migration-plan.md:400-401`).
- **Tests:** L1 for the timeout mapping; `hack/e2e.sh` unchanged.

#### P-09: Dependency upgrades
- **Why:** the known vulnerabilities of §1.7, found on 2026-10-17.
- **Do:**
  - the non-breaking fixes first (`npm audit fix`): TypeORM 0.3.26 or newer, `@nestjs/common` 10.4.16 or newer, `proxy-addr`, `sha.js`;
  - NestJS 10 to 12, all `@nestjs/*` packages together, with Express 5;
  - minio 7 to 8. If the client stays affected, replace it with the AWS SDK's S3 client: FF only uploads and deletes objects;
  - the same audit for the console (`FE/`) and the Node.js runtime (`runtimes/nodejs`).
- **Done when:** `npm audit --omit=dev` reports no critical or high finding in any of the three, or each remaining one is accepted in writing with a reason.
- **Order:** before phase 1, because P-11 adds `jose` and P-15 adds `@nestjs/throttler`, which must match the NestJS version.
- **Tests:** L0 to L4 green, unchanged; the audit's output in the progress log.

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

#### P-11: Keycloak and the global guard
- **Development stack:** Keycloak and Mailpit in docker-compose, with the `ff` realm imported from `deploy/keycloak/ff-realm.json`:
  - clients `ff-console` (public, PKCE), `ff-cli` (device flow), and `ff-e2e` (password grant, development realm only);
  - an audience mapper for the API;
  - self-registration and e-mail verification on.
- **Backend:**
  - the global `APP_GUARD` and `@Public()`;
  - token checks with `jose` (D2), with the realm's keys cached and refreshed when a token names an unknown key;
  - only asymmetric algorithms accepted.
- **Tests:**
  - L1 with locally signed tokens: valid, expired, wrong issuer, wrong audience, unverified e-mail, `alg: none`, a wrong key;
  - L4: log in as two users through `ff-e2e`, and anonymous calls get 401.

#### P-12: Accounts, users and sign-up
- **Tables:** `plans`, `accounts`, `users`, `memberships` (§4).
- **Rename the tenancy key** to `accountId` in the entities, the orchestrator's `FunctionWorkload`, the namespace naming, and the `ff.dev/tenant-id` annotation.
- **Sign-up flow:**
  - the user record is created on the first authenticated call;
  - `POST /accounts` creates the account, with the caller as owner;
  - `GET /me`.
- **Beta approval:** the account is `pending` until you approve it in the admin dashboard (P-71). A pending account can't deploy or invoke. Sign-up also asks what the customer plans to build, for your review. You get an e-mail for each new sign-up, with a link to the approvals queue.
- **Tests:** L1 for the flows and role checks; L2 for the migration; L4 from registration (Mailpit) to a pending account that can't deploy. P-71's test continues from there.

#### P-13: API keys
- D3: create, list, revoke, scopes, expiry, `last_used_at`. Comparisons run in constant time.
- **Tests:** L1 for parsing, hashing and scope checks; L4 for invoking with a key, and 401 after revocation; L5 for keys of account B used on account A.
- **Docs:** the getting-started guide's `curl` section uses a key.

#### P-14: Console login and account pages (parent F-10, in part)
- **API URL:** `VITE_API_URL` replaces the hard-coded `localhost`.
- **Login:** `react-oidc-context` with PKCE, a sign-up link, logout, and token renewal.
- **Pages:**
  - onboarding (create the account);
  - "waiting for approval";
  - account settings;
  - API keys.
- **The console's broken calls** (parent H-11) are fixed first, in P-05.
- **Tests:** L0 (`npm run build`); a manual check of the full flow, recorded in the progress log.

#### P-15: Plans, quotas and rate limits
- **Plans** as data (D5), assigned per account. One `beta` plan to start, with today's limits:
  - 25 functions, each up to 1,024 MB and 300 s (the current validation limits);
  - the current quota of 20 pods, 8 CPU and 8 GiB;
  - 14 days of logs and 30 days of history;
  - a 15-minute idle window, and no internet egress.

  You change any value in the admin dashboard (P-73).
- **`ensureTenant`** writes the account's plan quota. A plan change rewrites it in the account's namespace.
- **Function limits** (count, memory, timeout) are checked on create and update, with messages that name the plan's limit.
- **`@nestjs/throttler`** per account, with separate limits for control-plane writes and invokes. A runtime's 429 becomes `429 TooManyRequestsException`, recorded as `throttled`.
- **Tests:** L1 for limits and the 429 mapping; L3 for the plan quota on a namespace; L4 for exceeding a rate limit.

#### P-16: Members and invitations
- An owner invites a member by e-mail with a role. The invitation is accepted at the next login with that e-mail, and expires after 7 days.
- Owners change roles and remove members. The last owner can't be removed.
- **Tests:** L1 for the rules; L4 for an invite accepted by a second user. This task can slip until after the beta starts.

#### P-17: Audit log
- **Recorded:** creating, updating and deleting functions; key and member changes; plan, credit and status changes; every `/admin` call. Each row has the actor (user or key) and the source IP.
- **Readable by owners** through `GET /audit-log`. Append-only, with the same trigger as `usage_records`.
- **Tests:** L1, and L2 for the trigger.

### Phase 2: metering

#### P-20: Usage records
- **Table, trigger and monthly partitions** (§4, D6). A job creates the next month's partition ahead of time.
- **Invoke path:**
  - send `X-FF-Request-Id` with the invocation ID;
  - read the duration and memory headers on errors too: `FunctionRuntimeError` carries them;
  - map 429 to `throttled`, and orchestrator failures to `platform_error`;
  - record `init_ms` when the call had to scale from zero;
  - write the invocation's final state and the usage record in one transaction.
- **The `lost` reaper** (D6).
- **Tests:**
  - L1 for D7's table, one case per row;
  - L2: deleting a function keeps its records; changing memory doesn't change past records; `UPDATE` and `DELETE` are refused; a duplicate request ID is a no-op;
  - L4: kill the backend during a slow call; after the restart, the row is `lost` and bills nothing.

#### P-21: Capacity samples
- Every minute: one list of FF's Deployments (label `app.kubernetes.io/managed-by=ff-controller`), then one `capacity_samples` row per function with ready replicas, including its `minInstances` (the provisioned time of D8).
- An operator report: reserved GB-s against billed GB-s, per account and day. It is the input for D8.
- **Tests:** L1 against the fake Kubernetes API; L3 for a function at 0, 1 and 2 replicas.

#### P-22: Usage API and console page
- **`GET /usage?month=`:** requests, GB-seconds and billed duration per function, totals, and the estimated cost once prices exist (P-30). CSV export.
- **Console:** a "Usage" page with this month, last month, and the per-function table.
- **Tests:** L2: the API's totals equal the sum of the raw records, exactly; L4 for invoke, then usage.

### Phase 3: prepaid credit

#### P-30: AWS price book (parent B-11)
- **Data:** `currencies` (TND, exponent 3) and `price_books` with `valid_from`, as data, never as code.
- **The first book** (§4): AWS's current Lambda prices (D8) at the BCT rate of the day, with the source and the rate recorded in it.
- **The rater** supports every SKU in the book: requests, tiered GB-s, provisioned time and provisioned duration, the free tier (not for functions with `minInstances > 0`), and the three knobs at zero.
- **Tests:**
  - L1: a fixture month rated by FF equals the same month computed by hand with AWS's published formula and the book's rate;
  - L1 for each knob set above zero;
  - L2 for a book that changes in the middle of a month.
- **Done when:** the book is loaded, and the usage page shows costs.

#### P-31: Ledger and wallet (parent B-02)
- **Tables** from Appendix E. A deferred constraint trigger checks that each transaction sums to zero.
- **Accounts:** customer wallet, revenue, VAT payable, stamp duty, payment-provider clearing, and promotional credit.
- **Movements:** credit grants for promotions and corrections, made in the admin dashboard (P-74).
- **Money** is `bigint` from the database to the API, never `number`.
- **Tests:**
  - L1 for the money arithmetic and rounding (half-up to the minor unit, once per debit);
  - L2 for the zero-sum trigger, idempotency keys, and concurrent debits on one wallet.

#### P-32: Rating and debits (parent B-01)
- **The hourly job** (D9): usage records → `usage_hourly` → the free tier → the price book → one transaction per account and hour. Re-running an hour is a no-op.
- **Shadow mode** first (D9), switched off by configuration after two weeks without differences.
- **APIs:** `GET /billing/balance` and `GET /billing/transactions`. The console shows the balance on every page.
- **Tests:** L2: rating an hour twice; an hour that spans a price change; the free tier across a month boundary; the parent's reconciliation criterion (rated usage equals raw usage).

#### P-33: Balance check and spend controls (parent B-07, in part)
- **The spendable-balance cache,** the negative buffer, the grace period, and `402 InsufficientCreditException` on invoke (D9). The console shows a banner with a top-up link.
- **Low-balance e-mails** at thresholds the owner sets (by default 50%, 20% and 0% of the last top-up).
- **Tests:** L1 for the policy; L4 for a wallet run down to zero, then invokes refused, then a top-up, then invokes accepted.

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

#### P-35: Bank transfers and manual credit (parent B-04, light)
- **Pro-forma:** the owner asks for one; it carries a unique payment reference.
- **Recording the payment:** you record it in the admin dashboard (P-74), which credits the wallet and is audit-logged. Withholding tax follows D9: the withheld share is credited when you upload the certificate.
- **Tests:** L1 and L2 for the ledger entries, including a payment net of withholding tax.

#### P-36: Monthly invoices (parent B-05)
- **The monthly run** (D9): on the 1st, one draft per account that paid anything in the previous month, and a usage statement for every active account. You issue the drafts from the admin dashboard (P-74).
- **Numbering:** gapless per fiscal year, from a locked counter row, assigned only when a draft is issued. Issued invoices are immutable, and corrections are credit notes.
- **Content:** a French PDF with one line per payment (pre-tax credit and VAT at 19%), the 1 TND stamp duty, the buyer's tax ID for B2B, and the usage statement attached. Tax rates are dated data (parent §8.6).
- **Tests:** L2 for a month with two top-ups and a bank transfer net of withholding, a month without payments, numbering under concurrency, and credit notes; PDF snapshots.

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
- **Tests:** L2 for the purge job; L3 for log deletion as decided in P-41.

### Phase 5: metrics and alarms

#### P-50: Metrics API
- **`GET /functions/:id/metrics?start=&end=&period=&stat=` and `GET /metrics`** (account totals), from `usage_records` and `capacity_samples` (D11), with quiet periods filled with zeros.
- **Console:** the charts switch to this API. `GET /metrics/:functionId` is removed.
- **Tests:** L2 for the aggregates against hand-computed fixtures (percentiles, empty periods, throttles); L5.

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
  - the console: a static build.
- **`deploy/k8s/platform/`:**
  - the backend in `ff-system` (ServiceAccount `ff-controller`, `direct` invoke mode, one replica, migrations as a Job before each rollout);
  - the console;
  - Keycloak, with its database on the same PostgreSQL server (`KC_DB_*`);
  - the admin app (D12);
  - an edge proxy (Traefik or Caddy) with ACME TLS for the API, console, admin and login hostnames, and an IP allowlist on the admin hostname.
- **PostgreSQL is not deployed** by these manifests. The backend and Keycloak reach it through environment variables (D13).
- **Production settings:** Swagger off, CORS limited to the console's origin.
- **Tests:** L4 against a fresh k3d cluster deployed only from these manifests.

#### P-61: Backups and restore
- **What:** PostgreSQL point-in-time recovery, with WAL archived to a second site, covering FF's database and Keycloak's. Usage, ledger and invoices are money.
- **Targets** (parent §11.3): recovery point 15 minutes, recovery time 4 hours.
- **A restore drill,** recorded in the progress log, then monthly.

#### P-62: Sandbox on, egress per plan
- **gVisor is required in production** (`K8S_RUNTIME_CLASS=gvisor`, K-11). It adds 2–5 s to cold starts until K-13.
- **Internet egress per account** (D5): `networkPolicyManifest` takes the account's `internet_egress` flag instead of the global `K8S_EGRESS_INTERNET`. Turning it on or off in the admin dashboard rewrites the tenant's NetworkPolicy. Off by default.
- **Tests:** L3 for the K-11 suite under the production settings; L3 for a function that can't reach the internet, then can once the flag is on, while private addresses stay blocked either way.

#### P-63: CI (parent F-11)
- **Pipeline:**
  - lint and type-checks;
  - L1 and L2;
  - the migration drift check;
  - L4 and L5 on k3d;
  - Trivy image scans, an SBOM, and gitleaks.
- **Hosting:** self-hosted (Gitea and Woodpecker), or the GitHub free tier (parent §4.10).
- **Done when:** the pipeline is green on the branch, and a pull request can't merge without it.

#### P-64: Security review
- **Internal review** before the beta:
  - authentication, API keys, the payment webhooks, the log query builder, the `/admin` routes;
  - dependency audit, and the L5 suite.
- **An external penetration test before GA** (parent §11.4).
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
  - a required `reason` on every write, written to the audit log with the operator;
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

#### P-71: Accounts and approvals
- **Approvals queue:**
  - pending accounts, with what sign-up collected: the owner's name and e-mail, the account name, country, tax ID, and what they plan to build;
  - approve or reject, with a reason; the owner gets an e-mail either way;
  - your new-sign-up e-mail (P-12) links here.
- **Accounts:**
  - search by ID, name or e-mail, and filter by status and plan;
  - an account page: members, functions (name, runtime, memory, status, last invocation), this month's usage, balance, payments, invoices, the audit log, and the status history.
- **Actions:**
  - **suspend and reactivate:** a suspended account's invokes and deploys get `403 AccountSuspended`, and its functions are scaled to zero. Nothing is deleted.
  - **close:** P-45's deletion flow;
  - **change plan:** the quotas are rewritten;
  - **internet egress on or off** (D5, P-62).
- **Backend:** the `/admin/accounts` routes, plus the suspension check in the invoke and deploy paths.
- **Tests:**
  - L1 for the status changes: pending to active or rejected, active to suspended and back, any to closed;
  - L4, continuing P-12's test: approve, then deploy and invoke; suspend, and the invoke is refused; reactivate.

#### P-72: Support lookup
- **Search across accounts** by function ID or name, request ID, account ID, or e-mail.
- **A function page** shows its account, configuration, status, recent errors, and recent invocations (status and duration, without inputs or outputs).
- **Viewing customer data:** the code, invocation inputs and outputs, and logs open only with a reason. Each access is recorded in the customer's audit log (D12).
- **Tests:** L1; L4 for a lookup by request ID; L2 that an access shows up in the customer's audit log.

#### P-73: Prices, plans and settings
- **Price books:**
  - list and view them;
  - create a new version by editing the current one, or from "AWS's US$ prices × an exchange rate";
  - the start date must be in the future (the next hour at the earliest); active and past books are read-only.
- **Preview:** last month's usage re-rated with the draft book, per account and in total, next to what was actually charged.
- **Plans:** edit every limit of D5. Quota changes are applied at once to every account on the plan.
- **Settings:** shadow mode, the negative buffer, the grace period, low-balance thresholds, the invoice reminder, and the large-credit threshold.
- **Tests:** L1 for book validation (every SKU present, tiers in order, start in the future); L2 for the preview against a fixture month.

#### P-74: Payments, credit and invoices
- **Payments:** every payment with its provider, status and amount. Reconciliation mismatches are listed first.
- **Bank transfers:** record a payment against a pro-forma reference, with the withheld amount; upload the withholding certificate later (D9).
- **Credit:** grant promotional credit, or a correction, with a reason. Above the threshold, a second confirmation.
- **Invoices:**
  - the monthly drafts (D9): review, then issue all or one;
  - download the PDFs, and issue credit notes for refunds;
  - El Fatoora status, once P-37 exists.
- **Tests:** L2 for every action's ledger entries; L4 for a month-end run with a fixed clock: drafts, issue, PDF.

#### P-75: Overview
- **Figures:**
  - accounts by status, and pending approvals;
  - functions, invocations, errors and throttles today;
  - top-ups and consumption this month;
  - the total of customer balances (the unused credit FF owes);
  - reserved against billed GB-s per day: D8's cost gap.
- **Links** to the operator dashboards (P-53).
- **Backend:** `/admin/stats/overview`, cached for a minute.
- **Tests:** L2 for the figures against fixtures.

#### P-76: Operator audit view
- Every operator action, filtered by operator, account, action and date, with CSV export.
- **Tests:** L1.

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
| A burst of calls to one function queues on its only pod, and calls fail while it works through the queue | P-06 decides the scaling model before the beta; P-15's rate limits and the `throttled` status |

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
| P-03 Function lifecycle fixes | ✅ Done | (this commit) | • L1 `npm test`: **15 suites / 215 tests** (was 204). New in `functions.service.spec.ts`: repair of an `ERROR` function, retry without changes, rollback (nothing saved or archived), a rollback that fails too (both messages, pod released), a failed repair keeps the attempt, oversized code changes nothing, the archive written after the rollout and moved on a runtime change, an archive failure doesn't fail the update, a failed create releases its pod. In the driver's spec: one replica at least, even at zero. **Against the old code, 11 of these fail**, one or more per defect of §1.6.<br>• L3 (new `functions.lifecycle.it.spec.ts`, the service with the real driver on k3d): **3/3** in 2 min 36 s. A broken create ends `ERROR` with 0 desired replicas and no pod, and an update with fixed code makes it `ACTIVE` and invocable. A broken update of a working function answers 400, and after a scale to zero the cold start still runs the old code. At zero, broken code is refused and good code goes live on a real pod.<br>• L3 driver suite: **11/11**. The Node.js heap-hog case failed once with `Sandbox.Timedout`, which is a runtime timing issue: recorded under P-04.<br>• L4 `hack/e2e.sh`: **22/22**.<br>• Found while verifying: `npm run test:it -- <pattern>` silently ran the wrong suites, because Jest's list options swallow the arguments after them. `test:it` and `test:db` now end with a boolean flag, so a path filter works.<br>• Docs: `how-it-works.html` (update and failed-load scenarios, the lifecycle diagram, checked in a headless Chrome screenshot; a P-01 leftover in camelCase), the getting-started guide (update, load failures, troubleshooting), the dev guide and README (the L3 suite). |
| P-04 Runtime fixes | ⏳ Planned | | |
| P-05 Console fixes | ⏳ Planned | | |
| P-06 Concurrency and autoscaling | ⏳ Planned | | |
| P-07 Cluster permissions | ⏳ Planned | | |
| P-08 API and documentation fixes | ⏳ Planned | | |
| P-09 Dependency upgrades | ⏳ Planned | | |
| P-10 Principal and account-scoped services | ⏳ Planned | | |
| P-11 Keycloak and the global guard | ⏳ Planned | | |
| P-12 Accounts, users and sign-up | ⏳ Planned | | |
| P-13 API keys | ⏳ Planned | | |
| P-14 Console login and account pages | ⏳ Planned | | |
| P-15 Plans, quotas and rate limits | ⏳ Planned | | |
| P-16 Members and invitations | ⏳ Planned | | |
| P-17 Audit log | ⏳ Planned | | |
| P-20 Usage records | ⏳ Planned | | |
| P-21 Capacity samples | ⏳ Planned | | |
| P-22 Usage API and console page | ⏳ Planned | | |
| P-30 Prices and price book | ⏳ Planned | | |
| P-31 Ledger and wallet | ⏳ Planned | | |
| P-32 Rating and debits | ⏳ Planned | | |
| P-33 Balance check and spend controls | ⏳ Planned | | |
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
| P-70 Admin dashboard foundation | ⏳ Planned | | |
| P-71 Accounts and approvals | ⏳ Planned | | |
| P-72 Support lookup | ⏳ Planned | | |
| P-73 Prices, plans and settings | ⏳ Planned | | |
| P-74 Payments, credit and invoices | ⏳ Planned | | |
| P-75 Overview | ⏳ Planned | | |
| P-76 Operator audit view | ⏳ Planned | | |
