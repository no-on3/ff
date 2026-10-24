import { Logger } from '@nestjs/common';
import { onePlan, plan } from '../plans/test-fixtures';
import { BucketEvent, BucketEvents } from '../storage/bucket-events';
import { BucketEventDelivery } from './bucket-event-delivery';
import { Queue } from './queue.entity';

const ACCOUNT = '000000000001';
const QUEUE_ARN = `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:uploads`;
const FUNCTION_ARN = `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:thumbnails`;
const uploads = { id: 'q-1', accountId: ACCOUNT, name: 'uploads', maximumMessageSize: 1_048_576, delaySeconds: 0 } as Queue;
const record = (target: 'queue' | 'function', arn: string): BucketEvent => ({
  kind: 'record',
  accountId: ACCOUNT,
  bucket: 'photos',
  rule: { id: 'r', target, arn, events: ['s3:ObjectCreated:*'], prefix: null, suffix: null },
  record: { eventName: 'ObjectCreated:Put', s3: { object: { key: 'cat.jpg' } } },
});

describe("the delivery of buckets' events", () => {
  let queues: { find: jest.Mock; send: jest.Mock };
  let store: { accountBytes: jest.Mock; sendEvent: jest.Mock };
  let functions: { findOne: jest.Mock };
  let events: BucketEvents;
  let delivery: BucketEventDelivery;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    queues = { find: jest.fn(async () => uploads), send: jest.fn(async () => undefined) };
    store = { accountBytes: jest.fn(async () => 0), sendEvent: jest.fn(async () => undefined) };
    functions = { findOne: jest.fn(async () => ({ id: 'fn-1', accountId: ACCOUNT })) };
    events = new BucketEvents();
    delivery = new BucketEventDelivery(events, queues as never, store as never, onePlan(plan()), functions as never);
    delivery.onModuleInit();
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delivery.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("sends a queue S3's event as a message, its body { Records: [record] }, from the bucket, with the queue's delay", async () => {
    await events.publish(record('queue', QUEUE_ARN));

    expect(queues.find).toHaveBeenCalledWith(ACCOUNT, 'uploads');
    const [[queue, [message]]] = queues.send.mock.calls as Array<[Queue, Array<{ body: string; meta: unknown; sizeBytes: number; delaySeconds: number }>]>;
    expect(queue).toBe(uploads);
    expect(JSON.parse(message.body)).toEqual({ Records: [{ eventName: 'ObjectCreated:Put', s3: { object: { key: 'cat.jpg' } } }] });
    expect([message.meta, message.sizeBytes, message.delaySeconds]).toEqual([{ senderId: 'arn:aws:s3:::photos' }, Buffer.byteLength(message.body), 0]);
  });

  it("calls a function without waiting, S3's event kept in its queue for its worker, as S3 calls Lambda", async () => {
    await events.publish(record('function', FUNCTION_ARN));

    expect(functions.findOne).toHaveBeenCalledWith({ where: { accountId: ACCOUNT, name: 'thumbnails' }, select: { id: true, accountId: true } });
    const [[fn, requestId, body, expiresAt]] = store.sendEvent.mock.calls as Array<[unknown, string, string, Date]>;
    expect([fn, requestId, JSON.parse(body)]).toEqual([{ id: 'fn-1', accountId: ACCOUNT }, expect.stringMatching(/^[0-9a-f-]{36}$/), { Records: [expect.objectContaining({ eventName: 'ObjectCreated:Put' })] }]);
    // Kept for Lambda's six hours, and the grace after them.
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 3600 * 1000);
  });

  it("sends S3's test event to a queue a configuration names, as its body alone", async () => {
    await events.publish({ kind: 'test', accountId: ACCOUNT, bucket: 'photos', queueArn: QUEUE_ARN, body: { Service: 'Amazon S3', Event: 's3:TestEvent' } });

    expect(JSON.parse((queues.send.mock.calls[0] as [Queue, Array<{ body: string }>])[1][0].body)).toEqual({ Service: 'Amazon S3', Event: 's3:TestEvent' });
  });

  it("drops what can't go, saying why: a destination gone, another account's, the plan's room for messages full, a message over the queue's largest", async () => {
    queues.find.mockResolvedValueOnce(null);
    await events.publish(record('queue', QUEUE_ARN));
    functions.findOne.mockResolvedValueOnce(null);
    await events.publish(record('function', FUNCTION_ARN));
    await events.publish(record('queue', 'arn:aws:sqs:tn-tunis-1:000000000002:uploads'));
    store.accountBytes.mockResolvedValueOnce(plan().limits.queueStorageMb * 1024 * 1024);
    await events.publish(record('queue', QUEUE_ARN));
    queues.find.mockResolvedValueOnce({ ...uploads, maximumMessageSize: 10 });
    await events.publish(record('queue', QUEUE_ARN));

    expect([queues.send.mock.calls.length, store.sendEvent.mock.calls.length]).toEqual([0, 0]);
    expect(warnings.mock.calls.map(([message]) => message)).toEqual([
      `An event of bucket photos was not delivered to ${QUEUE_ARN}: it is no queue of the account any more`,
      `An event of bucket photos was not delivered to ${FUNCTION_ARN}: it is no function of the account any more`,
      'An event of bucket photos was not delivered to arn:aws:sqs:tn-tunis-1:000000000002:uploads: it is no queue of the account any more',
      `An event of bucket photos was not delivered to ${QUEUE_ARN}: the account's messages hold ${plan().limits.queueStorageMb} MB together, the Beta plan's limit`,
      expect.stringMatching(new RegExp(`^An event of bucket photos was not delivered to ${QUEUE_ARN}: the event is \\d+ bytes, over the queue's maximum message size of 10$`)),
    ]);
  });
});
