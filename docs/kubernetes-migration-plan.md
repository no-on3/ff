# FF Orchestrator Migration: Nomad → Kubernetes

| | |
|---|---|
| **Status** | In progress (see §8, Progress log) |
| **Branch** | `feat/k8s-orchestrator` |
| **Decision** | [ADR 0001: Kubernetes as the FF orchestrator](adr/0001-orchestrator-kubernetes.md) |
| **Parent plan** | [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md), ADR-001 and tasks F-02, F-03, F-06, F-08, F-13, F-15, R-06, R-07 |
| **Started** | 2026-10-16 |

This plan replaces HashiCorp Nomad with Kubernetes as the scheduler for FF functions. It also fixes the orchestration defects found in the code review, because the new implementation removes them by construction:
- **C-4**: code injected into Nomad templates;
- **C-5**: delete and update are no-ops;
- the scheduling half of **C-6**: no isolation;
- **H-1**: `npm install` at every container start;
- **H-2**: hard-coded memory;
- **H-3**: fragile invocation;
- **H-6**: broken Python runtime;
- **H-7**: unsafe autoscaler;
- **H-8** and **H-9**: unsafe wrapper;
- **H-12**: MinIO image gone.

Customers are not affected: functions keep the same API, the same console, and the same `handler(event, context)` contract. The Lambda Runtime API agent (R-04 in the parent plan) remains a separate, later piece of work.

---

## 1. Scope

**In scope:**
- An `Orchestrator` abstraction in the backend, with a Kubernetes implementation.
- A Kubernetes dev cluster (k3d), base manifests, RBAC, and an admission policy.
- Hardened runtime images for Node.js and Python (no installs at start, non-root, read-only root filesystem, real timeouts).
- Tenant namespaces with quotas, limits, a default-deny network policy, and the Pod Security "restricted" profile.
- Lifecycle that really works (deploy, update, delete), readiness waiting, scale to and from zero, safe scaling decisions.
- A dev stack that works again (SeaweedFS instead of the discontinued MinIO image), plus an end-to-end test.
- Removal of Nomad code and dependencies.
- An optional gVisor RuntimeClass.

**Out of scope** (still in the parent plan):
- Real authentication and tenancy (C-1 to C-3, F-01). This plan only makes the existing "no auth" development mode *consistent* (K-07).
- Database migrations (C-7, F-04).
- The Lambda Runtime API agent and gateway (R-04, R-05).
- Billing.
- Customer-facing S3/SQS services.

---

## 2. Decision summary

- **Kubernetes** (k3s in development and FF Cloud; RKE2 is the recommended distribution for on-prem banks and government). The reasons are recorded in ADR 0001.
- FF uses Kubernetes **only as a scheduler**. Customers never see Kubernetes objects, and no serverless framework's function format is adopted.
- **Own minimal API client** instead of `@kubernetes/client-node`, because:
  - The official client 2.0 is ESM-only, which conflicts with the CommonJS NestJS build and the Jest setup.
  - FF needs about ten API calls.
  - FF authenticates with ServiceAccount tokens only.

  The client is small, typed, and unit-tested, and has zero runtime dependencies.

---

## 3. Target architecture

```
Development (host)                                  k3d cluster "ff-dev" (k3s v1.37.1)
┌──────────────────────────────┐   HTTPS + SA token ┌──────────────────────────────────────────────────────┐
│ NestJS backend (PORT=3100)   │ ─────────────────▶ │ API server 127.0.0.1:6550                            │
│  OrchestratorModule          │   (API-server      │  ns ff-system: SA ff-controller, RBAC,               │
│   └ KubernetesOrchestrator   │    service proxy   │               ValidatingAdmissionPolicy             │
│      └ KubeClient            │    for invokes)    │  ns ff-t-<tenant-hash>:                              │
│ PostgreSQL ◀─ compose        │                    │   ResourceQuota · LimitRange · NetworkPolicy(deny)   │
│ SeaweedFS S3 ◀─ compose      │                    │   per function:                                      │
└──────────────────────────────┘                    │    ConfigMap fn-<id>-<codehash> (immutable code)     │
                                                    │    Deployment fn-<id>  ─ pod: ff-runtime-<lang>      │
                                                    │    Service fn-<id> :8080 (http)                      │
                                                    └──────────────────────────────────────────────────────┘
Production: the backend runs inside the cluster (namespace ff-system), uses its mounted ServiceAccount token,
and calls functions directly at http://fn-<id>.<ns>.svc:8080 (K8S_INVOKE_MODE=direct).
```

**Function pod** (runtime protocol v1):
- The main thread serves `GET /healthz` (liveness), `GET /readyz` (the user module is loaded), and `POST /invoke`.
- The user code runs in a **worker thread** (Node.js) or **worker process** (Python), one invocation at a time, as on Lambda.
- On timeout, out-of-memory, or crash, the worker is terminated and recreated. The main thread stays responsive, so probes keep working.

---

## 4. Conventions

### 4.1 Names, labels, annotations

| Object | Name | Notes |
|---|---|---|
| Tenant namespace | `ff-t-<first 12 hex of sha256(userId)>` | Deterministic and DNS-1123 safe. The raw tenant ID is kept in the annotation `ff.dev/tenant-id`. |
| Code ConfigMap | `fn-<functionId>-<first 10 hex of codeHash>` | `immutable: true`. A new code version means a new ConfigMap. The current and previous versions are kept; older ones are garbage-collected. |
| Deployment / Service | `fn-<functionId>` | Function IDs are lowercase UUIDs, so names are ≤ 39 characters and start with a letter (valid DNS-1035 for Services). |
| Tenant guardrails | `ff-tenant-quota`, `ff-tenant-limits`, `ff-default-deny` | Applied (server-side apply) on every deploy; idempotent. |

| Label / annotation | Value |
|---|---|
| `app.kubernetes.io/managed-by` | `ff-controller`, on every object FF creates (also checked by the admission policy) |
| `app.kubernetes.io/name` | `ff-function` |
| `ff.dev/function-id` | function UUID (selectors and garbage collection use it) |
| `ff.dev/runtime` | `nodejs` or `python` |
| `ff.dev/tenant-hash` | the 12-hex tenant hash, on namespaces |
| `ff.dev/code-sha256` (pod-template annotation) | full code hash; any code change triggers a rolling update |
| `pod-security.kubernetes.io/enforce`, `warn`, `audit` | `restricted`, on tenant namespaces |

