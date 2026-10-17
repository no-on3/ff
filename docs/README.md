# FF documentation

| Document | What it is for |
|---|---|
| [Getting started](getting-started.md) | Set up FF locally from a fresh clone, and the everyday commands |
| [How FF works](how-it-works.html) | Every feature from request to result, as step-by-step simulations with the messages, records, and Kubernetes objects at each hop. Open it in a browser |
| [Kubernetes dev guide](kubernetes-dev-guide.md) | The local cluster, runtime images, tests, the gVisor sandbox, the log pipeline, troubleshooting |
| [Kubernetes migration plan](kubernetes-migration-plan.md) | How FF moved from Nomad to Kubernetes, task by task (K-00 to K-13) |
| [CLI plan](cli-plan.md) | The `ff` command-line tool, in four phases (proposed) |
| [Client-readiness plan](client-readiness-plan.md) | Accounts and isolation, metering, prepaid credit at AWS prices in dinars, customer logs, metrics and alarms, the admin dashboard, and the pilot launch (proposed) |
| [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md) | The product and portability roadmap |
| [ADR 0001](adr/0001-orchestrator-kubernetes.md) | Why Kubernetes is FF's orchestrator |
| [ADR 0004](adr/0004-identity-and-tenancy.md) | Accounts, Keycloak login, API keys, account-scoped access, plans, and the operators' separate login. ADR 0002 and 0003 are reserved by the CLI plan |
| [ADR 0005](adr/0005-log-pipeline.md) | The log pipeline: Fluent Bit collects, VictoriaLogs stores, measured against Vector in the P-41 spike; request IDs, the per-namespace limit, deletion and retention |

Elsewhere in the repository:
- [`runtimes/nodejs`](../runtimes/nodejs/README.md) and [`runtimes/python`](../runtimes/python/README.md): the function runtimes, their protocol and their handler contracts;
- [`deploy/k8s`](../deploy/k8s/README.md): what the backend may do in a cluster, and why; the log pipeline's manifests.

Older documents described the platform before Kubernetes: Nomad, MinIO, the old CLI, and an auto-scaling design. They were removed because they no longer matched the code. Git history still has them, for example at commit `46f8397`.
