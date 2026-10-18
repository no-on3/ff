# FF Kubernetes manifests

`base/` is the cluster-level setup that FF needs in production before it can run functions: `kubectl apply -k deploy/k8s/base`. `dev/` is the same plus one permission that only a backend running outside the cluster needs; `hack/k8s/cluster-up.sh` applies it. Tenant objects (namespaces, quotas, network policies, function Deployments) are **not** here: the backend creates them at runtime.

| File | Object | Purpose |
|---|---|---|
| `00-namespace.yaml` | Namespace `ff-system` | FF platform components. Pod Security `restricted`. Tenant namespaces accept ingress only from here. |
| `10-serviceaccount.yaml` | ServiceAccount `ff-controller` | The backend's identity for managing tenant workloads |
| `20-clusterrole.yaml` | ClusterRole `ff-controller` | Least-privilege verbs (below) |
| `30-clusterrolebinding.yaml` | ClusterRoleBinding | Binds the role to the ServiceAccount |
| `40-admission-policy.yaml` | ValidatingAdmissionPolicy + binding `ff-controller-scope` | Confines the ServiceAccount's writes, and its Service proxy calls, to FF tenant namespaces |

## Development

| File | Object | Purpose |
|---|---|---|
| `dev/kustomization.yaml` | | `base/` plus the file below |
| `dev/10-clusterrole-dev.yaml` | ClusterRole + ClusterRoleBinding `ff-controller-dev-proxy` | `services/proxy` (get, create): in development the backend runs outside the cluster and invokes functions through the API server (`K8S_INVOKE_MODE=proxy`). Production runs it inside the cluster, calling the Services directly, so `base/` doesn't grant this |

## Logging

`logging/` is the log pipeline (client-readiness plan P-42, [ADR 0005](../../docs/adr/0005-log-pipeline.md)): Fluent Bit on every node reads the function containers' logs and writes them to VictoriaLogs, which only the collector and the backend reach. Apply it after `base/`, once the Secret with the store's delete key exists:

```bash
kubectl apply -k deploy/k8s/base
kubectl -n ff-system create secret generic victoria-logs-delete-key --from-file=key=./delete-key   # 32 random bytes, hex; the backend needs it too (P-45)
kubectl apply -k deploy/k8s/logging
```

In development, `hack/k8s/cluster-up.sh` does both, through `hack/k8s/logging-up.sh`, with a random key, and `hack/k8s/logging-down.sh` removes the pipeline and its data. The backend reads it for the logs API and for the load error a failed deploy names (P-43).

Closing an account deletes its log lines with the delete key (P-45). The backend reads the key from a file, `K8S_LOG_STORE_DELETE_KEY_FILE`: by default `/etc/ff/victoria-logs-delete-key/key`, where its manifests mount the Secret (P-60). In development, `hack/k8s/log-store-key.sh` copies it to `hack/.kube/victoria-logs-delete-key`, readable by you alone, and `logging-up.sh` runs it. The backend sends the key in a POST's form body, never in a URL: in development its calls go through the API server's proxy, whose request logs would show a URL.

