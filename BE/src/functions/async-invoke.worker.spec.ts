import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { FunctionRuntimeError, FunctionThrottledError, FunctionTimeoutError, OrchestratorError } from '../orchestrator/orchestrator.errors';
import { ClaimedEvent } from '../queues/queue-store';
import { AsyncInvokeWorker } from './async-invoke.worker';
import { InvocationSource } from './entities/function-invocation.entity';
import { FunctionStatus } from './entities/function.entity';

const ACCOUNT = '000000000001';
const NOW = new Date('2026-10-23T10:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('AsyncInvokeWorker: the attempts of asynchronous calls (L1)', () => {
  const fn = { id: 'fn-1', accountId: ACCOUNT, status: FunctionStatus.ACTIVE };
  let queues: { claimEvents: jest.Mock; retryEvent: jest.Mock; deleteEvent: jest.Mock };
  let functions: { findOne: jest.Mock; call: jest.Mock };
  let credit: { admit: jest.Mock };
  let accounts: { findOne: jest.Mock };
  let warnings: jest.SpyInstance;
  let worker: AsyncInvokeWorker;

  const event = (values: Partial<ClaimedEvent> = {}): ClaimedEvent => ({
    id: '7',
    functionId: 'fn-1',
    accountId: ACCOUNT,
    requestId: 'req-1',
    body: '{"order":42}',
    attributes: null,
    sentAt: NOW,
    receiveCount: 1,
    ...values,
  });
  /** One tick at NOW over these events, and its attempts waited for. */
  const tick = async (...events: ClaimedEvent[]) => {
    queues.claimEvents.mockResolvedValueOnce(events);
    const claimed = await worker.tick(NOW);
    await worker.settled();
    return claimed;
  };
  const make = (concurrency = 10) =>
    new AsyncInvokeWorker(
      {
        getOrThrow: () => ({ intervalSeconds: 0, concurrency }),
        get: (_key: string, fallback?: unknown) => fallback,
      } as unknown as ConfigService,
      queues as never,
      functions as never,
      credit as never,
      accounts as never,
    );

  beforeEach(() => {
    queues = { claimEvents: jest.fn(async () => []), retryEvent: jest.fn(async () => true), deleteEvent: jest.fn(async () => true) };
    functions = { findOne: jest.fn(async () => fn), call: jest.fn(async () => ({ ok: true, output: 1, invocation: {} })) };
    credit = { admit: jest.fn(async () => undefined) };
    accounts = { findOne: jest.fn(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE })) };
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    worker = make();
  });

  afterEach(() => jest.restoreAllMocks());

  it("runs a claimed event as the API's invoke makes a call, under its request ID, its attempt the claim's, then deletes it", async () => {
    expect(await tick(event())).toBe(1);

    expect(queues.claimEvents).toHaveBeenCalledWith(10, NOW, 90);
    expect(functions.findOne).toHaveBeenCalledWith(ACCOUNT, 'fn-1');
    expect(credit.admit).toHaveBeenCalledWith(ACCOUNT);
    expect(functions.call).toHaveBeenCalledWith(fn, { order: 42 }, { source: InvocationSource.ASYNC, requestId: 'req-1', attempt: 1 });
    expect(queues.deleteEvent).toHaveBeenCalledWith(expect.objectContaining({ id: '7', receiveCount: 1 }));
    expect(warnings).not.toHaveBeenCalled();
  });

  it("puts back a function's failure, a timeout too, for a retry a minute after it ended, with what it keeps of its attempts", async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} });
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionTimeoutError('Task timed out after 5.00 seconds'), invocation: {} });

    await tick(event({ attributes: { other: 'kept as it was' } }), event({ id: '8', requestId: 'req-2' }));

    const [[first, firstAt, firstKept], [second, secondAt, secondKept]] = queues.retryEvent.mock.calls;
    expect([first.id, second.id]).toEqual(['7', '8']);
    for (const at of [firstAt, secondAt]) expect(Math.abs((at as Date).getTime() - later(60).getTime())).toBeLessThan(1000);
    expect([firstKept, secondKept]).toEqual([
      { other: 'kept as it was', failures: 1, throttles: 0, settled: 1 },
      { failures: 1, throttles: 0, settled: 1 },
    ]);
  });

  it("drops an event after its third failure, Lambda's two retries used, and says so", async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} });

    await tick(event({ receiveCount: 3, attributes: { failures: 2, throttles: 0, settled: 2 } }));

    expect(functions.call).toHaveBeenCalledWith(fn, { order: 42 }, expect.objectContaining({ attempt: 3 }));
    expect(queues.deleteEvent).toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledWith('Asynchronous call req-1 of function fn-1 was dropped: its retries are used up');
  });

  it('backs off a throttled call from a second, and a call that failed on FF\'s side the same way, neither a retry', async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionThrottledError('Rate exceeded'), invocation: {} });
    functions.call.mockResolvedValueOnce({ ok: false, error: new OrchestratorError('no endpoints'), invocation: {} });

    await tick(event(), event({ id: '8', requestId: 'req-2', attributes: { failures: 0, throttles: 3, settled: 3 }, receiveCount: 4 }));

    const [[, throttledAt, throttled], [, failedAt, failed]] = queues.retryEvent.mock.calls;
    expect(Math.round(((throttledAt as Date).getTime() - NOW.getTime()) / 1000)).toBe(1);
    expect(Math.round(((failedAt as Date).getTime() - NOW.getTime()) / 1000)).toBe(8);
    expect([throttled, failed]).toEqual([
      { failures: 0, throttles: 1, settled: 1 },
      { failures: 0, throttles: 4, settled: 4 },
    ]);
  });

  it("waits, without a call, while the function isn't ACTIVE, the account isn't active, or its credit has run out", async () => {
    functions.findOne.mockResolvedValueOnce({ ...fn, status: FunctionStatus.ERROR });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.SUSPENDED });
    credit.admit.mockRejectedValueOnce(
      new InsufficientCreditException(
        { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-22T10:33:00Z') },
        { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
        { state: 'stopped', invokesStopAt: new Date('2026-10-23T10:33:00Z') },
      ),
    );

    await tick(event({ id: '1' }));
    await tick(event({ id: '2' }));
    await tick(event({ id: '3' }));

    expect(functions.call).not.toHaveBeenCalled();
    expect(queues.retryEvent.mock.calls.map(([claimed, , kept]) => [claimed.id, kept])).toEqual([
      ['1', { failures: 0, throttles: 1, settled: 1 }],
      ['2', { failures: 0, throttles: 1, settled: 1 }],
      ['3', { failures: 0, throttles: 1, settled: 1 }],
    ]);
  });

  it("deletes the event of a function that's gone", async () => {
    functions.findOne.mockRejectedValueOnce(new NotFoundException('Function with ID fn-1 not found'));

    await tick(event());

    expect([functions.call.mock.calls.length, queues.deleteEvent.mock.calls.length]).toEqual([0, 1]);
    expect(warnings).toHaveBeenCalledWith('Asynchronous call req-1 of function fn-1 was dropped: its function is gone');
  });

  it('counts a claim that kept no outcome, lost with its backend, as a failed attempt, and makes the next', async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} });

    await tick(event({ receiveCount: 2 }));

    expect(functions.call).toHaveBeenCalledWith(fn, { order: 42 }, expect.objectContaining({ attempt: 2 }));
    const [[, at, kept]] = queues.retryEvent.mock.calls;
    // Its second failure: two minutes.
    expect(Math.round(((at as Date).getTime() - NOW.getTime()) / 1000)).toBe(120);
    expect(kept).toEqual({ failures: 2, throttles: 0, settled: 2 });
  });

  it('drops an event past its maximum age without a call', async () => {
    await tick(event({ sentAt: later(-6 * 3600 - 1) }));

    expect([functions.call.mock.calls.length, queues.deleteEvent.mock.calls.length]).toEqual([0, 1]);
    expect(warnings).toHaveBeenCalledWith('Asynchronous call req-1 of function fn-1 was dropped: it reached its maximum age');
  });

  it("leaves an event another claim took when this attempt's lease ended: it stands", async () => {
    queues.deleteEvent.mockResolvedValueOnce(false);

    await tick(event());

    expect(warnings).toHaveBeenCalledWith('The attempt of asynchronous call req-1 ended after its lease: another claim has the event, which stands');
  });

  it('claims only what it has room for, and nothing while full', async () => {
    worker = make(2);
    let finish!: () => void;
    functions.call.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ ok: true, invocation: {} }))));
    queues.claimEvents.mockResolvedValueOnce([event()]);

    await worker.tick(NOW);
    await new Promise((resolve) => setImmediate(resolve));
    queues.claimEvents.mockResolvedValueOnce([event({ id: '8' })]);
    await worker.tick(NOW);
    await worker.tick(NOW);
    finish();
    await worker.settled();

    expect(queues.claimEvents.mock.calls.map(([limit]) => limit)).toEqual([2, 1]);
  });
});
