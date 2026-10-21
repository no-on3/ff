# Step 1 plan: make one function useful

| | |
|---|---|
| **Status** | Started on 2026-10-21, on the branch `feat/step-1`. What is done is in the progress log (§11). The choices this plan made for you to confirm are in §9. |
| **Goal** | Step 1 of [What to build next](what-to-build-next.md): a customer can run something real on FF. A function has configuration and secrets, a public web address, a schedule, and libraries, each in AWS's shape, so the code moves to AWS as it is |
| **Parent plans** | [What to build next](what-to-build-next.md) §4; the [local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): E-01 (function URLs), E-02 (schedules), §4.6 (event sources), §4.7 (secrets), §6.2 (the runtime contract), §6.4 (event payloads), Appendix C (environment variables) and Appendix D (event payloads) |
| **Builds on** | The [client-readiness plan](client-readiness-plan.md), done up to its pilot-launch tasks; the [CLI plan](cli-plan.md), whose phases 0 to 2 are this plan's U-08 |
| **Decision records** | ADR 0007 (the event a function receives) in U-03 |

Task numbers start with U, for *useful*. The CLI plan keeps its own numbers (C-xx) and its own progress log.

FF runs functions, but only through its API, with a login token or an API key, and a function has nothing but its code. Four gaps stop a customer from running anything real, and this plan closes them, in this order:

| Phase | You get | Needs |
|---|---|---|
| **0. Groundwork** | This plan, the baseline | nothing |
| **1. Environment and secrets** | A function's environment variables, with Lambda's rules, encrypted at rest; secrets that no one can read back; both given to the function when it starts | an encryption key for the platform |
| **2. AWS's events** | The function receives what Lambda would: a direct invoke's payload as the event itself. Existing functions keep today's wrapper until switched (ADR 0007) | nothing |
| **3. Function URLs** | A public HTTPS address per function, AWS's HTTP event (payload 2.0) and response rules, CORS, public or key-protected; TLS at the edge; then custom domains | phase 2; DNS for FF's function domain |
| **4. Schedules** | AWS's `rate()` and `cron()` expressions, the EventBridge "Scheduled Event" | phase 2 |
| **5. Packages and the `ff` command** | The CLI plan's phases 0 to 2: zips with `node_modules` or pip packages, and the commands for this plan's services | the CLI plan |

---

## 1. Where FF stands

Checked against the code on 2026-10-21 (commit `1bd102e`).

| Finding | Where | Consequence |
|---|---|---|
| **A function has no environment.** The Deployment's variables are FF's own: `FUNCTION_NAME`, `FUNCTION_TIMEOUT`, `FF_HANDLER` and the like. | `BE/src/orchestrator/kubernetes/manifests.ts`, `deploymentManifest` | A database password must be written in the code. Every member and every key with `functions:read` reads the code, and its copy sits in object storage. |
| **The backend may not touch Secrets at all.** Its ClusterRole leaves them out on purpose, and P-64 checks that no platform credential is in anything the backend reads. | `deploy/k8s/base/20-clusterrole.yaml`, `40-admission-policy.yaml`, `hack/k8s/test-rbac.sh` | The way a customer's secret reaches a pod has to be designed (D3), keeping that rule. |
| **The event is FF's own wrapper.** Both runtimes hand the handler `{ body, headers, method, query, path }`, built from the backend's own request to the pod: `body` is the input, and the headers are the backend's. On Lambda, a direct invoke's payload is the event itself. | `runtimes/nodejs/src/main.ts` (`acceptInvocation`), `runtimes/python/ff_runtime/main.py` | Every handler written for FF reads `event.body`, and fails on Lambda. A web address or a schedule needs AWS's own events (parent §6.4), which the wrapper would bury under `body`. The CLI plan left this as its question 1. |
| **Invoke input must be a JSON object.** | `BE/src/functions/dto/invoke-function.dto.ts` | Lambda takes any JSON value: a string, a number, an array. |
| **A function can only be called through the API**, with a login token or an API key with `functions:invoke`. | `BE/src/functions/functions.controller.ts` | No browser, no payment provider's webhook, no other company's system can call it. |
| **The edge serves four fixed hostnames,** each with a certificate from Let's Encrypt by HTTP-01. | `deploy/k8s/platform/edge/Caddyfile` | A host per function needs either one wildcard certificate (DNS-01) or a certificate per host on demand (D7). |
| **Nothing runs on a schedule** for customers. The backend's own periodic jobs (alarms, notifications, retention) take their due rows with `FOR UPDATE SKIP LOCKED`, so that several backends never do one twice. | `BE/src/alarms/alarm-evaluator.service.ts`, `notification-worker.service.ts` | The pattern exists for a scheduler (D9). |
| **A function is one file,** at most 900 KiB, in an immutable ConfigMap; the API refuses bodies over about 100 KB. | `manifests.ts` (`MAX_CODE_BYTES`); the CLI plan's C-03 | No libraries. That is the CLI plan's phase 2 (U-08). |
| **One backend replica.** The rate limits count in memory, and the scaler counts calls in flight. | client-readiness plan, §2 non-goals | Every new way in (a URL, a schedule) must go through the same counters, in the same process. |

