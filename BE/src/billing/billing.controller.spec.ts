/**
 * L1: GET /billing/balance and GET /billing/transactions (client-readiness
 * plan, P-32) through HTTP, with the validation main.ts sets up: who may call
 * them, the account they read, and the page they take. Their SQL runs
 * against PostgreSQL in hourly-rating.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

const ACCOUNT = '000000000001';
const BALANCE = { currency: 'TND', balance: '-0.250', shadowMode: false, month: '2026-10', charged: '12.750', ratedUntil: new Date('2026-10-17T10:00:00Z') };
const PAGE = {
  transactions: [
    { id: 'tx-1', kind: 'usage', occurredAt: new Date('2026-10-17T09:00:00Z'), createdAt: new Date('2026-10-17T10:33:05Z'), amount: '-0.750', currency: 'TND' },
  ],
  next: '2026-10-17T10:33:05.123456_6f1c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
};

describe('GET /billing/balance and /billing/transactions (L1, P-32)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const balance = jest.fn(async () => BALANCE);
  const transactions = jest.fn(async () => PAGE);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: { balance, transactions } }],
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

  it('lets every member read them, viewers included, even in an account that is not active, and a key with usage:read', () => {
    const reflector = new Reflector();
    for (const handler of [BillingController.prototype.balance, BillingController.prototype.transactions]) {
      expect([reflector.get(ROLES, handler), reflector.get(ACTIVE_ACCOUNT, handler), reflector.get(SCOPE, handler)]).toEqual([undefined, undefined, 'usage:read']);
    }
  });

  it("answers the caller's account's balance, money as strings", async () => {
    const res = await fetch(`${baseUrl}/billing/balance`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...BALANCE, ratedUntil: '2026-10-17T10:00:00.000Z' });
    expect(balance).toHaveBeenCalledWith(ACCOUNT);
  });

  it("answers the caller's account's transactions, 50 a page unless asked, and the next page from `next`", async () => {
    expect(await (await fetch(`${baseUrl}/billing/transactions`)).json()).toEqual(JSON.parse(JSON.stringify(PAGE)));
    await fetch(`${baseUrl}/billing/transactions?limit=10&before=${PAGE.next}`);

    expect(transactions.mock.calls).toEqual([
      [ACCOUNT, { limit: 50, before: undefined }],
      [ACCOUNT, { limit: 10, before: PAGE.next }],
    ]);
  });

  it('refuses a page that is not one, and another parameter', async () => {
    const refused = async (query: string) => {
      const res = await fetch(`${baseUrl}/billing/transactions?${query}`);
      return [res.status, (await res.json()).message];
    };

    expect(await refused('limit=0')).toEqual([400, ['limit must not be less than 1']]);
    expect(await refused('limit=101')).toEqual([400, ['limit must not be greater than 100']]);
    expect(await refused('before=2026-10-17')).toEqual([400, ["before must be the previous page's next"]]);
    expect(await refused('account=000000000002')).toEqual([400, ['property account should not exist']]);
    expect(transactions).not.toHaveBeenCalled();
  });
});
