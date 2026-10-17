# Getting started: run FF locally and use it

This guide takes a developer from a fresh clone to a working FF on their own machine, then shows the everyday commands. At the end you will have:

```
curl, Swagger UI, console ──▶ backend API (localhost:3000) ──▶ PostgreSQL + S3 (docker compose)
                                    │
                                    └──▶ local Kubernetes (k3d) ──▶ one namespace per tenant ──▶ function pods
```

The commands were checked on a Linux machine, against a running stack. `git clone` needs your repository's URL, and the commands that would overwrite `BE/.env` or delete data were not run there. More detail on the cluster, runtimes, and tests is in the [Kubernetes dev guide](kubernetes-dev-guide.md). To see what happens inside FF at each step, open [How FF works](how-it-works.html) in a browser: it simulates every feature, request by request.

## 1. Before you start

**Platform.** Linux on x86_64 (tested on Manjaro with kernel 6.12). The scripts read `/proc` and use GNU tools, so they need Linux. Windows with WSL 2 should work but is untested. macOS is not supported by the scripts yet.

**Tools:**

| Tool | Version | Used for |
|---|---|---|
| Docker, with the compose plugin | 24+ | PostgreSQL, S3, and the k3d cluster node |
| Node.js and npm | 24 | Backend, console, Node.js runtime tests |
| Python | 3.11+ | Python runtime tests |
| git, curl, jq | jq 1.6+ | Getting the code; the commands in this guide |
| zstd, sha512sum | any | Only for the optional gVisor sandbox |

`kubectl` and `k3d` are installed into the repository by a script (step 3); nothing goes system-wide.

**Machine.**
- At least 3.5 GB of free memory and 6 GB free on Docker's disk, plus about 1 GB for the repository.
- These ports free on 127.0.0.1: 5432 (PostgreSQL), 9003 (S3), 6550 (Kubernetes API), 3000 (backend), and 5199 (console). Section 6 shows how to move them.
- The first run downloads several hundred MB of container images and npm packages.

## 2. Set up (once)

Run everything from the repository root unless a step says otherwise.

**1. Get the code.** Until the Kubernetes work is merged, it lives on its branch.

```bash
git clone <repository-url> ff && cd ff
git checkout feat/k8s-orchestrator
```

**2. Check the machine.** Every heavy script runs this check first and stops when memory, disk, or CPU headroom is too low.

```bash
hack/check-resources.sh
```

**3. Install kubectl and k3d** into `hack/bin/`, with checksums verified.

```bash
hack/install-tools.sh
```

**4. Start PostgreSQL and S3** (SeaweedFS). The data lives in Docker volumes and survives restarts.

```bash
docker compose up -d --wait
```

**5. Create the local Kubernetes cluster.** The script:
- creates a one-node k3s cluster with k3d;
- caps it at 2 GB of memory;
- installs FF's RBAC and admission policy, with the Service proxy that a backend outside the cluster needs (`deploy/k8s/dev`);
- writes credentials to `hack/.kube/`.

It prints the `K8S_*` settings, which match the defaults in `BE/.env.example`.

```bash
hack/k8s/cluster-up.sh
```

**6. Build the function runtimes and load them into the cluster.** Each smoke test builds its image and checks that it runs hardened.

```bash
runtimes/nodejs/test/container-smoke.sh
runtimes/python/tests/container-smoke.sh
hack/k8s/load-images.sh
```

**7. Configure the backend, create the database schema, and start the backend.**

```bash
cp BE/.env.example BE/.env
cd BE && npm install
npm run migration:run
npm run start:dev
```

- The defaults in `.env.example` match the steps above. In development the backend acts as one account, `FF_DEV_ACCOUNT_ID` (`FF_AUTH_MODE=dev`), without a login; section 5 shows how to log in with Keycloak instead. To act as another account, send the header `X-FF-Dev-Account: <12 digits>`: each account sees only its own functions, and another account's answer 404, as functions that don't exist.
- **Every variable is checked when the backend starts.** A missing or bad value stops it with a message that names the variable and what it expects. `NODE_ENV=production` also refuses the development settings: the dev account, and the default database and storage credentials.
- A `BE/.env` from before 2026-10-17 sets `FF_DEV_USER_ID`, which is no longer read: copy `BE/.env.example` again. The backend says so if you forget.
- **The schema comes from migrations,** in development as in production. `npm run migration:run` applies the ones your database hasn't had yet. Run it again whenever you pull changes that add a migration (`BE/src/migrations/`). The backend refuses to start while a migration is pending, and says so.
- Leave this terminal running, and run the remaining commands from a second terminal at the repository root. Check that the backend answers: `curl -s localhost:3000/functions` prints `[]`, and the Swagger UI is at http://localhost:3000/api.