## 2. Goals and non-goals

**Goals:**
- **AWS's shapes everywhere:** Lambda's rules for variables, its event for direct invokes, API Gateway's payload 2.0 for URLs, EventBridge's scheduled event, SAM's names. A handler written on FF runs on Lambda unchanged, and the reverse (parent §3.3).
- **Secrets never readable back:** not by the API, the console, the audit log, the logs, nor the backend's cluster token, and encrypted at rest.
- **Every way in is an invocation:** a URL request and a scheduled run are recorded, metered, billed, rate-limited and checked for credit exactly like a direct invoke, with the same history, logs and metrics.
- **Isolation stays proven:** every new route is in the L5 suite, and a URL or a domain never reaches another account's function.

**Non-goals (for now):**
- **Async invoke, retries, dead-letter queues:** step 3's queue. A scheduled run that fails is recorded, not retried (D9).
- **SigV4 and the Lambda API.** `AWS_IAM` on an FF function URL means an FF API key (D6), until the Lambda API facade (parent E-06, E-07).
- **Response streaming** (`RESPONSE_STREAM`), WebSockets, API Gateway's REST API (payload 1.0), routes and authorizers.
- **Time zones in schedules** (EventBridge Scheduler has them; EventBridge rules, which SAM's `Schedule` event creates, don't), one-time `at()` schedules, flexible windows.
- **Versions and aliases** (parent R-01, step 5): a URL and a schedule point at the function itself, `$LATEST`.
- **Secret rotation without a deploy** ([What to build next](what-to-build-next.md) §9.6): changing a secret rolls out a new version.

## 3. Decisions

D5 is recorded in ADR 0007 (U-03). The others are recorded here.

### D1. Environment variables: Lambda's rules and shape
- **The field:** `environment`, a map of names to string values, on `POST /functions` and `PUT /functions/:id`. An update replaces the whole map, as Lambda's `UpdateFunctionConfiguration` does. `GET /functions/:id` returns it. A future Lambda API maps it to `Environment.Variables`.
- **Names:** Lambda's rule: a letter first, then letters, digits or underscores, two characters at least.
- **Reserved names** are refused with the reason: every name Lambda reserves (`_HANDLER`, `AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME`, `AWS_ACCESS_KEY_ID`, `LAMBDA_TASK_ROOT` and the rest of its list), FF's own runtime names (`FUNCTION_NAME`, `FUNCTION_VERSION`, `FUNCTION_MEMORY_LIMIT`, `FUNCTION_TIMEOUT`, `PORT`, and every `FF_` name), and `PATH`, which FF's runtimes start with. The names Lambda leaves open stay open: `TZ`, `LANG`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `LD_LIBRARY_PATH`, and every other `AWS_` name (`AWS_NODEJS_CONNECTION_REUSE_ENABLED` is common in SAM templates). A `TZ` of the customer's replaces FF's `UTC`.
- **Size:** at most 4 KB, measured as Lambda measures it: the JSON text of the map. Secrets count too (D2), so that both fit in Lambda's variables after an export.
- **Who reads them:** what reads the code. Variables are configuration: every member and every key with `functions:read` reads them, as on Lambda, where `GetFunctionConfiguration` returns them. A value no one should read goes in a secret.
- **The audit log** records the names added, changed and removed, never a value.
- **Encrypted at rest** (D4), like everything in the environment.

### D2. Secrets: write-only values, delivered as variables
- **What a secret is:** a variable whose value no one reads back. The function reads it as any variable (`process.env.DB_PASSWORD`), so its code is the same on AWS, where the export writes it as a variable, or as a Secrets Manager reference.
- **Routes:** `GET /functions/:id/secrets` gives each secret's name and when it changed, to every member. `PATCH /functions/:id/secrets` sets values and removes names (JSON merge patch: a string sets, `null` removes), for owners and developers. A change rolls out a new version, as a variable's does, and the answer comes once it is live. `POST /functions` takes `secrets` too, so a function never starts without them.
- **Never shown:** not by the API, the console, the audit log (names only), the invocation history or the backend's log. A validation message names the secret, never its value.
- **Names:** D1's rule. A name is a variable or a secret, not both.

### D3. Delivery: a Kubernetes Secret per function, written but never read by the backend
- **The pod reads its environment from a Secret** in its account's namespace, through `envFrom`. A pod spec, a Deployment and a ConfigMap never hold a value, so nothing the backend can read holds one.
- **The backend may create, update, patch and delete Secrets, never get, list or watch them.** The admission policy keeps those writes to `ff-t-*` namespaces, as it does every write. A write's own answer carries the object written: in a tenant namespace that is the customer's environment, which the backend wrote; anywhere else the admission policy refuses before anything is written or returned. `hack/k8s/test-rbac.sh` checks all of it.
- **Two Secrets per function, used in turn:** `fn-<id>-env-0` and `fn-<id>-env-1`. A new environment goes into the one the running version doesn't use, and the Deployment moves to it. Pods of the old version keep their Secret, so a pod restarted during a rollout never mixes old code and new values, and a rollback finds the old values where they were. The backend reads which one is in use from the Deployment, so it stores nothing more and never lists Secrets. Deleting the function deletes both.
- **A function without variables or secrets** has no Secret and no `envFrom`.
- **The pod template names the environment's revision,** a random ID that changes with every new environment. It never derives from the values, so it says nothing about them.
- **In the cluster,** etcd keeps Secrets encrypted when k3s's secrets encryption is on (`--secrets-encryption`), which the deploy guide makes a requirement.

