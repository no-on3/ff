/**
 * L1: GET /usage (client-readiness plan, P-22) through HTTP, with the
 * validation main.ts sets up: who may call it, the month it reads, and JSON or
 * CSV. Its SQL runs against PostgreSQL in usage.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { usageCsv } from './usage-csv';
import { UsageController } from './usage.controller';
import { MonthlyUsageView } from './usage.dto';
import { UsageService } from './usage.service';

const ACCOUNT = '000000000001';
const VIEW: MonthlyUsageView = {
  month: '2026-09',
  functions: [
    {
      functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
      functionName: 'hello',
      deleted: false,
      requests: 2,
      billedMs: 3,
      gbSeconds: '0.000375',
      throttled: 0,
      platformErrors: 0,
      lost: 0,
    },
  ],
  totals: { requests: 2, billedMs: 3, gbSeconds: '0.000375', throttled: 0, platformErrors: 0, lost: 0 },
};

describe('GET /usage (L1, P-22)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const monthly = jest.fn(async (_accountId: string, month: string) => ({ ...VIEW, month }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsageController],
      providers: [{ provide: UsageService, useValue: { monthly } }],
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
  beforeEach(() => monthly.mockClear());

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

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ ...VIEW, month: new Date().toISOString().slice(0, 7) });
    expect(monthly).toHaveBeenCalledWith(ACCOUNT, new Date().toISOString().slice(0, 7));
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

  it('answers CSV to Accept: text/csv, as a download named after the account and the month', async () => {
    const res = await fetch(`${baseUrl}/usage?month=2026-09`, { headers: { accept: 'text/csv' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="ff-usage-${ACCOUNT}-2026-09.csv"`);
    expect(await res.text()).toBe(usageCsv(VIEW));
  });
});
