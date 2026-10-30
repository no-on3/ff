# Decision log

| | |
|---|---|
| **What this is** | Every decision you have made about FF, newest first: what you decided and what it means, what has already changed because of it (with the commits), and what still has to change (with the task that will do it) |
| **How it is kept** | When you answer a plan's questions, a new section goes at the top of this log, and the plan's own table says "confirmed". The questions still waiting for you are at the end |

## 2026-10-30: step 4 started, its eleven choices as recommended

You said: "read docs/step-4-plan.md and docs/what-to-build-next.md, extract what's not done yet, create a dedicated tasks list for it, and then start working on it and don't stop until you are finished. You can deploy to server". The list is the [step-4 task list](step-4-tasks.md). Building without stopping meant answering the [step-4 plan](step-4-plan.md)'s §9 without asking: each of its eleven choices is taken as the plan recommended it. Any of them can still change; each says below what changing it would touch. The branch `feat/step-4` was made from `master` at `82d66ba`. The step was done the same day, W-00 to W-10, and installed on the development server (Deploy 2).

### Step 4: the whole app runs here

**40. A site is a bucket with S3's website configuration,** its files sent with `aws s3 sync` or `ff sites deploy`. ✅ Taken as recommended. The way out stays S3 and CloudFront, and buckets' measures, limits and bills serve sites as they are. Deploys with rollbacks, as Netlify has, can come on top later.
- **Changed already:** W-02 (`6dc2371`): S3's website configuration at the S3 front door, in S3's XML, and in FF's API, and the website server, which answers as S3's website endpoint does; W-03 (`0eef134`): `ff sites deploy`, which sends only what changed with a deploy's own key, and the console's site panel.
- **Still to change:** nothing.

**41. Single-page apps: an unknown path answers the index document with 200,** as CloudFront's custom error response does, a site's own setting, on with `ff sites deploy --spa`. ✅ Taken as recommended. Off, a site answers as S3 alone does: the error document, with 404.
- **Changed already:** W-02 (`6dc2371`): a site's `singlePageApp`, with which the website server answers an unknown path with the index document and 200; W-03 (`0eef134`): `ff sites deploy --spa`.
- **Still to change:** nothing.

**42. Sites live under FF's domain, at `<bucket>.site.ffunc.cloud`,** as function URLs live under `fn.ffunc.cloud`; on the development server, `<bucket>.site.dev.ffunc.cloud`. ✅ Taken as recommended. A domain of its own for customers' content (sites and function URLs), so that a phishing page on one never marks FF's own domain, as GitHub keeps `github.io` apart from `github.com`, is a question for before the public launch: added at the end of this log.
- **Changed already:** W-03 (`0eef134`): `<bucket>.site.<domain>` at the edge, its certificates made on demand, and a customer's own domain for a site; on the development server, the record `*.site.dev`, made by you on 2026-10-30, and a site there, which the smoke test visits (Deploy 2).
- **Still to change:** nothing in this step; a domain of its own for customers' content, before the public launch (the questions at the end).

**43. The bytes sites send out are counted, not billed,** as decision 12 says of all bytes out, with a limit a month per plan to protect the server: 10 GB on beta. ✅ Taken as recommended.
- **Changed already:** W-02 (`6dc2371`): a site's bytes counted, never billed, against the plan's `siteTransferGbPerMonth`, 10 GB on beta, past which the account's sites answer 403 until the month's end; each visit billed as a request of S3's second class, as a `GET` is.
- **Still to change:** nothing.

**44. E-mail's interface: SES v2's API first,** so that AWS's SDKs work with only the endpoint changed and the quotas sit in one place; SMTP, with a password made from a key as SES makes it, later. ✅ Taken as recommended.
- **Changed already:** W-06 (`0a8bba0`): SES v2's API at an endpoint of its own, `email.<domain>`, signed for `ses` with the account's keys or a function's: identities, the account, the suppression list; W-07 (`3599ead`): `SendEmail`, simple and raw.
- **Still to change:** nothing in this step; SMTP later, as this decision says.

**45. The server that sends customers' mail: a Postfix of its own,** the backend signing each message with the customer's DKIM key, never FF's own relay, so that one customer's spam can't stop FF's own mail. ✅ Taken as recommended. Postal does more, with more to run.
- **Changed already:** W-07 (`3599ead`): `deploy/mail/`, Postfix 3.11 and FF's agent, the backend signing each message with its domain's DKIM key, what bounced and the complaints read back; on the development server, beside the cluster, its mail handed to Mailpit, none sent (Deploy 2).
- **Still to change:** in production, a server and an IP address of its own, checked against block lists first (the plan's §8).

**46. The sandbox, as SES's:** a new account sends only to addresses it proved, 200 a day, until an operator lifts it in the admin app. ✅ Taken as recommended.
- **Changed already:** W-07 (`3599ead`): in the sandbox, mail to what the account proved alone, within the plan's 200 a day and 1 a second (W-06's `emailsPerDay` and `emailsPerSecond`); W-08 (`b4ff421`): the admin app's account page, where an operator lets an account out of the sandbox or puts it back, with a reason, in the account's audit log and an e-mail to its owners.
- **Still to change:** nothing.

