# Queue spike

The measurements behind [ADR 0010](../../../docs/adr/0010-queue.md) (step 3's queue): the [step-3 plan](../../../docs/step-3-plan.md)'s Q-01. Two halves, each a script:

```bash
hack/spikes/queue/storage.sh                 # about 3 minutes; fetches pgmq's release the first time
MESSAGES=5000 hack/spikes/queue/storage.sh   # quicker
hack/spikes/queue/sqs.sh                     # about a minute; npm and pip fetch the SDKs the first time
```

Both need Docker or the AWS CLI, Node.js 22 or later, `jq` and Python 3; `storage.sh` uses `pg` from `BE/node_modules` (`npm install` in `BE` first). Their work files go to `hack/.spike-queue/`, which git ignores.

## Where the messages live (`storage.sh`)

- **A PostgreSQL 15 of its own,** `postgres:15.19-alpine3.24`, the version FF's own database runs, in a container removed on exit.
- **pgmq 1.13.0, installed as plain SQL:** its release's `pgmq-extension/sql/pgmq.sql`, its archive's SHA-256 checked first, run into the database by its owner, with no extension, as on a managed PostgreSQL that can't add one. pgmq makes a table per queue, `pgmq.q_<name>`, and an archive for each.
- **FF's own table in pgmq's shape** (`storage.mjs`): every queue's messages in one table, `queue_messages`, with when each is next visible and how many times it was received, claimed `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, as FF's notification deliveries are.
- **The same work for both** (`storage.mjs`): `MESSAGES` (20,000) sent one at a time from 4 senders, as `SendMessage` is; claimed ten at a time with a visibility timeout by 4 consumers and deleted, as `ReceiveMessage` and `DeleteMessage` are, each message seen by one consumer only; sent ten at a time, as `SendMessageBatch` is; a consumer that stops between its claim and its delete, its messages back for another once their timeout ends, their receive count 2; `QUEUES` (200) queues made, and what they add to the database.
- **A backup restored elsewhere:** `pg_dump` of the database, restored into another; pgmq's schema comes with it, its functions working and a queue's message read there, FF's table too.

## SQS's protocol (`sqs.sh`)

- **`sqs-endpoint.mjs`,** a minimal Amazon SQS endpoint, Node.js's standard library only: SQS's JSON 1.0 protocol (`POST /`, `X-Amz-Target: AmazonSQS.<Operation>`), AWS Signature Version 4 for the service `sqs` with one key, queues in memory, long polling, SQS's MD5 sums of a body and of its attributes, its errors as `{"__type": "com.amazonaws.sqs#<Code>"}` with the `x-amzn-query-error` header that query-compatible clients read. A queue named `wrong-md5` answers sums that don't match.
- **The clients,** each with its defaults and only the endpoint, the region and a key: AWS's SDK for JavaScript v3 (`sqs-sdk-check.mjs`, `@aws-sdk/client-sqs` 3.1156.0), boto3 1.43.118 (`sqs_boto3_check.py`), and the AWS CLI with `AWS_ENDPOINT_URL_SQS` alone. Each: a queue made and found, messages with attributes of each type sent and received back, long polling (an empty queue answering after its wait; a message sent during the wait ending it), batches of ten, a visibility timeout changed, its counts; a queue that isn't there, a wrong secret and an unknown key refused; sums that don't match, which a client that checks them refuses.

What was measured, and what it decided, is in ADR 0010.
