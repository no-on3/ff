/**
 * L1: the pro-forma routes (client-readiness plan, P-35; cancelling, P-74) through HTTP, with
 * the validation main.ts sets up: who may call them, the account they act
 * for, and what they refuse. The service runs against PostgreSQL in
 * payments.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../../accounts/entities/account.entity';
import { Principal } from '../../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../../auth/route-rules';
import { PaymentsService } from './payments.service';
import { ProFormasController } from './pro-formas.controller';

const ACCOUNT = '000000000001';
const PAYMENT = '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60';

describe('the pro-forma routes (L1, P-35)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const payments = {
    requestProForma: jest.fn(async () => ({ id: PAYMENT })),
    proFormas: jest.fn(async () => [{ id: PAYMENT }]),
    vatPercentNow: jest.fn(async () => 19),
    proForma: jest.fn(async () => ({ id: PAYMENT })),
    cancelProForma: jest.fn(async () => ({ id: PAYMENT, status: 'cancelled' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProFormasController],
      providers: [{ provide: PaymentsService, useValue: payments }],
    }).compile();
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

  it("let an owner ask for one, with a user's token, any account status; every member read them, and a usage:read key", () => {
    const reflector = new Reflector();
    const rules = (handler: object) => [reflector.get(ROLES, handler as never), reflector.get(ACTIVE_ACCOUNT, handler as never), reflector.get(SCOPE, handler as never)];

    expect(rules(ProFormasController.prototype.request)).toEqual([['owner'], undefined, undefined]); // no scope: no API key
    expect(rules(ProFormasController.prototype.list)).toEqual([undefined, undefined, 'usage:read']);
    expect(rules(ProFormasController.prototype.get)).toEqual([undefined, undefined, 'usage:read']);
    expect(rules(ProFormasController.prototype.cancel)).toEqual([['owner'], undefined, undefined]); // as asking: an owner, any status, no key
  });

  it("cancel the caller's account's, 200 with it, and refuse an ID that is not one (P-74)", async () => {
    const cancel = (id: string) => fetch(`${baseUrl}/billing/pro-formas/${id}/cancel`, { method: 'POST' });

    const res = await cancel(PAYMENT);
    expect([res.status, await res.json()]).toEqual([200, { id: PAYMENT, status: 'cancelled' }]);
    expect(payments.cancelProForma).toHaveBeenCalledWith(ACCOUNT, PAYMENT);
    expect((await cancel('FF-7KQ2-9MXA')).status).toBe(400);
    expect(payments.cancelProForma).toHaveBeenCalledTimes(1);
  });

  it("ask for one for the caller's account, and refuse a credit that is not an amount", async () => {
    const post = (body: unknown) => fetch(`${baseUrl}/billing/pro-formas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect((await post({ credit: '50.000' })).status).toBe(201);
    expect(payments.requestProForma).toHaveBeenCalledWith(ACCOUNT, '50.000');
    for (const credit of ['fifty', '50,000', '-5', '']) {
      const res = await post({ credit });
      expect([credit, res.status, (await res.json()).message]).toEqual([credit, 400, ['credit must be an amount, such as 50.000']]);
    }
    expect((await post({ credit: '50', accountId: '000000000002' })).status).toBe(400);
    expect(payments.requestProForma).toHaveBeenCalledTimes(1);
  });

  it("read the caller's account's, with the VAT rate a new one gets, and refuse an ID that is not one", async () => {
    expect(await (await fetch(`${baseUrl}/billing/pro-formas`)).json()).toEqual({ proFormas: [{ id: PAYMENT }], vatPercent: 19 });
    expect((await fetch(`${baseUrl}/billing/pro-formas/${PAYMENT}`)).status).toBe(200);
    expect([payments.proFormas.mock.calls, payments.proForma.mock.calls]).toEqual([[[ACCOUNT]], [[ACCOUNT, PAYMENT]]]);
    expect((await fetch(`${baseUrl}/billing/pro-formas/FF-7KQ2-9MXA`)).status).toBe(400);
  });
});
