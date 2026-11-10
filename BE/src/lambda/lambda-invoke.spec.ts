/**
 * L1: Lambda's Invoke over FF's calls: what the call answers, as Lambda's
 * clients read it (the function's answer as sent, its error as the call's
 * outcome, the version that ran, the call's log when asked); Event queued,
 * DryRun checked; the payload, the headers and the function refused as
 * Lambda refuses them, and the plan's rate, the function's instances and the
 * account's credit as Lambda's throttles; the call's trace, the caller's or a
 * new one, given back. The requests and their answers are
 * lambda-invoke-examples.json's, which ff local's front door reads too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { TRACE_HEADER } from '../functions/trace';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { FunctionRuntimeError, FunctionThrottledError, FunctionTimeoutError, OrchestratorError } from '../orchestrator/orchestrator.errors';
import { plan } from '../plans/test-fixtures';
import { LambdaError } from './lambda-error';
import { CLIENT_CONTEXT_BYTES, LambdaInvoke } from './lambda-invoke';
import { LambdaAnswer } from './lambda-operations';
import { ACCOUNT, REGION, lambdaCall, lambdaCaller, lambdaRefusal } from './test-fixtures';

/** A case of the table: a request, what its call did, and the answer or the refusal. */
interface Example {
  title: string;
  versions?: boolean;
  request: { qualifier?: string; headers?: Record<string, string>; body?: string; payloadBytes?: number };
  ran?: { output?: string; error?: { kind?: 'timeout' | 'throttled' | 'platform'; type?: string; message: string }; logResult?: string };
  answer?: { status: number; headers?: Record<string, string>; body?: string; document?: Record<string, unknown> };
  refused?: { status: number; type: string; message?: string; messageStarts?: string; reason?: string };
  payload?: unknown;
}
const table = JSON.parse(readFileSync(join(__dirname, 'lambda-invoke-examples.json'), 'utf8')) as Record<string, Example[]>;
/** A trace the call started, as AWS X-Ray writes one. */
const NEW_TRACE = expect.stringMatching(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);

/** What the call did, as FunctionsService says it. */
function outcomeOf({ output, error, logResult }: NonNullable<Example['ran']>): Partial<CallOutcome> {
  const logged = logResult === undefined ? {} : { logResult };
  if (output !== undefined) return { ok: true, output: JSON.parse(output) as unknown, outputJson: output, ...logged };
  if (!error) throw new Error('A case says what its call answered, or how it failed');
  const errors = {
    timeout: () => new FunctionTimeoutError(error.message),
    throttled: () => new FunctionThrottledError(error.message),
    platform: () => new OrchestratorError(error.message),
  };
  return { ok: false, error: error.kind ? errors[error.kind]() : new FunctionRuntimeError(error.type ?? 'Error', error.message), ...logged };
}

/** The answer a case expects, as the handler gives it to the front door. */
function expected({ status, headers, body, document }: NonNullable<Example['answer']>): LambdaAnswer {
  return { status, ...(headers ? { headers } : {}), ...(body !== undefined ? { body: Buffer.from(body) } : {}), ...(document ? { document } : {}) };
}

