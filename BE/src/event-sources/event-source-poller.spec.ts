import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { Received } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EventSourcePoller } from './event-source-poller';
import { sqsRecord } from './sqs-event';

const ACCOUNT = '000000000001';
const ARN = `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders`;
const queue = { id: 'q-1', accountId: ACCOUNT, name: 'orders', visibilityTimeout: 30 } as Queue;
const active = { id: 'fn-1', accountId: ACCOUNT, name: 'orders-worker', status: FunctionStatus.ACTIVE, maxInstances: 3, timeout: 3 } as Function;

let n = 0;
const message = (body = 'order'): Received => {
  n += 1;
  return {
    id: String(n),
    messageId: `7e4d1c2a-0000-4000-8000-${String(n).padStart(12, '0')}`,
    body,
    meta: { senderId: 'AKFF7Q2MLKX4RTZB3W5N' },
    sentAt: new Date('2026-10-24T08:00:00Z'),
    receiveCount: 1,
    firstReceivedAt: new Date('2026-10-24T08:00:01Z'),
    sizeBytes: Buffer.byteLength(body),
  };
};
const mapping = (values: Partial<EventSourceMapping> = {}): EventSourceMapping & { queue: Queue } => ({
  id: 'm-1',
  accountId: ACCOUNT,
  functionId: 'fn-1',
  queueId: 'q-1',
  queue,
  batchSize: 10,
  maximumBatchingWindowInSeconds: 0,
  reportBatchItemFailures: false,
  maximumConcurrency: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...values,
});

