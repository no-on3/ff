# Kubernetes development guide

FF runs functions on Kubernetes ([ADR 0001](adr/0001-orchestrator-kubernetes.md)). This guide covers the local development cluster. The migration itself is tracked in the [migration plan](kubernetes-migration-plan.md). New to the project? Start with [Getting started](getting-started.md), which takes you from a fresh clone to a working setup and shows the everyday commands.

## Requirements

| Resource | Needed | Why |
|---|---|---|
| Docker | 24+ | k3d runs the k3s node as a container |
| Node.js | 24.15 or newer | Backend (NestJS 12), Node.js runtime tests |
| Python | 3.11+ | Python runtime tests (`python -P`) |
| `curl`, `jq` | any | Smoke tests, e2e |
| `zstd`, `sha512sum` | any | Only for `hack/k8s/gvisor-up.sh` |
| Free memory | ≥ 3 GB to create the cluster or run L3, ≥ 3.5 GB for e2e | The node is capped at 2 GB (`FF_NODE_MEMORY`) and idles at about 370 MiB. Each function pod takes its memory setting (128 MB minimum). |
| Free disk (Docker filesystem) | ≥ 6 GB | The k3s image, the runtime images (198 MB Node.js, 123 MB Python) and their copies imported into the node, plus about 150 MB of gVisor in the node if installed |
| Free disk (repository) | about 1 GB | `node_modules`, `hack/bin` (tools; gVisor adds about 200 MB) |
| Ports | `127.0.0.1:6550` | Kubernetes API |

Every script runs `hack/check-resources.sh` first and stops if the machine is too low on disk, memory, or CPU headroom. Run it yourself before anything heavy:

```bash
hack/check-resources.sh            # thresholds: MIN_DOCKER_DISK_GB, MIN_REPO_DISK_GB, MIN_MEM_AVAILABLE_MB, MAX_LOAD_FACTOR
```

## Tools

```bash
hack/install-tools.sh              # kubectl v1.37.1 + k3d v5.9.0 into hack/bin/, SHA-256 verified
```

Nothing is installed system-wide, and `~/.kube/config` is never touched. To use the tools and the cluster in your shell (bash or zsh):

```bash
source hack/k8s/env.sh             # PATH=hack/bin:…, KUBECONFIG=hack/.kube/ff-dev.kubeconfig
kubectl get pods -A
```

## Cluster lifecycle

```bash
hack/k8s/cluster-up.sh             # create (or start) the cluster, apply deploy/k8s/dev, install the log pipeline, mint credentials
hack/k8s/cluster-up.sh --monitoring    # the same, and the operator's monitoring (below)
hack/k8s/test-rbac.sh              # verify RBAC, the production manifests and the admission policy (35 checks)
hack/k8s/registry-up.sh            # the code registry, for a cluster made before it (cluster-up.sh runs it)
hack/k8s/cluster-down.sh           # delete the cluster, its registry's container, and the local credentials
```

`cluster-up.sh` creates k3s v1.37.1 with:
- one server node, no agents, and no load balancer container;
- the API on `127.0.0.1:6550`;
- a 2 GB node memory cap;
- Traefik and metrics-server disabled;
- the log pipeline (below), unless `--no-logging`;
- the operator's monitoring (below), with `--monitoring` only;
- the registry of functions' code images ([ADR 0003](adr/0003-code-delivery.md)), `ff-dev-registry` (`registry:3.1.2`), on the cluster's Docker network: the backend pushes to `127.0.0.1:5056`, and the node pulls from `ff-dev-registry:5000` over HTTP. `registry-up.sh` tells the node's containerd so in a `hosts.toml`, which containerd reads at each pull, and in `/etc/rancher/k3s/registries.yaml`, which has k3s write it again when it starts: a cluster made before the registry gets it without a restart. Its images are in the volume `ff-dev-registry`, which `cluster-down.sh` keeps; the backend makes an image again when the registry has lost it, at a deploy, and for every function's every hour and at its start. It takes deletes (`REGISTRY_STORAGE_DELETE_ENABLED=true`), as production's registry does, so that the purge of unused packages deletes their images too: `registry-up.sh` makes a container from before without them again, its volume kept.
- outside it, when `hack/k8s/data-db-up.sh` runs, the server of customers' databases ([ADR 0008](adr/0008-customer-databases.md)): `docker-compose.yml`'s `data-db` at 10.199.0.10, on a Docker network of its own that the node joins with `--gw-priority -1`, so that its default route stays the cluster's network. Docker picks a container's default gateway by the networks' names at equal priority, and `ff_data` sorts before `k3d-ff-dev`: without it, the node's traffic would leave through the data network. The script checks the route after joining, and `down` takes the node off the network first.