**47. A cache is a Valkey process of its own,** its memory the plan's, on a server of customers' caches; never one Valkey shared by every account, where one account could fill the memory of all. ✅ Taken as recommended.
- **Changed already:** W-04 (`7b40ee9`): `deploy/cache/`, Valkey 9.1.2 and FF's agent, each cache a process of its own under a user of its own, with the plan's memory, and `/caches` in FF's API; on the development server, beside the cluster (Deploy 2).
- **Still to change:** nothing.

**48. A cache keeps nothing on disk:** it is a cache, said plainly in the docs; a restart empties it. ✅ Taken as recommended.
- **Changed already:** W-04 (`7b40ee9`): a cache's keys in memory alone, nothing on disk; W-09 (`de6622d`): ADR 0013 as built and the French page on caches say that a restarted cache starts empty. An update of the development server no longer starts customers' caches again when nothing of theirs changed (Deploy 2, `e787d6d`).
- **Still to change:** nothing.

**49. The order: sites, then caches, then e-mail.** ✅ Taken as recommended. Sites are the smallest and reuse the most; e-mail has the most risk, and its server's IP address the most to check.

**50. FF's own counters (its rate limits) stay in the backend's memory** in this step; in Valkey once the backend runs more than one copy, as the client-readiness plan says. ✅ Taken as recommended.

## 2026-10-24, later: FF's domain is ffunc.cloud, and its repository on GitHub

You said: "I bought ffunc.cloud, i want to use instead", then made its records for the development server at OVH; and: "i also created an empty git repository: https://github.com/no-on3/ff so everything can be automated".

**38. FF's domain is `ffunc.cloud`, instead of `ffunc.tn`.** ✅ Your answer. Registered on 2026-10-24 at OVH, whose DNS serves its zone, which answers who serves it (17); the .tn registry never delegated `ffunc.tn`.
- **What it means:** production's names are under `ffunc.cloud`: `api`, `console`, `admin`, `login`, `s3`, `sqs`, `db`, `*.fn` and `*.s3`. The development server's are under `dev.ffunc.cloud`, so that production can take the short ones later without moving it: the eight records you made, `api`, `console`, `admin`, `login`, `s3`, `sqs`, `*.fn` and `*.s3`, each an A record to the server. None is AAAA: the server's proxy gets IPv6 callers through Docker's relay, which hides their address from the admin app's allowlist.
- **Changed already:** the zone (you, on 2026-10-24); the API's examples, the tests and the guides (`beefc12`); the development server's install, with Let's Encrypt's certificates for its six fixed names (37).
- **Still to change:** production's wildcard certificates. The edge asks for them by DNS-01 through RFC 2136, which OVH's DNS doesn't take (the questions at the end).

**39. FF's repository is on GitHub: `no-on3/ff`.** ✅ Your answer, and "push to github". Public when you made it, private since, the same day.
- **What it means:** GitHub runs the workflow already in `.github/workflows/ci.yml`, each stage of `hack/ci.sh` on GitHub's own machines. A private repository has 2,000 free minutes of them a month on GitHub Free, and the workflow's jobs may take up to 170 per push to `master`, by their time limits, and 215 a night, as the nightly run repeats every job, not the platform's alone (the questions at the end). The history pushed has no secret (gitleaks, every commit) and no trace of the server's address.
- **Changed already:** `master` pushed on 2026-10-24 (`2a381f4`), GitHub's default branch since.
- **Still to change:** how the development server updates from it (the questions at the end).

## 2026-10-24: step 3 merged, and FF on its development server

You asked, with step 3 done, for four things: the step-3 migrations on your development database, Caddy rebuilt, the merge into `master`, and FF deployed. On DNS you said: "currently the host for the dns is the canada server, made for dev work only, it already hosts other personal websites for dev work".

**34, done: your development database migrated.** ✅ Your answer. `ff_preview` had stopped at step 2's last migration: step 3's ten ran on 2026-10-24, after a copy of it (`pg_dump`, kept outside the repository), 50 of 50 now.
- **Still to change:** nothing. Your backend's watcher (`nest start --watch` in `BE/`) had stopped its app on the pending migrations: it starts again at its next change, or restart it.

**35, done: Caddy rebuilt.** ✅ Your answer. The three images that carry Caddy now build it themselves, 2.11.7 with Go 1.26.9 and x/net v0.60.0, which fix its release's three advisories (`3d1635a`). A newer one of Go's (CVE-2026-111943, crypto/x509) needs Go 1.26.10, released 2026-10-19: accepted until 2026-11-02, when it is two weeks old.
- **Found on the way** (`d4eaa94`): the security stage hadn't passed since 2026-10-21. Gitleaks' nine findings were made-up test values, now listed. npm audit found new advisories in the backend's dependencies whose fixes are under two weeks old: `.npmauditignore` now accepts such an advisory for a while, as `.trivyignore.yaml` does for images, and the API refuses compressed bodies, which closes body-parser's.
- **Changed already:** zod 4.6.7 in the backend on 2026-10-30, with step 4's merge, its exception having ended on 2026-10-25.
- **Still to change:** each fix once it is two weeks old, when its exception expires and the security stage says so: Go 1.26.10 for Caddy on 2026-11-02, body-parser 2.4.0 and multer 2.5.0 on 2026-11-05.

**36, done: step 3 is in `master`.** ✅ Your answer. Merged on 2026-10-24 (`2a381f4`), without a checkout, as step 2 was: `master` had not moved, so no file changed, and your dev servers saw nothing.