**A database created before 2026-10-17 must be reset once.** Until then, the backend created its tables itself, with other column names, and `npm run migration:run` stops with `relation "functions" already exists`. Resetting deletes your development functions and their history. Their Deployments in the cluster go with the old dev tenant's namespace (tenant `1`):

```bash
docker compose exec postgres psql -U postgres -c 'DROP DATABASE serverless_platform WITH (FORCE)' -c 'CREATE DATABASE serverless_platform'
source hack/k8s/env.sh && kubectl delete namespace "ff-t-$(printf %s 1 | sha256sum | cut -c1-12)" --ignore-not-found
(cd BE && npm run migration:run)
```

**8. The console (optional)**, in its own terminal:

```bash
cd FE && npm install && npm run dev
```

It runs on http://localhost:5199 and calls the API on localhost:3000. Without a login, as here, it acts as the backend's development account: it creates, invokes, and edits functions, shows their invocation history, and changes their instance limits. "Log in with Keycloak" in section 5 adds the login, sign-up, accounts and API keys.

**9. The gVisor sandbox (optional).** This runs every function in gVisor, an extra isolation layer. Restart the backend afterwards.

```bash
hack/k8s/gvisor-up.sh                                       # about 80 s the first time
sed -i 's/^K8S_RUNTIME_CLASS=.*/K8S_RUNTIME_CLASS=gvisor/' BE/.env
```

**Check the whole setup** with the end-to-end test. It uses its own compose project, ports, and backend, so it can run next to your dev stack. It takes about 3 minutes and needs 3.5 GB of free memory.

```bash
hack/e2e.sh
```

## 3. Use FF

The commands below assume the backend from step 7 and use the example functions in [`examples/`](../examples). They work in bash and zsh.

```bash
FF=http://localhost:3000
```

**Create a Node.js function** from a file. The call returns once the function is running (`"status": "ACTIVE"`):

```bash
ID=$(jq -n --rawfile code examples/hello.ts \
       '{name: "hello", runtime: "nodejs", memory: 128, timeout: 5, code: $code}' \
     | curl -s "$FF/functions" -H 'content-type: application/json' -d @- | jq -r .id)
echo "$ID"
```

**Invoke it.** `input` becomes `event.body` in the handler, and `duration` is the execution time in milliseconds, as the runtime measured it:

```bash
curl -s -X POST "$FF/functions/$ID/invoke" -H 'content-type: application/json' \
  -d '{"input": {"name": "Tunis"}}' | jq '{id, status, output, duration}'
# {"id": "6f1c…", "status": "COMPLETED", "output": {"message": "Hello Tunis", "requestId": "6f1c…"}, "duration": 1.09}
```

The invocation's `id` is also the call's request ID: the handler gets it as `context.awsRequestId`, the function's log names the call by it (`START RequestId: 6f1c…`), and so does its usage record (section 5).

**A Python function**, the same way:

```bash
PY=$(jq -n --rawfile code examples/hello.py \
       '{name: "hello-py", runtime: "python", memory: 128, timeout: 5, code: $code}' \
     | curl -s "$FF/functions" -H 'content-type: application/json' -d @- | jq -r .id)
curl -s -X POST "$FF/functions/$PY/invoke" -H 'content-type: application/json' -d '{"input": {"name": "Sfax"}}' | jq .output
```

**Errors and timeouts.** A function that raises, or runs past its timeout, answers HTTP 400 with the error. The invocation is recorded as `ERROR` or `TIMEOUT`. `examples/hello.py` raises for the name `error`, and `examples/slow.py` sleeps:

```bash
curl -s -X POST "$FF/functions/$PY/invoke" -H 'content-type: application/json' -d '{"input": {"name": "error"}}' | jq .message
# "ValueError: this name is not allowed"

SLOW=$(jq -n --rawfile code examples/slow.py \
         '{name: "slow", runtime: "python", memory: 128, timeout: 2, code: $code}' \
       | curl -s "$FF/functions" -H 'content-type: application/json' -d @- | jq -r .id)
curl -s -X POST "$FF/functions/$SLOW/invoke" -H 'content-type: application/json' -d '{"input": {"seconds": 5}}' | jq .message
# "Sandbox.Timedout: Task timed out after 2.00 seconds"
```

**List and inspect:**

```bash
curl -s "$FF/functions" | jq '.[] | {id, name, runtime, status}'
curl -s "$FF/functions/$ID" | jq '{name, runtime, memory, timeout, status}'
curl -s "$FF/functions/$ID/invocations?limit=5" | jq '{total, invocations: [.invocations[] | {status, duration, createdAt}]}'
curl -s "$FF/functions/$ID/scaling-config" | jq -c .
```