It is safe to re-run.

## Runtime images and integration tests

Function pods use the FF runtime images `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3` (protocol and handler contracts in [`runtimes/nodejs`](../runtimes/nodejs/README.md) and [`runtimes/python`](../runtimes/python/README.md)). In development they are built locally and imported into the cluster, so no registry is needed:

```bash
runtimes/nodejs/test/container-smoke.sh    # builds ff-runtime-nodejs:24-v3 and checks it hardened
runtimes/python/tests/container-smoke.sh   # builds ff-runtime-python:3.13-v3 and checks it hardened
hack/k8s/load-images.sh                    # imports every local ff-runtime-* image into ff-dev
hack/k8s/test-it.sh                        # L3: re-imports the images, then runs BE `npm run test:it` (~6 min)
hack/k8s/test-it.sh functions.lifecycle    # only the suites whose path matches
```

`npm run test:it` deploys real functions with the `ff-controller` token into a throw-away `ff-t-*` namespace. It checks:
- deploy and invoke;
- a code rollout;
- scale to zero and cold start;
- the tenant network policy (DNS allowed, the API server blocked);
- internet egress per account: a function can't reach the internet until its account's egress is on, can then, and can't again once it is off, the API server blocked throughout (only where this machine reaches the internet: `test-it.sh` checks first);
- init-failure diagnostics, and a missing RuntimeClass explained;
- a Python function (deploy, invoke, and Lambda error names);
- a Node.js function in `/var/task` that reads a file next to its code through a relative path;
- a Python and a Node.js memory hog: each gets `Runtime.OutOfMemory`, the next invocation works, and the container is never restarted;
- functions of both runtimes inside gVisor, with the network policy still enforced (only where the `gvisor` RuntimeClass exists; see [Sandboxing with gVisor](#sandboxing-with-gvisor));
- customers' database server (only where `hack/k8s/data-db-up.sh` runs it): a function reaches it on its port with its account's internet access off, and trusts its certificate through `NODE_EXTRA_CA_CERTS` and the CA FF mounts; once the platform's rule leaves the account's policy, it reaches it no more;
- scaling on concurrency (`functions.scaling.it.spec.ts`): a burst of slow calls takes a function to two instances without a failed call, later calls are spread over both, and a quiet minute steps it back to one;
- the function lifecycle, through `FunctionsService` (`functions.lifecycle.it.spec.ts`): a broken create is released and then repaired by an update; a broken update of a working function is rolled back, so the next cold start runs the old code; an update of a function scaled to zero is checked on a real pod; a call that a hung runtime never answers is recorded as `TIMEOUT` through the API server proxy, as in direct mode;
- clean-up.

It deletes everything it creates. The default `npm test` skips these suites.

## Running the backend against the cluster

```bash
docker compose up -d --wait               # PostgreSQL (127.0.0.1:5432) + SeaweedFS S3 (127.0.0.1:9003)
hack/k8s/cluster-up.sh                    # prints the K8S_* settings
hack/k8s/load-images.sh
cp BE/.env.example BE/.env                # first time only; the defaults match the steps above
cd BE && npm run migration:run && npm run start:dev
```

- **The database schema comes from migrations.** `npm run migration:run` applies the pending ones, and the backend refuses to start while any is pending. A database created before 2026-10-17 must be reset once; see [Getting started](getting-started.md), step 7.

- **Every variable is checked at boot.** A missing or bad value stops the backend with a message that names the variable (`BE/src/config/configuration.ts`).
- **Nothing runs without an account.** With Keycloak (`FF_AUTH_MODE=oidc`, client-readiness plan P-11 to P-14), each request acts for the logged-in user's account. Without a login, development uses `FF_AUTH_MODE=dev`, which acts as the account `FF_DEV_ACCOUNT_ID`, as `.env.example` does, or as the one an `X-FF-Dev-Account` header names. Every query is scoped to that account: another account's function answers 404. Those development accounts are real rows, created active the first time they are used (P-12). Production refuses this mode. `FF_DEV_USER_ID`, used before 2026-10-17, is no longer read, and the backend says so.
- **Platform failures stay generic.** An answer only shows the function's own errors and the caller's mistakes. Anything else is 500 with `… failed because of an internal error (request <id>)`; the backend's log has the details under that request ID, which every answer carries in `x-ff-request-id`.
- **What `docker compose up` starts.** Only PostgreSQL and S3. The backend and the console run on the host (`npm run start:dev`, `npm run dev`; the console on port 5199). `--profile auth` adds Keycloak (http://localhost:8180, about 600 MB, the development realm `ff`) and Mailpit (http://localhost:58025, SMTP on 51025, not FF's other project's 1025/8025).
- **S3 storage.** SeaweedFS replaces the MinIO community image, which is no longer published. Its dev credentials are in `infrastructure/seaweedfs/s3.json` (local use only).

## End-to-end test

```bash
hack/e2e.sh                # L4: the whole stack through the REST API (~3 min)
hack/e2e.sh --teardown     # … and delete the cluster afterwards
hack/e2e-tenancy.sh        # L5: every route as another account and anonymously, a function's logs, then the operator's routes, bank transfers, invoices and credit grants, and last, closing an account and deleting its data (~3 min)
```

The script starts its own compose project (`ff-e2e`, ports 55432 and 59003), ensures the cluster and runtime images are ready, builds the backend, and starts it on a free port. It then runs:
1. create (waits for ACTIVE);
2. invoke;
3. history (with duration);
4. update (new code live);
5. delete (Deployment gone, record gone);
6. the same create, invoke, and delete for a Python function;
7. plans and rate limits (P-15): an account on a small plan, its limits, its namespace's quota, and its rates;
8. usage records (P-20): one per invocation, with the invocation's ID as the runtime's request ID, for a success, an error, a timeout and a cold start; then the backend is killed during a call, restarted, and marks the call `LOST`, unbilled, within about a minute;
9. capacity samples (P-21): the warm function sampled each minute, and `npm run capacity:report` showing the account's day;
10. the usage API (P-22): `GET /usage` against the raw records, the deleted function's usage and the deleted database's month from its hourly sample, CSV with both, an empty month, a malformed one;
11. usage priced (P-30): the month in TND with the first price book, a function's cost from the book's prices in SQL, the free tier covering the month, the CSV's costs, and no estimate before the first book;
12. the hourly rating (P-32): every hour from the first book rated as the backend started, once and in order, in shadow mode; the balance and the transactions, nothing debited; `npm run billing:reconcile` against the stack's database;
13. the balance check (P-33): shadow mode off, no buffer and no grace period; a wallet run below zero, an invoke refused with 402 and nothing recorded; a top-up, and invokes accepted again at once.

It checks the Kubernetes side at each step. On exit it removes its compose project, including its volumes, and its tenant namespace, and stops the backend. Other projects' containers and volumes are never touched.

## Sandboxing with gVisor

Optional in development, required in production. With `K8S_RUNTIME_CLASS=gvisor`, every function pod runs in [gVisor](https://gvisor.dev), a user-space kernel that answers the pod's system calls. Tenant code then never talks to the node's kernel directly. This adds a layer on top of the default isolation (non-root, read-only root filesystem, no capabilities, seccomp `RuntimeDefault`, a NetworkPolicy and quota per tenant), for untrusted code. To switch it off in development, unset the variable. Functions pick up the change at their next deploy or update.

With `NODE_ENV=production` the backend refuses to start without `K8S_RUNTIME_CLASS`. Only a cluster that tries the platform's manifests, never with customers' code, may set `K8S_ALLOW_UNSANDBOXED=true` instead. `deploy/k8s/platform/deploy.sh` refuses to deploy when the cluster lacks the RuntimeClass, or a node with the label it schedules on. `hack/e2e-platform.sh` installs gVisor in its own cluster, and checks that the customer's function answers from gVisor's kernel.

### In the dev cluster

```bash
hack/k8s/gvisor-up.sh                      # first run about 80 s: downloads 130 MB, restarts the cluster once
hack/k8s/test-it.sh                        # now also runs the sandboxed case
K8S_RUNTIME_CLASS=gvisor hack/e2e.sh       # the whole stack, every function in gVisor
```

The script:
- installs the pinned release (20260928.0, SHA-512 checked) into the k3d node;
- registers `runsc` with containerd;
- applies `deploy/k8s/optional/runtimeclass-gvisor.yaml` and labels the node `ff.dev/gvisor=true`;
- checks the result with a pod that must report gVisor's kernel (`4.19.0-gvisor`).

It works nested because k3d nodes are privileged containers, and gVisor's default `systrap` platform needs no KVM. A recreated cluster needs the script again.

### On real nodes (k3s, RKE2, containerd)

On every node that should run sandboxed functions:
1. **Install the binaries.** Download `https://storage.googleapis.com/gvisor/releases/release/<release>/<arch>/gvisor.tar.zstd` and its `.sha512`, then check it with `sha512sum -c`. Extract `runsc`, `containerd-shim-runsc-v1`, and the `gvisor-bin/` directory into `/usr/local/bin`. `runsc` looks for the `gvisor-bin/` helpers next to itself and refuses to start a sandbox without them.
2. **Register the runtime** with containerd (containerd 2, configuration version 3): `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]` with `runtime_type = "io.containerd.runsc.v1"`.
   - k3s: put it, with `version = 3` on top, in `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-gvisor.toml`. k3s imports that directory. Then restart k3s.
   - RKE2 generates its containerd configuration the same way, under `/var/lib/rancher/rke2/agent/etc/containerd/`. Check that the generated `config.toml` has an `imports` line for `config-v3.toml.d`. If it does not, use `config-v3.toml.tmpl`.
   - Plain containerd: add the section to `/etc/containerd/config.toml` and restart containerd.
3. **Label the node:** `kubectl label node <node> ff.dev/gvisor=true`.

Then, once for the cluster, run `kubectl apply -f deploy/k8s/optional/runtimeclass-gvisor.yaml` and set `K8S_RUNTIME_CLASS=gvisor` for the backend.

**Verification checklist:**
- A test pod with `runtimeClassName: gvisor` reports a `-gvisor` kernel (`uname -r`, or `os.release()` in Node.js).
- `hack/k8s/test-it.sh`, pointed at the cluster, passes the sandboxed case. That case also checks that the tenant NetworkPolicy still applies inside gVisor.
- After the switch, the Deployments of new and updated functions show `runtimeClassName: gvisor`. `hack/e2e.sh` checks this when `K8S_RUNTIME_CLASS` is set.
- If the RuntimeClass is missing, no pod can be created, and the backend reports the reason: `no pods were created: … RuntimeClass "gvisor" not found`.

### Costs and differences (measured on k3d)

| | runc | gVisor |
|---|---|---|
| Memory of an idle pod | 48 MiB (Node.js), 21 MiB (Python) | +29 MiB, +36 MiB. The RuntimeClass declares 40 Mi of overhead, so this is not taken from the function's memory. |
| Idle CPU | 0 | about 2m |
| Cold start at 128 MB / 100m CPU, deploy to Ready (Node.js) | 6 to 8 s | 6 to 11 s (see "Cold starts" below) |

- gVisor reports its own kernel version (4.19.0-gvisor) and implements most, but not all, Linux system calls. Code that inspects kernel features can behave differently.
- The Python runtime's memory budget relies on `RLIMIT_DATA`, which gVisor does not enforce (verified). Under gVisor, a function that outgrows its memory meets the sandbox's limit instead.
- Cold starts are slow at the smallest size because of the 100m CPU limit, which slows every start-up step roughly tenfold. See the migration plan, K-13.

### Cold starts

`hack/k8s/cold-start-benchmark.sh` deploys functions through the backend's own Kubernetes driver, several at once, and times each one: from the deploy to Ready and to its first answer, and inside the pod from its creation to its container's start, to the runtime listening, to the code loaded. Loading the code must fit in the runtime's start-up limit, 10 s at the smallest sizes. The functions go in a namespace of their own, deleted at the end.

```bash
hack/k8s/cold-start-benchmark.sh --runtime-class gvisor                    # Node.js, 128 MB, 3 at once, 2 rounds
hack/k8s/cold-start-benchmark.sh --runtime python --memory 256 --at-once 1 --rounds 5
K8S_RUNTIME_IMAGE_NODEJS=ff-runtime-nodejs:other hack/k8s/cold-start-benchmark.sh   # another image, against this one
```

Measured on the dev cluster on 2026-10-20, 128 MB, in seconds:

| | Deploy to Ready | Container started to runtime listening | Listening to code loaded |
|---|---|---|---|
| Node.js, runc | 6.1 to 8.2 | 1.3 to 1.9 | 3.2 to 3.5 |
| Node.js, gVisor | 6.1 to 11.1 | 1.6 to 3.8 | 2.0 to 5.0 |
| Node.js, gVisor, before the TypeScript code cache | 14.2 to 15.1 | 2.7 to 3.1 | 8.9 to 9.4 |
| Python, gVisor | 6.1 to 7.1 | 3.8 to 4.0 | 0.9 to 1.0 |

The Node.js image keeps a V8 code cache of the TypeScript compiler, written at its build after a transpile ([runtimes/nodejs](../runtimes/nodejs/README.md#start-up)): compiling the compiler took most of the start-up limit inside gVisor. Deploy to Ready also counts the readiness probe's period and the backend's polling.

## The log pipeline

Fluent Bit reads every function container's log on the node, and VictoriaLogs keeps the lines for 31 days ([ADR 0005](adr/0005-log-pipeline.md), client-readiness plan P-42). `GET /functions/:id/logs` reads it, and so does the diagnosis of a deploy that fails, for the load error the runtime logged (P-43): the backend no longer reads pod logs. `cluster-up.sh` installs it, unless `--no-logging`; without it, the logs API answers 503 and a failed deploy doesn't name its load error.

```bash
hack/k8s/logging-up.sh                  # install it on a cluster made without it, about 30 s
hack/k8s/test-logging-filter.sh         # L1: the collector's configuration and Lua filter, in its image; Docker only
hack/k8s/test-it.sh log-pipeline        # L3: what functions print reaches the store, limited, and an account's lines deleted (about 2 min)
hack/k8s/log-store-key.sh               # copy the store's delete key to hack/.kube, for a development backend (logging-up.sh does)
hack/k8s/logging-down.sh                # remove it, with every stored line and the delete key
```

Closing an account deletes its log lines with the store's delete key (P-45). A development backend reads it from `hack/.kube/victoria-logs-delete-key` (`K8S_LOG_STORE_DELETE_KEY_FILE` in `BE/.env`); a cluster made before P-45 gets the file from `hack/k8s/log-store-key.sh`.

Running `logging-up.sh` again changes nothing. kubectl still reports the StatefulSet `configured`, because the API server fills in defaults in its volume template; VictoriaLogs isn't restarted.

What it installs is in [`deploy/k8s/README.md`](../deploy/k8s/README.md#logging): VictoriaLogs in `ff-system` with its volume, Fluent Bit in `ff-logging` on every node, and NetworkPolicies that let only Fluent Bit and the backend's pods reach the store.

**Each line** keeps its namespace (the account), its function ID, its pod, its stream (`stdout` or `stderr`), and the request ID of its call: the lines from its pod's `START` line to its `REPORT`. The runtimes write a call's output before its `END` (P-42 part 1), so every line the handler writes before it returns has its call. The namespace and the function ID are the stream fields, which every query names. They come from the pod's metadata, or, when the collector can't get it, from the log file's name and the pod's name (`fn-<function ID>-…`).

**The limit:** each account's namespace keeps 2,000 lines and 1 MiB a second, counted by the lines' own time, so a backlog read after a restart keeps each second's budget. Past it, lines are dropped. Once that second is two seconds past, the store gets one line per function, with `stream` `ff`, saying how many:

```
FF dropped 23412 of this function's log lines written at 2026-10-17 21:30:05 UTC: its account wrote more than 2000 lines, or 1048576 bytes, in that second.
```

2,000 lines let an account at the beta plan's 100 calls a second write 17 lines of its own per call, besides `START`, `END` and `REPORT`; 1 MiB stops a loop of long lines that the line count alone would let through. `FF_LOG_LINES_PER_SECOND` and `FF_LOG_BYTES_PER_SECOND` in `deploy/k8s/logging/30-fluent-bit.yaml` change them.

**A long line** is cut at 16,384 bytes, at the start of a character, and ends with ` …[truncated]`.

**Querying it** with LogsQL, in development:

```bash
source hack/k8s/env.sh
kubectl -n ff-system port-forward svc/victoria-logs 9428:9428 &
curl -s http://127.0.0.1:9428/select/logsql/query --data-urlencode 'query={namespace="ff-t-…"} request_id:="<invocation id>"'
curl -s http://127.0.0.1:9428/select/logsql/query --data-urlencode 'query={namespace="ff-t-…", function_id="<function id>"} _time:15m'
```

The L3 suite (`log-pipeline.it.spec.ts`, run where the pipeline is installed) deploys functions in two throw-away accounts and checks:
- a Node.js call's lines (stdout and stderr) and a Python call's, with their namespace, function, pod, stream and request ID, all queryable within 5 s;
- pages read as the logs API reads them: a call's lines, a phrase, pages of 3 back with the cursor giving the same lines once each, and a phrase written as LogsQL finding nothing;
- the live tail, opened before two calls and narrowed to one: that call's five lines, in order, within 15 s;
- a call printing 30,000 lines: at most 2,000 of them stored per second, every other one counted in a notice, so that stored and counted add up to the call's 30,003 lines; and another account calling meanwhile keeps all its lines;
- a 120,000-byte line of euro signs, cut to 5,461 of them;
- the store refusing a function pod and an unlabelled pod in `ff-system`, and accepting one labelled as the backend;
- the collector's permissions: pods and namespaces read, nothing else.

## The operator's monitoring

VictoriaMetrics scrapes the backend's metrics and the platform's: kube-state-metrics, the kubelet, VictoriaLogs, Fluent Bit and itself. vmalert evaluates the alert rules, Alertmanager e-mails them (to a Mailpit in the cluster, in development), and Grafana shows two dashboards ([ADR 0006](adr/0006-operator-monitoring.md), client-readiness plan P-53). The backend doesn't need any of it, so it is not installed by default: its pods use about 200 MiB of the 2 GB node.

**Grafana runs on this machine** in development, not in the cluster: it needs about 250 MiB of its own, which the node doesn't have beside k3s, the log pipeline and the functions. Squeezed in, it made the node read its files from disk again and again (500 MB a second, the machine's load at 13 to 18) until it was stopped. `hack/k8s/grafana.sh` runs the cluster's Grafana otherwise: the same image, the settings read from its Deployment, the same data source and dashboards, on the cluster's store through a port-forward. Its Deployment stays in the overlay at no replica.

```bash
hack/k8s/monitoring-up.sh               # install it, its Secrets made for you; safe to re-run
hack/k8s/grafana.sh                     # Grafana on this machine, on the cluster's store: http://localhost:3001 until Ctrl-C
hack/k8s/test-monitoring-rules.sh       # the alert rules' unit tests and the dashboards' queries, in the VictoriaMetrics images; Docker only, seconds
hack/k8s/test-monitoring.sh             # L3: L4's run scraped, every panel with data, the rules loaded, an alert's e-mail (about 12 min)
hack/k8s/monitoring-down.sh             # remove it, with every stored series
```

**The backend on the host** is scraped at this machine's address on the k3d network, which `hack/k8s/host-address.sh` prints (172.18.0.1 here), port 9464. Start it listening there:

```bash
cd BE && FF_METRICS_HOST="$(../hack/k8s/host-address.sh)" npm run start:dev    # or set FF_METRICS_HOST in BE/.env
```

Without it, the backend's panels are empty and the alert "FFBackendDown" fires, which is true: the store can't reach a backend.

**Looking at it:**

```bash
source hack/k8s/env.sh
hack/k8s/grafana.sh &                                                  # http://localhost:3001, admin, the password in hack/.kube/grafana-admin-password
kubectl -n ff-monitoring port-forward svc/mailpit 8026:8025 &          # http://localhost:8026: the alerts' e-mails
kubectl -n ff-monitoring port-forward svc/vmalert 8880:8880 &          # http://localhost:8880: each rule, and what fires
kubectl -n ff-monitoring port-forward svc/victoria-metrics 8428:8428 & # http://localhost:8428/vmui: any query
```

**The dashboards and the rules are in git** (`deploy/k8s/monitoring/base/dashboards/`, `rules/`), read-only in Grafana: change the JSON or the YAML, run `hack/k8s/test-monitoring-rules.sh`, then `monitoring-up.sh` again. The ConfigMaps' names carry their content's hash, so Grafana or vmalert restarts with the change. A new rule needs its unit test in `rules/tests/`: series written as the store would have them, and the alert expected when it must fire and when it must not.

**The L3 test** checks the stack's permissions (`kubectl auth can-i` as its ServiceAccounts) and its NetworkPolicies (a pod in a throw-away namespace reaches the API server, and neither the store, Alertmanager nor Mailpit). It then runs L4 with its backend's metrics on the scraped address, so stop a development backend listening there first, and starts Grafana as `grafana.sh` does. After the run, it checks:
- the run's backend scraped, and every other target up;
- its values: the calls by outcome (the lost one included), the refusals, its alarm;
- every query of both dashboards answering with data through Grafana's API;
- both rule groups loaded and evaluated without error;
- "FFBackendDown" firing once the run's backend has stopped, and its e-mail in Mailpit, addressed to the operator.

## The platform on a cluster of its own

`hack/e2e-platform.sh` is L4 for `deploy/k8s` (client-readiness plan P-60): it deploys FF on a new k3d cluster, `ff-platform-e2e` (3 GB, ports 58443 and 58080 on this machine), from the manifests alone, and takes a customer's path through the edge. It doesn't touch the dev cluster, and removes everything it made on exit; it needs about 5 GB free, and 15 minutes.

1. It builds the four images (`ff-backend`, `ff-console`, `ff-admin`, `ff-edge`, tagged `e2e`) and imports them with the code registry's (Zot, as the platform pins it), and installs gVisor in the cluster with `hack/k8s/gvisor-up.sh`, as production requires it for functions. The cluster is made with its node told where code images are, as an operator tells each node (`registries.yaml`: `registry.ff.internal` at the registry's fixed address, as `ff-node`).
2. PostgreSQL, S3 and Mailpit run as containers on the cluster's Docker network, outside it, as in production. Their passwords are made for the run; the backend gets none of development's.
3. It applies `deploy/k8s/base` and `logging`. `deploy.sh` must first refuse a sandbox the cluster lacks, and one no node is labelled to run; then it runs `deploy/k8s/platform/deploy.sh hack/k8s/platform-e2e`. That overlay holds hostnames under `ff.test`, function URLs under `fn.ff.test` with their certificates on demand, TLS from Caddy's own authority, and the development realm for its test client.
4. It checks:
   - TLS and HSTS on the four hostnames, verified against the edge's root, and plain HTTP sent to HTTPS with a 308;
   - `/readyz`, and the login's public issuer;
   - the admin app and Keycloak's administration refused, then admitted once this machine's address is allowed;
   - a customer made, signed in, asking for an account; the operator told by e-mail through the cluster's SMTP, then approving;
   - the backend's token for the cluster's API, read in its pod, lasting an hour;
   - a function deployed and invoked in direct mode, its inline code an image from the platform's registry, answering from gVisor's kernel, and its logs;
   - a function made from a package, its code image pushed to the platform's registry and pulled by the node under the name it maps, answering from its package; a second from the same package, whose own code can't reach the registry;
   - the audit log naming the caller's address, not the edge's;
   - a function URL over HTTPS through the edge, its certificate made on demand once the backend said yes, the function told the caller's address; no certificate for a host that is no URL;
   - an ordinary pod reaching the edge, and not the backend, its port for function URLs, Keycloak, the console, the code registry or a function;
   - `deploy.sh` run again changing nothing.

```bash
hack/e2e-platform.sh
```

## Credentials

Everything lives in `hack/.kube/` (git-ignored, mode 0700, files 0600):

| File | Identity | Use |
|---|---|---|
| `ff-dev.kubeconfig` | cluster admin | Setup and debugging only |
| `ff-controller.token`, `ca.crt` | ServiceAccount `ff-system/ff-controller` | **What the backend uses** (`K8S_TOKEN_FILE`, `K8S_CA_FILE`) |
| `ff-controller.kubeconfig` | the same ServiceAccount | Run kubectl with exactly the backend's permissions: `kubectl --kubeconfig hack/.kube/ff-controller.kubeconfig …` |

The token is valid for 24 hours. Renew it with `hack/k8s/mint-token.sh`, which also prints the `K8S_*` settings for `BE/.env`.

## What the backend may do

See [`deploy/k8s/README.md`](../deploy/k8s/README.md). In short:
- RBAC grants only what function lifecycle needs: no secrets, no pod exec, no role management. Its reads reach across the cluster, so credentials live in Secrets only, and the backend's token in the platform lasts an hour.
- An admission policy confines every write to `ff-t-*` namespaces labelled `app.kubernetes.io/managed-by=ff-controller`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `resources: FAIL …` | Free memory or disk first. Don't override the thresholds to push through. |
| `port 6550 already in use` | Set `FF_API_PORT=6551` (also exported by `env.sh`), then re-run `cluster-up.sh` and `mint-token.sh`. |
| `kubectl: command not found` after `source` | Source from the repository root: `source hack/k8s/env.sh`. |
| `Unauthorized` from the backend after a day | The token expired: run `hack/k8s/mint-token.sh`. |
| System pods stuck in `ContainerCreating` | Images are still being pulled inside the node; `kubectl -n kube-system get events` shows progress. |
| `hack/e2e.sh`: `FAIL backend answers on …` with an empty backend log | The backend was still loading its modules. On a spinning disk with a cold page cache that alone took 23 s. The script waits up to 180 s; raise it with `FF_E2E_BACKEND_START_SECONDS`. |
| `GET /functions/:id/logs` answers 503, and the backend logs `The logs of function … could not be read` | The log store isn't running or reachable. `kubectl -n ff-system get pods -l app.kubernetes.io/name=victoria-logs`; on a cluster made with `--no-logging` or before P-43, run `hack/k8s/logging-up.sh`. A failed deploy then names its load error again too. |
| Fluent Bit logs `no upstream connections available to victoria-logs…` right after `logging-up.sh` | It started before VictoriaLogs was ready. It retries each chunk (10 times, for an hour or two in all), and the chunks wait on the node's disk: nothing is lost. |
| Grafana's backend panels are empty, and "FFBackendDown" fires | No backend listens where the store scrapes it: start the backend with `FF_METRICS_HOST="$(hack/k8s/host-address.sh)"`. On the cluster's side, `kubectl -n ff-monitoring get endpointslice ff-backend-dev` must hold that address; `monitoring-up.sh` writes it. |
| "FFNodeMemoryHigh" fires in development | It is true: the 2 GB node holds k3s, the log pipeline, the monitoring and the functions. Remove the monitoring when you don't need it (`monitoring-down.sh`), or make the cluster with more (`FF_NODE_MEMORY=3g`, before `cluster-up.sh` creates it). Don't scale Grafana up in it: run `hack/k8s/grafana.sh`. |
| The machine slows down, and `docker stats` shows the k3d node reading hundreds of MB a second | The node is at its memory cap and reads its programs' files from disk again and again. Find the largest pods (`hack/k8s/grafana.sh` runs Grafana outside it) and remove what you don't need: the monitoring, or old functions. |
| `hack/k8s/test-monitoring.sh`: `something already listens on …:9464` | A development backend listens where L3's run must: stop it, or give the test another port with `FF_DEV_METRICS_PORT` and `monitoring-up.sh` the same. |
| Function pods in `ImagePullBackOff` for `ff-runtime-*` | kubelet's image GC deleted the imported image; it has no registry to re-pull from. GC runs when the disk passes the high threshold, which this cluster raises from 85% to 95% (`FF_IMAGE_GC_HIGH_THRESHOLD`). Re-import with `hack/k8s/load-images.sh`; `hack/k8s/test-it.sh` does this automatically. |