**37. FF on its development server, beside your other sites, through the server's own proxy.** ✅ Your answer: deploy there. The server's own rules (its `/data/proxy/README.md`) decide how: its one proxy keeps ports 80 and 443 for every project, FF adds one route file, and k3s runs without its ingress or load balancer.
- **What it means:** [`deploy/dev-server`](../deploy/dev-server/README.md). The platform as production runs it, with FF's names under `dev.ffunc.cloud` (38); the proxy terminates the internet's TLS, with Let's Encrypt's certificates for the six fixed names and its own authority's for function URLs and buckets, and sends FF's names to FF's edge, which does the rest; PostgreSQL, S3, mail and customers' databases beside the cluster, on no public port.
- **Changed already:** `4525d2e`: the edge believes the caller's address from that proxy alone (`FF_EDGE_TRUSTED_PROXIES`), so that its allowlist for the admin app still works behind it. `5e2eebf`: the kit. Installed on 2026-10-24, with your go-ahead ("Yes, run it now"): FF up at `https://console.dev.ffunc.cloud`, the install's 7 checks and the smoke test's 11 passed (an account asked for and approved, a function in gVisor and at its URL, a bucket, a queue), your other sites untouched. The first runs found five faults, each fixed and committed before the next run: the services beside the cluster missing at the migrations and blocked by the firewall (`827ac85`), the operator's username, which FF's realm makes its e-mail address (`d3254c9`), the proxy sending the edge its own address as the host (`74c2df5`), the smoke test not following Keycloak's redirect to the one-time password's setup (`15fae8c`), SeaweedFS unable to read its identities (`9518619`).
- **Still to change:** how the server updates (the questions at the end).

**17, answered: OVH serves the zone, `ffunc.cloud`'s (38).** Your answer, in two steps: FF's names point to the server in Canada; then, as `ffunc.tn` still answered "no such domain" on 2026-10-24, its registry having no record of it, `ffunc.cloud`, bought at OVH, whose DNS serves it.
- **Still open:** the two wildcards' certificates (`*.fn` and `*.s3`), on the development server and in production (the questions at the end).

## 2026-10-23, later: step 3's ten choices, and the object store's names

You answered: rename the object store's settings, which still carried MinIO's name, before step 3; then start step 3 with every choice of its plan as recommended. Step 2, done the same day, was merged into `master` (`f772e7f`) before step 3's branch was made from it.

**23, done: the object store's settings are `FF_OBJECT_STORE_*`.** ✅ Your answer: renamed now, while FF runs nowhere yet.
- **What it means:** MinIO itself left FF with the parent plan's F-15 (SeaweedFS by default, any S3-compatible store in production); its name stayed on six settings and a module. They are `FF_OBJECT_STORE_ENDPOINT`, `_PORT`, `_USE_SSL`, `_ACCESS_KEY`, `_SECRET_KEY` and `_BUCKET` now, and `BE/src/object-store/`; a backend still given an old name refuses to start, naming the new one. History in the plans keeps MinIO's name.
- **Changed already:** the step-3 branch's first commit: the backend, `BE/.env.example`, the platform's manifests and the test scripts; your `BE/.env` the same day.
- **Still to change:** nothing.

### Step 3: background work, where the queue fits

The [step-3 plan](step-3-plan.md)'s §9, each answered as it recommended.

**24. The queue's messages live in FF's own PostgreSQL; Q-01's spike picks pgmq or FF's own tables in its shape.** ✅ Confirmed. Backed up with FF's database, and written in the same transaction as what makes them; NATS JetStream later, when throughput requires it.
- **Changed already:** Q-01: [ADR 0010](adr/0010-queue.md), FF's own table, pgmq's throughput the same as measured but 7 relations a queue made while FF runs. Q-02, part 2: the tables `queues` and `queue_messages`, claimed with leases; functions' asynchronous calls kept there.
- **Still to change:** customers' queues, with Q-04 and Q-05.

**25. The account's keys, and each function's own, reach queues too.** ✅ Confirmed. One kind of key, as IAM's access keys reach every service.
- **Still to change:** Q-04.

**26. The SQS endpoint is a port of the backend's own, beside the S3 front door's,** at `sqs.ffunc.tn` in production. ✅ Confirmed.
- **Still to change:** Q-04; its address in FF's install.

**27. Queue requests are billed as SQS bills them:** by the million, each 64 KB of a message a request, 1 million free each month; the messages FF hands to functions one request a batch, FF's empty reads not billed. ✅ Confirmed.
- **Changed already:** Q-08, part 1: each request that names a queue counts, whichever way it came, FF's API's and the console's sends and receives too, as the AWS console's requests are SQS's; the console's pages, reading queues without SQS's operations, count nothing. A batch a function reads is the request that would have received it, each 64 KB of it one, its deletes after the call not billed; a bucket's events and a function's destination records sent to a queue count as S3's and Lambda's requests to SQS. Priced in SQS's three tiers (0.40, 0.30 and 0.24 US$ a million, past 100 and 200 billion in the month), from the book that starts the month after the migration `QueueBilling` runs; the statement, `GET /usage` and its CSV, the console's Usage page and `ff usage` list each queue.
- **Still to change:** nothing.

