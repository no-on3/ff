# Code search plan: CIAK as a service of FF's

| | |
|---|---|
| **Status** | **Proposed on 2026-10-31, not confirmed.** Checked the same day against FF's code (`feat/step-5`) and CIAK's (its own repository, SmartProject) by a read-only survey (§1). Nothing is built. It waits for §9's choices, and it is not part of step 5 (§9, 9). |
| **Goal** | A developer's AI coding agent (Claude Code, Cursor, or any other client of the Model Context Protocol, MCP) searches the developer's own code through FF. The index lives on a server of FF's in Tunisia, and the bill is paid in dinars from the account's credit. The service runs CIAK, an open-source (MIT) code index, on FF's own servers. FF does not resell CIAK's subscriptions at ciak.at |
| **Parent plans** | [What to build next](what-to-build-next.md): §9.6 (developer tools), §9.1 (open models hosted here, which this service pairs with), §9.8 (card top-ups, before FF takes individual developers), §10 (what every new service needs), §11 (nothing that depends on a foreign paid service). The [local markets and AWS portability plan](local-markets-and-aws-portability-plan.md) §1.1: what paying a supplier abroad costs, the card allowances, and INPDP's authorization for personal data sent abroad |
| **Builds on** | Step 4's server of customers' caches and its agent (`deploy/cache/`), the pattern for the code-index server; the front doors of steps 2 to 5, each a port of the backend's own; plans, the price book and hourly rating, as every service since step 2; FF's credit (P-74) for the pilot's accounts |
| **Decision records** | An ADR of its own (the code-index server and its front door), from I-02's spike, numbered when this plan is confirmed: the [developer tools plan](dev-tools-plan.md) took 0017 and 0018 |

