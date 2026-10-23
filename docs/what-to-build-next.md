# What to build next: FF as a local cloud

| | |
|---|---|
| **Status** | Proposed on 2026-10-21. It is a view with an order and reasons, not a plan with tasks. When you pick a step, it gets its own plan, in the format of the [client-readiness plan](client-readiness-plan.md). **Step 1 done on 2026-10-21,** in development: its plan is the [step-1 plan](step-1-plan.md), tasks U-00 to U-09, whose progress log says what was built. You confirmed [ADR 0003](adr/0003-code-delivery.md) the same day: production's code registry is in the platform's manifests, and inline code has moved onto it. **Step 2 done on 2026-10-23,** in development: its plan is the [step-2 plan](step-2-plan.md), which you confirmed on 2026-10-22 with the step-1 plan's choices, tasks V-00 to V-10, whose progress log says what was built. **Step 3's plan** is the [step-3 plan](step-3-plan.md), which you confirmed on 2026-10-23 with its ten choices as recommended; **started the same day:** its progress log says what is built. Every decision you made is in the [decision log](decisions.md). |
| **Parent plan** | [Local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): its Phase 3 (E-01 to E-10), its Phase 4 (S-01 to S-10), §4.6 event sources, §4.7 storage and queues, §6.7 AWS-compatible services, §10 go-to-market |
| **Builds on** | The [client-readiness plan](client-readiness-plan.md), done up to its pilot-launch tasks, and the [CLI plan](cli-plan.md), its phases 0 to 2 done with step 1 |
| **What it is for** | To answer "what do we add after functions?", and to look further ahead |

FF runs functions. The goal is bigger: the set of services a developer in Tunisia would otherwise buy from AWS with a foreign card, offered here, in dinars, with the same code, and with a way out to AWS at any time.

This document says what to add, in which order, and why. Sections 4 to 8 are the next five steps. Section 9 looks further ahead. Section 10 says what every new service needs. Section 11 says what not to build. Section 12 puts it all in one table.

Sizes are weeks of work for one developer. Where the parent plan gives a number, it is used. Otherwise: **small** is under two weeks, **medium** is two to six weeks, **large** is more.

## 1. What FF has today

Checked against the README and the client-readiness plan's progress log on 2026-10-21.

**Done:**
- Functions in Node.js and Python, with AWS Lambda's handler contract. They scale out when calls arrive together, scale to zero when idle, and run in a sandbox (gVisor).
- Accounts with members and roles, login through Keycloak, API keys, plans with limits and quotas.
- One usage record per call, prices in dinars at AWS's price list, prepaid credit, a ledger, top-ups by bank transfer, monthly PDF invoices.
- Logs per function (search and live tail), metrics with CloudWatch's names, alarms, e-mail and webhook notifications.
- An admin dashboard for the operator, operator monitoring, backups that can restore to any minute, deployment manifests with TLS.

**Not there yet** (on 2026-10-21; step 1, in §4, has added some of it since):
- A function can only be called through the API, with a login token or an API key. No public web address, no schedule, no queue.
- No environment variables or secrets for functions.
- A function is one file. No packages with libraries, and no `ff` command (the CLI plan is not started).
- No storage for the customer's files, no database for the customer's data.
- No versions, aliases or custom domains.
- No card payments (Konnect was skipped) and no e-invoicing (El Fatoora was skipped).

## 2. The idea in one sentence

**Everything a customer would have to pay for abroad, offered here.** A developer who can't pay for AWS also can't pay for Neon, Supabase, SendGrid, Twilio, Auth0 or Vercel. So the gap is not only "a place to run functions". It is the whole set of services an app needs. FF fills it one service at a time, starting with the ones that block the most customers.

## 3. How to choose

Four questions, for each idea:

1. **Does it block real apps today?** If a customer can't build a normal app without it, it comes first.
2. **Can the customer get it abroad without a card?** If not, it belongs in FF. If yes (a free tier, or open-source software they can run themselves), it can wait.
3. **How much work is it, and does FF already run the piece behind it?** FF already runs PostgreSQL, an S3-compatible file store, Keycloak, a mail sender and an edge proxy. A service built on one of those is cheaper than a new one.
4. **Does AWS have a shape to copy?** When AWS has an API for it, FF uses the same API, so the customer's code works on both sides. That is the parent plan's rule (§3.3): no FF-only formats where AWS already has one.