### 4.2 Pod security baseline (every function pod)
- `automountServiceAccountToken: false`, `enableServiceLinks: false`.
- Pod `securityContext`: `runAsNonRoot: true`, `runAsUser/runAsGroup/fsGroup: 10001`, `seccompProfile: RuntimeDefault`.
- Container `securityContext`: `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: ["ALL"]`.
- Volumes:
  - the code ConfigMap is mounted read-only at `/var/task` (mode 0444);
  - an `emptyDir` with `sizeLimit` (512 Mi by default) is mounted at `/tmp`;
  - nothing else.
- `runtimeClassName`: set when `K8S_RUNTIME_CLASS` is configured (for example `gvisor`, K-11).
- `terminationGracePeriodSeconds`: function timeout + 5 s, so in-flight invocations finish on scale-down.

### 4.3 Resource model
- **Memory:** request = limit = `function.memory` MiB.
- **CPU:** request = limit = `max(100, round(memory / 1769 × 1000))` millicores, matching Lambda's proportional CPU (1,769 MB ≈ 1 vCPU, about 6 vCPU at 10,240 MB).
- **Tenant ResourceQuota** (configurable defaults):
  - `pods: 20`;
  - `requests.cpu`/`limits.cpu: 8`;
  - `requests.memory`/`limits.memory: 8Gi`;
  - `configmaps: 60`;
  - `services: 30`.
- **LimitRange:** a default and maximum per container (maximum 10,240 Mi and 6 CPU), so no pod can run unbounded.

### 4.4 Network policy (`ff-default-deny`, per tenant namespace)
- **Ingress** is allowed only from namespace `ff-system`, plus any CIDRs in `K8S_INGRESS_ALLOW_CIDRS` (development: the API-server proxy source, if the policy engine blocks it).
- **Egress** is allowed to:
  - DNS (kube-system, `k8s-app=kube-dns`, UDP/TCP 53);
  - the internet (`0.0.0.0/0`), when `K8S_EGRESS_INTERNET=true`.
- **Blocked egress ranges** (the `except` list): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`. This covers pod and service CIDRs, node IPs, the API server, and metadata endpoints.

### 4.5 Backend configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ORCHESTRATOR` | `kubernetes` (from K-07; `nomad` before) | Driver selection |
| `K8S_API_URL` | in-cluster `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` | API server |
| `K8S_TOKEN_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Bearer token, re-read every 60 s (projected tokens rotate) |
| `K8S_CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API server CA |
| `K8S_INVOKE_MODE` | `direct` in-cluster, `proxy` outside | How function pods are reached |
| `K8S_NAMESPACE_PREFIX` | `ff-t-` | Tenant namespace prefix (must match the admission policy) |
| `K8S_RUNTIME_IMAGE_NODEJS` / `_PYTHON` | `ff-runtime-nodejs:24-v1` / `ff-runtime-python:3.13-v1` | Runtime images |
| `K8S_IMAGE_PULL_POLICY` | `IfNotPresent` | |
| `K8S_RUNTIME_CLASS` | *(empty)* | For example `gvisor` |
| `K8S_READY_TIMEOUT_SECONDS` | `90` | Wait for rollout on create/update; also used for cold start from zero |
| `K8S_EGRESS_INTERNET` | `true` | Allow internet egress from functions |
| `K8S_INGRESS_ALLOW_CIDRS` | *(empty)* | Extra ingress sources (comma-separated) |
| `K8S_TENANT_QUOTA_PODS` / `_CPU` / `_MEMORY` | `20` / `8` / `8Gi` | Tenant ResourceQuota |
| `FF_SCALE_TO_ZERO_IDLE_SECONDS` | `900` | Idle time before an eligible function is scaled to zero |
| `FF_DEV_USER_ID` | *(empty)* | **Development only.** Tenant used when no authenticated user exists (K-07). |

### 4.6 Pinned versions

| Component | Version | Notes |
|---|---|---|
| kubectl | v1.37.1 | SHA-256 verified against `dl.k8s.io` |
| k3d | v5.9.0 | SHA-256 verified against the release checksums |
| k3s image | `rancher/k3s:v1.37.1-k3s1` | |
| Node.js runtime base | `node:24-alpine` | Node 24 LTS = Lambda `nodejs24.x`; the digest is recorded in the runtime README |
| Python runtime base | `python:3.13-slim` | Lambda `python3.13` |
| TypeScript (in-runtime transpiler) | 5.7.3 | Same as the backend |
| gVisor (optional, K-11) | release `20260928.0` | SHA-512 checked against the release bucket; installed by `hack/k8s/gvisor-up.sh` |
| SeaweedFS | `chrislusf/seaweedfs:4.48` | Index digest `sha256:4e61d15f…7872d`, identical to the cached `latest`, so pinning downloads nothing |

---

## 5. Working rules

### 5.1 Resource-safety protocol
The development machine is shared, so:
- Docker's data root sits on a filesystem with about 16 GB free.
- Other projects' containers are running there and **must not be touched**: no prune, no `down -v` on other projects, no `docker volume rm`.

The rules:
1. Run `hack/check-resources.sh` **before every heavy step**: npm install, image pull or build, cluster create, image import, integration tests, e2e. **Stop when it fails.**
2. Run **one heavy operation at a time**: no parallel builds or tests, and no background agents for implementation.
3. Cap the cluster: `--servers-memory 2g` on the k3d node, Traefik and metrics-server disabled, 1 server and 0 agents. Function pods have memory and CPU limits, and every tenant has a ResourceQuota.
4. End-to-end tests use their **own** compose project name (`ff-e2e`) and non-default ports, and remove only their own volumes.
5. Background processes started by scripts are killed via `trap` on exit.

### 5.2 Git workflow
- **Branch:** `feat/k8s-orchestrator`, created from `master`. No remote, so nothing is pushed.
- **K-00 baseline:** a snapshot commit of the pre-existing uncommitted work, so that each task commit contains only that task's changes.
- **One commit per task:** `type(scope): summary (K-xx)`. The body describes what changed, the tests run with their results, and the docs updated.
- **Each commit must pass:**
  - `BE: npx tsc --noEmit`;
  - `BE: npm test`;
  - the task's own tests.

### 5.3 Test levels

