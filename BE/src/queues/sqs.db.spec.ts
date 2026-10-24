/**
 * L2: customers' queues on a real PostgreSQL, through the SQS endpoint, as
 * AWS's SDK for JavaScript calls it (ADR 0010): queues made, found, listed,
 * changed and deleted; messages sent, received with their attributes, their
 * MD5 sums checked by the SDK, hidden for their visibility timeout and back
 * after it, deleted by their last receipt only; delays, batches, a long poll
 * woken by PostgreSQL's NOTIFY, two consumers never holding one message, a
 * dead-letter queue taking what was received too often, retention, purges;
 * the plan's queues and storage; a read-only key and another account's. The
 * keys are FF's own, in its database. Each run works in a scratch database,
 * dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SQSServiceException,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { CreditService } from '../billing/credit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { Bucket } from '../storage/bucket.entity';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StorageKey } from '../storage/storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from '../storage/storage-names';
import { CustomerQueues } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueRequestCount } from './queue-request-count.entity';
import { QueueRequestCounts } from './queue-request-counts.service';
import { QueueStore } from './queue-store';
import { Queue } from './queue.entity';
import { SqsFrontDoor } from './sqs-front-door';
import { QueuesService } from './queues.service';
import { SqsOperations } from './sqs-operations';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '800000000001';
const OTHER = '800000000002';
const REGION = 'tn-tunis-1';
const BASE = 'http://sqs.localhost:3003';
/** The plan of these tests: the beta plan, with 4 queues and 1 MB of messages, to reach its limits soon. */
const PLAN = plan({ queues: 4, queueStorageMb: 1 });

