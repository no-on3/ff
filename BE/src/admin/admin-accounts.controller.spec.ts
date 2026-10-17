/**
 * L1: the admin dashboard's account routes (client-readiness plan, P-71;
 * credit grants, P-74) through HTTP, with the validation main.ts sets up: what each passes to the
 * service, and what each refuses. The service runs against PostgreSQL in
 * admin-accounts.db.spec.ts; who may call them is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PlansService } from '../plans/plans.service';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminCreditsService } from './admin-credits.service';
import { IS_ADMIN } from './operator';

const ID = '000000000042';
const PAGE = { accounts: [], next: null };
const VIEW = { account: { id: ID }, members: [], functions: [], usage: {}, statusHistory: [] };
const KEY = '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
const GRANT = { id: 'tx-1', kind: 'promo', currency: 'TND', amount: '25.000', balance: '25.000', createdAt: '2026-10-17T10:00:00.000Z', replayed: false };

describe('the admin account routes (L1, P-71)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const accounts = {
    list: jest.fn(async () => PAGE),
    detail: jest.fn(async () => VIEW),
    auditLog: jest.fn(async () => ({ entries: [], next: null })),
    changeStatus: jest.fn(async () => VIEW),
    changePlan: jest.fn(async () => VIEW),
    setEgress: jest.fn(async () => VIEW),
  };
  const plans = { list: jest.fn(async () => [{ id: 'beta', name: 'Beta', limits: {} }]) };
  const credits = { grant: jest.fn(async () => GRANT) };

  const call = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAccountsController, AdminPlansController],
      providers: [
        { provide: AdminAccountsService, useValue: accounts },
        { provide: PlansService, useValue: plans },
        { provide: AdminCreditsService, useValue: credits },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("are the admin dashboard's routes: operators only", () => {
    expect([AdminAccountsController, AdminPlansController].map((controller) => new Reflector().get(IS_ADMIN, controller))).toEqual([true, true]);
  });

  describe('GET /admin/accounts', () => {
    it('passes the search, the filters and the page on', async () => {
      const before = '2026-10-17T10:13:11.986123_000000000001';

      const res = await call('GET', `/admin/accounts?q=%20amira%20&status=pending&plan=beta&limit=10&before=${before}`);

      expect([res.status, await res.json()]).toEqual([200, PAGE]);
      expect(accounts.list).toHaveBeenCalledWith({ q: ' amira ', status: 'pending', planId: 'beta' }, { limit: 10, before });
    });

    it('gives 50 accounts a page by default', async () => {
      await call('GET', '/admin/accounts');

      expect(accounts.list).toHaveBeenCalledWith({ q: undefined, status: undefined, planId: undefined }, { limit: 50, before: undefined });
    });

    it.each([
      ['status=waiting', 'status must be one of: pending, active, rejected, suspended, closed'],
      ['plan=Beta%20plan', 'plan must be a plan ID, such as beta'],
      ['limit=101', 'limit must not be greater than 100'],
      ['before=2026-10-17T10:13:11Z_000000000001', "before must be the previous page's next"],
      [`q=${'x'.repeat(201)}`, 'q must be shorter than or equal to 200 characters'],
    ])('refuses %s', async (query, message) => {
      expect(await refusal(await call('GET', `/admin/accounts?${query}`))).toEqual([400, [message]]);
      expect(accounts.list).not.toHaveBeenCalled();
    });
  });

  it('GET /admin/accounts/:id gives the account page, and refuses an ID that is not one', async () => {
    expect([(await call('GET', `/admin/accounts/${ID}`)).status, accounts.detail.mock.calls]).toEqual([200, [[ID]]]);
    expect(await refusal(await call('GET', '/admin/accounts/42'))).toEqual([400, ['id must be an account ID: 12 digits']]);
  });

  it("GET /admin/accounts/:id/audit-log pages the account's whole log", async () => {
    await call('GET', `/admin/accounts/${ID}/audit-log?limit=20&before=99`);

    expect(accounts.auditLog).toHaveBeenCalledWith(ID, { limit: 20, before: '99' });
  });

  describe('the status changes', () => {
    it.each(['approve', 'reject', 'suspend', 'reactivate', 'close'])('POST /admin/accounts/:id/%s: 200 with the account page, for the reason given', async (change) => {
      const res = await call('POST', `/admin/accounts/${ID}/${change}`, { reason: 'Checked the use case' });

      expect([res.status, await res.json()]).toEqual([200, VIEW]);
      expect(accounts.changeStatus).toHaveBeenCalledWith(ID, change, 'Checked the use case');
    });

    it('need a reason, and take nothing else: no status sent along', async () => {
      expect(await refusal(await call('POST', `/admin/accounts/${ID}/approve`, {}))).toEqual([
        400,
        ['reason must be longer than or equal to 3 characters', 'reason must be a string'],
      ]);
      expect(await refusal(await call('POST', `/admin/accounts/${ID}/suspend`, { reason: 'abuse', status: 'closed' }))).toEqual([
        400,
        ['property status should not exist'],
      ]);
      expect(accounts.changeStatus).not.toHaveBeenCalled();
    });
  });

  it('PUT /admin/accounts/:id/plan moves the account, and refuses a plan ID that is not one', async () => {
    await call('PUT', `/admin/accounts/${ID}/plan`, { planId: 'large', reason: 'Needs more room' });
    expect(accounts.changePlan).toHaveBeenCalledWith(ID, 'large', 'Needs more room');

    expect(await refusal(await call('PUT', `/admin/accounts/${ID}/plan`, { planId: '../beta', reason: 'Needs more room' }))).toEqual([
      400,
      ['planId must be a plan ID, such as beta'],
    ]);
  });

  it('PUT /admin/accounts/:id/egress sets the flag, and takes only true or false', async () => {
    await call('PUT', `/admin/accounts/${ID}/egress`, { internetEgress: true, reason: 'Calls a payment API' });
    expect(accounts.setEgress).toHaveBeenCalledWith(ID, true, 'Calls a payment API');

    expect(await refusal(await call('PUT', `/admin/accounts/${ID}/egress`, { internetEgress: 'yes', reason: 'Calls a payment API' }))).toEqual([
      400,
      ['internetEgress must be a boolean value'],
    ]);
    expect(accounts.setEgress).toHaveBeenCalledTimes(1);
  });

  describe('POST /admin/accounts/:id/credits (P-74)', () => {
    const grant = { kind: 'promo', amount: '25.000', reason: 'Welcome credit for the pilot', idempotencyKey: KEY };

    it('grants, then answers 201 with the grant and the account page as it is after', async () => {
      const res = await call('POST', `/admin/accounts/${ID}/credits`, grant);

      expect([res.status, await res.json()]).toEqual([201, { grant: GRANT, account: VIEW }]);
      expect(credits.grant).toHaveBeenCalledWith(ID, grant);
      expect(credits.grant.mock.invocationCallOrder[0]).toBeLessThan(accounts.detail.mock.invocationCallOrder[0]);
    });

    it('passes on a correction that takes credit away, its amount typed again, and leaving a debt', async () => {
      const correction = { ...grant, kind: 'adjustment', amount: '-250.000', confirmAmount: '-250.000', allowDebt: true };

      expect((await call('POST', `/admin/accounts/${ID}/credits`, correction)).status).toBe(201);
      expect(credits.grant).toHaveBeenCalledWith(ID, correction);
    });

    it.each([
      [{ kind: 'refund' }, 'kind must be one of: promo, adjustment'],
      [{ amount: 25 }, 'amount must be an amount such as 25.000, or -5.000 for a correction that takes credit away'],
      [{ amount: '1e3' }, 'amount must be an amount such as 25.000, or -5.000 for a correction that takes credit away'],
      [{ amount: '+5' }, 'amount must be an amount such as 25.000, or -5.000 for a correction that takes credit away'],
      [{ amount: '1'.repeat(17) }, 'amount must be an amount such as 25.000, or -5.000 for a correction that takes credit away'],
      [{ confirmAmount: 'yes' }, 'confirmAmount must be the amount typed again, such as 250.000'],
      [{ allowDebt: 'yes' }, 'allowDebt must be a boolean value'],
      [{ idempotencyKey: 'retry-1' }, 'idempotencyKey must be a UUID, made once per grant'],
      [{ reason: 'no' }, 'reason must be longer than or equal to 3 characters'],
      [{ accountId: '000000000001' }, 'property accountId should not exist'],
    ])('refuses %j, granting nothing', async (change, message) => {
      expect(await refusal(await call('POST', `/admin/accounts/${ID}/credits`, { ...grant, ...change }))).toEqual([400, [message]]);
      expect(credits.grant).not.toHaveBeenCalled();
    });

    it('needs the kind, the amount, the reason and the key', async () => {
      const [status, messages] = await refusal(await call('POST', `/admin/accounts/${ID}/credits`, {}));

      expect(status).toBe(400);
      expect(messages).toEqual(
        expect.arrayContaining(['kind must be one of: promo, adjustment', 'reason must be a string', 'idempotencyKey must be a UUID, made once per grant']),
      );
      expect(messages.some((message: string) => message.startsWith('amount must be'))).toBe(true);
      expect(credits.grant).not.toHaveBeenCalled();
    });

    it('refuses an ID that is not an account', async () => {
      expect(await refusal(await call('POST', '/admin/accounts/42/credits', grant))).toEqual([400, ['id must be an account ID: 12 digits']]);
    });
  });

  it('GET /admin/plans lists the plans an account can move to', async () => {
    const res = await call('GET', '/admin/plans');

    expect([res.status, await res.json()]).toEqual([200, [{ id: 'beta', name: 'Beta', limits: {} }]]);
  });
});
