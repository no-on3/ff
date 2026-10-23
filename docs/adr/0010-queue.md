# ADR 0010: One queue in FF's database

| | |
|---|---|
| **Status** | Accepted: the [step-3 plan](../step-3-plan.md)'s D1, and its choices (its §9), confirmed by you on 2026-10-23; where its messages live, measured by Q-01's spike the same day |
| **Date** | 2026-10-23 |
| **Implementation** | Step-3 plan: decisions D1 to D5 and D9; tasks Q-02 to Q-07. As built so far: Q-02 (below) |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md): ADR-003 (the queue's backend), E-03, E-05, E-04's notifications, §4.6, §6.7; [What to build next](../what-to-build-next.md) §6; the spike, [`hack/spikes/queue`](../../hack/spikes/queue/README.md) |

## Context

Step 3 shows customers one queue three ways: a function called without waiting, as AWS Lambda's asynchronous invoke; queues that AWS's SDKs reach as Amazon SQS, read by functions in batches; and a function run when a file lands in a bucket. Each needs work kept until it is handled, retried when it fails, and never lost when a backend stops.

The parent plan's ADR-003 recommended pgmq, a queue made of PostgreSQL tables and functions, behind an SQS facade of FF's own, with NATS JetStream when throughput requires it. FF's own database is PostgreSQL 15 in development and CI, and may be a managed PostgreSQL in production, where an extension may not be allowed. You confirmed that the messages live in FF's own PostgreSQL, and that the spike chooses between pgmq and FF's own tables in its shape (the decision log, 24).

FF already runs durable, retried work this way: notification deliveries are rows that a worker claims `FOR UPDATE SKIP LOCKED`, each claim a lease, retried with backoff, written in the caller's transaction.

### Where the messages live, measured

`hack/spikes/queue/storage.sh`, on PostgreSQL 15.19 (`postgres:15.19-alpine3.24`, CI's), on this machine (8 CPUs, its load about 1.5 to 4.5 during the run):

| Measure | pgmq 1.13.0, as plain SQL | FF's own table in pgmq's shape |
|---|---|---|
| Installed | 349 ms, 76 functions in a schema of its own, no extension: its "SQL only" install, by the database's owner | a table and an index, by a migration |
| Sent one at a time, 4 senders, a transaction each (`SendMessage`) | 462 messages/s | 459 messages/s |
| Sent ten at a time (`SendMessageBatch`) | 3,758 messages/s | 4,981 messages/s |
| Claimed ten at a time with a visibility timeout and deleted, 4 consumers (`ReceiveMessage`, `DeleteMessage`) | 2,487 messages/s | 2,477 messages/s |
| Each of 20,000 messages to one consumer only | yes, none twice | yes, none twice |
| A consumer stopped between its claim and its delete | its 10 messages hidden meanwhile, then back once their timeout ended, received twice | the same |
| 200 queues made | 6.3 s; 1,400 relations more (a table and an archive per queue, their indexes and sequences) | nothing: a queue is a row elsewhere |
| A backup restored into another database | pgmq's schema with it, its functions working, a queue's message read there | the table and its rows |

Both claim alike: pgmq's `read()` is, in a dynamic statement on each queue's table, the claim FF's notifications make (`UPDATE … WHERE id IN (SELECT … ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED)`, the time it is next visible and its receive count set).

### SQS's protocol, measured

`hack/spikes/queue/sqs.sh`: a minimal SQS endpoint against AWS's SDK for JavaScript v3 (`@aws-sdk/client-sqs` 3.1156.0), boto3 1.43.118 and the AWS CLI 2.34.32, each given only the endpoint, the region and a key; 33 checks, 31 as wanted, the other 2 a finding:

- All three speak the JSON 1.0 protocol (`POST /`, `X-Amz-Target: AmazonSQS.<Operation>`, `application/x-amz-json-1.0`), signed with AWS Signature Version 4 for the service `sqs`; the AWS CLI takes its endpoint from `AWS_ENDPOINT_URL_SQS` alone.
- A queue's URL under the endpoint and the account (`<endpoint>/<account>/<name>`) works for all three.
- Long polling as SQS: an empty queue answered after its wait (2.0 s); a message sent during the wait ended it at once (about 0.5 s).
- **The SDK for JavaScript checks the MD5 sum SQS answers of a message's body,** on sending and on receiving, and refuses a wrong one (`InvalidChecksumError`, "Invalid MD5 checksum on messages"); boto3 checks neither. The spike's wrong sums were the body's and the attributes' together; its middleware, read in Q-04, checks the body's alone. FF computes both exactly, the attributes' as SQS's documentation defines it, for the clients that check it.
- **Errors carry two names:** the body's `__type` (`com.amazonaws.sqs#QueueDoesNotExist`), which the SDK for JavaScript names the error by, and the `x-amzn-query-error` header (`AWS.SimpleQueueService.NonExistentQueue;Sender`), which boto3 and the AWS CLI show, as SQS's older protocol did. FF answers both.

## Decision

### 1. One table for every queue's messages, in FF's database

FF keeps its queues' messages in a table of its own, `queue_messages`, in pgmq's shape: an ID, the message, when it is next visible, how many times it was received, when it was sent, when it expires. Not pgmq:
- **The same throughput,** measured, and the same claim.
- **No table made while FF runs:** pgmq makes 7 relations a queue, at about 32 ms each, so tens of thousands of tables for thousands of accounts' queues and functions' events; FF's table is one, made by a migration.
- **FF's migrations and their check cover it:** pgmq's schema would come from its own SQL file, upgraded by its own scripts, outside what `migration:check` proves.
- **Nothing to install** on a managed PostgreSQL, and partitioning, if ever needed, without pg_partman.

pgmq stays a way to give one hot queue a table of its own later, as NATS JetStream stays the way past what PostgreSQL carries (ADR-003).

### 2. Claimed with leases, at least once

A consumer claims a batch, `FOR UPDATE SKIP LOCKED`, which hides it for its visibility timeout and counts the receive; deleting a message is the handling's last step. A consumer that stops leaves its messages to come back when their leases end. Every backend may consume, the claims keeping them apart. Each message carries how many times it was received and how many of those were settled, so that a claim with no outcome, a backend stopped during the call, counts as one (the decision log, 32).

### 3. A function's asynchronous events in a queue of its own

Each function's waiting asynchronous calls are messages of a queue of the kind `function`, made at its first asynchronous call, which no customer lists and which goes with the function. Their size counts against the account's messages, as the plan's limit says (the decision log, 28).

### 4. A retried call keeps its request ID

Lambda calls a retried event with the same request ID. FF does too: each attempt is a row of the invocation history, with its attempt number, under the event's request ID; the usage record is keyed by that ID and the attempt's start, as it already is.

### 5. SQS's protocol as measured

The SQS endpoint (Q-04) speaks the JSON 1.0 protocol, answers both error names, and both MD5 sums exactly, a queue's URL under its endpoint and the account.

### As built (Q-02)

- **The tables,** by the migration `AsyncInvoke`: `queues`, a customer's by its name in the account or a function's own by the function, which it goes with; `queue_messages`, as decision 1 says, with a partial index on when it is next visible for functions' calls, so that their worker never reads customers' queues. Each queue keeps what its messages hold together, a trigger adding and taking each message's size as it is written and deleted: the plan's limit reads the account's few queues, not its messages.
- **The claim** (decision 2): one `UPDATE` of the messages a `SELECT … ORDER BY visible_at LIMIT n FOR UPDATE SKIP LOCKED` picks, counting the receive and setting the lease; what the claim does afterwards, delete the message or put it back for later, is guarded by the receive count it saw, so that a backend whose lease ended changes nothing. An asynchronous call's lease is the longest its attempt can take: twice its function's timeout, a cold start, and a minute.
- **A function's events** (decision 3): kept under their request ID, the call's own; what a call's attempts were (its failures, throttles, and the claims that kept an outcome) beside the event. A claim that kept none was lost with its backend, and counts as a failed attempt at the next claim (the decision log, 32).
- **The request ID** (decision 4): the history's `request_id`, the first attempt's row being the request's own ID as every call's was, a retry a row of its own; a row that names no request is its own, by a trigger, as every call before.

### As built (Q-04, part 1)

- **The endpoint** (decision 5): a server of the backend's own, on `FF_SQS_PORT` (3003) at `FF_SQS_BASE`, beside the S3 front door: `POST /` with `X-Amz-Target: AmazonSQS.<Operation>`, its body read whole, 3 MiB at most, and signed with Signature Version 4 for `sqs`, the body's SHA-256 signed; a session token is refused, as FF never issues one. The keys are step 2's, `AKFF…`: each reaches every queue of its account, a read-only one the operations IAM lists as reads (`GetQueueUrl`, `GetQueueAttributes`, `ListQueues`, `ReceiveMessage`). Each key is checked as at the S3 front door: its account active, its databases, buckets and queues on, the plan's queue requests a second; sending needs credit, receiving and deleting don't. Each answer carries its request ID, `x-amzn-RequestId`, and each error both its names.
- **Queues** (the migration `CustomerQueues`): SQS's five numbers, with SQS's defaults, as columns the database checks too, and the redrive policy; made within the plan's queues, counted under the account's lock; made again with the same attributes, the same queue, as `CreateQueue` answers, else `QueueNameExists`. Another account's queue, by its URL or its name, is one that doesn't exist.
- **Messages:** each with its attributes and its sender beside its body, its size counted as SQS counts it (the body, and each attribute's name, type and value) against the queue's maximum and the plan's storage, functions' waiting calls included. A receipt handle names one receive, by the message's row and its receive count: an older one deletes nothing and changes no visibility.
- **Long polling:** a trigger NOTIFYs `ff_queue` with the queue's ID for each message written, or moved, as the ledger's writes are told; a long poll waits for its queue's news on the backend's one listening connection, and asks the database again every second at most, for delays that end and visibility timeouts that expire. Measured in L2: a message sent during a wait answers it within milliseconds, against 700 ms without the NOTIFY.
- **Dead-letter queues:** a message received as often as its queue's `maxReceiveCount` moves to the dead-letter queue as it would be received again, its receive count back to none, kept for that queue's retention from when it was first sent, as SQS keeps a message's first enqueue time; its size moves with it, the size trigger following a message's move now.
- **Retention:** a message past it is never received, and the retention job deletes it with functions' expired calls.

## Consequences

- One more append-and-delete table in FF's database, its size bounded by the plans' limits on messages (the decision log, 28); the operator's database alerts and backups cover it, its point-in-time recovery possibly redelivering what was handled in the last minutes.
- Queue throughput is FF's database's: about 2,500 messages a second claimed and deleted here, far past a beta's needs; past that, a queue of its own in pgmq or NATS JetStream.
- The history's rows gain a request ID apart from their own ID, the same for every attempt of an event.

## Alternatives considered

- **pgmq, as plain SQL:** measured, its throughput the same; set aside for its table per queue and its schema outside FF's migrations (decision 1). Kept for later, for one queue.
- **NATS JetStream now:** a system more to run and back up, with no need for its throughput yet (ADR-003, and the decision log, 24).
- **A table per queue of FF's own:** pgmq's catalog cost without its tested code.
- **Redis:** not durable enough by default, and one more system.
