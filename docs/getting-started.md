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
- **Every function's code runs as an image** in the registry that `hack/k8s/cluster-up.sh` runs next to the cluster ([ADR 0003](adr/0003-code-delivery.md)). `BE/.env` names it as `.env.example` does: `FF_CODE_REGISTRY=http://127.0.0.1:5056` and `FF_CODE_REGISTRY_PULL=ff-dev-registry:5000`. A `BE/.env` from before 2026-10-21 lacks them: add those two lines, or every create and update answers 503 `This FF has no code registry`.
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

**10. Customers' databases (optional).** Customers' PostgreSQL databases live on a server of their own, apart from FF's ([ADR 0008](adr/0008-customer-databases.md)). In development it is `docker-compose.yml`'s `data-db`, PostgreSQL 18 with TLS only, on a Docker network of its own (10.199.0.0/24) that the cluster's node joins, so that functions reach it at its address there, as the backend and `psql` on this machine do. The script builds and starts it, joins the node, copies the CA of its certificate to `hack/.data-db/ca.crt`, and prints four lines for `BE/.env`; restart the backend after adding them. Without them, FF has no databases.

```bash
hack/k8s/data-db-up.sh            # about 2 minutes the first time: it builds its image
```

- Functions reach it whatever their account's internet access: their NetworkPolicy opens its address on port 5432, and nothing else of that network. Node.js functions trust its certificate through `NODE_EXTRA_CA_CERTS`, which FF sets to the CA it mounts in their pods; a Python driver finds the CA at `/etc/ff/data-db/ca.crt`.
- `hack/k8s/data-db-up.sh psql` opens `psql` in it as its superuser; `hack/k8s/data-db-up.sh down` stops it, and `down --volumes` deletes its data too, as `docker compose down -v` does.

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

**Invoke it.** `input` is the handler's event, as a payload is on AWS Lambda: any JSON value, `{}` when there is none. `duration` is the execution time in milliseconds, as the runtime measured it:

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

**Errors and timeouts.** A function that raises, or runs past its timeout, answers HTTP 400 with the error, and with the call as the history keeps it: `invocation`, its `id` (the request ID of its log lines), `status` `ERROR` or `TIMEOUT`, `duration` and `memoryUsed`. `examples/hello.py` raises for the name `error`, and `examples/slow.py` sleeps:

```bash
curl -s -X POST "$FF/functions/$PY/invoke" -H 'content-type: application/json' -d '{"input": {"name": "error"}}' | jq -c '{message, invocation}'
# {"message":"ValueError: this name is not allowed","invocation":{"id":"9b2e…","status":"ERROR","duration":2,"memoryUsed":36}}

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

`GET /databases/<id>/metrics` gives a customer's database's, a point an hour from its hourly measures (below), under the names CloudWatch gives RDS's and Aurora's: `DatabaseConnections`, its sessions, and `VolumeBytesUsed`, the bytes it uses, each with its `Maximum` and `Average` over the hour, `null` for an hour it wasn't measured in. Its period is an hour; by default the window starts 60 hours before now.

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

**Alarms**, as CloudWatch's: a metric of a function, or of the whole account without one, its statistic over a period, compared with a threshold, and "M out of N" periods breaching. Every minute FF judges the last N whole periods, each once it has been over a minute, so that a call ending then still counts. M or more breaching is `ALARM`, fewer is `OK`. A period without a datapoint (a duration with no call) is left out by default, and all N missing is `INSUFFICIENT_DATA`; `treatMissingData` makes it `notBreaching`, `breaching`, or `ignore`. Going into `ALARM`, and out of it, the alarm tells its actions: the owners' e-mail and up to 5 webhooks, signed as above, with `"kind": "alarm"` and the alarm, the states it left and entered, why, and the datapoints. Two alarms watch the account's money as it is: `Balance` and `MonthToDateCharges`, with the statistic `Latest` and one datapoint. An alarm with a `databaseId` watches a customer's database's `DatabaseConnections` or `VolumeBytesUsed`, hours at a time (`period` 3600), each hour judged once it is over; it goes with its database, as a function's alarm goes with its function.

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

They are configuration: whoever reads the function reads them, as on Lambda, and `GET /functions/<id>` answers with them (the list doesn't). The database keeps them encrypted, with the keys of `FF_ENCRYPTION_KEYS_FILE`: development has a key of its own, which production refuses. The cluster gives them to the function's pods through a Kubernetes Secret, and the audit log names the variables an update added, changed or removed, never their values. The console's Environment tab edits them. A value nobody should read back, such as a database password, belongs in a secret.

**Secrets** are variables whose values nobody reads back: not the console, not the API, not the audit log. The function reads them as its other variables, so its code is the same on AWS, where they become variables or Secrets Manager entries. They follow the variables' name rule, a name being a variable or a secret but not both, and count in the same 4 KB. Give them on create (`"secrets": {"DB_PASSWORD": "…"}`), or set and remove them later, `null` removing one; the others stay. A change rolls out a new version, as a change of variables does, and answers once it is live, with each secret's name and when it was set:

```bash
curl -s -X PATCH "$FF/functions/$ID/secrets" -H 'content-type: application/json' \
  -d '{"secrets": {"DB_PASSWORD": "correct-horse-battery-staple", "OLD_TOKEN": null}}' | jq -c .
# {"secrets":[{"name":"DB_PASSWORD","updatedAt":"2026-10-21T08:00:00.000Z"}]}
curl -s "$FF/functions/$ID/secrets" | jq -c '[.secrets[].name]'
```

Every member lists their names; owners and developers change them, and API keys with `functions:read` and `functions:write`. A value set again unchanged, or a name already gone, changes nothing. The console's Environment tab lists them under the variables, sets one (the value typed once, never shown again) and removes one.

**A web address for a function.** A function URL makes the function a web endpoint, as on AWS Lambda: every request to it, any method and any path, calls the function, and what the function returns is the response.

```bash
URL=$(curl -s -X POST "$FF/functions/$ID/url" -H 'content-type: application/json' -d '{"authType": "NONE"}' | jq -r .functionUrl)
echo "$URL"                        # http://<32 letters and digits>.fn.localhost:3001/
curl -si "${URL}hello?name=Amira"  # the function's answer, with x-amzn-RequestId
```

The backend answers URLs on a port of its own, `FF_FUNCTION_URL_PORT` (3001), at `FF_FUNCTION_URL_BASE` (`http://fn.localhost:3001`): browsers and curl take every name under `.localhost` to your machine. The address is random and stays the same until you delete the URL; a new URL gets a new address. The function gets AWS Lambda's event for function URLs, API Gateway's payload format 2.0: `rawPath`, `rawQueryString`, `queryStringParameters`, `headers` (names in lower case), `cookies`, `body` (text for text, JSON and XML; otherwise base64, with `isBase64Encoded`), and `requestContext` with `http.method`, `http.sourceIp` and `requestId`. It answers with `statusCode`, `headers`, `cookies`, `body` and `isBase64Encoded`; any other value is sent as JSON with 200. A handler written for a Lambda function URL runs unchanged:

```ts
export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const name = event.queryStringParameters?.name ?? 'world';
  return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: `Ahlan ${name}` };
}
```

- **Who may call it.** `"authType": "NONE"`: anyone, on the account's bill. `"AWS_IAM"`: only callers with an API key of the account that has `functions:invoke`, made by an owner or a developer, sent as `Authorization: Bearer ffk_…`; the function never sees the key. On AWS the same setting takes callers' SigV4 signatures instead.
- **Browsers on other sites.** `"cors"` takes AWS Lambda's six fields: `allowOrigins`, `allowMethods`, `allowHeaders`, `exposeHeaders`, `allowCredentials` and `maxAge`. With them, the URL answers browsers' preflights itself and puts its CORS headers on every answer; without them, the function answers preflights like any request.
- **A call like any other.** It counts against the plan's invocations per second together with the API's invokes, needs the account's credit, has its usage record and its price, and is in the history with `"source": "url"`. The history keeps the request with the values of `authorization`, `proxy-authorization` and `x-api-key` as `***`, and without its cookies.
- **When FF answers instead of the function**, with `{"Message": …}`: `404` for an address that is no URL, `403` without the account's credentials, `429` past the plan's rate, `402` without credit, `503` while the function isn't `ACTIVE`, `413` for a request over 6 MB, as on Lambda. A function that throws, times out, or returns something that can't be an HTTP response gets `502`, never its error's text: the history has that for you, and the backend's log says why a response couldn't be sent. Every answer carries `x-amzn-RequestId`, the call's request ID in the history and the logs.
- **Your own domain.** The URL can answer at a domain of yours too, such as `shop.example.tn`: add it, make the DNS record it asks for, and check it. A subdomain needs a CNAME to the URL's host; a domain apex, which can't have one, a TXT record `_ff-verify.<domain>` with the token FF gives, and an A record to FF's edge. Once the DNS proves the domain is yours, the URL answers there over HTTPS, its certificate made at the first request; the event's `requestContext.domainName` is your domain.

  ```bash
  curl -s -X POST "$FF/functions/$ID/url/domains" -H 'content-type: application/json' -d '{"domain": "shop.example.tn"}' | jq -c '{status, records}'
  # {"status":"pending","records":{"cname":[{"type":"CNAME","name":"shop.example.tn","value":"<id>.fn.localhost"}],"txt":[…]}}
  curl -s -X POST "$FF/functions/$ID/url/domains/shop.example.tn/verify" | jq -r '.status, .checkError'   # once the record is made
  ```

  A domain is checked again on each `…/verify`: if its records are gone, it goes back to pending and the URL stops answering there. An account adds a domain once; several accounts may add the same one, but only the first whose DNS proves it has it. The plan limits how many an account has (5 on the beta plan). `GET …/url/domains` lists them, `DELETE …/url/domains/<domain>` removes one, and deleting the URL removes them all. In development, the backend asks the DNS servers `FF_DOMAIN_RESOLVERS` names, for a test zone (`hack/e2e.sh` runs one), or the system's.
