# Step 3 plan: background work, where the queue fits

| | |
|---|---|
| **Status** | Proposed on 2026-10-23 with step 2's close (the [step-2 plan](step-2-plan.md), V-10), checked against the code the same day by a read-only survey (§1), and **confirmed by you the same day** with every choice of §9 as it recommended (the [decision log](decisions.md), 24 to 33). **Started on 2026-10-23,** on the branch `feat/step-3`, made from `master` (`f772e7f`, step 2's merge); its first commit renamed the object store's settings, which still carried MinIO's name (the decision log, 23). What is done is in the progress log (§11). |
| **Goal** | Step 3 of [What to build next](what-to-build-next.md) (§6): one queue that keeps its messages until they are handled, shown to customers three ways, each in AWS's shape: a function called without waiting, as AWS Lambda's asynchronous invoke; queues that AWS's SDKs and CLI reach as Amazon SQS, read by functions in batches; and a function run when a file lands in a bucket, with S3's event |
| **Parent plans** | [What to build next](what-to-build-next.md) §6 and §10; the [local markets and AWS portability plan](local-markets-and-aws-portability-plan.md): E-03 (asynchronous invoke), E-05 (FF Queues, the SQS JSON protocol, event source mappings), E-04's notifications, §4.6 (event sources), §4.7 and ADR-003 (the queue's storage), §6.7 (SQS), §8.1 (queue requests by the million, in 64 KB chunks) |
| **Builds on** | The [step-2 plan](step-2-plan.md): the S3 front door, its keys and functions' own keys, the hourly rating beyond functions, buckets' metrics and alarms; the [step-1 plan](step-1-plan.md): schedules, the event shapes, function URLs; the [client-readiness plan](client-readiness-plan.md): plans, usage records, the price book, notifications |
| **Decision records** | ADR 0010 (the queue: where its messages live, how they are claimed, what a backend's failure does), from Q-01's spike |

Task numbers start with Q, for *queue*. The CLI plan keeps its own numbers: its C-52 (`ff invoke --async`, `ff queues`, `ff event-sources`) and C-53's `ff buckets notify` are this plan's command-line parts.

## 1. Where FF stands

Checked against the code on 2026-10-23, at the end of step 2 (`feat/step-2`).

| Finding | Where | Consequence |
|---|---|---|
| **Every call waits for its answer.** `POST /functions/:id/invoke` answers 201 with the result; there is no `InvocationType`, no `202`, no `--async`. One path, `call()`, serves the API, the URL gateway and the scheduler: a RUNNING row, the orchestrator's call, then COMPLETED, ERROR, TIMEOUT or THROTTLED, and the usage record, written once. | `BE/src/functions/functions.service.ts` (`invoke()`, `call()`, `finish()`); `cli/src/cli.rs` (`InvokeArgs`) | Asynchronous calls go through the same `call()`, with a source of their own; nothing about a call's record or its bill changes. |
| **A failed scheduled run isn't retried.** The scheduler claims due schedules `FOR UPDATE SKIP LOCKED`, moves each to its next run, commits, then calls; a backend that stops between the two loses that run. | `BE/src/schedules/scheduler.service.ts`; the decision log, 19 | Schedules become asynchronous calls (D3), so that a failed run is retried, as EventBridge's runs are, and a stopped backend loses none. |
| **The backend already runs durable, retried work.** Notification deliveries are rows claimed `FOR UPDATE SKIP LOCKED`, each claim a lease of 5 minutes, retried after 1, 2, 4, 8 and 16 minutes, written in the caller's transaction, like an outbox. Hourly work holds PostgreSQL's advisory locks. | `BE/src/notifications/notification-worker.service.ts`, `retry.ts`, `notifications.service.ts`; `BE/src/billing/hourly-rating.service.ts` | The queue's consumer follows the same pattern, which works with several backends (D1). |
| **FF's own database is PostgreSQL 15,** or a managed one in production; no migration installs an extension; pgmq is in the docs only. | `docker-compose.yml`; `deploy/backup/postgres-walg/Dockerfile`; `deploy/backup/README.md`; `BE/src/migrations/` | Whether pgmq can be used without an extension a managed PostgreSQL may refuse is Q-01's first question (D1). |
| **The S3 front door sees every write's end:** its operation, bucket, status and bytes, in one place, where it counts requests today. | `BE/src/storage/front-door.ts` (`serve()`); `BE/src/storage/s3-requests.ts` | Bucket notifications are made there (D6). |
| **Functions' keys exist, for S3 only:** each function's own key, with `AWS_ENDPOINT_URL_S3`, the region, in its environment; the account's two keys reach buckets. | `BE/src/storage/function-keys.service.ts`; `BE/src/functions/environment.ts` (reserved names) | The same keys reach queues (D4), and functions get `AWS_ENDPOINT_URL_SQS` too. |
| **The rating knows resources beyond functions:** `resource_usage_hourly` with the kinds `database` and `bucket`, requests by S3's classes from counts written each minute; optional SKUs in the price book, priced 0 in older books. | `BE/src/billing/hourly-rating.service.ts`, `resource-usage-hourly.entity.ts`, `price-book.ts` | Queue requests fit the same way: a count by the minute, a kind `queue`, a SKU per million (D7). |
| **The rate limiter counts in memory,** with one backend replica. | `BE/src/plans/rate-limits.ts`; `deploy/k8s/platform/10-backend.yaml` | The queue's limits hold with one replica as the others do; several replicas need the shared counter that every limit needs (§8). |

## 2. Goals and non-goals

**Goals:**
- **AWS's shapes:** an asynchronous call answers `202` with its request ID, as Lambda's does, and is retried as Lambda retries; queues speak Amazon SQS's JSON protocol, so that `new SQSClient({})`, boto3 and the AWS CLI work with only the endpoint changed, and a function's code with nothing changed; a function reads a queue with SQS's event and reports partial batch failures as on Lambda; a file landing in a bucket gives S3's event.
- **At least once, never silently lost:** every accepted call or message is kept until it is handled, expires as AWS lets it, or goes to a dead-letter queue or a destination; a backend's failure delays work, never loses it (D1).
- **Isolation proven:** queues and their messages per account; keys reach only their account's queues; every new route in the L5 suite; the SQS endpoint checked as the S3 front door is.
- **Metered and billed as AWS bills:** SQS requests by the million, each 64 KB of a message a request, with SQS's free tier; asynchronous calls billed as any call.
- **Everything every new service needs** (What to build next §10): limits, price, console pages and routes with the isolation test, the admin app, metrics and alarms as CloudWatch names them, documentation in English and French, a way out.

**Non-goals (for now):**
- **FIFO queues** (later, the roadmap says), SNS topics, EventBridge buses and rules beyond schedules, Step Functions.
- **Kinesis and DynamoDB streams** as event sources; Kafka (MSK) and MQ event source mappings.
- **NATS JetStream:** ADR-003's next step, when throughput requires it (§8).
- **The Lambda API itself** (`Invoke` by SigV4, `CreateEventSourceMapping`, `PutFunctionEventInvokeConfig` at AWS's paths): the parent's E-06, with step 5. FF's own API and `ff` give the same settings in step 3.
- **Bucket notifications to anything but a function or a queue.**

## 3. Decisions

ADR 0010 will record D1, D2 and D5 as Q-01's spike measures them; where the spike changes a decision, the decision below will say so.

### D1. One queue in FF's database, claimed with leases
- **Where messages live:** in FF's own PostgreSQL, so that they are backed up with it (point-in-time recovery to the second site) and written in the same transaction as what makes them, as notifications are. Two ways, which Q-01 compares on FF's PostgreSQL 15 and on a managed provider's: **pgmq** (the parent plan's ADR-003: a queue per table, visibility timeouts, archive), if it installs as plain SQL where an extension can't be; or **FF's own tables in pgmq's shape** (a message's ID, its body, when it is next visible, how many times it was read, when it was sent), claimed `FOR UPDATE SKIP LOCKED` as notifications are. Recommendation in §9, 1. **As measured (Q-01): FF's own table,** [ADR 0010](adr/0010-queue.md): pgmq installs as plain SQL and claims as fast (about 2,500 messages a second, here), but makes 7 relations for each queue while FF runs, outside FF's migrations; one table, made by a migration, does the same.
- **How a message is handled:** a consumer claims a batch, which hides it for its visibility timeout (a lease); deleting it is the handling's last step. A consumer that stops leaves its messages to reappear when their leases end: at least once, never lost.
- **Who consumes:** every backend, the claims keeping them apart; in production, one replica today.

