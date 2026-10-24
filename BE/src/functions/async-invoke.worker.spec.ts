import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { FunctionRuntimeError, FunctionThrottledError, FunctionTimeoutError, OrchestratorError } from '../orchestrator/orchestrator.errors';
import { plan } from '../plans/test-fixtures';
import { ClaimedEvent } from '../queues/queue-store';
import { LAMBDA_RETRY_POLICY, MAX_ASYNC_INPUT_BYTES } from './async-invoke';
import { AsyncInvokeWorker } from './async-invoke.worker';
import { InvocationSource } from './entities/function-invocation.entity';
import { FunctionStatus } from './entities/function.entity';

const ACCOUNT = '000000000001';
const NOW = new Date('2026-10-23T10:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('AsyncInvokeWorker: the attempts of asynchronous calls (L1)', () => {
  const fn = { id: 'fn-1', name: 'orders', accountId: ACCOUNT, status: FunctionStatus.ACTIVE };
  const records = { id: 'fn-2', name: 'records', accountId: ACCOUNT, status: FunctionStatus.ACTIVE };
  const RECORDS_ARN = `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:records`;
  const QUEUE_ARN = `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:failed-orders`;
  const failedOrders = { id: 'queue-1', accountId: ACCOUNT, name: 'failed-orders', maximumMessageSize: 1_048_576, delaySeconds: 0 };
  let queues: {
    claimEvents: jest.Mock;
    retryEvent: jest.Mock;
    deleteEvent: jest.Mock;
    deleteEventAndSend: jest.Mock;
    deleteEventAnd: jest.Mock;
    accountBytes: jest.Mock;
  };
  let configs: { settingsFor: jest.Mock; arnOf: (f: { accountId: string; name: string }) => string; destinationFunction: jest.Mock; destinationQueue: jest.Mock };
  /** PostgreSQL's word that a call was kept, as the worker listens for it. */
  let told: (() => void) | undefined;
  let events: { onAsyncCall: jest.Mock };
  let customerQueues: { send: jest.Mock };
  let plans: { forAccount: jest.Mock };
  let counts: { count: jest.Mock };
  let functions: { findOne: jest.Mock; call: jest.Mock };
  let credit: { admit: jest.Mock };
  let accounts: { findOne: jest.Mock };
  let schedules: { update: jest.Mock };
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
  const make = (concurrency = 10, intervalSeconds = 0) =>
    new AsyncInvokeWorker(
      {
        getOrThrow: () => ({ intervalSeconds, concurrency }),
        get: (_key: string, fallback?: unknown) => fallback,
      } as unknown as ConfigService,
      queues as never,
      functions as never,
      credit as never,
      accounts as never,
      configs as never,
      schedules as never,
      events as never,
      customerQueues as never,
      plans as never,
      counts as never,
    );
  /** The record the worker handed its destination, as the destination's event. */
  const handed = () => JSON.parse(queues.deleteEventAndSend.mock.calls[0][3] as string) as Record<string, unknown>;

  beforeEach(() => {
    queues = {
      claimEvents: jest.fn(async () => []),
      retryEvent: jest.fn(async () => true),
      deleteEvent: jest.fn(async () => true),
      deleteEventAndSend: jest.fn(async () => true),
      // The event deleted, then the writes of the transaction, here with its manager's stand-in.
      deleteEventAnd: jest.fn(async (_event: unknown, then: (manager: unknown) => Promise<void>) => {
        await then('the transaction');
        return true;
      }),
      accountBytes: jest.fn(async () => 0),
    };
    configs = {
      settingsFor: jest.fn(async () => ({ policy: LAMBDA_RETRY_POLICY, onSuccess: null, onFailure: null })),
      arnOf: (f) => `arn:aws:lambda:tn-tunis-1:${f.accountId}:function:${f.name}`,
      destinationFunction: jest.fn(async () => records),
      destinationQueue: jest.fn(async () => failedOrders),
    };
    told = undefined;
    events = {
      onAsyncCall: jest.fn((subscriber: () => void) => {
        told = subscriber;
        return () => (told = undefined);
      }),
    };
    customerQueues = { send: jest.fn(async () => undefined) };
    plans = { forAccount: jest.fn(async () => plan()) };
    counts = { count: jest.fn() };
    functions = { findOne: jest.fn(async () => fn), call: jest.fn(async () => ({ ok: true, output: 1, invocation: {} })) };
    credit = { admit: jest.fn(async () => undefined) };
    accounts = { findOne: jest.fn(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE })) };
    schedules = { update: jest.fn(async () => ({ affected: 1 })) };
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
    // Each keeps its failure, for its record should it end at a later claim.
    expect([firstKept, secondKept]).toEqual([
      {
        other: 'kept as it was',
        failures: 1,
        throttles: 0,
        settled: 1,
        lastResponse: { statusCode: 200, functionError: 'Unhandled', payload: { errorType: 'Error', errorMessage: 'boom' } },
      },
      {
        failures: 1,
        throttles: 0,
        settled: 1,
        lastResponse: { statusCode: 200, functionError: 'Unhandled', payload: { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 5.00 seconds' } },
      },
    ]);
  });

  it("keeps no more than 4,096 characters of a failure's message with its event", async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'x'.repeat(10_000)), invocation: {} });

    await tick(event());

    expect(queues.retryEvent.mock.calls[0][2].lastResponse.payload.errorMessage).toHaveLength(4096);
  });

  it("drops an event after its third failure, Lambda's two retries used, and says so", async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} });

    await tick(event({ receiveCount: 3, attributes: { failures: 2, throttles: 0, settled: 2 } }));

    expect(functions.call).toHaveBeenCalledWith(fn, { order: 42 }, expect.objectContaining({ attempt: 3 }));
    expect(queues.deleteEvent).toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledWith('Asynchronous call req-1 of function fn-1 was dropped: its retries are used up');
  });

  it('backs off a throttled call from a second, and a call that failed on FF\'s side the same way, neither a retry', async () => {
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionThrottledError('Rate exceeded'), visible: 'Rate exceeded', invocation: {} });
    functions.call.mockResolvedValueOnce({
      ok: false,
      error: new OrchestratorError('no endpoints'),
      visible: 'The invocation failed because of an internal error (request req-2).',
      invocation: {},
    });

    await tick(event(), event({ id: '8', requestId: 'req-2', attributes: { failures: 0, throttles: 3, settled: 3 }, receiveCount: 4 }));

    const [[, throttledAt, throttled], [, failedAt, failed]] = queues.retryEvent.mock.calls;
    expect(Math.round(((throttledAt as Date).getTime() - NOW.getTime()) / 1000)).toBe(1);
    expect(Math.round(((failedAt as Date).getTime() - NOW.getTime()) / 1000)).toBe(8);
    // FF's own failure keeps only what the caller may see of it.
    expect([throttled, failed]).toEqual([
      { failures: 0, throttles: 1, settled: 1, lastResponse: { statusCode: 429, payload: { errorType: 'TooManyRequestsException', errorMessage: 'Rate exceeded' } } },
      {
        failures: 0,
        throttles: 4,
        settled: 4,
        lastResponse: { statusCode: 500, payload: { errorType: 'ServiceException', errorMessage: 'The invocation failed because of an internal error (request req-2).' } },
      },
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
    expect(queues.retryEvent.mock.calls.map(([claimed, , kept]) => [claimed.id, kept.throttles, kept.lastResponse.payload.errorMessage])).toEqual([
      ['1', 1, "FF couldn't make the call: the function is not ACTIVE"],
      ['2', 1, "FF couldn't make the call: the account is not active"],
      ['3', 1, "FF couldn't make the call: the account's credit has run out"],
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
    expect(kept).toEqual(expect.objectContaining({ failures: 2, throttles: 0, settled: 2 }));
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

  it("runs a schedule's run as the schedule's call, and says each attempt's outcome on the schedule, unless a later run has replaced it there", async () => {
    const run = (id: string) => event({ id, requestId: `req-${id}`, attributes: { origin: 'schedule', scheduleId: 's-1' } });
    functions.call
      .mockResolvedValueOnce({ ok: true, output: null, invocation: {} })
      .mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: { status: 'ERROR' } })
      .mockResolvedValueOnce({ ok: false, error: new FunctionTimeoutError('Task timed out after 5.00 seconds'), invocation: { status: 'TIMEOUT' } })
      .mockResolvedValueOnce({ ok: false, error: new FunctionThrottledError('Rate exceeded'), visible: 'Rate exceeded', invocation: {} });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.ACTIVE });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.ACTIVE });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.ACTIVE });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.ACTIVE });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.SUSPENDED });

    for (const id of ['1', '2', '3', '4', '5']) await tick(run(id));
    await tick(event({ id: '6', requestId: 'req-6' }));

    expect(functions.call.mock.calls.map(([, , options]) => options.source)).toEqual([
      InvocationSource.SCHEDULE,
      InvocationSource.SCHEDULE,
      InvocationSource.SCHEDULE,
      InvocationSource.SCHEDULE,
      InvocationSource.ASYNC,
    ]);
    expect(schedules.update.mock.calls).toEqual([
      [{ id: 's-1', lastRequestId: 'req-1' }, { lastOutcome: 'success' }],
      [{ id: 's-1', lastRequestId: 'req-2' }, { lastOutcome: 'error' }],
      [{ id: 's-1', lastRequestId: 'req-3' }, { lastOutcome: 'timeout' }],
      [{ id: 's-1', lastRequestId: 'req-4' }, { lastOutcome: 'throttled' }],
      [{ id: 's-1', lastRequestId: 'req-5' }, { lastOutcome: 'waiting: the account is not active' }],
    ]);
  });

  it("follows the function's own settings: no retry when it allows none", async () => {
    configs.settingsFor.mockResolvedValueOnce({ policy: { maximumRetryAttempts: 0, maximumEventAgeSeconds: 3600 }, onSuccess: null, onFailure: null });
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} });

    await tick(event());

    expect(configs.settingsFor).toHaveBeenCalledWith('fn-1');
    expect([queues.retryEvent.mock.calls.length, queues.deleteEvent.mock.calls.length]).toEqual([0, 1]);
  });

  it("hands a call that succeeded to its onSuccess destination, Lambda's record of it, in the transaction that deletes the event", async () => {
    configs.settingsFor.mockResolvedValueOnce({ policy: LAMBDA_RETRY_POLICY, onSuccess: RECORDS_ARN, onFailure: null });
    functions.call.mockResolvedValueOnce({ ok: true, output: { receipt: 'r-42' }, invocation: {} });

    await tick(event({ receiveCount: 2, attributes: { failures: 1, throttles: 0, settled: 1 } }));

    const [[ended, target, requestId, , expiresAt]] = queues.deleteEventAndSend.mock.calls;
    expect([ended.id, target, requestId, queues.deleteEvent.mock.calls.length]).toEqual(['7', records, expect.stringMatching(/^[0-9a-f-]{36}$/), 0]);
    expect((expiresAt as Date).getTime() - NOW.getTime()).toBeGreaterThanOrEqual(7 * 3600 * 1000 - 1000);
    expect(configs.destinationFunction).toHaveBeenCalledWith(ACCOUNT, RECORDS_ARN);
    expect(handed()).toEqual({
      version: '1.0',
      timestamp: expect.stringMatching(/^2026-10-23T10:00:0\d\.\d{3}Z$/),
      requestContext: { requestId: 'req-1', functionArn: `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:orders:$LATEST`, condition: 'Success', approximateInvokeCount: 2 },
      requestPayload: { order: 42 },
      responseContext: { statusCode: 200, executedVersion: '$LATEST' },
      responsePayload: { receipt: 'r-42' },
    });
  });

  it('hands a call whose retries are used up to its onFailure destination, with the error its function gave', async () => {
    configs.settingsFor.mockResolvedValueOnce({ policy: LAMBDA_RETRY_POLICY, onSuccess: null, onFailure: RECORDS_ARN });
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('TypeError', 'x is undefined'), invocation: {} });

    await tick(event({ receiveCount: 3, attributes: { failures: 2, throttles: 0, settled: 2 } }));

    expect(handed()).toMatchObject({
      requestContext: { condition: 'RetriesExhausted', approximateInvokeCount: 3 },
      responseContext: { statusCode: 200, executedVersion: '$LATEST', functionError: 'Unhandled' },
      responsePayload: { errorType: 'TypeError', errorMessage: 'x is undefined' },
    });
    // A function as the destination: no queue's request.
    expect(counts.count).not.toHaveBeenCalled();
  });

  it('hands a call too old at its claim to onFailure, with the last failure it kept; one with no attempt run, without an answer', async () => {
    configs.settingsFor.mockResolvedValue({ policy: LAMBDA_RETRY_POLICY, onSuccess: null, onFailure: RECORDS_ARN });
    const lastResponse = { statusCode: 429, payload: { errorType: 'TooManyRequestsException', errorMessage: 'Rate exceeded' } };

    await tick(event({ sentAt: later(-6 * 3600 - 1), receiveCount: 9, attributes: { failures: 0, throttles: 8, settled: 8, lastResponse } }));
    await tick(event({ id: '8', requestId: 'req-2', sentAt: later(-6 * 3600 - 1) }));

    expect(functions.call).not.toHaveBeenCalled();
    const [first, second] = queues.deleteEventAndSend.mock.calls.map(([, , , body]) => JSON.parse(body as string) as Record<string, unknown>);
    expect(first).toMatchObject({ requestContext: { condition: 'EventAgeExceeded' }, responseContext: { statusCode: 429 }, responsePayload: lastResponse.payload });
    expect([second.requestContext, 'responseContext' in second]).toEqual([expect.objectContaining({ requestId: 'req-2', condition: 'EventAgeExceeded' }), false]);
  });

  it("deletes the event of a call whose destination is gone, or whose record is over an asynchronous call's 1 MB, saying the record wasn't delivered", async () => {
    configs.settingsFor.mockResolvedValue({ policy: LAMBDA_RETRY_POLICY, onSuccess: RECORDS_ARN, onFailure: null });
    configs.destinationFunction.mockResolvedValueOnce(undefined);
    functions.call.mockResolvedValueOnce({ ok: true, output: 'small', invocation: {} });
    functions.call.mockResolvedValueOnce({ ok: true, output: 'x'.repeat(MAX_ASYNC_INPUT_BYTES), invocation: {} });

    await tick(event());
    await tick(event({ id: '8', requestId: 'req-2' }));

    expect([queues.deleteEventAndSend.mock.calls.length, queues.deleteEvent.mock.calls.length]).toEqual([0, 2]);
    expect(warnings).toHaveBeenCalledWith(`The record of asynchronous call req-1 of function fn-1 was not delivered: its destination ${RECORDS_ARN} is no function of the account any more`);
    expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/^The record of asynchronous call req-2 of function fn-1 was not delivered: its record is \d+ bytes, over an asynchronous call's 1048576$/));
  });

  it('claims only what it has room for, nothing while full, and again as an attempt ends after a claim that took all the room', async () => {
    worker = make(2);
    const finishes: Array<() => void> = [];
    functions.call.mockImplementation(() => new Promise((resolve) => finishes.push(() => resolve({ ok: true, invocation: {} }))));
    queues.claimEvents.mockResolvedValueOnce([event(), event({ id: '8' })]);

    await worker.tick(NOW);
    await new Promise((resolve) => setImmediate(resolve));
    await worker.tick(NOW);
    finishes[0]();
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishes[1]();
    await worker.settled();

    // Full: no claim; the first attempt over, one with its room, which found none due; the second over, none.
    expect(queues.claimEvents.mock.calls.map(([limit]) => limit)).toEqual([2, 1]);
  });

  it('claims as soon as PostgreSQL tells it a call was kept, and once more after a claim a call came during', async () => {
    worker = make(10, 60);
    worker.onModuleInit();
    let claimed!: (events: ClaimedEvent[]) => void;
    queues.claimEvents.mockImplementationOnce(() => new Promise((resolve) => (claimed = resolve)));

    told?.();
    told?.();
    expect(queues.claimEvents).toHaveBeenCalledTimes(1);
    claimed([]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(queues.claimEvents).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
    expect(told).toBeUndefined();
  });

  it("hands a call's record to a queue of the account as a message, its body Lambda's record, in the transaction that deletes the event", async () => {
    configs.settingsFor.mockResolvedValueOnce({ policy: LAMBDA_RETRY_POLICY, onSuccess: null, onFailure: QUEUE_ARN });
    functions.call.mockResolvedValueOnce({ ok: false, error: new FunctionRuntimeError('TypeError', 'x is undefined'), invocation: {} });

    await tick(event({ receiveCount: 3, attributes: { failures: 2, throttles: 0, settled: 2 } }));

    expect(configs.destinationQueue).toHaveBeenCalledWith(ACCOUNT, QUEUE_ARN);
    expect([queues.deleteEventAnd.mock.calls[0][0].id, queues.deleteEvent.mock.calls.length, queues.deleteEventAndSend.mock.calls.length]).toEqual(['7', 0, 0]);
    const [[queue, [message], at, manager]] = customerQueues.send.mock.calls;
    expect([queue, manager, (at as Date).getTime() >= NOW.getTime()]).toEqual([failedOrders, 'the transaction', true]);
    expect(message).toEqual({
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      body: expect.any(String),
      meta: { senderId: `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:orders` },
      sizeBytes: Buffer.byteLength(message.body as string),
      delaySeconds: 0,
    });
    expect(JSON.parse(message.body as string)).toMatchObject({
      version: '1.0',
      requestContext: { requestId: 'req-1', condition: 'RetriesExhausted', approximateInvokeCount: 3 },
      requestPayload: { order: 42 },
      responsePayload: { errorType: 'TypeError', errorMessage: 'x is undefined' },
    });
    // As the request Lambda makes to SQS: billed, and the message counted as sent.
    expect(counts.count.mock.calls).toEqual([
      [{ queueId: 'queue-1', accountId: ACCOUNT, queueName: 'failed-orders', requests: 1, sentSizes: [Buffer.byteLength(message.body as string)] }],
    ]);
  });

  it("deletes the event of a call whose queue is gone, whose record is over the queue's largest message, or whose account's messages hold the plan's room, saying the record wasn't delivered", async () => {
    configs.settingsFor.mockResolvedValue({ policy: LAMBDA_RETRY_POLICY, onSuccess: QUEUE_ARN, onFailure: null });
    configs.destinationQueue.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...failedOrders, maximumMessageSize: 1024 });
    functions.call.mockResolvedValue({ ok: true, output: 'x'.repeat(2000), invocation: {} });

    await tick(event());
    await tick(event({ id: '8', requestId: 'req-2' }));
    queues.accountBytes.mockResolvedValueOnce(plan().limits.queueStorageMb * 1024 * 1024);
    await tick(event({ id: '9', requestId: 'req-3' }));

    expect([customerQueues.send.mock.calls.length, queues.deleteEvent.mock.calls.length]).toEqual([0, 3]);
    expect(warnings).toHaveBeenCalledWith(`The record of asynchronous call req-1 of function fn-1 was not delivered: its destination ${QUEUE_ARN} is no queue of the account any more`);
    expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/^The record of asynchronous call req-2 of function fn-1 was not delivered: its record is \d+ bytes, over the queue's maximum message size of 1024$/));
    expect(warnings).toHaveBeenCalledWith(
      `The record of asynchronous call req-3 of function fn-1 was not delivered: the account's messages hold ${plan().limits.queueStorageMb} MB together, the Beta plan's limit`,
    );
  });

  it("sends no record to a queue while FF has the account's queues off, saying so, as their keys are refused", async () => {
    configs.settingsFor.mockResolvedValueOnce({ policy: LAMBDA_RETRY_POLICY, onSuccess: QUEUE_ARN, onFailure: null });
    accounts.findOne.mockResolvedValueOnce({ id: ACCOUNT, status: AccountStatus.ACTIVE }).mockResolvedValueOnce({ id: ACCOUNT, storageDisabledAt: new Date() });

    await tick(event());

    expect([customerQueues.send.mock.calls.length, queues.deleteEvent.mock.calls.length, configs.destinationQueue.mock.calls.length]).toEqual([0, 1, 0]);
    expect(warnings).toHaveBeenCalledWith("The record of asynchronous call req-1 of function fn-1 was not delivered: FF turned the account's databases, buckets and queues off");
  });
});