One more rule for every service: **a function must reach it over FF's private network, even when the account's internet access is off.** Internet access is off by default (client plan, D5). A database or a queue that lives inside FF works for every customer. One that lives outside FF does not.

## 4. Step 1: make one function useful

Four gaps stop a customer from running anything real. They come before any new service.

**Done on 2026-10-21, in development:** the [step-1 plan](step-1-plan.md) built this step, in this order: environment variables and secrets; the event a function receives, which must be AWS's before a web address or a schedule can send one; function URLs, their TLS at the edge, and custom domains; schedules; then packages and the `ff` command, as the CLI plan's phases 0 to 2. **Done so far:** environment variables and secrets; AWS Lambda's event, with the functions made before keeping theirs until switched; function URLs, in the API and the console, served by the backend on a port of its own and over HTTPS at the edge, at customers' own domains too, proved by DNS; schedules, in the API and the console, with EventBridge's expressions and its Scheduled Event; the `ff` command, the CLI plan's phase 1 (deploy, invoke, logs and the live tail, local runs in Docker, `ff init`, the account's usage, balance and metrics), with the commands of each service above; packages with libraries, a zip as Lambda takes one, uploaded once and checked, which a function names and runs as an image its pods mount, in development (the CLI plan's C-21 to C-23); the Node.js runtime on Debian 13's glibc, so that native modules built as Lambda builds them load (C-25); and `ff package` and `ff deploy <folder>`, which make a function's folder a package with its libraries, for the runtimes' platform, and upload it when the account hasn't it, with the getting-started guide's "Functions with dependencies" (C-26, C-27). The getting-started guide's [A small app, end to end](getting-started.md#a-small-app-end-to-end) walks through all of it at once: a web address that writes to a database through a secret, a nightly schedule, and a package with its driver, which `hack/cli-e2e.sh` runs. [ADR 0003](adr/0003-code-delivery.md), confirmed on 2026-10-21, added the code registry to production's manifests (the CLI plan's C-28); then inline code moved onto the packages' path, one file of up to 3 MiB as AWS Lambda's console takes, made a one-file package and run as an image too, so that every function's code reaches its pods one way (C-24); and a lost code image is made again within the hour, or at the backend's restart, its packages copied to the second site (C-29). **Confirmed on 2026-10-22:** the choices of the step-1 plan's §9 (the [decision log](decisions.md)); FF's domain, named the same day, is `ffunc.tn`, registered since (2026-10-23), and who hosts its DNS is still to choose. The plan's progress log has the details.

| Feature | Why | Parent task | Size |
|---|---|---|---|
| **Function URLs** | A public web address per function, so a browser, or a payment service's webhook, can call it. The event the function receives is the same as AWS API Gateway's (payload version 2.0), so the code moves to AWS as it is. Then custom domains, with free TLS certificates from Let's Encrypt, which the edge proxy already gets for FF's own hosts. | E-01 | 3 weeks |
| **Environment variables and secrets** | Today a database password would have to be written inside the code, and the code is stored where anyone with read access to the function can see it. Secrets are stored encrypted and given to the function when it starts. | C-31 (CLI plan), §4.7 | small |
| **Packages with libraries, and the `ff` command** | A real function needs libraries: a database driver, an SDK. Today a function is one file. The CLI plan's phases 1 and 2 build the upload of zip packages, with AWS Lambda's packaging rules. | CLI plan, phases 1 and 2 | in the CLI plan |
| **Schedules** | Run a function every night, or every five minutes, with AWS's `cron()` and `rate()` text, so the schedule moves too. | E-02 | 1 week |

## 5. Step 2: a database and file storage

These two are the heart of the "local cloud" idea. Almost every app needs both, and both need a foreign card today.

**Done on 2026-10-23, in development:** the [step-2 plan](step-2-plan.md), with its choices (its §9), after the CLI plan's C-29; its progress log says what was built. It takes the decisions below further: where the customers' database server runs and how functions reach it, how its size is limited, the S3 front door that the parent plan's E-04 describes, and what each service is billed.

### 5.1 Managed PostgreSQL

**What:** one database and one database user per account, on a PostgreSQL server that FF runs. The customer gets the connection string as a secret (step 1) and uses it from functions with any PostgreSQL driver.

**Why first:** an app without a database can't store anything. Neon, Supabase, PlanetScale and the others all need a card. The parent plan already says "recommend PostgreSQL, don't copy DynamoDB" (§6.7) and puts a managed offer in Phase 4. This document pulls it forward, ahead of queues.

**How to start small:**
- One shared server per plan tier. Later, a server per account for the bigger plans.
- The backups FF already runs (restore to any minute, a copy on a second site) cover the customers' databases too.
- Limits per plan: storage size, connections, number of databases.
- Billing by storage, in GB per month, from a sample taken every hour, as `capacity_samples` samples instances every minute. A small monthly fee per database if the costs need it.
- The way out: `pg_dump` and restore to AWS RDS. Write the page.

**Risks:** one customer's heavy queries slow the others (limits per user, and watch it in the operator's monitoring); a shared server is a bigger target (TLS on, one user per database, no admin rights for customers).