Task numbers start with I, for *index*. CIAK keeps its own task numbers (R01 to R31, in its repository's `ciak_project/next/remaining_tasks_2026-10-31.md`); I-01 names the ones this plan waits for.

## 1. Where FF and CIAK stand

Checked against both repositories on 2026-10-31.

### FF

| Finding | Where | Consequence |
|---|---|---|
| **Six front doors, each a port of the backend's own:** function URLs 3001, S3 3002, SQS 3003, sites 3004, SES 3005, Lambda's API 3006 (step 5). | `BE/src/config/configuration.ts`, [ADR 0014](adr/0014-lambda-api.md) | Code search is the seventh, on 3007 at `code.<domain>` (D3). |
| **Customers' resources that aren't functions run on servers apart from the cluster,** each with an agent of FF's that the backend calls over HTTPS with a token: customers' databases, caches and mail. | `deploy/data-db/`, `deploy/cache/agent.mjs`, `deploy/mail/` | The code-index server follows the cache server's shape (D2). |
| **A limit and a billed kind each follow one recipe:** the plan's schema and a migration, the admin app's and the console's lists, `ff account`; an append-only measure, a kind of `resource_usage_hourly`, a SKU in the price book. | `BE/src/plans/plan-limits.ts`, `BE/src/billing/price-book.ts`, `BE/src/billing/hourly-rating.service.ts` | The index's size and its calls are two kinds more (D5, D6). |
| **Rate limits are the backend's, in its memory,** per plan. | `BE/src/plans/rate-limits.ts` | The front door limits calls before CIAK sees them (D3). |
| **Each service has its scopes,** `<service>:read` and `<service>:write`, from `alarms:read` to `usage:read`, and each route has its rules in both of L5's loops. | `BE/src/`, `hack/e2e-tenancy.sh` | `code:read` and `code:write` (D3). |
| **Credit comes by bank transfer and from FF** (P-34 skipped, P-74). Bank transfer only works for companies (What to build next §9.8). | [Client-readiness plan](client-readiness-plan.md) | An individual developer, this service's most likely buyer, can't pay yet (§8, §9, 9). The pilot's accounts are given credit (§9, 7). |
| **Paying a supplier abroad costs a Tunisian buyer more:** payments through an approved intermediary, VAT by reverse charge (19%), maybe a 15% withholding tax; an individual's card allows 1,000 TND a year. Reselling a foreign service is "a lawyer first". | Parent plan §1.1; What to build next §9.1 | FF runs CIAK's code itself rather than reselling ciak.at's subscriptions (D1). |

### CIAK

Paths are in CIAK's repository.

| Finding | Where | Consequence |
|---|---|---|
| **What it is:** a code index for AI agents. `ciak scan` parses TypeScript, JavaScript, Python and Rust on the developer's machine into a SQLite index. `ciak sync` sends it to a server. `ciak-mcp-server`, which the agent runs, asks that server (`CIAK_API_URL`) for symbols, relationships, and a context of code bodies cut to a token budget. MIT licensed; its embedding model (CodeBERT) runs locally; Qdrant, for semantic search, is open source. It needs no foreign paid service. | `ciak_project/src/rust/{cli,mcp_server,api_server}`, `ciak_project/LICENSE` | It passes What to build next §11 (D1). |
| **Two programs take a sync:** CIAK's NestJS backend writes each project's SQLite index and keeps its sync records in PostgreSQL; `sync_worker` writes vectors to Qdrant. Searches are answered by CIAK's Rust `api_server`. | `ciak_backend/src/sync/sync.controller.ts`, `ciak_backend/src/sync/sqlite-sync.service.ts`, `ciak_project/src/rust/sync_worker/` | FF runs the API server and the sync intake; `sync_worker` and Qdrant only with semantic search (D2, §9, 5). |
| **Any API key can read any file on CIAK's server:** `POST /code-context/extract` and `/code-context/batch` read the path they are sent, with no check that it belongs to the caller's project, and their rule asks only for a normal API scope. | `ciak_project/src/rust/api_server/src/handlers/code_context.rs:108`, `ciak_project/src/rust/api_server/src/middleware/route_scope.rs` (`code_context.extract`) | Never forwarded by FF's front door, and fixed in CIAK before the pilot (D3, I-01). |
| **A sync's body, up to 1 GB, is read before the caller is checked:** the body parser runs before the guards. | `ciak_backend/src/main.ts` (`SYNC_REQUEST_BODY_LIMIT = '1gb'`), `ciak_project/src/rust/sync_worker/src/main.rs` (1 GiB) | FF's front door checks the key and the plan's size before it forwards a byte (D3). |
| **No rate limits** in CIAK's API server. | `ciak_project/src/rust/api_server/src/` | FF's own (D3). |
| **Callers may change the server's settings:** `POST /vector/config`, `/query/config`, `/config`, `/config/import/:filename` and `/config/export/:filename` (a file the caller names), and the caches' clears. | `ciak_project/src/rust/api_server/src/main.rs` | Never forwarded (D3). |
| **A sync sends the full source by default** (`SyncProfile::Full`; `snippet_limited` and `index_only` exist). | `ciak_project/src/rust/common/src/cloud_sync.rs` | FF's default is §9's fourth choice (D4). |
| **The plan is CIAK's own:** its users table, Stripe, a license file. Plan-based guarding has been half built since March, and a tier is never lowered (CIAK's review of 2026-10-16). | `ciak_project/next/cloud_api_entitlements_and_sync_guarding_plan.md` | For FF's accounts CIAK checks no plan: the front door does, and CIAK trusts it (D3, I-01). |
| **CIAK's MCP server needs a server to talk to,** and CIAK doesn't ship one to developers yet; whether it will (a local MCP mode, or a cloud-only free tier) is an open question of CIAK's. | CIAK's review of 2026-10-16 | The way out for agents waits for that answer (D9, §8). |
| **Open in CIAK's own list:** the evaluation re-run (R02), full scans that keep files deleted on disk (R31), a 28 s cold start on a 271 MB index (R14). **Done:** no simulated results (R01), vector search without Qdrant says so rather than failing (R13), local monorepo packages' imports (R30). | `ciak_project/next/remaining_tasks_2026-10-31.md` | R02 and R31 before the pilot; R14 measured by I-02 (§8). |