**28. Beta's limits:** 10 queues, 5 event source mappings a function, 100 requests a second, 100 MB of messages and waiting events per account. ✅ Confirmed.
- **Changed already:** Q-02, part 1: the four in every plan, the beta plan's as confirmed (the migration `QueueLimits`), edited in the admin app, listed by the console's account page and `ff account`. Part 2: what the account's messages hold, asynchronous calls waiting among them, enforced: an asynchronous call past it is refused with 429.
- **Still to change:** each other enforced with what it limits: requests and queues in Q-04 and Q-05, mappings in Q-06.

**29. FIFO queues later, once a customer asks;** standard queues first. ✅ Confirmed.
- **Still to change:** nothing in step 3.

**30. Bucket notifications go to a function or a queue;** SNS and EventBridge later, with those services. ✅ Confirmed.
- **Still to change:** Q-07.

**31. Destinations: a queue or a function,** on success and on failure, as Lambda's. ✅ Confirmed.
- **Changed already:** Q-03, part 1: a function as a destination, getting Lambda's record of each call as an asynchronous call of its own.
- **Still to change:** a queue as a destination, with Q-04, when there are queues to name.

**32. An asynchronous call lost when the backend stops is retried,** as one of its attempts; a synchronous one stays lost, as today. ✅ Confirmed.
- **Changed already:** Q-02, part 2: its event comes back when its lease ends, and the claim that kept no outcome counts as a failed attempt; the reaper marks that attempt `LOST`, unbilled, under its request.

**33. The docs: the guide in English, a page in French "comme AWS SQS".** ✅ Confirmed.
- **Still to change:** Q-09.

## 2026-10-23: the console merged, the domain registered, the server for development

You answered the readiness check of that day: merge the console's new look, remove a test container left running, the domain is registered, and the server in Canada is for development. Then, step 2, to its end.