- **In the console**, a function's URL tab does it all: create the URL, copy its address, see who may call it and how, change the auth type and CORS, delete it. The Invocations tab says which way each call came, and reads the history again each time it opens.
- **The rest.** `GET /functions/<id>/url` reads it; `PUT` changes what you send and keeps the rest (`"cors": null` removes CORS); `DELETE` stops the address at once. Every member reads it; owners and developers change it, and API keys with `functions:read` and `functions:write`. Only functions with AWS Lambda's event can have a URL, and a function with a URL can't go back to FF's original wrapped event until the URL is deleted.
- **In a cluster**, the edge sends every host under the function domain, `*.fn.<your domain>`, to that port over HTTPS, with one wildcard certificate that it gets through your DNS, or one per URL at its first request; and customers' own domains, each with a certificate made at its first request once the backend says the domain is verified: [deploy/k8s/README.md](../deploy/k8s/README.md), "Function URLs".

**Run a function on a schedule.** A schedule calls the function at the times its expression names, as an EventBridge rule's schedule does, the one SAM's `Schedule` event declares:

```bash
curl -s -X POST "$FF/functions/$ID/schedules" -H 'content-type: application/json' \
  -d '{"name": "nightly-report", "expression": "cron(0 2 * * ? *)"}' | jq -c '{name, nextRunAt}'
# {"name":"nightly-report","nextRunAt":"2026-10-22T02:00:00.000Z"}
curl -s "$FF/schedules/next-runs?expression=rate(15%20minutes)" | jq -c .runs   # a preview: the next five runs
```

- **Expressions** are EventBridge's, in UTC. `rate(1 minute)`, `rate(5 minutes)`, `rate(1 hour)`, `rate(2 days)`: the unit is singular for 1 and plural above, and the first run comes one interval after the schedule starts. `cron(minutes hours day-of-month month day-of-week year)`: six fields, one of the two days `?`, with `,` `-` `*` `/`, `L` (the month's last day, or `5L` its last Thursday), `W` (`15W`, the weekday nearest the 15th; `LW`, the last weekday), `#` (`2#1`, the first Monday), the names `JAN`–`DEC` and `SUN`–`SAT` (`1` is Sunday), and years from 1970 to 2199. Nothing runs more often than once a minute. A wrong expression is refused with what is wrong in it.
- **The event** is EventBridge's Scheduled Event: `{"version": "0", "id", "detail-type": "Scheduled Event", "source": "aws.events", "account", "time", "region", "resources": [the rule's ARN], "detail": {}}`, `time` when the run was due and `region` FF's (`FF_REGION`, `tn-tunis-1`). A schedule with an `input` sends that instead, any JSON value, as SAM's `Input` does.
- **Each run is a call like any other:** the plan's invocations per second, the account's credit, the history with `"source": "schedule"`, the usage record and its price. A run that can't be made (the function not `ACTIVE`, the account suspended or without credit, the plan's rate or its room for messages) is skipped, and the schedule's `lastOutcome` says why; otherwise it says `running`, then each attempt's outcome, `success`, `error`, `timeout` or `throttled`, and `lastRequestId` names the run in the history and the logs.
- **Kept, then retried as an asynchronous call.** Every few seconds (`FF_SCHEDULER_INTERVAL_SECONDS`, 5), the backend takes the schedules due, and in one transaction moves each to its next run and keeps its run in the function's queue, as EventBridge Scheduler hands its runs to Lambda: several backends never take one twice, and a backend stopped later loses nothing. The run is then an asynchronous call ("Call a function without waiting", below): within seconds, retried a minute, then two minutes after a failure, by the function's own settings, else Lambda's, each attempt the schedule's call in the history. A schedule late by any amount runs once, then follows its expression from now: missed runs aren't made up.
- **In the console**, a function's Schedules tab lists its schedules, with when each runs next and how its last run went, in your time and in UTC, and the last run's request ID. It makes one, showing the next five runs as you type the expression, or what is wrong in it, with a few examples to start from; it changes one, disables and enables it, and deletes it. Every member sees them; owners and developers change them.
- **The rest.** `GET /functions/<id>/schedules` lists them with their next run; `PUT …/schedules/<scheduleId>` changes what you send (`"enabled": false` stops the runs, `true` starts them again from now); `DELETE` removes one, and deleting the function removes them all. Names are unique within a function: letters, digits, `.`, `-` and `_`, as EventBridge rules'. The plan limits how many an account has (20 on the beta plan). Only functions with AWS Lambda's event can have schedules.

**Call a function without waiting.** As AWS Lambda's asynchronous invoke: the invocation type `Event`, in the header `X-Amz-Invocation-Type` or as `invocationType` in the body, keeps the call and answers at once, 202, with its request ID, the answer's `x-ff-request-id` too; FF runs it within seconds:

```bash
curl -s -X POST "$FF/functions/$ID/invoke" -H 'content-type: application/json' -H 'X-Amz-Invocation-Type: Event' \
  -d '{"input": {"name": "Tunis"}}' -w ' %{http_code}\n'
# {"requestId":"5f0c2b9e-…"} 202
curl -s "$FF/functions/$ID/invocations?limit=3" | jq -c '.invocations[] | {requestId, attempt, source, status}'
# {"requestId":"5f0c2b9e-…","attempt":1,"source":"async","status":"COMPLETED"}
```

- **Retried as Lambda retries it.** A failure of the function (it threw, timed out, or couldn't load) is retried a minute after, and a second one two minutes after; after the third attempt the call is dropped, which the backend's log says. A call that found no free instance, or that FF couldn't make (the function not `ACTIVE`, the account suspended or out of credit), is tried again after 1, 2, 4… seconds, up to five minutes apart, until it is six hours old. Each attempt is a call of its own in the history, its `source` `async` and its `attempt`, under the request ID, which its log lines name; each has its usage record, and is billed as any call. The waiting isn't.
- **At least once.** The call waits in FF's database until it ends ([ADR 0010](adr/0010-queue.md)). Two backends never run an attempt at once; one stopped during an attempt leaves the call to come back when its lease ends (twice the function's timeout, the cold start's limit and a minute), and that attempt counts as failed. A function may so see a call twice: as on Lambda, it should do its work once per request ID (`context.awsRequestId`).
- **Limits.** The event is at most 1 MB as JSON, Lambda's limit for asynchronous calls (413 past it). The calls waiting count against the plan's room for messages (100 MB on the beta plan, its queues' messages with them): past it, 429 until some have run. The plan's invocations per second count each call when it comes, not its attempts.
- **`DryRun`** only checks that the call could be made, the function and the input's size, and answers 204: nothing runs.
- **A function's own settings**, as Lambda's `EventInvokeConfig`: its retries (0 to 2), how long a call is kept (60 s to 6 hours), and destinations, another function of the account by its ARN or its name (kept as its ARN), which gets Lambda's record of each call as an asynchronous call of its own, or a queue of the account by its ARN (`arn:aws:sqs:tn-tunis-1:<account>:<queue>`, "Queues, as Amazon SQS", below), which gets it as a message's body, as Lambda sends one to SQS: `onSuccess` once a call succeeded, `onFailure` once its retries are used up or it is too old. The record is Lambda's: `requestContext` (the request ID, the function's ARN, the `condition`, `Success`, `RetriesExhausted` or `EventAgeExceeded`, and how many attempts were made), `requestPayload`, the event, and the last attempt's `responseContext` and `responsePayload`, the function's answer or its error. A call that aged out before any attempt ran has no response in it. A `PUT` replaces the settings whole, what it leaves out back to Lambda's default; `GET` answers 404 for a function without any, and `DELETE` removes them. A destination must be there when it is set; one deleted since gets nothing, which the backend's log says. A queue as a destination comes with queues. In the console, the Invocations tab's "Calls that don't wait" panel shows them and changes them, or goes back to Lambda's defaults; with `ff`, `ff async-config <name>` shows them, `--retries`, `--max-age 30m`, `--on-success` and `--on-failure` (a function's name), and `--no-on-success` or `--no-on-failure`, change what they name and keep the rest, and `--reset` goes back to Lambda's defaults.

  ```bash
  curl -s -X PUT "$FF/functions/$ID/event-invoke-config" -H 'content-type: application/json' \
    -d "{\"maximumRetryAttempts\": 0, \"destinationConfig\": {\"onFailure\": {\"destination\": \"arn:aws:lambda:tn-tunis-1:$ACCOUNT:function:failed-orders\"}}}" | jq -c
  ```
- **The worker:** as soon as a call is kept, PostgreSQL tells every backend (`NOTIFY`), and each claims the calls due, at most ten running at once (`FF_ASYNC_CONCURRENCY`); every 5 s too (`FF_ASYNC_INTERVAL_SECONDS`; 0 for a backend that runs none), for the retries come due and the calls a stopped backend left. A record that can't go to its destination (gone since, over what it takes, or the account's messages at the plan's limit) is said in the server log, and its call ends all the same.
- **In the console**, a function's Invocations tab invokes without waiting when "Don't wait for the answer" is ticked: it says the call's request ID, and its attempts join the history, each "asynchronously, attempt n", linked to its request's log lines. **With `ff`**, `ff invoke <name> --async` prints the request ID at once (`--raw`: the ID alone), `ff history <name>` lists the attempts, and `--dry-run` only checks.

**Update.** Edit `examples/hello.ts` and send the new code, or change settings. A change of code, runtime, handler, memory, or timeout rolls out a new version. The call returns once the new version is live (a few seconds), and the old one keeps serving until then. The new version is always checked on a running instance, even when the function was scaled to zero. If it can't start, the call answers 400 with the reason, and the previous version is put back: the function keeps working, and nothing changes.

```bash
jq -n --rawfile code examples/hello.ts '{code: $code}' \
  | curl -s -X PUT "$FF/functions/$ID" -H 'content-type: application/json' -d @- | jq '{status, updatedAt}'