### D4. Encryption at rest: AES-256-GCM, a data key per function, keys from a file
- **Envelope encryption,** as parent §4.7 asks:
  - each function's environment (variables and secrets together) is encrypted with its own random 256-bit data key, AES-256-GCM;
  - the data key is encrypted with the platform's key;
  - both are bound to the function's ID as additional data, so a row copied onto another function fails to decrypt.
- **The platform's keys** come from a file, `FF_ENCRYPTION_KEYS_FILE`: one key a line, `<id>:<32 bytes in base64>`. The first line encrypts; every line decrypts, so a new key can be added first and the old one removed once nothing uses it. Production refuses to start without the file. Development has a fixed key, refused in production.
- **One table,** `function_environments`, apart from `functions`, so that no list of functions ever loads or serializes it.
- **Later:** OpenBao's transit engine can wrap the data keys instead of the file (parent §4.10), without changing what the table holds.
- **The key is part of the backups** (P-61's runbook): without it, the environments can't be read.

### D5. Events: AWS's shapes, built by the backend (ADR 0007)
- **The runtime passes the payload through.** Runtime protocol v3: the body of `POST /invoke` *is* the event, any JSON value. The backend builds every event: a direct invoke's input as it came, a URL's request as API Gateway's payload 2.0 (D6), a schedule's EventBridge event (D9).
- **Existing functions keep today's wrapper** until their owner switches them. A function has an `eventFormat`: `lambda`, the default for new functions, or `wrapped`, which a migration gives every function that exists. The v3 runtime builds the wrapper itself for a `wrapped` function, as v2 did, so its handlers see no change. Switching is an update, rolled out like any.
- **URLs and schedules need `lambda`:** a `wrapped` function would get AWS's event under `body`, which works nowhere else. The API says so, and the console offers the switch.
- **Invoke input** may be any JSON value, as on Lambda.
- **Images:** `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`. Running functions keep their image until their next update, which works either way: a `wrapped` function gets the same event from v2 and v3.

### D6. Function URLs: Lambda's model, served by the backend on a port of its own
- **One URL per function,** as on Lambda: `https://<url-id>.<function domain>/`, where `<url-id>` is 32 random lowercase letters and digits, Lambda's format, fixed for the URL's life. Deleting the URL and creating it again gives a new address.
- **Its configuration, in Lambda's shape:**
  - `authType`: `NONE`, anyone may call it; or `AWS_IAM`, which on FF means an API key of the function's account with `functions:invoke`, sent as `Authorization: Bearer ffk_…`. SigV4 comes with the Lambda API facade (parent E-06, E-07). The setting exports to SAM unchanged; the callers' way of signing is the one difference, and the documentation says so;
  - `cors`: Lambda's six fields (`allowCredentials`, `allowHeaders`, `allowMethods`, `allowOrigins`, `exposeHeaders`, `maxAge`). With it set, FF answers the browser's preflight itself and adds the headers to every answer, as Lambda does;
  - `invokeMode`: `BUFFERED` only (non-goal: streaming).
- **The function URL gateway:** a second HTTP server in the backend process, on its own port (`FF_FUNCTION_URL_PORT`), that serves nothing but function URLs, by host name. None of the API's middleware applies to it: no API CORS, no login guard, no body parser. In a cluster the edge sends `*.<function domain>` to it (U-05). It moves out of the backend with the invocation gateway, later (parent R-05).
- **The event:** API Gateway's payload format 2.0, as Lambda's function URLs send it (parent Appendix D):
  - header names in lower case, repeated headers joined with commas, cookies in `cookies` rather than in `headers`;
  - `queryStringParameters` with repeated parameters joined with commas, and only when there is a query;
  - `requestContext` with `accountId` (`anonymous` for `NONE`), `apiId` and `domainPrefix` (the URL's ID), `domainName`, `http`, `requestId` (the invocation's ID, D10), `time` and `timeEpoch`, and `authorizer.iam` for `AWS_IAM`, with the key's ID and account;
  - the body as text when its content type names text, JSON or XML and it is valid UTF-8; otherwise base64, with `isBase64Encoded`. AWS doesn't document its own rule beyond "binary is base64"; this one is LocalStack's emulation of it, and a handler that reads `isBase64Encoded` works with both.
- **The answer,** by Lambda's rules:
  - an object with `statusCode` is a response: `statusCode` (100 to 599), `headers`, `cookies` (each a `Set-Cookie`), `body`, `isBase64Encoded`;
  - anything else is `200`, `content-type: application/json`, and the value as JSON (a string `"Hello"` answers `"Hello"`, quotes included, as Lambda's documentation shows);
  - a function that raises, times out or crashes answers `502`; no instance free in time, or the plan's rate, `429`; no credit, `402`; a function that isn't `ACTIVE`, `503`. Each answer carries `x-amzn-RequestId`, the invocation's ID.
- **Limits:** 6 MB for the event and for the answer, Lambda's; `413` above.
- **What is kept:** the invocation's history keeps the event with `authorization`, `cookie` and `x-api-key` values replaced by `***`, and no `cookies`: FF never stores the function's callers' credentials.
- **A public URL can be called by anyone,** on the account's bill. What bounds it: the plan's invocations per second, the function's `maxInstances`, and the account's credit. Rate limits per address belong to the edge, later ([What to build next](what-to-build-next.md) §9.4).

### D7. TLS for function URLs: one wildcard certificate, or one per host
- **Production:** one certificate for `*.<function domain>`, which Let's Encrypt only issues through a DNS-01 challenge. The edge image includes Caddy's RFC 2136 module, the standard protocol for DNS updates, which BIND, Knot and PowerDNS accept, so FF depends on no DNS company. An operator whose DNS is elsewhere builds the edge with that provider's module: one line of its Dockerfile.
- **Without DNS access:** certificates on demand, one per host, issued at the host's first request, after the backend says the host is a function URL (the edge's `ask` question). Let's Encrypt allows 50 new certificates a week per registered domain, so this suits a small beta only.
- **Custom domains** always use certificates on demand (D8).

### D8. Custom domains: proved by DNS, certified on demand
- **A domain is the account's** once DNS proves it: a CNAME from the domain to the function's URL host, or, for a domain apex, which can't have a CNAME, a TXT record `_ff-verify.<domain>` with the token FF gives and an A record to the edge.
- **One function per domain,** and a domain belongs to one account. The plan limits how many an account has.
- **The edge asks before each certificate.** The backend answers yes only for a verified domain or a function URL host. The edge has no other list of hosts.
- **The event:** `requestContext.domainName` is the custom domain, as on AWS.

### D9. Schedules: EventBridge rules' expressions and event
- **Per function,** as SAM's `Schedule` event declares them: a name unique within the function, an expression, an optional fixed input, `enabled`, an optional description.
- **Expressions,** exactly as EventBridge rules take them:
  - `rate(1 minute)`, `rate(5 minutes)`, `rate(1 hour)`, `rate(2 days)`: the unit singular for 1 and plural above. The first run comes one interval after the schedule is created;
  - `cron(minutes hours day-of-month month day-of-week year)`: six fields, UTC, with `,`, `-`, `*`, `/`, `?`, `L`, `W` and `#`, month names `JAN`–`DEC`, day names `SUN`–`SAT` (`1` is Sunday), years 1970 to 2199. One of the two day fields is `?`. Nothing runs more often than once a minute.
- **The event:** EventBridge's "Scheduled Event" (`version`, `id`, `detail-type`, `source: aws.events`, `account`, `time` (the scheduled time), `region`, `resources` (the rule's ARN), `detail: {}`), or the fixed input when the schedule has one, as SAM's `Input` does.
- **How it runs:** every few seconds, the backend takes the schedules due with `FOR UPDATE SKIP LOCKED`, moves each to its next run, commits, then invokes. So a run happens **at most once**, even with several backends; a backend stopped between the commit and the call loses that run. A schedule late by any amount runs once, then follows its expression from now: missed runs aren't made up one by one.
- **No retries:** a run that fails is in the history and the metrics, so an alarm can watch it. Lambda retries the asynchronous calls EventBridge makes; FF will when step 3 brings asynchronous invokes.
- **Skipped runs:** when the account isn't active, has no credit, or the function isn't `ACTIVE`, the run is skipped, and the schedule's last outcome says why.