**Size:** medium. Not estimated in the parent plan.

### 5.2 File storage (buckets)

**What:** buckets per account on FF's S3-compatible store, with the account's own access keys, a size limit from the plan, and a bill per GB per month and per request.

**Why:** uploads, images, exports, backups. Every app has files. FF already runs the store for its own code copies, so the piece behind it exists. The customer uses the AWS SDK's S3 client and only changes the server address. When they move to AWS, they remove that one setting.

**Kept for step 3:** notifications ("run a function when a file lands"), which need the queue.

**Size:** 2.5 weeks (E-04).

## 6. Step 3: background work, where the queue fits

**Confirmed and started on 2026-10-23:** the [step-3 plan](step-3-plan.md). It takes what follows further: where the queue's messages live (pgmq, or FF's own tables in its shape, which its first task's spike compares), Lambda's asynchronous invoke and its retries, SQS's API with the account's keys, functions reading queues in batches, and bucket notifications from the S3 front door; its §9's ten choices are answered, as the decision log says (24 to 33).

A queue is the right idea, and its time comes after steps 1 and 2. Build **one queue that keeps its messages until they are handled** (pgmq, a queue inside PostgreSQL, as the parent plan's ADR-003 says; NATS JetStream later if the load needs it), and show it to customers in three ways:

| Way | What the customer gets | Parent task | Size |
|---|---|---|---|
| **Async invoke** | Call a function without waiting for it. FF retries on failure (up to 2 times), drops events older than a limit, and sends failed events to a queue for failed messages or to another function. The same as Lambda's async invoke. Schedules then call their function this way, so that a failed scheduled run is retried too, as on AWS (the step-1 plan's §9, confirmed on 2026-10-22). | E-03 | 2.5 weeks |
| **Queues with the SQS API** | The customer creates a queue, sends messages from anywhere with the AWS SDK, and a function reads them in batches and can say which messages of a batch failed. Standard queues first, FIFO queues later. | E-05 | 4 weeks |
| **Bucket notifications** | A file lands in a bucket, and a function runs with an S3-shaped event. | part of E-04 | included above |

**Why in this order:** most pilot apps never need a queue, but none works without a database or a web address. And the queue is the most expensive row of the parent plan's Phase 3 table. Building the backbone once and selling it three ways is the cheapest way to get all three.

## 7. Step 4: the whole app runs here

After step 3, a customer can run an API with a database, files and background jobs. Three more things let them move the **whole** app.

### 7.1 Static site hosting

**What:** upload a built site (React, Vue, plain HTML), get an address, add a custom domain with TLS. A thin layer on the file store (step 2) and the Caddy edge proxy that already serves FF's own apps.

**Why:** agencies and startups need somewhere for the frontend. Vercel and Netlify need a card above their free tiers. With functions behind it, FF becomes "my whole app runs here". This is not in any plan yet.