**22, done: the console's new look is in `master`.** Merged on 2026-10-23 (`7d26ca4`), without a checkout: `master` had not moved since the branch began, so no file changed. The same day, the test DNS server that an earlier session had left running on the cluster's network (the container `dns-repro`, made on 2026-10-21 for the custom domains' checks) was removed.

**20, answered: `ffunc.tn` is registered.** ✅ Your answer: registered, while the registry confirms its owner's identity; FF acts on it as registered.
- **What it means:** FF's own addresses are under it: `api.ffunc.tn`, `console.ffunc.tn`, `admin.ffunc.tn` and `login.ffunc.tn`, `*.fn.ffunc.tn` for function URLs, and from step 2 `s3.ffunc.tn` and `*.s3.ffunc.tn` for buckets. The platform's manifests keep `example.tn`, an example that any operator replaces: FF's own values go in the overlay of FF's own install.
- **Still to change:** its DNS records and its certificates, once you choose who hosts its DNS (17, still waiting for you); the overlay with FF's addresses, with FF's install.

**21, answered: the server in Canada is FF's development server.** ✅ Your answer.
- **What it means:** FF runs there for development and tests, never with a customer's personal data. Production goes to a server in Tunisia, as the plans promise: the region stays `tn-tunis-1` (18), and no data of customers leaves the country, so INPDP's authorization for it isn't needed.
- **Still to change:** FF's install there, when you ask for it ([`deploy/k8s`](../deploy/k8s/README.md)). It isn't part of step 2, which is built and tested on this machine, as step 1 was.

**3, under way: step 2 started on 2026-10-23,** on the branch `feat/step-2`, made from `master` after the merge. Its tasks, V-00 to V-10, record their commits in the [step-2 plan](step-2-plan.md)'s progress log, and the decisions below (4 to 14) their changes as each is built.

## 2026-10-22, last: the console's look

**22. The console's look: direction A, "navy and paper".** ✅ Your choice, from two previews of the functions page.
- **What it means:** the console takes Column's calm palette (navy ink, a blue scale, a teal for what is healthy, an orange only for what needs you), the Geist fonts, soft navy shadows and 8 px corners. A sidebar replaces the row of links across the top, and lists become tables. The other direction, B, a dark one, stays written down in case a dark mode is wanted later.
- **Changed already:** the [console design plan](console-design-plan.md) (W-00 `8fff4cc`), with the direction as the build's contract and where each color comes from; built the same day: the tokens and the theme (W-01 `0be984e`), the sidebar (W-02 `0cf9efc`), the functions page (W-03 `3f3fc4f`), a function's page (W-04 `4a5587b`), the other pages (W-05 `eff29e9`), phones, focus and contrast (W-06 `e525e05`). Two of Column's colors were darkened for WCAG's contrast: the labels' grey and the orange under an alarm's count. No API change.
- **Still to change:** nothing: merged into `master` on 2026-10-23 (`7d26ca4`).

## 2026-10-22, later: FF's domain and its first server

You named both, and asked to record them and to merge step 1 into `master`. Two things found while recording them need you: nobody has registered the domain yet (20), and the server is in Canada, while the plans promise hosting in Tunisia (21).

**20. FF's domain is `ffunc.tn`.** ✅ Your answer.
- **What it means:** FF's addresses go under it. Following the example in production's settings, they would be `api.ffunc.tn`, `console.ffunc.tn`, `admin.ffunc.tn` and `login.ffunc.tn`, and each function URL `https://<32 letters and digits>.fn.ffunc.tn/`.
- **Found on 2026-10-22:** the domain isn't registered yet. The .tn registry (ATI) has no record of it, and DNS answers "no such domain". Register it soon, through a registrar ATI accredits, before someone else does. Choosing its name servers then answers the rest of decision 17: who hosts its DNS.
- **Changed already:** this log; the step-1 plan's §9 and the roadmap name it.
- **Registered since,** as you said on 2026-10-23 (above).
- **Still to change:** production's settings, where they say `example.tn` (`deploy/k8s/platform/*.env`, through an overlay); its DNS records, the four hosts and `*.fn` pointing to the server; decision 17's way to certificates.

**21. FF's first server is the one you reach with `ssh next`.** ✅ Your answer.
- **What it is,** read over SSH on 2026-10-22, nothing changed on it: a virtual server at OVH with 8 vCPUs, 22 GB of memory and two 200 GB disks (the second mounted at `/data`), running Ubuntu 26.04 LTS. Nothing is installed on it yet beyond Ubuntu itself. Its address belongs to OVH's data center in Beauharnois, near Montreal, **in Canada**. Its address and login stay in your SSH config, out of this repository.
- **What it means:** two things in the plans assume servers in Tunisia:
  - the promise "hosted in Tunisia" (the [parent plan](local-markets-and-aws-portability-plan.md), A1). Customers' personal data sent abroad needs INPDP's authorization (Law 2004-63, art. 52; the parent plan's §8.6), which may be hard to get while INPDP's council isn't renewed (R17);
  - the region, `tn-tunis-1` (18).
- **Changed already:** this log; the step-1 plan's §9 and the parent plan's §15 (question 3, ADR-006) point to it.
- **Answered on 2026-10-23:** FF's development server (above).
- **Still to change:** FF's install there ([`deploy/k8s`](../deploy/k8s/README.md)), with its backups' second site at another provider or in another region ([`deploy/backup`](../deploy/backup/README.md)).

## 2026-10-22: the step-1 and step-2 plans' choices, and C-29

You answered "all as recommended" to the 19 questions explained to you that day. Two of them start new work, in this order: **C-29 first, then step 2.** One needed a fact from you: FF's domain, which you gave the same day (20); who hosts its DNS is still to choose (17).

### Lost code images (the CLI plan's C-29)

**1. Lost code images are made again automatically.** ✅ Confirmed: before production, and before step 2.
- **What it means:** every function's code is an image in FF's registry. If the registry loses an image, running functions keep running, but no server that lacks the image can start a new copy of the function until its owner updates it. In production the registry keeps every image on one server's disk.
- **Changed already:** the [CLI plan](cli-plan.md)'s C-29, `218b680`. Every hour, and at once when the backend starts, the backend checks that the registry has the image of every package a function uses, whole, and makes each missing one again from the package's zip. A function whose pods still name an image the registry lost, as when the image made again differs from the old one, is rolled out with the new one. After losing the registry, restart the backend. The development registry now takes deletes, as production's does.
- **Still to change:** nothing.

**2. Uploaded code is copied to the second site too.** ✅ Confirmed: as part of C-29.
- **What it means:** the hourly backup copies only invoices and withholding certificates to the second site. Code typed in the console is also in FF's database, which is backed up; uploaded packages are only in FF's file store, so losing that store would lose them.
- **Changed already:** C-29, `218b680`. The backup's hourly mirror (`deploy/k8s/backup/mirror.sh`) also copies `packages/` to the second site. What FF deletes there (unused packages, a closed account's code) goes from the second site too, 30 days later, about as long as the database's backups keep what was deleted. A run that would delete more than half of the copy stops and says so, so an empty or replaced store never empties it. The restore runbook brings the packages back, then restarts the backend. A one-file package whose zip is lost is made again of its function's code, from the database. The backup drill checks all of it.
- **Still to change:** nothing.

### Step 2: a database and file storage

**3. Step 2 starts after C-29.** ✅ Confirmed.
- **What it means:** customers get PostgreSQL databases (like AWS RDS) and buckets for files (like AWS S3), billed in dinars at AWS's prices, within their plan, with a way out to AWS. About 35 to 45 working days.
- **Changed already:** the [step-2 plan](step-2-plan.md), the roadmap and the indexes say "confirmed".
- **Still to change:** the whole plan, V-00 to V-10, on a branch of its own.

**4. PostgreSQL 18.** ✅ Confirmed. FF never runs a newer version than AWS RDS, so that a database can always move to AWS; it moves to 19 once RDS offers it.
- **Changed already:** V-01's spike measured 18.6 with WAL-G 3.0.9, FF's version, which works with it ([ADR 0008](adr/0008-customer-databases.md)); V-02 made the server, PostgreSQL 18.6, in development and as the reference for production ([`deploy/data-db`](../deploy/data-db/README.md)).
- **Still to change:** nothing, until RDS offers 19.

**5. Customers' databases on a server of their own, outside Kubernetes.** ✅ Confirmed. One customer's heavy queries or full disk can't reach FF's own database, and the server has its own backups.
- **Changed already:** V-01 measured it ([ADR 0008](adr/0008-customer-databases.md)): a database and its user per customer, their names opaque, the backend's role no superuser, a tenant pod reaching the server through a rule of its own with its account's internet access off, and nothing else private.
- **Changed already, too:** V-02, the server, in development (`hack/k8s/data-db-up.sh`) and for production ([`deploy/data-db`](../deploy/data-db/README.md)); every tenant's network policy opens it on its port.
- **Changed already, too:** V-03, the databases themselves, in the API: each a database and its user on that server, made within the plan, suspended with their account, dropped at its data deletion date.
- **Changed already, too:** V-04, their hourly measures and their bill: storage by the GB-month, on the month's statement, in `GET /usage` and in the reconciliation.
- **Changed already, too:** V-05, the people's side: the console's Databases page, the admin app's per account (with each database's name on the server, and the switch that turns an account's databases off), `ff db`, the guide and a page in French; and the backups: 7 days of point-in-time recovery for the customers' server, with a key of its own, and one database brought back from a moment into a new one of the account's, by a runbook the monthly drill runs.
- **Still to change:** V-10, the small app on one of FF's databases.

**6. A database over its plan's size is warned and billed, not blocked.** ✅ Confirmed. Messages at 80% and 100%; above 100%, new connections are read-only, which the owner can turn off to clean up; the storage above the plan is billed.
- **Changed already:** V-01 measured the signal as an app meets it, and its statement changed: it is the user's setting in its database, which the backend may set, rather than the database's, which only its owner may; the sessions under way are ended so that a pool's come back read-only too ([ADR 0008](adr/0008-customer-databases.md), §5).
- **Changed already, too:** V-04: each database measured every hour; at 80% and 100% of the plan's storage its owners get an e-mail in their language, once each time it reaches the share; past 100%, the signal, set again each hour while it stays past, without ending the sessions under way, and taken away once it is back under; all its storage billed by the GB-month, above the plan's too.
- **Changed already, too:** V-05: the console says why a database is read-only, and shows its storage against the plan's; the admin app shows each database's status and size.
- **Still to change:** nothing.

**7. Databases reachable from the internet, encrypted only.** ✅ Confirmed. Developers connect from their laptops (`psql`, migration tools, `pg_dump`), as RDS's "publicly accessible" option allows.
- **Changed already:** V-01 measured who may log in where, and how drivers read the connection string: it says `sslmode=require`, which node-postgres takes as a full check of the certificate. So the server's certificate comes from a public CA in production, or from a CA of the operator's that functions' pods get ([ADR 0008](adr/0008-customer-databases.md), §9).
- **Changed already, too:** V-02, the server's encryption (TLS 1.2 at least) and who may log in where (`pg_hba.conf`), and the CA functions' pods get when the certificate isn't a public one; V-03, the connection string FF gives once, with `sslmode=require`.
- **Changed already, too:** V-05: the guide and the French page say how to connect, from a function and with `psql` from a machine.
- **Still to change:** nothing.

**8. Free every month, per account: 1 GB of database; 5 GB of files, 20,000 reads and 2,000 writes.** ✅ Confirmed: the plan's numbers.
- **Changed already:** V-04: all four are in the second price book, which its migration adds from the first hour of the month after it runs, with RDS's and S3's prices at AWS's list, read on 2026-10-23: 1 GB-month of databases, 5 GB-months of buckets, 2,000 `PUT` and 20,000 `GET` requests.
- **Changed already, too:** V-09: buckets measured every hour and their requests counted by S3's two classes, rated against the last three; the statement, `GET /usage` and its CSV show each bucket's month.
- **Still to change:** nothing.

**9. No monthly fee per database.** ✅ Confirmed. Only storage is billed; the price book can add a fee later.
- **Changed already:** V-04: the fee's price line is in the second book at 0; a book that sets one charges it by the hours each database existed.
- **Still to change:** nothing.

**10. Each function gets its own key to its account's buckets.** ✅ Confirmed. `new S3Client({})` works with no setup, as on AWS. The keys don't expire; short-lived ones, as AWS gives, come with step 5.
- **Changed already:** V-01 found how: the endpoint functions get is an IP address inside the cluster, which every SDK addresses path-style by itself, so that no DNS name of FF's is needed there ([ADR 0009](adr/0009-buckets.md), §4).
- **Changed already, too:** V-08: each function's key, made at its first deploy and revoked when it is deleted, in its pods' environment with the region and the endpoint, the Service `ff-storage`'s fixed address in production; `new S3Client({})` and `boto3.client("s3")` write to the account's bucket as they are, and are refused another's.
- **Still to change:** nothing, until short-lived keys (step 5).

**11. Customers' files are not copied to the second site, at first.** ✅ Confirmed, said plainly in the docs; to decide again before customers keep important files on FF.
- **Changed already:** the step-2 plan's V-09 now has the guide say so.
- **Changed already, too:** V-07: the guide's "Buckets" says it, beside the API that makes them.
- **Changed already, too:** V-09: the console's Buckets page says it, and `ff buckets create`.
- **Still to change:** the decision itself, again, before customers keep important files on FF.

**12. Data downloaded from FF is counted, not billed.** ✅ Confirmed. If FF's hosting bills FF for its traffic, FF bills it too.
- **Changed already:** V-06, the S3 front door, counts each bucket's bytes in and out by the minute, with its requests.
- **Changed already, too:** V-09: `GET /usage` gives each bucket's month of them, `bytesDownloaded` and `bytesUploaded`, and its CSV; the console's Usage page and `ff usage` show what each bucket sent out. Nothing prices them.
- **Still to change:** nothing, unless FF's hosting bills FF for its traffic.

**13. Out of credit: file uploads are refused; reading files and the databases go on.** ✅ Confirmed. FF never deletes data for non-payment, and functions are already refused without credit.
- **Changed already:** V-04: a database's storage is rated and debited whatever the balance, which goes below zero, as a function's `minInstances` do; nothing stops a database for its balance.
- **Changed already, too:** V-07: out of credit, an upload to a bucket answers `AccountProblem`, saying why; reading files goes on, and so does deleting them, which lowers the bill.
- **Still to change:** nothing.

**14. Documentation in French, a page per service, under `docs/fr/`.** ✅ Confirmed.
- **Changed already:** V-05, the first page: [`docs/fr/bases-de-donnees.md`](fr/bases-de-donnees.md), databases "comme AWS RDS", and the folder's index.
- **Changed already, too:** V-09: [`docs/fr/compartiments.md`](fr/compartiments.md), files in buckets "comme AWS S3".
- **Still to change:** a page for each service a later step adds.

### Step 1's choices (already built)

**15. Functions made before step 1 keep FF's old event until switched.** ✅ Confirmed.
- **What it means:** new functions receive the caller's input as `event`, as on AWS; older ones keep the old wrapper (`event.body`) until their owner switches them in the console.
- **Changed already:** `2883be7` (U-03): the runtimes' protocol v3 (`ff-runtime-nodejs:24-v3`, `ff-runtime-python:3.13-v3`), `functions.event_format` with the migration `EventFormat`, the console's switch, and [ADR 0007](adr/0007-function-events.md).
- **Still to change:** nothing. Once no function uses the old event, its code can go.

**16. A protected function URL (`AWS_IAM`) takes an FF API key.** ✅ Confirmed, until FF checks AWS's signatures.
- **Changed already:** `7eb725b` and `f8886c5` (U-04): function URLs, `AWS_IAM` checked as an API key of the function's account with `functions:invoke`, sent as `Authorization: Bearer ffk_…`.
- **Still to change:** later, AWS's signatures (SigV4), with the Lambda API of step 5, or reusing the signature checks step 2 builds for buckets.

**17. Certificates for function URLs: one for all of them if FF's DNS allows it, else one per URL.** ✅ Confirmed. The domain: `ffunc.tn` (20). ⏳ **Waiting for you:** who hosts its DNS, chosen when you register it.
- **Changed already:** `d13581b` (U-05): the edge built with the standard module for DNS updates (RFC 2136), both ways (`wildcard`, `on-demand`), and `deploy.sh`'s checks; `d0f5604` (U-06): customers' own domains, always one certificate each.
- **Still to change, once you answer:** DNS servers FF runs itself: settings only (`edge.env` and the Secret `ff-edge-dns`); a DNS company: its module in `deploy/edge/Dockerfile`, one line; neither: `on-demand`, about 50 new URLs a week for all customers, while the beta stays small.

**18. The region is `tn-tunis-1`.** ✅ Confirmed, if FF's servers are in Tunis. FF's first server is in Canada (21), and is for development only (answered on 2026-10-23): production's servers are in Tunisia, so the region stays.
- **Changed already:** `57101f7` (U-07): `FF_REGION`, `tn-tunis-1` by default, in each scheduled event's `region` and in its rule's name (`arn:aws:events:tn-tunis-1:…`).
- **Changed already, too:** V-08: functions get it as `AWS_REGION` and `AWS_DEFAULT_REGION`, with their key to their account's buckets.
- **Still to change:** before launch, the legal check of names like AWS's, and the `aws` in those names (the [parent plan](local-markets-and-aws-portability-plan.md)'s ADR-006).

