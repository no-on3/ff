# ADR 0012: Customers' mail, through SES v2's API and a server of their own

| | |
|---|---|
| **Status** | Accepted: the [step-4 plan](../step-4-plan.md)'s D4 to D6, and its choices (its §9), confirmed on 2026-10-30; SES v2's API as AWS's clients speak it, and a customer's DKIM signature through a Postfix, measured by W-01's spike the same day |
| **Date** | 2026-10-30 |
| **Implementation** | Step-4 plan: decisions D4 to D6; tasks W-06 to W-08. As built: W-06 to W-08 (below), decision 3 changed by W-07; W-09 documented it: the guide's "E-mail from apps", `how-it-works.html`'s scenario of it, the page in French, and the export kit's [`data/ses.md`](../../cli/templates/export/data/ses.md) |
| **Related** | [ADR 0010](0010-queue.md) (the queue that carries the mail to send); the [local markets and AWS portability plan](../local-markets-and-aws-portability-plan.md) §4.10, §9.2, §10; the spike, [`hack/spikes/mail`](../../hack/spikes/mail/README.md) |

## Context

An app sends e-mail: a receipt, a password reset, an alert. On AWS it calls SES (`@aws-sdk/client-sesv2`, boto3's `sesv2`) from a domain it proved with DKIM, within quotas that start small, in a sandbox until AWS lets it out, its bounces and complaints keeping addresses off a suppression list. FF's own mail goes through an outside relay with nodemailer, plain, with no DKIM, return path or bounce handling, and one customer's spam must never stop it.

### SES v2's API, as AWS's clients speak it, measured

`hack/spikes/mail/ses.sh`: a minimal SES v2 endpoint (`ses-endpoint.mjs`, Node.js's standard library), against AWS's SDK for JavaScript v3 (`@aws-sdk/client-sesv2` 3.1152.0), boto3 1.43.118 and the AWS CLI, each given its endpoint by `AWS_ENDPOINT_URL_SESV2` alone, a region and a key, as a function's code would have FF's. 33 checks, 33 as wanted: a domain and an address made as identities, one already there refused (`AlreadyExistsException`), one read back by its address, one not there refused (`NotFoundException`), the list in pages, `SendEmail` simple and raw, one from a domain not verified refused (`MessageRejected`), the account's quotas, the suppression list, a wrong secret refused (`SignatureDoesNotMatch`).

- **Every client signs the path escaped twice,** as AWS's rule for every service but S3 says: 42 requests of 42, none escaped once. An address's `@` in `/v2/email/identities/b@shop.example` is `%40` on the wire and `%2540` in what is signed. FF's signature check, written for S3, takes a mode for it.
- **Today's SDKs list identities with `POST /v2/email/list-identities`** and a JSON body (`NextToken`, `PageSize`), where SES v2's first model had `GET /v2/email/identities` and a query; both the SDK for JavaScript and boto3 did. The endpoint answers both.
- **Errors as AWS's REST JSON protocol gives them,** the error's name in `x-amzn-ErrorType` and a JSON body with its message: each client names the error by it.
- **A raw message names its sender in its `From` header,** read when `FromEmailAddress` is left out, as SES reads it.

### A customer's DKIM signature through a Postfix, measured

`hack/spikes/mail/dkim.sh`: an RSA key of 2,048 bits, as FF would make one for a customer's domain, its public half the TXT record FF would give; nodemailer, as the backend has it, signing each message with that key and handing it to Postfix 3.11.7 (Alpine 3.24.2's) with a return path naming the message (VERP, `b-<id>@bounces.<domain>`); Postfix relaying to a receiving server of the spike's, which refuses one address as a mailbox that doesn't exist; mailauth 7.3.0 checking the signature as a mailbox provider would. 7 checks, 7 as wanted:

- **The signature passes** at the other end, for the customer's domain and FF's selector, and **fails** once the subject is changed on the way.
- **The bounce comes back to the return path** as a delivery status report: to the address that names the message, with the recipient (`rfc822; bounce-me@example.test`), the action and status (`failed 5.1.1`), and what the remote server said.
- Each message was handed to Postfix in 70 to 132 ms over three runs; its delivery and the bounce took under a second.
- **Found on the way:** Postfix's catch-all for the bounces' domain (`luser_relay`) must be a whole address in a domain it delivers itself, or the bounces it takes leave again for the relay; and Docker's proxy takes a connection before Postfix listens, so a script waits for Postfix's own `220`.

## Decision

### 1. SES v2's API, on a port of the backend's own

An endpoint beside the S3 front door and the SQS endpoint: SES v2's REST API in JSON, signed with Signature Version 4 for the service `ses`, its path escaped twice, the account's keys and functions' own accepted, as at the other two. `AWS_ENDPOINT_URL_SESV2` is all a client needs. First: identities (`CreateEmailIdentity`, `GetEmailIdentity`, `ListEmailIdentities` both ways, `DeleteEmailIdentity`), `SendEmail` (simple and raw, 50 recipients at most), `GetAccount`, and the suppression list; any other operation answers `NotImplemented`.

### 2. Signed by the backend, sent by a server of customers' mail

Never FF's own relay. The backend signs each message with the customer's domain's DKIM key, which FF makes and keeps sealed (as SES's "bring your own DKIM" takes one), and hands it to a Postfix of the customers' own, on a server and an address apart, which delivers it and gets the bounces back for the return path's domain. A message's return path names it (VERP), so that a bounce says whose message it was without reading it.