curl -s -X PUT "$FF/functions/$ID" -H 'content-type: application/json' -d '{"memory": 256, "timeout": 10}' | jq '{memory, timeout}'
```

**Delete.** This removes the function's pods, Service, and code everywhere. To look inside the cluster first (section 4), keep the functions until then:

```bash
for f in "$ID" "$PY" "$SLOW"; do curl -s -o /dev/null -w "%{http_code}\n" -X DELETE "$FF/functions/$f"; done
```

**Functions made before 2026-10-21** get FF's original event: the input in `event.body`, inside the request FF sent them (`{ body, headers, method, query, path }`). Each keeps it until its owner moves it, with an update that changes its handler to read `event` and sets `"eventFormat": "lambda"` together; the console's edit form offers the choice on such a function's page. Only functions with AWS Lambda's event can have a web address or a schedule ([ADR 0007](adr/0007-function-events.md)). A function's `eventFormat` says which it has, and `"eventFormat": "wrapped"` on a create makes a new one the old way, for code not moved yet.

**What a function can be, today:**
- one file, inline (`function.ts` for Node.js, `function.py` for Python), up to 3 MiB of code (3,145,728 bytes of UTF-8), as AWS Lambda's console takes in its editor; more answers 400, saying how many bytes it has, and comes as a package;
- or a package with its libraries, a zip as AWS Lambda takes one: 50 MB, 250 MB and 20,000 files unpacked (below);
- with an input of up to 6 MB as JSON, as AWS Lambda's synchronous calls take, and a request to its URL up to 6 MB; a larger input answers 413 `RequestEntityTooLargeException`, in Lambda's words. A request's body may have 7 MB for a function's create, update and invoke, 100 KB elsewhere, and a larger one answers 413, saying which limit;
- within the account's plan: on the beta plan, 25 functions, each with 128–1024 MB of memory and a timeout of 1–300 s;
- with environment variables and secrets, 4 KB at most together, as on Lambda (above);
- up to 3 instances by default, and at most the plan's `instancesPerFunction` (10 on the beta plan) with `maxInstances`; `minInstances` from 0 up to the same limit keeps instances running when idle.

A request beyond the plan gets 400 with the plan's limit, for example `memory must be at most 1024 MB on the Beta plan`. "Plans and limits" in section 5 lists them all.

The handler is AWS Lambda's `handler(event, context)`, and the [Node.js](../runtimes/nodejs/README.md) and [Python](../runtimes/python/README.md) runtime READMEs describe `event`, `context`, and the error names. The code must define it: `exports.handler = async (event, context) => { … }` in Node.js, `def handler(event, context):` in Python. Code without one, such as a lone `console.log('hi');`, fails to load with `Runtime.HandlerNotFound: function.handler is undefined or not exported`.

**Another name for it.** A function's `handler` says which one its runtime calls, as AWS Lambda's handler does: `function.handler` unless you name another on a create or an update, such as `"handler": "function.lambda_handler"` for Python code written for Lambda. The code you send is the file `function` (`function.ts` or `function.py`), so its handler is `function.<name>`; another file, `lambda_function.lambda_handler` for example, answers 400. A function also says how its code came, `packageType` (`inline`: the one file you send), and gives its code's SHA-256 in base64 and its size in bytes, `codeSha256` and `codeSize`, in the form of Lambda's `CodeSha256` and `CodeSize`, which describe a package: for code sent inline, they are its text's.

**Functions with dependencies.** A real function needs libraries: a database driver, an SDK. It comes as a package, a zip as AWS Lambda takes one: the handler's file, in a folder if need be, and its libraries, `node_modules/` beside it for Node.js, the packages at its root for Python (`pip install -t`). `ff deploy <folder>` makes it from the function's folder, its libraries installed, and deploys it, once `ff` is set up ("With the `ff` command", below):

```bash
mkdir -p orders/lib && cd orders
echo '{ "name": "orders", "private": true, "dependencies": { "ms": "2.1.3" } }' > package.json
echo 'module.exports = (name) => `Hello ${name}`;' > lib/greet.js
cat > index.js <<'EOF'
const ms = require('ms');
const greet = require('./lib/greet');
exports.handler = async (event) => ({ message: greet(event.name ?? 'world'), in: ms(event.ms ?? 90000) });
EOF
ff deploy .                       # npm installs ms in a copy of the folder; "created orders (nodejs, 128 MB, 5 s): ACTIVE …"
ff invoke orders --data '{"name": "Tunis"}'    # {"message": "Hello Tunis", "in": "2m"}
ff deploy .                       # "orders: no changes": the same files make the same zip, the same SHA-256
cd .. && mkdir report && cd report
echo 'requests==2.32.5' > requirements.txt     # or pyproject.toml's [project] dependencies
printf 'import requests\n\n\ndef lambda_handler(event, context):\n    return {"requests": requests.__version__}\n' > lambda_function.py
ff deploy .                       # pip's wheels for the runtime; the handler is AWS Lambda's default
```

- **The handler** is `--handler` if you name one (`--handler src/handlers/orders.create`), else the function's while the package has its file, else `function.handler` where ff's own `function.*` is, then AWS Lambda's defaults, `index.handler` for Node.js and `lambda_function.lambda_handler` for Python. The Node.js runtime loads `.js`, `.mjs` (an ES module), `.cjs` or `.ts`, and a `.js` as an ES module where its `package.json` says `"type": "module"`, as Lambda's does.
- **ff builds in a copy of the folder,** never in it: `npm ci` (`npm install` without a lockfile), the `build` script if there is one, then `npm prune --omit=dev`; for Python, pip's wheels for the runtimes' platform, Linux x86_64 with glibc 2.28 or older and CPython 3.13, whatever your machine is. npm 11.19 doesn't run the install scripts of dependencies that `package.json`'s `allowScripts` doesn't allow, and ff says which it skipped: `npm install-scripts approve <package>` in the folder allows one.
- **Native libraries** (bcrypt, numpy) need the runtimes' platform: Linux x86_64 with glibc 2.41, Debian 13's, for both runtimes. Built as AWS Lambda's builds are, they load: npm's prebuilt `linux-x64-glibc` binaries, pip's manylinux wheels. npm installs your machine's binaries, the right ones on Linux x86_64; elsewhere, or for a Python library published as source alone, `--container` builds in the runtime's base image, in Docker.
- **Left out of the package:** version control, `__pycache__`, `.env` files, which usually hold secrets (ff says so: `ff secrets set` gives a function its secrets), and what a `.ffignore` names, in `.gitignore`'s syntax without `!`. `--no-build` packages the folder as it is, its `node_modules` included.
- **For AWS Lambda too:** `ff package` writes the same zip to the folder's `.ff/<name>.zip` and prints its SHA-256, Lambda's `CodeSha256`; `aws lambda create-function --zip-file fileb://.ff/orders.zip --handler index.handler --runtime nodejs24.x …` takes it. FF runs `.ts` files as they are, Lambda doesn't: `ff package --compile` runs the project's own `tsc` and leaves the TypeScript out. [`cli/README.md`](../cli/README.md#packages) has the details.

**Packages through the API.** Upload the zip, then name it by the SHA-256 the upload answers, in place of `code`, with the handler it holds; `ff deploy` does the same:

```bash
mkdir -p greet/lib && cd greet
printf 'exports.handler = async (event) => require("./lib/greet")(event.name ?? "world");\n' > index.js
printf 'module.exports = (name) => "Hello " + name;\n' > lib/greet.js
python3 -c 'import shutil; shutil.make_archive("../greet", "zip", ".")' && cd ..
SHA=$(curl -s -X POST "$FF/packages" -H 'content-type: application/zip' --data-binary @greet.zip | jq -r .codeSha256)
jq -n --arg sha "$SHA" '{name: "greet", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 5}' \
  | curl -s -X POST "$FF/functions" -H 'content-type: application/json' -d @- | jq '{status, packageType, codeSha256, codeSize}'
```

- **The upload** is checked entry by entry: a name that leaves the zip, a link, an encrypted file, a size or a checksum that lies are refused, saying which entry. The answer is 201 for a new package, 200 for one the account has already, which is stored once; `GET /packages?codeSha256=<SHA, URL-encoded>` says whether to upload at all.
- **The handler** names a file of the package, which the create or update looks for: one the package lacks answers 400, saying which file.
- **An update** names another package, with the settings that change, in one rollout; `code` makes the function inline again. A package that no function names is deleted an hour after its upload or its last use; an account keeps 20 unused at most.
- **It runs as an image:** FF makes one from the package, once, pushes it to the cluster's registry, and the function's pods mount it at `/var/task` on their runtime's image, read-only ([ADR 0003](adr/0003-code-delivery.md)). Inline code takes the same path: FF makes a one-file package of it, the same bytes for the same code, which `GET /packages` doesn't list, and which goes an hour after no function names it. In development the registry runs next to the cluster (`hack/k8s/registry-up.sh`, which `cluster-up.sh` runs), and `BE/.env` names it, as `BE/.env.example` does: `FF_CODE_REGISTRY=http://127.0.0.1:5056` and `FF_CODE_REGISTRY_PULL=ff-dev-registry:5000`. Without them, every create and update answers 503. In production it is Zot, in the platform's manifests (`deploy/k8s/README.md`, "The code registry").

**If a function cannot load** (a syntax error, a missing handler, an exception at import), the create call answers 400 as soon as the runtime has said why, in about 10 s: the runtime logs it at start, and the backend reads it in the log store, which has it about 5 s later. Without the log pipeline (`--no-logging`), the backend can't read it, and waits for the readiness timeout instead (90 s, `FF_READY_TIMEOUT_SECONDS` in `BE/.env`). The answer gives the runtime's reason, for example `The function failed to load: Runtime.UserCodeSyntaxError: SyntaxError: function.ts:2:11 Property assignment expected.`, and `functionId`: the function is saved all the same, listed with status `ERROR` and that reason, and its pod is released. Creating it again would only answer 409, since the name is taken: the console opens the saved function's page instead of keeping its form. **Fix it with an update:** send the corrected code (`PUT /functions/<id>`), and the function becomes `ACTIVE`, keeping its ID. An update of an `ERROR` function always rolls out, even without changes, so `PUT` with `{}` retries the same code after a passing failure such as a full quota. Without the log pipeline, a lower timeout such as 30 gives faster feedback.

**With the `ff` command.** Everything above has its command in `ff`, FF's command-line tool ([`cli/`](../cli/README.md), [ADR 0002](adr/0002-cli.md)): one Rust binary that talks to the API only. Build it once, point it at the backend, and say whom it acts as: in development mode, the account the backend acts as stands in for a token.