**19. A failed scheduled run is not retried, until step 3.** ✅ Confirmed.
- **Changed already:** `57101f7` and `b66e09e` (U-07): each run happens at most once; a failure is kept in the history, the metrics and the schedule's last outcome.
- **Changed already:** the step-3 plan's Q-03, part 2: each run is kept in its function's queue in the transaction that moves its schedule on, then run as an asynchronous call, so retried, and lost by no backend's stop (D3).

## Earlier decisions

Each is recorded in full where it was made, and its changes are in that plan's progress log.

| When | Decision | Recorded in | Built by |
|---|---|---|---|
| 2026-10-21 | Each function's code is an image in a registry of the platform (option C); later, customers choose among runtime versions, as on AWS | [ADR 0003](adr/0003-code-delivery.md); the [roadmap](what-to-build-next.md) §9.1 | C-23 `29f1e90`, C-28 `52c3f14`, C-24 `b1ef540` |
| 2026-10-21 | A function's name follows AWS Lambda's rule and is unique in its account | [CLI plan](cli-plan.md) §10, question 6 | `1bd102e` |
| 2026-10-21 | Step 1 of the roadmap first: make one function useful | [Step-1 plan](step-1-plan.md) | U-00 to U-09 |
| 2026-10-17 | No card top-ups (Konnect) for now: credit comes by bank transfer, and from FF | [Client-readiness plan](client-readiness-plan.md), P-34 | `80cb783`: skipped, its design kept |
| 2026-10-17 | No El Fatoora e-invoicing for now: PDF invoices, while paper invoices are allowed | Client-readiness plan, P-37 | `81dae05`: skipped, its design kept |
| 2026-10-17 and 18 | How the work is done: one commit per task, one heavy process at a time, the plan and the docs updated with each task, tests that fail without the change, no task numbers in the code | Each plan's working rules (§6) | Every task since |
| 2026-10-16 | Prices: AWS Lambda's, in dinars, with the same free tier, set from the admin dashboard | Client-readiness plan §9 (D8) | P-30 `e5e915f`, P-73 `5feb4fd` |
| 2026-10-16 | During the beta, you approve every new account | Client-readiness plan §9 (D2) | P-71 `94f3b39` |
| 2026-10-16 | A separate admin dashboard | Client-readiness plan §9 (D12) | P-70 `9b5749e` to P-76 `55af745` |
| 2026-10-16 | Monthly invoices | Client-readiness plan §9 (D9) | P-36 `d09beae` |
| 2026-10-16 | Functions can't reach the internet unless you turn it on for their account: the safe choice you asked for | Client-readiness plan §9 (D5) | P-62 `e3a825b` |
| 2026-10-16 | Production uses any PostgreSQL, through settings, outside the cluster: the plan's answer to your question | Client-readiness plan §9 (D13) | P-01 `e3493b3`, P-02 `ae23168`, P-61 `10bbb7d` |
| 2026-10-16 | Kubernetes, not Nomad, runs the functions | [ADR 0001](adr/0001-orchestrator-kubernetes.md) | The [Kubernetes migration plan](kubernetes-migration-plan.md), K-00 to K-13 |

