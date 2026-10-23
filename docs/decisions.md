# Decision log

| | |
|---|---|
| **What this is** | Every decision you have made about FF, newest first: what you decided and what it means, what has already changed because of it (with the commits), and what still has to change (with the task that will do it) |
| **How it is kept** | When you answer a plan's questions, a new section goes at the top of this log, and the plan's own table says "confirmed". The questions still waiting for you are at the end |

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
- **Still to change:** V-04, their samples and their bill; V-05, the console, the admin app, `ff db`, the guide and the backups.

**6. A database over its plan's size is warned and billed, not blocked.** ✅ Confirmed. Messages at 80% and 100%; above 100%, new connections are read-only, which the owner can turn off to clean up; the storage above the plan is billed.
- **Changed already:** V-01 measured the signal as an app meets it, and its statement changed: it is the user's setting in its database, which the backend may set, rather than the database's, which only its owner may; the sessions under way are ended so that a pool's come back read-only too ([ADR 0008](adr/0008-customer-databases.md), §5).
- **Still to change:** V-04.

**7. Databases reachable from the internet, encrypted only.** ✅ Confirmed. Developers connect from their laptops (`psql`, migration tools, `pg_dump`), as RDS's "publicly accessible" option allows.
- **Changed already:** V-01 measured who may log in where, and how drivers read the connection string: it says `sslmode=require`, which node-postgres takes as a full check of the certificate. So the server's certificate comes from a public CA in production, or from a CA of the operator's that functions' pods get ([ADR 0008](adr/0008-customer-databases.md), §9).
- **Changed already, too:** V-02, the server's encryption (TLS 1.2 at least) and who may log in where (`pg_hba.conf`), and the CA functions' pods get when the certificate isn't a public one; V-03, the connection string FF gives once, with `sslmode=require`.
- **Still to change:** V-05, the guide.

**8. Free every month, per account: 1 GB of database; 5 GB of files, 20,000 reads and 2,000 writes.** ✅ Confirmed: the plan's numbers.
- **Still to change:** V-04 and V-09 put them in the price book.

**9. No monthly fee per database.** ✅ Confirmed. Only storage is billed; the price book can add a fee later.
- **Still to change:** V-04, which adds the fee's price line at 0.

**10. Each function gets its own key to its account's buckets.** ✅ Confirmed. `new S3Client({})` works with no setup, as on AWS. The keys don't expire; short-lived ones, as AWS gives, come with step 5.
- **Changed already:** V-01 found how: the endpoint functions get is an IP address inside the cluster, which every SDK addresses path-style by itself, so that no DNS name of FF's is needed there ([ADR 0009](adr/0009-buckets.md), §4).
- **Still to change:** V-08.

**11. Customers' files are not copied to the second site, at first.** ✅ Confirmed, said plainly in the docs; to decide again before customers keep important files on FF.
- **Changed already:** the step-2 plan's V-09 now has the guide say so.
- **Still to change:** V-09.

**12. Data downloaded from FF is counted, not billed.** ✅ Confirmed. If FF's hosting bills FF for its traffic, FF bills it too.
- **Still to change:** V-09, the counts.

**13. Out of credit: file uploads are refused; reading files and the databases go on.** ✅ Confirmed. FF never deletes data for non-payment, and functions are already refused without credit.
- **Still to change:** V-07 and V-04.

**14. Documentation in French, a page per service, under `docs/fr/`.** ✅ Confirmed.
- **Still to change:** V-05 for databases, V-09 for buckets.

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
- **Still to change:** from step 2 (V-08), functions also get it as `AWS_REGION`. Before launch: the legal check of names like AWS's, and the `aws` in those names (the [parent plan](local-markets-and-aws-portability-plan.md)'s ADR-006).

**19. A failed scheduled run is not retried, until step 3.** ✅ Confirmed.
- **Changed already:** `57101f7` and `b66e09e` (U-07): each run happens at most once; a failure is kept in the history, the metrics and the schedule's last outcome.
- **Still to change:** step 3's background calls retry, and schedules will use them; the [roadmap](what-to-build-next.md)'s step 3 says so.

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
| Who hosts `ffunc.tn`'s DNS: DNS servers FF runs, a DNS company, or neither (decision 17; the domain is registered, 20) | This log, 17 and 20 | How function URLs and, from step 2, buckets get their certificates in production: one for all of them, or one each |
| Where `ff`'s downloads and the public runtime images are published, if customers can't rely on GitHub | [CLI plan](cli-plan.md) §10, question 3 | The first public release of `ff` |
| Windows for `ff`: in its phase 4, or when a customer asks | CLI plan §10, question 5 | The CLI's phase 4 |
| `ff login` sooner, so that the first customers never paste a key | CLI plan §10, question 7 | The order of the CLI's next tasks |
| Your company and the Startup Act label; FF Cloud or on-premises first; the data center and the hardware budget (a first server, for development: 21); a bank or payment provider; the team and the launch date; the product's name | [Parent plan](local-markets-and-aws-portability-plan.md) §15, questions 1 to 5 and 7 | Priorities, not the direction |
| Send the accountant's five questions; book the external penetration test | [Client-readiness plan](client-readiness-plan.md) §9 | VAT, invoices and withholding; the public launch |
| Later: take away the backend's right to create ConfigMaps, once no backend older than C-24 runs anywhere | [`deploy/k8s`](../deploy/k8s/README.md) | Nothing until then |
