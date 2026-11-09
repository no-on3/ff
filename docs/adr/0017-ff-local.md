# ADR 0017: The whole app on a laptop, `ff local` in Rust inside `ff`

| | |
|---|---|
| **Status** | Accepted: the [developer tools plan](../dev-tools-plan.md)'s D3 and its choices 5 and 6, confirmed on 2026-11-08 (the [decision log](../decisions.md)'s 74 and 75); the shape measured by M-01's spikes the same day |
| **Date** | 2026-11-09 |
| **Implementation** | Developer tools plan: decision D3; tasks M-05 (functions, URLs, schedules and Lambda's invoke), M-06 (queues and buckets) and M-07 (databases, caches, mail, and the small app end to end), whose part 4 records here what was built |
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

## Consequences

- A developer needs `ff` and, for the functions' containers and the databases, Docker. S3 and SQS need nothing more. The front door starts in milliseconds, offline, on Linux, macOS and Windows.
- `ff` grows. The spike's six operations took 2,315 lines; all of D3 takes several times that. It needs no new crate: `ring`, `base64`, `crc32fast` and `serde_json` are in `ff`, and MD5, which S3's ETags and SQS's checksums use and `ring` lacks, is written from RFC 1321, its suite its test.
- Drift, a local answer that differs from FF's, is the risk. The tables are what meet it, so moving the backend's tests into them is part of each operation's task: a refactor of the backend's specs, its own commit, the counts unchanged.
- The backend runs nothing new. Its specs read tables, and an answer it gets wrong, such as the missing checksum, is fixed in the backend too.

## Alternatives considered

- **The backend's front doors in a container:** measured above. It answers the clients alike, and loads code and packages far beyond the two front doors. It ports the queues' SQL anyway, and needs a store and Docker. It takes about 5 s and 380 MB where the port takes 8 ms and 4 MB. A change anywhere in 16 of the backend's folders could break it.
- **The whole backend in Docker Compose:** PostgreSQL, Keycloak, the store, the registry and a stand-in for Kubernetes on a laptop. That is the on-premises edition, a plan of its own.
- **An emulator of AWS made by others:** it answers as AWS does, not as FF does. FF's subset, its refusals and its words would differ, and no table of FF's would hold it to them.
