/**
 * L2: price books and plans, for operators (client-readiness plan, P-73),
 * against a real PostgreSQL server, in a scratch database that is dropped
 * after: a new book, the ones refused, removing one that hasn't started, the
 * books' statuses, a draft previewed on a fixture month, and plans changed
 * with their quota applied, or created.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { PricingService } from '../billing/pricing.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { AdminPricesService } from './admin-prices.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'kc-op-1', email: 'operator@ff.test' };
/** Next year: whatever day the tests run, its months are in the future. */
const Y = new Date().getUTCFullYear() + 1;
const NOW = new Date(`${Y}-02-10T10:15:00Z`);
/** The first book, its on-demand duration price doubled: a draft. */
const DOUBLED = {
  ...FIRST_PRICE_BOOK,
  source: { kind: 'manual', note: 'twice the duration' },
  prices: {
    ...FIRST_PRICE_BOOK.prices,
    gbSecond: [
      { upToGbSeconds: 6_000_000_000, price: '0.0001002668672' },
      { upToGbSeconds: 15_000_000_000, price: '0.00009024' },
      { upToGbSeconds: null, price: '0.0000802137344' },
    ],
  },
};

run('price books and plans, for operators (L2, P-73)', () => {
  let db: ScratchDatabase;
  let prices: AdminPricesService;
  let plans: PlansService;
  const applied: Array<{ accountId: string; tenant: TenantLimits }> = [];
  let failQuotaOf: string | null = null;
  const orchestrator = {
    applyTenantLimits: async (accountId: string, tenant: TenantLimits) => {
      if (accountId === failQuotaOf) throw new Error('the cluster refused');
      applied.push({ accountId, tenant });
    },
  } as unknown as Orchestrator;
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const entries = (action: string) => db.dataSource.getRepository(AuditEntry).find({ where: { action }, order: { id: 'ASC' } });
  async function account(planId = 'beta'): Promise<string> {
    const id = String(500000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId, status: AccountStatus.ACTIVE });
    return id;
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const table of ['usage_records', 'capacity_samples']) await query('SELECT ff_ensure_month_partition($1, $2::date)', [table, `${Y}-01-01`]);
    const ds = db.dataSource;
    const audit = new AuditService(ds.getRepository(AuditEntry));
    // As the request context would name the operator: the audit service takes the actor from it.
    const record = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementation((event, manager) => record({ actor: { id: `operator:${OPERATOR.id}`, label: OPERATOR.email }, ...event }, manager));
    const pricing = new PricingService(ds.getRepository(PriceBook), ds.getRepository(Currency));
    prices = new AdminPricesService(ds.getRepository(PriceBook), ds.getRepository(Currency), ds.getRepository(Account), pricing, audit);
    plans = new PlansService(ds.getRepository(Plan), ds.getRepository(Account), orchestrator, audit);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    applied.length = 0;
    failQuotaOf = null;
  });

  describe('a new price book', () => {
    it("starts on a whole hour in the future, made by the operator, with the reason in the audit log", async () => {
      const book = await prices.create(new Date(`${Y + 1}-01-01T00:00:00Z`), DOUBLED, OPERATOR, 'Twice the duration price, as a test', NOW);

      expect(book).toMatchObject({ status: 'scheduled', currency: 'TND', createdBy: 'operator:kc-op-1', document: DOUBLED });
      expect((await entries('price_book.create')).map((entry) => [entry.actor, entry.resource, entry.details])).toEqual([
        ['operator:kc-op-1', `price_book:${book.id}`, { reason: 'Twice the duration price, as a test', validFrom: `${Y + 1}-01-01T00:00:00.000Z`, currency: 'TND', source: DOUBLED.source }],
      ]);
    });

    it.each([
      ['an instant that is not a whole hour', `${Y + 1}-02-01T00:30:00Z`, 'validFrom must be a whole hour, UTC'],
      ['the hour now', `${Y}-02-10T10:00:00Z`, 'validFrom must be a whole hour, UTC'],
    ])('is refused for %s', async (_case, validFrom, message) => {
      await expect(prices.create(new Date(validFrom), DOUBLED, OPERATOR, 'x y z', NOW)).rejects.toThrow(message);
    });

    it("is refused when it doesn't fit, naming each problem, or when another starts at that hour", async () => {
      const refused = await prices.create(new Date(`${Y + 1}-03-01T00:00:00Z`), { ...FIRST_PRICE_BOOK, currency: 'EUR' }, OPERATOR, 'x y z', NOW).catch((error) => error);
      expect([refused instanceof BadRequestException, (refused as BadRequestException).getResponse()]).toEqual([
        true,
        expect.objectContaining({ message: ['currency: FF has no currency EUR'] }),
      ]);
      const notAws = { ...FIRST_PRICE_BOOK, prices: { ...FIRST_PRICE_BOOK.prices, requestsPerMillion: '0.5' } };
      await expect(prices.create(new Date(`${Y + 1}-03-01T00:00:00Z`), notAws, OPERATOR, 'x y z', NOW)).rejects.toThrow(BadRequestException);
      await expect(prices.create(new Date(`${Y + 1}-01-01T00:00:00Z`), DOUBLED, OPERATOR, 'again', NOW)).rejects.toThrow(
        new ConflictException(`A price book already starts at ${Y + 1}-01-01T00:00:00.000Z`),
      );
    });
  });

  it('removes a book that has not started, with the reason, and refuses one that has, or that does not exist', async () => {
    const book = await prices.create(new Date(`${Y + 2}-01-01T00:00:00Z`), DOUBLED, OPERATOR, 'to remove', NOW);
    const [first] = await db.dataSource.getRepository(PriceBook).find({ order: { validFrom: 'ASC' }, take: 1 });

    await prices.remove(book.id, 'Wrong date', NOW);
    await expect(prices.remove(first.id, 'Too cheap', NOW)).rejects.toThrow(
      new ConflictException(`Price book ${first.id} started on 2026-10-01T00:00:00.000Z: it is never changed or deleted`),
    );
    await expect(prices.remove(book.id, 'again', NOW)).rejects.toThrow(new NotFoundException(`Price book ${book.id} not found`));
    expect((await entries('price_book.delete')).map((entry) => entry.details)).toEqual([{ reason: 'Wrong date', validFrom: `${Y + 2}-01-01T00:00:00.000Z` }]);
  });

  it('lists the books oldest first: the one that prices usage now is active, the earlier past, the later scheduled', async () => {
    const statuses = (await prices.list(NOW)).map((book) => [book.validFrom.toISOString().slice(0, 10), book.status]);
    // The migrations' second book starts the month after they ran: customers' databases' and buckets' SKUs.
    const today = new Date();
    const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

    expect(statuses).toEqual([
      ['2026-10-01', 'past'],
      [nextMonth, 'active'],
      [`${Y + 1}-01-01`, 'scheduled'],
    ]);
    expect((await prices.list(new Date(`${Y + 1}-06-01T00:00:00Z`))).map((book) => book.status)).toEqual(['past', 'past', 'active']);
  });

  it("previews a draft on last month: each account at the draft, next to the books valid then and what was charged, and the totals", async () => {
    const [big, small] = [await account(), await account()];
    // 20,000,000 GB-s: well past the free tier's 400,000.
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), '${Y}-01-15T10:00:00Z', '${Y}-01-15T10:00:00Z', $1, gen_random_uuid(), 'big', 'nodejs', 10240, 1, 2000000000, 'success'),
              (gen_random_uuid(), '${Y}-01-15T10:00:00Z', '${Y}-01-15T10:00:00Z', $2, gen_random_uuid(), 'small', 'nodejs', 128, 1, 100, 'success')`,
      [big, small],
    );
    // What the hourly rating charged big (P-32): two hours of January; an hour of December and a charge in euros are not January's TND.
    await query(`INSERT INTO currencies (code, exponent) VALUES ('EUR', 2) ON CONFLICT DO NOTHING`);
    await query(
      `INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow)
       VALUES ($1, '${Y}-01-15T10:00:00Z', 'TND', 900000, 900000, true), ($1, '${Y}-01-15T11:00:00Z', 'TND', 82615, 982615, true),
              ($1, '${Y - 1}-12-31T23:00:00Z', 'TND', 5000, 5000, true), ($1, '${Y}-01-16T00:00:00Z', 'EUR', 5, 5, true)`,
      [big],
    );

    const books = await db.dataSource.getRepository(PriceBook).count();
    const preview = await prices.preview(DOUBLED, NOW);

    // 19,600,000 billed GB-s at the first book's 0.0000501334336, then at twice that; small was never rated.
    expect(preview).toEqual({
      month: `${Y}-01`,
      currency: 'TND',
      accounts: [
        { accountId: big, name: expect.any(String), current: '982.615', charged: '982.615', draft: '1965.231' },
        { accountId: small, name: expect.any(String), current: '0.000', charged: null, draft: '0.000' },
      ],
      totals: { current: '982.615', charged: '982.615', draft: '1965.231' },
    });
    expect(await db.dataSource.getRepository(PriceBook).count()).toBe(books); // nothing saved
  });

  describe('plans', () => {
    it("change a plan's limits for the reason, from what to what, apply its new quota to every account on it at once, with each one's egress, and read it fresh", async () => {
      await plans.create('team', 'Team', BETA_LIMITS, 'For pilots with a team');
      const [one, two] = [await account('team'), await account('team')];
      await query('UPDATE accounts SET internet_egress = true WHERE id = $1', [two]);
      await plans.get('team'); // in the cache now
      const quota = { pods: 40, cpu: '16', memory: '16Gi' };

      const changed = await plans.update('team', { name: 'Teams', limits: { ...BETA_LIMITS, functions: 50, quota } }, 'Pilots need room');

      expect(changed).toEqual({ plan: { id: 'team', name: 'Teams', limits: { ...BETA_LIMITS, functions: 50, quota } }, quota: { applied: 2, failed: 0 } });
      expect(applied).toEqual([
        { accountId: one, tenant: { quota, internetEgress: false } },
        { accountId: two, tenant: { quota, internetEgress: true } },
      ]);
      await expect(plans.get('team')).resolves.toMatchObject({ limits: { functions: 50 } });
      expect((await entries('plan.update')).map((entry) => entry.details)).toEqual([
        {
          reason: 'Pilots need room',
          changes: { name: { from: 'Team', to: 'Teams' }, functions: { from: 25, to: 50 }, quota: { from: BETA_LIMITS.quota, to: quota } },
        },
      ]);
    });

    it("write nothing for limits unchanged, apply nothing when the quota is the same, and count an account the cluster refused", async () => {
      await plans.create('solo', 'Solo', BETA_LIMITS, 'For one person');
      const refused = await account('solo');
      const before = (await entries('plan.update')).length;

      await plans.update('solo', { limits: BETA_LIMITS }, 'nothing');
      expect([(await entries('plan.update')).length, applied]).toEqual([before, []]);

      await plans.update('solo', { limits: { ...BETA_LIMITS, idleSeconds: 600 } }, 'Faster scale to zero');
      expect(applied).toEqual([]);

      failQuotaOf = refused;
      const changed = await plans.update('solo', { limits: { ...BETA_LIMITS, idleSeconds: 600, quota: { pods: 5, cpu: '2', memory: '2Gi' } } }, 'Smaller');
      expect(changed.quota).toEqual({ applied: 0, failed: 1 });
    });

    it('refuse limits that do not fit, naming each, a plan that does not exist, and a plan ID taken', async () => {
      const refused = await plans.update('beta', { limits: { ...BETA_LIMITS, memoryMb: 64, quota: { pods: 0 } } }, 'x y z').catch((error) => error);
      expect((refused as BadRequestException).getResponse()).toMatchObject({
        message: [
          'limits.memoryMb: Too small: expected number to be >=128',
          'limits.quota.pods: Too small: expected number to be >0',
          'limits.quota.cpu: Invalid input: expected string, received undefined',
          'limits.quota.memory: Invalid input: expected string, received undefined',
        ],
      });
      await expect(plans.update('gold', { limits: BETA_LIMITS }, 'x y z')).rejects.toThrow(new NotFoundException('Plan gold not found'));
      await expect(plans.create('beta', 'Beta again', BETA_LIMITS, 'x y z')).rejects.toThrow(new ConflictException('Plan beta exists already'));
      expect((await entries('plan.create')).map((entry) => [entry.resource, (entry.details as { reason: string }).reason])).toEqual([
        ['plan:team', 'For pilots with a team'],
        ['plan:solo', 'For one person'],
      ]);
    });
  });
});
