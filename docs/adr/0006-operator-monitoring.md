# ADR 0006: Operator monitoring

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Supersedes** | The parent plan's F-09 "Prometheus, Grafana" sketch, and `infrastructure/grafana`, which no longer exists |
| **Implementation** | [Client-readiness plan](../client-readiness-plan.md): task P-53, part 1 (the backend's log, `/readyz` and metrics) and part 2 (this stack) |
| **Related** | [ADR 0005](0005-log-pipeline.md), the log pipeline, whose store this one resembles |

## Context

FF's operator has to learn that something is wrong before a customer does. That means the API is down, invocations fail because of the platform, the hourly rating or the alarms fall behind, money doesn't reconcile, a node runs out of memory, or the functions' logs stop arriving. Part 1 gave the backend what to watch:
- a JSON log naming each request;
- `GET /readyz`;
- metrics in Prometheus's text format on a port of their own (`BE/src/monitoring`).

This part decides what scrapes them, what alerts on them, and where the operator looks. The constraints are those of the rest of the platform:
- **Small.** One operator and a few nodes. The development cluster is one node with 2 GiB, which already runs k3s, the log pipeline and the functions under test.
- **Self-hosted.** No cloud monitoring service, as for everything else (the parent plan's D-1).
- **In git.** Dashboards and rules are reviewed and applied like code, and tested.
- **Every image at least two weeks old.**

## Decision

In a namespace of its own, `ff-monitoring` (Pod Security `restricted`), `deploy/k8s/monitoring/`:

| Part | Chosen | Why |
|---|---|---|
| Metrics store | VictoriaMetrics v1.153.0, single node, scraping by itself (`-promscrape.config`) | One process instead of Prometheus plus an agent. It is the same family as the log store (ADR 0005), with the same flags, health page and image style. It answers PromQL (MetricsQL), so Grafana's Prometheus data source and vmalert work unchanged. Measured here: about 90 MiB with its caches capped at 96 MiB, for the few thousand series FF has |
| What it scrapes | The backend; kube-state-metrics; each kubelet's `/metrics/resource`; VictoriaLogs; Fluent Bit; the stack itself | The kubelet's resource endpoint gives node and container memory and CPU in a few dozen series. cAdvisor's endpoint gives thousands a node, most of the store for nothing the alerts read. node-exporter would need a privileged DaemonSet with the host's `/proc` and `/sys`; the node's memory and readiness come from the kubelet and kube-state-metrics instead |
| Cluster objects | kube-state-metrics v2.20.0, limited to nodes, pods, namespaces, PVCs, quotas, Deployments, StatefulSets, DaemonSets | Restarts, OOM kills, readiness, the functions' instances. The list keeps it near 40 MiB, and keeps it off Secrets and ConfigMaps |
| Alert rules | vmalert v1.153.0, the rules in git (`rules/`), unit-tested with `vmalert-tool` | Prometheus's rule format, so a move to Prometheus keeps them. The unit tests write series and expect each alert when it must fire and when it must not, in the image, without a cluster |
| Sending alerts | Alertmanager v0.34.1, by e-mail; Mailpit v1.31.4 catches them in development | Grouping, repeat and resolution e-mails come with it, and SMS later is a receiver to add. Its configuration is a Secret, since it holds the SMTP login |
| Dashboards | Grafana 13.2.3, its data source and two dashboards provisioned read-only from git | "FF platform" (the backend) and "FF cluster" (nodes, pods, logs, the stack). A change in the UI would be lost at the next restart, so changes are made in git. Its database is an emptyDir, since everything in it comes from git or a Secret |

**Who reaches what.** The store reads nodes and their kubelet's metrics cluster-wide. It finds pods only in `ff-system`, `ff-logging` and `ff-monitoring`, never a tenant's namespace. NetworkPolicies let the store scrape the stack, VictoriaLogs and Fluent Bit. vmalert and Grafana reach the store, and only vmalert reaches Alertmanager. No tenant pod reaches any of them.

**The alerts** are the platform's, not the customers':
- the backend down;
- FF's own failures (`platform_error`, `lost`) above 5 % of the calls;
- the API's 5xx above 5 %;
- slow cold starts;
- the rating, the alarms or the notifications behind;
- e-mails failing;
- a month that doesn't reconcile;
- the database near its disk;
- a node not ready or short of memory;
- a platform pod restarting or not running;
- the log collector missing, slow, retrying or giving lines up;
- either store's disk low;
- a target the store can't scrape.

A function's own errors are its owner's, who have alarms (P-52) for them. Payment failures wait for a card gateway (P-34 is skipped).

**The database's disk.** PostgreSQL runs outside the cluster (the plan's D13), so nothing in the cluster sees its disk. The backend reports the database's size (`pg_database_size`) and the disk its deployment declares (`FF_DATABASE_DISK_BYTES`). The alert divides the two, and stays silent while the disk is unknown.

**In development** the stack is opt-in (`hack/k8s/monitoring-up.sh`, or `cluster-up.sh --monitoring`). Its pods in the cluster use about 200 MiB of the 2 GiB node: the store about 60 to 90, kube-state-metrics 40 to 60, the rest about 25 each. Grafana doesn't fit. Measured alone on the host, it needs about 250 MiB of its own memory, whatever `GOMEMLIMIT` says, and reads 340 MB of files as it starts. Started in the cluster beside k3s, the log pipeline and the functions under test, it pushed the node to its cap. The node then read its programs' files from disk at 500 MB a second, the machine's load reached 13 to 18, and Grafana's own start never finished. So the overlay keeps Grafana's Deployment at no replica, and `hack/k8s/grafana.sh` runs the same image on the developer's machine. It takes the Deployment's settings, the data source and the dashboards from git, and reaches the store through a port-forward. Production nodes have the room: there it is a Deployment asking 256 MiB.

The backend runs on the host in development, so the overlay scrapes it through a Service without a selector. Its EndpointSlice holds this machine's address on the k3d network, where the backend listens when `FF_METRICS_HOST` says so: not on every interface.

## Alternatives

- **Prometheus server** (and the kube-prometheus-stack chart). The standard, but the chart brings the Prometheus Operator, its CRDs, node-exporter and a dozen dashboards FF doesn't use: well over a gigabyte on a node of two. A plain Prometheus would do, but VictoriaMetrics is lighter on memory and is already the log store's family.
- **vmagent in front of the store.** It is needed only to scrape from several places or to buffer when the store is away. On one cluster with one store, the store's own scraping is enough, and it is one process fewer.
- **Grafana's own alerting instead of vmalert and Alertmanager.** That would put the rules in Grafana's database or in provisioning files of Grafana's own format, tested only through Grafana. Prometheus-format rules in git, unit-tested in seconds, are portable to any Prometheus-compatible system.
- **VictoriaMetrics' own UI (vmui) instead of Grafana.** It is lighter, but it has no saved dashboards to keep in git, and the operator's dashboards are the point.

## Consequences

- The operator watches the two dashboards and gets e-mails. Production needs a real SMTP server in `alertmanager-config`, and the edge (P-60) decides how Grafana is reached: an IP allowlist, as for the admin dashboard.
- Each rule has tests; a new rule needs its own, in `rules/tests/`, which `hack/k8s/test-monitoring-rules.sh` runs. A new dashboard query must answer with data after L4's run: `hack/k8s/test-monitoring.sh` checks every panel through Grafana.
- In production the backend's pods must carry `app.kubernetes.io/name: ff-backend` and a port named `metrics` (P-60). A ServiceMonitor-style CRD isn't needed: the store finds them by label.
- Retention is 30 days of metrics. Longer history, if wanted, is a recording rule or a bigger volume, not another system.