### D10. Every way in is an invocation
- A URL request and a scheduled run go through the same path as `POST /functions/:id/invoke`:
  - the account's credit (402);
  - the plan's invocations per second, one count for all three ways (429);
  - concurrency and autoscaling, the cold start;
  - the invocation's record and history, its usage record and its bill, its metrics and its log lines, under one request ID.
- **The history says which way:** each invocation has a `source`: `api`, `url` or `schedule`.
- **Usage records don't change:** a call costs the same whichever way it came.

### D11. Plans: two new limits
- `schedules`: how many schedules an account may have; 20 on the beta plan.
- `customDomains`: how many custom domains; 5 on the beta plan.
- Function URLs need no limit of their own: one per function, and the plan already limits functions.

### D12. The region in events
Events name a region: the schedule's `region` and its rule's ARN. FF's region is `FF_REGION`, `tn-tunis-1` by default, the parent plan's example (§4.8), until its ADR-006 names the region and the partition.

## 4. Data model

New tables and columns, as a sketch.

```sql
-- Environment and secrets (U-01, U-02): one row per function that has any
create table function_environments (
  function_id uuid primary key references functions on delete cascade,
  account_id char(12) not null,
  revision text not null,                  -- random, new with every change: the pod template's annotation (D3)
  document jsonb not null,                 -- D4: { v, kid, wrappedKey, iv, ciphertext, tag } in base64
  updated_at timestamptz not null default now());
-- the plaintext of document: { "variables": { "NAME": "value" }, "secrets": { "NAME": { "value": "…", "updatedAt": "…" } } }

-- The event format (U-03)
alter table functions add column event_format text not null default 'lambda'
  check (event_format in ('lambda', 'wrapped'));     -- the migration sets every existing function to 'wrapped'

-- Function URLs (U-04)
create table function_urls (
  function_id uuid primary key references functions on delete cascade,
  account_id char(12) not null,
  url_id char(32) not null unique,          -- [a-z0-9]{32}: the host's first label
  auth_type text not null check (auth_type in ('NONE', 'AWS_IAM')),
  cors jsonb,                               -- Lambda's Cors, camelCase; null: none
  invoke_mode text not null default 'BUFFERED' check (invoke_mode = 'BUFFERED'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
alter table function_invocations add column source text not null default 'api'
  check (source in ('api', 'url', 'schedule'));

-- Custom domains (U-06)
create table custom_domains (
  domain text primary key,                  -- lowercase, no trailing dot
  account_id char(12) not null references accounts,
  function_id uuid not null references functions on delete cascade,
  token text not null,                      -- for the TXT record
  status text not null check (status in ('pending', 'verified')),
  checked_at timestamptz, check_error text, verified_at timestamptz,
  created_at timestamptz not null default now());

-- Schedules (U-07)
create table schedules (
  id uuid primary key default gen_random_uuid(),
  account_id char(12) not null references accounts,
  function_id uuid not null references functions on delete cascade,
  name text not null,
  description text,
  expression text not null,                 -- rate(…) or cron(…), as written
  input jsonb,                              -- null: the Scheduled Event
  enabled boolean not null default true,
  next_run_at timestamptz,                  -- null while disabled
  last_run_at timestamptz, last_request_id uuid, last_outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (function_id, name));
create index on schedules (next_run_at) where enabled;

-- Plans (D11): limits gain "schedules" and "customDomains"
```