| Level | What | Tool | When |
|---|---|---|---|
| L0 | Type-check and build | `tsc --noEmit`, `nest build` | Every task |
| L1 | Unit tests | Jest (backend), `node:test` / `unittest` (runtimes) | Every code task |
| L2 | Container smoke tests | `docker run` with production hardening flags | Runtime tasks |
| L3 | Cluster integration | Jest suite gated by `K8S_IT=1`, against k3d | K-06 onward |
| L4 | End-to-end | `hack/e2e.sh`: compose + cluster + backend + REST calls | K-08 onward |

### 5.4 Definition of done (per task)
1. The code and configuration are implemented.
2. The listed tests pass, and the results are written into the commit message and the progress log (§8).
3. The docs are updated: this plan's progress log plus the task-specific docs.
4. The commit is made on the branch.
5. A resource check passes, and no stray processes or containers are left running.

---

## 6. Tasks

### K-00: Preparation and guardrails ✅
- **Goal:** isolate the migration work and protect the machine.
- **Steps:**
  - Create the branch.
  - Make the baseline snapshot commit.
  - Add `hack/check-resources.sh`: free space on Docker's and the repository's filesystems, `MemAvailable`, and load average against `nproc`. All thresholds can be overridden by environment variables.
  - Ignore `hack/bin/`, `hack/.kube/`, and `*.kubeconfig`.
- **Tests:**
  - Default thresholds give exit 0.
  - Impossible memory, disk, or load thresholds give exit 1, with one line per violation.
  - The ignore rules match (`git check-ignore`).
- **Rollback:** delete the branch; `master` is untouched.

### K-01: Plan and decision record
- **Goal:** write this plan and ADR 0001, and update the parent plan (ADR-001 is decided).
- **Files:**
  - `docs/kubernetes-migration-plan.md`;
  - `docs/adr/0001-orchestrator-kubernetes.md`;
  - `docs/local-markets-and-aws-portability-plan.md`, which is also committed here (it was written earlier and was still untracked).
- **Tests:**
  - Markdown structure: tables are consistent and code fences balanced (scripted check).
  - Every relative link resolves.
- **Rollback:** revert the commit.

### K-02: Backend test harness
- **Goal:** make Jest usable before refactoring.
- **Design:**
  - In the `jest` section of `BE/package.json`:
    - `moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" }`, because the code uses the `@/` path alias;
    - `testTimeout: 20000`;
    - a `testPathIgnorePatterns` entry for `\.it\.spec\.ts$` in the default run.
  - New script `test:it` (`K8S_IT=1 jest --runInBand --testRegex '.*\.it\.spec\.ts$'`), for L3 tests from K-06 on.
  - First spec: `src/config/configuration.spec.ts`, covering defaults and environment overrides of the pure configuration factory. It proves the harness works, including the alias.
- **Tests:** `npm test` passes with at least one suite; `npx tsc --noEmit` passes.
- **Rollback:** revert.

### K-03: Orchestrator abstraction (no behaviour change)
- **Goal:** make the scheduler swappable. Today FunctionsService and MetricsService call `NomadService` directly.
- **Design:**
  - `src/orchestrator/orchestrator.types.ts`:
    ```ts
    export const ORCHESTRATOR = Symbol('ORCHESTRATOR');
    export interface FunctionWorkload {
      id: string; name: string; userId: string; runtime: 'nodejs' | 'python';
      code: string; memory: number; cpu?: number; timeout: number;
      minInstances: number; maxInstances: number;
    }
    export interface InvokeResult { output: unknown; durationMs?: number; memoryUsedMb?: number; cpuUsed?: number }
    export interface Orchestrator {
      deploy(fn: FunctionWorkload): Promise<void>;          // idempotent create-or-update
      update(fn: FunctionWorkload): Promise<void>;
      remove(fn: FunctionWorkload): Promise<void>;
      waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void>;
      invoke(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<InvokeResult>;
      scale(fn: FunctionWorkload, replicas: number): Promise<void>;
      readyInstances(fn: FunctionWorkload): Promise<number>;
    }
    ```
    Every method takes the workload, not an ID, because Kubernetes needs the tenant (namespace) as well.
  - `src/orchestrator/orchestrator.module.ts`: a provider factory that selects the implementation from `orchestrator.driver` (`ORCHESTRATOR` env). Unknown values fail fast at boot.
  - `src/orchestrator/nomad/nomad.orchestrator.ts`: an adapter delegating to the existing `NomadService`, keeping its current behaviour (including the no-op update and delete). This keeps the change reviewable.
  - FunctionsService and MetricsService inject `ORCHESTRATOR` instead of `NomadService`.
  - MetricsService starts its timer in `onModuleInit` and clears it in `onModuleDestroy`, instead of in the constructor. Same behaviour, but tests no longer leak timers.
- **Tests (L1):** FunctionsService with a fake orchestrator and mocked repositories and storage:
  - create calls `deploy` and leads to ACTIVE; a deploy failure leads to ERROR with the message;
  - remove calls `remove`;
  - invoke maps the orchestrator result onto the invocation record.

  Module wiring: `ORCHESTRATOR=nomad` resolves `NomadOrchestrator`; `ORCHESTRATOR=bogus` throws.
- **Rollback:** revert. There is no runtime change.

