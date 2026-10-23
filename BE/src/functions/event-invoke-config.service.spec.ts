import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LAMBDA_RETRY_POLICY } from './async-invoke';
import { EventInvokeConfigService } from './event-invoke-config.service';

const ACCOUNT = '000000000001';
const arn = (name: string, account = ACCOUNT, region = 'tn-tunis-1') => `arn:aws:lambda:${region}:${account}:function:${name}`;

describe('EventInvokeConfigService: a function\'s settings for its asynchronous calls, as Lambda\'s EventInvokeConfig (L1)', () => {
  const orders = { id: 'fn-1', name: 'orders', accountId: ACCOUNT };
  const failed = { id: 'fn-2', name: 'failed-orders', accountId: ACCOUNT };
  let saved: Record<string, unknown> | null;
  let configs: { findOneBy: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let functions: { findOne: jest.Mock; findAll: jest.Mock };
  let audit: { record: jest.Mock };
  let service: EventInvokeConfigService;

  beforeEach(() => {
    saved = null;
    configs = {
      findOneBy: jest.fn(async () => saved),
      save: jest.fn(async (row: Record<string, unknown>) => (saved = { ...row, updatedAt: new Date('2026-10-23T10:00:00Z') })),
      delete: jest.fn(async () => ({ affected: saved ? 1 : 0 })),
    };
    functions = {
      findOne: jest.fn(async () => orders),
      findAll: jest.fn(async (_account: string, name: string) => [orders, failed].filter((fn) => fn.name === name)),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new EventInvokeConfigService(configs as never, functions as never, audit as never, {
      getOrThrow: () => 'tn-tunis-1',
    } as unknown as ConfigService);
  });

  const refusal = (destination: string) =>
    service.put(ACCOUNT, 'fn-1', { destinationConfig: { onFailure: { destination } } }).then(
      () => 'kept',
      (error: BadRequestException) => (error.getResponse() as { message: string }).message,
    );

  it("keeps what it is given, what is left out as Lambda's default, and answers as Lambda's GetFunctionEventInvokeConfig", async () => {
    const view = await service.put(ACCOUNT, 'fn-1', { maximumRetryAttempts: 0 });

    expect(view).toEqual({
      functionArn: `${arn('orders')}:$LATEST`,
      maximumRetryAttempts: 0,
      maximumEventAgeInSeconds: null,
      destinationConfig: { onSuccess: {}, onFailure: {} },
      lastModified: new Date('2026-10-23T10:00:00Z'),
    });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      action: 'event_invoke_config.put',
      resource: 'function:fn-1',
      details: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: null, onSuccess: null, onFailure: null },
    });
  });

  it("takes another function of the account as a destination, by its ARN, $LATEST or not", async () => {
    const view = await service.put(ACCOUNT, 'fn-1', { destinationConfig: { onSuccess: { destination: arn('failed-orders') }, onFailure: { destination: `${arn('failed-orders')}:$LATEST` } } });

    expect(view.destinationConfig).toEqual({ onSuccess: { destination: arn('failed-orders') }, onFailure: { destination: arn('failed-orders') } });
    expect(functions.findAll).toHaveBeenCalledWith(ACCOUNT, 'failed-orders');
  });

  it("refuses a destination that is no function of the account, saying what it must be", async () => {
    expect(await refusal('failed-orders')).toBe(`destinationConfig.onFailure.destination must be the ARN of a function of the account, as Lambda's: ${arn('<name>')}`);
    expect(await refusal(`arn:aws:sqs:tn-tunis-1:${ACCOUNT}:failed`)).toBe(
      "destinationConfig.onFailure.destination: a queue becomes a destination with FF's queues; for now, name another function of the account",
    );
    expect(await refusal(arn('failed-orders', '000000000002'))).toBe(`destinationConfig.onFailure.destination must be a function of this account, in tn-tunis-1: ${arn('failed-orders')}`);
    expect(await refusal(arn('failed-orders', ACCOUNT, 'eu-west-3'))).toBe(`destinationConfig.onFailure.destination must be a function of this account, in tn-tunis-1: ${arn('failed-orders')}`);
    expect(await refusal(arn('orders'))).toBe("destinationConfig.onFailure.destination: a function can't be its own destination, as each record would call it again");
    expect(await refusal(arn('missing'))).toBe('destinationConfig.onFailure.destination: the account has no function named "missing"');
    expect([configs.save.mock.calls.length, audit.record.mock.calls.length]).toEqual([0, 0]);
  });

  it("answers 404 for a function without settings, saying it follows Lambda's defaults, and so does a delete", async () => {
    const missing = await service.get(ACCOUNT, 'fn-1').catch((error: unknown) => error);
    const gone = await service.remove(ACCOUNT, 'fn-1').catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(NotFoundException);
    expect((missing as NotFoundException).message).toBe(
      `The function ${arn('orders')} has no event invoke configuration: its asynchronous calls are retried twice and kept 6 hours, AWS Lambda's defaults`,
    );
    expect([gone instanceof NotFoundException, audit.record.mock.calls.length]).toEqual([true, 0]);
  });

  it('deletes the settings, saying so in the audit log', async () => {
    await service.put(ACCOUNT, 'fn-1', { maximumEventAgeInSeconds: 60 });

    await service.remove(ACCOUNT, 'fn-1');

    expect(configs.delete).toHaveBeenCalledWith({ functionId: 'fn-1' });
    expect(audit.record).toHaveBeenLastCalledWith({ accountId: ACCOUNT, action: 'event_invoke_config.delete', resource: 'function:fn-1' });
  });

  it("gives the worker the function's settings, else Lambda's defaults and no destination", async () => {
    expect(await service.settingsFor('fn-1')).toEqual({ policy: LAMBDA_RETRY_POLICY, onSuccess: null, onFailure: null });

    await service.put(ACCOUNT, 'fn-1', { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 120, destinationConfig: { onFailure: { destination: arn('failed-orders') } } });

    expect(await service.settingsFor('fn-1')).toEqual({ policy: { maximumRetryAttempts: 1, maximumEventAgeSeconds: 120 }, onSuccess: null, onFailure: arn('failed-orders') });
  });

  it("finds a destination's function in the account only", async () => {
    expect(await service.destinationFunction(ACCOUNT, arn('failed-orders'))).toBe(failed);
    expect(await service.destinationFunction('000000000002', arn('failed-orders'))).toBeUndefined();
    expect(await service.destinationFunction(ACCOUNT, 'not an ARN')).toBeUndefined();
  });
});
