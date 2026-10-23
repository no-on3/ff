/**
 * L1: the alarm routes through HTTP, with the validation main.ts sets up: who
 * may call each, and what an alarm's fields may be before the service judges
 * the rule as a whole. The service runs against PostgreSQL in alarms.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';

const ACCOUNT = '000000000001';
const ID = '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
const ALARM = {
  name: 'Checkout errors',
  functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
  metric: 'Errors',
  statistic: 'Sum',
  period: 60,
  comparison: 'GreaterThanThreshold',
  threshold: 5,
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  actions: { email: true, webhookUrls: ['https://example.tn/ff-hooks'] },
};

describe('the alarm routes (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const service = {
    list: jest.fn(async () => []),
    get: jest.fn(async () => ({ id: ID })),
    create: jest.fn(async () => ({ id: ID })),
    update: jest.fn(async () => ({ id: ID })),
    remove: jest.fn(async () => undefined),
  };

  const call = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AlarmsController], providers: [{ provide: AlarmsService, useValue: service }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('are read by every member and a key with alarms:read; changed by owners and developers of an active account, or a key with alarms:write', () => {
    const reflector = new Reflector();
    const rules = (handler: Parameters<Reflector['get']>[1]) => [reflector.get(ROLES, handler), reflector.get(ACTIVE_ACCOUNT, handler), reflector.get(SCOPE, handler)];
    const { list, get, create, update, remove } = AlarmsController.prototype;
    expect([list, get].map(rules)).toEqual([
      [undefined, undefined, 'alarms:read'],
      [undefined, undefined, 'alarms:read'],
    ]);
    for (const handler of [create, update, remove]) expect(rules(handler)).toEqual([['owner', 'developer'], true, 'alarms:write']);
  });

  it('passes an alarm on, the missing data treatment left to the service; replaces and deletes by ID', async () => {
    expect((await call('POST', '/alarms', ALARM)).status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(ACCOUNT, ALARM);
    expect((await call('PUT', `/alarms/${ID}`, { ...ALARM, treatMissingData: 'notBreaching' })).status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(ACCOUNT, ID, { ...ALARM, treatMissingData: 'notBreaching' });
    expect((await call('DELETE', `/alarms/${ID}`)).status).toBe(204);
    expect(service.remove).toHaveBeenCalledWith(ACCOUNT, ID);
    expect((await call('GET', `/alarms/${ID}`)).status).toBe(200);
    expect(await refusal(await call('GET', '/alarms/checkout'))).toEqual([400, 'Validation failed (uuid is expected)']);
  });

  it('refuses each field that is not one an alarm has, naming what it may be', async () => {
    const refused = async (change: object) => (await refusal(await call('POST', '/alarms', { ...ALARM, ...change })))[1] as string[];
    expect(await refused({ metric: 'Latency' })).toEqual([
      'metric must be one of Invocations, Errors, Throttles, ColdStarts, Duration, Instances, DatabaseConnections, VolumeBytesUsed, BucketSizeBytes, NumberOfObjects, AllRequests, GetRequests, PutRequests, 4xxErrors, 5xxErrors, BytesDownloaded, BytesUploaded, Balance, MonthToDateCharges',
    ]);
    expect(await refused({ statistic: 'Median' })).toEqual(['statistic must be one of Sum, Average, Maximum, p50, p95, p99, Latest']);
    expect(await refused({ period: 120 })).toEqual(['period must be one of 60, 300, 3600 seconds']);
    expect(await refused({ comparison: 'Above' })).toEqual(['comparison must be one of GreaterThanThreshold, GreaterThanOrEqualToThreshold, LessThanThreshold, LessThanOrEqualToThreshold']);
    expect(await refused({ threshold: '5' })).toEqual(['threshold must be a number conforming to the specified constraints']);
    expect(await refused({ evaluationPeriods: 61 })).toEqual(['evaluationPeriods must not be greater than 60']);
    expect(await refused({ datapointsToAlarm: 0 })).toEqual(['datapointsToAlarm must not be less than 1']);
    expect(await refused({ treatMissingData: 'zero' })).toEqual(['treatMissingData must be one of missing, notBreaching, breaching, ignore']);
    expect(await refused({ functionId: 'checkout' })).toEqual(['functionId must be a UUID']);
    expect(await refused({ name: '' })).toEqual(['name must be longer than or equal to 1 characters']);
    expect(await refused({ actions: { email: true, webhookUrls: Array(6).fill('https://example.tn') } })).toEqual(['actions.webhookUrls must contain no more than 5 elements']);
    expect(await refused({ actions: { email: 'yes', webhookUrls: [] } })).toEqual(['actions.email must be a boolean value']);
    expect(await refused({ state: 'OK' })).toEqual(['property state should not exist']);
    expect(service.create).not.toHaveBeenCalled();
  });
});