### K-04: Local Kubernetes cluster, base manifests, RBAC, admission policy
- **Goal:** a reproducible, resource-capped dev cluster with least-privilege controller identity.
- **Design:**
  - `hack/install-tools.sh`: downloads pinned kubectl and k3d into `hack/bin/` and verifies SHA-256 (the k3d release `checksums.txt`; `dl.k8s.io/…/kubectl.sha256`). Idempotent.
  - `hack/k8s/env.sh`: sets `PATH`, `KUBECONFIG=hack/.kube/ff-dev.kubeconfig`, the cluster name, the k3s image, and the API port 6550. Never touches `~/.kube/config`.
  - `hack/k8s/cluster-up.sh`: runs the resource check (minimum 3,000 MB memory), then:
    ```
    k3d cluster create ff-dev --image rancher/k3s:v1.37.1-k3s1 --servers 1 --agents 0 --no-lb \
      --api-port 127.0.0.1:6550 --servers-memory 2g \
      --k3s-arg "--disable=traefik@server:0" --k3s-arg "--disable=metrics-server@server:0" \
      --k3s-arg "--kubelet-arg=image-gc-high-threshold=95@server:0" \
      --k3s-arg "--kubelet-arg=image-gc-low-threshold=90@server:0" \
      --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 180s
    ```
    It then writes the kubeconfig (mode 0600), waits for the node to be Ready, applies `deploy/k8s/base`, and runs `mint-token.sh`.
  - `hack/k8s/mint-token.sh`: `kubectl -n ff-system create token ff-controller --duration=24h`, written to `hack/.kube/ff-controller.token`, plus the CA written to `hack/.kube/ca.crt` (both 0600). It prints the `K8S_*` variables for the backend. Development thereby exercises the **same least-privilege identity** as production.
  - `hack/k8s/cluster-down.sh`: deletes the cluster and the local credentials.
  - `deploy/k8s/base/` (kustomize):
    - **`ff-system` namespace** with Pod Security "restricted" labels.
    - **ServiceAccount** `ff-controller`.
    - **ClusterRole and binding**, with these verbs:
      - `namespaces`: get, list, watch, create, patch, update, delete;
      - `configmaps`: the same plus `deletecollection`;
      - `services`, `resourcequotas`, `limitranges`, `apps/deployments`, `networking.k8s.io/networkpolicies`: get, list, watch, create, patch, update, delete;
      - `deployments/scale`: get, patch, update;
      - `pods`: get, list, watch; `pods/log`: get;
      - `services/proxy`: get, create.
    - **`ValidatingAdmissionPolicy` `ff-controller-scope` and its binding.** Requests from the `ff-controller` user may only create, update, or delete:
      - Namespaces named `ff-t-*` with label `app.kubernetes.io/managed-by=ff-controller`;
      - namespaced objects whose namespace is such an `ff-t-*` managed namespace.

      This turns the necessarily cluster-wide RBAC into tenant-only write access.
- **Tests (L3, `hack/k8s/test-rbac.sh`):**
  - The node is Ready.
  - As the ServiceAccount, `kubectl auth can-i` returns:
    - yes for create deployments, create `services/proxy`, and get `pods/log` in `ff-t-x`;
    - no for create `clusterroles`, get `secrets`, and create `pods/exec`.
  - With the minted token:
    - creating a ConfigMap in `default` is **denied by the policy**;
    - creating namespace `ff-t-rbactest` (labelled) and a ConfigMap in it is allowed;
    - creating an unlabelled `ff-t-rogue` namespace is denied.
  - Cleanup leaves nothing behind.
- **Docs:** `docs/kubernetes-dev-guide.md` (setup and teardown); `deploy/k8s/README.md` (what each manifest does and why).
- **Rollback:** `hack/k8s/cluster-down.sh`, then revert.

### K-05: Hardened Node.js runtime image (`ff-runtime-nodejs:24-v1`)
- **Goal:** pods start without any install or network access, run as non-root on a read-only filesystem, and enforce timeouts and memory for real.
- **Design** (`runtimes/nodejs/`):
  - **Only dependency: `typescript` (5.7.3).** It is used at runtime to transpile user `.ts` files through a `require` hook (`ts.transpileModule` to CommonJS, ES2022, inline source maps). No Express and no ts-node: the HTTP server is `node:http`.
  - **`src/main.ts` (main thread):**
    - `GET /healthz` → 200.
    - `GET /readyz` → 200 once the worker has loaded the user module; otherwise 503 with `{status, error}`.
    - `POST /invoke`:
      - the body is limited to 6 MB (else 413);
      - optional `X-FF-Request-Id` header;
      - invocations run serially (FIFO queue, `FF_MAX_QUEUE`=32, else 429);
      - the deadline is `FUNCTION_TIMEOUT` ms from the start of execution.
    - Responses:
      - 200 with the JSON result;
      - 500 with `{errorType, errorMessage}`;
      - 504 with `{"errorType":"Sandbox.Timedout","errorMessage":"Task timed out after X.XX seconds"}`;
      - 503 if not ready.
    - Response headers: `X-FF-Request-Id`, `X-FF-Duration-Ms`, `X-FF-Max-Memory-Used-Mb`, and `X-FF-Function-Error: Unhandled` on errors.
  - **`src/worker.ts` (`worker_threads`):**
    - Installs the TypeScript hook and loads `${LAMBDA_TASK_ROOT:-/var/task}/function` (`.ts`, `.js`, or `.cjs`), then checks for the `FF_HANDLER` export (default `handler`).
    - Reports `ready`, or `init_error` with `Runtime.ImportModuleError` / `Runtime.HandlerNotFound`.
    - Per invocation, it builds the FF event (unchanged contract: `{body, headers, method, query, path}`) and a context (`functionName`, `functionVersion`, `memoryLimitInMB`, `awsRequestId`, `getRemainingTimeInMillis()`, computed per invocation). It awaits the handler and posts the JSON-serialized result.
  - **Failure handling:**
    - **Timeout:** `worker.terminate()`, respond 504, and start a fresh worker. This also stops CPU-bound infinite loops, which an in-process timer cannot.
    - **Out of memory:** `resourceLimits.maxOldGenerationSizeMb` ≈ 80% of `FUNCTION_MEMORY_LIMIT`. `ERR_WORKER_OUT_OF_MEMORY` maps to `Runtime.OutOfMemory`, and the worker is recreated.
    - **Crash:** `Runtime.ExitError`, and the worker is recreated.
  - **Logging:**
    - JSON platform logs, plus Lambda-style `START` / `END` / `REPORT` lines.
    - **No environment dump** (fixes H-8).
    - The user's `console.*` output passes through to stdout.
  - **`Dockerfile`:**
    - Two stages on `node:24-alpine`: the build stage runs `npm ci` and `tsc`; the final stage copies `dist/` and the production `node_modules`.
    - `USER 10001`, `ENV LAMBDA_TASK_ROOT=/var/task PORT=8080`, `CMD ["node","/opt/ff/dist/main.js"]`.
    - The base image digest is recorded in the README.
- **Tests:**
  - **L1, `node --test`, no Docker:** spawns `node dist/main.js` on fixtures:
    - `hello` (output and context fields);
    - `js-function` (plain JS);
    - `throws` (500, `Error` type);
    - `async-timeout` (504 within the timeout + 1 s);
    - `busy-loop` (504, then the next call succeeds on a recreated worker);
    - `init-error` (`/readyz` 503 with `Runtime.ImportModuleError`);
    - `no-handler` (`Runtime.HandlerNotFound`);
    - an oversized body (413);
    - two concurrent calls (both succeed, executed serially);
    - a sentinel environment variable never appears in the logs.
  - **L2, `runtimes/nodejs/test/container-smoke.sh`** (after a resource check):
    - build the image;
    - run with `--read-only --tmpfs /tmp --user 10001 --cap-drop ALL --security-opt no-new-privileges -v fixtures/hello:/var/task:ro`;
    - check `/readyz` and `/invoke`, and that the uid is 10001;
    - stop the container.