**Size:** small to medium.

### 7.2 Sending e-mail from apps

**What:** an API to send e-mail (sign-up codes, receipts, alerts), shaped like AWS SES's `SendEmail`, or an SMTP login per account for code that already uses SMTP. FF already sends mail for its own notifications.

**Why:** SendGrid, Mailgun and SES need a card. Every app sends e-mail.

**Caution:** mail is about reputation. If one customer sends spam, FF's mail servers get blocked for everyone. So: verified sender domains only (the customer adds SPF and DKIM records), low daily quotas that grow with the account's age and payments, bounce and complaint tracking, and a switch per account in the admin dashboard.

**Size:** medium.

### 7.3 A cache (Valkey)

**What:** a Redis-compatible key-value store per account, from Valkey, for sessions, counters and caching. The client-readiness plan already names Valkey for FF's own rate limits once the backend has more than one copy.

**Why:** common, but less urgent than the rest. Apps can start without it.

**Size:** small to medium.

## 8. Step 5: the way out

These keep the "no lock-in" promise. They don't make a customer productive on day one, so they come after the services above, but before FF asks bigger companies to trust it.

| Feature | What | Parent task | Size |
|---|---|---|---|
| **The Lambda API, with AWS's request signing** | FF answers the same calls as AWS Lambda's API, signed the way AWS signs requests (SigV4). Then `aws lambda …`, the AWS SDKs, Terraform and SAM work against FF with one server-address setting. | E-06, E-07 | 5.5 weeks |
| **Versions and aliases** | Publish a version, point `prod` at it, roll back by pointing it elsewhere. Needed for staging and for safe deploys. | R-01 | 2 weeks |
| **Terraform modules** | A tested provider setup and reference modules. | E-08 | 2 weeks |
| **The export kit** | `ff export` writes a SAM template, Terraform files, the code, data scripts and a runbook; `ff doctor` lists what still points at FF; a cost estimate at AWS prices, from the customer's real usage. | E-09 | 4 weeks |
| **SAM events** | The one `template.yaml`, with its queues, buckets and schedules, deploys on FF and, unchanged, on AWS. | E-10 | 2 weeks |

## 9. Further out

What comes after steps 1 to 5, grouped by theme. Each item says what it is, why, and what to watch. Nothing here has an estimate unless a parent task is named.

### 9.1 More ways to run code

- **Container functions.** The customer brings a container image, as Lambda allows. That opens Java, .NET, Go, Rust and PHP without FF writing a runtime for each. The parent plan has more runtimes in S-03 (3 weeks). Watch: image size and cold starts, and a local image registry so images don't come from the internet.
- **Runtime versions to choose from,** as AWS Lambda lets its customers choose `nodejs22.x`, `nodejs24.x` or `python3.12`: FF has one version per language today, which FF updates. Each version would be a runtime image, with its own date of end, as AWS deprecates its runtimes. A function's code is an image apart from its runtime's ([ADR 0003](adr/0003-code-delivery.md)), so it changes runtime with an update and its package as it is, unless its native libraries were built for another version; `ff package` builds for the version chosen.
- **Always-on web services.** Many apps are not functions: a Laravel or Django site, a Next.js server, an Express API with WebSockets. A service that runs a container behind a web address, with one or more copies, health checks, and updates one copy at a time with no downtime. Like AWS App Runner or Google Cloud Run. Billed per CPU-second and GB-second of running time. This is probably the biggest demand from agencies. It reuses the account spaces, quotas, sandbox, logs and metrics that functions have. Watch: it is a second product, not a feature. It needs its own plan.
- **Build from source.** Connect a Git repository, push, and FF builds the package and deploys it. The parent plan keeps builds on the developer's side at first and names a build service later (§6.1). Builds run in their own isolated jobs, never on the nodes that run customers' code, and fetch packages from a local mirror of npm and PyPI (§11.2), not from the internet.
- **GPUs and AI models.** Expensive hardware, so not soon. Two notes for later. Hosting open models locally would be a real service, since OpenAI and Anthropic also need a card. A gateway that resells foreign AI APIs is tempting, but paying abroad on the customers' behalf is exactly the problem FF exists to avoid, and the exchange rules apply to FF too. A lawyer first.