### D2. Asynchronous invoke, as AWS Lambda's
- `POST /functions/:id/invoke` with `X-Amz-Invocation-Type: Event` (or `invocationType: "Event"`) checks what a call checks (the function, the payload's size, credit, the plan's rate), keeps the event, and answers `202` with its request ID, as Lambda does; `ff invoke --async`. The payload limit is Lambda's for asynchronous calls, checked against AWS's documentation when built.
- A worker calls the function through `call()`, source `async`. On an error or a timeout it retries twice, a minute then two minutes later, as Lambda does; throttled calls are retried with backoff until the event's age is up. Each function's settings, as Lambda's `EventInvokeConfig`: retries 0 to 2, maximum event age 60 seconds to 6 hours, both Lambda's defaults (2, 6 hours).
- **Where an event ends:** on success or on failure, a destination of the account's: a queue (D4) or another function, with Lambda's destination record (`requestContext`, `requestPayload`, `responseContext`, `responsePayload`); without one, a failed event is kept in the history and counted, as Lambda counts dropped events.
- A call marked LOST because the backend stopped is retried: nobody waits for it (§9, 9).
- Each attempt is a call in the history, with its attempt number; the request ID stays the same across attempts, as Lambda's does.

### D3. Schedules call their function asynchronously
- A scheduled run is an asynchronous call: retried as D2 says, kept if the backend stops, as EventBridge Scheduler's runs go to Lambda. The schedule's last outcome is its last attempt's. Confirmed on 2026-10-22 (the roadmap, the decision log's 19).