- **Docs:** `runtimes/nodejs/README.md`: the runtime protocol, environment variables, error types, and limits.
- **Rollback:** revert, and `docker image rm ff-runtime-nodejs:24-v1`.

### K-06: KubernetesOrchestrator and API client
- **Goal:** the Kubernetes driver for every `Orchestrator` method.
- **Design** (`src/orchestrator/kubernetes/`):
  - **`kube-client.ts`:**
    - **Configuration:**
      - Resolved from `K8S_API_URL` / `K8S_TOKEN_FILE` / `K8S_CA_FILE`, or from the in-cluster defaults (§4.5).
      - The token file is re-read every 60 s.
      - Both `https://` and `http://` servers are supported (the latter only for unit tests).
    - **Methods:**
      - `apply(obj)`: server-side apply, `PATCH …?fieldManager=ff-controller&force=true` with `Content-Type: application/apply-patch+yaml` (a JSON body).
      - `get(path)`: returns `null` on 404.
      - `delete(path)`: propagation Background; returns `false` on 404.
      - `deleteCollection(path, labelSelector)`.
      - `scale(ns, name, n)`: a merge-patch on `deployments/{name}/scale`.
      - `listPods(ns, selector)` and `podLog(ns, pod, tailLines)`.
      - `proxyPost(ns, service, portName, path, body, headers, timeoutMs)` through `/api/v1/namespaces/{ns}/services/{svc}:{port}/proxy/{path}`.
    - **Errors:** API failures become `KubeApiError {status, reason, message}`, parsed from the Kubernetes `Status` object.
  - **`naming.ts`:** tenant namespace, object names, code hash.
  - **`manifests.ts`:** pure builders for:
    - Namespace (PSA labels);
    - ResourceQuota and LimitRange;
    - NetworkPolicy (§4.4);
    - the immutable code ConfigMap. It enforces a **900 KiB code limit**; the ConfigMap limit is 1 MiB, and larger code waits for the zip pipeline (R-02).
    - the Deployment (§4.2, §4.3), with:
      - `replicas = max(1, minInstances)` on create;
      - RollingUpdate with `maxUnavailable 0, maxSurge 1`;
      - readiness on `/readyz` and liveness on `/healthz`;
      - `revisionHistoryLimit 2`, `progressDeadlineSeconds 120`;
    - the Service (ClusterIP, port `http` 8080).
  - **`kubernetes.orchestrator.ts`:**
    - **`deploy`/`update`:**
      1. Apply the tenant guardrails.
      2. Apply the code ConfigMap.
      3. Apply the Service and the Deployment.
      4. Garbage-collect ConfigMaps older than the current and previous versions.
    - **`waitUntilReady`:** poll every second until `observedGeneration ≥ generation`, `updatedReplicas = replicas`, and `availableReplicas ≥ 1`. On timeout, throw with diagnostics: the container waiting reasons (`ImagePullBackOff`, `CrashLoopBackOff`, …) and the last 20 log lines.
    - **`invoke`:**
      - if `readyInstances = 0`, scale to 1 and wait (cold start from zero);
      - then POST `/invoke` through the transport (`proxy` or `direct`), with a timeout of the function timeout + 2 s;
      - map 200 to the output; map 500 and 504 to typed errors (`FunctionRuntimeError`, `FunctionTimeoutError`).
    - **`remove`:** delete the Deployment and the Service, then `deleteCollection` the ConfigMaps by label. The tenant namespace stays.
    - **`scale`** and **`readyInstances`:** the scale subresource, and `status.readyReplicas`.
- **Tests:**
  - **L1:**
    - naming: deterministic, DNS-safe, ≤ 63 characters;
    - manifests: every security-context field; CPU formula clamps (128 → 100 m, 1769 → 1000 m, 10240 → 5789 m); labels and annotations; immutable ConfigMap names; size limit; optional `runtimeClassName`; PSA labels; network-policy ingress, egress, and except-ranges;
    - client, against a local plain-HTTP fake API server: SSA method, path, query and content type; 404 semantics; Status-error parsing; token reload;
    - orchestrator with a fake client: apply order, garbage-collection selection, delete calls, scale from zero, error mapping.
  - **L3** (`npm run test:it`, cluster plus imported image, after a resource check):
    1. Deploy `hello`, wait until ready (≤ 90 s), invoke and get the output.
    2. Update the code and get the new output.
    3. Scale to 0, then invoke: it is served again via cold start.
    4. Invoke a function that tries the API-server ClusterIP (10.43.0.1) or a node IP: the call is **refused or times out** (network policy).
    5. Remove the function: the Deployment returns 404 and no ConfigMaps are left.
- **Rollback:** revert. The driver is still not the default until K-07.

### K-07: Wire the services to Kubernetes, safe scaling, consistent dev tenancy
- **Goal:** make Kubernetes the default driver, with correct lifecycle and records.
- **Design:**
  - **Configuration:** `ORCHESTRATOR` defaults to `kubernetes`; `.env.example` documents every `K8S_*` variable.
  - **FunctionsService:**
    - **create:** save → store the code in S3 (archive) → `deploy` → `waitUntilReady` → ACTIVE. On failure: ERROR, with the diagnostics as the message.
    - **update:** a change to code, runtime, memory, or timeout triggers `update` + `waitUntilReady`.
    - **remove:** a real orchestrator delete, then S3, then the database.
    - **invoke:** persist `duration` and `memoryUsed` (fixes H-5); map `FunctionTimeoutError` to the `TIMEOUT` status.
  - **Dev tenancy:** `@User()` resolves `request.user ?? FF_DEV_USER_ID`. `create` uses the resolved ID instead of the hard-coded `'1'`; without either, it returns 401. Update and delete then pass their existing ownership checks. This is an interim measure until F-01, documented as development-only.
  - **MetricsService:**
    - Extract a pure `decideReplicas()`: it clamps to `[minInstances, maxInstances]`, guards against division by zero, and ignores CPU (the Kubernetes driver has no per-invocation CPU ticks).
    - Use `orchestrator.readyInstances` and `scale`.
    - Add an idle sweep: with `scaleToZero && minInstances = 0`, scale to 0 once idle for `FF_SCALE_TO_ZERO_IDLE_SECONDS`, based on an in-memory last-invoked timestamp.