### 9.2 More data services

- **Database backups the customer runs.** A "restore to this time" button in the console, on top of FF's own backups.
- **Managed MySQL or MariaDB.** For WordPress and older Laravel apps. Only if customers ask.
- **Search.** An OpenSearch-style service is heavy to run. Only on demand, and maybe as a dedicated offer rather than a shared one.
- **A DynamoDB-compatible store.** The parent plan says no for v1 (§1.3), and this document agrees. PostgreSQL covers most needs. Revisit only if many customers arrive with DynamoDB code.

### 9.3 More messaging

- **Topics.** One message, many receivers: functions, queues, webhooks, e-mail. Like AWS SNS. Small once the queue exists.
- **SMS.** Sign-up codes, alerts, reminders, through the local operators. Twilio needs a card. Watch: it needs contracts with the operators, and it is a resale business with thin margins. The parent plan already wants SMS for phone verification (B-10).
- **WebSockets.** Live apps: chat, live dashboards, notifications in the browser. Lambda does it through API Gateway's WebSocket API. Watch: long connections don't fit functions that scale to zero. This fits better with always-on services (§9.1).
- **An event bus with rules.** Like EventBridge. Only if topics are not enough.

### 9.4 Web and edge

- **Caching in front of sites and functions.** Start with cache rules in the edge proxy. More nodes later, in other data centers in the country.
- **DNS hosting.** A DNS zone per account, so a customer points a `.tn` domain at FF and custom domains are one step. Small, with PowerDNS or CoreDNS and an API.
- **Basic protection.** Rate limits per IP at the edge, request size limits, blocking known bad traffic. Not a full web firewall.

### 9.5 Login for customers' own apps

**What:** hosted user accounts for the customer's app: sign-up, e-mail verification, password reset, social login, and tokens the customer's functions can check. Like AWS Cognito, Auth0 or Firebase Auth. FF already runs Keycloak. A separate login space (a realm) per account, or a Keycloak of their own for the bigger plans, is the short path.

**Why:** most apps need login, and the foreign providers need a card above their free tiers. Watch: the personal data of the customer's users then lives in FF, so the data-protection work (parent §9.2) applies twice.

### 9.6 Developer tools

- **Environments.** Dev, staging and production inside one account, on top of versions and aliases. Later, projects inside accounts, which the client plan's D1 left room for.
- **Deploy previews.** A branch gets its own address, removed when merged. Needs build-from-source (§9.1).
- **Tracing.** Follow one request through a function, a queue and the database, with OpenTelemetry (an open standard). Like X-Ray, which the parent plan leaves out of v1; OpenTelemetry is the portable way.
- **Local development.** `ff local` runs the whole app on a laptop: functions, the queue and the storage, with the same images. Like LocalStack, but FF's.
- **Secrets with rotation.** On top of step 1's secrets: change a database password without a deploy.
- **Templates.** A REST API, a cron job, a webhook receiver, a queue worker, an image resize on upload, a static site with an API. Each one deploys on FF and on AWS. The parent plan lists them (§10).
- **Documentation in French and Arabic**, a status page, and a forum. Each page says "this is the same as … on AWS".

### 9.7 Local services AWS does not have

This is where FF can be more than a copy. The customers are Tunisian businesses with Tunisian obligations.

