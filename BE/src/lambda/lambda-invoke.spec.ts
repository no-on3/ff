/**
 * L1: Lambda's Invoke over FF's calls: what the call answers, as Lambda's
 * clients read it (the function's answer as sent, its error as the call's
 * outcome, the version that ran, the call's log when asked); Event queued,
 * DryRun checked; the payload, the headers and the function refused as
 * Lambda refuses them, and the plan's rate, the function's instances and the
 * account's credit as Lambda's throttles.
 */
import { NotFoundException } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { withRequestContext } from '../common/request-context';
import { AsyncInvocationsService } from '../functions/async-invocations.service';
import { FunctionVersion } from '../functions/entities/function-version.entity';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { CallOutcome, CallTarget, FunctionsService } from '../functions/functions.service';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { FunctionRuntimeError, FunctionThrottledError, FunctionTimeoutError, OrchestratorError } from '../orchestrator/orchestrator.errors';
import { plan } from '../plans/test-fixtures';
import { LambdaError } from './lambda-error';
import { CLIENT_CONTEXT_BYTES, LambdaInvoke } from './lambda-invoke';
import { LambdaAnswer, LambdaCaller, operationOf } from './lambda-operations';

const ACCOUNT = '000000000001';
const REGION = 'tn-tunis-1';
const MB = 1024 * 1024;

const fn = (more: Partial<Function> = {}): Function =>
  Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders', status: FunctionStatus.ACTIVE, error: null, ...more });