## Questions still waiting for you

| Question | Where it is | What it affects |
|---|---|---|
| Step 5's fourteen choices, each with a recommendation: the order (the export kit first), how much of Lambda's API, how its changes are answered, runtime names, what access keys may do with functions, functions' keys that expire, how a version runs, Lambda's permissions, where a SAM template is read, SAM's web events, schedules in Terraform, what the cost estimate counts, trying the way out on AWS itself, and the limits on beta | [Step-5 plan](step-5-plan.md) §9 | Step 5: nothing of it is built until you confirm them |
| A domain of its own for customers' content, sites and function URLs, so that a phishing page on one never marks `ffunc.cloud` itself, as GitHub keeps `github.io` apart from `github.com`; or both under `ffunc.cloud`, as now | This log, 42 | The public launch: the names customers' sites and function URLs get, and their certificates |
| GitHub's minutes, now that the repository is private: GitHub Free gives it 2,000 a month, and the workflow may take up to 170 per push to `master` and 215 a night, its every job, up to about 6,450 a month by the nightly run alone. Public again, where they are free; the nightly run weekly; or the cluster's stage on demand alone | This log, 39 | Whether CI keeps running all month |
| How the development server updates: by itself, pulling each commit of `master` whose tests passed on GitHub (recommended: GitHub then holds no key to the server; a private repository takes a read-only deploy key of the server's own, and a token that reads the workflow's results), or by GitHub, through a key to the server | This log, 39 | Deploys without anyone running `install.sh` |
| Function URLs' and buckets' certificates on the development server: the proxy's own authority, as now (recommended); Let's Encrypt's by DNS-01, through an OVH key that can change every record of `ffunc.cloud`, kept on the server other projects share; or one per host on demand, through a line in the shared proxy's main file | [`deploy/dev-server`](../deploy/dev-server/README.md) | Whether a browser that doesn't trust the proxy's root can call a function at its URL |
| Production's wildcard certificates: the edge's DNS-01 speaks RFC 2136, which OVH's DNS doesn't take: OVH's module in the edge, a DNS server of FF's for the zones of `fn` and `s3`, or one certificate per host on demand | [`deploy/k8s`](../deploy/k8s/README.md); this log, 17 and 38 | Production's install |
| Where `ff`'s downloads and the public runtime images are published, if customers can't rely on GitHub | [CLI plan](cli-plan.md) §10, question 3 | The first public release of `ff` |
| Windows for `ff`: in its phase 4, or when a customer asks | CLI plan §10, question 5 | The CLI's phase 4 |
| `ff login` sooner, so that the first customers never paste a key | CLI plan §10, question 7 | The order of the CLI's next tasks |
| Your company and the Startup Act label; FF Cloud or on-premises first; the data center and the hardware budget (a first server, for development: 21); a bank or payment provider; the team and the launch date; the product's name | [Parent plan](local-markets-and-aws-portability-plan.md) §15, questions 1 to 5 and 7 | Priorities, not the direction |
| Send the accountant's five questions; book the external penetration test | [Client-readiness plan](client-readiness-plan.md) §9 | VAT, invoices and withholding; the public launch |
| Later: take away the backend's right to create ConfigMaps, once no backend older than C-24 runs anywhere | [`deploy/k8s`](../deploy/k8s/README.md) | Nothing until then |
| Logical replication for customers' databases, so that one moves to AWS RDS without its writes stopping: offer it, or keep `pg_dump` alone. The step-2 plan named it as a way out (its D14); the server doesn't give it today: it needs users with `REPLICATION` and `wal_level = logical` for the whole server, and a limit on what an idle subscription keeps on its disk | [Step-2 plan](step-2-plan.md), D14; [`cli/templates/export/data/postgres.md`](../cli/templates/export/data/postgres.md) | A large database's move to RDS: without it, the app stops writing for the copy, minutes for a few GB |