## 5. API changes

| Route | What | Task |
|---|---|---|
| `POST /functions`, `PUT /functions/:id`, `GET /functions/:id` | `environment` (D1); `secrets` on create only (D2); `eventFormat` (D5) | U-01, U-02, U-03 |
| `GET`, `PATCH /functions/:id/secrets` | Each secret's name and when it changed; set or remove values (D2) | U-02 |
| `POST /functions/:id/invoke` | `input` may be any JSON value; a `lambda` function gets it as its event (D5) | U-03 |
| `GET /functions/:id/invocations` | Each invocation with its `source` (D10) | U-04 |
| `POST`, `GET`, `PUT`, `DELETE /functions/:id/url` | The function's URL configuration (D6) | U-04 |
| Any method, `<url-id>.<function domain>/<path>`, on the gateway's port | The function URL itself (D6) | U-04 |
| `GET /tls/allowed?domain=`, on the gateway's port, for the edge only | Whether to get a certificate for a host (D7, D8) | U-05 |
| `GET`, `POST /functions/:id/url/domains`, `POST /functions/:id/url/domains/:domain/verify`, `DELETE /functions/:id/url/domains/:domain` | Custom domains (D8) | U-06 |
| `GET`, `POST /functions/:id/schedules`, `GET`, `PUT`, `DELETE /functions/:id/schedules/:scheduleId` | Schedules (D9) | U-07 |
| `GET /schedules/next-runs?expression=` | The next runs of an expression, for the console's preview | U-07 |
| `/admin/functions/:id` | The support page shows the function's URL, domains and schedules, and its variables' and secrets' names, never their values | U-04, U-07 |

## 6. Working rules

The same as the client-readiness plan's (§6 there):
- `hack/check-resources.sh` runs before every heavy step, and only one heavy operation runs at a time.
- Work on the branch `feat/step-1`, with one commit per task, or per part of a task: `type(scope): summary (U-xx)`.
- Each commit passes `npx tsc --noEmit`, `npm run lint` and `npm test` in `BE/`, and the console's and the admin app's builds when they change, plus the task's own tests.
- Each task's progress row records its tests and the documents it changed. Changed documents pass `hack/check-docs.py`.
- Code names no task or decision of this plan: comments, test names and API descriptions say in plain English what led to the code.

**Test levels:** the client-readiness plan's L0 to L5 (type-check and build; unit; PostgreSQL; cluster; end to end; across accounts), plus each runtime's own suites (`runtimes/nodejs/test`, `runtimes/python/tests`) and their container smoke tests. Every new route joins the L5 suite, `hack/e2e-tenancy.sh`.

## 7. Tasks

### Phase 0: groundwork