```bash
(cd cli && cargo build --release --locked) && export PATH="$PWD/cli/target/release:$PATH"
ff config set endpoint "$FF"
ff config set dev_account "$(curl -s "$FF/me" | jq -r '.accounts[0].id')"   # development mode only
ff whoami                                         # Development mode, as the owner of account …
ff deploy examples/hello.ts                       # creates "hello", or updates it with what changed
ff invoke hello --data '{"name": "Tunis"}'        # the answer, then its request ID, duration and memory
ff invoke hello --async --data '{"name": "Later"}' # kept and run without waiting: its request ID at once
ff logs hello --follow                            # its log lines as they come; Ctrl-C stops
ff deploy examples/hello.py --name hello-py --memory 256
ff history hello                                  # its calls, newest first, by request ID, an asynchronous call's attempts numbered
ff scale hello --min 1 --max 5
ff list
ff delete hello --yes
ff local invoke examples/hello.py --data '{"name": "here"}'   # on this machine, in Docker, as FF runs it
ff init orders --runtime python                   # a new function's folder: its handler and an event
ff deploy ./orders                                # a folder: packaged with its libraries, uploaded when new
ff package ./orders                               # the same zip, for AWS Lambda too: ./orders/.ff/orders.zip
ff account                                        # its plan's limits, and whether functions reach the internet
ff usage                                          # this month's calls per function, and their estimated cost
ff metrics hello --since 6h                       # its invocations, errors, durations, a row a minute
```

On an FF with logins, an owner of the account makes an API key in the console's API keys page, with the scopes the commands need (`functions:read`, `functions:write`, `functions:invoke`, `logs:read`; `usage:read` for `ff usage` and `ff balance`, `metrics:read` for `ff metrics`), and `ff config set-token` saves it without showing it; `ff config set endpoint https://api.<domain>` names the API. A script reads `--output json`, and the exit codes: 4 a deploy that never became ready, 5 a call that failed, 6 the account refusing (credit, scopes, the plan's rate). [`cli/README.md`](../cli/README.md) has every command, setting and code; `hack/build-cli.sh` makes the static Linux binary, with its SHA-256.

### A database

An account's functions keep their data in PostgreSQL databases that FF gives, as AWS RDS gives instances ([ADR 0008](adr/0008-customer-databases.md)): PostgreSQL 18, on a server of customers' databases apart from FF's own, a database and its user each, both named `ff_` and 24 random hexadecimal characters, which say nothing of whose it is; your name for it is the account's. TLS only. The plan sets how many, their storage and their sessions: one database on beta, 1,024 MB, 10 sessions at once. In development, setup's step 10 starts the server.

```bash
ff db create orders --secret-for orders-api              # the console's Databases page does the same
# orders made: its connection string, shown this once (FF keeps no copy; `ff db password orders` makes a new one):
# postgresql://ff_3f9c2a1e8b7d4c6a9e5f1a2b:Xq3v…@10.199.0.10:5432/ff_3f9c2a1e8b7d4c6a9e5f1a2b?sslmode=require
# DATABASE_URL set on orders-api
curl -s -X POST "$FF/databases" -H 'content-type: application/json' -d '{"name": "shop"}' | jq -r .connectionString
```

**Its password** is 32 random bytes, in that answer only: FF keeps no copy, and the server got only its SCRAM verifier, so the password is in no log. `ff db password orders` (`POST /databases/<id>/password`) makes a new one, shown once too; the old one opens no new session, those under way keep theirs. `--secret-for` sets the string as a secret of the functions named, `DATABASE_URL` unless `--secret-name` says otherwise, as an app written for Lambda and RDS reads its own.

**Functions reach it whatever their account's internet access:** each account's network policy opens the server, on its port only. node-postgres reads `sslmode=require` as a full check of the certificate: in production the server's comes from a public CA; in development FF gives functions' pods the server's own CA, in `NODE_EXTRA_CA_CERTS`. From your machine, `psql "<the string>"` encrypts and doesn't check the certificate, as libpq reads `require`; add `&sslmode=verify-full&sslrootcert=hack/.data-db/ca.crt` to check it in development.

