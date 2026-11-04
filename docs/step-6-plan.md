# Step 6 plan: the first paying customers

| | |
|---|---|
| **Status** | Proposed on 2026-11-04 with step 5's close (the [step-5 plan](step-5-plan.md), X-15), from its [task list](step-5-tasks.md)'s §4, group A, which that list recommended for step 6; checked against the code the same day by a read-only survey (§1). Its fourteen choices (§9) wait for you, each with a recommendation; nothing of it is built until you confirm them. |
| **Goal** | What the first paying customers meet first, now that the way out to AWS is built. They pay by card, in dinars, and get invoices that El Fatoora accepts. They log in to `ff` with their browser, never pasting a key, and install it from FF's own site on Linux, macOS or Windows. Their sites and function URLs live under a domain of their own, so that a phishing page on one never marks FF's, with production's certificates for it. And the development server updates itself from `master`'s commits whose tests passed |
| **Parent plans** | The step-5 task list's §4, group A; [What to build next](what-to-build-next.md) §12's row 6 (card top-ups, e-invoicing, two sites); the [client-readiness plan](client-readiness-plan.md): P-34 (Konnect's top-ups) and P-37 (El Fatoora), both skipped on 2026-10-17 with their designs kept, its D9 (taxes, invoices, top-ups) and its §9's questions and actions; the [local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): B-03 (the payment providers' interface), B-06 (El Fatoora), §8.4, §8.6 and Appendix F, and S-01 (two sites); the [CLI plan](cli-plan.md)'s C-40 to C-43 and its §10's questions 3, 5 and 7; the [decision log](decisions.md)'s 17, 38, 39 and 42 |
| **Builds on** | The client-readiness plan's ledger (P-31), credit and its refusal (P-33), bank transfers and pro-formas (P-35), monthly invoices (P-36) and the admin app's payments (P-74); [ADR 0004](adr/0004-identity-and-tenancy.md)'s Keycloak client for `ff`; step 4's sites ([ADR 0011](adr/0011-static-sites.md)), on which `ff`'s downloads are served; the development server's install ([`deploy/dev-server`](../deploy/dev-server/README.md)) and production's edge ([`deploy/k8s`](../deploy/k8s/README.md)) |
| **Decision records** | ADR 0017 (payments through a provider: one interface, a notification never trusted, the payments left pending asked again), ADR 0018 (e-invoicing: TEIF, its signature, its submission, and what an invoice keeps), ADR 0019 (customers' content under a domain of its own, and its certificates), each from G-01's spikes |

Task numbers start with G, for *go-live*: what a paying customer meets first. The other plans keep their numbers: the client-readiness plan's P-34 and P-37 and the CLI plan's C-40 to C-43 are parts of this plan's tasks, named in each.

## 1. Where FF stands

Checked against the code on 2026-11-04, at the end of step 5 (`feat/step-5`, through X-15's part 1).

| Finding | Where | Consequence |
|---|---|---|
| **Credit comes by bank transfer and from FF, nothing else.** An owner asks for a pro-forma on the console's Billing page: one of four packs (20, 50, 100 or 500 TND) or another amount, with its reference `FF-XXXX-XXXX`. The operator records the transfer in the admin app. That is one posting of kind `payment`: the wallet credited, VAT payable, the provider's clearing account debited, and a share withheld at source credited once its certificate comes. A payment's method takes `bank_transfer` alone. The ledger already has the kind `topup` and the account `provider_clearing`, but only tests use them. No provider has code, settings or routes. | `BE/src/billing/payments/` (`payment.entity.ts`'s checks, `payments.service.ts`'s `recordTransfer`, `pro-formas.controller.ts`), `BE/src/billing/ledger/`; `FE/src/components/Billing.tsx` (`CREDIT_PACKS`); `admin/src/pages/Payments.tsx` | A card's top-up is a payment of another method, posted as the `topup` the ledger already has. P-34's kept design says the rest (D1 to D3). |
| **Invoices are PDFs, numbered and never changed.** They are drafted on the 1st of each month and issued by the operator. Numbers run without gaps for each fiscal year from a locked counter (`FAC-2026-000001`; credit notes `AV-…`). They are written in pdfkit's standard fonts and kept in the bucket `functions` under `invoices/`. There is no XML, signature, submission or QR code. **P-36's known gaps:** no Arabic (an account named in Arabic can't be invoiced), no amount in words, no buyer's address (accounts have a name, a country and a tax ID, but no address), and no exemption for exports. | `BE/src/billing/invoices/` (`invoice-number.ts`, `invoice-pdf.ts`, `invoice.entity.ts`'s `buyerName` and `buyerTaxId`); `BE/src/accounts/entities/account.entity.ts` (`country`, `taxId`); `admin/src/pages/Invoices.tsx` | El Fatoora's XML needs the buyer details the invoice lacks: they come first (G-07), then the XML, its signature and its submission (G-08). |
| **`ff` logs in with an API key alone:** `ff config set-token` or `FF_TOKEN`, with profiles in `config.toml` and `credentials.toml` (0600). Keycloak's `ff-cli` client is already in both realm files, public, with the device grant turned on and the `ff-api` audience. The backend takes any of the realm's tokens except the admin app's. There is no `ff login`, no refresh and no `ff api-keys`; `ff keys` manages the access keys AWS's tools use. | `cli/src/auth.rs`, `cli/src/config.rs`; `deploy/keycloak/ff-realm.json`, `deploy/k8s/platform/keycloak/ff-realm.json` (`ff-cli`); `BE/src/auth/auth.guard.ts`; `BE/src/api-keys/api-keys.controller.ts` (owners only) | C-40 needs nothing new on the server's side (G-02). |
| **`ff` is built for Linux on x86_64 only,** as a static binary with its SHA-256, by hand. There is no release, signature, install script or update notice, and the workflow has no release job. The runtime images are built where they run: the development server builds them and imports them into k3s. None is published, so `ff local` needs the repository's `runtimes/`. | `hack/build-cli.sh`; `.github/workflows/ci.yml`; `cli/src/local.rs` (the images it pins); `deploy/dev-server/server.sh`; `cli/README.md` | C-41 to C-43 (G-03, G-04), once you say where downloads live (§9, 7). |
| **Every name is under one domain.** The hosts for function URLs, sites and S3 are settings of their own, separate from the API's and the console's, and `deploy.sh` checks the edge's names against the backend's. On the development server, all of them are under `dev.ffunc.cloud`. | `BE/src/config/configuration.ts` (`FF_FUNCTION_URL_BASE`, `FF_STORAGE_BASE`, `FF_WEBSITE_BASE`); `deploy/k8s/platform/edge.env`, `backend.env`, `deploy.sh`; `deploy/dev-server/k8s/edge.env`, `ff.caddy` | A domain for customers' content is settings, records and certificates, plus a read of whatever assumes one domain: cookies, CORS, the console's links (G-09). |
| **Production can't get its wildcard certificates as built.** The edge asks for them by DNS-01 through RFC 2136, which OVH's DNS, `ffunc.cloud`'s, doesn't accept. What's left is `on-demand`: one certificate per host, within Let's Encrypt's 50 a week. On the development server, `*.fn`, `*.s3` and `*.site` use certificates from the shared proxy's own authority. | `deploy/edge/Dockerfile` (`caddy-dns/rfc2136`); `deploy/k8s/platform/edge/Caddyfile`; `deploy/k8s/README.md`; `deploy/dev-server/ff.caddy` | The edge gets OVH's module, one line, with a key that reaches only the content domain's zone (D8). |
| **The development server updates only when someone runs `install.sh` from a checkout:** it copies the files over, runs `server.sh` as root, then the smoke test. It has held a customer since 2026-11-01. Nothing pulls updates, and GitHub holds no key to the server. | `deploy/dev-server/install.sh`, `server.sh`, `smoke.sh`, `README.md` | An updater on the server, run by a timer, that pulls what passed (D9, G-10). |
| **Backups, not a second site.** WAL-G backs up FF's database and Keycloak's, so any second of the last 30 days can be restored, encrypted and sent to the second site's S3. Customers' databases keep 7 days. Invoices and packages are copied every hour. The targets are 15 minutes of data lost at most and 4 hours to restore, and the restore is drilled. The backend, Keycloak and the log and metric stores run one copy each, with no standby. Production's install doesn't exist yet. | `deploy/backup/`, `deploy/data-db/`, `deploy/k8s/backup/`; `docs/backup-drills.md` | Two sites wait for production's first (§9, 14). |
| **Routes are guarded by default.** `@Public()` marks one that isn't, which Konnect's notification needs. L5 checks every route's rules. | `BE/src/auth/public.decorator.ts`; `hack/e2e-tenancy.sh` | The notification is public, checked by L5 as public, and trusted for nothing (D2). |

## 2. Goals and non-goals

**Goals:**

1. **Card top-ups through Konnect.** The console's packs can be paid by card, e-DINAR or Konnect's wallet. Credit is added only once Konnect's API says the payment is paid, when the backend asks it. No payment is credited twice, and the ones left pending are asked about again until they end.
2. **Invoices that El Fatoora accepts.** Each invoice carries the buyer details the law asks for. Its TEIF XML is signed with TunTrust's certificate and sent to TTN, and TTN's reference and QR code go on the PDF. It is built and tested against a stand-in for TTN's service and a certificate the tests make, then switched to the real ones by settings.
3. **`ff login`:** a customer logs in with the browser and never pastes a key. `ff api-keys` makes the keys a CI needs.
4. **`ff` for everyone:** builds for Linux, macOS and Windows, signed, downloadable from FF's own site with an install script. The runtime images are published, so `ff local` runs outside the repository. `ff` runs in a customer's CI.
5. **Customers' content under a domain of its own** (function URLs, sites, S3), on the Public Suffix List, with production's certificates for it.
6. **The development server updates itself** from `master`'s commits that passed, at night, with a backup first and the smoke test after.

**Non-goals:**
- Flouci and ClicToPay: later, behind the same interface.
- Cards kept on file for recurring charges.
- Postpaid billing.
- Importing bank statements (the parent plan's B-04).
- An e-invoicing API for customers (the step-5 list's §4, group C).
- Two sites (§9, 14).
- Production's install itself.
- The outside security test itself: yours to book (§9's actions); this step writes its scope.
- Groups B to F of the step-5 list's §4.

## 3. Decisions

Proposed; §9 lists the choices to confirm.

### D1. Payment providers behind one interface (B-03, P-34)
- **The interface:** `PaymentProvider` from the parent plan's Appendix F:
  - its capabilities: methods, currencies, refunds, a status query;
  - `createCheckout`, which answers the address the payer goes to;
  - `getStatus`, which asks the provider itself;
  - `parseNotification`, which reads a notification only to know which payment to ask about.
- **Konnect's adapter first,** with its API as P-34 recorded it on 2026-10-17:
  - the `x-api-key` header;
  - `POST /payments/init-payment`, with amounts in millimes and FF's payment ID as `orderId`, answering `payUrl` and `paymentRef`;
  - `GET /payments/:id`, answering `completed` or `pending`.
- **Every provider call** has a timeout, and a failed one is said to the payer as "try again" without crediting anything. The parent plan's §8.4 rules hold for every adapter.
- **The suites use a stand-in Konnect,** a small server that answers as Konnect's documentation says, each answer naming its source. L4 also runs against Konnect's sandbox once you have its credentials (§9, 3).

### D2. A top-up, from the pack to the credit
- **The methods:** Konnect's four (§9, 9): Tunisian and international cards, e-DINAR and its wallet.
- **The request:** `POST /billing/top-ups` with the credit asked for (a pack or another amount, before tax, as a pro-forma takes it).
  - It is open to owners only, as pro-formas are.
  - It makes a payment of method `konnect`, `pending`, with its VAT and total as D9 says, then calls Konnect's `init-payment`, and answers the payment and its `payUrl`.
- **Konnect's notification:** a public `GET /webhooks/konnect?payment_ref=…`, which the payer's browser can follow too.
  - It is kept as received in `webhook_events`, one row per provider and reference.
  - The backend then asks Konnect about the payment, and checks the amount, the currency and FF's payment ID against the pending one.
  - If it is completed, the payment is marked paid and its posting written in the same transaction: kind `topup`, key `konnect:<reference>`, the wallet credited, VAT payable, the provider's clearing account debited. A second notification is then a replay of the same key.
  - It answers 200 whatever it found, and says nothing.
- **The browser's return** lands on the console's result page, which reads the payment's state from FF's API, never from the redirect's parameters.
- **Card fees** are FF's cost, as D9 decided.
- **Invoicing is unchanged:** a card payment is a line of the month's invoice, as a transfer is.

### D3. Payments left pending
- **Every 10 minutes,** a job in one backend at a time (the lock step 5 added) asks Konnect again about each pending card payment. After a day, an unpaid one expires.
- **A payment Konnect reports paid after it expired** is still credited, since the money arrived, and the operator is told.
- **The admin app's payments page** lists card payments with Konnect's reference and their state, so they can be matched against Konnect's settlement reports. It has a button that asks Konnect again. Matching automatically, as the parent plan's §8.4 says, comes once Konnect's reports can be read by an API.

### D4. The buyer details an invoice needs (P-36's gaps)
- **Billing details on the account:** its legal name, its address, whether it is a business, and a business's tax ID (the account already has a country and a tax ID).
  - They are asked on the Billing page and required before the account's first payment of any kind (§9, 4). The invoice keeps them as they were on its issue date, as it keeps the buyer's name today.
- **The amount in words,** in French, as Tunisian invoices end ("Arrêtée la présente facture à la somme de …"), from the French words the invoices already write for days and months.
- **Arabic:** a font with Arabic glyphs and shaping (Noto Naskh Arabic, under the SIL Open Font License), embedded through fontkit. A name or an address in Arabic is written as given, and the invoice stays in French (§9, 5).
- **An export flag** from the account's country: no stamp duty for an account outside Tunisia, once the accountant confirms it (their question 5).

### D5. El Fatoora (B-06, P-37)
- **The format:** TEIF XML, from TTN's own package (schema 1.8.9 and guide 2.0 in the parent plan's sources; the version named in the code and in the settings).
- **The signature:** XAdES-B, RSA-SHA256, with TunTrust's certificate. Its key is kept as the backend's other keys are, sealed, unless TunTrust issues it only on a device a server can't use. G-01 reads TunTrust's offer; if so, the month's invoices are signed on a machine of yours with the device, in one batch the admin app prepares and takes back (§8).
- **The submission:** TTN's web service, `saveEfact` to send and `consultEfact` to read the answer.
  - An invoice is issued once TTN accepts it, with TTN's reference and its QR code printed on the PDF.
  - A refusal leaves the invoice drafted, with TTN's reason, for the operator.
  - The signed XML is kept next to the PDF (`invoices/<number>.xml`), never changed, and a credit note goes the same way.
- **The tests use a stand-in TTN,** a SOAP server of their own that answers as TTN's guide says, and a certificate they make. The real service and certificate come in by settings, once TTN's test access and TunTrust's certificate exist (§9, 3).
- **The gate stands:** El Fatoora must be live before general availability, or before the first invoice run after paper invoices stop being tolerated (the client-readiness plan's D9).

### D6. `ff login` (C-40)
- **The device flow** (RFC 8628) against `ff-cli`, as the CLI plan says:
  - `ff` prints the address and the code, opens the browser when there is one, and asks the token endpoint at the interval Keycloak gives.
  - The tokens go in `credentials.toml` with the refresh token. A call made as the access token is about to expire refreshes it first, and a failed refresh says to log in again.
- **`ff logout`** removes the profile's tokens, and `ff whoami` shows the user and the chosen account.
- **`ff api-keys create --name … --scopes … [--expires 90d]`, `list` and `revoke`,** for an owner's token; the new key is printed once.
- **The order:** a key given by `--token`, `FF_TOKEN` or a profile still comes before a login, so that CI keeps working unchanged.

### D7. `ff` downloaded, installed and kept current (C-41 to C-43)
- **Builds:** Linux on x86_64 and arm64 (static, musl), macOS on x86_64 and arm64, and Windows on x86_64 (§9, 8).
  - They are made by a release job from a tag on `master`, each with its SHA-256 and a minisign signature. The public key is in the repository, in the install script and on the downloads page.
- **The downloads** are a site of FF's own, on a bucket of its own (§9, 7):
  - the install script (`curl … | sh`, and a PowerShell one for Windows), which checks the signature;
  - the binaries;
  - the runtime images as archives, which `ff local` loads (`docker load`) when it can't pull them.
  - GitHub's releases and `ghcr.io` are copies.
- **`ff version`** says when a newer release exists, once a day at most, unless turned off.
- **Each release of `ff` pins its runtime images** by digest (C-42).
- **The CI examples** (C-43): GitHub Actions and GitLab CI, each installing `ff` from the downloads, with a deploy key in `FF_TOKEN`, deploying with `--output json` and failing on `ff`'s exit codes.

### D8. Names and certificates (decisions 17, 38 and 42)
- **A domain of its own for customers' content** (§9, 10): the hosts that serve customers' bytes move to it, so a phishing page there marks that domain, never FF's. Those hosts are:
  - function URLs, `*.fn`;
  - sites, `*.site`;
  - S3, `s3` and `*.s3`, since a presigned object is served there.
- **The Public Suffix List** gets the domain in its private section, so that browsers treat each customer's host as a site of its own and one customer can't set cookies for another.
- **FF's own domain** keeps the API, the console, login, the admin app, and the SQS, SES and Lambda endpoints, which answer the API alone.
- **Production's certificates** (§9, 11): the edge is built with OVH's DNS module.
  - Its OVH key is limited by OVH's access rules to the content domain's zone, so an edge taken over could change that zone and nothing of FF's.
  - The wildcards (`*.fn`, `*.site`, `*.s3`) come by DNS-01; customers' own domains stay one certificate each, on demand.
- **The development server** keeps its proxy's own authority (§9, 12) and moves to the content domain too. Its old names keep answering beside the new ones until its customer has moved, then go.

### D9. The development server updating itself (decision 39)
- **A timer on the server** (systemd, every 10 minutes) asks GitHub for `master`'s newest commit and that commit's run.
  - It reads the workflow's results with a token that can do nothing else, or no token while the repository is public.
  - When a newer commit has passed every job, it fetches it with a read-only deploy key, and only at night, between 01:00 and 05:00 in Tunis, since the server has a customer (§9, 13).
- **An update** backs up FF's databases (as `/data/ff/backups`), runs `server.sh` and then the smoke test.
  - A failure stops the updater until someone looks, with no retry, and is e-mailed to the operator through the server's own mail.
  - Each update's commit, time and result are written to a log on the server.
- **GitHub holds no key to the server,** and the repository holds nothing about it: its address stays out, as now.
- **`install.sh` stays,** for the first install and for a commit by hand.

### D10. What the step only prepares
- **The accountant's five questions** (the client-readiness plan's §9): G-11 writes them as a letter ready to send, in French. Each question gives the answer FF's design assumes and what changes if the answer differs.
- **The outside security test:** G-11 writes its scope and rules, ready to send to the testers you choose. The scope covers the API and its keys, the console and the admin app, login, one account reaching another's, and a function escaping its sandbox or reaching the internet.
- **Two sites wait** for production's first install (§9, 14).

## 4. Data model

Proposed, each table with `account_id` where it has one:

- **`payments`:**
  - `method` also takes `konnect`, and `status` also takes `expired`;
  - `provider_reference` (Konnect's `paymentRef`), `pay_url` and `expires_at`, all three set for a card payment and only for one.
- **`webhook_events`:** the provider, the event's key (unique together with the provider), the request as received (query and headers, never a secret), when it came, when it was handled, and what came of it.
- **`accounts`:** `legal_name`, `address` (its lines, postal code and city) and `is_business`, next to `country` and `tax_id`.
- **`invoices`:**
  - the buyer's address and whether a business, as the account was on the issue date;
  - `einvoice_status` (`none`, `signed`, `submitted`, `accepted`, `refused`);
  - `ttn_reference`, `ttn_qr` (what the QR code encodes), `ttn_reason` and `xml_key` (the signed XML's key in the bucket);
  - `submitted_at` and `accepted_at`.
- **No table for `ff login`:** the tokens stay on the customer's machine.

## 5. API changes

Proposed:

- **`POST /billing/top-ups`** (owners): `{ credit }` → `{ payment, payUrl }`.
- **`GET /billing/top-ups/:id`** (members): the payment's state, which the console's result page reads.
- **`GET /webhooks/konnect`** (public): answers 200 whatever it found, and is checked by L5 as public.
- **`PATCH /accounts/:id`** (owners) also takes `legalName`, `address` and `isBusiness`, and `GET /accounts/:id` gives them back.
- **The admin API:**
  - `GET /admin/payments` with card payments and their reference;
  - `POST /admin/payments/:id/check`, which asks the provider again;
  - `GET /admin/invoices` with El Fatoora's state and reason;
  - `POST /admin/invoices/:id/submit`, which sends a refused invoice again once it is fixed.
- **Each new route** gets its rules in both of L5's loops. The new DTOs' names are mirrored in `ff`, the console and the admin app.
- **No change for `ff login` or the downloads:** `POST`, `GET` and `DELETE /api-keys` exist.

## 6. Working rules

As step 5's, which are the repository's [`CLAUDE.md`](../CLAUDE.md):
- a commit for each task or part, `type(scope): summary (G-xx)`, with its tests, its documents and this plan's log;
- one heavy process at a time, `hack/check-resources.sh` first, the workers capped;
- refactor as you go;
- L1 to L5 for what each part touches, with a new route's rules in both of L5's loops;
- the backend's names mirrored in `ff` and the console;
- the console checked in a browser, at a phone's width too;
- no task or decision number in the code, its comments or its tests.

New with this step:

- **No real payment and no real invoice in a test.** Konnect's sandbox and TTN's test access are the only real services, and their credentials stay out of the repository, the workflows, the logs and the artifacts. The stand-ins answer as the providers' documentation says, each answer naming its source.
- **Money is integers in millimes,** as the ledger keeps it. Every rule of tax or stamp duty is dated data, as the price books are.
- **What goes live waits for the company:** Konnect's onboarding and TunTrust's certificate both ask for its documents. Each is built against its stand-in first, so that when they come, only settings change, and that change gets its own commit.
- **The release job and the updater are the only new places that hold credentials:** a signing key for releases, and a deploy key and a read-only token for the server. Each is named in the guide with what it can do, and none is ever printed.

## 7. Tasks

The order follows what waits least. Phase 1 waits only for your answers. Phases 2 and 3 are built against stand-ins and go live when the company's credentials come. Phase 4 waits for the content domain to be bought.

### Phase 0: groundwork

#### G-00: The plan and the baseline
- Your choices confirmed (§9), the decision log written, and the baseline from the branch's first green run: each suite's counts and times.

#### G-01: Spikes and ADRs 0017 to 0019
- **Konnect, from its documentation:** the stand-in written from it, and the sandbox tried once its credentials exist.
- **A TEIF document signed with XAdES-B** by a certificate the spike makes, in Node.js, and checked by a verifier that isn't FF's (`xmlsec1`).
- **TunTrust's offer read:** a certificate a server can use, or only one on a device.
- **The device flow** against the development realm.
- **OVH's DNS module** getting a test wildcard from Let's Encrypt's staging for a zone of the spike's own, with a key limited to that zone.
- **The three ADRs** written from what the spikes found.

### Phase 1: `ff`, ready for customers

#### G-02: `ff login`, `ff logout` and `ff api-keys` (C-40)
- D6.
- **Tests:** L2 for the device flow against a stand-in authorization server (pending, slow down, expired, success), the refresh and the keys; the ff suite against the development realm.

#### G-03: `ff`'s builds, signatures and downloads (C-41)
- D7's builds, the release job, the downloads' site, the install scripts and the update notice.
- **Unix-only code** made to work on Windows, or refused there saying why.
- **Tests:** the unit stage on each system once at each release; the install script checked against a signature that isn't the release's.

#### G-04: The runtime images published, and `ff` in a customer's CI (C-42, C-43)
- The images pinned by each release, published with it.
- `ff local` working outside the repository.
- The two CI examples, each run by the release job against the development stack.

### Phase 2: card top-ups

#### G-05: The providers' interface, Konnect's adapter, its notification and the payments left pending (P-34, B-03)
- D1 to D3 in the backend.
- **Tests:** L1 with Konnect's answers recorded: success, failure, an amount that differs, a notification twice, and a forged one for a payment that doesn't exist. L2 for the payment and its posting in one transaction. L4 against the stand-in, and against Konnect's sandbox when its credentials exist. L5's rules.

#### G-06: Top-ups in the console and the admin app
- **The console:** the Billing page's packs paid by card, each showing the credit, its VAT and the total; the redirect; and the result page.
- **The admin app:** card payments, with "ask again".
- **The guide's billing section.**
- **Tests:** both apps' Vitest; a browser at a phone's width.

### Phase 3: invoices El Fatoora accepts

#### G-07: The invoice's missing details (P-36's gaps)
- D4: the billing details on the Billing page and in the API, the amount in words, Arabic, and the export flag.
- **Tests:** L1 for the words and for an Arabic name read back from the PDF; L2 for the details kept as at the issue date.

#### G-08: El Fatoora (P-37, B-06)
- D5: the XML, its signature, the submission, the QR code, and the admin app's state and reason.
- **Tests:** L1 for the XML against TTN's schema and the signature checked by `xmlsec1`; L4 against the stand-in TTN; then TTN's test access.

### Phase 4: names, certificates and updates

#### G-09: A domain for customers' content, and production's certificates
- D8: the settings, the edge's module and its key, the development server's names, and the Public Suffix List's request.
- What assumed a single domain (cookies, CORS, the console's links) is read and fixed.
- **Tests:** L3 and the platform's suite with two domains; the development server's smoke test at the new names.

#### G-10: The development server updating itself
- D9: the timer, the updater, its log and its e-mail, and the guide's page.
- **Tests:** the updater's script against a stand-in for GitHub (a commit that passed, one that failed, one already installed, a failed smoke test); then once on the server, with your go-ahead.

### Phase 5: close

#### G-11: Documentation, and what you send
- The guide's pages for top-ups, invoices, `ff login` and installing `ff`, and the French pages.
- The ADRs as built.
- The accountant's letter, and the security test's scope (D10).

#### G-12: The step closed
- Konnect and El Fatoora live on the development server if their credentials exist, and said plainly if not.
- What to build next marks step 6 done, with the decision log and step 7's plan.

## 8. Risks

| Risk | What lowers it |
|---|---|
| Konnect's onboarding asks for the company's documents, and the company isn't there yet | Built against the stand-in and recorded answers, then switched to the real service by its settings alone; the bank transfer stays |
| A forged or repeated notification credits an account | A notification is only a reason to ask Konnect. The payment's amount, currency and ID are checked; one posting per key; the browser's redirect never read |
| A payment is paid but never confirmed: the payer leaves, or the notification is lost | Pending payments are asked about again every 10 minutes for a day; one paid after it expired is still credited, and the operator is told |
| TunTrust gives its certificate only on a device a server can't use | G-01 reads its offer first; if so, the month's invoices are signed in one batch on a machine of yours with the device, which the admin app prepares and takes back |
| TTN's format or service changes (the schema's version, the SOAP service) | The version is named in the code and the settings; the stand-in is built from TTN's own package's examples; the schema is read by the tests |
| Paper invoices stop being tolerated before G-08 is live | P-37's gate stays in force; the accountant's question 3 asks the date; PDFs meanwhile, as now |
| An account named in Arabic still can't be invoiced | G-07 embeds the font, and an Arabic name read back from the PDF is tested |
| Moving to a content domain breaks the development server's customer's addresses | The old names keep answering beside the new ones until the customer has moved; production's names are new |
| An OVH key on the cluster changes FF's own records | OVH's access rules limit it to the content domain's zone |
| The Public Suffix List takes weeks to list a domain | The request goes in the day the domain is bought; meanwhile, the console's cookies are already on another domain |
| The updater installs a commit that breaks the server, which has a customer | Only commits whose every job passed; at night; a backup first; the smoke test after; a failure stops the updater and is e-mailed |
| The server holds a deploy key and a token | A read-only key; a token that reads the workflow's results alone, or none while the repository is public; both 0600, root's |
| macOS quarantines a binary downloaded by a browser | The install script downloads with `curl`, which macOS doesn't quarantine; minisign for every build; Apple's notarization later, as it needs Apple's developer program, paid by card |
| Windows builds cost minutes: a Windows runner's minute counts twice on a private repository | Built on Linux by cross-compiling; tested on a Windows runner only at each release |

## 9. Choices for you to confirm

Each with what it means and a recommendation.

1. **The step's scope.** Options:
   - group A without two sites;
   - group A with two sites;
   - another group of the step-5 list's §4 first, such as B's always-on services.

   **Recommended: group A without two sites.** It is what the first paying customers meet. Two sites copy a first site that production doesn't have yet (14).
2. **The card gateway.** Options:
   - Konnect alone in this step, with Flouci after the pilot's feedback, behind the same interface;
   - both now;
   - ClicToPay through FF's own bank.

   **Recommended: Konnect alone,** as the client-readiness plan's D9 ordered them. It takes local and international cards, e-DINAR and its own wallet; Flouci adds wallets, which the pilot can ask for.
3. **Building before the company's credentials exist.** Options:
   - build top-ups and El Fatoora now, against stand-ins for Konnect and TTN and a certificate the tests make, with the real ones by settings when they come;
   - wait for the company and its credentials, building phases 1 and 4 meanwhile.

   **Recommended: build now.** The day the credentials come, only settings change, and El Fatoora's gate (D5) is met sooner.
4. **When the buyer details are asked.** Options:
   - on the Billing page, required before an account's first payment, a pro-forma or a top-up;
   - at sign-up;
   - only when the first invoice is drafted, with the operator asking.

   **Recommended: before the first payment.** Sign-up stays short, and no invoice is ever drafted without them. The accountant's answer to question 5 may add to the list.
5. **Arabic on invoices.** Options:
   - the invoice in French, with a name or address in Arabic written as given in an embedded font;
   - also an invoice in Arabic on request, as the parent plan's §8.6 allows.

   **Recommended: French, with Arabic as given.** It removes P-36's refusal; an invoice in Arabic can come when a customer asks.
6. **`ff login` first.** Options:
   - first in the step, as the CLI plan's question 7 recommends;
   - after the top-ups.

   **Recommended: first.** It is small, waits for nothing, and the first customers never paste a key.
7. **Where downloads and images live** (the CLI plan's question 3). Options:
   - on FF itself: a site on a bucket of FF's own, at `get.ffunc.cloud`, with the install scripts, the binaries, their checksums and signatures, and the runtime images as archives, with GitHub's releases and `ghcr.io` as copies;
   - GitHub alone;
   - a registry of FF's own for the images, as the code registry is.

   **Recommended: on FF itself.** It needs no new service, works when GitHub isn't reachable, and FF serves itself as it serves its customers. A public registry is one more service to run and protect.
8. **Windows and macOS** (the CLI plan's question 5). Options:
   - both now, with Windows cross-compiled and tested at each release, and macOS signed with minisign, Apple's notarization later;
   - Windows when a customer asks;
   - Apple's notarization now.

   **Recommended: both now, notarization later.** Many developers here work on Windows, and `ff` has Unix-only code to settle once. Apple's program is paid by card, every year.
9. **Which of Konnect's methods.** Options:
   - all four: Tunisian cards, international cards, e-DINAR and Konnect's wallet;
   - Tunisian cards, e-DINAR and the wallet, without international cards, whose fee is 2.9% where the others' is 1.3%.

   **Recommended: all four.** The fees are FF's cost (D9), and an international card is how a customer abroad, or a Tunisian with a foreign card, pays at all.
10. **A domain for customers' content** (decision 42). Options:
    - a second domain, which you choose and register at OVH as `ffunc.cloud` is, for function URLs, sites and S3, listed on the Public Suffix List;
    - both under `ffunc.cloud`, as now.

    **Recommended: a second domain,** as GitHub keeps `github.io` apart from `github.com`, before the public launch, while only one customer has addresses to move.
11. **Production's wildcard certificates** (decisions 17 and 38). Options:
    - OVH's DNS module in the edge, its key limited to the content domain's zone;
    - a DNS server of FF's for the content zones, delegated from OVH;
    - one certificate per host, on demand.

    **Recommended: OVH's module.** It is one line in the edge's build, and the key can't change FF's own records. A DNS server of FF's is a service to run, worth it with DNS hosting (group D). On demand stops at 50 new hosts a week.
12. **The development server's certificates.** Options:
    - the proxy's own authority, as now;
    - Let's Encrypt by DNS-01, through an OVH key kept on the server that other projects share;
    - one certificate per host on demand, through a line in the shared proxy's main file.

    **Recommended: as now.** It is a development server; the key and the shared file stay untouched.
13. **How the development server updates** (decision 39). Options:
    - by itself, pulling each commit of `master` whose every job passed, at night, with a backup first and the smoke test after, a failure stopping it (D9);
    - by GitHub, through a key to the server;
    - by hand, as now.

    **Recommended: by itself.** GitHub then holds no key to a server that other projects share.
14. **Two sites** (S-01). Options:
    - after production's first install, with a plan of its own;
    - in this step, designed now and built when the hardware comes.

    **Recommended: after production's first install.** Backups to the second site's S3 already give 15 minutes and 4 hours, and a second site needs the first one's servers to copy.

**Your actions, which no task can do** (the client-readiness plan's §9 and the parent plan's §15):

| Action | What it unblocks | When |
|---|---|---|
| The company, and the Startup Act label | Konnect's onboarding, TunTrust's certificate, TTN's registration | Before anything goes live |
| Konnect's merchant onboarding, sandbox first | G-05's sandbox runs; top-ups live | As soon as the company exists |
| TunTrust's certificate ordered, and TTN's El Fatoora registration with its test access | G-08 against TTN itself; El Fatoora live | It takes weeks: with the company |
| The accountant's five questions sent | D4's list and the export flag; how long PDFs may stay | Once G-11 writes the letter, or sooner |
| The outside security test booked | The public launch | Testers are booked weeks ahead; G-11 writes the scope |
| The content domain chosen and registered | G-09 | Before G-09; the Public Suffix List takes weeks |

## 10. Effort (rough estimates, one developer)

| Part | Weeks |
|---|---|
| G-00 and G-01: the plan, the spikes, three ADRs | 1 to 1.5 |
| `ff` for customers (G-02 to G-04) | 1.5 to 2 |
| Card top-ups (G-05, G-06) | 2 to 2.5 |
| Invoices El Fatoora accepts (G-07, G-08) | 3 to 4 |
| Names, certificates and updates (G-09, G-10) | 1.5 to 2 |
| Documentation and the close (G-11, G-12) | 1 to 1.5 |
| **Together** | **10 to 13.5** |

That is about 50 to 68 working days. The parent plan counts 3 person-weeks for B-03, with two adapters, and 2 to 3 for B-06. The client-readiness plan counts 10 to 15 days for P-37, and the CLI plan 4 to 6 days for C-40 to C-43. This plan adds the console and the admin app for each part, P-36's gaps, the stand-ins, and the names and the updater, which no parent plan counted. The external lead times aren't in it: the company, Konnect's onboarding, TunTrust's certificate, TTN's test access and the Public Suffix List.

## 11. Progress log

| Task | Status | Commits | Notes |
|---|---|---|---|
| G-00 The plan and the baseline | ⏳ Planned: your choices (§9) | | |
| G-01 Spikes and ADRs 0017 to 0019 | ⏳ Planned | | |
| G-02 `ff login`, `ff logout` and `ff api-keys` | ⏳ Planned | | |
| G-03 `ff`'s builds, signatures and downloads | ⏳ Planned | | |
| G-04 The runtime images published, and `ff` in a customer's CI | ⏳ Planned | | |
| G-05 The providers' interface, Konnect's adapter, its notification and the payments left pending | ⏳ Planned | | |
| G-06 Top-ups in the console and the admin app | ⏳ Planned | | |
| G-07 The invoice's missing details | ⏳ Planned | | |
| G-08 El Fatoora | ⏳ Planned | | |
| G-09 A domain for customers' content, and production's certificates | ⏳ Planned | | |
| G-10 The development server updating itself | ⏳ Planned | | |
| G-11 Documentation, and what you send | ⏳ Planned | | |
| G-12 The step closed | ⏳ Planned | | |
