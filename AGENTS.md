<!-- bmad:context -->
<!-- Verified 2026-11-01 against c7cc004. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## ff

Serverless functions platform (AWS Lambda contract on Kubernetes). NestJS backend (`BE/`), React consoles (`FE/`, `admin/`), Rust CLI (`cli/`), Node and Python runtimes. How to run: [docs/getting-started.md](docs/getting-started.md). Plans and ADRs live under `docs/`. Each plan's §6 adds step-specific working rules on top of this file.

## Policy

- One heavy process at a time on a shared machine: a build (`npm ci`, `cargo`, `docker build`), image pull/import, cluster create/change, or test suite (L1–L5, the `ff` suite, a `hack/ci.sh` stage). Never two suites at once, never a build while a suite runs; background counts as running. Run `hack/check-resources.sh` first. Cap workers: `FF_CI_JOBS=2 hack/ci.sh <stage>`; Jest/Vitest `--maxWorkers=2`; `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2`. No parallel helpers that build or test. GitHub runners may parallelize; this rule is for one machine.
- Refactor as you go on touched code; keep behavior; put suite counts before/after in the plan's log. A refactor bigger than the task gets its own commit before the task's, named in the log. Never drop a check.
- One commit per task or part: `type(scope): summary (X-xx)`, with its tests and docs; the plan's progress log in the same commit.
- Never put task or decision numbers in code, comments, or tests — say why in plain words.
- A new API route must get rules in both of L5's loops (`hack/e2e-tenancy.sh`), or L5 fails.
- Never commit `.env` / `.env.*.local`; copy from `BE/.env.example`, `FE/.env.example`, `admin/.env.example`.
- Never change the console port `5199` or admin port `5198` (`strictPort` — CORS and OIDC redirect URIs).

## Where things are

- Backend API: `BE/src/` (NestJS); OpenAPI from the running API; tenancy e2e: `hack/e2e-tenancy.sh`
- Customer console: `FE/` → http://localhost:5199; operator admin: `admin/` → http://localhost:5198
- CLI `ff`: `cli/`; runtimes: `runtimes/nodejs`, `runtimes/python`
- Pipeline entry: `hack/ci.sh`; what a change needs: `hack/ci.sh suggest` (map: `hack/suggest.map`)
- Deploy manifests: `deploy/`; local SeaweedFS identities: `infrastructure/seaweedfs/`
- Cluster/dev detail: [docs/kubernetes-dev-guide.md](docs/kubernetes-dev-guide.md); feature walkthrough: [docs/how-it-works.html](docs/how-it-works.html)

## Running and verifying

- Backend needs Node.js `>=24.15.0` (`BE/package.json` engines). Run Jest via `npm test` / `npm run test:db` so `BE/.npmrc` passes `--experimental-vm-modules`.
- Before verifying a change, run `hack/ci.sh suggest`, then one suggested stage or suite at a time (resource check first).
- Python runtime tests: `cd runtimes/python && python3 -m unittest discover -s tests` (Python 3.11+).
- After changing a DTO or shared constant: `cargo test` in `cli/`, and Vitest in both `FE/` and `admin/` (contract tests mirror BE sources). After rewording an API message, search `hack/` and run the suite that asserts it.

## Conventions that differ from defaults

- ESLint is the style check; there is no Prettier config — do not run `prettier --write` (it rewrites whole files). `BE`'s `npm run format` script exists but is not the project standard.
- Shell scripts under `pipefail`: never pipe into `grep -q` (use `… | grep pattern >/dev/null` or grep a file). Wait for Postgres with `pg_isready -h 127.0.0.1`, never the socket alone — `hack/ci.sh static` refuses both races.

## Known pitfalls

- Stale `BE/.env` (old console port `5173`, missing registry, wrong `FF_DEV_USER_ID`) breaks local login and deploys — refresh from `BE/.env.example`.
- After the machine changes networks, restart the k3d cluster with `hack/bin/k3d` (not a bare `k3d` on PATH) or DNS inside the cluster stays wrong; see getting-started troubleshooting.

<!-- /bmad:context -->
