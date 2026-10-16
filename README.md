# FF: a serverless functions platform

FF deploys and runs Node.js (TypeScript or JavaScript) and Python functions with AWS Lambda's handler contract, on Kubernetes. It targets markets where international payments and the big clouds are hard to use, such as Tunisia. Customers there get a local platform, and their functions stay portable to AWS Lambda when they move. See the [local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md).

## What works today

- **Functions API** (NestJS, PostgreSQL, S3-compatible storage). You can:
  - create, update, delete, and invoke functions;
  - see the invocation history with durations, and collect metrics.

  Functions scale to zero when idle and start again on the next invocation.
- **Kubernetes orchestration** ([ADR 0001](docs/adr/0001-orchestrator-kubernetes.md)):
  - each tenant gets its own namespace with a quota, container limits, and a default-deny network policy;
  - the backend uses a least-privilege ServiceAccount, confined to tenant namespaces by an admission policy;
  - code is stored in immutable ConfigMaps, up to 900 KiB.
- **Runtimes** `ff-runtime-nodejs:24-v1` and `ff-runtime-python:3.13-v1` ([Node.js](runtimes/nodejs/README.md), [Python](runtimes/python/README.md)):
  - Lambda's `handler(event, context)`, error names, and log lines;
  - real timeouts;
  - out-of-memory and crashes are handled per invocation, without restarting the container;
  - non-root, read-only images that install nothing at start.
- **Optional gVisor sandbox** for untrusted code: `K8S_RUNTIME_CLASS=gvisor`. See the [dev guide](docs/kubernetes-dev-guide.md#sandboxing-with-gvisor).
- **Dashboard:** a React + Vite frontend in `FE/`.

**Not implemented yet**, despite what older documents say:
- **Authentication is not enforced.** Auth0 JWT validation exists, but its guard is disabled, and development uses a fixed tenant (`FF_DEV_USER_ID`).
- Billing and payments: no Stripe or local gateways yet; see the market plan.
- Custom domains and function versioning.
- Multi-file packages with dependencies, which need the zip pipeline (parent plan R-02).

Nomad is no longer used. `nomad-vagrant/` is kept only for reference.

## Repository layout

| Path | Contents |
|---|---|
| `BE/` | Backend: functions API, metrics, scaling, and the orchestrator (`src/orchestrator/kubernetes`) |
| `FE/` | Dashboard (React, Vite, Tailwind) |
| `runtimes/` | Function runtime images, `nodejs/` and `python/`, runtime protocol v1 |
| `deploy/k8s/` | Cluster manifests: `base/` (namespace, RBAC, admission policy) and `optional/` (gVisor) |
| `hack/` | Development scripts: tools, dev cluster, image import, tests, resource guard |
| `infrastructure/` | SeaweedFS (S3) identities, Prometheus, and Grafana configuration for `docker-compose.yml` |
| `docs/` | Plans, ADRs, and the [Kubernetes dev guide](docs/kubernetes-dev-guide.md) |
| `cli/`, `cli-rust/`, `lambda-func/`, `scripts/` | Earlier prototypes (packaging CLIs, the old function wrapper, old setup scripts); not used by the current stack |
| `nomad-vagrant/` | Deprecated Nomad VM |

## Quick start (development)

You need Docker 24+, Node.js 24, Python 3.11+ (for the Python runtime tests), `curl`, and `jq`. Plan for at least 3.5 GB of free memory and 6 GB free on Docker's disk; the [dev guide](docs/kubernetes-dev-guide.md) has the details. The scripts check resources before every heavy step (`hack/check-resources.sh`).

```bash
docker compose up -d --wait                 # PostgreSQL (127.0.0.1:5432) + SeaweedFS S3 (127.0.0.1:9003)
hack/k8s/cluster-up.sh                      # k3d cluster (k3s v1.37.1), RBAC, admission policy, credentials
runtimes/nodejs/test/container-smoke.sh     # builds ff-runtime-nodejs:24-v1 and checks it
runtimes/python/tests/container-smoke.sh    # builds ff-runtime-python:3.13-v1 and checks it
hack/k8s/load-images.sh                     # imports the runtime images into the cluster
cp BE/.env.example BE/.env                  # first time only; the defaults match the steps above
cd BE && npm install && npm run start:dev   # API on http://localhost:3000, Swagger UI on /api
```

Create a function and invoke it:

```bash
curl -s localhost:3000/functions -H 'content-type: application/json' -d @- <<'EOF'
{"name": "hello", "runtime": "nodejs", "memory": 128, "timeout": 5,
 "code": "export async function handler(event) { return { message: `Hello ${event.body.name ?? 'world'}` }; }"}
EOF
curl -s -X POST localhost:3000/functions/<id>/invoke -H 'content-type: application/json' -d '{"input": {"name": "FF"}}'
# → {"status": "COMPLETED", "output": {"message": "Hello FF"}, "duration": 0.48, …}
```

For Python, use `"runtime": "python"` and code such as `"def handler(event, context):\n    return {\"message\": \"Hello \" + event[\"body\"].get(\"name\", \"world\")}\n"`. Creating a function returns once it is running (`"status": "ACTIVE"`). The memory range is 128–1024 MB and the timeout 1–300 s.

To start the dashboard: `cd FE && npm install && npm run dev`. It runs on http://localhost:5173 and calls the API on localhost:3000, which allows that origin (`CORS_ORIGIN`). Its pages were not reviewed during the Kubernetes migration.

## Tests

| Level | Command | What it covers |
|---|---|---|
| L1 backend | `cd BE && npm test` | Unit tests: orchestrator against a fake API server, manifests, scaling, services |
| L1 runtimes | `cd runtimes/nodejs && npm test`; `cd runtimes/python && python3 -m unittest discover -s tests` | The runtime protocol on real processes |
| L2 | `runtimes/*/test*/container-smoke.sh` | Images run hardened: read-only, uid 10001, no capabilities |
| L3 | `hack/k8s/test-it.sh` | The Kubernetes driver against the dev cluster (deploy, rollout, scale to zero, network policy, memory, gVisor) |
| RBAC | `hack/k8s/test-rbac.sh` | What the backend's ServiceAccount may and may not do |
| L4 | `hack/e2e.sh` | The whole stack through the REST API, with both runtimes |

## Documentation

- [Kubernetes dev guide](docs/kubernetes-dev-guide.md): cluster, images, tests, gVisor, troubleshooting.
- [Kubernetes migration plan](docs/kubernetes-migration-plan.md): the design and the task log K-00 to K-13.
- [Local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md): the product and portability roadmap.
- [deploy/k8s](deploy/k8s/README.md): what the backend is allowed to do in a cluster, and why.

## License

MIT
