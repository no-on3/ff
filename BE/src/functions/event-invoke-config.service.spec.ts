import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LAMBDA_RETRY_POLICY } from './async-invoke';
import { EventInvokeConfigService } from './event-invoke-config.service';

const ACCOUNT = '000000000001';
const arn = (name: string, account = ACCOUNT, region = 'tn-tunis-1') => `arn:aws:lambda:${region}:${account}:function:${name}`;
const queueArn = (name: string, account = ACCOUNT, region = 'tn-tunis-1') => `arn:aws:sqs:${region}:${account}:${name}`;

describe('EventInvokeConfigService: a function\'s settings for its asynchronous calls, as Lambda\'s EventInvokeConfig (L1)', () => {
  const orders = { id: 'fn-1', name: 'orders', accountId: ACCOUNT };
  const failed = { id: 'fn-2', name: 'failed-orders', accountId: ACCOUNT };
  let saved: Record<string, unknown> | null;
  let configs: { findOneBy: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let functions: { findOne: jest.Mock; findAll: jest.Mock };
  let queues: { find: jest.Mock };
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
    queues = { find: jest.fn(async (accountId: string, name: string) => (accountId === ACCOUNT && name === 'failed-orders' ? { id: 'queue-1', accountId, name } : null)) };
    audit = { record: jest.fn(async () => undefined) };
    service = new EventInvokeConfigService(configs as never, functions as never, queues as never, audit as never, {
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

  it("takes another function of the account as a destination, by its ARN, $LATEST or not, or by its name, and keeps its ARN", async () => {
    const view = await service.put(ACCOUNT, 'fn-1', { destinationConfig: { onSuccess: { destination: arn('failed-orders') }, onFailure: { destination: `${arn('failed-orders')}:$LATEST` } } });
    const byName = await service.put(ACCOUNT, 'fn-1', { destinationConfig: { onFailure: { destination: 'failed-orders' } } });

    expect(view.destinationConfig).toEqual({ onSuccess: { destination: arn('failed-orders') }, onFailure: { destination: arn('failed-orders') } });
    expect(byName.destinationConfig).toEqual({ onSuccess: {}, onFailure: { destination: arn('failed-orders') } });
    expect(functions.findAll).toHaveBeenCalledWith(ACCOUNT, 'failed-orders');
  });

  it("refuses a destination that is no function of the account, saying what it must be", async () => {
    expect(await refusal('failed orders')).toBe(
      `destinationConfig.onFailure.destination must be another function of the account, by its name or its ARN, as Lambda's (${arn('<name>')}), or a queue of the account, by its ARN (${queueArn('<name>')})`,
    );
    expect(await refusal(arn('failed-orders', '000000000002'))).toBe(`destinationConfig.onFailure.destination must be a function of this account, in tn-tunis-1: ${arn('failed-orders')}`);
    expect(await refusal(arn('failed-orders', ACCOUNT, 'eu-west-3'))).toBe(`destinationConfig.onFailure.destination must be a function of this account, in tn-tunis-1: ${arn('failed-orders')}`);
    expect(await refusal(arn('orders'))).toBe("destinationConfig.onFailure.destination: a function can't be its own destination, as each record would call it again");
    expect(await refusal(arn('missing'))).toBe('destinationConfig.onFailure.destination: the account has no function named "missing"');
    expect(await refusal('orders')).toBe("destinationConfig.onFailure.destination: a function can't be its own destination, as each record would call it again");
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

  it("takes a queue of the account as a destination, by its ARN as SQS writes it, and keeps it", async () => {
    const view = await service.put(ACCOUNT, 'fn-1', { destinationConfig: { onFailure: { destination: queueArn('failed-orders') } } });

    expect(view.destinationConfig).toEqual({ onSuccess: {}, onFailure: { destination: queueArn('failed-orders') } });
    expect(queues.find).toHaveBeenCalledWith(ACCOUNT, 'failed-orders');
    expect(await service.settingsFor('fn-1')).toMatchObject({ onFailure: queueArn('failed-orders') });
  });

  it("refuses a queue that is no queue of the account's, in its region, there now", async () => {
    expect(await refusal(queueArn('failed-orders', '000000000002'))).toBe(`destinationConfig.onFailure.destination must be a queue of this account, in tn-tunis-1: ${queueArn('failed-orders')}`);
    expect(await refusal(queueArn('failed-orders', ACCOUNT, 'eu-west-3'))).toBe(`destinationConfig.onFailure.destination must be a queue of this account, in tn-tunis-1: ${queueArn('failed-orders')}`);
    expect(await refusal(queueArn('missing'))).toBe('destinationConfig.onFailure.destination: the account has no queue named "missing"');
    expect(await refusal('arn:aws:sqs:tn-tunis-1:failed-orders')).toBe(`destinationConfig.onFailure.destination is no queue's ARN, which SQS writes ${queueArn('<name>')}`);
    expect([configs.save.mock.calls.length, audit.record.mock.calls.length]).toEqual([0, 0]);
  });

  it("finds a destination's queue in the account and its region only", async () => {
    expect(await service.destinationQueue(ACCOUNT, queueArn('failed-orders'))).toMatchObject({ id: 'queue-1' });
    expect(await service.destinationQueue('000000000002', queueArn('failed-orders'))).toBeUndefined();
    expect(await service.destinationQueue(ACCOUNT, queueArn('failed-orders', ACCOUNT, 'eu-west-3'))).toBeUndefined();
    expect(await service.destinationQueue(ACCOUNT, arn('failed-orders'))).toBeUndefined();
  });

  it("finds a destination's function in the account only", async () => {
    expect(await service.destinationFunction(ACCOUNT, arn('failed-orders'))).toBe(failed);
    expect(await service.destinationFunction('000000000002', arn('failed-orders'))).toBeUndefined();
    expect(await service.destinationFunction(ACCOUNT, 'not an ARN')).toBeUndefined();
  });
});