**Scaling.** Each instance serves one call at a time, as on Lambda. Calls that arrive together get more instances at once, one per call in flight, up to `maxInstances`. Each quiet minute takes one instance away, and 15 idle minutes take the function to zero, unless `minInstances` is above 0. A call waits at most one timeout for a free instance. Change the limits like this:

```bash
curl -s -X PUT "$FF/functions/$ID/scaling-config" -H 'content-type: application/json' -d '{"maxInstances": 5}' | jq -c .
# {"minInstances":0,"maxInstances":5,"scaleToZero":true}
```

**Update.** Edit `examples/hello.ts` and send the new code, or change settings. A change of code, runtime, memory, or timeout rolls out a new version. The call returns once the new version is live (a few seconds), and the old one keeps serving until then. The new version is always checked on a running instance, even when the function was scaled to zero. If it can't start, the call answers 400 with the reason, and the previous version is put back: the function keeps working, and nothing changes.

```bash
jq -n --rawfile code examples/hello.ts '{code: $code}' \
  | curl -s -X PUT "$FF/functions/$ID" -H 'content-type: application/json' -d @- | jq '{status, updatedAt}'
curl -s -X PUT "$FF/functions/$ID" -H 'content-type: application/json' -d '{"memory": 256, "timeout": 10}' | jq '{memory, timeout}'
```

**Delete.** This removes the function's pods, Service, and code everywhere. To look inside the cluster first (section 4), keep the functions until then:

```bash
for f in "$ID" "$PY" "$SLOW"; do curl -s -o /dev/null -w "%{http_code}\n" -X DELETE "$FF/functions/$f"; done
```

**What a function can be, today:**
- one file (`function.ts` for Node.js, `function.py` for Python) using only the standard library, since there is no npm or pip install yet;
- up to about 100 KB of code, with invoke input up to about 100 KB: that is the API's request limit today (larger requests get `413 request entity too large`). The runtimes themselves accept 900 KiB of code and 6 MB payloads; raising the API's limit is task C-03 of the [CLI plan](cli-plan.md);
- within the account's plan: on the beta plan, 25 functions, each with 128–1024 MB of memory and a timeout of 1–300 s;
- up to 3 instances by default, and at most the plan's `instancesPerFunction` (10 on the beta plan) with `maxInstances`; `minInstances` from 0 up to the same limit keeps instances running when idle.

A request beyond the plan gets 400 with the plan's limit, for example `memory must be at most 1024 MB on the Beta plan`. "Plans and limits" in section 5 lists them all.

The handler is AWS Lambda's `handler(event, context)`, and the [Node.js](../runtimes/nodejs/README.md) and [Python](../runtimes/python/README.md) runtime READMEs describe `event`, `context`, and the error names.

**If a function cannot load** (a syntax error, a missing handler, an exception at import), the create call waits for the readiness timeout (90 s, `FF_READY_TIMEOUT_SECONDS` in `BE/.env`). It then answers 400 with the runtime's reason, for example `The function failed to load: Runtime.UserCodeSyntaxError: SyntaxError: function.ts:2:11 Property assignment expected.` The function is listed with status `ERROR` and that reason, and its pod is released. **Fix it with an update:** send the corrected code (`PUT /functions/<id>`), and the function becomes `ACTIVE`, keeping its ID. An update of an `ERROR` function always rolls out, even without changes, so `PUT` with `{}` retries the same code after a passing failure such as a full quota. While developing functions, a lower timeout such as 30 gives faster feedback.

## 4. Look inside the cluster

```bash
source hack/k8s/env.sh                                   # kubectl from hack/bin, the dev cluster's kubeconfig
NS=ff-t-$(printf %s 000000000001 | sha256sum | cut -c1-12)   # the dev account's namespace (FF_DEV_ACCOUNT_ID)
kubectl -n "$NS" get deployments,pods,services,configmaps
```

Each function is a Deployment and a Service named `fn-<id>`. Its code is in an immutable ConfigMap `fn-<id>-<hash>`. The previous version's ConfigMap is kept too, because old pods may still use it during a rollout.

**Logs.** Each function pod logs:
- Lambda-style `START`, `END`, and `REPORT` lines, with duration and memory, for every invocation;
- your own `console.log` or `print` output;
- errors, as one JSON line with the stack trace.

The logs belong to the current pod, so a rollout starts them afresh.

```bash
kubectl -n "$NS" logs deploy/fn-$ID
```

**Call a runtime directly**, without the backend, to see its raw response and headers. Here the request body *is* the event body:

