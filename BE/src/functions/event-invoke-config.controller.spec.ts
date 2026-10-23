/**
 * L1: the routes of a function's settings for its asynchronous calls: who may
 * call each, and what the body may hold, through HTTP.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { EventInvokeConfigController } from './event-invoke-config.controller';
import { EventInvokeConfigService } from './event-invoke-config.service';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const reflector = new Reflector();
const rules = (handler: keyof EventInvokeConfigController) => {
  const method = EventInvokeConfigController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/functions/:id/event-invoke-config (L1)', () => {
  const configs = { get: jest.fn(async () => ({})), put: jest.fn(async () => ({})), remove: jest.fn(async () => undefined) };
  let app: INestApplication;
  let baseUrl: string;
  const put = (body: unknown) =>
    fetch(`${baseUrl}/functions/${ID}/event-invoke-config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventInvokeConfigController],
      providers: [{ provide: EventInvokeConfigService, useValue: configs }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read them, writers set them in an active account, and delete them in any', () => {
    expect([rules('get'), rules('put'), rules('remove')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'functions:read' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
      { roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' },
    ]);
  });

  it("takes Lambda's settings and destinations, and passes them on", async () => {
    const body = { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 600, destinationConfig: { onFailure: { destination: 'arn:aws:lambda:tn-tunis-1:000000000001:function:f' } } };

    expect((await put(body)).status).toBe(200);
    expect(configs.put).toHaveBeenCalledWith(ACCOUNT, ID, body);
  });

  it.each([
    [{ maximumRetryAttempts: 3 }, 'maximumRetryAttempts must not be greater than 2'],
    [{ maximumRetryAttempts: 1.5 }, 'maximumRetryAttempts must be an integer number'],
    [{ maximumEventAgeInSeconds: 59 }, 'maximumEventAgeInSeconds must not be less than 60'],
    [{ maximumEventAgeInSeconds: 21601 }, 'maximumEventAgeInSeconds must not be greater than 21600'],
    [{ destinationConfig: { onFailure: {} } }, 'destinationConfig.onFailure.destination must be a string'],
    [{ destinationConfig: { onSuccess: { destination: 'x', extra: 1 } } }, 'destinationConfig.onSuccess.property extra should not exist'],
    [{ qualifier: '$LATEST' }, 'property qualifier should not exist'],
  ])('refuses %j, saying why', async (body, problem) => {
    const res = await put(body);

    expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([problem])]);
    expect(configs.put).not.toHaveBeenCalled();
  });
});