- **An e-invoicing API.** Electronic invoices through El Fatoora are mandatory for service providers since January 2026. FF must build the signing and the submission for its own invoices (P-37, skipped for now). Once built, offer it as an API: send an invoice, get it signed, submitted and returned with its QR code. Every business that bills needs this, and few developers want to build it. Watch: the TunTrust certificate belongs to each business, so the service holds the customers' certificates, which is a security job in itself.
- **Ready-made payment integrations.** Templates and small libraries for Konnect, Flouci and bank e-payment, with the webhook receiver done right (FF's own lesson from D9: never trust the redirect, always ask the provider again). FF builds these for its own top-ups anyway.
- **Local SMS** (§9.3).

### 9.8 Business and platform

- **Card top-ups.** Konnect and Flouci, before FF takes individual developers. Bank transfer only works for companies. P-34 was skipped, not dropped.
- **E-invoicing for FF's own invoices** (P-37), before general availability.
- **Two sites.** Disaster recovery across two data centers (S-01, 4 weeks), before FF hosts anyone's production database.
- **Dedicated and On-Prem editions.** A "region in a box" for banks and public bodies that may not use shared hosting (S-06, 6 weeks; S-10 for the public-sector label).
- **Resellers.** Agencies that run FF for their clients, with a wholesale price and, later, their own name on the console.
- **A second country.** The same package with a local partner (S-07, and Appendix H of the parent plan). The exchange-control problem exists in several countries of the region.
- **Security labels.** ISO 27001 readiness (S-08), and a security test by an outside company before each big launch.

## 10. What every new service needs

A service is a product, not a feature. Before the next one starts, the last one has all of this:

1. **Its own usage records**, written once and never changed, so the bill can be recomputed, as functions have (client plan, D6).
2. **A price in the price book**, as a new SKU, and a free tier if AWS has one.
3. **Limits in the plan**, written into the account's quota.
4. **A console page** and the API routes, each limited to the caller's account, with the isolation test that every route has.
5. **An admin page**: see it per account, change its limits, turn it off for one account with a reason.
6. **Backups**, and a line in the restore runbook and in the monthly drill.
7. **Logs and metrics** the customer can read, and alarms on them.
8. **A documentation page** with the "same as AWS …" note, in French.
9. **A way out**: what the export kit writes for it, and the runbook for moving its data.
10. **Abuse limits**: what one bad customer can do to the others, and the limit that stops it.

## 11. What not to build

From the parent plan's non-goals (§1.3, §3.3), with the reason in plain words:

- **Virtual machines, or Kubernetes for customers.** A different business, with different support and security work. FF sells managed services.
- **A full copy of AWS**: CloudFormation, the IAM policy language, Step Functions, VPC networking, X-Ray. Too big, and customers don't need them to stay portable.
- **Crypto or stablecoin payments.** Legal risk, and the target customers don't ask for it.
- **Anything that depends on a foreign paid service to run.** FF would hit the same payment wall as its customers.
- **FF-only formats** where AWS has one. The code must move.

## 12. A rough order

| Order | What | Needs | Size |
|---|---|---|---|
| 1 | Step 1: function URLs, secrets, packages and the CLI, schedules. **Done** in development: the [step-1 plan](step-1-plan.md) | nothing | the CLI plan, plus about 4 weeks; the step-1 plan says 22 to 32 days besides the CLI (its §10) |
| 2 | Step 2: managed PostgreSQL, file storage. **Done** in development on 2026-10-23: the [step-2 plan](step-2-plan.md) | secrets | medium, plus 2.5 weeks; the step-2 plan says 35 to 45 days (its §10), counting all that every service needs |
| 3 | Step 3: the queue, as async invoke, SQS queues and bucket notifications. **Started on 2026-10-23:** the [step-3 plan](step-3-plan.md), confirmed the same day | storage | about 6.5 weeks; the step-3 plan says 29 to 38 days (its §10) |
| 4 | Step 4: static sites, e-mail, a cache | storage | medium |
| 5 | Step 5: the Lambda API, versions, Terraform, the export kit | steps 1 to 3 | about 15 weeks |
| 6 | Card top-ups, e-invoicing for FF's invoices, two sites | nothing; they can run alongside | in the client and parent plans |
| 7 | Always-on web services, container functions | step 1 | large |
| 8 | Login for apps, topics, SMS, the e-invoicing API | steps 2 and 3, P-37 | medium each |
| 9 | Caching, DNS, environments, tracing, build from source | step 5 | medium each |
| 10 | Editions, resellers, a second country | all of the above | large |

Steps 1 to 3 are what the paid beta's customers will ask for in their first month. Step 4 lets them move whole apps. Step 5 is what a cautious company needs before it signs. The rest is a direction, to be re-ordered by what the pilot customers ask for.