/** The refusal a case expects: its status, its type, its message, and its Reason, as `refused` lists them. */
function refusalOf({ status, type, message, messageStarts, reason }: NonNullable<Example['refused']>): unknown[] {
  const said = message?.replace('{region}', REGION).replace('{account}', ACCOUNT);
  const words = said ?? expect.stringMatching(new RegExp(`^${(messageStarts ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  return [status, type, words, ...(reason ? [reason] : [])];
}

const fn = (more: Partial<Function> = {}): Function =>
  Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders', status: FunctionStatus.ACTIVE, error: null, ...more });
/** What a qualifier names: the function's version 1, its alias live of version 3; nothing else. */
const TARGETS: Record<string, CallTarget> = {
  '1': { version: Object.assign(new FunctionVersion(), { version: 1 }) },
  live: { version: Object.assign(new FunctionVersion(), { version: 3 }), alias: 'live' },
};
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
  /** The trace header each answer gave back, which send() takes off it: the examples' answers, ff local's too, have none. */
  let traces: Array<string | undefined>;

  beforeEach(() => {
    function_ = fn();
    traces = [];
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
    queue = jest.fn(async (...call: unknown[]) => ({ requestId: 'req-1', traceId: call[4] }));
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
    const caller = lambdaCaller({ plan: plan({ invokesPerSecond: 5 }), function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } });
    const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const call = { ...lambdaCall('POST', '/2015-03-31/functions/orders/invocations'), body: Buffer.from(body), headers: lowered };
    return withRequestContext({ requestId: 'req-1' }, () => invoke.handlers.Invoke(call, caller)).then(untraced);
  }

  /** The answer without its trace header, which `traces` keeps. */
  function untraced({ headers, ...answer }: LambdaAnswer): LambdaAnswer {
    const { [TRACE_HEADER]: trace, ...others } = headers ?? {};
    traces.push(trace);
    return Object.keys(others).length > 0 ? { ...answer, headers: others } : answer;
  }

  /** The error an Invoke throws, as the front door answers it: its status, its type, its message, and its Reason. */
  async function refused(answer: Promise<unknown>): Promise<Array<number | string>> {
    const error = await lambdaRefusal(answer);
    return [error.status, error.type, error.message, ...(error.fields.Reason ? [error.fields.Reason] : [])];
  }

  const callOptions = () => functions.call.mock.calls.map(([, payload, options]) => ({ payload, ...options }));

  /** A case's request, its call doing what the case says. */
  function sendExample({ request, ran }: Example): Promise<LambdaAnswer> {
    if (ran) outcomes.push(outcomeOf(ran));
    const body = request.payloadBytes === undefined ? request.body : `"${'a'.repeat(request.payloadBytes - 2)}"`;
    return send({ qualifier: request.qualifier, headers: request.headers, body });
  }

  /** Each case answered, or refused, as it says. */
  async function answersAsItSays(examples: Example[]): Promise<void> {
    for (const example of examples) {
      if (example.refused) expect(await refused(sendExample(example))).toEqual(refusalOf(example.refused));
      else expect(await sendExample(example)).toEqual(expected(example.answer!));
    }
  }

  describe('RequestResponse, which waits for the call', () => {
    it("answers 200 with the function's answer as its runtime sent it, $LATEST having run it, under the request's ID", async () => {
      const [example] = table.answered;

      const answer = await sendExample(example);

      expect(answer).toEqual(expected(example.answer!));
      expect(callOptions()).toEqual([
        { payload: JSON.parse(example.request.body!), source: InvocationSource.API, requestId: 'req-1', target: {}, asks: { logTail: false }, traceId: NEW_TRACE },
      ]);
      expect(admit).toHaveBeenCalledWith(ACCOUNT);
    });

    it('takes any JSON value as the payload, {} for none, as Lambda gives a function called without one', async () => {
      for (const example of table.payloads) await sendExample(example);

      expect(callOptions().map(({ payload }) => payload)).toEqual(table.payloads.map(({ payload }) => payload));
    });

    it('names the version that ran: a version named, or an alias\'s; a version or an alias the function hasn\'t is Lambda\'s "Function not found", its ARN with it', async () => {
      const ran = [];
      for (const qualifier of ['1', 'live', '$LATEST']) ran.push((await send({ qualifier })).headers?.['x-amz-executed-version']);

      expect(ran).toEqual(['1', '3', '$LATEST']);
      expect(callOptions().map(({ target }) => target)).toEqual([TARGETS['1'], TARGETS.live, {}]);
      await answersAsItSays(table.notFound);
    });

    it("asks for the call's log with LogType Tail, and gives it back as X-Amz-Log-Result; LogType None, or none, asks nothing", async () => {
      const answers = [];
      for (const example of table.logs) answers.push(await sendExample(example));

      expect(answers.map(({ headers }) => headers)).toEqual(table.logs.map(({ answer }) => answer!.headers));
      expect(callOptions().map(({ asks }) => asks)).toEqual(table.logs.map(({ request }) => ({ logTail: request.headers?.['X-Amz-Log-Type'] === 'Tail' })));
    });

    it("passes the caller's ClientContext on as sent, base64 of a JSON object, its padding optional", async () => {
      for (const example of table.clientContexts) await sendExample(example);

      expect(callOptions().map(({ asks }) => asks)).toEqual(
        table.clientContexts.map(({ request }) => ({ logTail: false, clientContext: request.headers?.['X-Amz-Client-Context'] })),
      );
    });

    it("answers a function that threw, timed out or failed to load with 200 too: FunctionError Unhandled and Lambda's error document, its log with it", async () => {
      const answers = [];
      for (const example of table.functionErrors) answers.push(await sendExample(example));

      expect(answers).toEqual(table.functionErrors.map(({ answer }) => expected(answer!)));
    });

    it("answers no instance free as Lambda's throttle, its Reason the function's instances; the platform's failure as ServiceException", async () => {
      // The platform's details stay in the server's log.
      await answersAsItSays(table.throttles);
    });
  });

  describe('Event and DryRun', () => {
    it("keeps an Event in the function's queue, as the API's asynchronous call, with what it named, and answers 202 at once", async () => {
      const [example] = table.events;

      expect(await sendExample(example)).toEqual(expected(example.answer!));
      expect(queue).toHaveBeenCalledWith(ACCOUNT, 'f-orders', JSON.parse(example.request.body!), example.request.qualifier, NEW_TRACE);
      // The queue checks the credit, as for the API's asynchronous calls; nothing runs now.
      expect([admit.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
    });

    it('checks a DryRun as a call, and answers 204, nothing run or queued', async () => {
      await answersAsItSays(table.dryRuns);
      expect([queue.mock.calls.length, functions.call.mock.calls.length]).toEqual([0, 0]);
    });
  });

  describe('the trace', () => {
    it('makes the call part of the trace X-Amzn-Trace-Id names, as the AWS SDKs send it from _X_AMZN_TRACE_ID, else of a new one', async () => {
      const trace = '1-5759e988-bd862e3fe1be46a994272793';

      await send({ headers: { 'X-Amzn-Trace-Id': `Root=${trace};Parent=53995c3f42cd8ad8;Sampled=0` } });
      await send();
      await send({ headers: { 'X-Amzn-Trace-Id': `Root=${trace}`, 'X-Amz-Invocation-Type': 'Event' } });
      await send({ headers: { 'X-Amz-Invocation-Type': 'DryRun' } });

      const ran = callOptions().map(({ traceId }) => traceId);
      expect([...ran, queue.mock.calls[0][4]]).toEqual([trace, NEW_TRACE, trace]);
      expect(ran[1]).not.toBe(trace);
      // Given back by an answer that ran the call or kept it; a DryRun runs nothing.
      expect(traces).toEqual([`Root=${trace}`, `Root=${ran[1]}`, `Root=${trace}`, undefined]);
    });
  });

  describe('refused as Lambda refuses', () => {
    it("refuses an Event past 1 MB by Lambda's words for the operation, before anything is read; a call that waits takes it", async () => {
      const [event, waited] = table.tooLarge;

      expect(await refused(sendExample(event))).toEqual(refusalOf(event.refused!));
      expect(functions.callTarget).not.toHaveBeenCalled();
      expect((await sendExample(waited)).status).toBe(waited.answer!.status);
    });

    it("refuses a payload that isn't JSON, and an InvocationType or a LogType Lambda hasn't, naming those it has", async () => {
      await answersAsItSays(table.invalid);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it(`refuses a ClientContext that isn't base64 of a JSON object, or past ${CLIENT_CONTEXT_BYTES} bytes`, async () => {
      await answersAsItSays(table.clientContextsRefused);
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
