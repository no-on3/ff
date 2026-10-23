# FF documentation

| Document | What it is for |
|---|---|
| [Getting started](getting-started.md) | Set up FF locally from a fresh clone, and the everyday commands |
| [How FF works](how-it-works.html) | Every feature from request to result, as step-by-step simulations with the messages, records, and Kubernetes objects at each hop. Open it in a browser |
| [Kubernetes dev guide](kubernetes-dev-guide.md) | The local cluster, runtime images, tests, the gVisor sandbox, the log pipeline, troubleshooting |
| [Kubernetes migration plan](kubernetes-migration-plan.md) | How FF moved from Nomad to Kubernetes, task by task (K-00 to K-13) |
| [CLI plan](cli-plan.md) | The `ff` command-line tool, in six phases. Its phases 0 to 2 are step 1's U-08, done: its progress log (section 12) says what is done |
| [Client-readiness plan](client-readiness-plan.md) | Accounts and isolation, metering, prepaid credit at AWS prices in dinars, customer logs, metrics and alarms, the admin dashboard, the production setup, and the pilot launch. Under way: its progress log (section 11) says what is done |
| [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md) | The product and portability roadmap |
| [Step 1 plan](step-1-plan.md) | Make one function useful: environment variables and secrets, AWS's events, function URLs with TLS and custom domains, schedules, then packages and the CLI. Done in development: its progress log (section 11) says what was built; ADR 0003, confirmed since, brings the rest |
| [Step 2 plan](step-2-plan.md) | A database and file storage: managed PostgreSQL, one database and its user per account, and buckets on FF's S3 store with the account's own keys, metered and billed as AWS's, each with a way out. Confirmed on 2026-10-22, started on 2026-10-23: its progress log (section 11) says what is built |
| [What to build next](what-to-build-next.md) | What to add after functions, in which order and why: the next five steps (web addresses, secrets, packages, schedules; a database and file storage; queues; sites, e-mail, a cache; the way out to AWS), then the longer view (proposed) |
| [Console design plan](console-design-plan.md) | The console's look, direction A (navy and paper), chosen on 2026-10-22: the direction with where each color and font comes from, how it is built, and its tasks W-00 to W-06 |
| [Decision log](decisions.md) | Every decision you made about FF, newest first: what it means, what it changed (with the commits), what is still to change; and the questions still waiting for you |
| [ADR 0001](adr/0001-orchestrator-kubernetes.md) | Why Kubernetes is FF's orchestrator |
| [ADR 0002](adr/0002-cli.md) | The `ff` command: one Rust binary that talks only to the API, its configuration and tokens, functions by name, Lambda's packaging rules, its exit codes |
| [ADR 0003](adr/0003-code-delivery.md) | How a function's code reaches its pods: each version's code an image in a registry in the cluster, mounted at `/var/task` on its runtime's image; measured against an image per version, by a spike (accepted on 2026-10-21) |
| [ADR 0004](adr/0004-identity-and-tenancy.md) | Accounts, Keycloak login, API keys, account-scoped access, plans, and the operators' separate login |
| [ADR 0005](adr/0005-log-pipeline.md) | The log pipeline: Fluent Bit collects, VictoriaLogs stores, measured against Vector in the P-41 spike; request IDs, the per-namespace limit, deletion and retention |
| [ADR 0006](adr/0006-operator-monitoring.md) | The operator's monitoring: the backend's metrics, VictoriaMetrics, alert rules e-mailed through Alertmanager, Grafana's dashboards |
| [ADR 0007](adr/0007-function-events.md) | The event a function receives: AWS Lambda's, the payload itself, built by the backend for every way in; functions made before keep FF's original wrapper until switched |
| [ADR 0008](adr/0008-customer-databases.md) | Customers' databases: a PostgreSQL 18 server of their own, a database and its user per customer with opaque names, what the backend's role may do there without being a superuser, functions reaching it with their account's internet access off, the read-only signal past the plan's storage, the connection string and certificates; measured by step 2's spike (accepted on 2026-10-23) |
| [ADR 0009](adr/0009-buckets.md) | Buckets behind FF's S3 front door: AWS's Signature Version 4 and the SDKs' streaming uploads, checksums as S3 checks them, both addressings, an IP address for functions, requests counted by AWS's classes; measured by step 2's spike against three AWS clients (accepted on 2026-10-23) |
| [Backup drills](backup-drills.md) | The record of each monthly restore drill |
| [En français](fr/README.md) | For FF's customers, a page per service in French: [databases](fr/bases-de-donnees.md), as AWS RDS gives them, and [files in buckets](fr/compartiments.md), as AWS S3 gives them |

Elsewhere in the repository:
- [`runtimes/nodejs`](../runtimes/nodejs/README.md) and [`runtimes/python`](../runtimes/python/README.md): the function runtimes, their protocol and their handler contracts;
- [`deploy/k8s`](../deploy/k8s/README.md): what the backend may do in a cluster, and why; the platform's manifests and how to deploy them; the log pipeline's and the monitoring's;
- [`deploy/backup`](../deploy/backup/README.md): the backups of both databases and of customers' databases to a second site, the mirror of the legal records and functions' packages, and the restore runbooks, one customer's database from a point in time among them;
- [`deploy/data-db`](../deploy/data-db/README.md): the server of customers' databases, and how to install it.

Older documents described the platform before Kubernetes: Nomad, MinIO, the old CLI, and an auto-scaling design. They were removed because they no longer matched the code. Git history still has them, for example at commit `46f8397`.