**What it is now:** `ff db list` and `ff db get orders` (`GET /databases`, `GET /databases/<id>`): its status (`active`; `read_only` past the plan's storage, below; `suspended` with its account), its size and sessions as the server counts them, the plan's limits. Every hour the backend measures it, and its storage is billed by the GB-month, as RDS bills it, 1 GB-month free each month: section 5, "Customers' databases, measured every hour" and "Prices". `GET /databases/<id>/metrics` gives its `DatabaseConnections` and `VolumeBytesUsed` an hour a point, which alarms watch.

**Deleting it** (`ff db delete orders`, `DELETE /databases/<id>`) ends its sessions and drops it and its user, with its data. A suspended account's users can't log in until it is active again; a closed account's databases go at its data deletion date, with the rest of its data. Every member reads the account's databases; owners and developers make, change and delete them; an API key needs `databases:read` and `databases:write`. The audit log names each `database.create`, `database.password` and `database.delete`.

**Backups and the way out:** the server is backed up as FF's own is, to a second site, 7 days of point-in-time recovery. An owner asks FF for a database as it was at a moment of those 7 days, from the e-mail address FF knows them by; it comes back as a new database of the account's, as RDS restores to a new instance, by the runbook in [`deploy/backup`](../deploy/backup/README.md), which the monthly drill runs. To move a database to AWS RDS, `pg_dump` and `pg_restore`, the writes stopped for the copy: [`cli/templates/export/data/postgres.md`](../cli/templates/export/data/postgres.md), which `ff export` will put in its kit. Logical replication, which moves one without stopping them, needs what the server doesn't give customers today: a user with `REPLICATION`, and `wal_level` at `logical`. In French: [Bases de données](fr/bases-de-donnees.md).

### Files in buckets

Buckets for files come as AWS S3 gives them ([ADR 0009](adr/0009-buckets.md)): AWS's SDKs and CLI work with only their endpoint changed. The backend answers their requests on a port of its own, `FF_STORAGE_PORT` (3002), at `FF_STORAGE_BASE` (`http://s3.localhost:3002`): path-style there (`http://s3.localhost:3002/photos/a.jpg`, as boto3 and the CLI address it, and every SDK an IP address), and virtual-hosted under it (`http://photos.s3.localhost:3002/a.jpg`, as the SDK for JavaScript addresses a host name). In front of the store, SeaweedFS in development (`FF_OBJECT_STORE_*`), it:
- checks each request's AWS Signature Version 4, in its `Authorization` header or as a presigned URL (up to 7 days), with one of the account's access keys; nothing anonymous;
- lets a key into its own account's buckets only, those it names if it names some, and writes only with a read-write key: AWS's errors otherwise (`SignatureDoesNotMatch`, `InvalidAccessKeyId`, `AccessDenied`, `NoSuchBucket`), in S3's XML;
- serves `PutObject`, `GetObject` with ranges, `HeadObject`, `DeleteObject`, `DeleteObjects`, `CopyObject`, `ListObjectsV2` and `ListObjects`, the multipart upload's steps, `HeadBucket`, `GetBucketLocation` (`tn-tunis-1`) and `ListBuckets`; anything else answers `NotImplemented`;
- checks a body as it streams to the store: its signed SHA-256, each chunk of the SDKs' `aws-chunked` uploads and its trailer, the checksum it carries (CRC-32, CRC-32C, CRC-64/NVME, SHA-1, SHA-256); a body that fails never completes in the store, which gets FF's own signature, the bucket's name there (`ff-` and 24 characters), and no checksum;
- counts each request let into a bucket in its minute, by AWS's two classes of request (deletes free), with its bytes in and out, written once a minute to `storage_request_counts`.

Buckets and the account's access keys to them are made on the console's Buckets page, which lists each bucket with what it held at its last measure and warns when the account's buckets near or reach the plan's storage; a bucket's own page has its addresses, the AWS CLI's command for it, its last hours (what it held, its requests and those that failed) and its alarms; the Usage page has each bucket's month. Or through FF's API:

```bash
curl -s -X POST "$FF/buckets" -H 'content-type: application/json' -d '{"name": "photos"}'   # 201, its endpoint and address
curl -s -X POST "$FF/storage-keys" -H 'content-type: application/json' -d '{}' | jq -r '"export AWS_ACCESS_KEY_ID=\(.id) AWS_SECRET_ACCESS_KEY=\(.secretAccessKey) AWS_REGION=\(.region)"'
# then, with those three, any of AWS's tools, only the endpoint given:
aws --endpoint-url http://s3.localhost:3002 s3 cp ./cat.jpg s3://photos/2026/cat.jpg
aws --endpoint-url http://s3.localhost:3002 s3 ls s3://photos --recursive
```

Or with `ff`, whose key's secret comes as the four variables AWS's tools read, `AWS_ENDPOINT_URL_S3` among them, so that the CLI needs no `--endpoint-url`:

```bash
ff buckets create photos
eval "$(ff buckets keys create --bucket photos | grep '^export ')"
aws s3 cp ./cat.jpg s3://photos/2026/cat.jpg
ff buckets get photos          # what it held at its last hourly measure
ff usage                       # its month: GB-months, its requests by S3's two classes, what it sent out
```

`GET /buckets` and `GET /buckets/<name>` give each bucket's last measure too (`sizeBytes`, `objects`, `measuredAt`), and `GET /me` how full the account's buckets are together (`bucketStorageNotice`: 80, 100, or null under 80%).

**A bucket's name** is AWS's, without dots (3 to 63 lower-case letters, digits and hyphens), and unique across FF, as on AWS: whoever has `photos`, nobody else may, until it is deleted. In the store it is a name of FF's, `ff-` and 24 characters, which says nothing of whose it is. The plan sets how many an account has (five on beta), what they hold together (5 GB), the requests a second (100) and the largest file in one `PutObject` (5 GB; a multipart upload sends more). `GET /buckets` and `GET /buckets/<name>` show them; `DELETE /buckets/<name>` deletes an empty one, as S3 does, and `?force=true` deletes its files first, and the uploads under way.

**An access key** (`POST /storage-keys`) is an ID like AWS's, `AKFF` and 16 characters, and a secret of 40, in that answer only: FF keeps it sealed, as the front door needs it to check signatures. It reaches all the account's buckets and queues, or those `buckets` and `queues` name ("Queues, as Amazon SQS", below), read-write or, with `readOnly`, reading and listing only. An account has two at most, as IAM gives a user, so that one can replace the other; `DELETE /storage-keys/<id>` revokes one, at once. Only owners see, make and revoke them; owners and developers make and delete buckets; every member lists them. An API key needs `storage:read` and `storage:write`. The audit log names each `bucket.create`, `bucket.delete`, `storage_key.create` and `storage_key.delete`.

**Every request is checked the same way:** the key's account must be active and its storage on, or the front door answers `AccountProblem`, saying why; past the plan's requests a second, `SlowDown`; out of credit, uploads wait for credit, while reading and deleting go on. A closed account's buckets are emptied and deleted with the rest of its data, at its data deletion date, and its keys revoked.

**Measured every hour, billed as S3 Standard bills them:** each bucket's listing is measured once an hour, its objects' sizes summed and counted (`bucket_samples`), and each hour of it is rated from that and from its requests by S3's two classes, PUT, COPY, POST and LIST, then GET and the others, deletes free. The price book has S3 Standard's prices in TND, and each month's free tier, as AWS gives it the first year: 5 GB-months, 2,000 requests of the first class and 20,000 of the second. `GET /usage` lists each bucket's month (its GB-months, what it held last, each class's requests, its estimated cost, and the bytes its requests sent out and brought in, `bytesDownloaded` and `bytesUploaded`, counted, not billed, as [decision 12](decisions.md) has it), its CSV a line each, and the month's statement a table of them; the console's Usage page and `ff usage` show what each sent out. The plan's storage, 5 GB on beta, counts the account's buckets together: its owners are told at 80% and at 100%, and from 100% uploads answer `AccountProblem`, saying why, until the buckets hold less; reading and deleting go on, and once files are deleted, uploads go in again within a minute.

**Metrics and alarms, as CloudWatch has S3's:** `GET /buckets/<name>/metrics?period=60|300|3600` gives `BucketSizeBytes` and `NumberOfObjects` (their `Average`: each period of an hour carries that hour's measure, `null` in an hour not measured) and the requests, each period's `Sum`: `AllRequests`, `GetRequests`, `PutRequests`, `4xxErrors`, `5xxErrors`, `BytesDownloaded` and `BytesUploaded`, from the front door's counts by the minute. An alarm watches any of them with `bucketName` (`POST /alarms`), as CloudWatch's alarms on S3 name a `BucketName`, and goes with its bucket. The admin app's account page lists the account's buckets, their names in the store, what each held at its last measure, and how full they are together.

**A function reaches its account's buckets with no setting at all,** as on AWS Lambda with a role: `new S3Client({})` and `boto3.client("s3")` work as they are. Its pods get a key of its own in their environment, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_REGION`, `AWS_DEFAULT_REGION` and `AWS_ENDPOINT_URL_S3`, the front door's address inside the cluster: an IP address, where AWS's SDKs go path-style by themselves. The key is made at the function's first deploy (an older function gets its own the next time an update rolls it out), reaches every bucket of the account, read-write, is checked as any key is, and is revoked when the function is deleted; it is neither listed with the account's two keys nor counted against them. FF sets these names, so a function's variables can't, `AWS_ENDPOINT_URL_S3` included. The SDK isn't in the runtimes' images: name `@aws-sdk/client-s3`, or `boto3`, in the function's package ([Node.js](../runtimes/nodejs/README.md#buckets-with-awss-sdk), [Python](../runtimes/python/README.md#buckets-with-boto3)). The backend gives functions keys only when it knows where they reach the front door: `FF_STORAGE_FUNCTION_ENDPOINT`, and `FF_STORAGE_FUNCTION_CIDRS`, the addresses their NetworkPolicy opens on its port. With the development cluster, this machine as its pods see it, the gateway of its Docker network (`BE/.env.example` says how to find it):

```bash
FF_STORAGE_FUNCTION_ENDPOINT=http://172.18.0.1:3002
FF_STORAGE_FUNCTION_CIDRS=172.18.0.1/32
```

In production the backend runs in the cluster, and functions reach its pods through the Service `ff-storage`, at a fixed address, `10.43.0.251` ([deploy/k8s/README.md](../deploy/k8s/README.md), "Buckets from functions").

**Backups and the way out:** no bucket is copied to the second site ([decision 11](decisions.md)). The store's own redundancy keeps the files through a failed disk, as S3's does, but not through a file deleted or replaced by mistake, since FF keeps no versions of them, nor through the loss of the store. Keep your own copy of the files that matter: `aws s3 sync s3://photos ./photos`, with one of the account's keys in the environment, which is what the first half of [`cli/templates/export/data/s3-sync.sh`](../cli/templates/export/data/s3-sync.sh) does. To move a bucket to AWS S3, the same script then copies that folder to a bucket on S3 with the AWS CLI's own settings, FF's variables dropped first; run again, it copies only what changed, and `--delete-gone` deletes what FF no longer has. `ff export` will put it in its kit. Then point the code at S3 (on AWS Lambda, a role and no endpoint) and delete the bucket on FF. In French: [Fichiers dans des compartiments](fr/compartiments.md).

```bash
eval "$(ff buckets keys create --read-only | grep '^export ')"
cli/templates/export/data/s3-sync.sh photos my-photos-on-s3     # my-photos-on-s3 made on S3 first
```

### Queues, as Amazon SQS

Queues come as Amazon SQS gives its standard queues ([ADR 0010](adr/0010-queue.md)): AWS's SDKs and CLI work with only their endpoint changed. The backend answers their requests on a port of its own, `FF_SQS_PORT` (3003), at `FF_SQS_BASE` (`http://localhost:3003`). A queue's URL is `<FF_SQS_BASE>/<account>/<queue>`, and its ARN `arn:aws:sqs:tn-tunis-1:<account>:<queue>`. The endpoint:
- speaks SQS's JSON protocol, as AWS's current SDKs and CLI do, each request signed with AWS Signature Version 4 for the service `sqs` by one of the account's access keys, the same keys as buckets' ("An access key", above): a read-write key does everything, a read-only one lists queues, reads their attributes and receives;
- serves `CreateQueue`, `GetQueueUrl`, `ListQueues`, `GetQueueAttributes`, `SetQueueAttributes`, `DeleteQueue`, `PurgeQueue`, `SendMessage` and `SendMessageBatch`, `ReceiveMessage` with long polling, `DeleteMessage` and `DeleteMessageBatch`, `ChangeMessageVisibility` and `ChangeMessageVisibilityBatch`; anything else answers `UnsupportedOperation`, and FIFO queues, tags, access policies and KMS keys are refused, saying why;
- takes SQS's attributes, with SQS's defaults and ranges: `VisibilityTimeout` (30 s, up to 12 hours), `MessageRetentionPeriod` (4 days, from a minute to 14 days), `DelaySeconds` (up to 15 minutes), `ReceiveMessageWaitTimeSeconds` (up to 20 s), `MaximumMessageSize` (1 MiB at most), and a `RedrivePolicy`: another queue of the account, the dead-letter queue, takes a message once it has been received `maxReceiveCount` times;
- answers SQS's errors (`QueueDoesNotExist`, `InvalidParameterValue`, `AccessDenied`, `OverLimit`, …) by both their names, the body's `__type` and the `x-amzn-query-error` header, and gives the MD5 sums of each message's body and attributes that AWS's SDKs check.

With one of the account's keys in the environment (as above), and only the endpoint given:

```bash
export AWS_ENDPOINT_URL_SQS=http://localhost:3003
aws sqs create-queue --queue-name orders                  # its URL: http://localhost:3003/<account>/orders
queue="$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text)"
aws sqs send-message --queue-url "$queue" --message-body '{"item": "harissa", "quantity": 2}'
aws sqs receive-message --queue-url "$queue" --wait-time-seconds 10   # then delete-message with its ReceiptHandle
```

**In FF's API too,** beside the endpoint, the same queues the same way, as SQS's own operations run there: `GET /queues` lists the account's, each with its URL, ARN, attributes and messages counted (`available`, `inFlight`, `delayed`); `POST /queues` makes one (`{"name": "orders", "visibilityTimeout": 60}`, SQS's attributes by their names; a name the account has, 409); `GET`, `PATCH` (what is given changes; `"redrivePolicy": null` removes it) and `DELETE /queues/<name>`; `POST /queues/<name>/purge`. To debug a queue, `POST /queues/<name>/messages` sends a message (`{"body": "…", "attributes": {"item": {"dataType": "String", "stringValue": "harissa"}}}`), `POST /queues/<name>/receive` receives up to ten (`maxMessages`, `visibilityTimeout`, `waitTimeSeconds`), each hidden and counted as any receive, and `DELETE /queues/<name>/messages/<receiptHandle>` deletes one. Every member lists them; owners and developers change them; an API key needs `queues:read` and `queues:write`. The audit log names each `queue.create`, `queue.update`, `queue.purge` and `queue.delete`, whichever way it came, an SDK's under its access key.

**In the console,** the Queues page lists the account's queues, each with its messages (waiting, in flight, delayed) and what they hold, and makes one; a queue's page has its URL, ARN and endpoint, the AWS CLI's commands for it, its attributes, which owners and developers change there, a dead-letter queue among them, and, to debug it, sending a message, receiving up to ten (each received as by any receive: hidden for the visibility timeout, its receive counted) and deleting those received, a purge and the queue's deletion. The access keys, on the Queues page as on the Buckets page, reach every bucket and queue, or one of them alone, and a key just made comes with its five variables, `AWS_ENDPOINT_URL_SQS` among them. A function's "Calls that don't wait" offer the account's queues as destinations.

**With `ff`,** `ff queues create orders` makes one, with SQS's attributes as flags (`--visibility-timeout 1m`, `--retention 4d`, `--delay 5s`, `--receive-wait 20s`, `--max-message-size 262144`), each duration checked against SQS's range before any call, and a dead-letter queue by its name (`--dead-letter-queue orders-dlq --max-receive-count 3`); `ff queues list` and `ff queues get orders` give the messages, the URL, ARN and endpoint, and the attributes in words; `ff queues set orders …` changes those given, `--no-dead-letter-queue` removing it. To debug a queue, `ff queues send orders '{"item": "harissa"}' [--attribute item=harissa] [--delay 30s]` (`-` reads the body from stdin, `@file` from a file), `ff queues receive orders [--max 10] [--wait 20s] [--delete]`, which prints each message's receipt handle, and `ff queues delete-message orders <receipt handle>`; `ff queues purge` and `ff queues delete` ask first, a script saying `--yes`. `ff buckets keys create --queue orders` makes a key for that queue alone, and prints its five variables.

**An access key may name the queues it reaches** (`POST /storage-keys` with `"queues": ["orders"]`), as it names buckets: a key that names neither reaches all the account's buckets and queues; one that names some reaches those alone, so that a key naming buckets alone reaches no queue, and one naming queues alone no bucket. A queue it doesn't name answers `AccessDenied`, and `ListQueues` lists the ones it names.

**At least once, as SQS's standard queues:** a message received is hidden for the visibility timeout, then comes back for another receive unless it was deleted with the receipt handle of its last receive (an older handle deletes nothing, without an error, as SQS's documentation says); two receives never hold one message at once. A long poll answers as soon as a message comes, PostgreSQL telling every backend of each message written to a queue; a message past its retention is deleted, received or not. The messages are in FF's own database, one table for every queue's ([ADR 0010](adr/0010-queue.md)), so its backups keep them.

**Every request is checked as buckets' are:** the key's account must be active and its databases, buckets and queues on, or `AccessDenied` says why; past the plan's queue requests a second (100 on beta), `RequestThrottled`; out of credit, sending waits for credit, while receiving and deleting go on. The plan sets how many queues an account has (10 on beta) and what their messages hold together (100 MB), its functions' calls that don't wait among them: past it, sending answers `OverLimit` until some are deleted.

**A function reaches its account's queues with no setting at all,** as on AWS Lambda with a role: `new SQSClient({})` and `boto3.client("sqs")` work as they are. With the function's own key ("A function reaches its account's buckets", above), its pods get `AWS_ENDPOINT_URL_SQS`, the endpoint's address inside the cluster, which a function's variables can't set. A queue's URL is answered under the endpoint its caller reached: in a function, `GetQueueUrl` by the queue's name gives one under that address. AWS's SDK for JavaScript sends a queue's requests to the host of the URL it is given, so a URL from outside (`http://localhost:3003/…`, `https://sqs.<domain>/…`) works in a function only with `new SQSClient({ useQueueUrlAsEndpoint: false })`; boto3 and the AWS CLI keep to their endpoint whatever the URL's host, FF reading a queue's URL by its path. The backend gives functions the endpoint when it knows where they reach it: `FF_SQS_FUNCTION_ENDPOINT`, and `FF_SQS_FUNCTION_CIDRS`, the addresses their NetworkPolicy opens on its port; with the development cluster, the same gateway as buckets':

```bash
FF_SQS_FUNCTION_ENDPOINT=http://172.18.0.1:3003
FF_SQS_FUNCTION_CIDRS=172.18.0.1/32
```

A function deployed before the endpoint was given gets it at its next update. In production, functions reach it through the Service `ff-storage` too, at `10.43.0.251:3003` ([deploy/k8s/README.md](../deploy/k8s/README.md), "Queues from functions"), and customers at `https://sqs.<domain>`, behind the edge.

### A function reading a queue, as Lambda's event source mappings

A function may read a queue of its account, as AWS Lambda's event source mapping for SQS: FF receives the queue's messages in batches and calls the function with SQS's event, `{"Records": [...]}`, each record as Lambda gives it (`messageId`, `receiptHandle`, `body`, `attributes` with `ApproximateReceiveCount`, `SentTimestamp`, `SenderId` and `ApproximateFirstReceiveTimestamp`, `messageAttributes`, `md5OfBody`, `eventSource: "aws:sqs"`, `eventSourceARN`, `awsRegion`). A handler written for Lambda reads it as it is.

```bash
curl -s -X POST "$FF/functions/$ID/event-sources" -H 'content-type: application/json' \
  -d '{"eventSourceArn": "arn:aws:sqs:tn-tunis-1:<account>:orders", "batchSize": 10, "maximumBatchingWindowInSeconds": 2, "functionResponseTypes": ["ReportBatchItemFailures"]}'
```

- **A batch:** up to `batchSize` messages (10 unless said, up to 10,000; over 10, a window is needed, as on Lambda), gathered for up to `maximumBatchingWindowInSeconds` (0 unless said, up to 300: with none, a call takes what one receive gives), and never more than an event of 6 MB, the limit of a call; a message that would pass it begins the next batch. A message comes as soon as it is written, PostgreSQL telling FF, as a long poll does.
- **A call that succeeds deletes its batch;** one that fails, times out or is throttled deletes nothing, and its messages come back after the queue's visibility timeout, each receive counted, so that the queue's dead-letter queue takes a message received `maxReceiveCount` times, as SQS's redrive policy says. With `functionResponseTypes: ["ReportBatchItemFailures"]`, the answer `{"batchItemFailures": [{"itemIdentifier": "<messageId>"}]}` keeps those messages alone and deletes the others; an answer that isn't one (not an object, an ID that isn't the batch's) keeps the whole batch, as Lambda does. Without it, the answer is not read.
- **Batches at once:** `scalingConfig: {"maximumConcurrency": n}` (2 to 1,000), within the function's instances, each of which serves one call; without it, as many as the function's instances.
- **The rules Lambda has:** the queue's visibility timeout must be at least the function's timeout, or a message would come back during the call that has it (`Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds`); a function reads a queue once (409, naming the mapping that does); and a function reads as many queues as its plan allows (5 on beta).
- **Nothing is read** while the mapping is disabled (`"enabled": false`), the function isn't `ACTIVE`, or the account isn't active, has its databases, buckets and queues off, or has no credit: the messages wait, their receives not counted.

`GET /functions/<id>/event-sources` lists the queues a function reads; `GET /event-sources` the account's mappings, `?eventSourceArn=<queue ARN>` those reading one queue; `GET`, `PATCH` (what is given changes; `"scalingConfig": null` removes the maximum) and `DELETE /event-sources/<uuid>`. Deleting the function or the queue deletes its mappings. The names are Lambda's (`uuid`, `state`, `lastModified`…); every member reads them, owners and developers change them, an API key needs `functions:read` and `functions:write`, and the audit log names each `event_source.create`, `event_source.update` and `event_source.delete`. Each call is in the function's history, its source `sqs`, and billed as any call. Every backend reads every enabled mapping, loading them again every `FF_EVENT_SOURCE_REFRESH_SECONDS` (10) and at once when it changes one: with two backends, a mapping's batches may be twice as many at once.

### A small app, end to end

[`examples/orders-app`](../examples/orders-app/README.md) is a small app as one would write it for AWS Lambda: orders taken at a web address and kept in PostgreSQL, each order's receipt kept in a bucket, and a report each night, from a schedule. One package, with `pg`, the PostgreSQL driver, and `@aws-sdk/client-s3`, AWS's S3 client, makes its two functions. On FF it keeps its orders in one of FF's databases and its receipts in one of FF's buckets, as it would in RDS and S3 on AWS: its functions reach both with the account's internet access off, and its code names neither FF nor AWS, only `DATABASE_URL` and `RECEIPTS_BUCKET`. In development, functions get their own keys to buckets once the backend knows where they reach the front door (`FF_STORAGE_FUNCTION_ENDPOINT`, in "Files in buckets" above), and the customers' databases' server runs (setup's step 10).