```bash
kubectl -n "$NS" port-forward svc/fn-$ID 18080:8080 >/dev/null &
sleep 2                                                  # let the tunnel come up
curl -s -i -X POST localhost:18080/invoke -H 'content-type: application/json' -d '{"name": "direct"}'
kill $!                                                  # stop the port-forward
```

**See a cold start.** Idle functions are scaled to zero after the plan's idle window: 15 minutes on the beta plan (`idleSeconds`). To skip the wait, scale one down yourself. The next invocation starts it again, which takes about 7–10 s at the smallest size, and the backend logs `Cold start: scaling <id> from zero`.

```bash
kubectl -n "$NS" scale deploy/fn-$ID --replicas=0
curl -s -X POST "$FF/functions/$ID/invoke" -H 'content-type: application/json' -d '{"input": {}}' | jq .status
```

## 5. Everyday tasks

**Stop for the day, and start again.** Your data, the cluster, and its images survive.

```bash
# stop (and Ctrl-C the backend)
docker compose stop
source hack/k8s/env.sh && k3d cluster stop "$FF_CLUSTER_NAME"

# start again
docker compose up -d --wait
hack/k8s/cluster-up.sh                                   # restarts the existing cluster and renews its token
cd BE && npm run migration:run && npm run start:dev      # migration:run does nothing when none is pending
```

**Log in with Keycloak.** Development mode needs no login. To try real tokens, start Keycloak with the development realm `ff` (`deploy/keycloak/ff-realm.json`) and Mailpit, which catches its e-mails. Keycloak takes about 30 s and 600 MB:

```bash
docker compose --profile auth up -d --wait   # Keycloak on http://localhost:8180 (admin console: admin / admin), Mailpit on http://localhost:58025
```

Make a user, either by registering at http://localhost:8180/realms/ff/account (the verification e-mail arrives in Mailpit), or through the admin API. Then get a token through the `ff-e2e` client, which exists only in this development realm:

```bash
KC=http://localhost:8180
ADMIN=$(curl -s -X POST $KC/realms/master/protocol/openid-connect/token -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token)
curl -s -X POST $KC/admin/realms/ff/users -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"username":"amira@ff.test","email":"amira@ff.test","emailVerified":true,"enabled":true,"firstName":"Amira","lastName":"Test","credentials":[{"type":"password","value":"change-me-1","temporary":false}]}'
TOKEN=$(curl -s -X POST $KC/realms/ff/protocol/openid-connect/token -d grant_type=password -d client_id=ff-e2e -d username=amira@ff.test -d password=change-me-1 | jq -r .access_token)
```

Start the backend in OIDC mode, as `BE/.env.example` shows: `FF_AUTH_MODE=oidc`, `FF_OIDC_ISSUER=http://localhost:8180/realms/ff`, `FF_OIDC_AUDIENCE=ff-api`, and `FF_SMTP_URL=smtp://localhost:51025` so that its e-mails reach Mailpit. Every call then needs `-H "Authorization: Bearer $TOKEN"`, except `GET /healthz`; without a token, the answer is 401. The backend creates the user on its first call. Then make an account; it waits for approval during the beta, and you get an e-mail about it in Mailpit:

```bash
AUTH="Authorization: Bearer $TOKEN"
curl -s $FF/me -H "$AUTH" | jq -c .                       # {"user":{…"email":"amira@ff.test"…},"accounts":[]}
ACCOUNT=$(curl -s -X POST $FF/accounts -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name": "Atelier Sfax", "useCase": "Resize product photos"}' | jq -r .id)   # status "pending"
# approve it, as the admin dashboard will (client-readiness plan, P-71):
docker compose exec -T postgres psql -U postgres -d serverless_platform -c "UPDATE accounts SET status = 'active' WHERE id = '$ACCOUNT'"
curl -s $FF/functions -H "$AUTH"                         # now acts for that account
```

A user who belongs to several accounts names one with `-H "X-FF-Account: <id>"`.

For scripts, CI and the CLI, an owner makes an **API key** instead: it acts for its account, only with the scopes it was given (`functions:read`, `functions:write`, `functions:invoke`, `metrics:read`, and later `logs:read` and `usage:read`). The whole key is shown once:

```bash
KEY=$(curl -s -X POST $FF/api-keys -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name": "my laptop", "scopes": ["functions:read", "functions:write", "functions:invoke"]}' | jq -r .key)
curl -s $FF/functions -H "Authorization: Bearer $KEY"      # every functions route then works with the key
curl -s $FF/api-keys -H "$AUTH" | jq -c '.[] | {id, name, lastUsedAt}'
curl -s -X DELETE $FF/api-keys/${KEY:4:12} -H "$AUTH"      # revoked: it stops working at once
```

