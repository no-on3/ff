# FF Kubernetes manifests

`base/` is the cluster-level setup that FF needs before it can run functions. Apply it with `kubectl apply -k deploy/k8s/base`; `hack/k8s/cluster-up.sh` does this for development. Tenant objects (namespaces, quotas, network policies, function Deployments) are **not** here: the backend creates them at runtime.

| File | Object | Purpose |
|---|---|---|
| `00-namespace.yaml` | Namespace `ff-system` | FF platform components. Pod Security `restricted`. Tenant namespaces accept ingress only from here. |
| `10-serviceaccount.yaml` | ServiceAccount `ff-controller` | The backend's identity for managing tenant workloads |
| `20-clusterrole.yaml` | ClusterRole `ff-controller` | Least-privilege verbs (below) |
| `30-clusterrolebinding.yaml` | ClusterRoleBinding | Binds the role to the ServiceAccount |
| `40-admission-policy.yaml` | ValidatingAdmissionPolicy + binding `ff-controller-scope` | Confines the ServiceAccount's writes to FF tenant namespaces |

## Permissions

| Resource | Verbs | Why |
|---|---|---|
| `namespaces` | get, list, watch, create, patch, update, delete | One namespace per tenant (`ff-t-<hash>`) |
| `configmaps` | … + `deletecollection` | Immutable code ConfigMaps; clean-up by label |
| `services`, `resourcequotas`, `limitranges` | get, list, watch, create, patch, update, delete | Per-function Service; per-tenant guardrails |
| `apps/deployments` (+ `deployments/scale`: get, patch, update) | get, list, watch, create, patch, update, delete | One Deployment per function; scaling, including to zero |
| `networking.k8s.io/networkpolicies` | get, list, watch, create, patch, update, delete | Default-deny policy per tenant |
| `pods` (+ `pods/log`: get) | get, list, watch | Readiness checks and failure diagnostics |
| `services/proxy` | get, create | Development only: invoking functions through the API server |

**Not granted:** secrets, creating pods directly, `pods/exec`/`attach`/`portforward`, roles and bindings, nodes, `impersonate`, `escalate`, `bind`.

## Why an admission policy

RBAC cannot scope permissions by namespace label, so the rules above apply cluster-wide. `ff-controller-scope` closes that gap. For requests from `system:serviceaccount:ff-system:ff-controller` it checks the target namespace:
- for Namespace requests, the namespace itself;
- otherwise, the object's namespace.

The namespace must be named `ff-t-*` and labelled `app.kubernetes.io/managed-by=ff-controller`. As a result, a compromised backend cannot touch `kube-system`, `ff-system`, `default`, or any namespace it did not create. It also cannot remove its own label to escape the check. Other users are unaffected.

`hack/k8s/test-rbac.sh` checks all of this against a live cluster, both what is allowed and what is denied.