**The two functions.** From the app's folder; the second has the same package, so nothing goes up again:

```bash
cd examples/orders-app
ff deploy . --name orders-api --handler index.http          # npm installs pg and the S3 client in a copy of the folder; the package goes up
ff deploy . --name orders-nightly --handler index.nightly   # "package: …, which the account had"
```

**Its database and its bucket.** `ff db create` makes the database and sets its connection string as both functions' `DATABASE_URL`, rolling each out; the bucket keeps the receipts, its name in a variable. Each function has a key of its own to the account's buckets, with the region and the front door's address, in its environment, so `new S3Client({})` needs nothing more, as on AWS Lambda with a role:

```bash
ff db create orders --secret-for orders-api --secret-for orders-nightly
ff buckets create shop-receipts                             # a name of yours: bucket names are unique across FF
ff env set orders-api RECEIPTS_BUCKET=shop-receipts
ff env set orders-nightly RECEIPTS_BUCKET=shop-receipts
```

**The web address.**

```bash
ff url enable orders-api --auth none                        # its address: http://<id>.fn.localhost:3001/
ff invoke orders-api --http POST /orders --data '{"item": "harissa", "quantity": 2}'
# HTTP 201, then {"id":1,"item":"harissa","quantity":2,"created_at":"…","receipt":"s3://shop-receipts/receipts/1.txt"}
ff invoke orders-api --http GET /orders                     # or curl http://<id>.fn.localhost:3001/orders
ff invoke orders-api --http GET /orders/1/receipt           # Order 1, 2 × harissa, and its time
```

Its handler, `index.http`, takes AWS Lambda's event for function URLs and answers with a response object. Each instance connects at its first call, with the string the secret gives it, makes the table if it isn't there, and keeps the connection for the calls after. The order is written first, then its receipt, `receipts/<id>.txt`: a receipt that can't be written leaves the order, with `"receipt": null` in the answer and a line in the log. With one of the account's keys, the AWS CLI reads it as well: `aws s3 cp s3://shop-receipts/receipts/1.txt -`.

**The nightly report.**

```bash
ff schedule set orders-nightly "cron(0 2 * * ? *)"          # every night at 02:00 UTC; it says the next runs
ff invoke orders-nightly --data @events/scheduled.json      # a night's run, now, with EventBridge's Scheduled Event
ff logs orders-nightly                                      # report {"day":"2026-10-21","orders":1,"items":2,"removed":0,"receipts":0}
```