A key never does more than its creator's role allows, checked on every request: it stops when its creator leaves the account. An account has at most 20 keys; `expiresAt` (ISO 8601) makes one expire. Keys can't manage accounts or keys.

**Members.** An owner invites people by e-mail, with a role: `owner` (everything), `developer` (functions) or `viewer` (reads). Whoever next calls the API with a login for that address joins, within 7 days: Keycloak has verified the address. The invitation e-mail links to the console (`FF_CONSOLE_URL`). Owners change roles and remove members, but an account always keeps an owner, and a removed member's API keys stop at once.

```bash
curl -s -X POST $FF/members -H "$AUTH" -H 'content-type: application/json' -d '{"email": "salma@ff.test", "role": "developer"}'
curl -s $FF/members -H "$AUTH" | jq .                               # members, and invitations not accepted yet
curl -s -X PATCH $FF/members/<user ID> -H "$AUTH" -H 'content-type: application/json' -d '{"role": "viewer"}'
curl -s -X DELETE $FF/members/<user ID> -H "$AUTH"
curl -s -X DELETE $FF/members/invitations/<invitation ID> -H "$AUTH" # cancel one
```

Inviting an address again renews its invitation, with the new role.

**The audit log.** Owners read who changed what in their account, when, from which address, and in which request: account changes, functions created, changed and deleted, scaling, API keys, invitations, joins, role changes and removals. Entries are never changed or deleted: the database refuses it.

```bash
curl -s "$FF/audit-log?limit=20" -H "$AUTH" | jq -c '.entries[] | {at, actorLabel, action, resource}'
curl -s "$FF/audit-log?limit=20&before=<next>" -H "$AUTH"   # the next page, older; "next" is null on the last one
```

**Usage records.** Every invocation leaves one row in `usage_records` when it ends, written in the same transaction as its final state in the history (D6 of the client-readiness plan). The row copies what the price will depend on: the account, the function's ID, name, runtime and memory at the time of the call, the runtime's duration, the billed duration, the cold start (`init_ms`), and the outcome. Its `request_id` is the invocation's ID. Rows are never changed or deleted, not even when the function changes or is deleted: the database refuses it. What is billed follows D7:

| Outcome (`status`) | Billed duration (`billed_ms`) |
|---|---|
| `success`, `error` (it threw, crashed or ran out of memory) | the runtime's duration, rounded up to the millisecond |
| `timeout` | the function's timeout |
| `throttled` (no instance free in time), `platform_error` (the cold start failed, the pod was unreachable), `lost` | nothing |

The cold start, when the call had to start an instance, is recorded in `init_ms` and never billed.

**The month's usage.** `GET /usage` adds the records up for a month by the UTC calendar: per function and in total, the requests billed, the billed duration, the GB-seconds, and the calls not billed. Every member of the account may read it, viewers included, and an API key with `usage:read`. The console's "Usage" page shows this month and last month, and downloads the CSV:

```bash
curl -s "$FF/usage" | jq '{month, totals}'                                # this month
curl -s "$FF/usage?month=2026-09" | jq -c '.functions[] | {functionName, requests, gbSeconds}'
curl -s "$FF/usage?month=2026-09" -H 'Accept: text/csv'                  # the same, for a spreadsheet
# {"month": "2026-10", "totals": {"requests": 4, "billedMs": 3016, "gbSeconds": "0.752", "throttled": 0, "platformErrors": 0, "lost": 1}}
```

`gbSeconds` is billed duration × memory, counting 1,024 MB as 1 GB, as an exact decimal string, as AWS's Cost Explorer gives its amounts. The totals are the records' own sums, never the functions' rounded figures added up. A function deleted since keeps its usage, marked `"deleted": true`. Costs appear once prices exist (P-30). To read the raw records:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform \
  -c "SELECT started_at, function_name, status, memory_mb, duration_ms, billed_ms, init_ms FROM usage_records ORDER BY started_at DESC LIMIT 10"
```

The table has a partition per month, by the UTC calendar (`usage_records_2026_10`, …). The backend creates this month's and the next two at startup and then daily, so a month is never missing.

**Lost calls.** When the backend stops during a call (it crashed, was killed, or restarted), the call's answer is lost, and its invocation would stay `RUNNING`. At startup and every minute, the backend marks such calls `LOST`, with a usage record that bills nothing, once the longest a call can take has passed: two timeouts (a wait for a free instance, then the run), the cold-start limit (`K8S_READY_TIMEOUT_SECONDS`, 90 s), and 30 s more. For a function with a 5 s timeout, that is 2 min 10 s. The history then says `Lost: the backend restarted during the call, so its answer is unknown. It isn't billed.` A function changed since the call started gets the longest timeout there is (900 s), as its timeout then is no longer known.

