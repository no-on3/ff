/**
 * L1: GET /usage (client-readiness plan, P-22, P-30) through HTTP, with the
 * validation main.ts sets up: who may call it, the month it reads, its
 * estimated cost, and JSON or CSV. Its SQL runs against PostgreSQL in
 * usage.db.spec.ts and pricing.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { Decimal } from '../billing/decimal';
import { AccountEstimate, PricingService } from '../billing/pricing.service';
import { usageCsv } from './usage-csv';
import { UsageController } from './usage.controller';
import { MonthlyUsageView, UsageMonth } from './usage.dto';
import { UsageService } from './usage.service';

const ACCOUNT = '000000000001';
const HELLO = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const WARM = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const GONE = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f';
const RECORDS: UsageMonth = {
  month: '2026-09',
  functions: [
    { functionId: HELLO, functionName: 'hello', deleted: false, requests: 2, billedMs: 3, gbSeconds: '0.000375', throttled: 0, platformErrors: 0, lost: 0 },
  ],
  totals: { requests: 2, billedMs: 3, gbSeconds: '0.000375', throttled: 0, platformErrors: 0, lost: 0 },
};
const d = (text: string) => Decimal.parse(text);
const costOf = (total: string) => ({ requests: Decimal.ZERO, duration: d(total), provisioned: Decimal.ZERO, idle: Decimal.ZERO, total: d(total) });
const ESTIMATE: AccountEstimate = {
  // hello's calls; WARM held minInstances without a call; GONE too, and was deleted since; a function that cost nothing has no line.
  functions: new Map([
    [HELLO, costOf('0.0123456')],
    [WARM, costOf('1.5')],
    [GONE, costOf('0.25')],
    ['d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a', costOf('0')],
  ]),
  usage: d('1.7623456'),
  freeTier: d('-0.0123456'),
  volumeTiers: Decimal.ZERO,
  monthlyFee: Decimal.ZERO,
  total: d('1.75'),
  currency: 'TND',
  exponent: 3,
  pricedFrom: new Date('2026-09-01T00:00:00Z'),
  books: [{ id: 'book-1', validFrom: new Date('2026-09-01T00:00:00Z') }],
};
const NO_CALLS = { requests: 0, billedMs: 0, gbSeconds: '0', throttled: 0, platformErrors: 0, lost: 0 };
const PRICED: MonthlyUsageView = {
  ...RECORDS,
  functions: [
    { ...RECORDS.functions[0], cost: '0.012' },
    { functionId: WARM, functionName: 'warm', deleted: false, ...NO_CALLS, cost: '1.500' },
    { functionId: GONE, functionName: '', deleted: true, ...NO_CALLS, cost: '0.250' },
  ],
  estimate: {
    currency: 'TND',
    usage: '1.762',
    freeTier: '-0.012',
    volumeTiers: '0.000',
    monthlyFee: '0.000',
    total: '1.750',
    pricedFrom: new Date('2026-09-01T00:00:00Z'),
    priceBooks: ['book-1'],
  },
};

describe('GET /usage (L1, P-22, P-30)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const monthly = jest.fn(async (_accountId: string, month: string) => ({ ...RECORDS, month }));
  const functionNames = jest.fn(async () => new Map([[WARM, 'warm']]));
  const estimate = jest.fn(async (): Promise<AccountEstimate | null> => ESTIMATE);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsageController],
      providers: [
        { provide: UsageService, useValue: { monthly, functionNames } },
        { provide: PricingService, useValue: { estimate } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'viewer' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read, viewers included, even in an account that is not active, and a key with usage:read', () => {
    const reflector = new Reflector();
    const handler = UsageController.prototype.get;

    expect([reflector.get(ROLES, handler), reflector.get(ACTIVE_ACCOUNT, handler), reflector.get(SCOPE, handler)]).toEqual([
      undefined,
      undefined,
      'usage:read',
    ]);
  });

  it("answers the caller's account's month as JSON, this month by the UTC calendar without one", async () => {
    const res = await fetch(`${baseUrl}/usage`);
    const month = new Date().toISOString().slice(0, 7);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await res.json()).month).toBe(month);
    expect([monthly.mock.calls, estimate.mock.calls]).toEqual([[[ACCOUNT, month]], [[ACCOUNT, month]]]);
  });

  it("prices it (P-30): each function's cost before the free tier, the month's estimate, each rounded to the millime", async () => {
    const res = await fetch(`${baseUrl}/usage?month=2026-09`);

    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(PRICED)));
  });

  it('gives a line to a function that cost something without a call, named when it still exists', async () => {
    await fetch(`${baseUrl}/usage?month=2026-09`);

    expect(functionNames).toHaveBeenCalledWith(ACCOUNT, [WARM, GONE]);
  });

  it('has no cost and no estimate for a month that no price book covers', async () => {
    estimate.mockResolvedValueOnce(null);

    const body = await (await fetch(`${baseUrl}/usage?month=2025-01`)).json();

    expect([body.functions.map((fn: { cost: unknown }) => fn.cost), body.estimate]).toEqual([[null], null]);
  });

  it('reads the month asked for, and refuses one that is not YYYY-MM, or another parameter', async () => {
    expect((await fetch(`${baseUrl}/usage?month=2026-09`)).status).toBe(200);
    expect(monthly).toHaveBeenLastCalledWith(ACCOUNT, '2026-09');

    for (const query of ['month=2026-13', 'month=2026-9', 'month=last', 'month=2026-09-01']) {
      const res = await fetch(`${baseUrl}/usage?${query}`);
      expect([query, res.status, (await res.json()).message]).toEqual([query, 400, ['month must be a month as YYYY-MM, such as 2026-10']]);
    }
    expect((await fetch(`${baseUrl}/usage?month=2026-09&account=000000000002`)).status).toBe(400);
    expect(monthly).toHaveBeenCalledTimes(1);
  });

  it('answers CSV to Accept: text/csv, as a download named after the account and the month, with the costs', async () => {
    const res = await fetch(`${baseUrl}/usage?month=2026-09`, { headers: { accept: 'text/csv' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="ff-usage-${ACCOUNT}-2026-09.csv"`);
    expect(await res.text()).toBe(usageCsv(PRICED));
  });
});