The report counts the day before the event's `time`: set it to tomorrow's 02:00 in `events/scheduled.json` to count today's orders. Orders older than 90 days are removed, and their receipts with them, a `DeleteObjects` for each thousand; `receipts` counts the receipts asked to be deleted, as S3 counts a key already gone as deleted. At 02:00 UTC the scheduler calls the function with that event itself; the run is in `ff history orders-nightly`, and `ff schedule list orders-nightly` says how it went. `hack/cli-e2e.sh` runs this walkthrough end to end. Afterwards:

```bash
ff delete orders-nightly --yes && ff delete orders-api --yes
ff db delete orders --yes                                   # the database, with its data
ff buckets delete shop-receipts --force --yes               # the bucket, with its receipts
```

**A database of your own, elsewhere,** works as well, through the same secret, once the account's internet access is on. A function never reaches a private address, FF's own network included, so in development `hack/k8s/app-database.sh up` runs a PostgreSQL that the cluster's functions reach as they would one on the internet: on a Docker network of its own in 198.18.0.0/15, the range set aside for tests, which the cluster's node joins (Docker 28 or later). It prints the database's address. FF's operator turns the account's internet access on in the admin dashboard, on the account's page (`PUT /admin/accounts/<id>/egress`); in development mode, with no operator, the database stands in, and the next deploy applies it to the account's namespace:

```bash
DATABASE_URL=$(hack/k8s/app-database.sh up)                 # postgres://app:…@198.18.0.10:5432/app
docker compose exec -T postgres psql -U postgres -d serverless_platform \
  -c "UPDATE accounts SET internet_egress = true WHERE id = '$(curl -s "$FF/me" | jq -r '.accounts[0].id')'"
printf '%s\n' "$DATABASE_URL" | ff secrets set orders-api DATABASE_URL
hack/k8s/app-database.sh down                               # afterwards: the database, with its data
```

**In production** the database and the bucket are FF's, as here, or a database of yours on the internet, with TLS (`sslmode=require` in its address) and the account's internet access on. The same folder runs on AWS Lambda with an RDS database and an S3 bucket: `ff package` writes its zip, and the function's role gives the S3 client its credentials.

## 4. Look inside the cluster

```bash
source hack/k8s/env.sh                                   # kubectl from hack/bin, the dev cluster's kubeconfig
NS=ff-t-$(printf %s 000000000001 | sha256sum | cut -c1-12)   # the dev account's namespace (FF_DEV_ACCOUNT_ID)
kubectl -n "$NS" get deployments,pods,services
```

Each function is a Deployment and a Service named `fn-<id>`. Its code is an image in the cluster's registry, inline code's too, which its pods mount read-only at `/var/task`, and which `kubectl -n "$NS" get deployment fn-<id> -o jsonpath='{.spec.template.spec.volumes[?(@.name=="code")].image.reference}'` names: `ff-dev-registry:5000/ff-code/<account>@sha256:…`, the same image for the same code. A function deployed before 2026-10-21 keeps its code in an immutable ConfigMap `fn-<id>-<hash>` until its next update, which deletes it.

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

**Call a runtime directly**, without the backend, to see its raw response and headers. Here the request body *is* the event:

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

A key never does more than its creator's role allows, checked on every request: it stops when its creator leaves the account. An account has at most 20 keys; `expiresAt` (ISO 8601) makes one expire. Keys can't manage accounts or keys. Any key reads `GET /me`, whatever its scopes: itself (`key`: its ID, name and scopes) and the account it acts for, with its creator's role, which is how a script, or `ff whoami`, checks the key it was given.

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

**Usage records.** Every invocation leaves one row in `usage_records` when it ends, written in the same transaction as its final state in the history (D6 of the client-readiness plan). The row copies what the price will depend on: the account, the function's ID, name, runtime and memory at the time of the call, the runtime's duration, the billed duration, the cold start (`init_ms`), and the outcome. Its `request_id` is the request's ID, the invocation's own but for an asynchronous call's retries, which keep the first attempt's: each attempt is a row of its own, by its start. Rows are never changed or deleted, not even when the function changes or is deleted: the database refuses it. What is billed follows D7:

| Outcome (`status`) | Billed duration (`billed_ms`) |
|---|---|
| `success`, `error` (it threw, crashed or ran out of memory) | the runtime's duration, rounded up to the millisecond |
| `timeout` | the function's timeout |
| `throttled` (no instance free in time), `platform_error` (the cold start failed, the pod was unreachable), `lost` | nothing |

The cold start, when the call had to start an instance, is recorded in `init_ms` and never billed.

**The month's usage.** `GET /usage` adds the records up for a month by the UTC calendar: per function and in total, the requests billed, the billed duration, the GB-seconds, and the calls not billed; and, under `databases`, each of the account's databases measured in the month: the hours it was measured in, its GB-months, and its size at its last measure. Every member of the account may read it, viewers included, and an API key with `usage:read`. The console's "Usage" page shows this month and last month, and downloads the CSV, a line per function and then per database, its `kind` first:

```bash
curl -s "$FF/usage" | jq '{month, totals}'                                # this month
curl -s "$FF/usage?month=2026-09" | jq -c '.functions[] | {functionName, requests, gbSeconds}'
curl -s "$FF/usage?month=2026-09" -H 'Accept: text/csv'                  # the same, for a spreadsheet
# {"month": "2026-10", "totals": {"requests": 4, "billedMs": 3016, "gbSeconds": "0.752", "throttled": 0, "platformErrors": 0, "lost": 1}}
```

`gbSeconds` is billed duration × memory, counting 1,024 MB as 1 GB, as an exact decimal string, as AWS's Cost Explorer gives its amounts. The totals are the records' own sums, never the functions' rounded figures added up. A function deleted since keeps its usage, marked `"deleted": true`, and so does a database. A database's `gbMonths` is its size each hour over the month's hours, 1 GB being 2^30 bytes, as RDS bills storage, to six decimals. To read the raw records:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform \
  -c "SELECT started_at, function_name, status, memory_mb, duration_ms, billed_ms, init_ms FROM usage_records ORDER BY started_at DESC LIMIT 10"
```

The table has a partition per month, by the UTC calendar (`usage_records_2026_10`, …). The backend creates this month's and the next two at startup and then daily, so a month is never missing; `capacity_samples` and `database_samples` likewise.

**Customers' databases, measured every hour** ([ADR 0008](adr/0008-customer-databases.md)). Each minute, the backend measures every database not measured yet in the hour: all of them at the hour's start, a new one within a minute. Each measure is a row of `database_samples`, written once, with the database's size (`pg_database_size`), its sessions and its name; a closed account's databases aren't measured, their data waiting for their deletion date. At 80% and at 100% of the plan's storage per database, the account's owners get an e-mail, in their language, once each time it reaches the share, listed with the account's other notifications. Past 100%, its new sessions start read-only, and the sessions under way are ended so that a pool's start so again: an app reads, and a write is refused with SQLSTATE 25006. It is a signal rather than a wall: a session may turn it off for itself (`SET default_transaction_read_only = off`) and delete what it no longer needs, or even take the setting away, which the next hour's measure sets again, leaving the sessions under way be; the storage above the plan's is billed. Once the database is back under, at the next measure, its sessions start read-write again. To read the samples:

```bash
docker compose exec -T postgres psql -U postgres -d serverless_platform \
  -c "SELECT hour, name, pg_size_pretty(size_bytes) AS size, connections FROM database_samples ORDER BY hour DESC LIMIT 10"
