# Local front door spike

The question: should `ff local` answer S3 and SQS with a port of the front doors in Rust, inside `ff`, or with the backend's own front doors run in Node.js? The spike builds both ways for the same six operations and measures them. It is the measure behind ADR 0017 and the plan's choice 5. The [developer tools plan](../../../docs/dev-tools-plan.md)'s D3; its task list's M-01, part 3.

```bash
hack/spikes/local-front-door/run.sh    # about 3 minutes
```

It needs:
- Rust (the toolchain `cli/` pins);
- Node.js 24, with `BE/dist` built (`cd BE && npm run build`): the script refuses a build older than the front doors' sources;
- Docker, with `chrislusf/seaweedfs:4.48`;
- the AWS CLI;
- the L4 clients in `hack/.cache/s3-clients` and `hack/.cache/sqs-clients`, which `hack/e2e.sh` installs.

Its build, its data, the clients' answers and the results go to `hack/.spikes/local-front-door/` (`results.md`). The store runs in a container of its own, `ff-spike-local-front-door-store`, removed at the end.

## What it does

The six operations are S3's `PutObject`, `GetObject` and `ListObjectsV2`, and SQS's `SendMessage`, `ReceiveMessage` and `DeleteMessage`. Each side serves them on two ports, one per service, with one account, one key, one bucket and one queue.

