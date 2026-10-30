# Step 4 task list: what is not done yet

| | |
|---|---|
| **What this is** | The work the [step-4 plan](step-4-plan.md) and [What to build next](what-to-build-next.md) leave undone, as one list to work through, each line ticked when its commit lands. The plan keeps the design and the progress log with the evidence; this list keeps the order and what is left |
| **Made** | On 2026-10-30, when you asked to build what the two documents leave undone without stopping. Step 4's eleven choices were taken as the plan recommended them (the [decision log](decisions.md), 40 to 50) |
| **Branch** | `feat/step-4`, from `master` at `82d66ba` |

## 1. What the two documents leave undone

1. **Step 4, the whole app runs here** (What to build next §7; the step-4 plan): static sites, e-mail from apps, a cache. Nothing of it was built: its plan waited for its eleven choices. **This list builds it,** tasks W-00 to W-10 below.
2. **Step 5, the way out** (What to build next §8): the Lambda API with AWS's request signing, versions and aliases, Terraform modules, the export kit (`ff export`, `ff doctor`, a cost estimate), SAM events. It has no plan yet; step 4's last task writes it (W-10), as each step's close wrote the next one's plan. Building it waits for you to confirm that plan's choices, as every step's did.
3. **Further out** (What to build next §9 and §12's rows 6 to 10): always-on services, container functions, login for apps, topics, SMS, the e-invoicing API, DNS hosting and the rest. A direction, not a plan: each gets its own plan when you pick it, ordered by what the pilot customers ask for.
4. **Your questions** (the decision log's last table): GitHub's minutes, how the development server updates, certificates. Answers only you can give; nothing here depends on them.

## 2. The tasks

Each task, or part of one, is one commit with its tests and its documents, as the plan's working rules say (§6).

### Phase 0: groundwork
- [x] **W-00** The plan confirmed (its choices in the decision log), the branch, the baseline's test counts.
- [x] **W-01** Four spikes, then ADRs 0011 (sites), 0012 (mail) and 0013 (caches):
  - [x] a bucket's files served to a browser through the backend, measured (a site's first load, many small files at once);
  - [x] AWS's SDKs and CLI against a minimal SES v2 endpoint, with only the endpoint changed;
  - [x] a message signed with a domain's DKIM key by the backend, sent through a Postfix, its signature checked at the other end;
  - [x] Valkey, a process for each cache: its memory and start time, TLS with a password.

### Phase 1: static sites
- [x] **W-02** The website configuration and the website server:
  - [x] part 1: a bucket's website configuration through the S3 front door (S3's XML) and FF's API (`/buckets/:name/website`), its single-page setting;
  - [x] part 2: the website server, on a port of the backend's own: index and error documents, single-page apps, `ETag` and 304, ranges, content types, counted as a bucket's reads, the plan's monthly limit on bytes out.
- [ ] **W-03** Addresses, domains, the console and `ff`:
  - [ ] part 1: `<bucket>.site.<domain>` at the edge, its certificates, a customer's own domain for a site;
  - [ ] part 2: the console's site panel on a bucket's page; `ff sites deploy` and `ff sites domains`;
  - [ ] part 3: sites' metrics as CloudFront names them, and alarms on them.
- [ ] **Deploy 1:** sites on the development server, at `*.site.dev.ffunc.cloud` (one DNS record more).

### Phase 2: caches
- [ ] **W-04** The server of customers' caches, and the API:
  - [ ] part 1: `deploy/cache`: Valkey, a process for each cache, and the small agent that starts them, for development and the platform;
  - [ ] part 2: `/caches` (create, list, get, a new password, delete), the address shown once, the plan's limits, functions' way to it, suspension.
- [ ] **W-05** Caches in the console, `ff`, the admin app, and the bill:
  - [ ] part 1: the Caches page, `ff caches`, the admin app's account page;
  - [ ] part 2: hourly measures, the bill (the kind `cache`, its price), metrics as ElastiCache names them, alarms.

### Phase 3: e-mail
- [ ] **W-06** Identities and the SES endpoint:
  - [ ] part 1: SES v2's API on a port of its own, signed for `ses` with the account's keys: identities (a domain with its DKIM keys and records, its proof; addresses, for the sandbox), the account, the suppression list;
  - [ ] part 2: the same in FF's API (`/email/...`), each route's isolation checks.
- [ ] **W-07** Sending:
  - [ ] part 1: `SendEmail` (simple and raw), queued, signed with the domain's key, handed to the customers' own Postfix; the sandbox and the quotas;
  - [ ] part 2: bounces and complaints, the suppression list filled by them, the reputation rates and the pause; port 25 closed to every function.
- [ ] **W-08** E-mail in the console, `ff`, the admin app, and the bill:
  - [ ] part 1: the E-mail page, `ff email`, the admin app's switch and sandbox;
  - [ ] part 2: the bill (the kind `email`, its price), metrics as SES names them, alarms.

### Phase 4: close
- [ ] **W-09** Documentation: the guide's three sections, `how-it-works.html`'s scenarios, a page in French for each service, the export kit's three pages, ADRs 0011 to 0013 as built.
- [ ] **W-10** The step closed: the small app's frontend as a site, a receipt e-mailed, its order list in a cache; the guide and `hack/cli-e2e.sh` walk through it; What to build next marks step 4 done; step 5's plan.
- [ ] **Deploy 2:** step 4 on the development server.