```

**Prices** (P-30, D8 of the client-readiness plan). FF charges what AWS Lambda charges, in TND, with the same free tier: 1 million requests and 400,000 GB-s per account and month. Prices live in price books, as data: the first is AWS's US East list at the BCT's rate of 14 October 2026, 3.0080 TND per US$, valid from 1 October 2026. A new book starts in the future, and a book that has started never changes, so past usage keeps its prices. `GET /usage` estimates the month's cost with the books valid during it: each function's cost before the free tier, then the free tier, the duration tiers past 6 billion GB-s, any monthly fee, and the total, each rounded to the millime. A function with `minInstances` above zero pays for those instances while they are ready, and for its calls at the provisioned price, without the free tier. A database costs what RDS for PostgreSQL's gp3 storage costs in US East, by the GB-month: 0.115 US$, 0.34592 TND at the book's rate, with 1 GB-month free per account and month; FF charges no monthly fee per database. Those prices are in the second book, which the migration `DatabaseBilling` adds from the first hour of the month after it runs, the first book's prices with RDS's and S3's (S3 Standard's storage in its three tiers, its two classes of request, and their free tier: 5 GB-months, 2,000 `PUT` and 20,000 `GET`, for buckets); the books before price databases at nothing. Every hour, the backend rates the hour's usage with the same prices (P-32, below); for the first two weeks it only shows the charges.

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

**The hourly rating** (P-32, D9). An hour is rated once its last usage can have arrived: 33 minutes after it ends, at the platform's limits (two 900 s timeouts, the cold start, 30 s, and a minute). The backend then sums the hour's billed calls and minute samples into `usage_hourly`, and its databases' hourly samples into `resource_usage_hourly`, each with its name then, and charges each account that used something in it: its month so far, rated with the price books and rounded once to the millime, less what the month's earlier hours were charged. So the free tier and the tiers count from the month's start, and a month's charges add up to its total rounded once. Each charge is in `usage_charges`, and `rating_runs` lists the hours rated; a stopped backend catches up when it starts, hour by hour, and only one backend rates at a time.

**Shadow mode** is on at first (D9: the platform setting `billingShadowMode`, in the admin dashboard's Settings): charges are recorded and shown, and nothing is debited. Once `npm run billing:reconcile` has agreed for two weeks, turn it off, with a reason: from the next hour rated, each charge is debited, one ledger transaction per account and hour (`usage:<account>:<hour>`), and usage rated in shadow mode is never debited later. The console shows the balance on every page, with "Billing trial" while shadow mode is on; its title gives the month's charges so far. Every member reads it, and an API key with `usage:read`:

```bash
curl -s $FF/billing/balance | jq -c .
# {"currency":"TND","balance":"0.000","shadowMode":true,"month":"2026-10","charged":"0.000","ratedUntil":"2026-10-17T13:00:00.000Z"}
curl -s "$FF/billing/transactions?limit=20" | jq -c '.transactions[] | {kind, occurredAt, amount}'   # newest first; pass next as before
cd BE && npm run billing:reconcile -- --month 2026-10      # the month's charges against its usage records, priced afresh
# 2026-10 until 2026-10-17T13:00:00.000Z (the end of the last hour rated):
# Account         Charged  From usage  Requests rated  Requests used  GB-h rated  GB-h sampled
# 000000000001  0.000 TND   0.000 TND               4              4       0.007         0.007  ok
# The account agrees.
```

The reconciliation compares, per account, what the hourly rating charged in the month with the same hours priced again from the usage records and samples, and the billed calls and the databases' storage counted both ways: the parent plan's criterion, rated usage equals raw usage. It only reads, and exits 1 when an account differs. A difference means usage reached the database after its hour was rated, which the 33 minutes are there to prevent: that usage is not charged.

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

**Invoices and usage statements** (P-36, D9). Each month an account buys credit in gets an invoice, issued early the next month by FF's operator (below). It lists a line per transfer received up to the month's end and not invoiced before: the credit before tax and its VAT, at the rate of the day the pro-forma was asked for. It adds the stamp duty, 1 TND, which is taken from the account's credit when the invoice is issued. The invoice is a French PDF, numbered `FAC-<year>-000001` without gaps in each fiscal year, with the month's usage statement attached: each function's requests, GB-seconds and cost, each database's GB-months and cost, by the name it had, the free tier, the total, and what was debited. Usage itself isn't invoiced again, since its credit was. Every month has a usage statement, with or without an invoice. An issued invoice never changes: a correction is a credit note (*facture d'avoir*), `AV-<year>-000001`. The console's Billing page lists the invoices and credit notes, and downloads them and any month's statement. Every member does, and an API key with `usage:read`:

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

**Lost calls.** When the backend stops during a call (it crashed, was killed, or restarted), the call's answer is lost, and its invocation would stay `RUNNING`. At startup and every minute, the backend marks such calls `LOST`, with a usage record that bills nothing, once the longest a call can take has passed: two timeouts (a wait for a free instance, then the run), the cold-start limit (`K8S_READY_TIMEOUT_SECONDS`, 90 s), and 30 s more. For a function with a 5 s timeout, that is 2 min 10 s. The history then says `Lost: the backend restarted during the call, so its answer is unknown. It isn't billed.` A function changed since the call started gets the longest timeout there is (900 s), as its timeout then is no longer known. An asynchronous call's lost attempt isn't the end of it: nobody waits for its answer, so its event comes back once its lease ends, and the lost attempt counts as one that failed ("Call a function without waiting", above).

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
3. "Settings", under "Account" in the sidebar, shows the account; its owners rename it or set its tax ID. "Members" invites people and changes their roles. "API keys" lists, creates and revokes the account's keys, and shows a new key once. The account switcher at the top of the sidebar lists your accounts, and "New account…" makes another. A viewer sees no button to create, change or invoke.

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

**Turning an account's databases, buckets and queues off** (`PUT /admin/accounts/<id>/storage`, the account page's "Databases, buckets and queues"). With a reason, as for abuse, its functions going on: its databases' users can't log in and their sessions end, its access keys are refused at the S3 front door and the SQS endpoint, it makes no database, bucket or queue, FF's API sends and receives no message, and its functions' records go to no queue; their data stay, and are billed. Turned on again, they log in and the keys work, unless the account is suspended or closed; reactivating a suspended account doesn't let them in while its storage is off. Its owners get an e-mail of each change, in their language, the reason in it, and its members read the reason in their audit log and in `GET /me` (`storageDisabledAt`, `storageDisabledReason`). The account page lists its databases, with their names on the server, which a restore of one names (`deploy/backup/README.md`), and their size and sessions as the server counts them; its buckets; and its queues, each with its messages counted, what they hold and its dead-letter queue, and what they hold together with its functions' calls that don't wait, against the plan's room for them.

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

**Prices** (P-73). The dashboard's Prices page lists the price books: past, active and scheduled. A new book starts from the latest one, scheduled or active, at AWS's US$ prices times a rate, or at TND prices as you set them, with the free tier and D8's knobs (a minimum billed duration, a price for idle instance time, a monthly fee); and, from a book that has them, customers' databases' and buckets' prices as AWS RDS and S3 set them, their free tier and a monthly fee per database. A book after one with those must have them too: the API names each one missing, since without them databases and buckets would cost nothing from it on. It starts at a whole hour, UTC, from the next one on, and prices what happens until a later one starts. "Try it on last month" prices last month with the draft, per account, next to the books valid then and what the hourly rating charged (in shadow mode, only rated), and saves nothing. A book that says it is AWS's prices times a rate must be exactly that: the API names each price that isn't. A scheduled book can be removed; one that has started never changes.

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
(cd cli && cargo test --locked)                          # the ff command: unit tests, then its binary against a scripted API, seconds
hack/k8s/test-it.sh                                      # the Kubernetes driver on the dev cluster, about 6 min
hack/k8s/test-logging-filter.sh                          # the log collector's configuration and filter, in its image, seconds
hack/k8s/test-rbac.sh                                    # the backend's cluster permissions
hack/e2e.sh                                              # the whole stack through the API, about 3 min
hack/e2e-tenancy.sh                                      # every route as another account and anonymously, about 1 min
hack/cli-e2e.sh                                          # the ff command on the stack, and in Docker, about 5 min
hack/test-images.sh                                      # the backend's, console's and admin app's images, run as the cluster runs them, about 3 min
hack/k8s/test-platform-manifests.sh                      # deploy/k8s/platform checked without deploying it, about 1 min
hack/e2e-platform.sh                                     # FF deployed from deploy/k8s on a cluster of its own, through its edge, about 15 min
hack/backup-drill.sh                                     # the restore drill: both databases to a moment, the legal records, the packages, about 2 min
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
| Port 5432 or 9003 already in use | `FF_PG_PORT=55432 FF_S3_PORT=59003 docker compose up -d --wait`, then set `DB_PORT` and `FF_OBJECT_STORE_PORT` in `BE/.env` to match. |
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
| A function can't reach an outside API: `connect ETIMEDOUT`, or a name that resolves but never answers | Its account's internet egress is off, as every new account's is: `GET /me` says it of each account (`internetEgress`), and `ff account` too. Turn it on in the admin dashboard (the account's page), or with `PUT /admin/accounts/:id/egress`. In development mode, without the admin dashboard: `UPDATE accounts SET internet_egress = true WHERE id = '<FF_DEV_ACCOUNT_ID>';` in the database, then change a function's code or create one: every rollout writes the account's NetworkPolicy. |
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
| Function pods in `ImagePullBackOff` | The runtime image is not in the cluster: `hack/k8s/load-images.sh`. Or the node can't pull the code image (`kubectl -n <namespace> describe pod` names it): `hack/k8s/registry-up.sh` starts the registry and tells the node where it is. A registry that lost the image, its volume deleted, gets it back from the backend, which makes again the images functions use every hour and at its start: restart it. |
| `create` or `update` answers 503 `This FF has no code registry, so it can't deploy a function` | `BE/.env` lacks the registry, as one from before 2026-10-21 does: add `FF_CODE_REGISTRY=http://127.0.0.1:5056` and `FF_CODE_REGISTRY_PULL=ff-dev-registry:5000`, as in `BE/.env.example`, and restart the backend. |
| `create` or `update` answers 503 `The code registry can't be reached: nothing changed, try again in a moment` | The registry isn't running: `hack/k8s/registry-up.sh`, then send it again. |
| `create` fails with `The function failed to load:` | The code didn't load: the runtime's reason follows, and `functionId` names the function, saved as `ERROR`. Fix the code and send it with `PUT /functions/<id>`, rather than create it again: see "If a function cannot load" in section 3. If the answer is 500 instead, the platform failed: see the row below about request IDs. |
| `create` takes 90 s, then fails | The backend couldn't read the runtime's reason in the log store, and waited for the readiness timeout: check the log pipeline (`kubectl -n ff-system get pods`; `hack/k8s/logging-up.sh` installs it). |
| 400 `name must be 1 to 64 letters, digits, hyphens or underscores…` | Function names follow AWS Lambda's rule: no spaces, dots or accented letters, and 64 characters at most. `my-function` or `my_function`, rather than `my function`. |
| 409 `A function named "…" already exists in this account` | Names are unique within an account: choose another name, or change the function that has it (`PUT /functions/<id>`). One whose code failed to load was saved all the same: fix it rather than create it again. |
| 409 `The new version is live, but the function keeps its name …` | Another create or rename took the new name while the update rolled out. The rest of the update went through; rename the function again with a free name. |
| An update answers 400 with `The update was rolled back` | The new version couldn't start; the reason comes first, and `functionId` names the function, as a failed create's answer does. The previous version still serves, and the record is unchanged. |
| An invocation stays `RUNNING`, then becomes `LOST` | The backend stopped during the call, so its answer is unknown; it isn't billed. Invoke again. See "Lost calls" in section 5. |
| The backend logs `Could not create the monthly partitions` | The migrations haven't run (`cd BE && npm run migration:run`), or the database refused: the message says why. An invocation in a month without a partition fails with `no partition of relation "usage_records" found for row`. |
| The backend logs `Could not sample capacity` | The Kubernetes API didn't answer the list of Deployments, or the database refused the samples: the message says why. That minute has no sample; the next minute is sampled as usual. |
| An invoke answers 429 with `TooManyRequestsException: Rate exceeded: no instance was free within …` | More calls arrived together than the function's instances could take within one timeout. Raise `maxInstances` (`PUT /functions/<id>/scaling-config`), or make the calls shorter. |
| `jq: parse error` after `echo "$response" \| jq` in zsh | zsh's `echo` expands `\n` inside JSON strings. Pipe `curl` straight into `jq`, or use `printf '%s' "$response"`. |

More symptoms and fixes are in the dev guide's [troubleshooting table](kubernetes-dev-guide.md#troubleshooting).