/** Waits, a turn of the event loop at a time, until `condition` holds: 5 s at most, as a batching window of 1 s takes its second. */
async function until(condition: () => boolean): Promise<void> {
  const ends = Date.now() + 5000;
  while (!condition() && Date.now() < ends) await new Promise((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error('the condition never held');
}

describe('the event source poller, which reads the queues functions are mapped to', () => {
  /** The queue's messages that can be received now. */
  let waiting: Received[];
  let queues: { receive: jest.Mock; deleteMessages: jest.Mock };
  let functions: { findOne: jest.Mock; call: jest.Mock };
  let accounts: { findOne: jest.Mock };
  let credit: { admit: jest.Mock };
  let mappings: { find: jest.Mock };
  let counts: { count: jest.Mock };
  let poller: EventSourcePoller;
  let logs: jest.SpyInstance;
  let warnings: jest.SpyInstance;

  const make = (refreshSeconds = 10) =>
    new EventSourcePoller(
      new ConfigService({ eventSources: { refreshSeconds }, sqs: { region: 'tn-tunis-1' } }),
      mappings as never,
      accounts as never,
      queues as never,
      // A wait for a message ends at the next turn, as PostgreSQL's NOTIFY or the fallback would end it.
      { wait: jest.fn(() => new Promise((resolve) => setImmediate(resolve))) } as never,
      functions as never,
      credit as never,
      counts as never,
    );
  const deleted = () => queues.deleteMessages.mock.calls.flatMap(([, receipts]: [Queue, Array<{ id: string }>]) => receipts.map((receipt) => receipt.id));
  const records = (call: number) => (functions.call.mock.calls[call][1] as { Records: Array<{ body: string }> }).Records;

  beforeEach(() => {
    n = 0;
    waiting = [];
    queues = { receive: jest.fn(async (_queue: Queue, max: number) => waiting.splice(0, max)), deleteMessages: jest.fn(async () => undefined) };
    functions = { findOne: jest.fn(async () => active), call: jest.fn(async () => ({ ok: true, output: null, invocation: {} })) };
    accounts = { findOne: jest.fn(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE, storageDisabledAt: null })) };
    credit = { admit: jest.fn(async () => undefined) };
    mappings = { find: jest.fn(async () => [mapping()]) };
    counts = { count: jest.fn() };
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    poller = make();
  });

  afterEach(async () => {
    poller.onModuleDestroy();
    await poller.settled();
    jest.restoreAllMocks();
  });

  it("calls the function with SQS's event for a batch, its history's source sqs, and deletes the batch once the call succeeded", async () => {
    const batch = [message('one'), message('two')];
    waiting.push(...batch);

    await poller.refresh();
    await until(() => deleted().length === 2);

    expect(queues.receive).toHaveBeenCalledWith(queue, 10, 30, expect.any(Date));
    expect(functions.call).toHaveBeenCalledWith(active, { Records: batch.map((received) => sqsRecord(received, ARN, 'tn-tunis-1')) }, { source: InvocationSource.SQS });
    expect(deleted()).toEqual(['1', '2']);
    expect(queues.deleteMessages.mock.calls[0][1]).toEqual(batch.map(({ id, receiveCount, messageId }) => ({ id, receiveCount, messageId })));
  });

  it('counts a batch as the request that would have received it, each 64 KB of its messages a request, and the deletes after its call as not billed; finding nothing counts nothing', async () => {
    waiting.push(message('x'.repeat(70_000)), message('two'));

    await poller.refresh();
    await until(() => deleted().length === 2);
    // The reader goes on finding nothing.
    await until(() => queues.receive.mock.calls.length >= 3);

    const named = { queueId: 'q-1', accountId: ACCOUNT, queueName: 'orders' };
    expect(counts.count.mock.calls).toEqual([[{ ...named, requests: 2, received: 2 }], [{ ...named, requests: 0, deleted: 2 }]]);
  });

  it("deletes nothing of a call that failed: its messages come back after the queue's visibility timeout", async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new Error('x'), visible: 'TypeError: x is undefined', invocation: {} });
    waiting.push(message(), message());

    await poller.refresh();
    await until(() => functions.call.mock.calls.length === 1);
    await poller.settled();

    expect(queues.deleteMessages).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledWith(
      "The call of function orders-worker with 2 messages of the queue orders failed, which come back after the queue's visibility timeout: TypeError: x is undefined",
    );
  });

  it('with ReportBatchItemFailures, deletes all but the messages the answer names; an answer that is no batch response deletes none', async () => {
    mappings.find.mockResolvedValue([mapping({ reportBatchItemFailures: true })]);
    const batch = [message(), message(), message()];
    functions.call.mockResolvedValueOnce({ ok: true, output: { batchItemFailures: [{ itemIdentifier: batch[1].messageId }] }, invocation: {} });
    functions.call.mockResolvedValueOnce({ ok: true, output: 'done', invocation: {} });
    waiting.push(...batch);

    await poller.refresh();
    await until(() => deleted().length === 2);
    waiting.push(message());
    await until(() => functions.call.mock.calls.length === 2);
    await poller.settled();

    expect(deleted()).toEqual(['1', '3']);
    expect(warnings).toHaveBeenCalledWith("Function orders-worker answered 1 message of the queue orders with no batch response Lambda takes: they all come back after the queue's visibility timeout");
  });

  it("without ReportBatchItemFailures, deletes the whole batch whatever the answer, as Lambda reads no answer then", async () => {
    functions.call.mockResolvedValueOnce({ ok: true, output: { batchItemFailures: [{ itemIdentifier: 'x' }] }, invocation: {} });
    waiting.push(message(), message());

    await poller.refresh();
    await until(() => deleted().length === 2);
  });

  it("with no batching window, calls with what one receive gives; with one, receives until the batch is full", async () => {
    waiting.push(message(), message(), message());
    await poller.refresh();
    await until(() => functions.call.mock.calls.length === 1);
    expect(records(0)).toHaveLength(3);
    poller.onModuleDestroy();
    await poller.settled();

    // 15 a batch, more than a receive's 10, which needs a window.
    poller = make();
    mappings.find.mockResolvedValue([mapping({ batchSize: 15, maximumBatchingWindowInSeconds: 1 })]);
    waiting.push(...Array.from({ length: 25 }, () => message()));
    const before = queues.receive.mock.calls.length;
    await poller.refresh();
    await until(() => functions.call.mock.calls.length === 3);

    expect([records(1).length, records(2).length]).toEqual([15, 10]);
    // A receive gives 10 at most: 10 and 5 for the first batch, then 10, and the window waits for 5 more until it ends.
    expect(queues.receive.mock.calls.slice(before, before + 4).map(([, max]: [Queue, number]) => max)).toEqual([10, 5, 10, 5]);
  });

  it('never makes an event over 6 MB: a message that would take it past begins the next batch', async () => {
    mappings.find.mockResolvedValue([mapping({ maximumBatchingWindowInSeconds: 1 })]);
    // Ten messages of a million characters each: six fit in an event, the seventh would pass 6 MB.
    waiting.push(...Array.from({ length: 10 }, () => message('x'.repeat(1_000_000))));

    await poller.refresh();
    await until(() => functions.call.mock.calls.length === 2);

    expect([records(0).length, records(1).length]).toEqual([6, 4]);
    expect(Buffer.byteLength(JSON.stringify(functions.call.mock.calls[0][1]))).toBeLessThanOrEqual(6 * 1024 * 1024);
    await until(() => deleted().length === 10);
  });

  it("has as many batches in calls at once as its maximum concurrency, within the function's instances", async () => {
    const calls: Array<() => void> = [];
    functions.call.mockImplementation(() => new Promise((resolve) => calls.push(() => resolve({ ok: true, output: null, invocation: {} }))));
    mappings.find.mockResolvedValue([mapping({ batchSize: 1, maximumConcurrency: 2 })]);
    waiting.push(...Array.from({ length: 6 }, () => message()));

    await poller.refresh();
    await until(() => calls.length === 2);
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(2);
    calls[0]();
    await until(() => calls.length === 3);
    poller.onModuleDestroy();
    calls.slice(1).forEach((release) => release());
    await poller.settled();

    // Without a maximum, the function's three instances.
    poller = make();
    calls.length = 0;
    mappings.find.mockResolvedValue([mapping({ id: 'm-2', batchSize: 1 })]);
    await poller.refresh();
    await until(() => calls.length === 3);
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(3);
    poller.onModuleDestroy();
    calls.forEach((release) => release());
  });

  it.each([
    ['the function is not ACTIVE', () => functions.findOne.mockResolvedValue({ ...active, status: FunctionStatus.ERROR })],
    ['the function is gone', () => functions.findOne.mockRejectedValue(new NotFoundException())],
    ['the account is not active', () => accounts.findOne.mockResolvedValue({ id: ACCOUNT, status: AccountStatus.SUSPENDED, storageDisabledAt: null })],
    ["FF turned the account's databases, buckets and queues off", () => accounts.findOne.mockResolvedValue({ id: ACCOUNT, status: AccountStatus.ACTIVE, storageDisabledAt: new Date() })],
    [
      "the account's credit has run out",
      () =>
        credit.admit.mockRejectedValue(
          new InsufficientCreditException(
            { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
            { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
            { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
          ),
        ),
    ],
  ])('receives nothing while %s, and says so once', async (why, set) => {
    set();
    waiting.push(message());

    await poller.refresh();
    await until(() => logs.mock.calls.length > 0);

    expect(logs).toHaveBeenCalledWith(`The queue orders waits for function fn-1: ${why}`);
    expect([queues.receive.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
  });

  it('reads a mapping made, and stops reading one disabled or deleted, as the mappings are loaded again', async () => {
    mappings.find.mockResolvedValue([]);
    await poller.refresh();
    waiting.push(message());
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(queues.receive).not.toHaveBeenCalled();

    mappings.find.mockResolvedValue([mapping()]);
    await poller.changed();
    await until(() => deleted().length === 1);

    mappings.find.mockResolvedValue([]);
    await poller.refresh();
    const receives = queues.receive.mock.calls.length;
    waiting.push(message());
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect([queues.receive.mock.calls.length, deleted()]).toEqual([receives, ['1']]);
  });

  it('reads nothing on a backend whose refresh is 0', async () => {
    poller = make(0);
    poller.onModuleInit();
    await poller.changed();

    expect(mappings.find).not.toHaveBeenCalled();
  });
});