## 2. Goals and non-goals

**Goals:**

1. **Code search for an account:** a developer indexes a repository on their machine, sends the index to FF with one command, and their AI agent searches it through FF's endpoint with the account's API key.
2. **Billed as FF bills:** the index's size and its calls measured, rated hourly, paid from the account's credit in dinars, within the plan's limits.
3. **The developer's code stays in Tunisia,** on a server of FF's, read by nothing but the account's keys. FF's operators see sizes and counts, never code.
4. **A pilot that proves it:** a few beta accounts, their agents' token use measured with and without it, before a price is set.

**Non-goals:** reselling ciak.at's subscriptions; CIAK's own billing, accounts or license files for FF's accounts; indexes built on FF's servers from a Git repository (with build from source, What to build next §9.1); indexing the functions' packages already on FF; semantic search in the first version (§9, 5); seats and teams; an AI model (§9.1's open models are a plan of their own).

## 3. Decisions

Proposed, each with its choice in §9.

### D1. FF runs CIAK; it doesn't resell it
- FF runs CIAK's MIT code on its own server, under FF's name, sold and invoiced by FF's Tunisian company in dinars. No money goes abroad, so the reverse-charge VAT, the withholding tax and the exchange rules don't apply to it, and the customer's code never leaves the country.
- ciak.at stays CIAK's own business, selling outside Tunisia. The two share code, not customers or money.
- The documentation says plainly that the service runs CIAK, with its license and its version.