| File | Object | Purpose |
|---|---|---|
| `logging/00-namespace.yaml` | Namespace `ff-logging` | The collector's. Pod Security `privileged`, because reading the node's `/var/log` takes hostPath volumes, which every other level forbids; the pod is locked down by its own settings instead |
| `logging/10-victoria-logs.yaml` | Service and StatefulSet `victoria-logs` in `ff-system` | VictoriaLogs v1.53.0: 31 days, and at most 8 GiB of its 10 GiB volume, the oldest days going first. `/delete/*` needs the key, read from the mounted Secret, so it is on no command line. Non-root, read-only root, no capabilities, no API token |
| `logging/20-fluent-bit-rbac.yaml` | ServiceAccount `fluent-bit`, ClusterRole and ClusterRoleBinding `ff-logging-fluent-bit` | get, list and watch pods and namespaces: the labels it adds |
| `logging/30-fluent-bit.yaml` | DaemonSet `fluent-bit` | Fluent Bit 5.1.3 on every node, any taint. Root, as the node's container logs are root's (mode 0640), but no capabilities, read-only root and `/var/log`. Its offsets and buffer are in `/var/lib/ff-logging` on the node. The limit's figures are its environment |
| `logging/40-network-policies.yaml` | NetworkPolicies `victoria-logs` (`ff-system`) and `default-deny-ingress` (`ff-logging`) | Only Fluent Bit's pods and the backend's (`app.kubernetes.io/name: ff-backend`) reach the store; nobody reaches the collector |
| `logging/fluent-bit/` | ConfigMap `fluent-bit-<hash>` | `fluent-bit.yaml` (the pipeline) and `ff.lua` (each line's fields and call, the limit, the cut). The hash rolls the DaemonSet when they change. `hack/k8s/test-logging-filter.sh` tests both |

**The collector's permissions,** checked by the log pipeline's L3 suite: it may get, list and watch pods and namespaces, and nothing else: no Secrets, no ConfigMaps, no `pods/log`, no writes, no nodes.

## Optional

| File | Object | Purpose |
|---|---|---|
| `optional/runtimeclass-gvisor.yaml` | RuntimeClass `gvisor` (handler `runsc`) | Runs function pods in gVisor when the backend has `K8S_RUNTIME_CLASS=gvisor`. Only on nodes labelled `ff.dev/gvisor=true`, with 40 Mi / 25m pod overhead. The nodes need gVisor installed first: see [Sandboxing with gVisor](../../docs/kubernetes-dev-guide.md#sandboxing-with-gvisor). |

## Permissions

| Resource | Verbs | Why |
|---|---|---|
| `namespaces` | get, list, watch, create, patch, update, delete | One namespace per tenant (`ff-t-<hash>`) |
| `configmaps` | … + `deletecollection` | Immutable code ConfigMaps; clean-up by label |
| `services`, `resourcequotas`, `limitranges` | get, list, watch, create, patch, update, delete | Per-function Service; per-tenant guardrails |
| `apps/deployments` (+ `deployments/scale`: get, patch, update) | get, list, watch, create, patch, update, delete | One Deployment per function; scaling, including to zero; once a minute, one list across the tenant namespaces for the capacity samples (client-readiness plan, P-21) |
| `networking.k8s.io/networkpolicies` | get, list, watch, create, patch, update, delete | Default-deny policy per tenant |
| `pods` | get, list, watch | Readiness checks and failure diagnostics. `pods/log` went in P-43 (client-readiness plan): the logs, and the load error a failed deploy names, come from the log store |
| `services/proxy` | get, create | **Development only,** in `dev/`: invoking functions through the API server |

**Not granted:** secrets, `pods/log`, creating pods directly, `pods/exec`/`attach`/`portforward`, roles and bindings, nodes, `impersonate`, `escalate`, `bind`, and, in production, `services/proxy`.

## Why an admission policy

RBAC cannot scope permissions by namespace label, so the rules above apply cluster-wide. `ff-controller-scope` closes that gap. For requests from `system:serviceaccount:ff-system:ff-controller` it checks the target namespace:
- for Namespace requests, the namespace itself;
- otherwise, the object's namespace.

The namespace must be named `ff-t-*` and labelled `app.kubernetes.io/managed-by=ff-controller`. As a result, a compromised backend cannot touch `kube-system`, `ff-system`, `default`, or any namespace it did not create. It also cannot remove its own label to escape the check. Other users are unaffected.

The policy also checks calls through a Service's proxy, which reach admission as `CONNECT`: with the development overlay, the backend can proxy into its tenants' Services, and into one more: the log store's, `ff-system/victoria-logs`, by that name and port 9428 only, which the development backend queries this way (P-43). Production grants no proxy at all, so this allows nothing there. The prefix is fixed: the backend's configuration accepts no `K8S_NAMESPACE_PREFIX` but `ff-t-`, since any other would make every deploy fail here.

## Cluster-wide reads (decided for the beta, 2026-10-17)

RBAC can't limit reads to `ff-t-*` namespaces, and the admission policy doesn't see reads. So the backend's token can **read across the whole cluster**: namespaces, ConfigMaps, Services, quotas, limit ranges, NetworkPolicies, Deployments and pods. Stolen, it would show:
- every ConfigMap, in `kube-system` and `ff-system` too;
- every pod's spec, including environment variables written into it as plain values;
- how every Service and Deployment is laid out.

It can no longer read containers' logs: `pods/log` went in P-43, when the logs began to come from the log store. In development, it can also query the log store, which holds the functions' logs only.

It still couldn't read Secrets, run anything inside a pod, or change anything outside the tenant namespaces.

**For the beta, FF accepts this, under four rules:**
1. FF has its own cluster, with no unrelated workloads.
2. Platform components keep credentials in Secrets only: never in ConfigMaps, environment values or command lines, and never in their logs.
3. Inside the cluster the backend uses its projected ServiceAccount token, which is short-lived and bound to its pod.
4. `pods/log` went when the log store began to serve logs (client-readiness plan, P-43), and the security review (P-64) reviews this decision.

**The narrower option, for that review:** read permissions per tenant namespace, through a RoleBinding in each one to a ClusterRole `ff-tenant-reader`. RBAC lets a subject create a binding to a role only if it holds the role's permissions or may `bind` that role, so granting `bind` on `ff-tenant-reader` alone, with the admission policy keeping such bindings inside `ff-t-*` namespaces, would let the backend create them without a separate provisioner. It moves the risk into the backend's right to create bindings, so it needs its own review before it replaces the cluster-wide reads.

`hack/k8s/test-rbac.sh` checks all of this against a live cluster, both what is allowed and what is denied. For the production manifests, it removes the development overlay's binding, checks that no Service proxy is left, and restores it.
