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
| Node.js and npm | 24.15 or newer | Backend (NestJS 12: its tests need 24.9, its CLI 24.15), console, Node.js runtime tests |
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

**1. Get the code.** `master` has everything this guide uses.

```bash
git clone <repository-url> ff && cd ff
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
- installs the log pipeline (`deploy/k8s/logging`): Fluent Bit, which collects every function's output, and VictoriaLogs, which keeps it. The logs API reads it, and so do the load errors a deploy reports. `--no-logging` leaves it out, and those two with it;
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

**A database created before 2026-10-17 must be reset once, or replaced by a new one.** Until then, the backend created its tables itself, with other column names: `npm run migration:run` stops with `relation "functions" already exists`, and the backend, which finds every migration pending, doesn't start. Resetting deletes your development functions and their history. Their Deployments in the cluster go with the old dev tenant's namespace (tenant `1`):

```bash
docker compose exec postgres psql -U postgres -c 'DROP DATABASE serverless_platform WITH (FORCE)' -c 'CREATE DATABASE serverless_platform'
source hack/k8s/env.sh && kubectl delete namespace "ff-t-$(printf %s 1 | sha256sum | cut -c1-12)" --ignore-not-found
(cd BE && npm run migration:run)
```

To keep the old database as it is, give the backend a new one instead, and its name in `BE/.env`:

```bash
docker compose exec postgres createdb -U postgres ff_dev
sed -i 's/^DB_NAME=.*/DB_NAME=ff_dev/' BE/.env
(cd BE && npm run migration:run)
```

**8. The console (optional)**, in its own terminal:

```bash
cd FE && npm install && npm run dev
```

It runs on http://localhost:5199 and calls the API on localhost:3000. Without a login, as here, it acts as the backend's development account: its functions, with their history, logs, metrics and alarms; the account's usage, notifications and billing. "Log in with Keycloak" in section 5 adds the login, sign-up, accounts, members and API keys.

**9. The gVisor sandbox (optional here, required in production).** This runs every function in gVisor, an extra isolation layer: customers' code never talks to the node's kernel. In production the backend refuses to start without it. Restart the backend afterwards.

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

**A name belongs to one function of the account.** It follows AWS Lambda's rule: 1 to 64 letters, digits, hyphens or underscores, compared exactly, so `Hello` and `hello` are two names. A name outside the rule answers 400, `name must be 1 to 64 letters, digits, hyphens or underscores, as an AWS Lambda function's name`; one given before 2026-10-21 that breaks it is kept until the function is renamed. Another create or rename with a name in use answers 409, `A function named "hello" already exists in this account: choose another name, or change that function`, and changes nothing: run the command above twice and the second `ID` is `null`. Delete the first one (`curl -s -X DELETE "$FF/functions/$ID"`), or choose another name. Names weren't unique before 2026-10-21 either: the migration that made them so kept the name of the oldest of an account's functions with one name, and added the first 8 characters of their ID to the others' (`hello-3f9c2a1e`). The account's audit log records each of these renames, as FF's.

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

**The invocation history** keeps each call for the account's plan's `historyRetentionDays`, 30 days on beta: a job deletes older calls every hour, while their usage records stay for billing. It keeps at most 64 KiB of each input, output and error. Of a longer one, it keeps the start of its JSON text, as a string, and sets `inputTruncated`, `outputTruncated` or `errorTruncated`; the invoke's own answer has the input and output whole. A character PostgreSQL can't store, NUL or a lone surrogate (half of an emoji, from a string cut in two), is kept as U+FFFD; the function gets it as sent.

```bash
curl -s "$FF/functions/$ID/invocations?limit=1" | jq -c '.invocations[0] | {status, inputTruncated, outputTruncated, errorTruncated}'
# {"status":"COMPLETED","inputTruncated":false,"outputTruncated":false,"errorTruncated":false}
```

**Metrics.** `GET /functions/<id>/metrics` gives a function's figures, a point per period, under the names CloudWatch gives Lambda's:
- `Invocations`: every call that reached the function, failed or not;
- `Errors`: its errors and timeouts, and the calls FF failed or lost;
- `Throttles`: the calls refused, because no instance was free in time or the plan's rate limit was reached;
- `ColdStarts`: the calls that waited for an instance to load the code;
- `Duration`: the `Average`, `Maximum`, `p50`, `p95` and `p99` in milliseconds, `null` in a period without a measured call;
- `Instances`: the `Maximum` ready in one minute of the period, and the `Average` over its minutes.

`GET /metrics` gives the same for the whole account, deleted functions included. Both are worked out from the usage records the bill is made of, so they agree with it, and with the history. `period` is 60 (the default), 300 or 3600 seconds. `start` and `end` are RFC 3339 times, rounded out to whole periods of UTC time; by default the window starts 60 periods before now. An answer has at most 1,440 points: a longer window answers 400 and says so. An API key needs the `metrics:read` scope.

```bash
curl -s "$FF/functions/$PY/metrics?period=300" \
  | jq -c '{period, points: (.timestamps | length), calls: (.metrics.Invocations | add), errors: (.metrics.Errors | add), slowest: ([.metrics.Duration.Maximum[] | values] | max)}'
# {"period":300,"points":61,"calls":2,"errors":1,"slowest":103.4}
curl -s "$FF/metrics?period=3600&start=$(date -u -d '-1 day' +%FT%TZ)" | jq -c '.metrics | {calls: (.Invocations | add), throttles: (.Throttles | add)}'
# {"calls":4,"throttles":0}
```

**Notifications.** FF tells an account what happens by e-mail to its owners, each in their language, and by webhooks: a POST of JSON to a URL of yours. Alarms send theirs this way (below); a test shows how it arrives. Each webhook is signed with the account's secret, which owners read at `GET /notifications/webhook-secret`: `FF-Signature: t=<Unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with the secret as written. A receiver checks the signature, that `t` is recent, and drops an `FF-Event-Id` it already has, as [`examples/webhook-receiver.mjs`](../examples/webhook-receiver.mjs) does. It answers 2xx within 5 seconds, or FF tries again 1, 2, 4, 8 and 16 minutes later, then gives up; a redirect is never followed. FF never sends a webhook to a private or reserved address. A receiver on your own machine needs `FF_WEBHOOK_ALLOW_PRIVATE=true` in `BE/.env`, as `.env.example` sets it; production refuses that setting.

```bash
FF_WEBHOOK_SECRET=$(curl -s "$FF/notifications/webhook-secret" | jq -r .secret) node examples/webhook-receiver.mjs &   # on :8090
curl -s -X POST "$FF/notifications/test" -H 'content-type: application/json' -d '{"webhookUrl": "http://localhost:8090/ff"}' \
  | jq -c '[.deliveries[] | {channel, status}]'
# [{"channel":"webhook","status":"pending"}]
sleep 11; curl -s "$FF/notifications/deliveries?limit=1" | jq -c '.[0] | {status, attempts, responseStatus}'
# {"status":"delivered","attempts":1,"responseStatus":204}; the receiver printed the test's body
```

The body is `{"id", "type", "account", "createdAt", "data"}`; `id` is also the `FF-Event-Id`, the same for each try. `"email": true` sends the test to the owners' e-mail too; development mode's account has no owner, so it answers 400 there. `POST /notifications/webhook-secret/rotate` makes a new secret: for 24 hours after, each webhook carries a `v1` by the old one too, while your receivers change over. Owners read and rotate the secret; owners and developers send tests; every member reads the deliveries, kept 30 days. API keys can't call these routes. The console's Notifications page does all of it: the secret, a test, and how each delivery went, read again while one is still to be sent.

**Alarms**, as CloudWatch's: a metric of a function, or of the whole account without one, its statistic over a period, compared with a threshold, and "M out of N" periods breaching. Every minute FF judges the last N whole periods, each once it has been over a minute, so that a call ending then still counts. M or more breaching is `ALARM`, fewer is `OK`. A period without a datapoint (a duration with no call) is left out by default, and all N missing is `INSUFFICIENT_DATA`; `treatMissingData` makes it `notBreaching`, `breaching`, or `ignore`. Going into `ALARM`, and out of it, the alarm tells its actions: the owners' e-mail and up to 5 webhooks, signed as above, with `"kind": "alarm"` and the alarm, the states it left and entered, why, and the datapoints. Two alarms watch the account's money as it is: `Balance` and `MonthToDateCharges`, with the statistic `Latest` and one datapoint.

```bash
curl -s -X POST "$FF/alarms" -H 'content-type: application/json' -d "{\"name\": \"py errors\", \"functionId\": \"$PY\",
  \"metric\": \"Errors\", \"statistic\": \"Sum\", \"period\": 60, \"comparison\": \"GreaterThanThreshold\", \"threshold\": 0,
  \"evaluationPeriods\": 1, \"datapointsToAlarm\": 1, \"actions\": {\"email\": false, \"webhookUrls\": [\"http://localhost:8090/ff\"]}}" | jq -c '{id, state}'
# {"id":"…","state":"INSUFFICIENT_DATA"}; within a minute "OK", and "ALARM" the minute after one of its calls fails
curl -s "$FF/alarms" | jq -c '.[] | {name, state, stateReason}'
```

The metrics take their statistics: `Sum` for `Invocations`, `Errors`, `Throttles` and `ColdStarts`; `Average`, `Maximum`, `p50`, `p95` or `p99` for `Duration`; `Maximum` or `Average` for `Instances`. A period is 60, 300 or 3600 seconds, N up to 60 periods and a day at most, and an account has up to 50 alarms. Every member reads them; owners and developers change them, and API keys with the scopes `alarms:read` and `alarms:write`. A function's alarms go with it. The evaluation's pace is `FF_ALARM_INTERVAL_SECONDS` (60) and `FF_ALARM_SETTLE_SECONDS` (60), which tests shorten. In the console, the Alarms page lists them with their state and why, and creates, changes and deletes them; a function's page shows its alarms' states.

**Scaling.** Each instance serves one call at a time, as on Lambda. Calls that arrive together get more instances at once, one per call in flight, up to `maxInstances`. Each quiet minute takes one instance away, and 15 idle minutes take the function to zero, unless `minInstances` is above 0. A call waits at most one timeout for a free instance. Change the limits like this:

```bash
curl -s -X PUT "$FF/functions/$ID/scaling-config" -H 'content-type: application/json' -d '{"maxInstances": 5}' | jq -c .
# {"minInstances":0,"maxInstances":5,"scaleToZero":true}
```

**Environment variables**, as AWS Lambda's: names and string values your code reads as `process.env.NAME` in Node.js, `os.environ["NAME"]` in Python. Set them on create, or replace them all with an update, which rolls out a new version as a change of code does; `{}` removes them. A name starts with a letter, then letters, digits or underscores, two characters at least. The names Lambda sets itself (`AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME` and the rest of its list) and FF's runtimes' (`FUNCTION_TIMEOUT`, `PORT`, `PATH`, every `FF_` name) are refused, and all of them together take at most 4 KB as JSON text, as Lambda counts it. `TZ` is yours: the runtimes run in UTC otherwise.

```bash
curl -s -X PUT "$FF/functions/$ID" -H 'content-type: application/json' \
  -d '{"environment": {"GREETING": "Ahlan", "TZ": "Africa/Tunis"}}' | jq -c .environment
# {"GREETING":"Ahlan","TZ":"Africa/Tunis"}
```

They are configuration: whoever reads the function reads them, as on Lambda, and `GET /functions/<id>` answers with them (the list doesn't). The database keeps them encrypted, with the keys of `FF_ENCRYPTION_KEYS_FILE`: development has a key of its own, which production refuses. The cluster gives them to the function's pods through a Kubernetes Secret, and the audit log names the variables an update added, changed or removed, never their values. The console's Environment tab edits them. A value nobody should read back, such as a database password, belongs in a secret, which the [step-1 plan](step-1-plan.md)'s U-02 adds.

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
- with environment variables, 4 KB at most, as on Lambda (above);
- up to 3 instances by default, and at most the plan's `instancesPerFunction` (10 on the beta plan) with `maxInstances`; `minInstances` from 0 up to the same limit keeps instances running when idle.

A request beyond the plan gets 400 with the plan's limit, for example `memory must be at most 1024 MB on the Beta plan`. "Plans and limits" in section 5 lists them all.

The handler is AWS Lambda's `handler(event, context)`, and the [Node.js](../runtimes/nodejs/README.md) and [Python](../runtimes/python/README.md) runtime READMEs describe `event`, `context`, and the error names. The code must define it: `exports.handler = async (event, context) => { … }` in Node.js, `def handler(event, context):` in Python. Code without one, such as a lone `console.log('hi');`, fails to load with `Runtime.HandlerNotFound: function.handler is undefined or not exported`.

**If a function cannot load** (a syntax error, a missing handler, an exception at import), the create call answers 400 as soon as the runtime has said why, in about 10 s: the runtime logs it at start, and the backend reads it in the log store, which has it about 5 s later. Without the log pipeline (`--no-logging`), the backend can't read it, and waits for the readiness timeout instead (90 s, `FF_READY_TIMEOUT_SECONDS` in `BE/.env`). The answer gives the runtime's reason, for example `The function failed to load: Runtime.UserCodeSyntaxError: SyntaxError: function.ts:2:11 Property assignment expected.`, and `functionId`: the function is saved all the same, listed with status `ERROR` and that reason, and its pod is released. Creating it again would only answer 409, since the name is taken: the console opens the saved function's page instead of keeping its form. **Fix it with an update:** send the corrected code (`PUT /functions/<id>`), and the function becomes `ACTIVE`, keeping its ID. An update of an `ERROR` function always rolls out, even without changes, so `PUT` with `{}` retries the same code after a passing failure such as a full quota. Without the log pipeline, a lower timeout such as 30 gives faster feedback.

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

Without cluster access, `GET /functions/:id/logs` gives the same lines, from the log store (P-43), which keeps them after the instance that wrote them is gone: a function scaled to zero still has its lines. It gives a page: the newest 200 lines of the window, or `limit` up to 1,000 (`tail`, its older name, still works), oldest first.
- **The window** runs from `start` (RFC 3339), or `sinceSeconds` ago, to `end`, or now. It never starts before the plan's log retention, 14 days on beta: a window wholly older than that has no lines.
- **`q`** keeps the lines with a phrase, as whole words and with its case: `q=time out` finds "a time out here", not "timeout". **`requestId`** keeps one call's lines: the invocation's `id` in the history.
- **`next`** is set when there are older lines: pass it as `cursor`, with the same parameters, for the page before.
- **Each line** has its time to the nanosecond (UTC), the instance that wrote it, its stream (`stdout` or `stderr`), and the request ID of the call it belongs to: from the call's `START` line to its `REPORT`. Everything a call writes before it returns comes before its `END`, in both runtimes. Lines outside a call, such as a cold start's, have none. So do lines written after the handler returned, by a timer or a promise it left running, unless the next call has started: they get its ID.
- **The account's limit** keeps 2,000 lines and 1 MiB a second. Past it, lines are dropped, and the page then has a line with stream `ff` and no instance: "FF dropped N of this function's log lines written at …".
- A line longer than 16,384 bytes is cut at the start of a character, and ends with ` …[truncated]`.

Every member of the account reads them, and so does an API key with `logs:read`; another account's function answers 404. When the store can't be reached, the answer is 503: try again in a minute. The [Kubernetes dev guide](kubernetes-dev-guide.md#the-log-pipeline) shows how to query the store directly.

**In the console,** the function page's Logs tab shows the same lines: a time range, a phrase, one call's lines (a line's request ID, or the Logs link of a row of the invocation history), older pages, and "Live", which follows the new ones as they come.

**The live tail,** `GET /functions/:id/logs/stream`, keeps the connection open and sends each new line as a Server-Sent Event, about 5 s after it was written: the store waits that long for lines that reach it late. `q` and `requestId` narrow it, as for a page. A `ping` event comes every 15 s; an `end` event after 30 minutes, when the stream closes and you open another; an `unavailable` event if the store can't start the tail or fails. A 404 comes as JSON, before any event. A browser's `EventSource` can't send the `Authorization` header, so read it with `fetch`, or with curl:

```bash
curl -sN "$FF/functions/$ID/logs/stream" | grep --line-buffered '^data: {' | sed -u 's/^data: //' | jq -r '"\(.time) \(.message)"'
```

```bash
curl -s "$FF/functions/$ID/logs?limit=20" | jq -r '.lines[] | "\(.time) \(.requestId // "-") \(.message)"'
curl -s "$FF/functions/$ID/logs?requestId=$REQUEST" | jq -r '.lines[].message'          # one call's lines
curl -s "$FF/functions/$ID/logs?q=greeting&sinceSeconds=3600" | jq -r '.lines[].message'  # a phrase, in the last hour
curl -s "$FF/functions/$ID/logs?limit=100&cursor=$NEXT" | jq -c '.next'                    # the page before the one whose next was $NEXT
```

**Call a runtime directly**, without the backend, to see its raw response and headers. Here the request body *is* the event body:

```bash
kubectl -n "$NS" port-forward svc/fn-$ID 18080:8080 >/dev/null &
sleep 2                                                  # let the tunnel come up
curl -s -i -X POST localhost:18080/invoke -H 'content-type: application/json' -d '{"name": "direct"}'
kill $!                                                  # stop the port-forward
```

**See a cold start.** Idle functions are scaled to zero after the plan's idle window: 15 minutes on the beta plan (`idleSeconds`). To skip the wait, scale one down yourself. The next invocation starts it again, which takes about 6–8 s at the smallest size (6–11 s in gVisor), and the backend logs `Cold start: scaling <id> from zero`.

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

**Both dashboards with a login, from start to finish.** Run the backend, the console and the admin dashboard each in its own terminal, with the login's settings on the command line. Variables set there win over `BE/.env` and the apps' `.env.local`, which stay as they are; to keep the settings, put them in those files instead, as `BE/.env.example`, `FE/.env.example` and `admin/.env.example` show:

```bash
cd BE && FF_AUTH_MODE=oidc FF_OIDC_ISSUER=http://localhost:8180/realms/ff FF_OIDC_AUDIENCE=ff-api \
  FF_SMTP_URL=smtp://localhost:51025 npm run start:dev
cd FE && VITE_OIDC_AUTHORITY=http://localhost:8180/realms/ff npm run dev      # the console, http://localhost:5199
cd admin && VITE_OIDC_AUTHORITY=http://localhost:8180/realms/ff npm run dev   # the admin dashboard, http://localhost:5198
```

1. On the console, "Sign up". Any e-mail address works, a made-up one such as `amira@ff.test` too: Keycloak and the backend send every e-mail to Mailpit, which keeps them all and delivers none. Open the verification e-mail at http://localhost:58025, follow its link, and choose a password: Keycloak brings you back to the console, logged in.
2. Create the account. It waits for approval, and Mailpit gets the e-mail FF sends its operator about it.
3. On the admin dashboard, log in as `operator@ff.test`, password `operator-dev-1`. The first time, Keycloak asks you to set up a one-time password: scan its QR code with an authenticator app (FreeOTP, Google Authenticator, …), then enter a code. "Approvals" lists the new account: approve it, with a reason. The owner's e-mail about it arrives in Mailpit, in French unless they chose English.
4. On the console, "Check again" shows the functions page.

If Keycloak answers `Invalid parameter: redirect_uri` or `Client not found`, its realm is older than the dashboards: reset it, as "Reset Keycloak" below shows, then open the console again rather than reloading the error page. Section 6 says where each part's logs are.

For the API from the command line, make a user, either by registering at http://localhost:8180/realms/ff/account (the verification e-mail arrives in Mailpit), or through the admin API. Then get a token through the `ff-e2e` client, which exists only in this development realm:

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
# approve it as FF's operator: in the admin dashboard's Approvals (below), or with the operator's token
OP=$(curl -s -X POST $KC/realms/ff/protocol/openid-connect/token -d grant_type=password -d client_id=ff-admin \
  -d username=operator@ff.test -d password=operator-dev-1 | jq -r .access_token)   # the development realm only
curl -s -X POST $FF/admin/accounts/$ACCOUNT/approve -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"reason": "Use case checked"}' | jq -r .account.status   # "active"; the owner's e-mail is in Mailpit
curl -s $FF/functions -H "$AUTH"                         # now acts for that account
```

A user who belongs to several accounts names one with `-H "X-FF-Account: <id>"`.

**The e-mails' language.** Every e-mail a customer gets, from the approval to an invoice, comes in French, Tunisia's language of business and the invoices', unless its reader chooses English, for all their accounts: on the console's Account page ("Your e-mails"), or so. An e-mail to several owners reaches each in their own language; an invitation goes in the invitee's when they already have a login, else in the inviter's. Your own e-mails, as the operator, stay in English.

```bash
curl -s -X PATCH $FF/me -H "$AUTH" -H 'content-type: application/json' -d '{"locale": "en"}' | jq -r .user.locale   # "en"; "fr-TN" goes back to French
```

For scripts, CI and the CLI, an owner makes an **API key** instead: it acts for its account, only with the scopes it was given: `functions:read`, `functions:write`, `functions:invoke`, `logs:read`, `metrics:read`, `alarms:read`, `alarms:write`, and `usage:read` (the usage, the balance, pro-formas and invoices). The whole key is shown once:

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

**The audit log.** Owners read who changed what in their account, when, from which address, and in which request: account changes, functions created, changed and deleted, scaling, API keys, invitations, joins, role changes and removals. FF's own changes to the account (its approval, a suspension, its plan) are there too, as FF's, with the operator's reason but without their e-mail or address. Entries are never changed or deleted: the database refuses it.

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

`gbSeconds` is billed duration × memory, counting 1,024 MB as 1 GB, as an exact decimal string, as AWS's Cost Explorer gives its amounts. The totals are the records' own sums, never the functions' rounded figures added up. A function deleted since keeps its usage, marked `"deleted": true`. To read the raw records:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform \
  -c "SELECT started_at, function_name, status, memory_mb, duration_ms, billed_ms, init_ms FROM usage_records ORDER BY started_at DESC LIMIT 10"
```

The table has a partition per month, by the UTC calendar (`usage_records_2026_10`, …). The backend creates this month's and the next two at startup and then daily, so a month is never missing.

**Prices** (P-30, D8 of the client-readiness plan). FF charges what AWS Lambda charges, in TND, with the same free tier: 1 million requests and 400,000 GB-s per account and month. Prices live in price books, as data: the first is AWS's US East list at the BCT's rate of 14 October 2026, 3.0080 TND per US$, valid from 1 October 2026. A new book starts in the future, and a book that has started never changes, so past usage keeps its prices. `GET /usage` estimates the month's cost with the books valid during it: each function's cost before the free tier, then the free tier, the duration tiers past 6 billion GB-s, any monthly fee, and the total, each rounded to the millime. A function with `minInstances` above zero pays for those instances while they are ready, and for its calls at the provisioned price, without the free tier. Every hour, the backend rates the hour's usage with the same prices (P-32, below); for the first two weeks it only shows the charges.

```bash
curl -s "$FF/usage" | jq '.estimate'
# {"currency": "TND", "usage": "0.003", "freeTier": "-0.003", "volumeTiers": "0.000", "monthlyFee": "0.000", "total": "0.000", …}
curl -s "$FF/usage" | jq -c '.functions[] | {functionName, gbSeconds, cost}'
docker compose exec -T postgres psql -U postgres -d serverless_platform -c "SELECT valid_from, prices->'source'->>'usdRate' AS rate FROM price_books"
```

**Credit and the ledger** (P-31, D9). Money lives in a double-entry ledger in PostgreSQL. Each movement is a transaction of entries in whole millimes, each added to an account's balance, and they sum to zero: a top-up of 50.000 TND of credit is +50.000 on the account's wallet, +9.500 of VAT that FF owes, and −59.500 that the payment provider holds for FF. An account's balance is the sum of its wallet's entries, and the admin dashboard's account page shows it; below zero, it is usage the credit didn't cover. Each transaction has an idempotency key (`usage:<account>:<hour>`, a payment's own), so a retry never writes it twice. The database checks each transaction's sum when it commits, and nothing in the ledger is ever changed or deleted: a correction is another transaction. Usage is debited once shadow mode is off (P-32, below); credit comes by bank transfer, recorded by an operator (P-35, below), and from FF, granted on the admin dashboard's account page (P-74, below); Konnect top-ups were skipped (P-34). To read the balances:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform -c "
  SELECT a.account_id, a.currency, sum(e.amount_minor) AS balance_in_millimes
    FROM ledger_accounts a JOIN ledger_entries e ON e.ledger_account_id = a.id
   WHERE a.type = 'wallet' GROUP BY 1, 2"
curl -s $FF/admin/accounts/$ACCOUNT -H "Authorization: Bearer $OP" | jq -c .balances    # with an operator's token: below
# [{"currency":"TND","balance":"50.000"}]
```

Amounts are `bigint` from the database to the API, never a JavaScript number, and the API writes them as strings with every decimal of the currency.

**The hourly rating** (P-32, D9). An hour is rated once its last usage can have arrived: 33 minutes after it ends, at the platform's limits (two 900 s timeouts, the cold start, 30 s, and a minute). The backend then sums the hour's billed calls and minute samples into `usage_hourly`, and charges each account that used something in it: its month so far, rated with the price books and rounded once to the millime, less what the month's earlier hours were charged. So the free tier and the tiers count from the month's start, and a month's charges add up to its total rounded once. Each charge is in `usage_charges`, and `rating_runs` lists the hours rated; a stopped backend catches up when it starts, hour by hour, and only one backend rates at a time.

**Shadow mode** is on at first (D9: the platform setting `billingShadowMode`, in the admin dashboard's Settings): charges are recorded and shown, and nothing is debited. Once `npm run billing:reconcile` has agreed for two weeks, turn it off, with a reason: from the next hour rated, each charge is debited, one ledger transaction per account and hour (`usage:<account>:<hour>`), and usage rated in shadow mode is never debited later. The console shows the balance on every page, with "Billing trial" while shadow mode is on; its title gives the month's charges so far. Every member reads it, and an API key with `usage:read`:

```bash
curl -s $FF/billing/balance | jq -c .
# {"currency":"TND","balance":"0.000","shadowMode":true,"month":"2026-10","charged":"0.000","ratedUntil":"2026-10-17T13:00:00.000Z"}
curl -s "$FF/billing/transactions?limit=20" | jq -c '.transactions[] | {kind, occurredAt, amount}'   # newest first; pass next as before
cd BE && npm run billing:reconcile -- --month 2026-10      # the month's charges against its usage records, priced afresh
# 2026-10 until 2026-10-17T13:00:00.000Z (the end of the last hour rated):
# Account         Charged  From usage  Requests rated  Requests used
# 000000000001  0.000 TND   0.000 TND               4              4  ok
# The account agrees.
```

The reconciliation compares, per account, what the hourly rating charged in the month with the same hours priced again from the usage records and samples, and the billed calls counted both ways: the parent plan's criterion, rated usage equals raw usage. It only reads, and exits 1 when an account differs. A difference means usage reached the database after its hour was rated, which the 33 minutes are there to prevent: that usage is not charged.

**The balance check** (P-33, D9). Before each invoke, the backend looks at the account's balance: calls go on down to the negative buffer (`negativeBuffer`, 1.000 TND), so that the hour and a half the rating lags never blocks a paying customer; below it, for the grace period (`gracePeriodHours`, 24); then `POST /functions/:id/invoke` answers `402 InsufficientCreditException`, saying since when and what to do, and records nothing of the call. Reads, logs and deploys go on, and nothing is deleted. Credit lets invokes in again at once. In shadow mode nothing is refused. The balance is cached per account: a trigger on the ledger NOTIFYs every backend of each write to a wallet when it commits, whoever wrote it, and each drops that account's balance; a lost notification is covered within a minute. The console shows a banner on every page once the balance is below the buffer, with the time invokes stop, or a red one once they stopped; both link to the Billing page.

**Low-balance e-mails** (P-33). The owners get an e-mail when the balance falls to 50%, 20% and 0% of the last credit (a top-up, a payment, or credit from FF), each share once per credit: the platform's `lowBalancePercents`, or the shares an owner sets on the console's Billing page. The Billing page also shows the balance, this month's charges, whether invokes go on, and what moved the balance. With the API:

```bash
curl -s $FF/billing/balance | jq -c .credit       # {"state":"ok","buffer":"1.000","belowBufferSince":null,"invokesStopAt":null}
curl -s $FF/billing/alerts | jq -c .              # {"lowBalancePercents":null,"defaultPercents":[50,20,0]}: FF's
curl -s -X PUT $FF/billing/alerts -H 'content-type: application/json' -d '{"lowBalancePercents": [80, 20]}'   # an owner; null for FF's again
```

Any member reads the shares, and an API key with `usage:read`; only an owner, with a login, changes them, and the account's audit log keeps each change (`billing.alerts`).

**Adding credit by bank transfer** (P-35, D9). Credit comes by bank transfer, against a pro-forma. An owner asks for one on the console's Billing page, for a prepaid pack (20, 50, 100 or 500 TND) or another amount from 10 to 1,000,000 TND, before VAT. The pro-forma gives the credit, 19% VAT on top, the total to transfer, FF's bank account, and a reference such as `FF-7KQ2-9MXA` to write in the transfer's label; its page is in French, and prints, or saves as PDF from the browser's print dialog. Every member sees the account's pro-formas and where each one stands, and so does an API key with `usage:read`. Only an owner, with a login, asks for one, whatever the account's status, since a suspended account may still owe usage. An owner can also cancel a pending one, on its page ("Cancel this pro-forma"), so that nobody pays it: it shows as cancelled, and its printed copy says *Annulée*. If a transfer comes for it anyway, FF still records and credits it. A paid one is never cancelled. The account's audit log keeps each request (`billing.pro_forma`) and cancellation (`billing.pro_forma_cancel`).

```bash
curl -s -X POST $FF/billing/pro-formas -H 'content-type: application/json' -d '{"credit": "50"}' | jq -c '{id, reference, credit, vat, total, bank}'
# {"id":"…","reference":"FF-7KQ2-9MXA","credit":"50.000","vat":"9.500","total":"59.500","bank":{"name":"Development bank: no transfer arrives","iban":"TN59 1000 6035 1835 9847 8831","bic":null}}
curl -s $FF/billing/pro-formas | jq -c '.proFormas[] | {reference, status, total, transfer}'   # newest first, the last 100
curl -s -X POST $FF/billing/pro-formas/$PRO_FORMA/cancel | jq -c '{reference, status, cancelledAt}'   # an owner's; again, nothing more
```

Each pro-forma names FF and its bank from `FF_SELLER_NAME`, `FF_SELLER_TAX_ID`, `FF_SELLER_ADDRESS`, `FF_BANK_NAME`, `FF_BANK_IBAN` (its check digits are verified) and `FF_BANK_BIC` (optional). In development they have defaults that say they are not real; in production the backend refuses to start without them (`BE/.env.example`).

When the transfer shows on FF's bank statement, you record it on the admin dashboard's Payments page (below). The wallet gets the credit at once, less any share the buyer withheld at source, and invokes go on again at once (P-33). The withheld share is credited when you add the buyer's withholding certificate. The owners get an e-mail each time.

**Invoices and usage statements** (P-36, D9). Each month an account buys credit in gets an invoice, issued early the next month by FF's operator (below). It lists a line per transfer received up to the month's end and not invoiced before: the credit before tax and its VAT, at the rate of the day the pro-forma was asked for. It adds the stamp duty, 1 TND, which is taken from the account's credit when the invoice is issued. The invoice is a French PDF, numbered `FAC-<year>-000001` without gaps in each fiscal year, with the month's usage statement attached: each function's requests, GB-seconds and cost, the free tier, the total, and what was debited. Usage itself isn't invoiced again, since its credit was. Every month has a usage statement, with or without an invoice. An issued invoice never changes: a correction is a credit note (*facture d'avoir*), `AV-<year>-000001`. The console's Billing page lists the invoices and credit notes, and downloads them and any month's statement. Every member does, and an API key with `usage:read`:

```bash
curl -s $FF/billing/invoices | jq -c '.invoices[] | {number, kind, month, issuedOn, total, corrects}'
curl -s $FF/billing/invoices/$INVOICE/pdf -o invoice.pdf                # as it was issued
curl -s $FF/billing/statements/2026-10/pdf -o releve-2026-10.pdf        # any month that has begun, as rated so far
```

Invoices are dated in Tunisia, an hour ahead of UTC, and the fiscal year is that day's year; usage months stay UTC, as everywhere. **Tax rates are dated data** (parent §8.6): the table `tax_rates` holds the VAT rate (19% since 2018) and the stamp duty (1.000 TND since 2023), each from the day it applies. A new rate is a new row from its first day; rows are never changed. Until the admin dashboard edits them, add one in SQL:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform -c "
  INSERT INTO tax_rates (kind, valid_from, percent, source) VALUES ('vat', '2027-01-01', 20, 'Finance Law 2027')"
```

**Lost calls.** When the backend stops during a call (it crashed, was killed, or restarted), the call's answer is lost, and its invocation would stay `RUNNING`. At startup and every minute, the backend marks such calls `LOST`, with a usage record that bills nothing, once the longest a call can take has passed: two timeouts (a wait for a free instance, then the run), the cold-start limit (`K8S_READY_TIMEOUT_SECONDS`, 90 s), and 30 s more. For a function with a 5 s timeout, that is 2 min 10 s. The history then says `Lost: the backend restarted during the call, so its answer is unknown. It isn't billed.` A function changed since the call started gets the longest timeout there is (900 s), as its timeout then is no longer known.

**Capacity samples.** Five seconds into every minute, the backend lists FF's Deployments in one Kubernetes call and writes a row to `capacity_samples` for each function with a ready instance: how many, its memory and its `minInstances` (D6 and D8 of the client-readiness plan). A warm instance holds its memory whether or not it runs a call, and these samples show how much. Like usage records, samples are never changed or deleted, and the table has a partition per month. The capacity report weighs, per account and day, the GB-s held for ready instances against the GB-s the usage records bill:

```bash
cd BE && npm run capacity:report -- --days 7      # the last 7 days by the UTC calendar, today included
# Day (UTC)   Account       Reserved GB-s  Provisioned GB-s  Billed GB-s  Requests  Reserved ÷ billed
# 2026-10-17  000000000001         45.000             0.000        0.004         3            11,250×
```

One 128 MB instance kept warm for a day holds 10,800 GB-s, while a 1 ms call bills 0.000125 GB-s: that gap is D8's. The admin dashboard's Overview shows the same for the last 7 days (P-75); the report goes further back. "Provisioned" is what `minInstances` would bill at the provisioned price. The report reads the database that `BE/.env` names, and changes nothing.

**The console with a login.** With the backend in OIDC mode as above, copy `FE/.env.example` to `FE/.env.local`, set `VITE_OIDC_AUTHORITY=http://localhost:8180/realms/ff` in it, and restart `npm run dev`. The console then opens on a login page:
1. "Sign up" opens Keycloak's registration form, which takes any address: the verification e-mail arrives in Mailpit (http://localhost:58025) whatever its domain. Its link asks for a password, then brings you back to the console, logged in.
2. The console asks you to create your account, which then waits for approval. Approve it as above, and "Check again" shows the functions.
3. "Account" shows the account; its owners rename it or set its tax ID. "Members" invites people and changes their roles. "API keys" lists, creates and revokes the account's keys, and shows a new key once. The account switcher in the header lists your accounts, and "New account…" makes another. A viewer sees no button to create, change or invoke.

The console keeps its tokens in the tab's session storage, and renews the 5-minute access token with the refresh token before it expires. "Log out" ends the Keycloak session too. When that session ends another way (30 minutes without a renewal, as after the laptop slept, or a logout in another tab), the next call gets 401, and the console asks you to log in again.

**The admin dashboard** (P-70) is for you, FF's operator: a separate web app in `admin/` (http://localhost:5198), for approvals and accounts, support, payments, credit, invoices, prices and plans, the overview, the operator audit log and the platform's settings. It always logs in, through Keycloak's client `ff-admin`: start Keycloak as above, and the backend in OIDC mode, with `CORS_ORIGIN` including http://localhost:5198 (`BE/.env.example` has both addresses). Then:

```bash
cd admin && cp .env.example .env.local && npm install && npm run dev
```

The development realm has one operator, `operator@ff.test`, password `operator-dev-1`, with the realm role `ff-operator`. At its first login, Keycloak asks it to set up a one-time password: scan the QR code with an authenticator app (FreeOTP, Google Authenticator, …), then enter a code. Every later login asks for a code. Customers who log in there are told they aren't operators.

Every change in the dashboard is confirmed with a reason, which the audit log keeps with the operator's name: `operator:<id>`. The backend's `/admin` routes take only an operator's token issued to `ff-admin`; a console token, even an operator's, gets 403, and so do API keys. Development mode has no operator: those routes answer 400 there. In the other direction, a token issued to `ff-admin` calls no customer route.

```bash
OP=$(curl -s -X POST $KC/realms/ff/protocol/openid-connect/token -d grant_type=password -d client_id=ff-admin \
  -d username=operator@ff.test -d password=operator-dev-1 | jq -r .access_token)   # the development realm only
curl -s $FF/admin/settings -H "Authorization: Bearer $OP" | jq -c .settings
curl -s -X PUT $FF/admin/settings -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"settings": {"gracePeriodHours": 48}, "reason": "Pilot customers asked for more time"}' | jq -c .settings
```

The password grant works only in the development realm, for scripts and tests; production's realm turns it off for `ff-admin` (P-60). **The settings** are values the tasks read: shadow billing, which the hourly rating reads each hour (P-32, above), the negative buffer and grace period (P-33), the low-balance e-mails (P-33), the invoice reminder (P-36), the large-credit threshold (P-74), and how many days a closed account's data is kept before it is deleted. Each is its default until changed. Amounts are in TND with three decimals, as strings.

**Payments** (P-35): the dashboard's Payments page lists the pro-formas owners asked for, newest first, with what each one is waiting for. To record a transfer from the bank statement:
1. Find its pro-forma by the reference in the transfer's label, typed in any case, with or without dashes. You can also filter by status or account.
2. "Record the transfer": enter what arrived, what the buyer withheld at source (0 for none), the date on the statement and the bank's reference, then a reason. The two amounts must make the pro-forma's total, and the share withheld must be less than the credit. The dialog says what the wallet gets before you confirm.
3. The wallet gets the credit less the withheld share. This is one ledger transaction, keyed `transfer:<payment>`. For 50.000 TND of credit paid with 0.892 withheld, it is: wallet +49.108, VAT payable +9.500, and the bank's clearing −58.608.
4. When the buyer sends the withholding certificate (*certificat de retenue à la source*), "Add the certificate" uploads it: a PDF, a PNG or a JPEG, 5 MB at most. It is kept in the S3 bucket under `withholding-certificates/<payment>`, and the withheld share is credited, keyed `withholding:<payment>`: wallet +0.892, withholding-tax receivable −0.892. "Certificate" downloads it again.

"Cancel" cancels a pending pro-forma with a reason, which the owners' e-mail gives (`payment.cancel`); the Status filter's "Cancelled" lists those cancelled by owners or by you. A transfer that comes for a cancelled pro-forma anyway is recorded as usual: it pays it and credits the wallet, and the audit entry says it had been cancelled. A transfer is recorded once, and so is a certificate. The operator audit log keeps each step (`payment.record`, `payment.withholding`), as does the account's own log, as FF's. Sort out partial payments and over-payments with the buyer before you record anything; refunds wait for the accountant's answer (the plan, P-74). The account page lists the account's last payments. With the API, the certificate's body is the file itself, so its reason goes in the `X-FF-Reason` header, URI-encoded:

```bash
curl -s "$FF/admin/payments?reference=ff7kq29mxa" -H "Authorization: Bearer $OP" | jq -c '.payments[] | {id, accountId, status, total}'
curl -s -X POST $FF/admin/bank-transfers -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"reference": "FF-7KQ2-9MXA", "received": "58.608", "withheld": "0.892", "receivedOn": "2026-10-20", "bankReference": "VIR-0042", "reason": "Statement of 20 October"}'
curl -s -X PUT $FF/admin/payments/$PAYMENT/withholding-certificate -H "Authorization: Bearer $OP" -H 'content-type: application/pdf' \
  -H "X-FF-Reason: $(jq -rn '"Certificate from the tax platform" | @uri')" --data-binary @certificate.pdf
curl -s $FF/admin/payments/$PAYMENT/withholding-certificate -H "Authorization: Bearer $OP" -o certificate.pdf
curl -s -X POST $FF/admin/payments/$PAYMENT/cancel -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"reason": "Asked for twice by mistake"}' | jq -c '{reference, status, cancelledBy}'
```

**Invoices** (P-36): the dashboard's Invoices page shows a month's drafts, last month's by default: each account with payments received up to the month's end and not invoiced yet, with its lines, VAT, stamp duty and total. A draft is worked out from the payments each time, so a transfer recorded late joins it. Once the month is over in Tunisia, "Issue all" or "Issue" issues them, with a reason. Each invoice is numbered, its stamp duty taken from the account's credit (a ledger transaction, `stamp:<invoice>`: wallet −1.000, stamp duty +1.000), and its PDF written to the S3 bucket under `invoices/<number>.pdf`. Its owners get an e-mail. One that fails, such as for an account name the PDF's fonts can't write, is named, and the others go on; its number goes back, so the numbers keep no gap. A transfer recorded after its month's invoice was issued goes on the next month's. Below the drafts, every issued invoice and credit note, filtered by account, kind and month, with its PDF. "Credit note" corrects an invoice: lines before tax, at the invoice's VAT rate, never giving back more than it charged. A credit note moves no money; refunds wait for the accountant's answer (the plan, P-74). The audit log keeps each document (`invoice.issue`, `invoice.credit_note`), as does the account's own log, as FF's.

From the 1st, you get an e-mail when last month's invoices are ready to issue, and another if some still aren't after `invoiceReminderDay` (the 3rd), each once per month, whichever backend sends it. They go to `FF_OPERATOR_EMAIL`, and link to the Invoices page.

```bash
curl -s "$FF/admin/invoices/drafts?month=2026-10" -H "Authorization: Bearer $OP" | jq -c '.drafts[] | {accountId, total}'
curl -s -X POST $FF/admin/invoices/issue -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"month": "2026-10", "reason": "October reviewed"}' | jq -c '{issued: [.issued[].number], failed}'   # or "accountIds": [...]
curl -s -X POST $FF/admin/invoices/$INVOICE/credit-notes -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"lines": [{"description": "Remboursement du crédit non consommé", "amount": "20"}], "reason": "Unused credit refunded"}'
curl -s "$FF/admin/invoices?accountId=$ACCOUNT" -H "Authorization: Bearer $OP" | jq -c '.invoices[] | {number, kind, total}'
```

**The operator audit log** (P-76): the dashboard's "Audit log" page lists what operators did, newest first: when (in UTC), who, the action, the account, what changed, and why. `GET /admin/audit-log` gives the same, 50 entries a page (`limit`, at most 100; pass `next` as `before` for the next page, older), filtered by part of the operator's e-mail in any case (`operator`), the account (`accountId`), the action (`action`) and a time range (`from` included, `to` excluded, ISO 8601). With `Accept: text/csv` it gives the newest 10,000 entries that match, and the header `X-FF-Truncated: true` when more matched: narrow the filters for the rest. Only operators' actions are in it; customers' are in each account's own log, above.

```bash
curl -s "$FF/admin/audit-log?action=settings.update&limit=5" -H "Authorization: Bearer $OP" \
  | jq -c '.entries[] | {at, operator: .operator.email, action, reason}'
# {"at":"2026-10-17T10:00:00.000Z","operator":"operator@ff.test","action":"settings.update","reason":"Pilot customers asked for more time"}
curl -s "$FF/admin/audit-log?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z" -H "Authorization: Bearer $OP" -H 'Accept: text/csv'
```

**The overview** (P-75): the dashboard's first page, Overview, has the platform at a glance, from `GET /admin/stats/overview`, worked out at most once a minute:
- the accounts by status, and how many wait for your approval;
- the functions, and today's calls, failures and throttles;
- this month's usage charged (debited, or only rated in the billing trial), the credit bought by transfers, the credit FF owes in the wallets, and what accounts in debt owe;
- the invoices issued this month, and last month's to issue;
- the last 7 days of capacity held against billed;
- links to the Grafana dashboards when `VITE_GRAFANA_URL` is set (`http://localhost:3001` in `admin/.env.example`, where `hack/k8s/grafana.sh` serves them).

**Accounts and approvals** (P-71). The dashboard opens on **Approvals**: the accounts waiting for your approval, with who signed up and what they plan to build; the new-account e-mail links there. **Accounts** lists every account, newest first, searched by ID, name or a member's e-mail, and filtered by status and plan. An account's page shows its owners and members, its functions with their last call, this month's usage, its credit (below), its payments and invoices, its status history and its whole audit log, and makes the changes. Each change takes a reason, which the account's audit log keeps, and sends each owner an e-mail:

| Change | From | Then |
|---|---|---|
| Approve | pending | active: it deploys and invokes |
| Reject | pending | rejected: it never deploys |
| Suspend | active | suspended: its functions scale to zero at once (a call under way finishes first), and it can't deploy or invoke. Nothing is deleted |
| Reactivate | suspended | active: functions with warm instances (`minInstances`) get them back; the others start at their next call |
| Close | any but closed | closed, for good: its functions scale to zero, and its data is deleted once the notice period has passed (below) |

The e-mail of a rejection, a suspension or a closure gives your reason. A change that doesn't apply to the account's status answers 409.

Once a minute, the backend scales back to zero any function of a suspended or closed account that started anyway, such as with a call already under way. Moving an account to another plan applies the plan's quota to its namespace at once. Internet egress is off for every new account (its plan's default: beta has it off) until you turn it on: the change writes the account's NetworkPolicy at once, and if the cluster refuses it, nothing changes and you get the error, so try again. Private addresses, FF's own network and the cloud's metadata addresses stay out of reach either way. `K8S_EGRESS_INTERNET=false` cuts every account off, whatever its setting.

**Closing an account deletes its data, after a notice.** Closing sets the date: now plus the notice period in the settings, `closedAccountDeletionDays`, 30 days by default. The owners' e-mail gives it, to the minute in UTC, and so do the account page, `GET /me` and the console's banner; until then, the members still read the account's functions, history and logs. Once the date has passed, a job deletes each function, with its code in object storage and its invocation history, then the account's namespace, then its lines in the log store, and checks that none is left. The account's audit log then shows each deletion as FF's. Its usage records, payments, invoices and audit log stay: the law requires keeping them. The job runs at the backend's start and every hour (`FF_RETENTION_INTERVAL_SECONDS`), with the purge of old invocation history; a step that fails is logged, and the next run does it again. Changing the notice period doesn't move the date of an account closed already.

```bash
curl -s $FF/admin/accounts/$ACCOUNT -H "Authorization: Bearer $OP" | jq -c '.account | {status, dataDeletionDueAt, dataDeletedAt}'
# {"status":"closed","dataDeletionDueAt":"2026-11-17T10:32:45.123Z","dataDeletedAt":null}
```

```bash
curl -s "$FF/admin/accounts?status=pending" -H "Authorization: Bearer $OP" | jq -c '.accounts[] | {id, name, useCase, owners: [.owners[].email]}'
curl -s "$FF/admin/accounts?q=amira" -H "Authorization: Bearer $OP" | jq -c '.accounts[] | {id, name, status, planId}'
curl -s $FF/admin/accounts/$ACCOUNT -H "Authorization: Bearer $OP" | jq '{status: .account.status, balances, functions: [.functions[].name], requests: .usage.totals.requests, history: [.statusHistory[] | "\(.status) by \(.by)"]}'
curl -s -X POST $FF/admin/accounts/$ACCOUNT/suspend -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"reason": "Abuse report: mining cryptocurrency"}' | jq -r .account.status        # also /approve, /reject, /reactivate, /close
curl -s -X PUT $FF/admin/accounts/$ACCOUNT/plan -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"planId": "beta", "reason": "Back to the beta plan"}' | jq -r .account.planId    # the plans: GET /admin/plans
curl -s -X PUT $FF/admin/accounts/$ACCOUNT/egress -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"internetEgress": true, "reason": "Calls a payment API"}' | jq -r .account.internetEgress
curl -s "$FF/admin/accounts/$ACCOUNT/audit-log?limit=20" -H "Authorization: Bearer $OP" | jq -c '.entries[] | {at, actorLabel, action}'
```

**Support.** One search finds what a customer asks about: an account by its ID, its name or a member's e-mail, a function by its ID or a part of its name, and a call by its request ID, the ID in the customer's error message or logs. A call the history no longer keeps is still found by its usage record. A function's page has its settings, its account, and its recent calls and failures, each with its status, duration and error type, but not what went in or out. What a call sent and got back (with its whole error message), the code and the logs are the customer's data: they come only for a reason, and each look goes to the account's audit log, where its owners read it as FF's, with that reason. A look that can't be recorded gives nothing.

```bash
curl -s "$FF/admin/search?q=$REQUEST_ID" -H "Authorization: Bearer $OP" | jq -c '.calls[] | {functionId, accountId, status, inHistory}'
curl -s $FF/admin/functions/$ID -H "Authorization: Bearer $OP" | jq -c '{account: .account.id, errors: [.recentErrors[] | {status, errorType}]}'
curl -s -X POST $FF/admin/functions/$ID/invocations/$REQUEST_ID -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"reason": "Ticket 42: why this call failed"}' | jq -c '{input, output, error}'   # also /code, and /logs with the logs route's fields
```

**Credit from FF** (P-74). The account page's Credit section has the balance, read as it is now; whether invokes go on, with the negative buffer and grace period (P-33); and this month's charges, debited apart from those only rated in shadow mode. "Grant credit" gives:
- **Promotional credit**, which only adds.
- **A correction**, either way: credit added, or taken away. A correction takes the credit left at most, so the balance stays at 0 or above. To leave a debt on purpose, tick "It may leave a debt" (`allowDebt`).

Each grant is one ledger transaction, keyed by the dialog: the wallet moves by the amount, and FF's promotional credit, what the credit costs FF, by the opposite. A grant needs a reason, which goes to the audit log (`credit.promo`, `credit.adjustment`) and to the owners' e-mail. Above the large-credit threshold, 100.000 TND by default and either way, a second step asks for the amount again (D12). A promotion doesn't go to a rejected or closed account; a correction can still settle its balance. Credit lets an account whose invokes stopped invoke again at once.

With the API, make a key once per grant (a UUID): a retry with it grants once, and answers `"replayed": true`. A key used for another grant is refused, and the same request sent twice at once grants once.

```bash
KEY=$(cat /proc/sys/kernel/random/uuid)
curl -s -X POST $FF/admin/accounts/$ACCOUNT/credits -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "{\"kind\": \"promo\", \"amount\": \"25\", \"reason\": \"Welcome credit for the pilot\", \"idempotencyKey\": \"$KEY\"}" \
  | jq -c '{grant: .grant | {amount, balance, replayed}, credit: .account.credit | {balance, state: .state.state}}'
# {"grant":{"amount":"25.000","balance":"25.000","replayed":false},"credit":{"balance":"25.000","state":"ok"}}
curl -s -X POST $FF/admin/accounts/$ACCOUNT/credits -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "{\"kind\": \"adjustment\", \"amount\": \"-150\", \"confirmAmount\": \"-150\", \"reason\": \"Transfer recorded twice\", \"idempotencyKey\": \"$(cat /proc/sys/kernel/random/uuid)\"}"
```

**Prices** (P-73). The dashboard's Prices page lists the price books: past, active and scheduled. A new book starts from the active one, at AWS's US$ prices times a rate, or at TND prices as you set them, with the free tier and D8's knobs (a minimum billed duration, a price for idle instance time, a monthly fee). It starts at a whole hour, UTC, from the next one on, and prices what happens until a later one starts. "Try it on last month" prices last month with the draft, per account, next to the books valid then and what the hourly rating charged (in shadow mode, only rated), and saves nothing. A book that says it is AWS's prices times a rate must be exactly that: the API names each price that isn't. A scheduled book can be removed; one that has started never changes.

```bash
curl -s $FF/admin/price-books -H "Authorization: Bearer $OP" | jq -c '.[] | {status, validFrom, kind: .document.source.kind, rate: .document.source.usdRate}'
BOOK=$(curl -s $FF/admin/price-books -H "Authorization: Bearer $OP" | jq -c '.[] | select(.status == "active") | .document')
curl -s -X POST $FF/admin/price-books/preview -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "$(jq -cn --argjson doc "$BOOK" '{document: ($doc | .prices.monthlyPlanFee = "5.000")}')" | jq '.totals'   # no reason: it saves nothing
curl -s -X POST $FF/admin/price-books -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "$(jq -cn --argjson doc "$BOOK" '{validFrom: "2027-01-01T00:00:00Z", document: $doc, reason: "Same prices next year"}')" | jq -c '{id, status}'
```

**Reset Keycloak** when its realm is older than `deploy/keycloak/ff-realm.json`: Keycloak reads that file only at its first start, so a change to it needs this reset. It deletes Keycloak's users; sign up again afterwards, and the operator sets up its one-time password again. The backend, the console and the admin dashboard can keep running.

```bash
docker compose --profile auth down -v keycloak   # name the service: without it, -v deletes the database and S3 volumes too
docker compose --profile auth up -d --wait       # imports the realm again, in about 30 s
```

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
| History, logs kept | 30 days, 14 days | older calls deleted within the hour (P-45); older lines not shown (P-43), and gone from the log store after its 31 days |

Reads are not rate-limited. A rate is counted per account: a user who has no account yet is counted alone, and a caller without a login by address. The counts live in the backend's memory, so they start again when it restarts.

Plans change in the admin dashboard's Plans page (P-73), or with the operator's token: a change applies at once, and a new quota goes to every account on the plan. The plan's accounts are moved on their page (P-71):

```bash
curl -s $FF/admin/plans -H "Authorization: Bearer $OP" | jq -c '.[] | {id, name, functions: .limits.functions}'
# a plan with more room, from the beta plan's limits
curl -s -X POST $FF/admin/plans -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "$(curl -s $FF/admin/plans -H "Authorization: Bearer $OP" | jq -c '.[] | select(.id == "beta") | {id: "team", name: "Team", limits: (.limits | .functions = 100 | .memoryMb = 2048), reason: "Pilots with a team"}')"
curl -s -X PUT $FF/admin/accounts/$ACCOUNT/plan -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"planId": "team", "reason": "Pilots with a team"}' | jq -r .account.planId
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

**The backend's health, log and metrics** (P-53), as FF's operator watches them. No token is needed: `/readyz` is public, and the metrics are on a port of their own, which only this machine reaches (`FF_METRICS_PORT`, 9464, and `FF_METRICS_HOST`, 127.0.0.1; `FF_METRICS_PORT=0` serves none). The API's port never serves them.

```bash
curl -s localhost:3000/healthz                           # the process is alive
curl -s localhost:3000/readyz                            # it can serve: {"status":"ready","checks":{"database":"ok","kubernetes":"ok"}}
# 503 {"status":"not ready","checks":{"database":"connect ECONNREFUSED 127.0.0.1:5432","kubernetes":"ok"},…} says which failed
curl -s localhost:9464/metrics | grep -E '^ff_(invocations|notification|alarm|rating)'
# ff_invocations_total{outcome="success"} 3
# ff_notification_attempts_total{channel="webhook",result="delivered"} 1
# ff_alarm_evaluations_total 12
# ff_rating_lag_seconds 2591.4
```

- **The backend's own metrics:** invocations by outcome (`success`, `error`, `timeout`, `throttled`, `platform_error`, `lost`), how long they ran and their cold starts, invocations refused (`rate_limit`, `credit`), notification attempts by channel and result, alarm evaluations and changes of state, the API's answers by status class.
- **Read from the database at each scrape:** the rating's lag (since the end of the last hour rated: between about 33 minutes and an hour and a half when it keeps up), the alarm evaluator's (about a minute), the deliveries waiting to be sent, and the accounts whose month doesn't reconcile (as `npm run billing:reconcile` says, computed at most once an hour). The process's own, prefixed `ff_backend_`: CPU, memory, the event loop's lag.
- **The cluster's side** (P-53, part 2) is optional: `hack/k8s/monitoring-up.sh` installs a metrics store that scrapes the backend and the cluster, alert rules that e-mail the operator (a Mailpit in the cluster catches them), and Grafana with two dashboards. Start the backend with `FF_METRICS_HOST="$(hack/k8s/host-address.sh)"` for the store to reach it. The [Kubernetes dev guide](kubernetes-dev-guide.md#the-operators-monitoring) says how to open each part.
- **The database's disk:** `FF_DATABASE_DISK_BYTES` tells the metrics the database server's disk, for the alert when the database fills 80 % of it; unset, there is no such alert.
- **The log** is readable lines in development. `FF_LOG_FORMAT=json` writes what production writes by default: one JSON object a line, with `time`, `level`, `context`, `message`, an error's `stack`, and the `requestId` of the request it was logged for, the same as in the answer's `x-ff-request-id`. In development that includes each SQL query, with its parameters. Every line of a request then comes with one filter, which skips the watcher's own lines: `FF_LOG_FORMAT=json npm run start:dev | jq -cR 'fromjson? | select(.requestId == "<id>")'`. The backend writes no log files: everything goes to stdout.

**Renew the cluster token.** The backend's token is valid for 24 hours. When calls to Kubernetes start failing with `Unauthorized`, run `hack/k8s/mint-token.sh`. `cluster-up.sh` does this as well.

**After changing a runtime** (`runtimes/nodejs` or `runtimes/python`), rebuild and reload the image. New pods use it. To move an existing function onto it, restart its Deployment (with `NS` and `ID` from sections 3 and 4).

```bash
runtimes/python/tests/container-smoke.sh && hack/k8s/load-images.sh
kubectl -n "$NS" rollout restart deploy/fn-$ID
```

**Run the tests.** Use the fast ones while you work and the cluster ones before you commit:

```bash
(cd BE && npm run lint)                                  # the backend's linter, with type information, seconds
(cd BE && npm test)                                      # backend unit tests, seconds; one file: (cd BE && npx jest src/<file>.spec.ts)
(cd BE && npm run test:db)                               # migrations against real PostgreSQL (compose), seconds
(cd BE && npm run migration:check)                       # the migrations build exactly the entities' schema
(cd FE && npm test)                                      # console unit tests, seconds
(cd runtimes/nodejs && npm test)                         # Node.js runtime protocol
(cd runtimes/python && python3 -m unittest discover -s tests)   # Python runtime protocol
hack/k8s/test-it.sh                                      # the Kubernetes driver on the dev cluster, about 6 min
hack/k8s/test-logging-filter.sh                          # the log collector's configuration and filter, in its image, seconds
hack/k8s/test-rbac.sh                                    # the backend's cluster permissions
hack/e2e.sh                                              # the whole stack through the API, about 3 min
hack/e2e-tenancy.sh                                      # every route as another account and anonymously, about 1 min
hack/test-images.sh                                      # the backend's, console's and admin app's images, run as the cluster runs them, about 3 min
hack/k8s/test-platform-manifests.sh                      # deploy/k8s/platform checked without deploying it, about 1 min
hack/e2e-platform.sh                                     # FF deployed from deploy/k8s on a cluster of its own, through its edge, about 15 min
hack/backup-drill.sh                                     # the restore drill: both databases to a moment, the legal records, about 2 min
```

**The pipeline** runs them in stages, the same here as on the CI server (`.github/workflows/ci.yml`, one job a stage). Each stage stops at its first failing step and names it:

```bash
hack/ci.sh static            # linters, types, builds, the docs, how-it-works.html's script, the shell scripts, the workflow, about 5 min
hack/ci.sh unit              # every unit suite: backend, console, admin app, both runtimes, alert rules, log filter, about 2 min
hack/ci.sh db                # L2 and the migrations' drift check, on a PostgreSQL 15.19 of its own, about 2 min
hack/ci.sh security          # gitleaks on every commit, npm audit, and each image scanned by Trivy with its SBOM in hack/.ci/sbom, about 3 min
hack/ci.sh cluster           # L3, L4, L5, the images and the platform's manifests, on the dev cluster, about 15 min
hack/ci.sh platform          # hack/e2e-platform.sh: nightly on the CI server, about 15 min
hack/ci.sh all               # static, unit, db, security and cluster
```

`security` fails on a high or critical vulnerability that has a fix. One that can't be fixed yet is accepted in `.trivyignore.yaml`, for the one binary it is in, with why and until when; on that date the scan reports it again. A gitleaks finding that isn't a secret goes in `.gitleaksignore`, by its fingerprint.

**The platform's images** (P-60): `BE/Dockerfile`, `FE/Dockerfile` and `admin/Dockerfile`. The two apps bake their addresses into the bundle, so each environment builds its own:

```bash
docker build -t ff-backend BE
docker build -t ff-console --build-arg VITE_API_URL=https://api.example.tn --build-arg VITE_OIDC_AUTHORITY=https://login.example.tn/realms/ff FE
docker build -t ff-admin --build-arg VITE_API_URL=https://api.example.tn --build-arg VITE_OIDC_AUTHORITY=https://login.example.tn/realms/ff admin
```

In production the backend serves no API documents unless `FF_API_DOCS=true`, and believes `X-Forwarded-For` only from the proxies `FF_TRUST_PROXY` names (the edge's addresses), so that the audit log and the rate limits see the caller.

**Reset everything.** This is destructive: it deletes the cluster and all local FF data.

```bash
hack/k8s/cluster-down.sh
docker compose down -v
```

## 6. When something goes wrong

**Where the logs are.** Look there first: most problems name themselves.

| Part | Its log |
|---|---|
| The backend | Its terminal, the one running `npm run start:dev`: `<time> [<level>] [<context>] <message>`, with the stack trace under an error. Every answer carries its request ID in the `x-ff-request-id` header, which the browser's Network tab shows; in JSON (below), each line logged while serving it names it. Started in the background (`npm run start:dev > ~/ff-backend.log 2>&1 &`), it logs to that file: `tail -f ~/ff-backend.log`. |
| The console, the admin dashboard | Their `npm run dev` terminal shows build errors. What happens in the page shows in the browser's developer tools (F12): Console for its errors, Network for each call to the API and its answer. |
| Keycloak | `docker compose logs -f keycloak`. A failed login is a `LOGIN_ERROR` line, with its reason: `error="invalid_redirect_uri"`, `error="invalid_user_credentials"`, … |
| E-mails | Mailpit, http://localhost:58025, keeps every e-mail Keycloak and the backend sent. Without `FF_SMTP_URL`, the backend writes its e-mails to its own log instead. |
| PostgreSQL, S3, Mailpit | `docker compose logs -f postgres`, or `s3`, or `mailpit`. |
| Functions | Section 4, "Logs": the console's Logs tab, `GET /functions/:id/logs`, or `kubectl logs`. |

In development the backend also logs every SQL query, a few every 10 s from its background tasks. To read its log without them, start it with JSON lines and leave out TypeORM's; other lines, such as the compiler's, pass as they are:

```bash
cd BE && FF_LOG_FORMAT=json npm run start:dev 2>&1 | jq -rR --unbuffered '(fromjson? | objects) // {message: .}
  | select(.context != "TypeORM") | ([.time, .level, .context, .requestId, .message] | map(select(. != null)) | join(" ")), (.stack[]? // empty)'
```

| Symptom | Fix |
|---|---|
| `resources: FAIL …` | Free memory or disk first. The thresholds protect the machine; don't lower them to push through. |
| Port 5432 or 9003 already in use | `FF_PG_PORT=55432 FF_S3_PORT=59003 docker compose up -d --wait`, then set `DB_PORT` and `MINIO_PORT` in `BE/.env` to match. |
| Port 6550 already in use | `export FF_API_PORT=6551` before `hack/k8s/cluster-up.sh`, then set `K8S_API_URL=https://127.0.0.1:6551` in `BE/.env`. |
| Port 3000 already in use | Set `PORT` in `BE/.env`, and `VITE_API_URL` in `FE/.env.local` to match (see `FE/.env.example`). |
| `Port 5199 is already in use` | The console doesn't move to another port: the login and the backend's `CORS_ORIGIN` name this one. Stop what holds it (`ss -ltnp 'sport = :5199'`). To use another port anyway, change `CONSOLE_PORT` in `FE/vite.config.ts`, add the address to `ff-console`'s redirect URIs and web origins in Keycloak's admin console, and set `CORS_ORIGIN` in `BE/.env`. |
| The console says `Can't reach the API at …` | The backend isn't running at `VITE_API_URL`, or its `CORS_ORIGIN` doesn't include http://localhost:5199. A `BE/.env` from before 2026-10-17 says 5173: take the line from `BE/.env.example`. |
| The console says `The API asks for a login, but this console has none` | The backend runs in OIDC mode, and the console without a login. Set `VITE_OIDC_AUTHORITY` in `FE/.env.local` and restart `npm run dev`, or set `FF_AUTH_MODE=dev` in `BE/.env`. |
| Keycloak answers `Invalid parameter: redirect_uri` | Your Keycloak still has the realm it imported before the console moved to port 5199 (2026-10-17). Reset it, as "Reset Keycloak" in section 5 shows, then open the console again and sign up again: reloading the error page repeats the old request. |
| The admin dashboard's login answers `Client not found`, or `operator@ff.test` can't log in | Your Keycloak imported the realm before the admin dashboard existed (2026-10-17). Reset it, as "Reset Keycloak" in section 5 shows. |
| Keycloak, Mailpit or S3 doesn't answer after `docker system prune` | The prune deleted their stopped containers, not their volumes: `docker compose --profile auth up -d --wait` makes the containers again, with the data they had. |
| 403 `The admin routes take a token issued to the admin dashboard (ff-admin)` | The token came from another client, such as the console's. Log in to the admin dashboard, or get the token through `ff-admin`. |
| 400 `prices.requestsPerMillion: must be 0.20 × 3.0080 = 0.6016` | A book that says its prices are AWS's US$ prices times a rate has one that isn't: change it, or make the book's source `manual`. |
| `Ledger transaction … does not sum to zero`, or `… has fewer than two entries` | Something wrote the ledger around `LedgerService.post()`, such as SQL by hand. The database checks each transaction when it commits, so nothing of it was written. Write a whole transaction, balanced, in one database transaction, or post it through the service. |
| `migration:run` stops with `Price books must start at a whole hour, UTC, for the hourly rating (P-32)` | A book in your database starts within an hour, which the admin dashboard never makes. Remove it if it hasn't started (`DELETE FROM price_books WHERE id = '…'`); one that has started can't be changed, so ask before going further. |
| The backend logs `The hourly rating failed: …` every minute, and `GET /billing/balance`'s `ratedUntil` stops moving | The rating stops at the hour it can't finish, so that no hour is skipped: the message names the problem, such as a database that can't be reached. Fix it; the next turn rates the hour, then every hour after it, and charges each account once. |
| `npm run billing:reconcile` marks an account `DIFFERENT` | Usage reached the database after its hour was rated, and no charge includes it. Compare the account's usage records with `usage_hourly` for the month's hours to find the late ones, and keep shadow mode on until the cause is fixed. |
| 402 `InsufficientCreditException: Invokes stopped at …` | The account's balance has been below the negative buffer for the grace period (P-33). Add credit; invokes go on at once. An owner asks for a pro-forma on the console's Billing page and transfers its total, and you record the transfer on the admin dashboard's Payments page (P-35); or you grant credit on the account's page (P-74). Shadow mode, in its Settings, also lets every invoke through. |
| A grant: 409 `Account … has … TND: taking … TND would leave it below 0.000 TND` | A correction takes the credit left at most (P-74). Take less; or, if the customer owes it, tick "It may leave a debt" (`allowDebt: true`). |
| A grant: 400 `… is above the large-credit threshold` | Above `largeCreditThreshold`, the amount is typed again (`confirmAmount`, D12): the dashboard asks for it in a second step. The threshold is on the Settings page. |
| A grant: 409 `idempotencyKey … was used for another grant` | Each grant takes a key of its own; the dashboard makes one each time its dialog opens. The same key with the same grant is a retry: it answers `"replayed": true` and grants nothing more. |
| The backend won't start: `FF_SELLER_NAME must be set when NODE_ENV=production: pro-formas name the seller and where to pay (P-35)` | In production, set `FF_SELLER_NAME`, `FF_SELLER_TAX_ID`, `FF_SELLER_ADDRESS`, `FF_BANK_NAME` and `FF_BANK_IBAN`: each pro-forma prints them. The development defaults say they are not real, so production refuses them. |
| 400 `received … and withheld … make …, not the pro-forma's …` when recording a transfer | What arrived and what was withheld at source must add up to the pro-forma's total. A partial payment or an over-payment isn't recorded: sort it out with the buyer first. |
| 409 `The transfer for FF-… was recorded on …` | The transfer was already recorded: each pro-forma takes one. The Payments page shows it, with what it credited. Cancelling it gets the same answer: a paid pro-forma isn't cancelled. |
| 409 `2026-11 isn't over in Tunisia: its invoices are issued from the 1st of the next month` | A month's invoices are issued once it is over, in Tunisia's time. The drafts show meanwhile. |
| An invoice isn't issued: `"…" has a character the PDF's fonts can't write` | The PDF's standard fonts write French and other Latin text, not Arabic script: an account named in Arabic can't be invoiced until a font that writes it is added (see the plan, P-36). Its number goes back, and the other invoices are issued. Meanwhile its owners can give the account its name in Latin letters on the console's Account page, as the company's French name; then issue it again. |
| `No stamp duty applies on …: add one to tax_rates` (or VAT) | No rate in `tax_rates` covers that day: add the rate in force from its first day, as above. |
| The backend logs `Not listening to the ledger: …. Again in 5 s` | Its connection for the ledger's NOTIFY broke, and it opens another. Meanwhile, a cached balance can be a minute old at most. If it repeats, check the database. |
| `ledger_entries is append-only: UPDATE refused` (or `DELETE`, `TRUNCATE`; the same for `ledger_transactions` and `ledger_accounts`) | The ledger is never changed. Post a correcting transaction instead: the movement the other way. |
| 409 `The ledger key … was posted before, with other entries` | A movement reused another's idempotency key: the first stands, and nothing was written. A retry must post the same entries. |
| 409 `Account … is active: only a pending account can be approved` | The change doesn't apply to the account's status any more: another operator changed it first. Reload the account's page; its status history says who did what. |
| 403 `The admin routes are for FF's operators` | The user hasn't the realm role `ff-operator`. Give it in Keycloak's admin console (Users → Role mapping), then log in again. |
| 400 `Every admin change needs a reason` | Send `reason`, 3 to 500 characters, in the body. |
| `The backend did not start` with `Invalid configuration (… problems)` | Each line names a variable and what it expects. With `FF_DEV_USER_ID is no longer read`, your `BE/.env` is from before 2026-10-17: copy `BE/.env.example` again. With `FF_SCALE_TO_ZERO_IDLE_SECONDS is no longer read` or `K8S_TENANT_QUOTA_… is no longer read`, remove those lines: the account's plan sets them now. |
| A backend test stops before it starts: `Must use import to load ES Module: …/node_modules/@nestjs/common/index.js` | NestJS ships its packages as ES modules only, and Jest loads them from the backend's CommonJS only on Node.js 24.9 or newer, with the flag `--experimental-vm-modules`. Check `node --version` (with nvm: `nvm install 24 && nvm use 24`). Then start Jest through npm, which passes the flag from `BE/.npmrc`: `npm test`, `npm run test:db`, or `npx jest <file>`. An editor's test runner, or `node_modules/.bin/jest`, needs `NODE_OPTIONS=--experimental-vm-modules` set itself. |
| After your machine changed networks, functions can't resolve names (`EAI_AGAIN`, even for `kube-dns.kube-system.svc.cluster.local`), and L3's network cases fail | The cluster's node keeps the DNS servers it started with: `docker exec k3d-ff-dev-server-0 cat /etc/resolv.conf` names the old network's (`ExtServers`). Restart the cluster with the k3d in `hack/bin`, which isn't on your `PATH` (a bare `k3d` says the command isn't found): `hack/bin/k3d cluster stop ff-dev && hack/bin/k3d cluster start ff-dev`, about 15 s. The node then names the new network's servers, and L3 passes again. Every pod restarts, those of functions another terminal runs too. |
| 400 `… must not contain the NUL character (U+0000)` | PostgreSQL stores no NUL in text, so the API refuses it in what it keeps: a function's code, names, settings, searches. Remove it. An invocation's input may hold one: the function gets it whole. |
| A function can't reach an outside API: `connect ETIMEDOUT`, or a name that resolves but never answers | Its account's internet egress is off, as every new account's is. Turn it on in the admin dashboard (the account's page), or with `PUT /admin/accounts/:id/egress`. In development mode, without the admin dashboard: `UPDATE accounts SET internet_egress = true WHERE id = '<FF_DEV_ACCOUNT_ID>';` in the database, then change a function's code or create one: every rollout writes the account's NetworkPolicy. |
| The backend won't start: `K8S_RUNTIME_CLASS must name the sandbox functions run in (gvisor) when NODE_ENV=production` | Production runs customers' code in gVisor. Install it on the nodes, apply `deploy/k8s/optional/runtimeclass-gvisor.yaml`, and set `K8S_RUNTIME_CLASS=gvisor` (the platform's `backend.env` has it). Only a cluster that tries the platform's manifests, without customers, sets `K8S_ALLOW_UNSANDBOXED=true` instead. |
| 400 `… must be at most … on the Beta plan`, or `The Beta plan allows 25 functions per account` | The request goes beyond the account's plan. Ask for less, or move the account to a larger plan ("Plans and limits" in section 5). |
| 400 `An account needs an owner: make another member owner first` | Make another member owner, then change or remove the first one. |
| An invited person doesn't see the account | They must log in with the invited address, within 7 days of the invitation. `GET /members` (or the console's "Members") shows the invitation, and whether it expired; invite again to renew it. |
| 429 `TooManyRequestsException: Rate exceeded: the Beta plan allows …` | The account made more changes or invocations than its plan allows. Wait for the seconds in `Retry-After`. |
| Every API call returns 401 | `FF_AUTH_MODE` isn't `dev`, and the call has no valid token. Use the development values from `BE/.env.example`, or send a token: see "Log in with Keycloak" in section 5. |
| 401 `The token was issued by another issuer` | `FF_OIDC_ISSUER` must be exactly the token's `iss`, `http://localhost:8180/realms/ff` for the local Keycloak, including `localhost`. |
| 403 `This user has no account yet: create one with POST /accounts` | The token is valid, but the user has no account to act for: create one, as "Log in with Keycloak" in section 5 shows. |
| 403 `Your account is waiting for approval` | A new account can't deploy or invoke until it is approved: in the admin dashboard's Approvals, or with the operator's token ("Log in with Keycloak" in section 5). |
| 400 `This user belongs to several accounts` | Name one: `-H "X-FF-Account: <account ID>"`. `GET /me` lists them. |
| 403 `This API key lacks the scope …` | The key wasn't given that scope. Make one that has it; scopes can't be added to a key. |
| 401 `The API key was revoked`, or `has expired` | Make a new key. |
| `migration:run` stops with `tenants that are not 12-digit account IDs` | Functions from before 2026-10-17 can't move to accounts. Reset the database once, as shown after step 7. |
| A function you can see in the console answers 404 to `curl` | The two act as different accounts: `curl` sent `X-FF-Dev-Account`, or the backend runs with another `FF_DEV_ACCOUNT_ID` than when the function was created. |
| An answer is 500 with `… failed because of an internal error (request <id>)` | A failure of the platform, not of your function. The backend's log has the details: search it for the request ID, which every answer also carries in `x-ff-request-id`. |
| The backend logs `The operator's metrics are not served: 127.0.0.1:9464 cannot be listened on: … EADDRINUSE` | Another backend holds the port, such as one started in another terminal. The API serves all the same. Give this one another `FF_METRICS_PORT`, or `0` for none. |
| `/readyz` answers 503 | `checks` says which part failed. The database: start it (`docker compose up -d --wait postgres`). Kubernetes with `Unauthorized`: the cluster token expired, run `hack/k8s/mint-token.sh`; with `no answer within 2 s`: start the cluster (`hack/k8s/cluster-up.sh`). |
| `The backend did not start: The database schema is out of date: … pending` | `cd BE && npm run migration:run`, then start it again. |
| `migration:run` fails with `relation "functions" already exists` | The database was created before migrations were used. Reset it once, as shown after step 7. |
| `npm run test:db` fails with `ECONNREFUSED` | PostgreSQL isn't running: `docker compose up -d --wait postgres`. The tests read `DB_*` from `BE/.env`. |
| Kubernetes calls fail with `Unauthorized` | The token expired: `hack/k8s/mint-token.sh`. |
| Function pods in `ImagePullBackOff` | The runtime image is not in the cluster: `hack/k8s/load-images.sh`. |
| `create` fails with `The function failed to load:` | The code didn't load: the runtime's reason follows, and `functionId` names the function, saved as `ERROR`. Fix the code and send it with `PUT /functions/<id>`, rather than create it again: see "If a function cannot load" in section 3. If the answer is 500 instead, the platform failed: see the row below about request IDs. |
| `create` takes 90 s, then fails | The backend couldn't read the runtime's reason in the log store, and waited for the readiness timeout: check the log pipeline (`kubectl -n ff-system get pods`; `hack/k8s/logging-up.sh` installs it). |
| 400 `name must be 1 to 64 letters, digits, hyphens or underscores…` | Function names follow AWS Lambda's rule: no spaces, dots or accented letters, and 64 characters at most. `my-function` or `my_function`, rather than `my function`. |
| 409 `A function named "…" already exists in this account` | Names are unique within an account: choose another name, or change the function that has it (`PUT /functions/<id>`). One whose code failed to load was saved all the same: fix it rather than create it again. |
| 409 `The new version is live, but the function keeps its name …` | Another create or rename took the new name while the update rolled out. The rest of the update went through; rename the function again with a free name. |
| An update answers 400 with `The update was rolled back` | The new version couldn't start; the reason comes first. The previous version still serves, and the record is unchanged. |
| An invocation stays `RUNNING`, then becomes `LOST` | The backend stopped during the call, so its answer is unknown; it isn't billed. Invoke again. See "Lost calls" in section 5. |
| The backend logs `Could not create the monthly partitions` | The migrations haven't run (`cd BE && npm run migration:run`), or the database refused: the message says why. An invocation in a month without a partition fails with `no partition of relation "usage_records" found for row`. |
| The backend logs `Could not sample capacity` | The Kubernetes API didn't answer the list of Deployments, or the database refused the samples: the message says why. That minute has no sample; the next minute is sampled as usual. |
| An invoke answers 429 with `TooManyRequestsException: Rate exceeded: no instance was free within …` | More calls arrived together than the function's instances could take within one timeout. Raise `maxInstances` (`PUT /functions/<id>/scaling-config`), or make the calls shorter. |
| `jq: parse error` after `echo "$response" \| jq` in zsh | zsh's `echo` expands `\n` inside JSON strings. Pipe `curl` straight into `jq`, or use `printf '%s' "$response"`. |

More symptoms and fixes are in the dev guide's [troubleshooting table](kubernetes-dev-guide.md#troubleshooting).
