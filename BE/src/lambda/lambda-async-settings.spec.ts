/**
 * L1: Lambda's settings for a function's asynchronous calls over FF's:
 * PutFunctionEventInvokeConfig, UpdateFunctionEventInvokeConfig,
 * GetFunctionEventInvokeConfig, DeleteFunctionEventInvokeConfig and
 * ListFunctionEventInvokeConfigs, in Lambda's shape; what they send checked
 * under Lambda's names, a version's or an alias's refused, as FF keeps one
 * for the function, and the rest refused as Lambda refuses.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventInvokeConfigView, PutEventInvokeConfigDto } from '../functions/dto/event-invoke-config.dto';
import { Function } from '../functions/entities/function.entity';
import { EventInvokeConfigService } from '../functions/event-invoke-config.service';
import { LambdaAsyncSettings } from './lambda-async-settings';
import { ACCOUNT, REGION, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;
const CONFIG = '/2019-09-25/functions/orders/event-invoke-config';
const FAILED = `arn:aws:sqs:${REGION}:${ACCOUNT}:failed-orders`;
const RECEIPTS = ARN.replace(':orders', ':receipts');
const CHANGED = new Date('2026-11-02T09:30:00.000Z');
const NONE = [404, 'ResourceNotFoundException', `The function ${ARN}:$LATEST doesn't have an EventInvokeConfig`];

describe("Lambda's settings of asynchronous calls (L1)", () => {
  const function_ = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders' });
  let saved: EventInvokeConfigView | undefined;
  let service: { get: jest.Mock; put: jest.Mock; remove: jest.Mock; arnOf: jest.Mock };
  let handlers: LambdaAsyncSettings;

  beforeEach(() => {
    saved = undefined;
    const found = () => {
      if (!saved) throw new NotFoundException('The function has no event invoke configuration');
      return saved;
    };
    service = {
      get: jest.fn(async () => found()),
      put: jest.fn(async (_account: string, _id: string, dto: PutEventInvokeConfigDto) => {
        saved = {
          functionArn: `${ARN}:$LATEST`,
          maximumRetryAttempts: dto.maximumRetryAttempts ?? null,
          maximumEventAgeInSeconds: dto.maximumEventAgeInSeconds ?? null,
          destinationConfig: { onSuccess: dto.destinationConfig?.onSuccess ?? {}, onFailure: dto.destinationConfig?.onFailure ?? {} },
          lastModified: CHANGED,
        };
        return saved;
      }),
      remove: jest.fn(async () => {
        found();
        saved = undefined;
      }),
      arnOf: jest.fn(() => ARN),
    };
    handlers = new LambdaAsyncSettings(service as unknown as EventInvokeConfigService);
  });

  /** A request as the front door hands it on: the function its path names found, a qualifier from its name or its query. */
  async function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    const answer = await handlers.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
    return { status: answer.status, document: answer.document as Record<string, unknown> };
  }
  const put = (input: Record<string, unknown>) => ask('PUT', CONFIG, input);

  describe('PutFunctionEventInvokeConfig', () => {
    it("sets the function's settings under FF's names, and answers with Lambda's FunctionEventInvokeConfig, its LastModified in seconds", async () => {
      const answer = await put({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600, DestinationConfig: { OnFailure: { Destination: FAILED }, OnSuccess: {} } });

      expect(service.put).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 3600, destinationConfig: { onFailure: { destination: FAILED } } });
      expect(answer).toEqual({
        status: 200,
        document: {
          LastModified: CHANGED.getTime() / 1000,
          FunctionArn: `${ARN}:$LATEST`,
          MaximumRetryAttempts: 0,
          MaximumEventAgeInSeconds: 3600,
          DestinationConfig: { OnSuccess: {}, OnFailure: { Destination: FAILED } },
        },
      });
    });

    it("leaves out what is at Lambda's default, as Lambda answers it", async () => {
      expect((await put({})).document).toEqual({ LastModified: CHANGED.getTime() / 1000, FunctionArn: `${ARN}:$LATEST`, DestinationConfig: { OnSuccess: {}, OnFailure: {} } });
    });

    it("refuses a version's or an alias's, a field Lambda's model hasn't, a DestinationConfig that isn't Lambda's, and passes FF's own checks' refusals on", async () => {
      expect(await refused(ask('PUT', `${CONFIG}?Qualifier=live`, {}, 'live'))).toEqual([
        400,
        'InvalidParameterValueException',
        "FF keeps one setting of a function's asynchronous calls, which its versions and aliases follow too: PutFunctionEventInvokeConfig names orders alone, or $LATEST, not live.",
      ]);
      expect(await refused(put({ MaximumRetries: 1 }))).toEqual([400, 'InvalidParameterValueException', "FF doesn't take MaximumRetries in PutFunctionEventInvokeConfig."]);
      expect(await refused(put({ DestinationConfig: { OnTimeout: {} } }))).toEqual([400, 'InvalidParameterValueException', 'DestinationConfig takes OnSuccess and OnFailure, not OnTimeout.']);
      expect(await refused(put({ DestinationConfig: { OnFailure: { Arn: FAILED } } }))).toEqual([400, 'InvalidParameterValueException', 'DestinationConfig.OnFailure takes Destination alone, an ARN.']);
      const [, type, message] = await refused(put({ MaximumRetryAttempts: 3 }));
      expect([type, message]).toEqual(['InvalidParameterValueException', expect.stringContaining('maximumRetryAttempts')]);
      expect(service.put).not.toHaveBeenCalled();

      service.put.mockRejectedValueOnce(new BadRequestException('destinationConfig.onFailure.destination: the account has no queue named "gone"'));
      expect(await refused(put({ DestinationConfig: { OnFailure: { Destination: `${FAILED}-gone` } } }))).toEqual([
        400,
        'InvalidParameterValueException',
        'destinationConfig.onFailure.destination: the account has no queue named "gone"',
      ]);
    });
  });

  describe('UpdateFunctionEventInvokeConfig, GetFunctionEventInvokeConfig, DeleteFunctionEventInvokeConfig', () => {
    it('changes what is sent, the rest staying, where Put would put it back to its default', async () => {
      await put({ MaximumRetryAttempts: 1, DestinationConfig: { OnFailure: { Destination: FAILED } } });

      const answer = await ask('POST', CONFIG, { MaximumEventAgeInSeconds: 120, DestinationConfig: { OnSuccess: { Destination: RECEIPTS } } });

      expect(service.put).toHaveBeenLastCalledWith(ACCOUNT, 'f-orders', { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 120, destinationConfig: { onSuccess: { destination: RECEIPTS } } });
      expect(answer.document).toMatchObject({ MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 120, DestinationConfig: { OnSuccess: { Destination: RECEIPTS }, OnFailure: {} } });
      expect((await ask('POST', CONFIG, { MaximumEventAgeInSeconds: 60 })).document).toMatchObject({ MaximumRetryAttempts: 1, DestinationConfig: { OnSuccess: { Destination: RECEIPTS } } });
    });

    it("reads the settings, and deletes them with 204; a function without any, in Lambda's words", async () => {
      expect(await refused(ask('GET', CONFIG))).toEqual(NONE);
      expect(await refused(ask('POST', CONFIG, { MaximumRetryAttempts: 0 }))).toEqual(NONE);
      expect(await refused(ask('DELETE', CONFIG))).toEqual(NONE);

      await put({ MaximumRetryAttempts: 2 });
      expect((await ask('GET', CONFIG)).document).toMatchObject({ FunctionArn: `${ARN}:$LATEST`, MaximumRetryAttempts: 2 });
      expect(await ask('DELETE', CONFIG)).toEqual({ status: 204, document: undefined });
      expect(await refused(ask('GET', CONFIG))).toEqual(NONE);
    });

    it("refuses a version's or an alias's, by its query or its name", async () => {
      for (const [method, qualifier] of [['GET', '3'], ['POST', 'live'], ['DELETE', 'live']]) {
        const [status, type] = await refused(ask(method, `${CONFIG}?Qualifier=${qualifier}`, {}, qualifier));
        expect([status, type]).toEqual([400, 'InvalidParameterValueException']);
      }
      expect(service.get).not.toHaveBeenCalled();
    });
  });

  describe('ListFunctionEventInvokeConfigs', () => {
    it("lists the function's settings, or none, 50 at most a page, as Lambda's; named without a version or an alias", async () => {
      expect((await ask('GET', `${CONFIG}/list`)).document).toEqual({ FunctionEventInvokeConfigs: [] });
      await put({ MaximumRetryAttempts: 0 });
      expect((await ask('GET', `${CONFIG}/list?MaxItems=50`)).document).toEqual({ FunctionEventInvokeConfigs: [expect.objectContaining({ FunctionArn: `${ARN}:$LATEST`, MaximumRetryAttempts: 0 })] });

      expect(await refused(ask('GET', `${CONFIG}/list?MaxItems=51`))).toEqual([400, 'InvalidParameterValueException', 'MaxItems must be a whole number from 1 to 50, not 51.']);
      expect(await refused(ask('GET', `${CONFIG}/list`, {}, 'live'))).toEqual([
        400,
        'InvalidParameterValueException',
        'ListFunctionEventInvokeConfigs names the function alone, not its version or alias live: send orders.',
      ]);
    });
  });
});