#### U-00: The plan and the baseline
- Commit [What to build next](what-to-build-next.md) and the CLI plan's update of 2026-10-21 as they were written, then this plan on its own branch.
- Bring the documents up to date with the code: the CLI plan's question 6 (function names) was decided by the commit that gave names Lambda's rule (`1bd102e`), and its §1.2 still says the rule isn't enforced.
- Record the baseline: `tsc`, lint and the unit tests in `BE/`.
- **Done when:** the documents pass `hack/check-docs.py`, and the baseline is in the progress log.

### Phase 1: environment and secrets

#### U-01: Environment variables
- **Backend:**
  - the key ring (D4): `FF_ENCRYPTION_KEYS_FILE`, read at start, refused in production when missing or malformed; the development key otherwise;
  - `function_environments` and its migration; the encryption, bound to the function's ID;
  - `environment` on create and update (D1), validated: names, reserved names, 4 KB; a change rolls out a new version, and a rollback restores the previous environment with the previous code;
  - `GET /functions/:id` returns it; `GET /functions` doesn't;
  - the audit log's `function.update` and `function.create` name the variables, never their values.
- **Cluster (D3):**
  - the workload carries the environment and its revision; `apply` writes the Secret slot the running version doesn't use, then the Deployment with `envFrom` and the revision's annotation; `remove` deletes both slots;
  - FF's `TZ=UTC` gives way to the customer's `TZ`;
  - the ClusterRole gains `create`, `update`, `patch` and `delete` on Secrets, the admission policy covers Secrets, and `deploy/k8s/README.md` says why.
