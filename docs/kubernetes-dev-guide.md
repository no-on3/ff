# Kubernetes development guide

FF runs functions on Kubernetes ([ADR 0001](adr/0001-orchestrator-kubernetes.md)). This guide covers the local development cluster. The migration itself is tracked in the [migration plan](kubernetes-migration-plan.md).

## Requirements

| Resource | Needed | Why |
|---|---|---|
| Docker | 24+ | k3d runs the k3s node as a container |
| Free memory | ≥ 3 GB when creating the cluster | The node is capped at 2 GB (`FF_NODE_MEMORY`); it idles at about 370 MiB |
| Free disk (Docker filesystem) | ≥ 6 GB | k3s image plus images pulled inside the node (about 1 GB in total) |
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
hack/k8s/cluster-up.sh             # create (or start) the cluster, apply deploy/k8s/base, mint credentials
hack/k8s/test-rbac.sh              # verify RBAC and the admission policy (25 checks)
hack/k8s/cluster-down.sh           # delete the cluster and the local credentials
```

`cluster-up.sh` creates k3s v1.37.1 with:
- one server node, no agents, and no load balancer container;
- the API on `127.0.0.1:6550`;
- a 2 GB node memory cap;
- Traefik and metrics-server disabled.

It is safe to re-run.

## Runtime images and integration tests

Function pods use the FF runtime images (`ff-runtime-nodejs:24-v1`, …). In development they are built locally and imported into the cluster, so no registry is needed:

```bash
runtimes/nodejs/test/container-smoke.sh   # builds ff-runtime-nodejs:24-v1 and checks it hardened
hack/k8s/load-images.sh                   # imports every local ff-runtime-* image into ff-dev
hack/k8s/test-it.sh                       # L3: re-imports the images, then runs BE `npm run test:it` (~75 s)
```

`npm run test:it` deploys real functions with the `ff-controller` token into a throw-away `ff-t-*` namespace. It checks:
- deploy and invoke;
- a code rollout;
- scale to zero and cold start;
- the tenant network policy (DNS allowed, the API server blocked);
- init-failure diagnostics;
- clean-up.

It deletes everything it creates. The default `npm test` skips these suites.

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
| Function pods in `ImagePullBackOff` for `ff-runtime-*` | kubelet's image GC deleted the imported image; it has no registry to re-pull from. GC runs when the disk passes the high threshold, which this cluster raises from 85% to 95% (`FF_IMAGE_GC_HIGH_THRESHOLD`). Re-import with `hack/k8s/load-images.sh`; `hack/k8s/test-it.sh` does this automatically. |