### 3. Queued, then retried

A send is a message of a queue of FF's (ADR 0010), answered at once with its ID; a server that refuses for now is tried again, one that refuses for good bounces it.

### 4. Reputation, as SES keeps it

A sender's domain must be the account's, proved by its DKIM records, which FF checks as it checks a custom domain; SPF and DMARC advised in the records FF gives. A new account is in the sandbox, as SES's: it sends only to addresses it proved, 200 a day, until an operator lets it out. Quotas a day and a second, from the plan. A hard bounce or a complaint puts the address on the account's suppression list; past SES's rates the account is reviewed, then stopped. **Port 25 is closed to every function,** so that no code sends around them.

### As built (W-06): the endpoint and identities

- **The endpoint** (decision 1): a server of the backend's on `FF_SES_PORT` (3005), behind the edge at `email.<domain>` (`FF_SES_BASE`, a customer's `AWS_ENDPOINT_URL_SESV2`). The account's keys that reach the whole account (one that names buckets or queues reaches those alone), a read-only one only reading, and functions' own, whose pods get `AWS_ENDPOINT_URL_SESV2`, a name a function can't set; the account active. Each answer names its request (`x-amzn-RequestId`), each refusal its error (`x-amzn-ErrorType`) in SES's words.
- **Identities:** a domain gets an RSA key of 2,048 bits, FF's, sealed as secrets are, under a selector `ff` and 8 hexadecimal characters, as SES's own DKIM brought in (`SigningAttributesOrigin` `EXTERNAL`), and four records to publish: the key's TXT, its return path's (`bounces.mail.<domain>`) MX and SPF, and a DMARC policy that only reports. Looked up every minute for 72 hours, then `FAILED`; once proved, once a day, `TEMPORARY_FAILURE` while its record is gone. An address is proved by a link FF e-mails it through its own mail. `GetAccount` and the suppression list's four operations; FF's API under `/email/`, the scopes `email:read` and `email:write`, each change in the account's audit log. The plan's `emailIdentities` (2 domains on beta; an address counts for none), `emailsPerDay` (200) and `emailsPerSecond` (1).

### As built (W-07): sending, and what comes back

