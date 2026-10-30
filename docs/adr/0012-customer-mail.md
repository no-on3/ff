# ADR 0012: Customers' mail, through SES v2's API and a server of their own

| | |
|---|---|
| **Status** | Accepted: the [step-4 plan](../step-4-plan.md)'s D4 to D6, and its choices (its §9), confirmed on 2026-10-30; SES v2's API as AWS's clients speak it, and a customer's DKIM signature through a Postfix, measured by W-01's spike the same day |
| **Date** | 2026-10-30 |
| **Implementation** | Step-4 plan: decisions D4 to D6; tasks W-06 to W-08 |
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
