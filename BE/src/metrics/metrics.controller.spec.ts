/**
 * L1: GET /functions/:id/metrics, GET /metrics, GET /databases/:id/metrics, GET /buckets/:name/metrics,
 * GET /buckets/:name/website/metrics, GET /queues/:name/metrics, GET /caches/:name/metrics and GET /email/metrics
 * through HTTP, with the validation main.ts sets up: who may read them, the
 * account and the window they pass on, and what they refuse before asking the
 * database. Their SQL runs against PostgreSQL in customer-metrics.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { CustomerMetricsService } from './customer-metrics.service';
import { MetricsWindow } from './customer-metrics';
import { MetricsController } from './metrics.controller';

const ACCOUNT = '000000000001';
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const DB = '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f';

describe('GET /functions/:id/metrics and GET /metrics (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const forFunction = jest.fn(async (_accountId: string, _id: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forAccount = jest.fn(async (_accountId: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forDatabase = jest.fn(async (_accountId: string, _id: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forBucket = jest.fn(async (_accountId: string, _name: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forQueue = jest.fn(async (_accountId: string, _name: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forSite = jest.fn(async (_accountId: string, _name: string, _window: MetricsWindow) => ({ metrics: {} }));
  const forCache = jest.fn(async (_accountId: string, _name: string, _window: MetricsWindow) => ({ metrics: {} }));
  const emailMetrics = jest.fn(async (_accountId: string, _window: MetricsWindow) => ({ metrics: {} }));

  const get = (path: string) => fetch(`${baseUrl}${path}`);
  const refusal = async (path: string) => {
    const res = await get(path);
    return [res.status, (await res.json()).message];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: CustomerMetricsService, useValue: { forFunction, forAccount, forDatabase, forBucket, forQueue, forSite, forCache, emailMetrics } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.SUSPENDED, planId: 'beta', role: 'viewer' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read them, viewers included, even in an account that is not active, and a key with metrics:read', () => {
    const reflector = new Reflector();
    for (const handler of [
      MetricsController.prototype.forFunction,
      MetricsController.prototype.forAccount,
      MetricsController.prototype.forDatabase,
      MetricsController.prototype.forBucket,
      MetricsController.prototype.forSite,
      MetricsController.prototype.forQueue,
      MetricsController.prototype.forCache,
      MetricsController.prototype.forEmail,
    ]) {
      expect([reflector.get(ROLES, handler), reflector.get(ACTIVE_ACCOUNT, handler), reflector.get(SCOPE, handler)]).toEqual([undefined, undefined, 'metrics:read']);
    }
  });

  it("asks for the caller's account's function over the window named, in whole periods, a time zone's offset taken into account", async () => {
    const res = await get(`/functions/${FN}/metrics?period=300&start=2026-10-19T09:02:00Z&end=2026-10-19T10:58:00%2B01:00`);

    expect(res.status).toBe(200);
    expect(forFunction).toHaveBeenCalledWith(ACCOUNT, FN, { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T10:00:00Z'), period: 300 });
  });

  it("asks for the caller's account by default over the last 60 minutes, and this one", async () => {
    const before = Date.now();
    expect((await get('/metrics')).status).toBe(200);

    const [accountId, window] = forAccount.mock.calls[0];
    expect([accountId, window.period]).toEqual([ACCOUNT, 60]);
    expect(window.end.getTime() % 60_000).toBe(0);
    expect(window.end.getTime()).toBeGreaterThanOrEqual(before);
    // 61 minutes: the 60 before now's, and now's; 60 when now is a whole minute.
    expect([60 * 60_000, 61 * 60_000]).toContain(window.end.getTime() - window.start.getTime());
  });

  it('takes a period of a minute, five or an hour, and nothing else', async () => {
    for (const period of [60, 300, 3600]) expect((await get(`/metrics?period=${period}`)).status).toBe(200);
    for (const period of ['120', '0', 'hour', '60.5']) expect(await refusal(`/metrics?period=${period}`)).toEqual([400, ['period must be one of 60, 300, 3600 seconds']]);
    expect(forAccount).toHaveBeenCalledTimes(3);
  });

  it('refuses a time without its zone, or not a time, a start not before the end, too many points, and a field it has no use for', async () => {
    expect(await refusal('/metrics?start=2026-10-19T09:00:00')).toEqual([400, ['start must be an RFC 3339 time, such as 2026-10-19T09:00:00Z']]);
    expect(await refusal('/metrics?end=yesterday')).toEqual([400, ['end must be an RFC 3339 time, such as 2026-10-19T10:00:00Z']]);
    expect(await refusal('/metrics?start=2026-10-19T10:00:00Z&end=2026-10-19T09:00:00Z')).toEqual([400, 'start must be before end']);
    expect(await refusal('/metrics?start=2026-10-18T09:00:00Z&end=2026-10-19T09:01:00Z')).toEqual([
      400,
      'The window holds 1441 periods of 60 s: at most 1440. Take a longer period, or a shorter window',
    ]);
    expect(await refusal('/metrics?start=2026-10-12T09:00:00Z&end=2026-10-19T09:00:00Z&period=300')).toEqual([400, expect.stringContaining('2016 periods of 300 s')]);
    expect(await refusal('/metrics?stat=p99')).toEqual([400, ['property stat should not exist']]);
    expect(forAccount).not.toHaveBeenCalled();
  });

  it("asks for the caller's account's database a point an hour, over the last 60 hours by default, and refuses another period", async () => {
    expect((await get(`/databases/${DB}/metrics?start=2026-10-19T09:30:00Z&end=2026-10-19T12:10:00Z`)).status).toBe(200);
    expect(forDatabase).toHaveBeenCalledWith(ACCOUNT, DB, { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T13:00:00Z'), period: 3600 });

    expect((await get(`/databases/${DB}/metrics?period=3600`)).status).toBe(200);
    const [, , window] = forDatabase.mock.calls[1];
    expect(window.period).toBe(3600);
    // 61 hours: the 60 before now's, and now's; 60 when now is a whole hour.
    expect([60, 61]).toContain((window.end.getTime() - window.start.getTime()) / 3_600_000);
    expect(await refusal(`/databases/${DB}/metrics?period=60`)).toEqual([400, "A database's metrics have a point an hour: period must be 3600"]);
    expect(await refusal('/databases/orders/metrics')).toEqual([400, 'Validation failed (uuid is expected)']);
    expect(forDatabase).toHaveBeenCalledTimes(2);
  });

  it("asks for the caller's account's cache by its name, a point an hour, over the last 60 hours by default, and refuses another period", async () => {
    expect((await get('/caches/sessions/metrics?start=2026-10-19T09:30:00Z&end=2026-10-19T12:10:00Z')).status).toBe(200);
    expect(forCache).toHaveBeenCalledWith(ACCOUNT, 'sessions', { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T13:00:00Z'), period: 3600 });

    expect((await get('/caches/sessions/metrics')).status).toBe(200);
    const [, , window] = forCache.mock.calls[1];
    expect([60, 61]).toContain((window.end.getTime() - window.start.getTime()) / 3_600_000);
    expect(await refusal('/caches/sessions/metrics?period=300')).toEqual([400, "A cache's metrics have a point an hour: period must be 3600"]);
    expect(forCache).toHaveBeenCalledTimes(2);
  });

  it("asks for the caller's account's mail, a point an hour, and refuses another period", async () => {
    expect((await get('/email/metrics?start=2026-10-19T09:30:00Z&end=2026-10-19T12:10:00Z')).status).toBe(200);
    expect(emailMetrics).toHaveBeenCalledWith(ACCOUNT, { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T13:00:00Z'), period: 3600 });
    expect(await refusal('/email/metrics?period=60')).toEqual([400, "Mail's metrics have a point an hour: period must be 3600"]);
    expect(emailMetrics).toHaveBeenCalledTimes(1);
  });

  it("asks for the caller's account's bucket by its name, in any of the periods, over the window named", async () => {
    expect((await get('/buckets/photos/metrics?start=2026-10-19T09:30:00Z&end=2026-10-19T12:10:00Z&period=300')).status).toBe(200);
    expect(forBucket).toHaveBeenCalledWith(ACCOUNT, 'photos', { start: new Date('2026-10-19T09:30:00Z'), end: new Date('2026-10-19T12:10:00Z'), period: 300 });

    expect((await get('/buckets/photos/metrics')).status).toBe(200);
    expect(forBucket.mock.calls[1][2].period).toBe(60);
    expect(await refusal('/buckets/photos/metrics?period=86400')).toEqual([400, ['period must be one of 60, 300, 3600 seconds']]);
    expect(forBucket).toHaveBeenCalledTimes(2);
  });

  it("asks for the caller's account's bucket's site by the bucket's name, in any of the periods, over the window named", async () => {
    expect((await get('/buckets/shop/website/metrics?start=2026-10-30T09:30:00Z&end=2026-10-30T12:10:00Z&period=3600')).status).toBe(200);
    expect(forSite).toHaveBeenCalledWith(ACCOUNT, 'shop', { start: new Date('2026-10-30T09:00:00Z'), end: new Date('2026-10-30T13:00:00Z'), period: 3600 });
    expect(await refusal('/buckets/shop/website/metrics?period=120')).toEqual([400, ['period must be one of 60, 300, 3600 seconds']]);
    expect(forSite).toHaveBeenCalledTimes(1);
  });

  it("asks for the caller's account's queue by its name, in any of the periods, over the window named", async () => {
    expect((await get('/queues/orders/metrics?start=2026-10-24T09:30:00Z&end=2026-10-24T12:10:00Z&period=300')).status).toBe(200);
    expect(forQueue).toHaveBeenCalledWith(ACCOUNT, 'orders', { start: new Date('2026-10-24T09:30:00Z'), end: new Date('2026-10-24T12:10:00Z'), period: 300 });
    expect(await refusal('/queues/orders/metrics?period=86400')).toEqual([400, ['period must be one of 60, 300, 3600 seconds']]);
    expect(forQueue).toHaveBeenCalledTimes(1);
  });

  it("refuses a function's ID that isn't one", async () => {
    expect(await refusal('/functions/hello/metrics')).toEqual([400, 'Validation failed (uuid is expected)']);
    expect(forFunction).not.toHaveBeenCalled();
  });
});
