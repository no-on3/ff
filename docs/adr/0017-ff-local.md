# ADR 0017: The whole app on a laptop, `ff local` in Rust inside `ff`

| | |
|---|---|
| **Status** | Accepted: the [developer tools plan](../dev-tools-plan.md)'s D3 and its choices 5 and 6, confirmed on 2026-11-08 (the [decision log](../decisions.md)'s 74 and 75); the shape measured by M-01's spikes the same day |
| **Date** | 2026-11-09 |
| **Implementation** | Developer tools plan: decision D3; tasks M-05 (functions, URLs, schedules and Lambda's invoke), M-06 (queues and buckets) and M-07 (databases, caches, mail, and the small app end to end). As built: below, under "As built"; M-07's part 4 documented it: the guide's [The whole app on your laptop](../getting-started.md#the-whole-app-on-your-laptop-ff-local), with its table of what `ff local` is and isn't, and [`cli/README.md`](../../cli/README.md) |
| **Related** | [ADR 0002](0002-cli.md) (the `ff` command); [ADR 0007](0007-function-events.md) (the URL event `ff local` builds); [ADR 0009](0009-buckets.md), [ADR 0010](0010-queue.md), [ADR 0012](0012-customer-mail.md) and [ADR 0014](0014-lambda-api.md) (the front doors it answers as); [ADR 0016](0016-sam-templates.md) (the template it reads); the spikes, [`hack/spikes/local-front-door`](../../hack/spikes/local-front-door/README.md) and [`hack/spikes/schedule-expressions`](../../hack/spikes/schedule-expressions/README.md) |

## Context

`ff local start` runs one function today, in its runtime container, at a local URL. An app on FF is more than one function. The small app has functions with URLs, a schedule, a queue, buckets with notifications and a site, mail, a database and a cache. A developer can only try it whole by deploying it. The plan's choice 5 named three ways to run it on a laptop:
1. inside `ff`, in Rust: one binary, one process;
2. the backend's own front doors in a small container, with `ff` running the functions;
3. the whole backend in Docker Compose, which is the on-premises edition's work, a plan of its own.

### The first two, measured

`hack/spikes/local-front-door/` built the first two for S3's `PutObject`, `GetObject` and `ListObjectsV2` and SQS's `SendMessage`, `ReceiveMessage` and `DeleteMessage`. The AWS CLI, AWS's SDK for JavaScript v3 and boto3 ran the same twelve checks against each side:

| | A port to Rust | The backend's front doors in Node.js |
|---|---|---|
| The clients' checks | 36 of 36 | 36 of 36 |
| Its lines | 2,315, with crates `ff` has | 6,565 of the backend's, from 16 of its folders, and 80 packages; 173 lines of stand-ins |
| Start to its ports open | 8 ms | 0.9 s, after its store's 3.9 s |
| Its memory | 4 MB | 199 MB, and its store's 178 MB |
| What a developer must have | `ff` | Node.js, 336 MB of `node_modules`, Docker, and SeaweedFS's image of 505 MB |

What else the spike found:
- **The backend's way still ports.** SQS's two guarantees, that a receive hides a message from the others and that only the last receive's handle deletes it, are in `CustomerQueues`' SQL. Without PostgreSQL, they had to be written again. The S3 front door is a proxy, so it needs a store beside it. And the two front doors load the backend's functions, billing, plans and eleven other folders through their imports.
- **The fixtures to share mostly don't exist yet.** Of the backend's 287 L1 tests for this code, 130 read a table that Rust can read too: the Signature V4 suite, the checksums' check values and AWS's aws-chunked examples (the last two moved into tables by the spike). The other 157 build their requests in TypeScript, against the classes.
- **FF already differs from S3 once.** S3 gives back the checksum a client sent in `PutObject`'s answer; the port did, the backend's front door doesn't. (M-06 fixed the backend first.)

`hack/spikes/schedule-expressions/` ported the backend's reader of EventBridge's schedules. The backend's tests now read a table of 47 cases, and so does the port. On 220,000 expressions made at random, the two readers gave the same runs and the same refusals.

## Decision

### 1. `ff local start template.yaml`, inside `ff`, in Rust

`ff local` reads the template with `ff deploy`'s reader and its refusals ([ADR 0016](0016-sam-templates.md)), then runs the app on the laptop in one process, as the plan's D3 lists:
- each function in its runtime container, as `ff local start` runs one today, started at its first call;
- its variables pointed at the local front door;
- its secrets from `--secrets .env.local`;
- schedules run on time, by the backend's reader ported;
- queues polled as the backend's poller polls them;
- bucket notifications;
- sites;
- a PostgreSQL and a Valkey when asked.

### 2. One front door on one port, in the protocols AWS's SDKs speak

Lambda's, SQS's, S3's and SES v2's operations that D3 lists, on `--port` (3700 by default), each answered as FF's front door answers it: the same refusals, in the same words. Functions' URLs are at `http://<function>.fn.localhost:<port>`, and sites at `http://<bucket>.site.localhost:<port>`. A signed request is checked against the local key, which `ff local` prints and writes to `.ff/local/credentials`. A request without a signature is taken, for `curl`.

### 3. Held to FF by tables that both sides read

Before porting an operation, M-05 and M-06 move its L1 tests' requests and answers into tables beside the backend's code, as the spikes did for the checksums and the schedules. The backend's specs read them, their counts unchanged, and `ff`'s tests read the same files. A case added on either side then fails on the other until both answer alike. Where the two differ from AWS, AWS's answer goes in the table and both sides are fixed: `PutObject`'s checksum is the first such case, in M-06.

Beside the tables, the AWS CLI's S3 and SQS cases of L4 run against `ff local` in the `ff` suite, and the small app runs on it end to end (M-07).

### 4. What it keeps, and where

- The queues' messages are kept in memory.
- Each bucket's objects are files under `.ff/local/buckets/<bucket>/`, with their headers beside them, so a developer can look at them.
- Mail goes under `.ff/local/mail/`.
- Each function's log goes under `.ff/local/logs/` and on stderr.
- The databases' data is kept in Docker volumes of the project's.

`ff local reset` empties all of it, with `--data` for the volumes.

### 5. What it leaves out

These are named in the guide's table:
- versions and aliases (an alias is a name for the function as it is);
- plans, limits and usage records;
- metrics and alarms;
- custom domains and TLS;
- the log store;
- gVisor;
- the account's internet switch;
- keys of several levels;
- FIFO queues;
- S3's versioning.

An operation outside it answers as FF answers one it doesn't offer, in the service's words.

### As built (M-05 to M-07)

The decision held as written. The plan's progress log has each part, its commit and its tests.

- **Its size.** `ff local` is `cli/src/local/`, about 16,200 lines of Rust, and `cli/src/commands/local_template.rs`, about 1,800, where it was 1,270 lines for one function. `cargo test` went from 536 tests to 693. No crate was added: MD5 is `cli/src/md5.rs`, from RFC 1321.
- **The tables.** Each operation's L1 tests were moved into a table before it was ported, each move a commit of its own, the backend's counts unchanged. `ff`'s tests read twelve: Lambda's `lambda-invoke-examples.json` and `function-url-examples.json`; the schedules' `schedule-expressions.json`; SQS's `sqs-examples.json` and `sqs-event-examples.json`; S3's `s3-examples.json`, `aws-chunked-examples.json`, `checksum-check-values.json`, `bucket-event-examples.json` and `website-examples.json`; SES's `send-email-examples.json`; and the signatures' `signature-v4-suite/cases.json`.
- **What the port found in the backend.** Four answers were wrong on FF, and each was fixed in the backend, its case added to the table: `PutObject` didn't give back the checksum the client sent, as S3 does; a site answered a condition that failed, or a range past the file, with a length and no body, so that a browser waited; a quiet `DeleteObjects` sent no events, as it read the deleted keys from an answer that names none in quiet mode; and a raw message naming a recipient that is no address was refused as "Illegal address: undefined", where the refusal now names the field.
- **The client suites.** The `ff` suite runs `ff local` in eight sections, 121 checks: `local` (one function, 13), `local_template` (31), `local_apps` (12), `local_queues` (18), `local_buckets` (20), `local_data` (8), `local_mail` (11) and `local_small_app` (8). The AWS CLI's cases of L4 pass against it: Lambda's `invoke`; SQS's `send-message`, `send-message-batch`, `receive-message`, `delete-message`, `get-queue-url`, `get-queue-attributes`, `list-queues` and `purge-queue`; S3's `cp`, `ls`, `sync` and `presign`, `mb` and `rb` refused in FF's words, and eight `s3api` reads; SES v2's `send-email`, simple and raw. The small app runs on it whole with AWS's SDK for JavaScript: an order through to its e-mail, its nightly removing an old order and its receipt.
- **Past D3's list.** S3 answers `ListObjects`, `UploadPartCopy`, `ListParts`, `ListMultipartUploads`, `ListBuckets` and `GetBucketLocation` too, and a read of a bucket setting FF's buckets don't have as S3 answers a bucket without it; SQS answers `ListQueues` and the batches of `DeleteMessage` and `ChangeMessageVisibility`. Three commands joined `ff local start`: `ff local run <schedule>`, a schedule run now; `ff local mail`, the mail kept; and `ff local reset --data`, the database's and the cache's volumes removed.
- **Where it differs from FF, on purpose.** A queue's event source mapping calls one batch at a time, as a function runs here in one container. The mail is checked as FF checks a request, but not as FF checks an account: any sender goes, and the operations on identities, the sandbox and the suppression list are refused, saying they are FF's. A request without a signature is taken, for `curl`. The guide's table lists the rest.

## Consequences

- A developer needs `ff` and, for the functions' containers and the databases, Docker. S3 and SQS need nothing more. The front door starts in milliseconds, offline, on Linux, macOS and Windows.
- `ff` grows. The spike's six operations took 2,315 lines; all of D3 takes several times that. It needs no new crate: `ring`, `base64`, `crc32fast` and `serde_json` are in `ff`, and MD5, which S3's ETags and SQS's checksums use and `ring` lacks, is written from RFC 1321, its suite its test.
- Drift, a local answer that differs from FF's, is the risk. The tables are what meet it, so moving the backend's tests into them is part of each operation's task: a refactor of the backend's specs, its own commit, the counts unchanged.
- The backend runs nothing new. Its specs read tables, and an answer it gets wrong, such as the missing checksum, is fixed in the backend too.

## Alternatives considered

- **The backend's front doors in a container:** measured above. It answers the clients alike, and loads code and packages far beyond the two front doors. It ports the queues' SQL anyway, and needs a store and Docker. It takes about 5 s and 380 MB where the port takes 8 ms and 4 MB. A change anywhere in 16 of the backend's folders could break it.
- **The whole backend in Docker Compose:** PostgreSQL, Keycloak, the store, the registry and a stand-in for Kubernetes on a laptop. That is the on-premises edition, a plan of its own.
- **An emulator of AWS made by others:** it answers as AWS does, not as FF does. FF's subset, its refusals and its words would differ, and no table of FF's would hold it to them.