**Capacity samples.** Five seconds into every minute, the backend lists FF's Deployments in one Kubernetes call and writes a row to `capacity_samples` for each function with a ready instance: how many, its memory and its `minInstances` (D6 and D8 of the client-readiness plan). A warm instance holds its memory whether or not it runs a call, and these samples show how much. Like usage records, samples are never changed or deleted, and the table has a partition per month. The capacity report weighs, per account and day, the GB-s held for ready instances against the GB-s the usage records bill:

```bash
cd BE && npm run capacity:report -- --days 7      # the last 7 days by the UTC calendar, today included
# Day (UTC)   Account       Reserved GB-s  Provisioned GB-s  Billed GB-s  Requests  Reserved ÷ billed
# 2026-10-17  000000000001         45.000             0.000        0.004         3            11,250×
```

One 128 MB instance kept warm for a day holds 10,800 GB-s, while a 1 ms call bills 0.000125 GB-s: that gap is D8's, and the report is how you watch it until the admin dashboard does (P-75). "Provisioned" is what `minInstances` would bill at the provisioned price. The report reads the database that `BE/.env` names, and changes nothing.

**The console with a login.** With the backend in OIDC mode as above, copy `FE/.env.example` to `FE/.env.local`, set `VITE_OIDC_AUTHORITY=http://localhost:8180/realms/ff` in it, and restart `npm run dev`. The console then opens on a login page:
1. "Sign up" opens Keycloak's registration form. The verification e-mail arrives in Mailpit (http://localhost:58025); its link asks for a password, then brings you back to the console, logged in.
2. The console asks you to create your account, which then waits for approval. Approve it as above, and "Check again" shows the functions.
3. "Account" shows the account; its owners rename it or set its tax ID. "Members" invites people and changes their roles. "API keys" lists, creates and revokes the account's keys, and shows a new key once. The account switcher in the header lists your accounts, and "New account…" makes another. A viewer sees no button to create, change or invoke.

The console keeps its tokens in the tab's session storage, and renews the 5-minute access token with the refresh token before it expires. "Log out" ends the Keycloak session too. When that session ends another way (30 minutes without a renewal, as after the laptop slept, or a logout in another tab), the next call gets 401, and the console asks you to log in again.

**Reset Keycloak** with `docker compose --profile auth down -v keycloak`: it deletes Keycloak's users, and imports the realm again at the next start. Keycloak reads `deploy/keycloak/ff-realm.json` only at its first start, so a change to that file needs this reset. Name the service: without it, `down -v` deletes the database and S3 volumes too.

**Plans and limits.** Each account has a plan (D5 of the client-readiness plan); new accounts get `beta`. A plan sets how many functions an account may have, each one's memory, timeout and instances, the quota of the account's namespace (all its functions together), the rate of changes and of invocations, and the idle window before scale to zero. `GET /me` shows each account's plan, and so does the console's account page. The beta plan:

| Limit | Beta | Over it |
|---|---|---|
| Functions per account | 25 | 400 `The Beta plan allows 25 functions per account: delete one first` |
| Memory, timeout per function | 1,024 MB, 300 s | 400 `memory must be at most 1024 MB on the Beta plan` |
| Instances per function | 10 | 400 `maxInstances must be at most 10 on the Beta plan` |
| Namespace quota | 20 pods, 8 CPU, 8 GiB | a rollout that doesn't fit: `exceeded quota` |
| Changes (create, update, delete, scaling, keys, accounts) | 60 a minute | 429 `TooManyRequestsException: Rate exceeded…`, with `Retry-After` |
| Invocations | 100 a second | 429, the same, counted apart from changes |
| Idle before scale to zero | 15 minutes | |
| History, logs kept | 30 days, 14 days | kept for now: P-45 and P-43 apply them |

Reads are not rate-limited. A rate is counted per account: a user who has no account yet is counted alone, and a caller without a login by address. The counts live in the backend's memory, so they start again when it restarts.

Until the admin dashboard (P-73), plans change in SQL. The backend reads a plan at most once a minute, so a change applies within a minute; an account's namespace gets its new quota at its next deploy or update:

```bash
psql() { docker compose exec -T postgres psql -U postgres -d serverless_platform "$@"; }
psql -c "SELECT id, name, limits FROM plans"
# a plan with more room, from the beta plan's limits
psql -c "INSERT INTO plans (id, name, limits) SELECT 'team', 'Team', limits || '{\"functions\": 100, \"memoryMb\": 2048}' FROM plans WHERE id = 'beta'"
psql -c "UPDATE accounts SET plan_id = 'team' WHERE id = '$ACCOUNT'"
```