/** What a qualifier names: the function's version 1, its alias live of version 3; nothing else. */
const TARGETS: Record<string, CallTarget> = {
  '1': { version: Object.assign(new FunctionVersion(), { version: 1 }) },
  live: { version: Object.assign(new FunctionVersion(), { version: 3 }), alias: 'live' },
};
const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const credit = () =>
  new InsufficientCreditException(
    { currency: 'TND', exponent: 3, balanceMinor: -2345n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
    { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
    { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
  );

describe("Lambda's Invoke (L1)", () => {
  let function_: Function;
  /** What the call answers, the next one first. */
  let outcomes: Array<Partial<CallOutcome>>;
  let throttled: boolean;
  let functions: { callTarget: jest.Mock; call: jest.Mock };
  let queue: jest.Mock;
  let admit: jest.Mock;
  let refusedCount: jest.Mock;
  let invoke: LambdaInvoke;

  beforeEach(() => {
    function_ = fn();
    outcomes = [];
    throttled = false;
    functions = {
      callTarget: jest.fn(async (_function: Function, qualifier?: string) => {
        if (qualifier === undefined || qualifier === '$LATEST') return {};
        const target = TARGETS[qualifier];
        if (!target) throw new NotFoundException('no such version or alias');
        return target;
      }),
      call: jest.fn(async () => ({ invocation: {}, ok: true, output: null, ...outcomes.shift() })),
    };
    queue = jest.fn(async () => ({ requestId: 'req-1' }));
    admit = jest.fn(async () => undefined);
    refusedCount = jest.fn();
    const throttler = {
      increment: jest.fn(async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: throttled, timeToBlockExpire: throttled ? 1 : 0 })),
    } as unknown as ThrottlerStorage;
    invoke = new LambdaInvoke(
      functions as unknown as FunctionsService,
      { queue } as unknown as AsyncInvocationsService,
      { admit } as unknown as CreditService,
      { count: refusedCount } as unknown as RefusedInvocationsService,
      throttler,
    );
  });

  /** An Invoke as the front door hands it on: the function the path names, its headers and its body as sent. */
  function send({ qualifier, headers = {}, body = '' }: { qualifier?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<LambdaAnswer> {
    const route = operationOf('POST', '/2015-03-31/functions/orders/invocations');
    if (!route) throw new Error('no Invoke route');
    const caller: LambdaCaller = {
      accountId: ACCOUNT,
      region: REGION,
      key: {} as LambdaCaller['key'],
      plan: plan({ invokesPerSecond: 5 }),
      function_,
      named: { name: 'orders', ...(qualifier ? { qualifier } : {}) },
      mayUse: () => true,
      actor: { id: 'access_key:AKFF', label: 'access key AKFF' },
    };
    const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const call = { operation: route.operation, groups: route.groups, query: new URLSearchParams(), input: {}, body: Buffer.from(body), headers: lowered };
    return withRequestContext({ requestId: 'req-1' }, () => invoke.handlers.Invoke(call, caller));
  }

  /** The error an Invoke throws, as the front door answers it: its status, its type, its message, and its Reason. */
  async function refused(answer: Promise<unknown>): Promise<Array<number | string>> {
    const error = await answer.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof LambdaError)) throw new Error(`not refused in Lambda's words: ${String(error)}`);
    return [error.status, error.type, error.message, ...(error.fields.Reason ? [error.fields.Reason] : [])];
  }

  const callOptions = () => functions.call.mock.calls.map(([, payload, options]) => ({ payload, ...options }));

  describe('RequestResponse, which waits for the call', () => {
    it("answers 200 with the function's answer as its runtime sent it, $LATEST having run it, under the request's ID", async () => {
      outcomes.push({ ok: true, output: { n: 1 }, outputJson: '{ "n" : 1 }' });

      const answer = await send({ body: '{"order": 7}' });

      expect(answer).toEqual({ status: 200, body: Buffer.from('{ "n" : 1 }'), headers: { 'x-amz-executed-version': '$LATEST' } });
      expect(callOptions()).toEqual([
        { payload: { order: 7 }, source: InvocationSource.API, requestId: 'req-1', target: {}, asks: { logTail: false } },
      ]);
      expect(admit).toHaveBeenCalledWith(ACCOUNT);
    });

    it('takes any JSON value as the payload, {} for none, as Lambda gives a function called without one', async () => {
      for (const body of ['"text"', '42', '[1,"two"]', 'null', '']) await send({ body });

      expect(callOptions().map(({ payload }) => payload)).toEqual(['text', 42, [1, 'two'], null, {}]);
    });

    it('names the version that ran: a version named, or an alias\'s; a version or an alias the function hasn\'t is Lambda\'s "Function not found", its ARN with it', async () => {
      const ran = [];
      for (const qualifier of ['1', 'live', '$LATEST']) ran.push((await send({ qualifier })).headers?.['x-amz-executed-version']);

      expect(ran).toEqual(['1', '3', '$LATEST']);
      expect(callOptions().map(({ target }) => target)).toEqual([TARGETS['1'], TARGETS.live, {}]);
      expect(await refused(send({ qualifier: '7' }))).toEqual([
        404,
        'ResourceNotFoundException',
        `Function not found: arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders:7`,
      ]);
    });

    it("asks for the call's log with LogType Tail, and gives it back as X-Amz-Log-Result; LogType None, or none, asks nothing", async () => {
      outcomes.push({ ok: true, output: 1, outputJson: '1', logResult: 'U1RBUlQK' });

      const tailed = await send({ headers: { 'X-Amz-Log-Type': 'Tail' } });
      const plain = await send({ headers: { 'X-Amz-Log-Type': 'None' } });

      expect(tailed.headers).toEqual({ 'x-amz-executed-version': '$LATEST', 'x-amz-log-result': 'U1RBUlQK' });
      expect(plain.headers).toEqual({ 'x-amz-executed-version': '$LATEST' });
      expect(callOptions().map(({ asks }) => asks)).toEqual([{ logTail: true }, { logTail: false }]);
    });

    it("passes the caller's ClientContext on as sent, base64 of a JSON object, its padding optional", async () => {
      const sent = base64Json({ custom: { cart: '7' } });

      await send({ headers: { 'X-Amz-Client-Context': sent } });
      await send({ headers: { 'X-Amz-Client-Context': 'e30' } });

      expect(callOptions().map(({ asks }) => asks)).toEqual([
        { logTail: false, clientContext: sent },
        { logTail: false, clientContext: 'e30' },
      ]);
    });

    it("answers a function that threw, timed out or failed to load with 200 too: FunctionError Unhandled and Lambda's error document, its log with it", async () => {
      outcomes.push(
        { ok: false, error: new FunctionRuntimeError('TypeError', 'bad input'), logResult: 'RU5ECg==' },
        { ok: false, error: new FunctionTimeoutError('Task timed out after 3.00 seconds') },
        { ok: false, error: new FunctionRuntimeError('Runtime.ImportModuleError', "Unable to import module 'index'") },
      );

      const answers = [await send({ headers: { 'X-Amz-Log-Type': 'Tail' } }), await send({ qualifier: '1' }), await send()];

      expect(answers).toEqual([
        {
          status: 200,
          document: { errorType: 'TypeError', errorMessage: 'bad input' },
          headers: { 'x-amz-executed-version': '$LATEST', 'x-amz-log-result': 'RU5ECg==', 'x-amz-function-error': 'Unhandled' },
        },
        {
          status: 200,
          document: { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 3.00 seconds' },
          headers: { 'x-amz-executed-version': '1', 'x-amz-function-error': 'Unhandled' },
        },
        {
          status: 200,
          document: { errorType: 'Runtime.ImportModuleError', errorMessage: "Unable to import module 'index'" },
          headers: { 'x-amz-executed-version': '$LATEST', 'x-amz-function-error': 'Unhandled' },
        },
      ]);
    });

    it("answers no instance free as Lambda's throttle, its Reason the function's instances; the platform's failure as ServiceException", async () => {
      outcomes.push(
        { ok: false, error: new FunctionThrottledError('Rate exceeded: no instance was free within 3.00 seconds') },
        { ok: false, error: new OrchestratorError('no endpoints available for service') },
      );

      expect(await refused(send())).toEqual([
        429,
        'TooManyRequestsException',
        'Rate exceeded: no instance was free within 3.00 seconds',
        'ReservedFunctionConcurrentInvocationLimitExceeded',
      ]);
      // The platform's details stay in the server's log.
      expect(await refused(send())).toEqual([500, 'ServiceException', 'The AWS Lambda service encountered an internal error.']);
    });
  });

  describe('Event and DryRun', () => {
    it("keeps an Event in the function's queue, as the API's asynchronous call, with what it named, and answers 202 at once", async () => {
      const answer = await send({ qualifier: 'live', headers: { 'X-Amz-Invocation-Type': 'Event' }, body: '{"order": 8}' });

      expect(answer).toEqual({ status: 202 });
      expect(queue).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { order: 8 }, 'live');
      // The queue checks the credit, as for the API's asynchronous calls; nothing runs now.
      expect([admit.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
    });

    it('checks a DryRun as a call, and answers 204, nothing run or queued', async () => {
      expect(await send({ headers: { 'X-Amz-Invocation-Type': 'DryRun' } })).toEqual({ status: 204 });
      expect(await refused(send({ qualifier: '7', headers: { 'X-Amz-Invocation-Type': 'DryRun' } }))).toEqual([
        404,
        'ResourceNotFoundException',
        `Function not found: arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders:7`,
      ]);
      expect([queue.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
    });
  });

  describe('refused as Lambda refuses', () => {
    it("refuses an Event past 1 MB by Lambda's words for the operation, before anything is read; a call that waits takes it", async () => {
      const over = `"${'a'.repeat(MB - 1)}"`;

      expect(await refused(send({ headers: { 'X-Amz-Invocation-Type': 'Event' }, body: over }))).toEqual([
        413,
        'RequestEntityTooLargeException',
        'Request must be smaller than 1048576 bytes for the InvokeFunction operation',
      ]);
      expect(functions.callTarget).not.toHaveBeenCalled();
      expect((await send({ body: over })).status).toBe(200);
    });

    it("refuses a payload that isn't JSON, and an InvocationType or a LogType Lambda hasn't, naming those it has", async () => {
      expect(await refused(send({ body: 'not json' }))).toEqual([400, 'InvalidRequestContentException', expect.stringMatching(/^Could not parse request body into json: /)]);
      expect(await refused(send({ headers: { 'X-Amz-Invocation-Type': 'Later' } }))).toEqual([
        400,
        'InvalidParameterValueException',
        'InvocationType must be RequestResponse, Event, DryRun, not Later.',
      ]);
      expect((await refused(send({ headers: { 'X-Amz-Log-Type': 'All' } })))[2]).toBe('LogType must be None, Tail, not All.');
      expect(functions.call).not.toHaveBeenCalled();
    });

    it(`refuses a ClientContext that isn't base64 of a JSON object, or past ${CLIENT_CONTEXT_BYTES} bytes`, async () => {
      for (const sent of [Buffer.from('not json').toString('base64'), base64Json([1]), base64Json(null), '%%%']) {
        expect(await refused(send({ headers: { 'X-Amz-Client-Context': sent } }))).toEqual([
          400,
          'InvalidRequestContentException',
          'Client context must be a valid Base64-encoded JSON object.',
        ]);
      }
      const long = base64Json({ custom: { padding: 'a'.repeat(CLIENT_CONTEXT_BYTES) } });
      expect(await refused(send({ headers: { 'X-Amz-Client-Context': long } }))).toEqual([
        400,
        'InvalidParameterValueException',
        `ClientContext must be at most ${CLIENT_CONTEXT_BYTES} bytes of base64, not ${long.length}.`,
      ]);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it.each([
      [FunctionStatus.CREATING, 'Pending'],
      [FunctionStatus.ERROR, 'Failed'],
    ])('refuses $LATEST while the function is %s, naming its state as Lambda does; a version runs as it was published', async (status, state) => {
      function_ = fn({ status });

      for (const type of ['RequestResponse', 'Event']) {
        expect(await refused(send({ headers: { 'X-Amz-Invocation-Type': type } }))).toEqual([
          409,
          'ResourceConflictException',
          `The operation cannot be performed at this time. The function is currently in the following state: ${state}`,
        ]);
      }
      expect((await send({ qualifier: '1' })).status).toBe(200);
      expect(callOptions().map(({ target }) => target)).toEqual([TARGETS['1']]);
    });

    it("refuses a call past the plan's invocations per second as Lambda's throttle, counted as refused, nothing run", async () => {
      throttled = true;

      const error = await send().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(LambdaError);
      expect(error).toMatchObject({
        status: 429,
        type: 'TooManyRequestsException',
        message: 'Rate exceeded: the Beta plan allows 5 invocations per second.',
        fields: { Reason: 'CallerRateLimitExceeded' },
        headers: { 'retry-after': '1' },
      });
      expect(refusedCount).toHaveBeenCalledWith(ACCOUNT, 'f-orders');
      expect([admit.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
    });

    it("refuses a call once the account's credit ran out with Lambda's 429, saying so, whether it waits or is queued", async () => {
      admit.mockRejectedValueOnce(credit());
      queue.mockRejectedValueOnce(credit());

      for (const type of ['RequestResponse', 'Event']) {
        const [status, name, message] = await refused(send({ headers: { 'X-Amz-Invocation-Type': type } }));
        expect([status, name]).toEqual([429, 'TooManyRequestsException']);
        expect(String(message)).toMatch(/^The account's credit ran out\. Invokes stopped at 2026-10-18 10:33 UTC: /);
      }
      expect(functions.call).not.toHaveBeenCalled();
    });
  });
});