- **The server of customers' mail** (decision 2): `deploy/mail/`, Postfix 3.11 relaying from the backend's addresses alone, taking what comes for every return-path domain into one Maildir and refusing everything else from the internet, a message waiting a day at most; FF's agent starts it and gives the backend what came back over HTTPS on port 6391, to a token whose SHA-256 alone it has. The backend hands each message over SMTP with STARTTLS required, the server's certificate checked, signed with its domain's DKIM key, its envelope's sender `b-<message ID>@bounces.mail.<domain>` once the domain's MX is found, FF's own bounce domain (`FF_EMAIL_BOUNCE_DOMAIN`) until then.
- **Decision 3 changed: not step 3's queue, but a table of its own,** `email_messages`, taken the same way (a lease, `FOR UPDATE SKIP LOCKED`): each recipient's fate stays with its message, which its bounces, the console's list and the reputation's review read. A refusal for now is tried again 30 s, 2, 10 and 30 minutes later, then hourly, for a day; a refusal for good, or a day without a hand-over, fails it, the customer reading the server's words, never its address. Messages are kept 30 days.
- **Reputation** (decision 4): `SendEmail`, simple and raw, and `POST /email/messages`, from an address the account proved or one at a domain it proved; in the sandbox to what it proved alone; 50 recipients and 10 MB at most; each recipient counting against the plan's day and second, a suppressed one too, under a lock on the account, as SES counts them. Every 10 seconds the backend reads what came back: a bounce for good, or a complaint, puts the address on the suppression list. Over the last 14 days, of 100 recipients at least, past 5% of bounces for good or 0.1% of complaints the account is reviewed, past 10% or 0.5% stopped, never back by itself, the operator told. **Port 25 is closed to every function:** the internet's rule of their NetworkPolicy lists its ports, 465 and 587 open, as on AWS.

### As built (W-08): the console, `ff`, the admin app, and the bill

- **The admin app's switch:** an operator lets an account out of the sandbox, puts it back, pauses its sending, turns it on, or clears its standing after a review, each with a reason (`PUT /admin/accounts/:id/email`), in the account's audit log (`account.email`) and in an e-mail to its owners. The console's E-mail page and `ff email` give the rest: identities with their records, the account's sending, a test message, the latest messages with each recipient's fate, the suppression list.
- **Billed as SES bills:** each message leaves a billing record in the same transaction, `email_sends` (the migration `EmailBilling`, by month, append-only, kept as the bill is, where a message goes after 30 days): its identity, its recipients, what its attachments weigh. Each hour's mail is rated beside databases', buckets', queues' and caches' (the kind `email`, a line for each identity): its recipients at the book's `emailRecipientsPerThousand` and its attachments at `emailAttachmentsGb`, SES's 0.10 US$ a thousand and 0.12 a GB, times the book's rate, with no free tier.
- **Metrics and alarms:** `GET /email/metrics`, a point an hour from the account's messages: `Send`, `Delivery`, `Bounce`, `Complaint` (Sum), `Reputation.BounceRate` and `Reputation.ComplaintRate` (Average, the shares of the last 14 days' recipients reached that bounced for good and that complained). SES's `Reject` counts messages with a virus, which FF doesn't scan for. Alarms on all six watch the account's mail.

## Consequences

- One more server to run, with an address of its own whose reputation is FF's to keep: on block lists from the start if its hosting company's ranges are, warmed with low quotas (the plan's §8). Its agent and its Postfix are FF's code and settings, in `deploy/mail/`.
- Messages' copies are in FF's database for 30 days, their billing records as long as the bill is: the operator's database backups carry both.
- What the build leaves for later, each said above: SES's SMTP interface, with a password made from a key (the plan's §9, 5); templates, configuration sets, contact lists and dedicated IPs, which answer `NotImplemented`; receiving mail; `Reject`, without a virus scan; a domain's own DKIM key brought in, rather than FF's.

## Alternatives considered

- **SMTP first,** for code that sends with a library such as nodemailer: set aside for SES v2's API, which AWS's SDKs reach with the endpoint changed alone and where the quotas sit in one place (the plan's §9, 5).
- **Postal,** which the parent plan names: it does more, with more to run; and **a local relay** that signs each customer's domain, if one exists. Postfix with the backend's signing has the fewest pieces, measured by W-01's spike (the plan's §9, 6).
- **FF's own relay:** one customer's spam would stop FF's own mail, its logins' and invoices' (decision 2).
- **Step 3's queue for the messages:** what a recipient became would sit apart from its message, which its bounces, the console's list and the reputation's review all read (decision 3, changed by W-07).
