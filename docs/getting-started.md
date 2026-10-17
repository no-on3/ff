# Getting started: run FF locally and use it

This guide takes a developer from a fresh clone to a working FF on their own machine, then shows the everyday commands. At the end you will have:

```
curl, Swagger UI, dashboard ──▶ backend API (localhost:3000) ──▶ PostgreSQL + S3 (docker compose)
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
| Node.js and npm | 24 | Backend, dashboard, Node.js runtime tests |
| Python | 3.11+ | Python runtime tests |
| git, curl, jq | jq 1.6+ | Getting the code; the commands in this guide |
| zstd, sha512sum | any | Only for the optional gVisor sandbox |

`kubectl` and `k3d` are installed into the repository by a script (step 3); nothing goes system-wide.

**Machine.**
- At least 3.5 GB of free memory and 6 GB free on Docker's disk, plus about 1 GB for the repository.
- These ports free on 127.0.0.1: 5432 (PostgreSQL), 9003 (S3), 6550 (Kubernetes API), 3000 (backend), and 5173 (dashboard). Section 6 shows how to move them.
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
- installs FF's RBAC and admission policy (`deploy/k8s/base`);
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

- The defaults in `.env.example` match the steps above. In development the backend acts as one account, `FF_DEV_ACCOUNT_ID` (`FF_AUTH_MODE=dev`), until Keycloak login exists.
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

**8. The dashboard (optional)**, in its own terminal:

```bash
cd FE && npm install && npm run dev
```

It runs on http://localhost:5173 and calls the API on localhost:3000. It creates, invokes, and edits functions, and shows their invocation history; the scaling tab is read-only for now.

**9. The gVisor sandbox (optional).** This runs every function in gVisor, an extra isolation layer. Restart the backend afterwards.

```bash
hack/k8s/gvisor-up.sh                                       # about 80 s the first time
sed -i 's/^K8S_RUNTIME_CLASS=.*/K8S_RUNTIME_CLASS=gvisor/' BE/.env
```

**Check the whole setup** with the end-to-end test. It uses its own compose project, ports, and backend, so it can run next to your dev stack. It takes about 2 minutes and needs 3.5 GB of free memory.

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

**Invoke it.** `input` becomes `event.body` in the handler, and `duration` is the execution time in milliseconds:

```bash
curl -s -X POST "$FF/functions/$ID/invoke" -H 'content-type: application/json' \
  -d '{"input": {"name": "Tunis"}}' | jq '{status, output, duration}'
# {"status": "COMPLETED", "output": {"message": "Hello Tunis", "requestId": "…"}, "duration": 1.09}
```

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
- 128–1024 MB of memory;
- a timeout of 1–300 s;
- up to 3 instances by default, and 10 at most (`maxInstances`); `minInstances` from 0 to 10 keeps instances running when idle.

The handler is AWS Lambda's `handler(event, context)`, and the [Node.js](../runtimes/nodejs/README.md) and [Python](../runtimes/python/README.md) runtime READMEs describe `event`, `context`, and the error names.

**If a function cannot load** (a syntax error, a missing handler, an exception at import), the create call waits for the readiness timeout (90 s, `FF_READY_TIMEOUT_SECONDS` in `BE/.env`). It then answers 400 with `Function "<name>" did not become ready within 90 s: last log lines: …`. Those lines include the runtime's reason, for example `"errorType":"Runtime.UserCodeSyntaxError","errorMessage":"SyntaxError: function.ts:2:11 Property assignment expected."`. The function is listed with status `ERROR` and that reason, and its pod is released. **Fix it with an update:** send the corrected code (`PUT /functions/<id>`), and the function becomes `ACTIVE`, keeping its ID. An update of an `ERROR` function always rolls out, even without changes, so `PUT` with `{}` retries the same code after a passing failure such as a full quota. While developing functions, a lower timeout such as 30 gives faster feedback.

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

**See a cold start.** Idle functions are scaled to zero after 15 minutes (`FF_SCALE_TO_ZERO_IDLE_SECONDS`). To skip the wait, scale one down yourself. The next invocation starts it again, which takes about 7–10 s at the smallest size, and the backend logs `Cold start: scaling <id> from zero`.

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
(cd BE && npm test)                                      # backend unit tests, seconds
(cd BE && npm run test:db)                               # migrations against real PostgreSQL (compose), seconds
(cd BE && npm run migration:check)                       # the migrations build exactly the entities' schema
(cd FE && npm test)                                      # dashboard unit tests, seconds
(cd runtimes/nodejs && npm test)                         # Node.js runtime protocol
(cd runtimes/python && python3 -m unittest discover -s tests)   # Python runtime protocol
hack/k8s/test-it.sh                                      # the Kubernetes driver on the dev cluster, about 3 min
hack/k8s/test-rbac.sh                                    # the backend's cluster permissions
hack/e2e.sh                                              # the whole stack through the API, about 2 min
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
| Port 3000 already in use | Set `PORT` in `BE/.env`. The dashboard has the API address hard-coded in `FE/src/services/api.ts`, so change it there as well. |
| Port 5173 already in use | Vite moves to the next free port and prints it. Set `CORS_ORIGIN` in `BE/.env` to that address, or the browser blocks the dashboard's API calls. |
| `The backend did not start` with `Invalid configuration (… problems)` | Each line names a variable and what it expects. With `FF_DEV_USER_ID is no longer read`, your `BE/.env` is from before 2026-10-17: copy `BE/.env.example` again. |
| Every API call returns 401 | `FF_AUTH_MODE` isn't `dev`. The default, `oidc`, needs Keycloak, which doesn't exist yet (client-readiness plan P-11). Use the values from `BE/.env.example`. |
| `The backend did not start: The database schema is out of date: … pending` | `cd BE && npm run migration:run`, then start it again. |
| `migration:run` fails with `relation "functions" already exists` | The database was created before migrations were used. Reset it once, as shown after step 7. |
| `npm run test:db` fails with `ECONNREFUSED` | PostgreSQL isn't running: `docker compose up -d --wait postgres`. The tests read `DB_*` from `BE/.env`. |
| Kubernetes calls fail with `Unauthorized` | The token expired: `hack/k8s/mint-token.sh`. |
| Function pods in `ImagePullBackOff` | The runtime image is not in the cluster: `hack/k8s/load-images.sh`. |
| `create` takes 90 s, then fails | The function cannot load. The error message contains the runtime's reason. Fix the code and send it with `PUT /functions/<id>`: see "If a function cannot load" in section 3. |
| An update answers 400 with `The update was rolled back` | The new version couldn't start; the reason comes first. The previous version still serves, and the record is unchanged. |
| An invoke answers 400 with `Invocation failed with HTTP 429: … Rate exceeded: no instance was free within …` | More calls arrived together than the function's instances could take within one timeout. Raise `maxInstances` (`PUT /functions/<id>/scaling-config`), or make the calls shorter. The client-readiness plan's P-15 turns this answer into a 429. |
| `jq: parse error` after `echo "$response" \| jq` in zsh | zsh's `echo` expands `\n` inside JSON strings. Pipe `curl` straight into `jq`, or use `printf '%s' "$response"`. |

More symptoms and fixes are in the dev guide's [troubleshooting table](kubernetes-dev-guide.md#troubleshooting).