The backend checks a plan's limits before using them: a plan that lacks one, or has a wrong one, makes its accounts' requests fail with 500, and the log names the plan and the limit.

**Change the database schema.** Change the entity, then let TypeORM write the migration, read it, and register it:

```bash
cd BE
npm run migration:generate -- src/migrations/AddFunctionDescription   # compares the entities with your database
# review the new file, then add its class to src/migrations/index.ts
npm run migration:run                                    # apply it to your database
npm run migration:check                                  # migrations and entities agree: exit 0
```

`migration:check` builds a scratch database, runs every migration there, and fails if the entities still need anything. A migration that isn't in `src/migrations/index.ts` never runs, so the check catches it too. `npm run migration:revert` undoes the last migration, and `npm run migration:show` lists them.

**Renew the cluster token.** The backend's token is valid for 24 hours. When calls to Kubernetes start failing with `Unauthorized`, run `hack/k8s/mint-token.sh`. `cluster-up.sh` does this as well.

**After changing a runtime** (`runtimes/nodejs` or `runtimes/python`), rebuild and reload the image. New pods use it. To move an existing function onto it, restart its Deployment (with `NS` and `ID` from sections 3 and 4).

```bash
runtimes/python/tests/container-smoke.sh && hack/k8s/load-images.sh
kubectl -n "$NS" rollout restart deploy/fn-$ID
```

**Run the tests.** Use the fast ones while you work and the cluster ones before you commit:

```bash
(cd BE && npm run lint)                                  # the backend's linter, with type information, seconds
(cd BE && npm test)                                      # backend unit tests, seconds
(cd BE && npm run test:db)                               # migrations against real PostgreSQL (compose), seconds
(cd BE && npm run migration:check)                       # the migrations build exactly the entities' schema
(cd FE && npm test)                                      # console unit tests, seconds
(cd runtimes/nodejs && npm test)                         # Node.js runtime protocol
(cd runtimes/python && python3 -m unittest discover -s tests)   # Python runtime protocol
hack/k8s/test-it.sh                                      # the Kubernetes driver on the dev cluster, about 6 min
hack/k8s/test-rbac.sh                                    # the backend's cluster permissions
hack/e2e.sh                                              # the whole stack through the API, about 3 min
hack/e2e-tenancy.sh                                      # every route as another account and anonymously, about 1 min
```

**Reset everything.** This is destructive: it deletes the cluster and all local FF data.

```bash
hack/k8s/cluster-down.sh
docker compose down -v
```

## 6. When something goes wrong

