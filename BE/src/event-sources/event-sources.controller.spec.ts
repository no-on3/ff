/**
 * L1: the routes of functions reading queues, as Lambda's event source
 * mappings: who may call each, and what the bodies may hold, through HTTP.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { EventSourcesController } from './event-sources.controller';
import { EventSourcesService } from './event-sources.service';

const ACCOUNT = '000000000001';
const FUNCTION = '6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70';
const MAPPING = '1f0e2d3c-4b5a-4968-8776-655443322110';
const ARN = `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders`;
const reflector = new Reflector();
const rules = (handler: keyof EventSourcesController) => {
  const method = EventSourcesController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/functions/:id/event-sources and /event-sources (L1)', () => {
  const eventSources = {
    listForFunction: jest.fn(async () => []),
    create: jest.fn(async () => ({})),
    list: jest.fn(async () => []),
    get: jest.fn(async () => ({})),
    update: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
  };
  const principal: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
  let app: INestApplication;
  let baseUrl: string;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const refusal = async (response: Response) => [response.status, ((await response.json()) as { message: string[] }).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventSourcesController],
      providers: [{ provide: EventSourcesService, useValue: eventSources }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = principal;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("lets every member read them; writers make and change them in an active account, and delete them in any, as a function's settings", () => {
    for (const handler of ['listForFunction', 'list', 'get'] as const) {
      expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
    }
    expect([rules('create'), rules('update')]).toEqual([
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
    ]);
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' });
  });

  it("takes Lambda's settings by their names, and passes them on", async () => {
    const body = {
      eventSourceArn: ARN,
      batchSize: 100,
      maximumBatchingWindowInSeconds: 5,
      functionResponseTypes: ['ReportBatchItemFailures'],
      scalingConfig: { maximumConcurrency: 2 },
      enabled: false,
    };

    expect((await call('POST', `/functions/${FUNCTION}/event-sources`, body)).status).toBe(201);
    expect(eventSources.create).toHaveBeenCalledWith(ACCOUNT, FUNCTION, body);
    expect((await call('PATCH', `/event-sources/${MAPPING}`, { scalingConfig: null, functionResponseTypes: [] })).status).toBe(200);
    expect(eventSources.update).toHaveBeenCalledWith(ACCOUNT, MAPPING, { scalingConfig: null, functionResponseTypes: [] });
    expect((await call('GET', `/event-sources?eventSourceArn=${encodeURIComponent(ARN)}`)).status).toBe(200);
    expect(eventSources.list).toHaveBeenCalledWith(ACCOUNT, ARN);
    expect((await call('GET', `/functions/${FUNCTION}/event-sources`)).status).toBe(200);
    expect((await call('GET', `/event-sources/${MAPPING}`)).status).toBe(200);
    expect((await call('DELETE', `/event-sources/${MAPPING}`)).status).toBe(204);
    expect([eventSources.listForFunction.mock.calls, eventSources.get.mock.calls, eventSources.remove.mock.calls]).toEqual([
      [[ACCOUNT, FUNCTION]],
      [[ACCOUNT, MAPPING]],
      [[ACCOUNT, MAPPING]],
    ]);
  });

  it.each([
    [{ eventSourceArn: ARN, batchSize: 0 }, 'batchSize must not be less than 1'],
    [{ eventSourceArn: ARN, batchSize: 10_001 }, 'batchSize must not be greater than 10000'],
    [{ eventSourceArn: ARN, maximumBatchingWindowInSeconds: 301 }, 'maximumBatchingWindowInSeconds must not be greater than 300'],
    [{ eventSourceArn: ARN, functionResponseTypes: ['ReportItemFailures'] }, 'each value in functionResponseTypes must be one of the following values: ReportBatchItemFailures'],
    [{ eventSourceArn: ARN, scalingConfig: { maximumConcurrency: 1 } }, 'scalingConfig.maximumConcurrency must not be less than 2'],
    [{ eventSourceArn: ARN, scalingConfig: { maximumConcurrency: 1001 } }, 'scalingConfig.maximumConcurrency must not be greater than 1000'],
    [{ eventSourceArn: ARN, enabled: 'yes' }, 'enabled must be a boolean value'],
    [{ batchSize: 5 }, 'eventSourceArn must be a string'],
    [{ eventSourceArn: ARN, filterCriteria: {} }, 'property filterCriteria should not exist'],
  ])('refuses %j before the service is called', async (body, problem) => {
    const [status, messages] = await refusal(await call('POST', `/functions/${FUNCTION}/event-sources`, body));

    expect([status, messages]).toEqual([400, expect.arrayContaining([problem])]);
    expect(eventSources.create).not.toHaveBeenCalled();
  });

  it("refuses an ID that isn't a UUID, the function's or the mapping's", async () => {
    expect((await call('GET', '/functions/orders/event-sources')).status).toBe(400);
    expect((await call('PATCH', '/event-sources/orders', {})).status).toBe(400);
    expect((await call('DELETE', '/event-sources/orders')).status).toBe(400);
    expect([eventSources.listForFunction, eventSources.update, eventSources.remove].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });
});