- **Tests:**
  - **L1:**
    - `decideReplicas` table tests: zero instances, bounds, scale up and down, the CPU-ignored case;
    - FunctionsService transitions (ACTIVE / ERROR / TIMEOUT), duration persisted;
    - `@User()` resolution (authenticated user, dev fallback, and 401).
  - **L3:** the K-06 suite still passes.
- **Rollback:** set `ORCHESTRATOR=nomad`, or revert.

### K-08: Dev stack repaired (SeaweedFS) and end-to-end test
- **Goal:** `docker compose up` works again on a fresh machine, and a single script proves the full flow.
- **Design:**
  - **`docker-compose.yml`:**
    - Replace `minio/minio` (gone from Docker Hub) with SeaweedFS (`weed server -s3`; the pinned tag is the locally cached version). Its S3 identities come from `infrastructure/seaweedfs/s3.json` (dev credentials only).
    - Parametrize the host ports: `${FF_PG_PORT:-5432}` and `${FF_S3_PORT:-9003}` (port 8333 is taken by another project on this machine).
    - Move Prometheus, Grafana, and the backend/frontend containers under the `full` profile, so the default `up` starts only PostgreSQL and S3.
    - Drop the obsolete `version:` key.
  - **`hack/e2e.sh`:**
    1. Resource check.
    2. `docker compose -p ff-e2e up -d postgres s3` on ports 55432 and 59003, then wait until healthy.
    3. Make sure the cluster exists and the runtime image is imported; mint a token.
    4. `npm run build`, then start the backend (`PORT=3100`) in the background, with a `trap` to stop it.
    5. Wait for HTTP.
    6. Run the scenario:
       - create the `hello` function → ACTIVE;
       - invoke → expected output, and `duration > 0` in the history;
       - update the code → new output;
       - delete → the Kubernetes objects are gone.
    7. Tear down **only** the `ff-e2e` compose project (`down -v`). The cluster is kept unless `--teardown` is given.
- **Tests:** L4 `hack/e2e.sh` passes; L1 and L3 suites still pass.
- **Docs:** the dev guide gets "running the full stack" and "e2e" sections.
- **Rollback:** revert. The old compose file is in git history.

