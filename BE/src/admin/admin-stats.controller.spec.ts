/**
 * L1: GET /admin/stats/overview through HTTP: the overview as the service
 * works it out. Its SQL runs against PostgreSQL in admin-stats.db.spec.ts; who
 * may call it is the guard's (auth.guard.spec.ts).
 */
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminStatsController } from './admin-stats.controller';
import { OverviewView } from './admin-stats.dto';
import { AdminStatsService } from './admin-stats.service';
import { IS_ADMIN } from './operator';

const overview: OverviewView = {
  computedAt: '2026-11-20T10:00:00.000Z',
  accounts: { byStatus: { pending: 2, active: 4, rejected: 1, suspended: 1, closed: 1 }, pendingApprovals: 2 },
  functions: { total: 4, byStatus: { ACTIVE: 2, ERROR: 1, CREATING: 1 } },
  today: { day: '2026-11-20', invocations: 7, errors: 4, throttles: 7 },
  month: '2026-11',
  money: [{ currency: 'TND', consumption: { charged: '2.200', debited: '1.500', shadow: '0.700' }, topUps: { payments: 1, credit: '100.000' }, balances: { owedByFF: '167.500', owedToFF: '4.200', walletsInDebt: 1 } }],
  invoices: { month: '2026-10', issued: 1, creditNotes: 0, toIssue: { month: '2026-10', drafts: 1, issuable: true } },
  capacity: [{ day: '2026-11-20', reservedGbS: 75, provisionedGbS: 75, billedGbS: 1.28, requests: 5 }],
};

describe('GET /admin/stats/overview (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const stats = { overview: jest.fn(async () => overview) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AdminStatsController], providers: [{ provide: AdminStatsService, useValue: stats }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  it("is one of the admin dashboard's routes: operators only", () => {
    expect(new Reflector().get(IS_ADMIN, AdminStatsController)).toBe(true);
  });

  it('answers the overview as the service works it out, money as strings to the millime', async () => {
    const res = await fetch(`${baseUrl}/admin/stats/overview`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(overview);
    expect(stats.overview).toHaveBeenCalledTimes(1);
  });
});