### D4. Queues with Amazon SQS's API
- **The protocol:** SQS's JSON 1.0 protocol, which AWS's current SDKs use (`X-Amz-Target: AmazonSQS.<Operation>`), on a port of the backend's own beside the S3 front door's, at `https://sqs.<domain>`, signed with AWS Signature Version 4 for the service `sqs`, checked with the code the S3 front door already uses. The queue's URL and ARN in AWS's forms, with the region `tn-tunis-1` and the account's 12 digits.
- **Operations:** `CreateQueue`, `GetQueueUrl`, `GetQueueAttributes`, `SetQueueAttributes`, `ListQueues`, `DeleteQueue`, `PurgeQueue`, `SendMessage(Batch)`, `ReceiveMessage` with long polling, `DeleteMessage(Batch)`, `ChangeMessageVisibility(Batch)`; anything else answers SQS's unsupported-operation error. Standard queues: at least once, best-effort order.
- **Attributes,** with SQS's defaults and ranges: visibility timeout (30 seconds; up to 12 hours), retention (4 days; 1 minute to 14 days), delivery delay (up to 15 minutes), receive wait (up to 20 seconds), the maximum message size SQS allows, and a redrive policy: after a number of receives, a message goes to the queue's dead-letter queue, as SQS's `maxReceiveCount`.
- **Keys:** the account's keys (step 2's, `AKFF…`) reach queues too, all of them or those named, read-write or read-only; a function's own key reaches its account's queues, and functions get `AWS_ENDPOINT_URL_SQS`. One kind of key, as IAM's access keys reach every service (§9, 2).
- Also in FF's API (`/queues`), the console and `ff queues`, with sending and receiving for debugging, as the CLI plan's C-52 lists.

