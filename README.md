# FF: a serverless functions platform

FF deploys and runs Node.js (TypeScript or JavaScript) and Python functions with AWS Lambda's handler contract, on Kubernetes. It targets markets where international payments and the big clouds are hard to use, such as Tunisia. Customers there get a local platform, and their functions stay portable to AWS Lambda when they move. See the [local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md).

## What works today

- **Functions API** (NestJS, PostgreSQL, S3-compatible storage). You can:
  - create, update, delete, and invoke functions;
  - see the invocation history with durations, and collect metrics.

  Functions scale out when calls arrive together (one instance per call in flight, up to `maxInstances`), scale to zero when idle, and start again on the next invocation.
- **Kubernetes orchestration** ([ADR 0001](docs/adr/0001-orchestrator-kubernetes.md)):
  - each tenant gets its own namespace with a quota, container limits, and a default-deny network policy;
  - the backend uses a least-privilege ServiceAccount, confined to tenant namespaces by an admission policy;
  - code is stored in immutable ConfigMaps, up to 900 KiB. The API currently accepts requests of about 100 KB at most, which is task C-03 of the [CLI plan](docs/cli-plan.md).
- **Runtimes** `ff-runtime-nodejs:24-v2` and `ff-runtime-python:3.13-v2`, runtime protocol 2 ([Node.js](runtimes/nodejs/README.md), [Python](runtimes/python/README.md)):
  - Lambda's `handler(event, context)`, error names, and log lines, with the code's directory as the working directory and the peak memory as `Max Memory Used`;
  - real timeouts;
  - out-of-memory and crashes are handled per invocation, without restarting the container; a replacement that can't load the code again restarts it;
  - non-root, read-only images that install nothing at start.