run("customers' queues through the SQS endpoint, in FF's database (L2)", () => {
  const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
  let db: ScratchDatabase;
  let events: QueueEvents;
  let store: QueueStore;
  let counts: QueueRequestCounts;
  let frontDoor: SqsFrontDoor;
  let endpoint: string;
  const key = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const reader = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const theirs = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  /** A key that names one queue, and one that names a bucket alone. */
  const ordersOnly = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const photosOnly = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  let api: QueuesService;
  const clients: SQSClient[] = [];
  /** A client as a customer's code makes one: its endpoint, its region and a key, nothing else. */
  const client = (credentials = key) => {
    const made = new SQSClient({ endpoint, region: REGION, credentials: { accessKeyId: credentials.id, secretAccessKey: credentials.secret }, maxAttempts: 1 });
    clients.push(made);
    return made;
  };
  let sqs: SQSClient;
  let n = 0;
  /** A queue of its own for each test, made through the endpoint. */
  const newQueue = async (Attributes?: Record<string, string>) => (await sqs.send(new CreateQueueCommand({ QueueName: `queue-${++n}`, Attributes }))).QueueUrl as string;
  const sizes = async () =>
    Object.fromEntries(
      (await db.dataSource.query<Array<{ name: string; size_bytes: string }>>('SELECT name, size_bytes FROM queues WHERE account_id = $1', [ACCOUNT])).map((row) => [
        row.name,
        Number(row.size_bytes),
      ]),
    );
  const deleteAll = async () => {
    for (const QueueUrl of (await sqs.send(new ListQueuesCommand({}))).QueueUrls ?? []) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
  };
  async function failure(send: Promise<unknown>): Promise<{ name: string; code?: string; message: string }> {
    try {
      await send;
    } catch (error) {
      if (error instanceof SQSServiceException) return { name: error.name, code: (error as unknown as { Code?: string }).Code, message: error.message };
      throw error;
    }
    throw new Error('not refused');
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Shop', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    const keys = db.dataSource.getRepository(StorageKey);
    const directory = new StorageDirectory(db.dataSource.getRepository(Bucket), keys, encryption);
    await keys.save([
      { id: key.id, accountId: ACCOUNT, secret: directory.sealSecret(key.id, key.secret) },
      { id: reader.id, accountId: ACCOUNT, readOnly: true, secret: directory.sealSecret(reader.id, reader.secret) },
      { id: theirs.id, accountId: OTHER, secret: directory.sealSecret(theirs.id, theirs.secret) },
      { id: ordersOnly.id, accountId: ACCOUNT, queues: ['orders'], secret: directory.sealSecret(ordersOnly.id, ordersOnly.secret) },
      { id: photosOnly.id, accountId: ACCOUNT, buckets: ['photos'], secret: directory.sealSecret(photosOnly.id, photosOnly.secret) },
    ]);
    events = new QueueEvents(db.dataSource);
    await events.onModuleInit();
    store = new QueueStore(db.dataSource, { count: () => undefined } as never);
    const customerQueues = new CustomerQueues(db.dataSource, db.dataSource.getRepository(Queue));
    counts = new QueueRequestCounts(db.dataSource.getRepository(QueueRequestCount));
    const operations = new SqsOperations(customerQueues, store, events, new AuditService(db.dataSource.getRepository(AuditEntry)), counts, BASE, REGION);
    // Every account on that plan, with credit, and as many requests a second as it sends: the checks of each have their own tests.
    frontDoor = new SqsFrontDoor(
      new ConfigService({ sqs: { base: BASE, region: REGION } }),
      directory,
      operations,
      onePlan(PLAN),
      { admit: async () => undefined } as unknown as CreditService,
      { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) },
    );
    // FF's API over the same operations, as the module makes it.
    api = new QueuesService(
      operations,
      customerQueues,
      onePlan(PLAN),
      { admit: async () => undefined } as unknown as CreditService,
      directory,
      new ConfigService({ sqs: { base: BASE, region: REGION } }),
    );
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
    sqs = client();
  });

  afterAll(async () => {
    for (const made of clients) made.destroy();
    await frontDoor?.onModuleDestroy();
    await events?.onModuleDestroy();
    await db?.drop();
  });

  afterEach(deleteAll);

  describe('queues', () => {
    it('makes a queue, answers its URL under the endpoint and the account, and finds it by name', async () => {
      const made = await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }));
      expect(made.QueueUrl).toBe(`${BASE}/${ACCOUNT}/orders`);
      expect((await sqs.send(new GetQueueUrlCommand({ QueueName: 'orders' }))).QueueUrl).toBe(made.QueueUrl);
      expect(await failure(sqs.send(new GetQueueUrlCommand({ QueueName: 'invoices' })))).toEqual({
        name: 'QueueDoesNotExist',
        code: 'AWS.SimpleQueueService.NonExistentQueue',
        message: 'The specified queue does not exist.',
      });
    });

    it('answers the queue there is when it is made again with the same attributes, and refuses other values', async () => {
      const first = await sqs.send(new CreateQueueCommand({ QueueName: 'orders', Attributes: { VisibilityTimeout: '60' } }));
      expect((await sqs.send(new CreateQueueCommand({ QueueName: 'orders', Attributes: { VisibilityTimeout: '60' } }))).QueueUrl).toBe(first.QueueUrl);
      expect((await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }))).QueueUrl).toBe(first.QueueUrl);
      expect(await failure(sqs.send(new CreateQueueCommand({ QueueName: 'orders', Attributes: { VisibilityTimeout: '30' } })))).toEqual({
        name: 'QueueNameExists',
        code: 'QueueAlreadyExists',
        message: 'A queue already exists with the same name and a different value for attribute VisibilityTimeout',
      });
    });

    it("lists the account's queues by name, a prefix's, a page at a time", async () => {
      for (const QueueName of ['orders-eu', 'orders-us', 'invoices']) await sqs.send(new CreateQueueCommand({ QueueName }));
      expect((await sqs.send(new ListQueuesCommand({}))).QueueUrls).toEqual([`${BASE}/${ACCOUNT}/invoices`, `${BASE}/${ACCOUNT}/orders-eu`, `${BASE}/${ACCOUNT}/orders-us`]);
      const first = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: 'orders', MaxResults: 1 }));
      expect(first.QueueUrls).toEqual([`${BASE}/${ACCOUNT}/orders-eu`]);
      const second = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: 'orders', MaxResults: 1, NextToken: first.NextToken }));
      expect(second).toMatchObject({ QueueUrls: [`${BASE}/${ACCOUNT}/orders-us`] });
      expect(second.NextToken).toBeUndefined();
      expect((await client(theirs).send(new ListQueuesCommand({}))).QueueUrls).toBeUndefined();
    });

    it("makes the plan's queues and no more, counted under the account's lock", async () => {
      const made = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => sqs.send(new CreateQueueCommand({ QueueName: `many-${i}` }))));
      expect(made.filter((result) => result.status === 'fulfilled')).toHaveLength(PLAN.limits.queues);
      const refused = made.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect((refused.reason as Error).name).toBe('OverLimit');
      expect((refused.reason as Error).message).toBe('The Beta plan allows 4 queues per account: delete one first.');
    });

    it('answers its attributes, changes them, and deletes it with its messages', async () => {
      const QueueUrl = await newQueue();
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'kept' }));
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { VisibilityTimeout: '120', ReceiveMessageWaitTimeSeconds: '1' } }));
      const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }));
      expect(Attributes).toMatchObject({
        QueueArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:queue-${n}`,
        VisibilityTimeout: '120',
        ReceiveMessageWaitTimeSeconds: '1',
        MessageRetentionPeriod: '345600',
        ApproximateNumberOfMessages: '1',
      });
      expect(Number(Attributes?.LastModifiedTimestamp)).toBeGreaterThanOrEqual(Number(Attributes?.CreatedTimestamp));
      expect((await sizes())[`queue-${n}`]).toBe(4);
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      expect((await failure(sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'too late' })))).name).toBe('QueueDoesNotExist');
      expect(await db.dataSource.query('SELECT count(*)::int AS n FROM queue_messages')).toEqual([{ n: 0 }]);
    });
  });

  describe('messages', () => {
    const attributes = {
      color: { DataType: 'String', StringValue: 'harissa red' },
      quantity: { DataType: 'Number', StringValue: '2' },
      picture: { DataType: 'Binary.png', BinaryValue: new Uint8Array([137, 80, 78, 71]) },
    };

    it('keeps a message with its attributes, and gives it back as sent, the SDK checking its MD5 sums', async () => {
      const QueueUrl = await newQueue();
      const body = '{"item":"harissa","quantity":2} سلام 👋';
      const sent = await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: body, MessageAttributes: attributes }));
      expect(sent.MessageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent.MD5OfMessageAttributes).toMatch(/^[0-9a-f]{32}$/);
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }));
      expect(Messages).toHaveLength(1);
      expect(Messages[0]).toMatchObject({ MessageId: sent.MessageId, Body: body, MD5OfMessageAttributes: sent.MD5OfMessageAttributes, MessageAttributes: attributes });
      expect(Messages[0].Attributes).toMatchObject({ SenderId: key.id, ApproximateReceiveCount: '1' });
      expect(Math.abs(Number(Messages[0].Attributes?.SentTimestamp) - Date.now())).toBeLessThan(10_000);
    });

    it('hides a message received for its visibility timeout, gives it back after, and deletes it by its last receipt only', async () => {
      const QueueUrl = await newQueue({ VisibilityTimeout: '1' });
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'once' }));
      const first = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined();
      expect((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessagesNotVisible'] }))).Attributes).toEqual({
        ApproximateNumberOfMessagesNotVisible: '1',
      });
      const second = (await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 3, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }))).Messages?.[0];
      expect(second).toMatchObject({ MessageId: first?.MessageId, Attributes: { ApproximateReceiveCount: '2' } });
      expect(second?.ReceiptHandle).not.toBe(first?.ReceiptHandle);
      // The first receipt deletes nothing, without an error, as SQS's documentation has it; the last one deletes the message.
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: first?.ReceiptHandle }));
      expect(await db.dataSource.query('SELECT count(*)::int AS n FROM queue_messages')).toEqual([{ n: 1 }]);
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: second?.ReceiptHandle }));
      expect(await db.dataSource.query('SELECT count(*)::int AS n FROM queue_messages')).toEqual([{ n: 0 }]);
    });

    it("changes a received message's visibility, and refuses it for one not received any more", async () => {
      const QueueUrl = await newQueue({ VisibilityTimeout: '600' });
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'look again' }));
      const message = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: message?.ReceiptHandle, VisibilityTimeout: 0 }));
      const again = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      expect(again?.MessageId).toBe(message?.MessageId);
      expect((await failure(sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: message?.ReceiptHandle, VisibilityTimeout: 0 })))).name).toBe('MessageNotInflight');
    });

    it('waits for its delay before it can be received', async () => {
      const QueueUrl = await newQueue();
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'later', DelaySeconds: 1 }));
      expect((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessagesDelayed'] }))).Attributes).toEqual({
        ApproximateNumberOfMessagesDelayed: '1',
      });
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined();
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 3 }));
      expect(Messages.map((message) => message.Body)).toEqual(['later']);
    });

    it('sends, receives and deletes ten at a time', async () => {
      const QueueUrl = await newQueue();
      const sent = await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: Array.from({ length: 10 }, (_, i) => ({ Id: `m${i}`, MessageBody: `batch ${i}` })) }));
      expect(sent.Successful).toHaveLength(10);
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
      expect(Messages.map((message) => message.Body).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `batch ${i}`).sort());
      const deleted = await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl,
          Entries: [...Messages.map((message, i) => ({ Id: `d${i}`, ReceiptHandle: message.ReceiptHandle })).slice(0, 9), { Id: 'made-up', ReceiptHandle: 'not-a-handle' }],
        }),
      );
      expect(deleted.Successful).toHaveLength(9);
      expect(deleted.Failed).toEqual([{ Id: 'made-up', Code: 'ReceiptHandleIsInvalid', SenderFault: true, Message: 'The input receipt handle "not-a-handle" is not a valid receipt handle.' }]);
      expect(await db.dataSource.query('SELECT count(*)::int AS n FROM queue_messages')).toEqual([{ n: 1 }]);
    });

    it('gives each message to one consumer at a time, however many receive at once', async () => {
      const QueueUrl = await newQueue({ VisibilityTimeout: '600' });
      for (let batch = 0; batch < 4; batch++) {
        await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: Array.from({ length: 10 }, (_, i) => ({ Id: `m${i}`, MessageBody: `${batch * 10 + i}` })) }));
      }
      const consumers = Array.from({ length: 4 }, () => client());
      const received = await Promise.all(
        consumers.flatMap((consumer) => Array.from({ length: 3 }, () => consumer.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 })))),
      );
      const bodies = received.flatMap((answer) => (answer.Messages ?? []).map((message) => message.Body));
      expect(bodies).toHaveLength(40);
      expect(new Set(bodies).size).toBe(40);
    });
  });

  describe('long polling', () => {
    it("answers an empty queue after its wait, and as soon as a message comes during one, PostgreSQL's NOTIFY telling it", async () => {
      const QueueUrl = await newQueue();
      const started = Date.now();
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 1 }))).Messages).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);

      const waiting = sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 10 }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client().send(new SendMessageCommand({ QueueUrl, MessageBody: 'during the wait' }));
      const sentAt = Date.now();
      expect(((await waiting).Messages ?? []).map((message) => message.Body)).toEqual(['during the wait']);
      // Asking the database again a second into the wait would answer 700 ms after the message came: the NOTIFY answers at once.
      expect(Date.now() - sentAt).toBeLessThan(400);
    });

    it("takes the queue's own wait when the receive names none", async () => {
      const QueueUrl = await newQueue({ ReceiveMessageWaitTimeSeconds: '1' });
      const started = Date.now();
      await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });
  });

  describe('dead-letter queues', () => {
    it('moves a message received as often as the redrive policy allows to the dead-letter queue, with its size, and its long poll wakes', async () => {
      const deadLetter = await newQueue();
      const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetter, AttributeNames: ['QueueArn'] }));
      const QueueUrl = await newQueue({ VisibilityTimeout: '0', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: 2 }) });
      const sent = await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'poison' }));
      for (let receive = 1; receive <= 2; receive++) {
        expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0]?.MessageId).toBe(sent.MessageId);
      }
      const waiting = client().send(new ReceiveMessageCommand({ QueueUrl: deadLetter, WaitTimeSeconds: 10, MessageSystemAttributeNames: ['All'] }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined();
      const movedAt = Date.now();
      const moved = (await waiting).Messages?.[0];
      // The move's NOTIFY wakes the dead-letter queue's long poll, well before it would ask the database again.
      expect(Date.now() - movedAt).toBeLessThan(400);
      expect(moved).toMatchObject({ MessageId: sent.MessageId, Body: 'poison', Attributes: { ApproximateReceiveCount: '1' } });
      expect(await sizes()).toMatchObject({ [`queue-${n - 1}`]: 6, [`queue-${n}`]: 0 });
    });

    it('refuses a redrive policy whose dead-letter queue is not there, or is the queue itself', async () => {
      const arn = `arn:aws:sqs:${REGION}:${ACCOUNT}:nowhere`;
      expect((await failure(newQueue({ RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 2 }) }))).message).toBe(
        'Value for parameter RedrivePolicy is invalid. Reason: Dead letter target does not exist.',
      );
      const QueueUrl = await newQueue();
      const policy = JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:queue-${n}`, maxReceiveCount: 2 });
      expect((await failure(sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { RedrivePolicy: policy } })))).message).toContain("can't be its own dead-letter queue");
    });
  });

  describe('what a queue keeps', () => {
    it("drops a message past its retention: it isn't received, and the purge of expired messages deletes it", async () => {
      const QueueUrl = await newQueue({ MessageRetentionPeriod: '60' });
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'old news' }));
      const [{ expires }] = await db.dataSource.query<Array<{ expires: number }>>('SELECT extract(epoch FROM expires_at - sent_at)::int AS expires FROM queue_messages');
      expect(expires).toBe(60);
      await db.dataSource.query(`UPDATE queue_messages SET expires_at = now() - interval '1 second'`);
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined();
      expect(await store.purgeExpired()).toBe(1);
      expect((await sizes())[`queue-${n}`]).toBe(0);
    });

    it('purges every message of a queue', async () => {
      const QueueUrl = await newQueue();
      await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: [{ Id: 'a', MessageBody: 'one' }, { Id: 'b', MessageBody: 'two' }] }));
      await sqs.send(new PurgeQueueCommand({ QueueUrl }));
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined();
      expect((await sizes())[`queue-${n}`]).toBe(0);
    });

    it("refuses a message once the account's messages hold the plan's storage, and takes more once some are deleted", async () => {
      const QueueUrl = await newQueue();
      const big = 'x'.repeat(700_000);
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: big }));
      expect(await failure(sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: big })))).toMatchObject({
        name: 'OverLimit',
        message: "The account's messages hold 1 MB together, the Beta plan's limit, its functions' asynchronous calls among them: try again once some are deleted.",
      });
      const message = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message?.ReceiptHandle }));
      await expect(sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: big }))).resolves.toHaveProperty('MessageId');
    });
  });

  describe("FF's API, beside the endpoint", () => {
    const owner: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner', userId: 'u-1' };

    it("counts each request that names a queue, the endpoint's and the API's, as SQS bills them, written once a minute", async () => {
      const QueueUrl = await newQueue();
      const [{ id }] = await db.dataSource.query<Array<{ id: string }>>('SELECT "id" FROM "queues" WHERE "account_id" = $1 AND "name" = $2', [ACCOUNT, `queue-${n}`]);
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'x'.repeat(70_000) }));
      const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: Messages?.[0].ReceiptHandle }));
      await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
      await api.send(owner, `queue-${n}`, { body: 'from the console' });
      await sqs.send(new ListQueuesCommand({}));
      await counts.flush();

      const [row] = await db.dataSource.query<Array<Record<string, unknown>>>(
        `SELECT min("name") AS "name", sum("requests")::int AS "requests", sum("sent")::int AS "sent", sum("sent_bytes")::int AS "sentBytes", max("sent_max_bytes") AS "largest",
                sum("received")::int AS "received", sum("deleted")::int AS "deleted", sum("empty_receives")::int AS "emptyReceives", count(DISTINCT "writer")::int AS "writers"
           FROM "queue_request_counts" WHERE "queue_id" = $1`,
        [id],
      );
      // CreateQueue 1, the send of 70,000 bytes 2, its receive 2, the delete 1, the empty receive 1, the API's send 1; ListQueues names no queue.
      expect(row).toEqual({ name: `queue-${n}`, requests: 8, sent: 2, sentBytes: 70_016, largest: 70_000, received: 1, deleted: 1, emptyReceives: 1, writers: 1 });
    });

    it('makes a queue that AWS\'s SDK finds, receives what the SDK sent with its attributes, and deletes it by its handle', async () => {
      const made = await api.create(owner, { name: 'orders', visibilityTimeout: 45 });
      expect(made).toMatchObject({ name: 'orders', url: `${BASE}/${ACCOUNT}/orders`, arn: `arn:aws:sqs:${REGION}:${ACCOUNT}:orders`, visibilityTimeout: 45 });
      expect((await sqs.send(new GetQueueUrlCommand({ QueueName: 'orders' }))).QueueUrl).toBe(made.url);
      await sqs.send(new SendMessageCommand({ QueueUrl: made.url, MessageBody: 'from the SDK', MessageAttributes: { item: { DataType: 'String', StringValue: 'harissa' } } }));
      await api.send(owner, 'orders', { body: 'from the API', attributes: { size: { dataType: 'Number', stringValue: '2' } } });

      expect((await api.get(ACCOUNT, 'orders')).messages).toEqual({ available: 2, inFlight: 0, delayed: 0 });
      const received = await api.receive(owner, 'orders', { maxMessages: 10 });
      expect(received.map((message) => [message.body, message.attributes, message.senderId, message.receiveCount])).toEqual([
        ['from the SDK', { item: { dataType: 'String', stringValue: 'harissa' } }, key.id, 1],
        ['from the API', { size: { dataType: 'Number', stringValue: '2' } }, 'user:u-1', 1],
      ]);
      expect((await api.list(ACCOUNT)).map((queue) => [queue.name, queue.messages])).toEqual([['orders', { available: 0, inFlight: 2, delayed: 0 }]]);
      for (const message of received) await api.deleteMessage(owner, 'orders', message.receiptHandle);
      expect((await api.get(ACCOUNT, 'orders')).messages).toEqual({ available: 0, inFlight: 0, delayed: 0 });
    });

    it("refuses a name the account has, a queue it hasn't, and changes, purges and deletes what the SDK sees", async () => {
      await api.create(owner, { name: 'orders' });
      await expect(api.create(owner, { name: 'orders' })).rejects.toThrow('The account has a queue named "orders" already');
      await expect(api.get(ACCOUNT, 'invoices')).rejects.toThrow('The account has no queue named "invoices"');
      await api.update(owner, 'orders', { delaySeconds: 3 });
      const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: `${BASE}/${ACCOUNT}/orders`, AttributeNames: ['DelaySeconds'] }));
      expect(Attributes).toEqual({ DelaySeconds: '3' });
      await api.send(owner, 'orders', { body: 'to purge' });
      await api.purge(owner, 'orders');
      expect((await api.get(ACCOUNT, 'orders')).sizeBytes).toBe(0);
      await api.remove(owner, 'orders');
      expect((await failure(sqs.send(new GetQueueUrlCommand({ QueueName: 'orders' })))).name).toBe('QueueDoesNotExist');
    });

    it("writes each change in the audit log, an SDK's under its access key, from its address", async () => {
      await sqs.send(new CreateQueueCommand({ QueueName: 'audited' }));
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: `${BASE}/${ACCOUNT}/audited`, Attributes: { VisibilityTimeout: '90' } }));
      await api.purge(owner, 'audited');
      await sqs.send(new DeleteQueueCommand({ QueueUrl: `${BASE}/${ACCOUNT}/audited` }));

      const entries = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: ACCOUNT, resource: 'queue:audited' }, order: { at: 'ASC' } });
      expect(entries.map((entry) => [entry.action, entry.actor])).toEqual([
        ['queue.create', `access_key:${key.id}`],
        ['queue.update', `access_key:${key.id}`],
        ['queue.purge', 'system'],
        ['queue.delete', `access_key:${key.id}`],
      ]);
      expect(entries[0]).toMatchObject({ actorLabel: `access key ${key.id}`, ip: '127.0.0.1', details: { attributes: {} } });
      expect(entries[1].details).toEqual({ attributes: { visibilityTimeout: 90 } });
    });
  });

  describe('keys', () => {
    it("lets a read-only key read and receive, but not send or delete", async () => {
      const QueueUrl = await newQueue();
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'for the reader' }));
      const readOnly = client(reader);
      const message = (await readOnly.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      expect(message?.Body).toBe('for the reader');
      expect(await failure(readOnly.send(new SendMessageCommand({ QueueUrl, MessageBody: 'no' })))).toMatchObject({
        name: 'AccessDenied',
        message: "The access key is read-only: it can't call SendMessage.",
      });
      expect((await failure(readOnly.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message?.ReceiptHandle })))).name).toBe('AccessDenied');
    });

    it("finds no queue of another account's with a key of its own, whatever its URL", async () => {
      const QueueUrl = await newQueue();
      const other = client(theirs);
      expect((await failure(other.send(new SendMessageCommand({ QueueUrl, MessageBody: 'not yours' })))).name).toBe('QueueDoesNotExist');
      expect((await failure(other.send(new GetQueueUrlCommand({ QueueName: `queue-${n}`, QueueOwnerAWSAccountId: ACCOUNT })))).name).toBe('QueueDoesNotExist');
      expect((await failure(other.send(new GetQueueUrlCommand({ QueueName: `queue-${n}` })))).name).toBe('QueueDoesNotExist');
    });

    it('lets a key that names a queue reach it alone, list it alone, and a key that names a bucket alone reach none', async () => {
      const ordersUrl = (await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }))).QueueUrl as string;
      const QueueUrl = await newQueue();
      const named = client(ordersOnly);

      await expect(named.send(new SendMessageCommand({ QueueUrl: ordersUrl, MessageBody: 'to the queue it names' }))).resolves.toHaveProperty('MessageId');
      expect((await failure(named.send(new SendMessageCommand({ QueueUrl, MessageBody: 'not named' })))).name).toBe('AccessDenied');
      expect((await failure(named.send(new CreateQueueCommand({ QueueName: 'another' })))).name).toBe('AccessDenied');
      expect((await named.send(new ListQueuesCommand({}))).QueueUrls).toEqual([ordersUrl]);
      expect((await failure(client(photosOnly).send(new GetQueueUrlCommand({ QueueName: 'orders' })))).name).toBe('AccessDenied');
      expect((await client(photosOnly).send(new ListQueuesCommand({}))).QueueUrls).toBeUndefined();
    });

    it('refuses a revoked key, as one it never knew', async () => {
      await db.dataSource.getRepository(StorageKey).update({ id: reader.id }, { revokedAt: new Date() });
      expect((await failure(client(reader).send(new ListQueuesCommand({})))).name).toBe('InvalidClientTokenId');
      await db.dataSource.getRepository(StorageKey).update({ id: reader.id }, { revokedAt: null });
    });
  });
});
