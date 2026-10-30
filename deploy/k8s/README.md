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
- the backend in `ff-system`, as `ff-controller`, calling functions' Services directly; a Service that refuses the connection, as one does for a moment after its pod becomes ready, is tried again for up to 5 seconds, the call having reached no function;
- its migrations, as a Job;
- the console and the admin app, two replicas each;
- Keycloak;
- the edge proxy in `ff-edge`: Caddy, TLS from Let's Encrypt for four hostnames and for functions' URLs under the function domain, and the admin app and Keycloak's administration for FF's addresses only;
- the code registry, Zot, which keeps functions' code images for the nodes to mount ([ADR 0003](../../docs/adr/0003-code-delivery.md)): every function's, inline code's too.

PostgreSQL and S3 are outside the cluster (D13). The images are built from `BE/`, `FE/`, `admin/` and `deploy/edge/` (getting-started, "The platform's images").

**Before the first deploy:**
1. Two databases on the PostgreSQL server, `ff` and `keycloak`, each with its user.
2. gVisor on the nodes that run functions, each labelled `ff.dev/gvisor=true`, and `optional/runtimeclass-gvisor.yaml` applied (the Kubernetes dev guide, "On real nodes"). `backend.env` runs every function in it (`K8S_RUNTIME_CLASS=gvisor`): the backend refuses to start in production without a sandbox, and `deploy.sh` to deploy when the cluster lacks the RuntimeClass or a node to run it.
3. DNS for the four hostnames (API, console, admin, login) to the edge's load balancer, ports 80 and 443 open: Let's Encrypt checks them. And for functions' URLs, a wildcard record, `*.fn.example.tn`, to the same address ("Function URLs", below).
4. An overlay of `platform/` with FF's values:
   - `backend.env`, merged: the hostnames, the database, S3, the seller's and the bank's details, `FF_TRUST_PROXY` (the cluster's pod network, which only the edge reaches the backend from);
   - `keycloak.env`: the login hostname, its database, the mail server;
   - `edge.env`: the four hostnames, the ACME e-mail, `FF_ADMIN_ALLOW`, FF's own addresses, and the function domain with its way to certificates ("Function URLs", below); `FF_EDGE_TRUSTED_PROXIES` stays empty, unless a proxy of the server's own stands in front of the edge, whose `X-Forwarded-For` then names the caller, as on a server shared with other sites;
   - `images`: the registry's images and their tags.
5. The Secrets:

   ```bash
   kubectl -n ff-system create secret generic ff-backend --from-literal=DB_PASSWORD=… --from-literal=FF_OBJECT_STORE_ACCESS_KEY=… \
     --from-literal=FF_OBJECT_STORE_SECRET_KEY=… --from-literal=FF_SMTP_URL='smtp://user:password@smtp.example.tn:587' \
     --from-literal=FF_CODE_REGISTRY_PASSWORD="$BACKEND_PASSWORD"
   # The code registry's two users, bcrypt: htpasswd comes with Apache's tools, or as
   # docker run --rm httpd:2.4.69-alpine htpasswd -nbBC 12 <user> <password>
   htpasswd -nbBC 12 ff-backend "$BACKEND_PASSWORD" > htpasswd && htpasswd -nbBC 12 ff-node "$NODE_PASSWORD" >> htpasswd
   kubectl -n ff-system create secret generic ff-code-registry --from-file=htpasswd=./htpasswd
   kubectl -n ff-system create secret generic keycloak --from-literal=KC_DB_PASSWORD=… \
     --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD=… --from-literal=FF_SMTP_PASSWORD=…
   # The keys that encrypt functions' variables and secrets at rest: one a line, <id>:<32 bytes in base64>, the first sealing
   echo "$(date +%Y-%m):$(openssl rand -base64 32)" > keys
   kubectl -n ff-system create secret generic ff-encryption-keys --from-file=keys=./keys
   ```

   Keep a copy of the keys file apart from the cluster and the database, as the backups' own key is kept (`deploy/backup/README.md`): without it, no function's variables or secrets can be read. To change keys, put a new line first in the Secret, restart the backend, and remove the old line once every function has been updated since.
6. Each node's containerd told where code images are ("The code registry", below).

Then `deploy/k8s/platform/deploy.sh <overlay>`. It checks the sandbox, the function URLs' settings and the code registry's Secrets, runs the migrations Job from the new image and waits for it, then applies the rest and waits for each rollout. The backend refuses to start on a schema with migrations pending anyway.

**The code registry** ([ADR 0003](../../docs/adr/0003-code-delivery.md)). Every function runs its code from an image, which the backend makes from its package, inline code from a one-file package of its own, and pushes to the registry, and which the node pulls to mount at the function's `/var/task`. Without it, no function deploys, and the backend refuses to start in production. The registry is Zot, in its minimal build, in `ff-system` (`platform/70-code-registry.yaml`, its settings `platform/code-registry/config.json`):
- **Two users,** from the Secret `ff-code-registry`'s `htpasswd`: `ff-backend` pushes and deletes, with its password in the Secret `ff-backend` (`FF_CODE_REGISTRY_PASSWORD`); `ff-node` only pulls. Nobody reads anything without a login.
- **The backend** pushes to the Service by its name (`FF_CODE_REGISTRY` in `backend.env`), and names the images `registry.ff.internal/ff-code/<account>@sha256:…` (`FF_CODE_REGISTRY_PULL`). Only the backend reaches the registry from a pod: tenants' pods reach no private address, and `ff-system` denies by default.
- **The nodes** pull from themselves, which k3s lets through, at the Service's fixed address, `10.43.0.250`, in the band of k3s's Service range (`10.43.0.0/16`) that Kubernetes keeps for fixed addresses; a cluster with another range gives another address in an overlay. Each node's containerd maps the name to it. On k3s, `/etc/rancher/k3s/registries.yaml` on every node, then a restart of k3s there:

  ```yaml
  mirrors:
    registry.ff.internal:
      endpoint:
        - "http://10.43.0.250:5000"
  configs:
    "10.43.0.250:5000":
      auth:
        username: ff-node
        password: "<ff-node's password>"
  ```

  Elsewhere, containerd's `hosts.toml` for `registry.ff.internal`, and its CRI configuration for the login. With a network plugin other than k3s's, or nodes that pull from the registry on another node, add the nodes' addresses to the NetworkPolicy `ff-code-registry`.
- **No backup:** the backend makes an image again from its package's zip, which object storage keeps and the backups copy to the second site, when the registry has lost it, or a blob of it. Its retention job does so every hour and at the backend's start, for every package a function names, and then rolls out each working function whose pods mount an image the registry hasn't: one made again with another digest, by a later backend, isn't the one their pods name (the CLI plan's C-29). After losing the registry, restart the backend (`kubectl -n ff-system rollout restart deployment/ff-backend`) rather than wait for the hour. Meanwhile a pod that starts on a node without its image can't pull it, while running pods, and nodes that have it, keep it: put the volume on storage that outlives a node all the same. Blobs nothing names any more go a day later (`gc`); the volume, 20 GiB here, holds the images of the packages in use and those an hour unused.

**Function URLs** (step-1 plan, D6 and D7). Each function URL is `https://<32 letters and digits>.<function domain>/`. The backend answers them on a port of its own, 3001 (`FF_FUNCTION_URL_PORT`), which its Service names `function-urls` and only the edge reaches; the edge sends every host under the function domain there. Three settings must agree, and `deploy.sh` checks that they do: the backend's `FF_FUNCTION_URL_BASE` (`https://fn.example.tn`, the addresses the API gives), the edge's `FF_FUNCTION_URL_DOMAIN` (`fn.example.tn`), and the DNS record `*.fn.example.tn` to the edge. Their certificates come one of two ways, as the edge's `FF_FUNCTION_URL_TLS` says:
- `wildcard`, for production: one certificate for `*.fn.example.tn`, which Let's Encrypt issues only through a DNS-01 challenge, a TXT record `_acme-challenge.fn.example.tn` the edge writes and removes. It writes it with RFC 2136 updates, the standard that BIND, Knot and PowerDNS take, so FF depends on no DNS company: `FF_DNS_SERVER` (the primary server, `host:53`), `FF_DNS_TSIG_KEY_NAME` and `FF_DNS_TSIG_KEY_ALG` in `edge.env`, and the key itself in a Secret, which `deploy.sh` refuses to go without:

  ```bash
  # On the DNS server, BIND for example: a key, and the right to change that one record's TXT, nothing else.
  tsig-keygen -a hmac-sha256 ff-acme. > /etc/bind/ff-acme.key   # include it in named.conf, then in the zone fn.example.tn:
  #   update-policy { grant ff-acme. name _acme-challenge.fn.example.tn. TXT; };
  # In the cluster: the namespace first, as the platform makes it, then the Secret with the key's secret.
  kubectl apply -f deploy/k8s/platform/00-namespace-edge.yaml
  kubectl -n ff-edge create secret generic ff-edge-dns --from-literal=FF_DNS_TSIG_KEY='<the secret of ff-acme.>'
  ```

  The record lives in the zone `fn.example.tn`, delegated to that server, or in FF's main zone if that server holds it. A provider without RFC 2136 has a module of its own for Caddy: build the edge with it instead (`deploy/edge/Dockerfile`, one `--with`), and change `edge/Caddyfile`'s `function-url-tls-wildcard` to it.
- `on-demand`, without access to the DNS: a certificate for each URL's host, at its first request, once the edge has asked the backend (`/tls/allowed?domain=` on port 3001), which says yes only for a URL that exists, so nobody makes the edge ask for names of their choosing. Let's Encrypt issues 50 certificates a week per registered domain: enough for a small beta. The first request to a new URL waits for its certificate, a few seconds.

**Customers' own domains** come through the same port: the edge's last site takes every host no other site names, and gets a certificate for it at its first request once the backend says the domain is verified (the same question, `/tls/allowed`), whatever `FF_FUNCTION_URL_TLS` says. Let's Encrypt's limit then counts per customer's domain, not FF's. Give the backend `FF_EDGE_ADDRESSES`, the edge's public addresses, in `backend.env`: a customer's domain apex, which can't be a CNAME, must point to them, and the check says so; without them, the TXT record alone proves an apex. The checks ask the cluster's DNS, or the servers `FF_DOMAIN_RESOLVERS` names.

The test overlay (`hack/k8s/platform-e2e`) uses `on-demand` with Caddy's own authority, offline, and a DNS server of its own for a customer's domain.

**Buckets' S3 front door** ([ADR 0009](../../docs/adr/0009-buckets.md)). Customers' S3 clients reach `https://s3.example.tn`, path-style, and each bucket at `https://<bucket>.s3.example.tn`, virtual-hosted. The backend answers both on a port of its own, 3002 (`FF_STORAGE_PORT`), which its Service names `storage` and the edge reaches, and functions too ("Buckets from functions", below); the edge sends both hosts there as they came, as clients' signatures cover the host, the path and the headers. The backend's `FF_STORAGE_BASE` (`https://s3.example.tn`) and the edge's `FF_STORAGE_HOST` (`s3.example.tn`) must agree, and `deploy.sh` checks that they do; the DNS records `s3.example.tn` and `*.s3.example.tn` point to the edge. Their certificates come the two ways function URLs' do, as the edge's `FF_STORAGE_TLS` says: `wildcard`, one for both names through DNS-01 with the same TSIG key, its update policy granting `_acme-challenge.s3.example.tn` too; or `on-demand`, one per bucket's host once the backend says the bucket is one (the same `/tls/allowed` on port 3001, the edge's one address for its questions), out of the same 50 a week. The store behind is FF's own (`FF_OBJECT_STORE_*`): customers' buckets are there under names of FF's, `ff-` and 24 characters, and FF's credentials are the only ones the store knows.

**Buckets from functions** (ADR 0009). Each function's pods get a key of the function's own, made at its first deploy and revoked when it is deleted, with the region and `AWS_ENDPOINT_URL_S3`, where they reach the front door inside the cluster, so that AWS's SDKs work in them with no setting. That address is the Service `ff-storage`'s, fixed, `10.43.0.251:3002` (`platform/10-backend.yaml`), as the backend's `FF_STORAGE_FUNCTION_ENDPOINT` names it (`backend.env`): an IP address, where AWS's SDKs address buckets path-style by themselves, so that no name of FF's is needed inside the cluster; beside the code registry's, in the band of k3s's Service range kept for fixed addresses, and a cluster with another range gives another address in an overlay, with the setting to match. Without `FF_STORAGE_FUNCTION_CIDRS`, each tenant's NetworkPolicy opens the backend's own pods, on 3002, whatever the account's internet access, and the NetworkPolicy `ff-backend` lets tenants' function pods in on that port alone. Traffic stays inside the cluster, in plain HTTP, as the nodes' pulls of code images do; the signatures still cover every request. Without `FF_STORAGE_FUNCTION_ENDPOINT`, functions get no key.

**Queues' SQS endpoint** ([ADR 0010](../../docs/adr/0010-queue.md)). Customers' SQS clients reach `https://sqs.example.tn`, where a queue's URL is `https://sqs.example.tn/<account>/<queue>`. The backend answers on a port of its own, 3003 (`FF_SQS_PORT`), which its Service names `sqs` and the edge reaches, and functions too ("Queues from functions", below); the edge sends the host there as it came, as clients' signatures cover the host and the body. The backend's `FF_SQS_BASE` (`https://sqs.example.tn`) and the edge's `FF_SQS_HOST` (`sqs.example.tn`) must agree, and `deploy.sh` checks that they do; the DNS record `sqs.example.tn` points to the edge, and its certificate comes as the API's does, one name of its own.

**Queues from functions** (ADR 0010). With the function's own key, its pods get `AWS_ENDPOINT_URL_SQS`, where they reach the SQS endpoint inside the cluster: the Service `ff-storage`'s fixed address too, on 3003, as the backend's `FF_SQS_FUNCTION_ENDPOINT` names it (`backend.env`). Without `FF_SQS_FUNCTION_CIDRS`, each tenant's NetworkPolicy opens the backend's own pods on 3003 too, whatever the account's internet access, and the NetworkPolicy `ff-backend` lets tenants' function pods in on 3002 and 3003 alone. A queue's URL is answered under the endpoint its caller reached: inside a function, `http://10.43.0.251:3003/<account>/<queue>`, so that AWS's SDK for JavaScript, which sends a queue's requests to its URL's host, keeps them inside the cluster. A URL from outside, `https://sqs.example.tn/…`, works in a function with boto3 and the AWS CLI, which keep to their endpoint whatever the URL's host; with the SDK for JavaScript, only with its client's `useQueueUrlAsEndpoint: false`, as functions don't reach the edge. Without `FF_SQS_FUNCTION_ENDPOINT`, functions get no `AWS_ENDPOINT_URL_SQS`.

**Mail's SES endpoint** ([ADR 0012](../../docs/adr/0012-customer-mail.md)). Customers' SES v2 clients reach `https://email.example.tn` (`FF_SES_BASE`; `FF_SES_HOST` at the edge, one name with its own certificate), where an address's link is `https://email.example.tn/verify?token=…`. The backend answers on a port of its own, 3005 (`FF_SES_PORT`), and the edge passes requests on unchanged, as their signatures cover the host and the body. Functions' pods get `AWS_ENDPOINT_URL_SESV2`, the Service `ff-storage`'s fixed address on 3005 (`FF_SES_FUNCTION_ENDPOINT`), with their own key. A domain's records name the mail server, `FF_EMAIL_MAIL_HOST`, in its MX and SPF, and its bounces come back to FF's own return path, `FF_EMAIL_BOUNCE_DOMAIN`, until its own is proved.

**Customers' databases** ([ADR 0008](../../docs/adr/0008-customer-databases.md)) live on a server of their own, outside the cluster, as FF's own database does: [`deploy/data-db`](../data-db/README.md) says how to install it. The backend reaches it with its own role there (`FF_DATA_DB_*` in `backend.env`, the password in the Secret `ff-backend`), and every tenant's NetworkPolicy opens the server's addresses, `FF_DATA_DB_CIDRS`, on its port, whatever the account's internet access: the addresses its name resolves to from the cluster's nodes. When its certificate comes from a CA of the operator's (`FF_DATA_DB_CA_FILE`), the backend writes the CA into a Secret of each tenant's, `ff-data-db-ca`, which functions' pods mount at `/etc/ff/data-db/` and Node.js trusts through `NODE_EXTRA_CA_CERTS`; with a public CA's certificate, there is nothing to write.

**Customers' caches** ([ADR 0013](../../docs/adr/0013-caches.md)) live on a server of their own too, a Valkey process for each cache: [`deploy/cache`](../cache/README.md) says how to install it. The backend tells its agent what each cache is, over HTTPS with a token (`FF_CACHE_*` in `backend.env`, the token in the Secret `ff-backend`), and every tenant's NetworkPolicy opens the server's addresses, `FF_CACHE_CIDRS`, on the caches' ports, `FF_CACHE_PORTS`, never the agent's. A CA of the operator's (`FF_CACHE_CA_FILE`) goes into the same Secret `ff-data-db-ca` as the database server's, both CAs one after the other, which Node.js trusts as one file.

**The first operator:**
1. In Keycloak's admin console (`https://<login>/admin`, from an address `FF_ADMIN_ALLOW` names), as the bootstrap administrator, make the user.
2. Give them the realm role `ff-operator`; they set up their one-time password at their first login.
3. Make a permanent administrator, and remove the bootstrap one.

The realm is imported at Keycloak's first start only: a realm already there is left as it is, so later changes to it are made in the admin console. `deploy/keycloak/production-realm.py` makes `platform/keycloak/ff-realm.json` from the development realm:
- no test client, and no password grant on `ff-admin`;
- no user;
- a password policy: 12 to 128 characters, neither the username nor the e-mail address;
- the apps' addresses and the mail server from Keycloak's environment.

| File | Object | Purpose |
|---|---|---|
| `platform/00-namespace-edge.yaml` | Namespace `ff-edge` | The edge's, the only pods the internet reaches. Pod Security `restricted` |
| `platform/10-backend.yaml` | Services `ff-backend` and `ff-storage`, Deployment `ff-backend` in `ff-system` | The API on port 80, functions' URLs on 3001 (`function-urls`), buckets on 3002 (`storage`) and queues on 3003 (`sqs`), which functions reach at `ff-storage`'s fixed address; one replica, as `ff-controller`, with a token for the cluster's API asked for an hour, not the default year ("Cluster-wide reads", below); `/readyz` and `/healthz` its probes, its metrics port named `metrics`; user 10001, read-only root, the log store's key mounted for deleting a closed account's lines, and the keys of `ff-encryption-keys` for functions' variables and secrets |
| `platform/15-migrations.yaml` | Job `ff-migrations` | The migrations, from the backend's image and settings; `deploy.sh` runs it first |
| `platform/20-console.yaml`, `30-admin.yaml` | Services and Deployments `ff-console`, `ff-admin` | The static builds, two replicas each, user 65532, read-only root |
| `platform/40-keycloak.yaml` | Service and Deployment `keycloak` | Keycloak 26.7.5 with `start`, TLS at the edge, its database outside; the realm imported at its first start. Non-root, no capability; its root is writable, as its start builds its configuration there |
| `platform/50-edge.yaml` | PVC, Service (LoadBalancer, keeping callers' addresses) and Deployment `ff-edge` | Caddy, with the RFC 2136 DNS module, on 8080 and 8443, the Service on 80 and 443; its certificates on the volume; the Secret `ff-edge-dns` in its environment when there is one |
| `platform/60-network-policies.yaml` | NetworkPolicies | `ff-system` denies by default; the edge reaches the backend (its API and its ports for functions' URLs and buckets), the apps and Keycloak; tenants' functions reach the backend's port for buckets alone; the backend reaches Keycloak for the realm's keys, and the code registry; the metrics store reaches the backend's metrics port; the edge takes the world on its two ports |
| `platform/70-code-registry.yaml` | PVC, Service (at a fixed address) and Deployment `ff-code-registry` | Zot 2.1.22, minimal, the functions' code images; user 10001, read-only root; two users from the Secret `ff-code-registry` |
| `platform/code-registry/config.json` | ConfigMap `ff-code-registry` | Zot's settings: its storage and its collection of blobs nothing names, the login, `ff-backend` pushing and deleting, `ff-node` pulling |
| `platform/backend.env`, `keycloak.env`, `edge.env` | ConfigMaps | What isn't secret, with example values (`example.tn`) for an overlay to replace |
| `platform/edge/Caddyfile` | ConfigMap `ff-edge-caddyfile` | The four sites and the function domain's, HSTS, the allowlist, by the caller's address, which a proxy that `FF_EDGE_TRUSTED_PROXIES` names may give; function URLs' certificates by DNS or on demand; `FF_EDGE_TLS=local_certs` for tests, which have no ACME |
| `platform/keycloak/ff-realm.json` | ConfigMap `keycloak-realm` | The production realm |

`hack/e2e-platform.sh` deploys them on a k3d cluster of its own, with `deploy.sh` and the overlay `hack/k8s/platform-e2e`, and takes a customer's path through the edge (the Kubernetes dev guide, "The platform on a cluster of its own"). `hack/k8s/test-platform-manifests.sh` checks them without deploying:
- every pod's hardening, and every workload's NetworkPolicy;
- an API token for the backend alone, asked for an hour at most;
- credentials in Secrets only: none in a ConfigMap, an environment value or a command line;
- the backend's settings, read by the backend's own configuration;
- the realm up to date;
- the function domain the same for the backend and the edge, and the backend's port for function URLs reached by the edge alone;
- the edge's image with the RFC 2136 module, and its Caddyfile valid for Caddy, with function URLs' certificates either way; its allowlist believing `X-Forwarded-For` from the proxies `FF_EDGE_TRUSTED_PROXIES` names alone;
- the code registry: Zot's settings valid for its pinned image, where the volume and the users' Secret are mounted; its fixed address and port the backend's settings name; the backend alone reaching it;
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

Optional in development, required in production (see "Platform").

| File | Object | Purpose |
|---|---|---|
| `optional/runtimeclass-gvisor.yaml` | RuntimeClass `gvisor` (handler `runsc`) | Runs function pods in gVisor when the backend has `K8S_RUNTIME_CLASS=gvisor`. Only on nodes labelled `ff.dev/gvisor=true`, with 40 Mi / 25m pod overhead. The nodes need gVisor installed first: see [Sandboxing with gVisor](../../docs/kubernetes-dev-guide.md#sandboxing-with-gvisor). |

## Permissions

| Resource | Verbs | Why |
|---|---|---|
| `namespaces` | get, list, watch, create, patch, update, delete | One namespace per tenant (`ff-t-<hash>`) |
| `configmaps` | … + `deletecollection` | The code ConfigMaps functions had before their code came as images (ADR 0003): deleted at a function's second rollout since, and by label with the function. The backend makes none any more; its create and patch can go once no backend from before may run |
| `services`, `resourcequotas`, `limitranges` | get, list, watch, create, patch, update, delete | Per-function Service; per-tenant guardrails |
| `apps/deployments` (+ `deployments/scale`: get, patch, update) | get, list, watch, create, patch, update, delete | One Deployment per function; scaling, including to zero; once a minute, one list across the tenant namespaces for the capacity samples (client-readiness plan, P-21) |
| `networking.k8s.io/networkpolicies` | get, list, watch, create, patch, update, delete | Default-deny policy per tenant |
| `secrets` | create, patch, update, delete: **never get, list or watch** | A function's variables and secrets, which its pods read through `envFrom` ("Functions' environments", below) |
| `pods` | get, list, watch | Readiness checks and failure diagnostics. `pods/log` went in P-43 (client-readiness plan): the logs, and the load error a failed deploy names, come from the log store |
| `services/proxy` | get, create | **Development only,** in `dev/`: invoking functions through the API server |

**Not granted:** reading secrets (get, list, watch), `pods/log`, creating pods directly, `pods/exec`/`attach`/`portforward`, roles and bindings, nodes, `impersonate`, `escalate`, `bind`, and, in production, `services/proxy`.

## Why an admission policy

RBAC cannot scope permissions by namespace label, so the rules above apply cluster-wide. `ff-controller-scope` closes that gap. For requests from `system:serviceaccount:ff-system:ff-controller` it checks the target namespace:
- for Namespace requests, the namespace itself;
- otherwise, the object's namespace.

The namespace must be named `ff-t-*` and labelled `app.kubernetes.io/managed-by=ff-controller`. As a result, a compromised backend cannot touch `kube-system`, `ff-system`, `default`, or any namespace it did not create. It also cannot remove its own label to escape the check. Other users are unaffected.

The policy also checks calls through a Service's proxy, which reach admission as `CONNECT`: with the development overlay, the backend can proxy into its tenants' Services, and into one more: the log store's, `ff-system/victoria-logs`, by that name and port 9428 only, which the development backend queries this way (P-43). Production grants no proxy at all, so this allows nothing there. The prefix is fixed: the backend's configuration accepts no `K8S_NAMESPACE_PREFIX` but `ff-t-`, since any other would make every deploy fail here.

## Cluster-wide reads (decided 2026-10-17, reviewed 2026-10-20)

RBAC can't limit reads to `ff-t-*` namespaces, and the admission policy doesn't see reads. So the backend's token can **read across the whole cluster**: namespaces, ConfigMaps, Services, quotas, limit ranges, NetworkPolicies, Deployments and pods. Stolen, it would show:
- every ConfigMap, in `kube-system` and `ff-system` too;
- every pod's spec, including environment variables written into it as plain values;
- how every Service and Deployment is laid out.

It can no longer read containers' logs: `pods/log` went in P-43, when the logs began to come from the log store. In development, it can also query the log store, which holds the functions' logs only.

It still couldn't read Secrets, run anything inside a pod, or change anything outside the tenant namespaces. It may write Secrets in tenant namespaces, never read one: see "Functions' environments", below.

**FF accepts this, under five rules:**
1. FF has its own cluster, with no unrelated workloads.
2. Platform components keep credentials in Secrets only: never in ConfigMaps, environment values or command lines, and never in their logs. `hack/k8s/test-platform-manifests.sh` checks the platform's manifests for this: no ConfigMap key or environment value named like a credential, no password in a URL, no private key, and no secret written into the realm's JSON (its SMTP password is `${FF_SMTP_PASSWORD}`, filled in from the Secret when Keycloak starts).
3. Inside the cluster the backend's token is asked for an hour (`deploy/k8s/platform/10-backend.yaml`), bound to its pod, and renewed by the kubelet before it expires; the backend reads the file again every minute. The token Kubernetes mounts by default would be valid for a year: measured on k3s, 31,536,000 s. `hack/e2e-platform.sh` reads it in the backend's pod: 3,600 s.
4. `pods/log` went when the log store began to serve logs (client-readiness plan, P-43).
5. A function's pod spec holds no secret. Since functions have environment variables and secrets of their own (step-1 plan, U-01), their values go in a Secret in the tenant's namespace, read through `envFrom`, never as plain values in the pod spec, which this token reads.

**Reviewed by the security review** (client-readiness plan, P-64, 2026-10-20), and kept, for the beta and for GA:
- What a stolen token shows is the platform's layout (names, images, settings without credentials, the cluster's public CA), and every customer's function code, which the functions' ConfigMaps hold. Rules 2 and 5 keep credentials out of it. The token itself can change nothing outside `ff-t-*` namespaces, which the admission policy enforces. **Since 2026-10-21** functions' code is in the code registry rather than in ConfigMaps ([ADR 0003](../../docs/adr/0003-code-delivery.md)): the token shows only the code ConfigMaps of functions deployed before, until their next rollouts delete them, and the images' names, not their contents, which take a registry login from a Secret.
- Rule 3 was found untrue as written: the backend used the default token, valid for a year. It now asks for an hour.
- The narrower option below would hide `kube-system` and `ff-system` from the token, which hold no credentials outside Secrets. To do that, it would give the backend the power to create RoleBindings, a write that is riskier than these reads. And the functions' code stayed readable under either option, since the backend must read their namespaces (no longer: their code is in the registry now, above). So it is not taken.

**The narrower option, not taken:** read permissions per tenant namespace, through a RoleBinding in each one to a ClusterRole `ff-tenant-reader`. RBAC lets a subject create a binding to a role only if it holds the role's permissions or may `bind` that role, so granting `bind` on `ff-tenant-reader` alone, with the admission policy keeping such bindings inside `ff-t-*` namespaces, would let the backend create them without a separate provisioner. It moves the risk into the backend's right to create bindings, so it needs its own review before it replaces the cluster-wide reads.

## Functions' environments (step-1 plan, U-01)

A function's variables and secrets reach its pods through a Secret in its account's namespace, which the pods read through `envFrom`. So the backend may **create, patch, update and delete Secrets, and never get, list or watch one**:
- the admission policy keeps those writes to `ff-t-*` namespaces, as every write of the backend's;
- the answer to a write is the object written: in a tenant namespace, an environment the backend wrote itself; anywhere else the policy refuses the write before anything is written or answered;
- each function has two Secrets, `fn-<id>-env-0` and `fn-<id>-env-1`, written in turn: a new environment goes into the one the running version doesn't read, so that its pods keep theirs during a rollout and a rollback finds the old values. The backend reads which one is in use from the Deployment, and deletes the other once a rollout is complete; deleting a function deletes both, by name;
- the backend keeps them in its database encrypted with the keys of `ff-encryption-keys` (the backup runbook says where their copy lives);
- in etcd, Secrets are encrypted only when the cluster says so: start k3s with `--secrets-encryption` (or turn it on with `k3s secrets-encrypt enable`, then rotate). A cluster without it keeps every Secret, FF's own included, in clear on its disks.

`hack/k8s/test-rbac.sh` checks all of this against a live cluster, both what is allowed and what is denied. For the production manifests, it removes the development overlay's binding, checks that no Service proxy is left, and restores it.
