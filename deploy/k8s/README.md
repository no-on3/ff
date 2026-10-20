# FF Kubernetes manifests

`base/` is the cluster-level setup that FF needs in production before it can run functions: `kubectl apply -k deploy/k8s/base`. `dev/` is the same plus one permission that only a backend running outside the cluster needs; `hack/k8s/cluster-up.sh` applies it. Tenant objects (namespaces, quotas, network policies, function Deployments) are **not** here: the backend creates them at runtime.

| File | Object | Purpose |
|---|---|---|
| `00-namespace.yaml` | Namespace `ff-system` | FF platform components. Pod Security `restricted`. Tenant namespaces accept ingress only from the backend's pods here (`app.kubernetes.io/name: ff-backend`). |
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
| `logging/40-network-policies.yaml` | NetworkPolicies `victoria-logs` (`ff-system`), `default-deny-ingress` and `fluent-bit-metrics` (`ff-logging`) | Only Fluent Bit's pods and the backend's (`app.kubernetes.io/name: ff-backend`) reach the store, and the metrics store for its `/metrics`; only the metrics store reaches the collector, on its metrics port |
| `logging/fluent-bit/` | ConfigMap `fluent-bit-<hash>` | `fluent-bit.yaml` (the pipeline) and `ff.lua` (each line's fields and call, the limit, the cut). The hash rolls the DaemonSet when they change. `hack/k8s/test-logging-filter.sh` tests both |

**The collector's permissions,** checked by the log pipeline's L3 suite: it may get, list and watch pods and namespaces, and nothing else: no Secrets, no ConfigMaps, no `pods/log`, no writes, no nodes.

## Platform

`platform/` is FF itself in the cluster (client-readiness plan P-60):
- the backend in `ff-system`, as `ff-controller`, calling functions' Services directly;
- its migrations, as a Job;
- the console and the admin app, two replicas each;
- Keycloak;
- the edge proxy in `ff-edge`: Caddy, TLS from Let's Encrypt for four hostnames, and the admin app and Keycloak's administration for FF's addresses only.

PostgreSQL and S3 are outside the cluster (D13). The images are built from `BE/`, `FE/`, `admin/` and `deploy/edge/` (getting-started, "The platform's images").

**Before the first deploy:**
1. Two databases on the PostgreSQL server, `ff` and `keycloak`, each with its user.
2. DNS for the four hostnames (API, console, admin, login) to the edge's load balancer, ports 80 and 443 open: Let's Encrypt checks them.
3. An overlay of `platform/` with FF's values:
   - `backend.env`, merged: the hostnames, the database, S3, the seller's and the bank's details, `FF_TRUST_PROXY` (the cluster's pod network, which only the edge reaches the backend from);
   - `keycloak.env`: the login hostname, its database, the mail server;
   - `edge.env`: the four hostnames, the ACME e-mail, and `FF_ADMIN_ALLOW`, FF's own addresses;
   - `images`: the registry's images and their tags.
4. The Secrets:

   ```bash
   kubectl -n ff-system create secret generic ff-backend --from-literal=DB_PASSWORD=… --from-literal=MINIO_ACCESS_KEY=… \
     --from-literal=MINIO_SECRET_KEY=… --from-literal=FF_SMTP_URL='smtp://user:password@smtp.example.tn:587'
   kubectl -n ff-system create secret generic keycloak --from-literal=KC_DB_PASSWORD=… \
     --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD=… --from-literal=FF_SMTP_PASSWORD=…
   ```

Then `deploy/k8s/platform/deploy.sh <overlay>`. It runs the migrations Job from the new image and waits for it, then applies the rest and waits for each rollout. The backend refuses to start on a schema with migrations pending anyway.

**The first operator:**
1. In Keycloak's admin console (`https://<login>/admin`, from an address `FF_ADMIN_ALLOW` names), as the bootstrap administrator, make the user.
2. Give them the realm role `ff-operator`; they set up their one-time password at their first login.
3. Make a permanent administrator, and remove the bootstrap one.

The realm is imported at Keycloak's first start only: a realm already there is left as it is, so later changes to it are made in the admin console. `deploy/keycloak/production-realm.py` makes `platform/keycloak/ff-realm.json` from the development realm:
- no test client, and no password grant on `ff-admin`;
- no user;
- the apps' addresses and the mail server from Keycloak's environment.

| File | Object | Purpose |
|---|---|---|
| `platform/00-namespace-edge.yaml` | Namespace `ff-edge` | The edge's, the only pods the internet reaches. Pod Security `restricted` |
| `platform/10-backend.yaml` | Service and Deployment `ff-backend` in `ff-system` | One replica, as `ff-controller`; `/readyz` and `/healthz` its probes, its metrics port named `metrics`; user 10001, read-only root, the log store's key mounted for deleting a closed account's lines |
| `platform/15-migrations.yaml` | Job `ff-migrations` | The migrations, from the backend's image and settings; `deploy.sh` runs it first |
| `platform/20-console.yaml`, `30-admin.yaml` | Services and Deployments `ff-console`, `ff-admin` | The static builds, two replicas each, user 65532, read-only root |
| `platform/40-keycloak.yaml` | Service and Deployment `keycloak` | Keycloak 26.7.5 with `start`, TLS at the edge, its database outside; the realm imported at its first start. Non-root, no capability; its root is writable, as its start builds its configuration there |
| `platform/50-edge.yaml` | PVC, Service (LoadBalancer, keeping callers' addresses) and Deployment `ff-edge` | Caddy on 8080 and 8443, the Service on 80 and 443; its certificates on the volume |
| `platform/60-network-policies.yaml` | NetworkPolicies | `ff-system` denies by default; the edge reaches the backend, the apps and Keycloak; the backend reaches Keycloak for the realm's keys; the metrics store reaches the backend's metrics port; the edge takes the world on its two ports |
| `platform/backend.env`, `keycloak.env`, `edge.env` | ConfigMaps | What isn't secret, with example values (`example.tn`) for an overlay to replace |
| `platform/edge/Caddyfile` | ConfigMap `ff-edge-caddyfile` | The four sites, HSTS, the allowlist; `FF_EDGE_TLS=local_certs` for tests, which have no ACME |
| `platform/keycloak/ff-realm.json` | ConfigMap `keycloak-realm` | The production realm |

`hack/k8s/test-platform-manifests.sh` checks them without deploying:
- every pod's hardening, and every workload's NetworkPolicy;
- the backend's settings, read by the backend's own configuration;
- the realm up to date;
- the edge's Caddyfile, valid for Caddy;
- the cluster API's schemas, with a server dry run.

## Monitoring

`monitoring/` is the operator's monitoring (client-readiness plan P-53, [ADR 0006](../../docs/adr/0006-operator-monitoring.md)), in its own namespace `ff-monitoring`. VictoriaMetrics scrapes the backend's metrics and the platform's. vmalert evaluates the alert rules in git, Alertmanager sends what fires by e-mail, and Grafana shows the two dashboards in git. Apply `monitoring/base` after `base/` and `logging/`, once its two Secrets exist:

```bash
kubectl apply -f deploy/k8s/monitoring/base/00-namespace.yaml
kubectl -n ff-monitoring create secret generic alertmanager-config --from-file=alertmanager.yaml=./alertmanager.yaml
kubectl -n ff-monitoring create secret generic grafana-admin --from-file=password=./grafana-password   # random
kubectl apply -k deploy/k8s/monitoring/base
```

`alertmanager.yaml` is `monitoring/dev/alertmanager.yaml` with the production SMTP server, its login (`smtp_auth_username`, `smtp_auth_password`), TLS (`smtp_require_tls: true`), the operator's address, and `group_wait: 30s`, `group_interval: 5m`. The backend's pods must carry `app.kubernetes.io/name: ff-backend` and name their metrics port `metrics` (`FF_METRICS_PORT`, with `FF_METRICS_HOST=0.0.0.0`), and `FF_DATABASE_DISK_BYTES` gives the database server's disk for its alert.

In development, `hack/k8s/monitoring-up.sh` applies `monitoring/dev` instead, with the Secrets made for you. `hack/k8s/monitoring-down.sh` removes it and its data. The stack is not installed by default (`cluster-up.sh --monitoring` installs it too): its pods use about 200 MiB of the 2 GiB development node. Grafana's 250 MiB don't fit beside them, so the overlay keeps its Deployment at no replica and `hack/k8s/grafana.sh` runs the same Grafana on the developer's machine, on the store through a port-forward. The overlay adds Mailpit, which catches the alerts' e-mails, and replaces the backend's job with one for the backend on the host: the Service `ff-backend-dev`, whose EndpointSlice the script points at this machine's address on the k3d network (`hack/k8s/host-address.sh`). Start the backend with `FF_METRICS_HOST` set to that address to be scraped. `hack/k8s/test-monitoring-rules.sh` tests the rules and the dashboards in seconds, and `hack/k8s/test-monitoring.sh` is L3: L4's run scraped, then the dashboards, the rules and an alert's e-mail.

| File | Object | Purpose |
|---|---|---|
| `monitoring/base/00-namespace.yaml` | Namespace `ff-monitoring` | Pod Security `restricted`: nothing here reads the node's files |
| `monitoring/base/10-victoria-metrics.yaml` | ServiceAccount, ClusterRole `ff-monitoring-nodes`, ClusterRole `ff-monitoring-discovery` bound in `ff-system`, `ff-logging` and `ff-monitoring`, Service and StatefulSet `victoria-metrics` | VictoriaMetrics v1.153.0, scraping by itself every 30 s; 30 days on a 5 GiB volume, read-only past the last GiB. It reads nodes and their kubelet's metrics (`nodes/metrics`), and finds pods only in the platform's namespaces, never a tenant's |
| `monitoring/base/20-kube-state-metrics.yaml` | ServiceAccount, ClusterRole and ClusterRoleBinding `ff-kube-state-metrics`, Service and Deployment | kube-state-metrics v2.20.0: list and watch nodes, pods, namespaces, PVCs, quotas, Deployments, StatefulSets and DaemonSets. No Secrets, no ConfigMaps |
| `monitoring/base/30-vmalert.yaml` | Service and Deployment `vmalert` | vmalert v1.153.0: the rules every 30 s, alerts to Alertmanager, their state written back to the store as `ALERTS` |
| `monitoring/base/40-alertmanager.yaml` | Service and Deployment `alertmanager` | Alertmanager v0.34.1, one replica, its configuration from the Secret `alertmanager-config` |
| `monitoring/base/50-grafana.yaml` | Service and Deployment `grafana` | Grafana 13.2.3: the admin's password from the Secret `grafana-admin`, no sign-up, no anonymous access, nothing fetched from the internet; its database on an emptyDir; 256 MiB asked, as it uses about 250 |
| `monitoring/base/60-network-policies.yaml` | NetworkPolicies in `ff-monitoring` | The store scrapes every pod; vmalert and Grafana query the store; only vmalert reaches Alertmanager. Nothing else, a tenant least of all |
| `monitoring/base/scrape/` | ConfigMap `victoria-metrics-scrape-<hash>` | The jobs: the backend (`backend.yaml`), and the cluster's objects, the kubelets' `/metrics/resource`, VictoriaLogs, Fluent Bit and the stack's pods, found by their name (`platform.yaml`) |
| `monitoring/base/rules/` | ConfigMap `vmalert-rules-<hash>` | The alert rules, `ff-backend.yaml` and `ff-cluster.yaml`, and their unit tests in `tests/` |
| `monitoring/base/dashboards/`, `grafana/` | ConfigMaps `grafana-dashboards-<hash>`, `grafana-datasources-<hash>`, `grafana-dashboard-providers-<hash>` | The dashboards "FF platform" and "FF cluster", read-only in Grafana, and its data source |
| `monitoring/dev/` | Mailpit, Service `ff-backend-dev`, the backend's job replaced, Grafana at no replica | Development only, with `alertmanager.yaml`, the configuration `monitoring-up.sh` makes a Secret |

**The store's permissions:** get, list and watch nodes, and get `nodes/metrics`, cluster-wide; get, list and watch pods in `ff-system`, `ff-logging` and `ff-monitoring` only. kube-state-metrics lists objects cluster-wide, tenants' included, but reads nothing inside them.

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
