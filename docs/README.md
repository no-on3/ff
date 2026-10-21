# FF documentation

| Document | What it is for |
|---|---|
| [Getting started](getting-started.md) | Set up FF locally from a fresh clone, and the everyday commands |
| [How FF works](how-it-works.html) | Every feature from request to result, as step-by-step simulations with the messages, records, and Kubernetes objects at each hop. Open it in a browser |
| [Kubernetes dev guide](kubernetes-dev-guide.md) | The local cluster, runtime images, tests, the gVisor sandbox, the log pipeline, troubleshooting |
| [Kubernetes migration plan](kubernetes-migration-plan.md) | How FF moved from Nomad to Kubernetes, task by task (K-00 to K-13) |
| [CLI plan](cli-plan.md) | The `ff` command-line tool, in six phases (proposed; brought up to date on 2026-10-21 with login, API keys, the logs API and unique names). Its phases 0 to 2 are step 1's U-08 |
| [Client-readiness plan](client-readiness-plan.md) | Accounts and isolation, metering, prepaid credit at AWS prices in dinars, customer logs, metrics and alarms, the admin dashboard, the production setup, and the pilot launch. Under way: its progress log (section 11) says what is done |
| [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md) | The product and portability roadmap |
| [Step 1 plan](step-1-plan.md) | Make one function useful: environment variables and secrets, AWS's events, function URLs with TLS and custom domains, schedules, then packages and the CLI. Under way: its progress log (section 11) says what is done |
| [What to build next](what-to-build-next.md) | What to add after functions, in which order and why: the next five steps (web addresses, secrets, packages, schedules; a database and file storage; queues; sites, e-mail, a cache; the way out to AWS), then the longer view (proposed) |
| [ADR 0001](adr/0001-orchestrator-kubernetes.md) | Why Kubernetes is FF's orchestrator |
| [ADR 0004](adr/0004-identity-and-tenancy.md) | Accounts, Keycloak login, API keys, account-scoped access, plans, and the operators' separate login. ADR 0002 and 0003 are reserved by the CLI plan |
| [ADR 0005](adr/0005-log-pipeline.md) | The log pipeline: Fluent Bit collects, VictoriaLogs stores, measured against Vector in the P-41 spike; request IDs, the per-namespace limit, deletion and retention |
| [ADR 0006](adr/0006-operator-monitoring.md) | The operator's monitoring: the backend's metrics, VictoriaMetrics, alert rules e-mailed through Alertmanager, Grafana's dashboards |
| [Backup drills](backup-drills.md) | The record of each monthly restore drill |

Elsewhere in the repository:
- [`runtimes/nodejs`](../runtimes/nodejs/README.md) and [`runtimes/python`](../runtimes/python/README.md): the function runtimes, their protocol and their handler contracts;
- [`deploy/k8s`](../deploy/k8s/README.md): what the backend may do in a cluster, and why; the platform's manifests and how to deploy them; the log pipeline's and the monitoring's;
- [`deploy/backup`](../deploy/backup/README.md): the backups of both databases to a second site, the legal records' mirror, and the restore runbook.

Older documents described the platform before Kubernetes: Nomad, MinIO, the old CLI, and an auto-scaling design. They were removed because they no longer matched the code. Git history still has them, for example at commit `46f8397`.
