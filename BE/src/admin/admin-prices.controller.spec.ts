/**
 * L1: the admin dashboard's price book and plan routes (client-readiness plan,
 * P-73) through HTTP, with the validation main.ts sets up: what each passes on,
 * and what each refuses. The services run against PostgreSQL in
 * admin-prices.db.spec.ts; who may call them is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { PlansService } from '../plans/plans.service';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPricesController } from './admin-prices.controller';
import { AdminPricesService, earliestStart, lastMonth } from './admin-prices.service';
import { CHANGES_NOTHING, IS_ADMIN, Operator } from './operator';

const OPERATOR: Operator = { id: 'kc-op-1', email: 'operator@ff.test' };
const BOOK_ID = '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60';

describe('the admin price book and plan routes (L1, P-73)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prices = {
    list: jest.fn(async () => []),
    create: jest.fn(async () => ({ id: BOOK_ID })),
    preview: jest.fn(async () => ({ month: '2026-09', currency: 'TND', accounts: [], totals: { current: '0.000', draft: '0.000' } })),
    remove: jest.fn(async () => undefined),
  };
  const plans = {
    list: jest.fn(async () => []),
    create: jest.fn(async () => ({ id: 'pro' })),
    update: jest.fn(async () => ({ plan: { id: 'beta' }, quota: { applied: 1, failed: 0 } })),
  };
  const call = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPricesController, AdminPlansController],
      providers: [
        { provide: AdminPricesService, useValue: prices },
        { provide: PlansService, useValue: plans },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // The operator, where the guard puts it (P-70).
    app.use((req: { operator?: Operator }, _res: unknown, next: () => void) => {
      req.operator = OPERATOR;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("are the admin dashboard's routes, and only the preview changes nothing", () => {
    const reflector = new Reflector();

    expect([AdminPricesController, AdminPlansController].map((controller) => reflector.get(IS_ADMIN, controller))).toEqual([true, true]);
    expect(
      ['list', 'create', 'preview', 'remove'].map((handler) => reflector.get(CHANGES_NOTHING, AdminPricesController.prototype[handler as keyof AdminPricesController])),
    ).toEqual([undefined, undefined, true, undefined]);
  });

  describe('the price books', () => {
    it('create one for the operator, from the instant given, with its document and reason', async () => {
      const res = await call('POST', '/admin/price-books', { validFrom: '2026-11-01T00:00:00Z', document: FIRST_PRICE_BOOK, reason: 'New BCT rate' });

      expect(res.status).toBe(201);
      expect(prices.create).toHaveBeenCalledWith(new Date('2026-11-01T00:00:00Z'), FIRST_PRICE_BOOK, OPERATOR, 'New BCT rate');
    });

    it.each([
      [{ validFrom: 'next week', document: {}, reason: 'why not' }, 'validFrom must be a valid ISO 8601 date string'],
      [{ validFrom: '2026-11-01T00:00:00Z', document: 'cheap', reason: 'why not' }, 'document must be an object'],
    ])('refuse a book that is not one: %j', async (body, message) => {
      expect(await refusal(await call('POST', '/admin/price-books', body))).toEqual([400, [message]]);
      expect(prices.create).not.toHaveBeenCalled();
    });

    it('preview a draft: 200, and nothing saved', async () => {
      const res = await call('POST', '/admin/price-books/preview', { document: FIRST_PRICE_BOOK });

      expect(res.status).toBe(200);
      expect(prices.preview).toHaveBeenCalledWith(FIRST_PRICE_BOOK);
      expect(prices.create).not.toHaveBeenCalled();
    });

    it('remove one by its ID, with the reason, and refuse an ID that is not one', async () => {
      expect((await call('DELETE', `/admin/price-books/${BOOK_ID}`, { reason: 'Wrong rate' })).status).toBe(200);
      expect(prices.remove).toHaveBeenCalledWith(BOOK_ID, 'Wrong rate');

      expect(await refusal(await call('DELETE', '/admin/price-books/first', { reason: 'Wrong rate' }))).toEqual([400, 'Validation failed (uuid is expected)']);
    });
  });

  describe('the plans', () => {
    it('change one: the name, the limits and the reason passed on, and the quota applied answered', async () => {
      const res = await call('PUT', '/admin/plans/beta', { name: 'Beta', limits: BETA_LIMITS, reason: 'Pilots need room' });

      expect([res.status, await res.json()]).toEqual([200, { plan: { id: 'beta' }, quota: { applied: 1, failed: 0 } }]);
      expect(plans.update).toHaveBeenCalledWith('beta', { name: 'Beta', limits: BETA_LIMITS }, 'Pilots need room');
    });

    it('create one, and refuse an ID that is not a plan ID', async () => {
      expect((await call('POST', '/admin/plans', { id: 'pro', name: 'Pro', limits: BETA_LIMITS, reason: 'For the pilots' })).status).toBe(201);
      expect(plans.create).toHaveBeenCalledWith('pro', 'Pro', BETA_LIMITS, 'For the pilots');

      expect(await refusal(await call('POST', '/admin/plans', { id: 'Pro Plan', name: 'Pro', limits: BETA_LIMITS, reason: 'For the pilots' }))).toEqual([
        400,
        ['id must be a plan ID: lowercase letters, digits, - and _, such as pro'],
      ]);
      expect(await refusal(await call('PUT', '/admin/plans/Beta!', { limits: BETA_LIMITS, reason: 'x y z' }))).toEqual([400, ['id must be a plan ID, such as beta']]);
    });
  });
});

describe('when a price book may start, and which month a preview prices (L1, P-73)', () => {
  it('starts on a whole hour, the next one at the earliest', () => {
    expect([earliestStart(new Date('2026-10-17T10:15:30Z')), earliestStart(new Date('2026-10-17T10:00:00Z')), earliestStart(new Date('2026-12-31T23:59:59Z'))]).toEqual([
      new Date('2026-10-17T11:00:00Z'),
      new Date('2026-10-17T11:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    ]);
  });

  it('previews last month by the UTC calendar', () => {
    expect([lastMonth(new Date('2026-10-17T12:00:00Z')), lastMonth(new Date('2027-01-01T00:30:00+01:00'))]).toEqual(['2026-09', '2026-11']);
  });
});