| Symptom | Fix |
|---|---|
| `resources: FAIL …` | Free memory or disk first. The thresholds protect the machine; don't lower them to push through. |
| Port 5432 or 9003 already in use | `FF_PG_PORT=55432 FF_S3_PORT=59003 docker compose up -d --wait`, then set `DB_PORT` and `MINIO_PORT` in `BE/.env` to match. |
| Port 6550 already in use | `export FF_API_PORT=6551` before `hack/k8s/cluster-up.sh`, then set `K8S_API_URL=https://127.0.0.1:6551` in `BE/.env`. |
| Port 3000 already in use | Set `PORT` in `BE/.env`, and `VITE_API_URL` in `FE/.env.local` to match (see `FE/.env.example`). |
| `Port 5199 is already in use` | The console doesn't move to another port: the login and the backend's `CORS_ORIGIN` name this one. Stop what holds it (`ss -ltnp 'sport = :5199'`). To use another port anyway, change `CONSOLE_PORT` in `FE/vite.config.ts`, add the address to `ff-console`'s redirect URIs and web origins in Keycloak's admin console, and set `CORS_ORIGIN` in `BE/.env`. |
| The console says `Can't reach the API at …` | The backend isn't running at `VITE_API_URL`, or its `CORS_ORIGIN` doesn't include http://localhost:5199. A `BE/.env` from before 2026-10-17 says 5173: take the line from `BE/.env.example`. |
| The console says `The API asks for a login, but this console has none` | The backend runs in OIDC mode, and the console without a login. Set `VITE_OIDC_AUTHORITY` in `FE/.env.local` and restart `npm run dev`, or set `FF_AUTH_MODE=dev` in `BE/.env`. |
| Keycloak answers `Invalid parameter: redirect_uri` | Your Keycloak still has the realm it imported before the console moved to port 5199 (2026-10-17). Reset it, as "Log in with Keycloak" in section 5 shows, and sign up again. |
| `The backend did not start` with `Invalid configuration (… problems)` | Each line names a variable and what it expects. With `FF_DEV_USER_ID is no longer read`, your `BE/.env` is from before 2026-10-17: copy `BE/.env.example` again. With `FF_SCALE_TO_ZERO_IDLE_SECONDS is no longer read` or `K8S_TENANT_QUOTA_… is no longer read`, remove those lines: the account's plan sets them now. |
| 400 `… must be at most … on the Beta plan`, or `The Beta plan allows 25 functions per account` | The request goes beyond the account's plan. Ask for less, or move the account to a larger plan ("Plans and limits" in section 5). |
| 400 `An account needs an owner: make another member owner first` | Make another member owner, then change or remove the first one. |
| An invited person doesn't see the account | They must log in with the invited address, within 7 days of the invitation. `GET /members` (or the console's "Members") shows the invitation, and whether it expired; invite again to renew it. |
| 429 `TooManyRequestsException: Rate exceeded: the Beta plan allows …` | The account made more changes or invocations than its plan allows. Wait for the seconds in `Retry-After`. |
| Every API call returns 401 | `FF_AUTH_MODE` isn't `dev`, and the call has no valid token. Use the development values from `BE/.env.example`, or send a token: see "Log in with Keycloak" in section 5. |
| 401 `The token was issued by another issuer` | `FF_OIDC_ISSUER` must be exactly the token's `iss`, `http://localhost:8180/realms/ff` for the local Keycloak, including `localhost`. |
| 403 `This user has no account yet: create one with POST /accounts` | The token is valid, but the user has no account to act for: create one, as "Log in with Keycloak" in section 5 shows. |
| 403 `Your account is waiting for approval` | A new account can't deploy or invoke until it is approved. Until the admin dashboard exists, approve it in the database (section 5). |
| 400 `This user belongs to several accounts` | Name one: `-H "X-FF-Account: <account ID>"`. `GET /me` lists them. |
| 403 `This API key lacks the scope …` | The key wasn't given that scope. Make one that has it; scopes can't be added to a key. |
| 401 `The API key was revoked`, or `has expired` | Make a new key. |
| `migration:run` stops with `tenants that are not 12-digit account IDs` | Functions from before 2026-10-17 can't move to accounts. Reset the database once, as shown after step 7. |
| A function you can see in the console answers 404 to `curl` | The two act as different accounts: `curl` sent `X-FF-Dev-Account`, or the backend runs with another `FF_DEV_ACCOUNT_ID` than when the function was created. |
| An answer is 500 with `… failed because of an internal error (request <id>)` | A failure of the platform, not of your function. The backend's log has the details: search it for the request ID, which every answer also carries in `x-ff-request-id`. |
| `The backend did not start: The database schema is out of date: … pending` | `cd BE && npm run migration:run`, then start it again. |
| `migration:run` fails with `relation "functions" already exists` | The database was created before migrations were used. Reset it once, as shown after step 7. |
| `npm run test:db` fails with `ECONNREFUSED` | PostgreSQL isn't running: `docker compose up -d --wait postgres`. The tests read `DB_*` from `BE/.env`. |
| Kubernetes calls fail with `Unauthorized` | The token expired: `hack/k8s/mint-token.sh`. |
| Function pods in `ImagePullBackOff` | The runtime image is not in the cluster: `hack/k8s/load-images.sh`. |
| `create` takes 90 s, then fails | The function cannot load: the answer starts with `The function failed to load:` and the runtime's reason. Fix the code and send it with `PUT /functions/<id>`: see "If a function cannot load" in section 3. If the answer is 500 instead, the platform failed: see the row below about request IDs. |
| An update answers 400 with `The update was rolled back` | The new version couldn't start; the reason comes first. The previous version still serves, and the record is unchanged. |
| An invocation stays `RUNNING`, then becomes `LOST` | The backend stopped during the call, so its answer is unknown; it isn't billed. Invoke again. See "Lost calls" in section 5. |
| The backend logs `Could not create the monthly partitions` | The migrations haven't run (`cd BE && npm run migration:run`), or the database refused: the message says why. An invocation in a month without a partition fails with `no partition of relation "usage_records" found for row`. |
| The backend logs `Could not sample capacity` | The Kubernetes API didn't answer the list of Deployments, or the database refused the samples: the message says why. That minute has no sample; the next minute is sampled as usual. |
| An invoke answers 429 with `TooManyRequestsException: Rate exceeded: no instance was free within …` | More calls arrived together than the function's instances could take within one timeout. Raise `maxInstances` (`PUT /functions/<id>/scaling-config`), or make the calls shorter. |
| `jq: parse error` after `echo "$response" \| jq` in zsh | zsh's `echo` expands `\n` inside JSON strings. Pipe `curl` straight into `jq`, or use `printf '%s' "$response"`. |

More symptoms and fixes are in the dev guide's [troubleshooting table](kubernetes-dev-guide.md#troubleshooting).
