/**
 * L2: functions reading queues, as AWS Lambda's event source mappings, on a
 * real PostgreSQL: mappings made with Lambda's defaults and refusals, once
 * per function and queue, counted against the plan under a lock, changed,
 * deleted, and gone with their queue or their function; and the poller
 * reading a real queue, woken by PostgreSQL's NOTIFY: a batch called with
 * SQS's event and deleted, a message the answer names back after its
 * visibility timeout until the dead-letter queue takes it, a disabled
 * mapping reading nothing. The function's call is stood in for; its own
 * tests are elsewhere. Each run works in a scratch database, dropped after.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { onePlan, plan } from '../plans/test-fixtures';
import { CustomerQueues } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { QueueRequestCount } from '../queues/queue-request-count.entity';
import { QueueRequestCounts } from '../queues/queue-request-counts.service';
import { QueueEvents } from '../queues/queue-events';
import { QueueSettings } from '../queues/sqs-attributes';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EventSourcePoller } from './event-source-poller';
import { EventSourcesService } from './event-sources.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '810000000001';
const REGION = 'tn-tunis-1';
const arnOf = (name: string) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;

/** Waits until `condition` holds, every 100 ms, for `seconds` at most. */
async function until(condition: () => Promise<boolean> | boolean, seconds = 20): Promise<void> {
  const ends = Date.now() + seconds * 1000;
  while (!(await condition())) {
    if (Date.now() > ends) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

run('functions reading queues, as Lambda\'s event source mappings (L2)', () => {
  let db: ScratchDatabase;
  let queues: CustomerQueues;
  let events: QueueEvents;
  let poller: EventSourcePoller;
  let counts: QueueRequestCounts;
  let service: EventSourcesService;
  let n = 0;
  /** What the function answers a batch with; each call's event is kept. */
  let answer: (event: { Records: Array<{ messageId: string; body: string }> }) => unknown;
  const calls: Array<{ Records: Array<{ messageId: string; body: string; eventSourceARN: string }> }> = [];

  const newFunction = (timeout = 5) =>
    db.dataSource.getRepository(Function).save({
      name: `reader-${++n}`,
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout,
      status: FunctionStatus.ACTIVE,
    });
  const newQueue = async (settings: Partial<QueueSettings> = {}, name = `queue-${++n}`): Promise<Queue> =>
    (await queues.create(ACCOUNT, name, settings, { limit: 1000, name: 'Beta' }, REGION)).queue;
  const send = (queue: Queue, ...bodies: string[]) =>
    queues.send(
      queue,
      bodies.map((body) => ({ messageId: randomUUID(), body, meta: { senderId: 'AKFF7Q2MLKX4RTZB3W5N' }, sizeBytes: Buffer.byteLength(body), delaySeconds: 0 })),
      new Date(),
    );
  const bodiesIn = async (queue: Queue) =>
    (await db.dataSource.query<Array<{ body: string }>>('SELECT body FROM queue_messages WHERE queue_id = $1 ORDER BY id', [queue.id])).map((row) => row.body);
  const entries = async (action: string) =>
    (await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: ACCOUNT, action }, order: { id: 'ASC' } })).map((entry) => entry.details);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Readers', planId: 'beta', status: AccountStatus.ACTIVE });
    queues = new CustomerQueues(db.dataSource, db.dataSource.getRepository(Queue));
    events = new QueueEvents(db.dataSource);
    await events.onModuleInit();
    const functions = {
      findOne: async (accountId: string, id: string) => {
        const fn = await db.dataSource.getRepository(Function).findOneBy({ id, accountId });
        if (!fn) throw new NotFoundException(`Function with ID ${id} not found`);
        return fn;
      },
      call: async (_fn: Function, event: (typeof calls)[number]) => {
        calls.push(event);
        return { ok: true, output: answer(event), invocation: {} };
      },
    };
    // Loaded again only when a mapping changes here, so that each test says when.
    const config = new ConfigService({ sqs: { region: REGION }, eventSources: { refreshSeconds: 3600 } });
    counts = new QueueRequestCounts(db.dataSource.getRepository(QueueRequestCount));
    poller = new EventSourcePoller(
      config,
      db.dataSource.getRepository(EventSourceMapping),
      db.dataSource.getRepository(Account),
      queues,
      events,
      functions as never,
      { admit: async () => undefined } as never,
      counts,
    );
    poller.onModuleInit();
    service = new EventSourcesService(
      db.dataSource.getRepository(EventSourceMapping),
      functions as never,
      queues,
      onePlan(plan()),
      new AuditService(db.dataSource.getRepository(AuditEntry)),
      poller,
      config,
    );
  });

  afterAll(async () => {
    poller?.onModuleDestroy();
    await poller?.settled();
    await events?.onModuleDestroy();
    await db?.drop();
  });

  beforeEach(() => {
    calls.length = 0;
    answer = () => null;
  });

  describe('the mappings', () => {
    it("makes one with Lambda's defaults, lists it for the function, the account and the queue, and keeps one per function and queue", async () => {
      const fn = await newFunction();
      const queue = await newQueue();

      const made = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name), enabled: false });

      expect(made).toEqual({
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
        eventSourceArn: arnOf(queue.name),
        functionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${fn.name}`,
        batchSize: 10,
        maximumBatchingWindowInSeconds: 0,
        functionResponseTypes: [],
        scalingConfig: null,
        state: 'Disabled',
        stateTransitionReason: 'USER_INITIATED',
        lastModified: expect.any(Date),
      });
      expect(await service.listForFunction(ACCOUNT, fn.id)).toEqual([made]);
      expect(await service.list(ACCOUNT, arnOf(queue.name))).toEqual([made]);
      expect((await service.list(ACCOUNT)).map((mapping) => mapping.uuid)).toContain(made.uuid);
      expect(await service.get(ACCOUNT, made.uuid)).toEqual(made);
      await expect(service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name) })).rejects.toEqual(
        new ConflictException(
          `An event source mapping with SQS arn (" ${arnOf(queue.name)} ") and function (" ${fn.name} ") already exists. Please update or delete the existing mapping with UUID ${made.uuid}`,
        ),
      );
      expect(await entries('event_source.create')).toContainEqual({
        function: fn.name,
        queue: queue.name,
        batchSize: 10,
        maximumBatchingWindowInSeconds: 0,
        reportBatchItemFailures: false,
        maximumConcurrency: null,
        enabled: false,
      });
    });

    it("counts a function's mappings against its plan under a lock on it: of six made at once, five", async () => {
      const fn = await newFunction();
      const made = await Promise.allSettled(
        await Promise.all(Array.from({ length: 6 }, async () => newQueue())).then((made) =>
          made.map((queue) => service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name), enabled: false })),
        ),
      );

      expect(made.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
      expect(made.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown)).toEqual([
        new BadRequestException(`The Beta plan lets a function read 5 queues: ${fn.name} reads 5 already`),
      ]);
    });

    it('changes what is given and keeps the rest, saying each change in the audit log, and deletes one', async () => {
      const fn = await newFunction();
      const queue = await newQueue();
      const made = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name), enabled: false });

      const changed = await service.update(ACCOUNT, made.uuid, { batchSize: 100, maximumBatchingWindowInSeconds: 2, functionResponseTypes: ['ReportBatchItemFailures'], scalingConfig: { maximumConcurrency: 4 } });
      expect(changed).toMatchObject({ batchSize: 100, maximumBatchingWindowInSeconds: 2, functionResponseTypes: ['ReportBatchItemFailures'], scalingConfig: { maximumConcurrency: 4 }, state: 'Disabled' });
      await expect(service.update(ACCOUNT, made.uuid, { maximumBatchingWindowInSeconds: 0 })).rejects.toEqual(
        new BadRequestException('Maximum batch window in seconds must be greater than 0 if maximum batch size is greater than 10'),
      );
      expect((await service.update(ACCOUNT, made.uuid, { scalingConfig: null })).scalingConfig).toBeNull();
      expect((await entries('event_source.update')).slice(-2)).toEqual([
        {
          changes: {
            batchSize: { from: 10, to: 100 },
            maximumBatchingWindowInSeconds: { from: 0, to: 2 },
            reportBatchItemFailures: { from: false, to: true },
            maximumConcurrency: { from: null, to: 4 },
          },
        },
        { changes: { maximumConcurrency: { from: 4, to: null } } },
      ]);

      await service.remove(ACCOUNT, made.uuid);
      await expect(service.get(ACCOUNT, made.uuid)).rejects.toEqual(new NotFoundException(`The account has no event source mapping ${made.uuid}`));
      expect((await entries('event_source.delete')).slice(-1)).toEqual([{ function: fn.name, queue: queue.name }]);
    });

    it("goes with its queue, and with its function; and isn't made for a queue that hides a message for less than the function's timeout", async () => {
      const fn = await newFunction();
      const [first, second] = [await newQueue(), await newQueue()];
      const viaQueue = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(first.name), enabled: false });
      const viaFunction = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(second.name), enabled: false });

      await queues.delete(first);
      await expect(service.get(ACCOUNT, viaQueue.uuid)).rejects.toBeInstanceOf(NotFoundException);
      await db.dataSource.getRepository(Function).delete({ id: fn.id });
      await expect(service.get(ACCOUNT, viaFunction.uuid)).rejects.toBeInstanceOf(NotFoundException);

      const slow = await newFunction(60);
      await expect(service.create(ACCOUNT, slow.id, { eventSourceArn: arnOf(second.name) })).rejects.toEqual(
        new BadRequestException('Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds'),
      );
    });
  });

  describe('the poller', () => {
    it("calls the function with a batch of SQS's event at once, PostgreSQL telling it, and deletes what it handled", async () => {
      const fn = await newFunction();
      const queue = await newQueue();
      const mapping = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name) });
      await poller.refresh();

      const sent = Date.now();
      await send(queue, 'one', 'two');
      await until(async () => (await bodiesIn(queue)).length === 0);

      expect(Date.now() - sent).toBeLessThan(2000);
      expect(calls.flatMap((event) => event.Records.map((record) => [record.body, record.eventSourceARN]))).toEqual([
        ['one', arnOf(queue.name)],
        ['two', arnOf(queue.name)],
      ]);
      await service.remove(ACCOUNT, mapping.uuid);
      // The batch counted as the one request that would have received it, its deletes not billed, its empty receives not counted.
      await poller.settled();
      await counts.flush();
      expect(
        await db.dataSource.query(
          'SELECT sum("requests")::int AS "requests", sum("received")::int AS "received", sum("deleted")::int AS "deleted", sum("empty_receives")::int AS "empty" FROM "queue_request_counts" WHERE "queue_id" = $1',
          [queue.id],
        ),
      ).toEqual([{ requests: 1, received: 2, deleted: 2, empty: 0 }]);
    });

    it("keeps a message the answer names, which comes back after its visibility timeout until the dead-letter queue takes it", async () => {
      const fn = await newFunction(1);
      const dead = await newQueue();
      const queue = await newQueue({ visibilityTimeout: 1, redrivePolicy: { deadLetterTargetArn: arnOf(dead.name), maxReceiveCount: 2 } });
      answer = (event) => ({ batchItemFailures: event.Records.filter((record) => record.body === 'fail').map((record) => ({ itemIdentifier: record.messageId })) });
      const mapping = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name), functionResponseTypes: ['ReportBatchItemFailures'] });
      await poller.refresh();

      await send(queue, 'ok', 'fail', 'ok too');
      await until(async () => (await bodiesIn(dead)).length === 1, 30);

      expect([await bodiesIn(queue), await bodiesIn(dead)]).toEqual([[], ['fail']]);
      // Called with the three, then twice with the one that failed, which a third receive moved to the dead-letter queue.
      expect(calls.map((event) => event.Records.map((record) => record.body))).toEqual([['ok', 'fail', 'ok too'], ['fail']]);
      await service.remove(ACCOUNT, mapping.uuid);
    }, 40_000);

    it('reads nothing while its mapping is disabled, and reads again once it is enabled', async () => {
      const fn = await newFunction();
      const queue = await newQueue();
      const mapping = await service.create(ACCOUNT, fn.id, { eventSourceArn: arnOf(queue.name), enabled: false });
      await poller.refresh();

      await send(queue, 'waits');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect([calls.length, await bodiesIn(queue)]).toEqual([0, ['waits']]);

      await service.update(ACCOUNT, mapping.uuid, { enabled: true });
      await poller.refresh();
      await until(async () => (await bodiesIn(queue)).length === 0);
      expect(calls.map((event) => event.Records.map((record) => record.body))).toEqual([['waits']]);
      await service.remove(ACCOUNT, mapping.uuid);
    });
  });
});