### K-09: Remove Nomad
- **Goal:** no dead scheduler code, fewer dependencies, smaller attack surface.
- **Steps:**
  - **Delete:**
    - `src/nomad/*` and `src/orchestrator/nomad/*`;
    - `BE/script.ts` and `src/types/chatsight__hostel.d.ts`;
    - `BE/templates/` (superseded by `runtimes/`), along with its `COPY` in `BE/Dockerfile`;
    - the per-function `package.json` and `tsconfig.json` uploads, which only Nomad read.
  - **Uninstall** `@chatsight/hostel`, `@pulumi/nomad`, and `@pulumi/pulumi`, after a resource check.
  - **Clean up:** remove the `nomad.*` configuration keys. The driver factory accepts only `kubernetes`.
  - **Docs:** update the README and docs to describe Kubernetes. `nomad-vagrant/` stays untouched (the user's environment) and is marked deprecated in the docs.
- **Tests:** L0, L1, L3, L4 all pass; `npm ls` shows no Nomad or Pulumi packages.
- **Rollback:** revert (the lockfile is restored from git).

### K-10: Python runtime (`ff-runtime-python:3.13-v1`)
- **Goal:** fix H-6 with the same protocol and hardening as Node.js.
- **Design** (`runtimes/python/`):
  - Standard library only.
  - The main process runs a `ThreadingHTTPServer`, so probes stay responsive.
  - Invocations are serialized through a lock, with a bounded queue (429 beyond `FF_MAX_QUEUE`).
  - User code runs in a worker process, `python -P -m ff_runtime.worker`, connected by a socket pair that carries length-prefixed JSON messages. It is killed and recreated on timeout, out-of-memory, or exit. *Changed from the original design* (`multiprocessing` with the spawn context): spawn starts an extra resource-tracker process in every container and re-imports the main module in the child. A plain subprocess avoids both and reports the worker's exit status directly.
  - Memory: after user code loads, the worker sets `RLIMIT_DATA` to its current data size plus a budget: the function's memory, minus what the container already uses, minus 32 MB for the main process. Allocations beyond it become `Runtime.OutOfMemory`, and the container lives on; on Kubernetes the container limit equals the function memory, and reaching it kills the whole container. Python threads get 2 MB stacks, because stacks count toward the limit. The worker's `oom_score_adj` is 1000. *Corrected after K-10*: the first version allowed the full function memory on top of the loaded size, so on Kubernetes the container was killed first. A worker restart is also no longer tied to the request thread (`PR_SET_PDEATHSIG` fires on thread exit), and connection threads can no longer freeze the accept loop.
  - The handler signature is **Lambda's** `handler(event, context)`. The old Python wrapper called `handler(event)` and never worked, so there are no existing users to break.
  - The context has Lambda's attribute names: `function_name`, `function_version`, `memory_limit_in_mb` (a string), `aws_request_id`, `get_remaining_time_in_millis()`, and the rest. The working directory is the task root, as on Lambda.
  - The image is `python:3.13-slim` (glibc, so Lambda's `manylinux` wheels work), with a non-root user and a read-only root filesystem.
  - In the backend, the runtime selects the image and file name: `function.ts` or `.js` for Node.js, `function.py` for Python. This was already in place from K-06.
- **Tests:**
  - L1: `python -m unittest` against fixtures, with the same scenarios as Node.js;
  - L2: a container smoke test;
  - L3: deploy and invoke a Python function on k3d;
  - L4: the e2e script also creates, invokes, and deletes a Python function through the REST API.
- **Rollback:** revert, and remove the image.

### K-11: gVisor RuntimeClass (optional isolation layer)
- **Goal:** make sandboxed execution a configuration switch.
- **Design:**
  - `deploy/k8s/optional/runtimeclass-gvisor.yaml`:
    - `handler: runsc`;
    - `scheduling.nodeSelector: ff.dev/gvisor=true`, so pods only land on nodes that have gVisor;
    - `overhead.podFixed` 40Mi / 25m. This is measured: the Sentry adds 29–36 MiB to an idle pod, and it runs in the pod's cgroup, so without the overhead it would use part of the function's memory.
  - `K8S_RUNTIME_CLASS=gvisor` sets `runtimeClassName` on function pods (from K-06).
  - A missing RuntimeClass no longer surfaces as a silent timeout: the readiness diagnostics now include the Deployment's `ReplicaFailure` message.
  - `hack/k8s/gvisor-up.sh` (development):
    - pins release 20260928.0, at least two weeks old;
    - checks the release tarball's SHA-512 and extracts only `runsc`, the shim, and the `gvisor-bin/` sidecars, which this release requires;
    - installs them into the k3d node and adds a containerd drop-in (`config-v3.toml.d/10-gvisor.toml`);
    - restarts the cluster only when that changes;
    - applies the RuntimeClass, labels the node, and checks the result with a pod.
  - The dev guide documents installation on real k3s, RKE2, and containerd nodes, with a verification checklist.
  - *Corrected:* the original plan said k3d nodes can't run gVisor. They can. The nodes are privileged containers, and gVisor's default `systrap` platform needs no KVM.
- **Tests:**
  - L1: `runtimeClassName` only when configured (K-06); `ReplicaFailure` diagnostics.
  - L3: `hack/k8s/test-it.sh` runs the sandboxed case wherever the RuntimeClass exists. Node.js and Python functions must report gVisor's kernel, and the NetworkPolicy must still hold. A missing RuntimeClass must be explained.
  - L4: `K8S_RUNTIME_CLASS=gvisor hack/e2e.sh` checks the Deployments' `runtimeClassName`.
- **Rollback:** unset the variable. Functions return to runc at their next deploy or update.

### K-13: Cold-start performance (proposed, not started)
- **Found in K-11.** At the smallest size, 128 MB with a 100m CPU limit and request equal to limit, a pod takes about 10 s from creation to Ready, even without gVisor (measured on k3d). Breakdown:
  - Node.js: 7.8 s from listening to initialized for a `.ts` function, and 5.9 s for a `.js` one. `ts-hook.ts` imports the TypeScript compiler (about 9 MB of JavaScript) eagerly, and FF stores every Node.js function as `function.ts`.
  - Python: 3.9 s to listening and 1.3 s to initialized.
  - The 0.1 CPU limit slows every one of these start-up steps roughly tenfold.
- **Options:**
  1. CPU burst. Keep the proportional CPU *request*, but set a higher *limit*, for example 1 CPU. This would have the biggest effect for every runtime. It is a product decision: it affects tenant fairness, and it moves away from Lambda's strictly proportional CPU.
  2. Node.js: bake a V8 compile cache (`NODE_COMPILE_CACHE`) for the runtime and TypeScript into the image, and load TypeScript only for `.ts` files.
  3. Python: defer heavy imports in the main process, such as `http.server`'s email parsing.
  4. Minimum instances and warm pools (parent plan S-02) hide the remaining cold starts.
- **Tests:** a cold-start benchmark (pod created to first successful invocation) per runtime and size, as an L3 report.

### K-12: Documentation and plan synchronization
- **Goal:** the documentation matches reality.
- **Steps:**
  - Finish the dev guide: requirements (RAM, disk), commands, troubleshooting.
  - Rewrite the README: what exists today, the Kubernetes quick start, the test commands.
  - In the parent plan: mark ADR-001 as decided, replace F-13 with K-04/K-06, update the §4.10 orchestrator row and risk R1, and link here.
  - Close this plan's progress log.
- **Tests:** the docs link check and the markdown check pass, and all commands quoted in the guide were run during the tasks.

---

## 7. Migration-specific risks

| Risk | Mitigation |
|---|---|
| Kubernetes operational complexity for a small team | k3s (a single binary); `hack/` scripts encode every operation; a managed Kubernetes offer from a data-center partner remains an option |
| The custom API client misses edge cases | Only stable v1 APIs are used (core, apps, networking, admissionregistration); unit tests against a fake API server; L3 tests against a real k3s |
| The network-policy engine blocks the development proxy path | **Checked in K-06: not blocked on k3s**. API-server proxy calls reach pods under the default-deny policy. `K8S_INGRESS_ALLOW_CIDRS` remains for other CNIs; production uses `direct` mode from `ff-system`. |
| The ConfigMap code limit (1 MiB) | 900 KiB limit enforced with a clear error. The zip artifact pipeline (parent plan R-02) lifts it. |
| Machine overload during tests | §5.1 protocol, capped node memory, quotas, one heavy step at a time |
| Cold start from zero is slow | Readiness-gated waits; minimum instances; warm pools later (parent plan S-02). Measured in K-11: about 10 s at 128 MB / 100m, mostly CPU-limited start-up. Options are in K-13. |

---

## 8. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| K-00 Preparation | ✅ Done | `0f1ced0` (baseline snapshot), `992cd63` | Resource guard: exit 0 at defaults, exit 1 on each violated threshold; ignore rules verified |
| K-01 Plan and ADR | ✅ Done | `e197d16` | `hack/check-docs.py` passes on this plan, ADR 0001, and the parent plan; a negative test catches a bad table row, a broken link, and an unclosed fence |
| K-02 Test harness | ✅ Done | `c26a44b` | `tsc --noEmit` exit 0; `npm test`: 1 suite, 3 tests pass, imported through the `@/` alias; `npm run test:it` selects only `*.it.spec.ts` (none yet) |
| K-03 Orchestrator abstraction | ✅ Done | `7acb5f7` (build fix found while verifying), `9ed8dd1` | `tsc` exit 0; `npm test`: 4 suites, 15 tests; `NomadService` is referenced only by its driver; `nest build` now emits `dist/main.js` (it was `dist/src/main.js`, which broke `start:prod`). Only deliberate behaviour change: the metrics loop skips functions deleted during the window, instead of writing metrics for a missing row |
| K-04 Dev cluster, RBAC, admission policy | ✅ Done | `729fffc` | • kubectl v1.37.1 and k3d v5.9.0 installed with SHA-256 verified; a re-run skips; a tampered file is rejected.<br>• Cluster up in about 47 s (k3s v1.37.1); node idles at 368 MiB of its 2 GiB cap.<br>• `test-rbac.sh`: **25/25** (7 grants, 7 denials, 9 admission-policy cases, node and token identity), no leftovers.<br>• `env.sh` fixed to work when sourced from zsh as well as bash. |
| K-05 Node.js runtime image | ✅ Done | `9c3072c` | • L1 `npm test`: **21/21** in about 8 s, stable over 3 more runs, no leftover processes. Covers TS (enum) and JS handlers, context, Lambda log lines, serial execution, error mapping, async timeout, a CPU-bound loop stopped while `/healthz` stays up, OOM, `process.exit`, five init-failure kinds, 413/400/429/404, and no environment in logs.<br>• L2 `container-smoke.sh`: **6/6** with read-only root, uid 10001, all capabilities dropped, no installs.<br>• Image 195 MB on `node:24-alpine` (Node 24.22.0). |
| K-06 KubernetesOrchestrator | ✅ Done | `368fb50` | • L1: backend `npm test` **9 suites / 84 tests**, covering naming, manifests (security baseline, CPU formula, network policy, size limit), the client against a local fake API server (SSA, 404 handling, Status errors, token rotation, timeouts), the orchestrator against a fake API (apply order, replica preservation, ConfigMap GC, cold start, error mapping), settings resolution, and driver selection.<br>• L3: `npm run test:it` **6/6** in 79 s against k3d with the least-privilege token: deploy and invoke, rollout, scale to zero and cold start, NetworkPolicy (DNS ✓, kube-dns TCP 53 ✓, API server ✗), init-failure diagnostics, removal. No leftovers.<br>• `dist` contains no specs or fixtures. |
| K-07 Wiring, scaling, dev tenancy | ✅ Done | `bd156c4` (dev cluster image-GC fix found while verifying), `ecef3bd` | • L1 `npm test`: **12 suites / 123 tests**, adding `decideReplicas` table tests (incl. the former divide-by-zero), idle sweep (eligibility, skipped on Nomad, fault isolation), `resolveUserId`, create/update/invoke flows (readiness wait, rollout only on relevant fields, nothing saved on failed rollout, duration persisted, `TIMEOUT` status).<br>• L3 `hack/k8s/test-it.sh`: **6/6** after the GC fix.<br>• New interface flag `supportsScaleToZero` (Kubernetes true, Nomad false), so the idle sweep never parks Nomad functions at zero. |
| K-08 Dev stack and e2e | ✅ Done | `dbe2ce3` (cascade-delete fix found by the e2e test), `5bb644f` | • L4 `hack/e2e.sh`: **14/14** through the REST API (create → ACTIVE → Deployment in tenant namespace → invoke → output → history with duration → update → new code live → delete → Deployment and record gone).<br>• Its first runs found two real bugs: port 3100 taken by another project (the script now picks a free port), and the cascade-delete bug (fixed in `dbe2ce3`, with a regression test that fails without it).<br>• Cleanup verified: 0 `ff-e2e` containers and volumes, no tenant namespace, no backend process, other projects untouched. |
| K-09 Remove Nomad | ✅ Done | `83ed1b0` | • Deleted the Nomad service and module, the Nomad adapter, `script.ts`, the hostel type shim, `BE/templates/` and `BE/job.json`.<br>• Uninstalled `@chatsight/hostel`, `@pulumi/nomad`, `@pulumi/pulumi` (221 packages removed) and `axios` (only Nomad used it).<br>• Nomad-only `package.json`/`tsconfig.json` uploads removed. Only `kubernetes` is accepted as a driver; `nomad` now fails at boot.<br>• L0 build ✓; L1 **122/122**; L3 **6/6**; L4 **14/14**. `nomad-vagrant/` kept and marked `DEPRECATED.md`. |
| K-10 Python runtime | ✅ Done | `815d600` (test-hygiene fix found while verifying), `8a986b8` | • L1 `python3 -m unittest`: **22/22** in about 6 s, stable over 4 runs. It mirrors the Node.js suite: context, Lambda log lines, serial execution, error mapping, timeout, a CPU-bound loop stopped while `/healthz` stays up, OOM, `sys.exit`, six init-failure kinds, 413/400/429/404, no environment in logs. It adds `Decimal` and UTF-8 output, `Runtime.MarshalError`, chunked bodies, and a graceful `SIGTERM`.<br>• L2 `container-smoke.sh`: **10/10**, hardened. Inside a 256 MB container, a hoarding function gets `Runtime.OutOfMemory` and the container is not OOM-killed.<br>• L3 `hack/k8s/test-it.sh`: **7/7**, with a new Python case (deploy, invoke, `ValueError` mapping) at 6.8 s. L4 `hack/e2e.sh`: **19/19**, with a new Python lifecycle.<br>• Verified by hand: numpy 2.5.4 runs in a 128 MB function, and an oversized allocation gets `Runtime.OutOfMemory` and then recovers. Kubernetes sets `memory.oom.group=1` on containers (k3s v1.37.1), so the runtime's own limit is what keeps a container alive.<br>• Image 119 MB on `python:3.13-slim` (Python 3.13.16). Main process 22 MB plus a 15 MB worker. Found while verifying: the e2e backend start budget rose from 60 s to 180 s, because the repository's 5400 rpm disk with a cold page cache took 23 s just to load the modules. Also, a K-06 test left a timer that made Jest force-exit a worker (`815d600`). |
| K-11 gVisor RuntimeClass | ✅ Done | `a0932f7` and `d7d15bf` (runtime fixes found while verifying), (this commit) | • **gVisor works on k3d**, contrary to the plan: `hack/k8s/gvisor-up.sh` takes 83 s from scratch on a fresh cluster (download, SHA-512, install, drop-in, one restart, check pod: kernel `4.19.0-gvisor`) and 6 s when re-run.<br>• L1 backend: orchestrator suite 72/72, with a new `ReplicaFailure` diagnostics test.<br>• L3 **11/11**: Node.js and Python inside gVisor with the NetworkPolicy intact; missing RuntimeClass explained; Python and Node.js memory hogs in 128 MB get `Runtime.OutOfMemory` with 0 restarts.<br>• L4: **20/20** with `K8S_RUNTIME_CLASS=gvisor`, **19/19** without.<br>• Measured: +29/+36 MiB per idle pod (declared as 40Mi overhead); cold start 12–15 s against about 10 s with runc (K-13).<br>• Found while verifying, and fixed in their own commits: Python replacement workers died with their connection (`PR_SET_PDEATHSIG` is per thread); a failed thread start could freeze the Python accept loop; both runtimes' memory budgets let the kernel kill the whole container. gVisor does not enforce `RLIMIT_DATA` (documented). |
| K-12 Docs and plan sync | ⏳ Planned | | |
| K-13 Cold-start performance | 💡 Proposed | | Measurements and options in K-13; needs a product decision on CPU burst |