### D5. Functions read queues: event source mappings
- A function is given a queue (`ff event-sources add <queue> <function>`): FF reads it in batches (batch size 1 to 10 by default, up to Lambda's limits with a batching window of up to 300 seconds) and calls the function with SQS's event (`Records[]`, each with `messageId`, `receiptHandle`, `body`, `attributes`, `messageAttributes`, `md5OfBody`, `eventSource: "aws:sqs"`, the queue's ARN).
- A batch that succeeds is deleted; one that fails comes back after the visibility timeout. With `ReportBatchItemFailures`, the function's `batchItemFailures` returns only those messages, as on Lambda. A message received too many times goes to the queue's dead-letter queue (D4).
- How many batches at once: the mapping's maximum concurrency, as Lambda's (2 to 1,000), within the function's `maxInstances` and the plan's.

### D6. Bucket notifications, from the S3 front door
- A bucket's notification configuration as S3 takes it (`PutBucketNotificationConfiguration`, `GetBucketNotificationConfiguration`), with `LambdaFunctionConfigurations` and `QueueConfigurations`, events `s3:ObjectCreated:*` and `s3:ObjectRemoved:*` and their kinds, and prefix and suffix filters; also `ff buckets notify <bucket> <function> [--prefix] [--suffix]` and the console's bucket page.
- When a write the configuration names ends well, the front door queues S3's event (`Records[]` with `eventName`, the bucket, the object's key, URL-encoded as S3 does, its size, ETag and a sequencer): a function's is an asynchronous call (D2), as S3 calls Lambda; a queue's is a message.
- An event is written after the store answered: a backend that stops between the two loses that event. S3 promises at least once, usually within seconds; FF's ADR 0010 says how close it comes, and the docs say it plainly (§8).

### D7. Usage and billing
- **Queue requests,** counted by the minute as buckets' are: each SQS API request, each 64 KB of a message's payload a request, as SQS counts; billed by the million at SQS's standard price, with SQS's free tier, 1 million requests a month (§9, 4). The messages FF delivers to functions count as the requests that would have received them, one per batch; FF's empty reads don't (§9, 4).
- **Asynchronous calls** are billed as any call; keeping their events isn't billed, as on Lambda.
- The statement, `GET /usage`, its CSV, the console's Usage page and `ff usage` show each queue's month; the reconciliation knows the new kind.

### D8. Plans: new limits
- Queues per account (10 on beta), event source mappings per function (5), SQS requests a second (the plan's S3 rate, 100 on beta), and what an account's messages hold together, waiting events of asynchronous calls included (100 MB on beta), so that FF's database is protected from one customer's backlog (§9, 5). Past it, `SendMessage` and asynchronous calls are refused, as SQS refuses over its limits, until messages are handled or expire.

### D9. Every way in is checked the same way
- As step 2's D11: the account active and its storage on, the plan's rate, credit to send (reading and deleting go on without), a key reaching that queue; the SQS endpoint answers SQS's errors (`AccessDenied`, `InvalidClientTokenId`, `QueueDoesNotExist`, `RequestThrottled`).

### D10. Suspension, credit and closure
- A suspended account's queues and mappings stop delivering, its keys are refused, its messages kept until their retention ends, as its files are kept; credit as D9. A closed account's queues go with its data, at its data deletion date; its pending events with them.

### D11. Metrics and alarms
- A queue's, as CloudWatch names SQS's: `ApproximateNumberOfMessagesVisible`, `ApproximateNumberOfMessagesNotVisible`, `ApproximateAgeOfOldestMessage`, `NumberOfMessagesSent`, `NumberOfMessagesReceived`, `NumberOfMessagesDeleted`, `NumberOfEmptyReceives`, `SentMessageSize`. A function's asynchronous calls, as Lambda's: `AsyncEventsReceived`, `AsyncEventAge`, `AsyncEventsDropped`, `DestinationDeliveryFailures`. Alarms on them, as on functions', databases' and buckets'.

### D12. Backups and the way out
- Messages are in FF's database, so its point-in-time recovery covers them: a restore can redeliver what was handled since, or lose the last minutes, as the database's recovery point says (15 minutes at most).
- The export kit writes the queues as `AWS::SQS::Queue`, the mappings as `AWS::Lambda::EventSourceMapping`, a function's settings as `AWS::Lambda::EventInvokeConfig`, a bucket's notifications in its `NotificationConfiguration`; messages waiting are handled before the move, not copied. The page in French says how.

## 4. Data model

Q-01 settles D1's storage; with FF's own tables, they are these. Every table carries `account_id`.

| Table | What it holds |
|---|---|
| `queues` | `id`, `account_id`, `name` (unique per account, SQS's rule), its attributes (visibility timeout, retention, delay, receive wait, maximum size), `dead_letter_queue_id` and `max_receive_count`, `kind` (`customer`, or `function` for a function's asynchronous events, which no customer lists), `created_at` |
| `queue_messages` | `id` (bigint), `queue_id`, `account_id`, `message_id` (SQS's, a UUID), `body`, `attributes`, `sent_at`, `visible_at`, `receive_count`, `first_received_at`, `receipt` (the last receipt handle's secret part), `expires_at`; claimed `FOR UPDATE SKIP LOCKED`, deleted when handled |
| `event_invoke_configs` | `function_id`, `max_retry_attempts`, `max_event_age_seconds`, `on_success`, `on_failure` (a queue's or a function's ARN) |
| `event_source_mappings` | `id` (a UUID, as Lambda's), `function_id`, `queue_id`, `batch_size`, `batching_window_seconds`, `report_batch_item_failures`, `maximum_concurrency`, `enabled`, `state` |
| `bucket_notifications` | `bucket_id`, its configuration as S3 takes it: each function's and queue's events and filters |
| `queue_request_counts` | per queue, minute and writer, as `storage_request_counts`: requests, messages sent, received and deleted, bytes; append-only, a partition per month |

`function_invocations` gains the source `async` and an attempt number; `usage_records` is unchanged.

## 5. API changes

| Route | What it does |
|---|---|
| `POST /functions/:id/invoke` | With `X-Amz-Invocation-Type: Event`: `202` and the request ID, the event kept (D2) |
| `GET`, `PUT`, `DELETE /functions/:id/event-invoke-config` | Retries, maximum event age, destinations (D2) |
| `GET`, `POST /queues`; `GET`, `PATCH`, `DELETE /queues/:name`; `POST /queues/:name/purge` | Queues in FF's API, beside SQS's (D4) |
| `GET /queues/:name/metrics` | D11's metrics, as `/buckets/:name/metrics` gives buckets' |
| `GET`, `POST /functions/:id/event-sources`; `PATCH`, `DELETE /event-sources/:id` | Event source mappings (D5) |
| `GET`, `PUT /buckets/:name/notifications` | A bucket's notifications in FF's API, beside S3's (D6) |
| The SQS endpoint | SQS's JSON protocol, on a port of its own (D4) |

Scopes `queues:read` and `queues:write`; the audit log names `queue.*`, `event_source.*`, `event_invoke_config.*` and `bucket.notifications`; each route in both of L5's loops.

## 6. Working rules

The step-2 plan's (§6 there), on a branch of this step's own: `type(scope): summary (Q-xx)`, one commit per task or part of a task, `hack/check-resources.sh` before each heavy step and one heavy operation at a time, the task's tests and the backend's type-check, lint and unit tests on each commit, progress rows with their tests and documents, `hack/check-docs.py` on what changed, and no task or decision number in the code, its comments or its tests.

## 7. Tasks

### Phase 0: groundwork

#### Q-00: The plan and the baseline
- This plan, confirmed; the baseline's test counts; the branch.
- **Done when:** §9's answers are in the decision log and this plan says so.

#### Q-01: Spike and ADR 0010
- **The queue's storage:** pgmq installed as plain SQL on FF's PostgreSQL 15 and on a managed provider's, against FF's own tables in pgmq's shape: sending, claiming with a visibility timeout and deleting at the rates a beta needs (thousands of messages a second at most), with several consumers, a consumer killed mid-batch, and a backup restored.
- **SQS's protocol:** a minimal endpoint, against AWS's SDK for JavaScript v3, boto3 and the AWS CLI: SigV4 for `sqs`, the JSON protocol, long polling, batches, the errors as each SDK reads them.
- **Done when:** ADR 0010 records what was measured and decided, and §9's questions have their facts.

### Phase 1: calls without waiting

#### Q-02: The queue and asynchronous invoke
- D1's queue and its consumer; D2's `202`, the worker, the history's source and attempts, the retries and the maximum age; `ff invoke --async`; L1, L2 (claims, leases, a consumer stopped), L4 (an event retried twice, then dropped; one past its age), L5.

#### Q-03: Destinations, and schedules through the queue
- `event-invoke-config`, the destinations (D2), schedules as asynchronous calls (D3); L2, L4.

### Phase 2: queues

#### Q-04: The SQS endpoint
- D4's protocol, operations and attributes, keys reaching queues, `AWS_ENDPOINT_URL_SQS` in functions' environment, D9's checks; L1, L2, L4 with the three SDKs and the CLI, L5 with another account's key.

#### Q-05: Queues in the API, the console, the admin app and `ff`
- `/queues`, the console's Queues page (made of the console's pieces), the admin app's account page, `ff queues`; D8's limits; L3.

#### Q-06: Event source mappings
- D5: batches, the batching window, partial batch failures, the dead-letter queue, maximum concurrency; `ff event-sources`; L4 with a function that fails some messages of a batch.

### Phase 3: notifications, metering, tools

#### Q-07: Bucket notifications
- D6 through the S3 front door and FF's API, `ff buckets notify`; L4: a file uploaded with the AWS CLI runs a function with S3's event, and puts a message in a queue.

#### Q-08: Metering, billing, metrics and alarms
- D7's counts, the rating's new kind, the SKU and its free tier, the statement, `GET /usage`, the console's Usage page, `ff usage`; D11's metrics and alarms; L1 for the request chunks, L2, L4 for a queue's month on the statement.

#### Q-09: Documentation
- The guide's "Background work", `how-it-works.html`'s scenarios (an asynchronous call retried, a queue read by a function, a file that runs a function), a page in French "comme AWS SQS", the export kit's part (D12), ADR 0010 as built.

### Phase 4: close

#### Q-10: The step closed
- The small app makes each order's receipt in the background: `POST /orders` puts a message in a queue, which a function reads to write the receipt; the nightly report runs as an asynchronous call. `how-it-works.html` and the guide walk through it, `hack/cli-e2e.sh` runs it.
- [What to build next](what-to-build-next.md) marks step 3 done, and step 4 gets its plan.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A customer's backlog fills FF's database | D8's limit on what an account's messages hold; retention as SQS's; the operator's disk alert; the move to NATS JetStream (ADR-003) when throughput requires it |
| Duplicates: at least once means a message or an event can come twice | As on AWS: the request ID and message ID stay the same across deliveries, and the docs say to handle them idempotently |
| Retries multiply load on a failing function | Lambda's backoff and maximum age (D2); the plan's rate and the function's `maxInstances`; the dead-letter queue |
| A poison message loops forever | The redrive policy (D4) and `maxReceiveCount`; the metrics show its receives |
| A notification lost when the backend stops after the store answered | Measured in Q-01; said plainly in the docs; a sweep of the store's listing later if it matters |
| The limiter counts in memory, with one replica | As every limit today; several replicas need a shared counter (PostgreSQL or Redis), which this step doesn't add |
| SQS's protocol as an SDK reads it (a new default, an error's shape) | Q-01's spike against three SDKs and the CLI; L4 with each, run when their versions change |
| A queue's consumer holds a backend's time | Bounded batches and concurrency per mapping (D5); its own process later if needed, as the URL gateway can |

## 9. Choices made for you to confirm

**You confirmed them all on 2026-10-23,** as recommended (the [decision log](decisions.md), 24 to 33). Each row says what this plan chose and why, and what the other way would have been.

| Question | This plan's choice | Affects |
|---|---|---|
| 1. Where messages live | In FF's own PostgreSQL either way (backed up with it, written in the same transaction as what makes them). Recommended: let Q-01's spike pick between pgmq, if it installs as plain SQL where an extension can't be, and FF's own tables in pgmq's shape, which need nothing new; the other way, NATS JetStream now, one more system to run | Q-01, Q-02 |
| 2. Keys for queues | Recommended: the account's keys from step 2 reach queues too, all or those named, and functions' own keys reach their account's queues: one kind of key, as IAM's; the other way, separate keys per service | Q-04 |
| 3. The SQS endpoint | Recommended: a port of the backend's own, beside the S3 front door's, at `sqs.<domain>` in production; the other way, a service of its own from the start | Q-04 |
| 4. Billing queue requests | Recommended: as SQS bills, by the million, each 64 KB of a message a request, 1 million free each month; the messages FF delivers to functions counted as one request a batch, FF's empty reads not counted (AWS counts its pollers' empty reads); the other way, every read, as AWS | Q-08 |
| 5. Limits on beta | Recommended: 10 queues, 5 mappings a function, 100 requests a second, 100 MB of messages and waiting events per account; the other way, no storage limit beyond retention | Q-05 |
| 6. FIFO queues | Recommended: later, once a customer asks (the roadmap says so); standard queues first | Q-04 |
| 7. Where notifications go | Recommended: to a function (an asynchronous call) or a queue; SNS and EventBridge later, with those services | Q-07 |
| 8. Destinations | Recommended: a queue or a function, on success and on failure, as Lambda's; SNS, EventBridge and S3 later | Q-03 |
| 9. A call lost when the backend stops | Recommended: an asynchronous call marked LOST is retried, as an attempt, since nobody waits for it; a synchronous one stays LOST, as today | Q-02 |
| 10. The language of the new docs | Recommended: the guide in English, a page in French "comme AWS SQS", as for databases and buckets | Q-09 |

