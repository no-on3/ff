import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { withRequestContext } from '../common/request-context';
import { plan } from '../plans/test-fixtures';
import { AsyncInvocationsService } from './async-invocations.service';
import { MAX_ASYNC_INPUT_BYTES } from './async-invoke';
import { FunctionStatus } from './entities/function.entity';
import { MAX_INPUT_BYTES } from './limits';

const ACCOUNT = '000000000001';
const MB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A JSON string value whose JSON text, with its two quotes, is exactly `size` bytes. */
const jsonOfSize = (size: number) => 'a'.repeat(size - 2);

describe('AsyncInvocationsService: the invocation types Event and DryRun (L1)', () => {
  const fn = { id: 'fn-1', accountId: ACCOUNT, status: FunctionStatus.ACTIVE };
  let functions: { findOne: jest.Mock; callTarget: jest.Mock };
  let credit: { admit: jest.Mock };
  let plans: { forAccount: jest.Mock };
  let queues: { accountBytes: jest.Mock; sendEvent: jest.Mock };
  let service: AsyncInvocationsService;

  beforeEach(() => {
    functions = { findOne: jest.fn(async () => fn), callTarget: jest.fn(async () => ({})) };
    credit = { admit: jest.fn(async () => undefined) };
    plans = { forAccount: jest.fn(async () => plan({ queueStorageMb: 100 })) };
    queues = { accountBytes: jest.fn(async () => 0), sendEvent: jest.fn(async () => undefined) };
    service = new AsyncInvocationsService(functions as never, credit as never, plans as never, queues as never);
  });

  const failure = (promise: Promise<unknown>) => promise.then(() => 'kept', (error: unknown) => error);

  it("keeps the event in the function's queue under the request's own ID, which it answers, until the longest age and an hour more", async () => {
    const before = Date.now();

    const answer = await withRequestContext({ requestId: 'req-9' }, () => service.queue(ACCOUNT, 'fn-1', { order: 42 }));

    expect(answer).toEqual({ requestId: 'req-9' });
    const [kept, requestId, body, expiresAt, options] = queues.sendEvent.mock.calls[0];
    expect([kept, requestId, body, options]).toEqual([fn, 'req-9', '{"order":42}', { attributes: undefined }]);
    expect((expiresAt as Date).getTime() - before).toBeGreaterThanOrEqual(7 * 3600 * 1000);
    expect((expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(7 * 3600 * 1000);
    expect([functions.findOne.mock.calls[0], credit.admit.mock.calls[0]]).toEqual([[ACCOUNT, 'fn-1'], [ACCOUNT]]);
  });

  it('keeps {} without an input, and gives a new request ID outside a request', async () => {
    const { requestId } = await service.queue(ACCOUNT, 'fn-1');

    expect(requestId).toMatch(UUID);
    expect(queues.sendEvent.mock.calls[0][2]).toBe('{}');
  });

  it("refuses an event over Lambda's 1 MB as JSON, as Lambda names it, before anything else", async () => {
    expect(await service.queue(ACCOUNT, 'fn-1', jsonOfSize(MAX_ASYNC_INPUT_BYTES))).toEqual({ requestId: expect.stringMatching(UUID) });

    const refused = (await failure(service.queue(ACCOUNT, 'fn-1', jsonOfSize(MAX_ASYNC_INPUT_BYTES + 1)))) as HttpException;

    expect([refused.getStatus(), refused.getResponse()]).toEqual([
      HttpStatus.PAYLOAD_TOO_LARGE,
      {
        statusCode: 413,
        error: 'RequestEntityTooLargeException',
        message: 'Request must be smaller than 1048576 bytes for the InvokeFunction operation: the input is 1048577 bytes as JSON',
      },
    ]);
    expect([functions.findOne.mock.calls.length, queues.sendEvent.mock.calls.length]).toEqual([1, 1]);
  });

  it("refuses a function that isn't ACTIVE, or another account's, and keeps nothing", async () => {
    functions.findOne.mockResolvedValueOnce({ ...fn, status: FunctionStatus.ERROR });
    expect(await failure(service.queue(ACCOUNT, 'fn-1', {}))).toBeInstanceOf(BadRequestException);

    functions.findOne.mockRejectedValueOnce(new NotFoundException('Function with ID fn-2 not found'));
    expect(await failure(service.queue(ACCOUNT, 'fn-2', {}))).toBeInstanceOf(NotFoundException);

    expect(queues.sendEvent).not.toHaveBeenCalled();
  });

  it('keeps the version or the alias the call named beside its event, which each attempt runs; nothing for $LATEST', async () => {
    await service.queue(ACCOUNT, 'fn-1', {}, 'live');
    await service.queue(ACCOUNT, 'fn-1', {}, '3');
    await service.queue(ACCOUNT, 'fn-1', {}, '$LATEST');

    expect(queues.sendEvent.mock.calls.map((call) => call[4])).toEqual([{ attributes: { qualifier: 'live' } }, { attributes: { qualifier: '3' } }, { attributes: undefined }]);
    expect(functions.callTarget.mock.calls).toEqual([
      [fn, 'live'],
      [fn, '3'],
      [fn, '$LATEST'],
    ]);
  });

  it("refuses a version or an alias the function hasn't, and keeps nothing; keeps one that names a version while $LATEST isn't ACTIVE", async () => {
    functions.callTarget.mockRejectedValueOnce(new NotFoundException('Function not found: …:function:orders:9'));
    expect(await failure(service.queue(ACCOUNT, 'fn-1', {}, '9'))).toBeInstanceOf(NotFoundException);
    expect(queues.sendEvent).not.toHaveBeenCalled();

    // A version runs whatever $LATEST's state, as a rollback needs; an alias naming $LATEST doesn't.
    functions.findOne.mockResolvedValue({ ...fn, status: FunctionStatus.ERROR });
    functions.callTarget.mockResolvedValueOnce({ version: { version: 2 }, alias: 'live' });
    expect(await service.queue(ACCOUNT, 'fn-1', {}, 'live')).toEqual({ requestId: expect.stringMatching(UUID) });
    functions.callTarget.mockResolvedValueOnce({ alias: 'edge' });
    expect(await failure(service.queue(ACCOUNT, 'fn-1', {}, 'edge'))).toBeInstanceOf(BadRequestException);
    expect(queues.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses a call once the account's credit has run out, and keeps nothing", async () => {
    const refusal = new HttpException('Payment Required', HttpStatus.PAYMENT_REQUIRED);
    credit.admit.mockRejectedValueOnce(refusal);

    expect(await failure(service.queue(ACCOUNT, 'fn-1', {}))).toBe(refusal);
    expect(queues.sendEvent).not.toHaveBeenCalled();
  });

  it("keeps an event while the account's messages hold the plan's limit with it, and refuses one past it with 429, naming the plan", async () => {
    // Two bytes: the event {}.
    queues.accountBytes.mockResolvedValueOnce(100 * MB - 2);
    expect(await service.queue(ACCOUNT, 'fn-1')).toEqual({ requestId: expect.stringMatching(UUID) });

    queues.accountBytes.mockResolvedValueOnce(100 * MB - 1);
    const refused = (await failure(service.queue(ACCOUNT, 'fn-1'))) as HttpException;

    expect([refused.getStatus(), (refused.getResponse() as { message: string }).message]).toEqual([
      429,
      "TooManyRequestsException: the account's messages hold 100 MB together, the Beta plan's limit, its asynchronous calls waiting to run among them: " +
        'this call was not kept. Try again once they are handled.',
    ]);
    expect(queues.accountBytes).toHaveBeenCalledWith(ACCOUNT);
    expect(queues.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("checks a DryRun's function, what it names and its input only: nothing is kept, nothing runs", async () => {
    await service.dryRun(ACCOUNT, 'fn-1', { a: 1 }, 'live');
    expect(functions.callTarget).toHaveBeenCalledWith(fn, 'live');
    functions.callTarget.mockRejectedValueOnce(new NotFoundException('Function not found: …:function:orders:gone'));
    expect(await failure(service.dryRun(ACCOUNT, 'fn-1', {}, 'gone'))).toBeInstanceOf(NotFoundException);

    const refused = (await failure(service.dryRun(ACCOUNT, 'fn-1', jsonOfSize(MAX_INPUT_BYTES + 1)))) as HttpException;
    functions.findOne.mockRejectedValueOnce(new NotFoundException('Function with ID fn-2 not found'));
    const missing = await failure(service.dryRun(ACCOUNT, 'fn-2'));

    expect([refused.getStatus(), missing]).toEqual([413, expect.any(NotFoundException)]);
    expect([functions.findOne.mock.calls.length, credit.admit.mock.calls.length, queues.sendEvent.mock.calls.length]).toEqual([3, 0, 0]);
  });
});