- **Optional gVisor sandbox** for untrusted code: `K8S_RUNTIME_CLASS=gvisor`. See the [dev guide](docs/kubernetes-dev-guide.md#sandboxing-with-gvisor).
- **Accounts and login:** users sign up and log in through Keycloak (`docker compose --profile auth` starts the development realm), in the console or with tokens. They create accounts that wait for your approval, and act for one account per request. Owners invite members by e-mail, as owners, developers or viewers, and make API keys for scripts and CI, limited to scopes. Another account's functions answer 404 on every route (`hack/e2e-tenancy.sh`). Development acts as one account (`FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID`, or another one named by `X-FF-Dev-Account`), which production refuses.
- **Plans:** each account's plan sets its limits: how many functions, each one's memory, timeout and instances, its namespace's quota, and its rates of changes and invocations, which answer 429 with `Retry-After` beyond them. One plan, `beta`, to start; plans change in SQL until the admin dashboard (client-readiness plan, P-73).
- **Console:** a React + Vite web app in `FE/`: login and sign-up, the new account's onboarding and approval, account settings, members, API keys, and the function pages, which show each role only what it may do.

**Not implemented yet**, despite what older documents say:
- Approving accounts takes SQL until the admin dashboard (client-readiness plan, P-71).
- Billing and payments: no Stripe or local gateways yet; see the market plan.
- Custom domains and function versioning.
- Multi-file packages with dependencies, which need the zip pipeline (parent plan R-02).

Nomad is no longer used; its development VM was removed.

## Repository layout

| Path | Contents |
|---|---|
| `BE/` | Backend: functions API, metrics, scaling, and the orchestrator (`src/orchestrator/kubernetes`) |
| `FE/` | Console (React, Vite, Tailwind) |
| `runtimes/` | Function runtime images, `nodejs/` and `python/`, runtime protocol v1 |
| `deploy/k8s/` | Cluster manifests: `base/` (namespace, RBAC, admission policy), `dev/` (base plus the Service proxy a backend outside the cluster needs) and `optional/` (gVisor) |
| `hack/` | Development scripts: tools, dev cluster, image import, tests, resource guard |
| `infrastructure/` | SeaweedFS (S3) identities for `docker-compose.yml` |
| `docs/` | The [getting-started guide](docs/getting-started.md), plans, ADRs, and the [Kubernetes dev guide](docs/kubernetes-dev-guide.md) |
| `examples/` | Example functions (Node.js and Python) used by the getting-started guide |

## Quick start (development)

For a step-by-step setup and the everyday commands (create, invoke, update, logs, cold starts, tests, reset), follow **[Getting started](docs/getting-started.md)**. The short version:

You need Docker 24+, Node.js 24, Python 3.11+ (for the Python runtime tests), `curl`, and `jq`. Plan for at least 3.5 GB of free memory and 6 GB free on Docker's disk; the [dev guide](docs/kubernetes-dev-guide.md) has the details. The scripts check resources before every heavy step (`hack/check-resources.sh`).

```bash
docker compose up -d --wait                 # PostgreSQL (127.0.0.1:5432) + SeaweedFS S3 (127.0.0.1:9003)
hack/k8s/cluster-up.sh                      # k3d cluster (k3s v1.37.1), RBAC, admission policy, credentials
runtimes/nodejs/test/container-smoke.sh     # builds ff-runtime-nodejs:24-v2 and checks it
runtimes/python/tests/container-smoke.sh    # builds ff-runtime-python:3.13-v2 and checks it
hack/k8s/load-images.sh                     # imports the runtime images into the cluster
cp BE/.env.example BE/.env                  # first time only; the defaults match the steps above
cd BE && npm install && npm run migration:run   # the database schema comes from migrations
npm run start:dev                           # API on http://localhost:3000, Swagger UI on /api
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

For Python, use `"runtime": "python"` and code such as `"def handler(event, context):\n    return {\"message\": \"Hello \" + event[\"body\"].get(\"name\", \"world\")}\n"`. Creating a function returns once it is running (`"status": "ACTIVE"`). On the beta plan, the memory range is 128–1024 MB and the timeout 1–300 s: each account's plan sets its limits and rates ("Plans and limits" in [Getting started](docs/getting-started.md)).

To start the console: `cd FE && npm install && npm run dev`. It runs on http://localhost:5199 and calls the API on localhost:3000, which allows that origin (`CORS_ORIGIN`). Without a login, it acts as the backend's development account. With `VITE_OIDC_AUTHORITY` set (`FE/.env.example`), users log in through Keycloak, sign up, create their account, and manage API keys: see "Log in with Keycloak" in [Getting started](docs/getting-started.md). The metrics charts get a new source in the client-readiness plan (P-50).

## Tests

| Level | Command | What it covers |
|---|---|---|
| L0 backend | `cd BE && npx tsc --noEmit && npm run lint` | Types, and ESLint with type information: promises nobody awaits, unchecked `any` values |
| L1 backend | `cd BE && npm test` | Unit tests: orchestrator against a fake API server, manifests, scaling, services |
| L1 runtimes | `cd runtimes/nodejs && npm test`; `cd runtimes/python && python3 -m unittest discover -s tests` | The runtime protocol on real processes |
| L1 console | `cd FE && npm test` | What the console sends and shows: the fields of an edit, invoke input, API error messages, units; the token and account on each request, token renewal, the account it acts for, API keys; and that its port, client and scopes match the realm and the API (Vitest) |
| L2 database | `cd BE && npm run test:db`; `npm run migration:check` | The migrations against real PostgreSQL, each case in its own scratch database; no drift between the migrations and the entities |
| L2 images | `runtimes/*/test*/container-smoke.sh` | Images run hardened: read-only, uid 10001, no capabilities |
| L3 | `hack/k8s/test-it.sh` | The Kubernetes driver against the dev cluster (deploy, rollout, scale to zero, network policy, memory, gVisor), and the function lifecycle (repair, rollback, updates at zero, a runtime that never answers) |
| RBAC | `hack/k8s/test-rbac.sh` | What the backend's ServiceAccount may and may not do |
| L4 | `hack/e2e.sh` | The whole stack through the REST API, with both runtimes, and the code archive in object storage |
| L5 | `hack/e2e-tenancy.sh` | Every route of the OpenAPI document, as another account (404, nothing changes) and anonymously (401); sign-up through Keycloak and Mailpit; isolation between two real accounts |

## Documentation

- [Getting started](docs/getting-started.md): local setup from a fresh clone, and how to use FF day to day.
- [How FF works](docs/how-it-works.html): every feature from request to result, as step-by-step simulations with the messages and records at each hop (open it in a browser).
- [Kubernetes dev guide](docs/kubernetes-dev-guide.md): cluster, images, tests, gVisor, troubleshooting.
- [Kubernetes migration plan](docs/kubernetes-migration-plan.md): the design and the task log K-00 to K-13.
- [Local markets and AWS portability plan](docs/local-markets-and-aws-portability-plan.md): the product and portability roadmap.
- [CLI plan](docs/cli-plan.md): the `ff` command-line tool, in four phases (proposed).
- [deploy/k8s](deploy/k8s/README.md): what the backend is allowed to do in a cluster, and why.

## License

MIT
