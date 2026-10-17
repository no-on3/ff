# Kubernetes development guide

FF runs functions on Kubernetes ([ADR 0001](adr/0001-orchestrator-kubernetes.md)). This guide covers the local development cluster. The migration itself is tracked in the [migration plan](kubernetes-migration-plan.md). New to the project? Start with [Getting started](getting-started.md), which takes you from a fresh clone to a working setup and shows the everyday commands.

## Requirements

| Resource | Needed | Why |
|---|---|---|
| Docker | 24+ | k3d runs the k3s node as a container |
| Node.js | 24 | Backend, Node.js runtime tests |
| Python | 3.11+ | Python runtime tests (`python -P`) |
| `curl`, `jq` | any | Smoke tests, e2e |
| `zstd`, `sha512sum` | any | Only for `hack/k8s/gvisor-up.sh` |
| Free memory | ≥ 3 GB to create the cluster or run L3, ≥ 3.5 GB for e2e | The node is capped at 2 GB (`FF_NODE_MEMORY`) and idles at about 370 MiB. Each function pod takes its memory setting (128 MB minimum). |
| Free disk (Docker filesystem) | ≥ 6 GB | The k3s image, the runtime images (195 MB Node.js, 119 MB Python) and their copies imported into the node, plus about 150 MB of gVisor in the node if installed |
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
hack/k8s/cluster-up.sh             # create (or start) the cluster, apply deploy/k8s/dev, mint credentials
hack/k8s/test-rbac.sh              # verify RBAC, the production manifests and the admission policy (31 checks)
hack/k8s/cluster-down.sh           # delete the cluster and the local credentials
```

`cluster-up.sh` creates k3s v1.37.1 with:
- one server node, no agents, and no load balancer container;
- the API on `127.0.0.1:6550`;
- a 2 GB node memory cap;
- Traefik and metrics-server disabled.

It is safe to re-run.

## Runtime images and integration tests

Function pods use the FF runtime images `ff-runtime-nodejs:24-v2` and `ff-runtime-python:3.13-v2` (protocol and handler contracts in [`runtimes/nodejs`](../runtimes/nodejs/README.md) and [`runtimes/python`](../runtimes/python/README.md)). In development they are built locally and imported into the cluster, so no registry is needed:

```bash
runtimes/nodejs/test/container-smoke.sh    # builds ff-runtime-nodejs:24-v2 and checks it hardened
runtimes/python/tests/container-smoke.sh   # builds ff-runtime-python:3.13-v2 and checks it hardened
hack/k8s/load-images.sh                    # imports every local ff-runtime-* image into ff-dev
hack/k8s/test-it.sh                        # L3: re-imports the images, then runs BE `npm run test:it` (~6 min)
hack/k8s/test-it.sh functions.lifecycle    # only the suites whose path matches
```

`npm run test:it` deploys real functions with the `ff-controller` token into a throw-away `ff-t-*` namespace. It checks:
- deploy and invoke;
- a code rollout;
- scale to zero and cold start;
- the tenant network policy (DNS allowed, the API server blocked);
- init-failure diagnostics, and a missing RuntimeClass explained;
- a Python function (deploy, invoke, and Lambda error names);
- a Node.js function in `/var/task` that reads a file next to its code through a relative path;
- a Python and a Node.js memory hog: each gets `Runtime.OutOfMemory`, the next invocation works, and the container is never restarted;
- functions of both runtimes inside gVisor, with the network policy still enforced (only where the `gvisor` RuntimeClass exists; see [Sandboxing with gVisor](#sandboxing-with-gvisor));
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
- **Nothing runs without a tenant.** Until Keycloak login exists (client-readiness plan P-11), development uses `FF_AUTH_MODE=dev`, which acts as the account `FF_DEV_ACCOUNT_ID`, as `.env.example` does. Production refuses this mode. `FF_DEV_USER_ID`, used before 2026-10-17, is no longer read, and the backend says so.
- **What `docker compose up` starts.** Only PostgreSQL and S3. The backend and the dashboard run on the host (`npm run start:dev`, `npm run dev`).
- **S3 storage.** SeaweedFS replaces the MinIO community image, which is no longer published. Its dev credentials are in `infrastructure/seaweedfs/s3.json` (local use only).

## End-to-end test

```bash
hack/e2e.sh                # L4: the whole stack through the REST API (~2 min)
hack/e2e.sh --teardown     # … and delete the cluster afterwards
```

The script starts its own compose project (`ff-e2e`, ports 55432 and 59003), ensures the cluster and runtime images are ready, builds the backend, and starts it on a free port. It then runs:
1. create (waits for ACTIVE);
2. invoke;
3. history (with duration);
4. update (new code live);
5. delete (Deployment gone, record gone);
6. the same create, invoke, and delete for a Python function.

It checks the Kubernetes side at each step. On exit it removes its compose project, including its volumes, and its tenant namespace, and stops the backend. Other projects' containers and volumes are never touched.

## Sandboxing with gVisor

This is optional. With `K8S_RUNTIME_CLASS=gvisor`, every function pod runs in [gVisor](https://gvisor.dev), a user-space kernel that answers the pod's system calls. Tenant code then never talks to the node's kernel directly. This adds a layer on top of the default isolation (non-root, read-only root filesystem, no capabilities, seccomp `RuntimeDefault`, a NetworkPolicy and quota per tenant), for untrusted code. To switch it off, unset the variable. Functions pick up the change at their next deploy or update.

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
| Cold start at 128 MB / 100m CPU, pod created to Ready (Node.js) | about 10 s | 12 to 15 s |

- gVisor reports its own kernel version (4.19.0-gvisor) and implements most, but not all, Linux system calls. Code that inspects kernel features can behave differently.
- The Python runtime's memory budget relies on `RLIMIT_DATA`, which gVisor does not enforce (verified). Under gVisor, a function that outgrows its memory meets the sandbox's limit instead.
- The 10 s cold start without gVisor comes from the 100m CPU limit, which slows every start-up step roughly tenfold. See the migration plan, K-13.

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
- RBAC grants only what function lifecycle needs: no secrets, no pod exec, no role management.
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
| Function pods in `ImagePullBackOff` for `ff-runtime-*` | kubelet's image GC deleted the imported image; it has no registry to re-pull from. GC runs when the disk passes the high threshold, which this cluster raises from 85% to 95% (`FF_IMAGE_GC_HIGH_THRESHOLD`). Re-import with `hack/k8s/load-images.sh`; `hack/k8s/test-it.sh` does this automatically. |