- **Console:** an Environment tab: the variables as a table to edit, the 4 KB used, Save rolls out.
- **Tests:**
  - L1: names and reserved names, the size as Lambda measures it, the encryption (a wrong key, another function's ID, a changed byte all fail; two encryptions of one value differ), the manifests (`envFrom`, the slot, the annotation, nothing when empty), the slot choice (unchanged, changed, after a rollback), the service (a rollout on change, none without, the rollback restores, the audit details hold no value);
  - L2: the stored document holds no value in clear; deleting the function deletes its row;
  - L3: a function reads its variable; after an update, the new value; the old pods kept their Secret during the rollout;
  - RBAC (`hack/k8s/test-rbac.sh`): the backend writes a Secret in a tenant namespace, never in `ff-system` or `default`, and reads none anywhere;
  - L4 (`hack/e2e.sh`): create with a variable, invoke and read it, update it, read the new value;
  - console (Vitest): the editor's checks.
- **Docs:** the getting-started guide ("Configuration and secrets"), `deploy/k8s/README.md` (the Secrets rule, k3s secrets encryption), the backup runbook (the key), `BE/.env.example`.

#### U-02: Secrets
- **Backend:** `secrets` on create; `GET` and `PATCH /functions/:id/secrets` (D2); the 4 KB counts variables and secrets together; a name is one or the other.
- **Console:** a Secrets section in the Environment tab: names and dates, set, replace, remove; a value is typed, never shown.
- **Tests:**
  - L1: the merge patch (set, replace, remove, a name that is a variable, too large), the answers never holding a value, validation messages never echoing one;
  - L4: a function reads its secret; the API, the history and the audit log hold no value; a viewer lists the names and can't set one;
  - L5: both routes, across accounts.
- **Docs:** the getting-started guide's "Configuration and secrets".

### Phase 2: AWS's events

#### U-03: The event a function receives (ADR 0007)
- **ADR 0007** records D5: why the payload is the event, why the backend builds every event, and how `wrapped` functions keep working.
- **Runtimes, protocol v3:**
  - the body of `POST /invoke` is the event, any JSON value, unless `FF_EVENT_FORMAT=wrapped`, which builds v2's wrapper;
  - images `24-v3` and `3.13-v3`, the defaults in the configuration and in every script that names `-v2`;
  - each README's "What changed in v3".
- **Backend:** `functions.event_format` and its migration (every existing function `wrapped`); `eventFormat` on create and update, a change rolled out; `FF_EVENT_FORMAT` in the manifests; invoke input any JSON value.
- **Console:** the invoke box takes any JSON value; a `wrapped` function's page says what its handler gets and offers the switch.
- **Examples and docs:** `examples/` read the event itself; the getting-started guide, `how-it-works.html` (the invoke), the CLI plan's question 1 answered.
- **Tests:**
  - runtimes: a payload of each JSON kind reaches the handler as is; `wrapped` gives v2's wrapper; both container smoke tests;
  - L1: the manifests' variable, the rollout on a switch, the DTO;
  - L2: the migration sets existing functions `wrapped`, and a new one is `lambda`;
  - L3 and L4: both formats, end to end.

### Phase 3: function URLs

#### U-04: Function URLs
- **Part 1, the backend:**
  - `function_urls` and its migration; `POST`, `GET`, `PUT` and `DELETE /functions/:id/url`, writers for changes; a `wrapped` function is refused with the way to switch;
  - the gateway (D6): `FF_FUNCTION_URL_PORT` and `FF_FUNCTION_URL_BASE` (`http://fn.localhost:3001` in development, where every browser takes `*.localhost` to this machine; `https://fn.<domain>` in production, which refuses `http://`);
  - the event builder and the answer's mapping (D6), the CORS preflight and headers, `AWS_IAM` with an API key;
  - the invocation's core taken out of `FunctionsService.invoke`, so the API, the gateway and later the scheduler share it (D10); `function_invocations.source`; the redacted copy for the history;
  - the plan's rate shared with the API's invocations, through the throttler's own storage;
  - the admin app's support page shows the URL.
- **Part 2, the console:** a URL tab: create, the address with a copy button, the auth type, CORS, delete; the history's source column.
- **Tests:**
  - L1: the event against AWS's published sample (headers, cookies, query, base64, custom domain), the answer's mapping (each inference rule, cookies, base64, a bad `statusCode`, bad header names), CORS (preflight allowed and refused, credentials), the host's parsing, the auth;
  - L2: a URL ID is unique; deleting the function deletes its URL;
  - L4: `curl` through the gateway: `GET` with a query, a JSON `POST`, a binary `PUT`, a cookie set and read, a 404 path answered by the function, a preflight, `AWS_IAM` with and without a key, a function's error as 502, the invocation in the history as `url` with its redactions, a usage record;
  - L5: the four routes; a URL's host never reaches another account's function;
  - console: Vitest for the forms; a check in a browser.
- **Docs:** the getting-started guide ("A web address for a function"), `how-it-works.html` (a URL request, hop by hop), `BE/.env.example`.

#### U-05: TLS for function URLs at the edge
- **The edge image** built with `xcaddy` and the RFC 2136 module (D7). The Caddyfile gets the function domain's site: `*.<function domain>` to the backend's gateway port; with `FF_FUNCTION_URL_TLS=wildcard`, a DNS-01 certificate from the TSIG key in a Secret; with `on-demand`, a certificate per host after the backend's yes.
- **The backend:** `GET /tls/allowed?domain=` on the gateway's port; the backend's Service gains the gateway's port, and its NetworkPolicy lets the edge reach it.
- **Tests:** `hack/k8s/test-platform-manifests.sh`; L4 platform (`hack/e2e-platform.sh`, with Caddy's own authority, offline): a function URL through the edge over HTTPS; `ask` answers no for an unknown host.
- **Docs:** `deploy/k8s/README.md`: the DNS records (`*.fn` to the edge), the TSIG key, the on-demand mode and its Let's Encrypt limit.

#### U-06: Custom domains
- **Backend:** `custom_domains` and its migration; the routes (D8); verification by a DNS lookup (CNAME, or TXT and A), retried by `POST …/verify`; the gateway serves a verified domain; `GET /tls/allowed` says yes for it; the plan's `customDomains`.
- **Console:** domains in the URL tab: add, the record to create, verify, remove.
- **Tests:** L1 with a stub resolver (a CNAME, a TXT, a wrong one, none, a domain of another account); L2 (a domain belongs to one account); L4 platform (a domain reaches its function over HTTPS through the edge); L5.
- **Docs:** the getting-started guide; `deploy/k8s/README.md`.

### Phase 4: schedules

#### U-07: Schedules
- **Part 1, the backend:**
  - the expression parser and the next run (D9), in UTC, with EventBridge's errors;
  - `schedules` and its migration; the routes; `GET /schedules/next-runs`; the plan's `schedules` (D11);
  - the scheduler: every `FF_SCHEDULER_INTERVAL_SECONDS` (5), the due schedules taken with `SKIP LOCKED`, moved, then invoked through the shared core with `source: schedule`; the skipped runs and their reason;
  - `FF_REGION` (D12); the Scheduled Event;
  - the admin app's support page shows the schedules.
- **Part 2, the console:** a Schedules tab: the list with the next run and the last outcome, a form with the next runs as the expression is typed, enable, disable, delete.
- **Tests:**
  - L1: every example of EventBridge's documentation, and the hard cases: `L`, `LW`, `W` near a month's ends, `#` and the fifth one that doesn't exist, `?` rules, ranges that wrap (`20-2`), steps, names, the year field, leap years, the singular and plural of `rate()`, more than once a minute refused;
  - L2: two schedulers never run one schedule twice; a disabled one never runs; deleting the function deletes its schedules;
  - L4: `rate(1 minute)` runs within 70 s, with the Scheduled Event, recorded as `schedule`; a fixed input; a disabled schedule doesn't run;
  - L5: the routes.
- **Docs:** the getting-started guide ("Run a function on a schedule"), `how-it-works.html`.

### Phase 5: packages and the `ff` command

#### U-08: The CLI plan's phases 0 to 2, and its commands for this plan's services
- The CLI plan's C-00 to C-27, in its order, each with its own progress row there.
- With them, once phase 1 is done: `ff env` and `--env` (C-31's CLI part), `ff secrets` (C-53's part), `ff url` (C-50) and `ff schedule` (C-51), which need only this plan's API.
- **Done when:** the CLI plan's C-27 is done, and its phase-5 rows for step 1 are.

#### U-09: The step closed
- `how-it-works.html` and the getting-started guide walk through one small app: a web address that writes to a database through a secret, a nightly schedule, a package with a driver.
- [What to build next](what-to-build-next.md) marks step 1 done, and step 2 gets its plan.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A public URL is called in a loop, on the customer's bill | The plan's invocations per second, the function's `maxInstances`, the credit check; rate limits per address at the edge later; the URL can be deleted at once, and a new one has a new address |
| The platform's encryption key is lost: every environment is unreadable | The key file in the backups and the restore runbook (P-61); several keys allowed, so a new one never replaces the old one at once |
| A secret's value leaks through a log or an error | Values never reach a log line, an audit entry, the history or a message; L1 and L4 tests look for a known value everywhere the API and the logs answer |
| The backend's new right to write Secrets is misused | Writes only, confined by the admission policy to tenant namespaces; checked by `test-rbac.sh` |
| Wildcard certificates need DNS access the operator lacks | Certificates on demand (D7), within Let's Encrypt's weekly limit; the RFC 2136 module works with self-hosted DNS |
| The event switch breaks existing handlers | Existing functions stay `wrapped`, with the same event from v2 and v3; switching is explicit and rolled out like any change, and a failed switch rolls back |
| FF's URL event differs from AWS's where AWS documents nothing (the base64 rule, a non-string `body`) | FF's rules are written down and tested; a handler that reads `isBase64Encoded` works on both; `ff doctor` (CLI plan C-33) flags the rest |
| A scheduled run is lost when the backend stops at the wrong moment | At most once by design (D9), stated in the documentation; asynchronous invokes with retries in step 3 |
| URL traffic and the API share one backend process | The gateway is a separate server on its own port, so it can move to a process of its own (parent R-05) without changing its contract |

## 9. Choices made for you to confirm

This plan had to decide these to start. Each can change; the task it affects is named.

| Question | This plan's choice | Affects |
|---|---|---|
| Existing functions and the new event | They keep today's wrapper until switched, one by one; new functions get Lambda's event. The other way: switch all of them now, since no customer has any yet | U-03 |
| `AWS_IAM` on a function URL | An FF API key with `functions:invoke`, until SigV4 exists | U-04 |
| Certificates for function URL hosts | A wildcard by DNS-01 with RFC 2136 if FF's DNS allows it, else one per host on demand. Where will FF's domain's DNS be hosted? | U-05 |
| The region in events and ARNs | `tn-tunis-1`, until the parent's ADR-006 | U-07 |
| A scheduled run that fails | Recorded, not retried, until step 3 | U-07 |

## 10. Effort (rough estimates, one developer)

| Task | Working days | Notes |
|---|---|---|
| U-00 | 0.5 | |
| U-01, U-02 | 4–6 | The Secrets rule in the cluster and the encryption are most of it |
| U-03 | 2–3 | Two runtimes, the migration, and every example and test that reads `event.body` |
| U-04 | 6–8 | The event and its answer, CORS, the gateway, the shared invocation core |
| U-05, U-06 | 5–7 | The edge image, DNS, on-demand TLS, domain checks |
| U-07 | 4–6 | AWS's cron syntax is the largest part |
| U-08 | 29–40 | The CLI plan's phases 0 to 2 (26 to 35), and four commands |
| U-09 | 1–2 | |
| **Total** | **51–72** | Without the CLI, 22 to 32 days, against the "about 4 weeks" of [What to build next](what-to-build-next.md), which didn't count custom domains, the encryption, or the event switch |

## 11. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| U-00 The plan and the baseline | ✅ Done | (this commit) | • [What to build next](what-to-build-next.md) and the CLI plan's update, as written on 2026-10-21, committed first on `feat/client-ready` (`e0eef37`); this plan on `feat/step-1`, made from it.<br>• Baseline before any change: backend `tsc --noEmit` exit 0, `npm run lint` 0 problems, `npm test` **84 suites / 1058 tests** (Node.js 24.22.0, `--maxWorkers=2`).<br>• The CLI plan brought up to date with the code: its question 6 decided by `1bd102e` (names follow Lambda's rule), and §1.2, D3, C-03, C-04, C-32, C-33, its risks and its progress rows with it; its question 1 taken up by this plan's U-03; C-31's backend part, and the secrets of C-53, are this plan's U-01 and U-02; C-50, C-51 and C-53 wait for this plan's tasks.<br>• [What to build next](what-to-build-next.md): its status, §4 and §12 link this plan. The docs' index and the README list it.<br>• `hack/check-docs.py`: OK on the five documents. |
| U-01 Environment variables | ⏳ Planned | | |
| U-02 Secrets | ⏳ Planned | | |
| U-03 The event a function receives | ⏳ Planned | | |
| U-04 Function URLs | ⏳ Planned | | |
| U-05 TLS for function URLs at the edge | ⏳ Planned | | |
| U-06 Custom domains | ⏳ Planned | | |
| U-07 Schedules | ⏳ Planned | | |
| U-08 Packages and the `ff` command | ⏳ Planned: the CLI plan's own log | | |
| U-09 The step closed | ⏳ Planned | | |