- **The port to Rust** (`src/`), shaped as `ff local` would serve them:
  - the objects are files under `--data`, each with a JSON file of its headers beside it;
  - the messages are kept in memory;
  - HTTP comes from the standard library alone, a thread per connection, as `ff local start` serves function URLs today (`cli/src/local_url.rs`).

  It ports the backend's checks, its errors' words included:
  - Signature Version 4, in the header form (a presigned URL is answered `NotImplemented`);
  - aws-chunked bodies, signed, unsigned with a trailer, and signed with a trailer, each chunk's signature checked in its chain;
  - the five checksums (CRC-32, CRC-32C, CRC64NVME, SHA-1, SHA-256), and `Content-MD5`;
  - ranges; listing by prefix, delimiter, `start-after` and continuation token, keys URL-encoded when asked;
  - SQS's JSON protocol and its errors with their query codes; the message attributes' MD5; receipt handles that name one receive; long polls.

  Its tests read three of the backend's own files: the Signature V4 suite (`BE/src/common/signature-v4-suite/cases.json`), and two tables this spike moved out of the backend's specs. Those are `BE/src/storage/checksum-check-values.json` (each checksum's check value, and AWS's CRC-32C example) and `BE/src/storage/aws-chunked-examples.json` (AWS's two worked examples of a signed upload). The backend's specs read both tables now, their counts unchanged (11 and 9 tests).
- **The backend's own front doors** (`node/serve.mjs`): `S3FrontDoor` and `SqsFrontDoor` as `BE/dist` builds them, run in Node.js without NestJS and without PostgreSQL. In place of Nest's injection they get the least that lets the six operations through:
  - the settings, four of them;
  - one key, one account and one plan;
  - counts, audit, credit and limits that do nothing;
  - the queues' messages in memory, standing in for `CustomerQueues`, which keeps them in SQL.

  The S3 front door is a proxy, so its objects go to SeaweedFS, as the backend's do.
- **The clients** (`drivers/`): the AWS CLI, AWS's SDK for JavaScript v3 and boto3, each with its defaults (path-style addressing aside). Each runs the same twelve checks against each side:
  1. an object put and read back, with its type and metadata;
  2. 5 MB streamed and read back;
  3. a range;
  4. a listing by prefix and delimiter, then page by page;
  5. a missing key;
  6. S3 with a wrong secret;
  7. the queue's URL;
  8. a message with attributes of each type and Arabic text, received back, the clients checking its MD5 sums;
  9. a delete, then an empty receive answered after its wait;
  10. a long poll ended at once by a message;
  11. a queue that isn't there;
  12. SQS with a wrong secret.
- **The measures:**
  - each side's lines;
  - its time from start to its ports open, the median of five starts;
  - its memory at its peak after the clients (`VmHWM`), and the store's;
  - the backend's fixtures it passes;
  - what a developer must have to run it.

  For the Node.js side, the lines count the backend's files it loads and the packages they bring. The fixtures count the backend's L1 for the same code, which is that side's own.

## What it found

On 2026-11-08, with Rust 1.91.0, Node.js 24.22.0 and `BE/dist` as built on 2026-11-04, SeaweedFS 4.48, aws-cli 2.34.32, the SDK for JavaScript 3.1156.0 and boto3 1.43.118:

| | Rust, as `ff local` would serve them | The backend's front doors in Node.js |
|---|---|---|
| The clients' checks | 36 of 36 | 36 of 36 |
| Its lines | 2,315 of code and 553 of tests | 6,565 of the backend's, in 89 files; 173 of stand-ins |
| What it brings | 12 crates, all in `ff` already, at the same versions | 80 packages, 1,265 of their files: TypeORM's 388, RxJS's 226, class-validator's 133, validator's 113, zod's 95 |
| Start to its ports open (median of five) | 8 ms | 0.9 s, after SeaweedFS's 3.9 s |
| Its memory at its peak, after the clients | 4 MB | 199 MB, and SeaweedFS's 178 MB |
| The backend's fixtures it passes | The three tables: the Signature V4 suite's 38 cases, in both forms; the 5 check values and the CRC-32C example; AWS's two aws-chunked examples. 7 of its 19 tests read them | The backend's L1 for the same code, 287 tests, as its own |
| What a developer must have | The one binary, 1.1 MB | Node.js; BE's `node_modules` (336 MB; the packages loaded weigh 107 MB); Docker; SeaweedFS's image, 505 MB |

1. **The clients see the same thing from both sides, with one exception: PutObject's checksum.** When the AWS CLI sends a CRC64NVME, the Rust side gives it back in `PutObject`'s answer, with `x-amz-checksum-type`, as S3 does. The backend's front door doesn't. It checks the checksum as the body streams, then keeps it from the store, so the store's answer has none. No client fails without it, but it is a place where FF differs from S3, and a shared fixture of `PutObject`'s answer would have shown it. The backend could give it back, since it has computed it.
2. **The backend's way doesn't avoid a port: the queues' behaviour is in SQL.** Both of SQS's guarantees are in `CustomerQueues`' statements, which need PostgreSQL:
   - a receive hides each message from the others (`FOR UPDATE SKIP LOCKED`);
   - only the last receive's handle deletes.

   Without the database, they had to be written again: in memory here, about 70 lines with the long poll's wake-up, which PostgreSQL's `NOTIFY` gives the backend. The S3 front door is a proxy, so it needs a store in a container beside it. And the two front doors load 16 of the backend's folders, not 2: storage and queues, but also common, functions, billing, plans, encryption, admin, database, databases, audit, accounts, tags, metrics, monitoring and the orchestrator, through their imports. A change to any of them could stop `ff local`. TypeORM loads 388 files for the entities' decorators alone, with no database behind them.
3. **The fixtures to share are mostly still to be made.** Of the backend's 287 L1 tests for this code, 130 read a table that Rust reads too: 114 from the Signature V4 suite, 11 checksums, 5 aws-chunked. The other 157 build their requests in TypeScript, against the classes: `front-door.spec.ts`'s 41 and `sqs-operations.spec.ts`'s 35 among them. Rust can't read those. The plan's defence against drift is "both sides read the same files", so M-06 first moves the operations' requests and answers into tables, as part 4 did for the schedules and this spike did for the checksums and AWS's examples. Then it ports what those tables hold.
4. **The cost of each way, for a developer:**
   - The port starts in 8 ms and uses 4 MB, offline, with nothing installed but `ff`.
   - The backend's way, packaged as the plan's second option, is an image of the backend's code with its `node_modules` and a store beside it. That is hundreds of MB to pull, about 5 s to start, and about 380 MB of memory.
   - The port's price is about 2,300 lines that must stay in step with the backend's, about a third of what the backend's way loads of FF's own code.
5. **Recommendation: inside `ff`, in Rust, as D3 says,** with M-06 holding it to tables of requests and answers that the backend's L1 reads too. The second way still needs a port of the SQL, a store and Docker. It ties `ff local` to 16 of the backend's modules and gives the clients nothing more. ADR 0017 decides.
