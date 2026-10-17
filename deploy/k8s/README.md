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
| `apps/deployments` (+ `deployments/scale`: get, patch, update) | get, list, watch, create, patch, update, delete | One Deployment per function; scaling, including to zero |
| `networking.k8s.io/networkpolicies` | get, list, watch, create, patch, update, delete | Default-deny policy per tenant |
| `pods` (+ `pods/log`: get) | get, list, watch | Readiness checks and failure diagnostics. `pods/log` goes once logs come from the log store (client-readiness plan, P-43) |
| `services/proxy` | get, create | **Development only,** in `dev/`: invoking functions through the API server |

**Not granted:** secrets, creating pods directly, `pods/exec`/`attach`/`portforward`, roles and bindings, nodes, `impersonate`, `escalate`, `bind`, and, in production, `services/proxy`.

## Why an admission policy

RBAC cannot scope permissions by namespace label, so the rules above apply cluster-wide. `ff-controller-scope` closes that gap. For requests from `system:serviceaccount:ff-system:ff-controller` it checks the target namespace:
- for Namespace requests, the namespace itself;
- otherwise, the object's namespace.

The namespace must be named `ff-t-*` and labelled `app.kubernetes.io/managed-by=ff-controller`. As a result, a compromised backend cannot touch `kube-system`, `ff-system`, `default`, or any namespace it did not create. It also cannot remove its own label to escape the check. Other users are unaffected.

The policy also checks calls through a Service's proxy, which reach admission as `CONNECT`: with the development overlay, the backend can proxy into its tenants' Services and nowhere else. The prefix is fixed: the backend's configuration accepts no `K8S_NAMESPACE_PREFIX` but `ff-t-`, since any other would make every deploy fail here.

## Cluster-wide reads (decided for the beta, 2026-10-17)

RBAC can't limit reads to `ff-t-*` namespaces, and the admission policy doesn't see reads. So the backend's token can **read across the whole cluster**: namespaces, ConfigMaps, Services, quotas, limit ranges, NetworkPolicies, Deployments, pods, and pod logs. Stolen, it would show:
- every ConfigMap, in `kube-system` and `ff-system` too;
- every pod's spec, including environment variables written into it as plain values;
- every container's logs, the backend's and Keycloak's included;
- how every Service and Deployment is laid out.

It still couldn't read Secrets, run anything inside a pod, or change anything outside the tenant namespaces.

**For the beta, FF accepts this, under four rules:**
1. FF has its own cluster, with no unrelated workloads.
2. Platform components keep credentials in Secrets only: never in ConfigMaps, environment values or command lines, and never in their logs.
3. Inside the cluster the backend uses its projected ServiceAccount token, which is short-lived and bound to its pod.
4. `pods/log` goes when the log store serves logs (client-readiness plan, P-43), and the security review (P-64) reviews this decision.

**The narrower option, for that review:** read permissions per tenant namespace, through a RoleBinding in each one to a ClusterRole `ff-tenant-reader`. RBAC lets a subject create a binding to a role only if it holds the role's permissions or may `bind` that role, so granting `bind` on `ff-tenant-reader` alone, with the admission policy keeping such bindings inside `ff-t-*` namespaces, would let the backend create them without a separate provisioner. It moves the risk into the backend's right to create bindings, so it needs its own review before it replaces the cluster-wide reads.

`hack/k8s/test-rbac.sh` checks all of this against a live cluster, both what is allowed and what is denied. For the production manifests, it removes the development overlay's binding, checks that no Service proxy is left, and restores it.