### D2. The server of customers' code indexes
- A server apart from the cluster, as customers' databases and caches have, with FF's agent (`deploy/code/`): CIAK's API server and its sync intake, their images pinned to a version. Each account is a CIAK tenant under the server's data directory, in CIAK's own layout (`tenants/<account>/projects/<project>/database.db`).
- **One CIAK server for every account,** not a process each as caches have. CIAK keeps tenants apart by their directory, and its path checks refuse an escape. A process each would cost a cold start each (28 s on a 271 MB index, CIAK's R14). I-02's spike measures what three tenants cost; the question comes back if one tenant can slow the others (§8).
- Reached neither from the internet nor from functions: only the backend's front door and the agent reach it.
- **The agent** makes and deletes a tenant, measures each project's index on disk, and stops a tenant when its account is suspended. It has no route that returns code.
- **No backups:** an index is made from the developer's code, and a `ciak sync` makes it again. The restore runbook says so (§9, 6).

### D3. The front door
- The backend's seventh server, on `FF_CODE_PORT` (3007), at `https://code.<domain>` behind the edge.
- Each call carries one of the account's API keys, with `code:read` (searches) or `code:write` (syncs and deletions). The front door sets CIAK's tenant from the key's account and drops any tenant the caller sent. CIAK's own login and license checks are off behind it (its trusted mode, I-01), so CIAK never decides who a caller is.
- **An allow-list:** only the routes that CIAK's MCP server and `ciak sync` call are forwarded, as I-02 records them. Never forwarded: the settings' writes, the caches' clears, the import and export of settings, the debug routes, and `/code-context/extract` and `/code-context/batch` until I-01 limits them to the caller's own indexed files.
- Before a sync is forwarded, its key is checked and its body is held to what is left of the plan's index size. A larger body is refused before it is read.
- Calls are counted by the minute and limited by the plan's `codeRequestsPerSecond`. A suspended account's calls are refused.
- Every route, FF's own (`/code/projects`) and the forwarded ones, has its rules in both of L5's loops.
- The audit log: `code.sync`, `code.project.delete`, `code.settings`.

### D4. Getting code in
- The developer's machine builds the index: `ciak scan`, then `ciak sync` with `CIAK_API_URL=https://code.<domain>` and the account's key. FF builds nothing; CIAK's parsers run where the code is.
- FF's default sync profile is `snippet_limited` (bounded snippets, no wide blocks). The account's setting turns `full` on, and the console says what each sends (§9, 4).
- `ff code setup` makes a key with `code:read` and `code:write`, and writes the agent's MCP configuration for the repository (`ciak-mcp-server` and its two variables) for the clients the docs list.

### D5. Plans: new limits
- `codeProjects` (3 on beta), `codeIndexMb` (1,024 on beta; a NestJS repository of 27,113 symbols has an index of 271 MB, CIAK's benchmark) and `codeRequestsPerSecond` (5 on beta). Each in the plan's schema, the admin app's plan editor, the console's account page and `ff account`. The numbers are set again from the pilot.

### D6. Usage and billing
- No AWS service has this shape, so there is no AWS price to copy. The index is billed by the GB-month, measured each hour as customers' databases are; calls by the thousand, counted by the minute.
- The SKUs `codeIndexGbMonth` and `codeRequestsPerThousand` in the price book, at the book's rate. Priced after the pilot (I-09), aiming for one developer with an index of about 300 MB and a normal month's calls to pay about CIAK's Developer tier, 7 US$ a month, at the book's rate.
- No free tier: CIAK's local mode is free for a developer who doesn't want to pay.
- In `GET /usage` and its CSV, the console's Usage page, `ff usage`, the statement and its PDF ("Recherche de code | Go-mois | Requêtes | Montant HT"), the admin app's price editor and the reconciliation.

### D7. Suspension, credit and closure
- Suspended: every call is refused. Without credit: searches go on and syncs wait for credit, as uploads to buckets do. Closed: the account's tenant goes with its data, at its deletion date.

### D8. Metrics and alarms
- CloudWatch has no names for this, so FF's own, for the account and for each project: `Requests` and `Errors` (Sum), `Latency` (p50, p95), `IndexBytes` (Maximum), `Syncs` (Sum). Alarms on all of them, as on every service's.

### D9. The way out
- The data is the customer's own code, which they already have. To leave, a developer keeps `ciak scan` and CIAK's CLI on their own machine, or uses ciak.at outside Tunisia.
- An agent can leave only once CIAK's MCP server works without a server of FF's or ciak.at's. That is CIAK's open question (§1); the export kit's page says what works on the day I-08 writes it.

### D10. Customers' code
- Customer content, as a bucket's files are: never read by FF's operators. The admin app shows each project's size, its last sync and its calls, never a file or a symbol. An operator can turn the service off for one account, with a reason.
- A repository may hold personal data (fixtures, seeds, dumps). On a foreign service it would leave the country, which needs INPDP's authorization (Law 2004-63, art. 52); here it stays. The parent plan's data-protection work (§9.2) covers it as it covers buckets.
- Abuse limits (What to build next §10, 10): the plan's index size, projects and calls; the front door's allow-list; one tenant's searches measured against another's latency by I-02.

## 4. Data model

Proposed, each table with `account_id`:

- `code_projects`: CIAK's project ID, its name, its index's size, its last sync, its status.
- `code_samples`: each project's index size by the hour, from the agent; by month, append-only.
- `code_request_counts`: by the minute, each project's calls and errors.
- The account's sync profile, `snippet_limited` or `full`.
- `resource_usage_hourly`: the kind `code`.

## 5. API changes

Proposed:

- **The front door** at `code.<domain>`: the allow-listed CIAK routes (D3), with `code:read` or `code:write`.
- **FF's API:** `GET /code/projects`, `GET` and `DELETE /code/projects/:id`, `GET /code/projects/:id/metrics`, `GET` and `PUT /code/settings` (the sync profile); `code` in `GET /usage`; `GET` and `PUT /admin/accounts/:id/code` for operators. Each in both of L5's loops.

## 6. Working rules

The repository's (`CLAUDE.md`): one heavy process at a time; a commit for each task or part, with its tests, its documents and this plan's log; a new route's rules in both of L5's loops; the console checked in a browser, at a phone's width too. CIAK's changes (I-01) are made and committed in CIAK's repository, under its rules, and FF pins the version they land in.

## 7. Tasks

### Phase 0: groundwork

#### I-00: The plan and the baseline
- This plan confirmed, §9's choices in the decision log; the branch made; every suite green, with its counts in the log.

#### I-01: CIAK's side, in CIAK's repository
- `/code-context/extract` and `/code-context/batch` read only the files of the caller's indexed projects.
- A trusted mode for the API server and the sync intake: the tenant taken from a header only a caller with the front door's token may set; no license or login check; every feature on; the sync body's limit a setting.
- `ciak sync` and `ciak-mcp-server` with one key, sent as a bearer token, and no tenant of their own.
- CIAK's R31 (files deleted on disk) and R02 (the evaluation, which the pilot is compared with).

#### I-02: Spike and its ADR
- CIAK's server on a server apart, with three tenants: its memory and disk, a cold start on a 271 MB index, and one tenant's heavy searches against another's latency.
- FF's own repository indexed and synced: the index's size and the time each step takes.
- The routes CIAK's MCP server and `ciak sync` call, recorded: the allow-list.
- Claude Code through a minimal front door. Its ADR records what was measured and decided.

### Phase 1: the server and the front door

#### I-03: The server of customers' code indexes
- D2: `deploy/code/`, CIAK's images pinned, FF's agent, TLS; `docker-compose.yml`'s `code` and `hack/k8s/code-up.sh` in development; L2's to L5's servers of their own; `deploy/code/README.md` says how to install it.

#### I-04: The front door and the API
- D3, D7, D10: `FF_CODE_PORT`, the allow-list, the key and size checks, the counts, the limits, suspension; `/code/projects` and `/code/settings`; the audit log; L5's rules.

### Phase 2: the product

#### I-05: Plans, usage and the bill
- D5 and D6: the limits and their migration; the hourly samples, the kind `code`, its SKUs; the statement's line.

#### I-06: The console, `ff` and the admin app
- The console's Code search page: projects, sizes, last syncs, the sync profile, and the agent's setup. `ff code setup|projects|delete`. The admin app's account page and its switch.

#### I-07: Metrics and alarms
- D8: `GET /code/projects/:id/metrics`, the account's, alarms on them, the console's alarm form.

### Phase 3: the pilot and the close

#### I-08: Documentation
- Getting started's "Code search for your AI agent", `how-it-works.html`'s scenario, a page in French (`fr/recherche-de-code.md`), the export kit's page, its ADR as built.

#### I-09: The pilot and the price
- Three to five beta accounts, given credit (P-74), on their own repositories: their agents' tokens and answers with and without code search. The SKUs' prices set from it. What to build next §9.6 says code search is there.

## 8. Risks

| Risk | What lowers it |
|---|---|
| One account reads another's code | The front door sets the tenant itself and forwards only the allow-list (D3); I-01's fix of the file reads; CIAK's tenant directories and path checks; L5's loops on every route; a process per account if I-02 finds a way across |
| Few customers can use it: most AI coding agents also need a foreign card, and an individual's card allows 1,000 TND a year | The pilot asks first (I-09). It pairs with open models hosted by FF (What to build next §9.1), which would make the agent payable in dinars too. It costs little to keep running if few use it |
| Its buyers are individual developers, and FF takes credit only by bank transfer, which works for companies | Card top-ups first (What to build next §9.8), or a pilot of companies (§9, 9) |
| One tenant's large index slows everyone (CIAK's cold start: 28 s on 271 MB) | Measured by I-02; the plan's index size; a second server, or a process of its own for the largest accounts |
| CIAK changes under FF | Its images pinned to a version; I-01's changes covered by CIAK's own tests; FF's L4 against the pinned version |
| A customer indexes secrets (keys in files they didn't mean to send) | `snippet_limited` by default (D4); the docs say what `ciak scan` reads and how to leave files out; the account's deletion of a project removes its index at once |
| The pilot shows no saving on real repositories | No price until it does (I-09); CIAK's R02 numbers first |
| An agent can't leave without a server | CIAK's open question answered before I-08 writes the way out (D9) |

## 9. Choices to make

Proposed on 2026-10-31, each with what it means and its recommendation:

1. **Run or resell:** FF runs CIAK's code on its own server and sells it as FF's (D1); or FF resells ciak.at's subscriptions, paid abroad. **Recommended: run it.** Reselling means paying a supplier abroad, with its taxes and the exchange rules, which is what FF exists to avoid.
2. **Isolation:** one CIAK server with a tenant per account; or a CIAK process per account, as caches have. **Recommended: one server,** with the front door's allow-list and I-01's fixes, unless I-02's spike finds one tenant can reach or slow another.
3. **Where indexes are built:** on the developer's machine (D4); or on FF's servers from a Git repository. **Recommended: the developer's machine.** FF's own builds come with build from source.
4. **What a sync sends by default:** `snippet_limited`; `full`, CIAK's default; or `index_only`. **Recommended: `snippet_limited`,** with `full` as the account's setting: less of the customer's code on FF's server, at the cost of shorter code in the agent's context. The pilot compares both.
5. **Semantic search in the first version:** without it (symbols, text, relationships and context work without Qdrant); or with `sync_worker` and Qdrant on the server. **Recommended: without,** added if the pilot asks for it.
6. **Backups:** none, since a sync makes an index again; or backups, as customers' databases have. **Recommended: none,** said plainly in the docs, as caches have none.
7. **The pilot's price:** free, through FF's credit; or the SKUs' prices from the first day. **Recommended: credit,** with the price set from what the pilot measures.
8. **The name:** FF's "Code search" ("Recherche de code"), its docs saying it runs CIAK; or CIAK's name in the console. **Recommended: FF's name,** with CIAK named in the docs, with its license.
9. **When:** after step 5 and the card top-ups (What to build next §12, sixth row), since its buyers are mostly individual developers; or right after step 5, with a pilot of companies that pay by transfer. **Recommended: after the card top-ups.** CIAK's side (I-01) can start at any time in CIAK's repository, and FF waits for it either way.

## 10. Effort (rough estimates, one developer)

| Part | Days |
|---|---|
| I-00 and I-02: the plan, the spike, its ADR | 3 to 5 |
| CIAK's side (I-01) | 5 to 8 |
| The server and the front door (I-03, I-04) | 6 to 9 |
| The product (I-05 to I-07) | 6 to 8 |
| Documentation, the pilot and the close (I-08, I-09) | 4 to 6, and the pilot's weeks |
| **Together** | **24 to 36** |

I-04's days depend most on how many routes the allow-list holds and on I-01's trusted mode.

## 11. Progress log

| Task | Status | Commits | Notes |
|---|---|---|---|
| I-00 The plan and the baseline | ⏳ Planned | | |
| I-01 CIAK's side | ⏳ Planned | | |
| I-02 Spike and its ADR | ⏳ Planned | | |
| I-03 The server of customers' code indexes | ⏳ Planned | | |
| I-04 The front door and the API | ⏳ Planned | | |
| I-05 Plans, usage and the bill | ⏳ Planned | | |
| I-06 The console, `ff` and the admin app | ⏳ Planned | | |
| I-07 Metrics and alarms | ⏳ Planned | | |
| I-08 Documentation | ⏳ Planned | | |
| I-09 The pilot and the price | ⏳ Planned | | |