## 10. Effort (rough estimates, one developer)

| Task | Working days | Notes |
|---|---|---|
| Q-00 | 0.5 | |
| Q-01 | 3–4 | Two spikes, one ADR |
| Q-02 | 4–5 | The queue's consumer and the retries are most of it |
| Q-03 | 2–3 | |
| Q-04 | 5–6 | SQS's protocol and its errors, as the S3 front door was for S3 |
| Q-05 | 3–4 | Three interfaces |
| Q-06 | 3–4 | |
| Q-07 | 2–3 | |
| Q-08 | 3–4 | |
| Q-09 | 2 | |
| Q-10 | 1–2 | |
| **Total** | **29–38** | The roadmap's 6.5 weeks plus what every service needs (its §10): the bill, the admin app, the way out |

## 11. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| Q-00 The plan and the baseline | ✅ Done | this commit | • **The plan,** proposed with step 2's close (`5196b28`), confirmed by you on 2026-10-23 with every choice of §9 as it recommended (the [decision log](decisions.md), 24 to 33), and started the same day on `feat/step-3`, made from `master` at step 2's merge (`f772e7f`).<br>• **Before it, on the branch:** the object store's settings named for what it is, any S3-compatible store, MinIO's names refused at boot naming the new ones (`da318c7`, the decision log's 23); and a race in FF's direct calls fixed, a function's Service refusing a call for a moment after its pod becomes ready (`2dc03ad`).<br>• **The baseline,** this branch at `2dc03ad`: L1 121 suites / 1,771 tests; L2 40 suites / 402 tests, `migration:check` over 40 migrations; L3 158 checks; L4 277; L5 741; the platform's manifests 19 checks, its images 27, its end-to-end suite 41; `hack/ci.sh static` (lint, types and builds of the backend, the console and the admin app, the runtime's build, `ff`'s formatting and clippy, the docs, every shell script); the console 24 files / 327 tests; the admin app 17 files / 134 tests; the CLI 211 tests in 14 binaries.<br>• **Found on the way,** in `da318c7`'s runs: the suites' shared settings let a developer's `BE/.env` reach their backends for functions' keys and customers' databases, now set empty there; `hack/test-images.sh` had fallen behind production's settings since 2026-10-21, and took ports a development backend holds; and two runs of L4 lost their backend to a kill from outside FF, its log simply stopping, with neither a crash nor a memory kill in the journal.<br>• **Docs:** the decision log (23 to 33; 19; the step-3 question gone from the open ones), the roadmap, the docs' index, the README, this plan (its status, §9) |
| Q-01 Spike and ADR 0010 | ✅ Done | this commit | • **[ADR 0010](adr/0010-queue.md)** (one queue in FF's database) records what was measured and decided: one table of FF's for every queue's messages, claimed with leases, at least once; a function's waiting events in a queue of its own; a retried call keeping its request ID; SQS's protocol as the clients read it.<br>• **The harness, [`hack/spikes/queue/`](../hack/spikes/queue/README.md)** (its README says what it does): `storage.sh`, a PostgreSQL 15.19 of its own, pgmq 1.13.0 installed as plain SQL (its archive's SHA-256 checked), and `storage.mjs`'s same work for pgmq and for FF's own table; `sqs.sh`, a minimal SQS endpoint (`sqs-endpoint.mjs`, Node.js's standard library only) against AWS's SDK for JavaScript v3, boto3 and the AWS CLI.<br>• **Measured:** pgmq installed as plain SQL in 349 ms, no extension; the same throughput for both, about 460 messages a second sent one at a time, 2,480 claimed ten at a time and deleted by 4 consumers, 3,760 (pgmq) and 4,980 (FF's table) sent ten at a time; each of 20,000 messages to one consumer only, a stopped consumer's messages back after their timeout, a backup restored and read, for both; 200 queues 6.3 s and 1,400 relations for pgmq, nothing for FF's table.<br>• **Found:** AWS's SDK for JavaScript checks the MD5 sums of a message's body and attributes and refuses wrong ones, boto3 checks neither; errors carry two names, the body's `__type` for the SDK for JavaScript, `x-amzn-query-error` for boto3 and the AWS CLI; long polling and batches as SQS; a queue's URL under the endpoint and the account works for all three.<br>• **Tests:** the spike's own: `storage.sh`'s 16 measures, each as expected; `sqs.sh`'s 33 checks, 31 as wanted, the other 2 the finding above (boto3 accepting wrong MD5 sums); `hack/check-docs.py` on the files changed.<br>• **Docs:** ADR 0010, the docs' index, this plan (D1 as measured), the decision log (24) |
| Q-02 The queue and asynchronous invoke | ⏳ Planned | | |
| Q-03 Destinations, and schedules through the queue | ⏳ Planned | | |
| Q-04 The SQS endpoint | ⏳ Planned | | |
| Q-05 Queues in the API, the console, the admin app and `ff` | ⏳ Planned | | |
| Q-06 Event source mappings | ⏳ Planned | | |
| Q-07 Bucket notifications | ⏳ Planned | | |
| Q-08 Metering, billing, metrics and alarms | ⏳ Planned | | |
| Q-09 Documentation | ⏳ Planned | | |
| Q-10 The step closed | ⏳ Planned | | |
