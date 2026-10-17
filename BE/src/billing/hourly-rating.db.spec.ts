/**
 * L2: the hourly rating (client-readiness plan, P-32, D9) against a real
 * PostgreSQL server, in scratch databases that are dropped after: an hour's
 * charge is the account's month so far, rated and rounded once, less the
 * month's earlier charges; hours rated again, a price change at a whole hour,
 * the free tier at a month's start, minInstances and the monthly fee, shadow
 * mode, and the parent's reconciliation criterion (rated usage equals raw
 * usage); then the job: settling, catching up, two backends at once, and what
 * an account reads of its money.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { DEFAULT_SETTINGS } from '../admin/platform-settings';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { databaseConfiguration } from '../config/configuration';
import { createScratchDatabase } from '../database/scratch-database';
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { BillingService } from './billing.service';
import { Currency } from './currency.entity';
import { HourlyRatingService } from './hourly-rating.service';
import { LedgerService } from './ledger/ledger.service';
import { PriceBook } from './price-book.entity';
import { PriceDocument } from './price-book';
import { PricingService } from './pricing.service';
import { HOUR_MS } from './rating-hours';
import { reconcile, reconciled } from './reconciliation';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
/** Next year: its books start in the future whenever the tests run, as the database requires of a new book. */
const Y = new Date().getUTCFullYear() + 1;
const at = (iso: string) => new Date(`${Y}-${iso}Z`);
const MINUTE = 60_000;
const SETTLE = 33 * MINUTE;

/** A scratch database with the services the rating needs, shadow mode as each test sets it. */
async function ratingWorld() {
  const db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
  await db.dataSource.runMigrations({ transaction: 'each' });
  for (let month = 1; month <= 8; month++) {
    for (const table of ['usage_records', 'capacity_samples']) await db.dataSource.query('SELECT ff_ensure_month_partition($1, $2::date)', [table, `${Y}-${String(month).padStart(2, '0')}-01`]);
  }
  const ds = db.dataSource;
  const state = { shadow: true };
  const settings = { get: async () => ({ ...DEFAULT_SETTINGS, billingShadowMode: state.shadow }) } as unknown as PlatformSettingsService;
  const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService; // a 90 s cold start: 33 min to settle
  const pricing = new PricingService(ds.getRepository(PriceBook), ds.getRepository(Currency));
  const ledger = new LedgerService(ds);
  const newRating = () => new HourlyRatingService(ds, pricing, ledger, settings, config);
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => ds.query<T>(sql, parameters);
  return {
    db,
    state,
    pricing,
    ledger,
    rating: newRating(),
    newRating,
    billing: new BillingService(ds, ledger, settings),
    query,
    async account(): Promise<string> {
      const id = String(600000000000 + ++n);
      await ds.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
      return id;
    },
    /** A call that started at `start`, billed as given. */
    call: (accountId: string, functionId: string, start: Date, fields: { billedMs?: number; memoryMb?: number; minInstances?: number; status?: string } = {}) =>
      query(
        `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, min_instances, duration_ms, billed_ms, status)
         VALUES (gen_random_uuid(), $1, $1, $2, $3, 'fn', 'nodejs', $4, $5, $6::numeric, $6::int, $7)`,
        [start, accountId, functionId, fields.memoryMb ?? 128, fields.minInstances ?? 0, fields.billedMs ?? 0, fields.status ?? 'success'],
      ),
    sample: (accountId: string, functionId: string, minute: Date, instances: number, minInstances: number, memoryMb: number) =>
      query('INSERT INTO capacity_samples (function_id, minute, account_id, instances, min_instances, memory_mb) VALUES ($1, $2, $3, $4, $5, $6)', [
        functionId,
        minute,
        accountId,
        instances,
        minInstances,
        memoryMb,
      ]),
    /** A book from `validFrom`, on the first book's, with these prices and free tier. */
    addBook: (validFrom: Date, prices: Partial<PriceDocument['prices']>, freeTier = { requests: 0, gbSeconds: 0 }) =>
      ds.getRepository(PriceBook).save({
        currency: 'TND',
        validFrom,
        prices: { ...FIRST_PRICE_BOOK, source: { kind: 'test' }, freeTier, prices: { ...FIRST_PRICE_BOOK.prices, ...prices } },
        createdBy: 'test',
      }),
    /** The hour before `first` rated, as a previous run leaves it: rating starts at `first`. */
    startAt: (first: Date) => query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES ($1, 0, true)`, [new Date(first.getTime() - HOUR_MS)]),
    /** An account's charges, hour by hour: [hour, charge, month so far, shadow, debited]. */
    charges: async (accountId: string) =>
      (
        await query<Array<{ hour: Date; amount: string; mtd: string; shadow: boolean; debited: boolean }>>(
          `SELECT hour, amount_minor::text AS amount, month_to_date_minor::text AS mtd, shadow, ledger_transaction_id IS NOT NULL AS debited
             FROM usage_charges WHERE account_id = $1 ORDER BY hour`,
          [accountId],
        )
      ).map((row) => [row.hour.toISOString().slice(5, 13), Number(row.amount), Number(row.mtd), row.shadow, row.debited]),
  };
}
/** Prices that make the arithmetic plain: only requests cost, at this price per million. */
const REQUESTS_ONLY = (perMillion: string): Partial<PriceDocument['prices']> => ({ requestsPerMillion: perMillion, gbSecond: [{ upToGbSeconds: null, price: '0' }] });

run('the hourly rating (L2, P-32)', () => {
  let w: Awaited<ReturnType<typeof ratingWorld>>;
  /** Rates `count` hours from `first`, in order. */
  const rateHours = async (first: Date, count: number) => {
    for (let i = 0; i < count; i++) await w.rating.rateHour(new Date(first.getTime() + i * HOUR_MS));
  };

  beforeAll(async () => {
    w = await ratingWorld();
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  describe('January: the month so far, rounded once, and debited', () => {
    const first = at('01-01T00:00:00');
    let a: string;
    let b: string;
    let idle: string;
    const fnA = randomUUID();

    beforeAll(async () => {
      await w.addBook(first, REQUESTS_ONLY('400')); // 0.0004 TND a request, no free tier
      [a, b, idle] = [await w.account(), await w.account(), await w.account()];
      // a: a call at 00:10, 01:10 and 02:10, none at 03:00, two at 04:10; b: three at 02:30.
      for (const time of ['00:10', '01:10', '02:10', '04:10', '04:20']) await w.call(a, fnA, at(`01-01T${time}:00`));
      const fnB = randomUUID();
      for (const time of ['02:30', '02:31', '02:32']) await w.call(b, fnB, at(`01-01T${time}:00`));
      await w.startAt(first);
      w.state.shadow = false;
      await rateHours(first, 5);
    });

    it('charges each hour the month so far, rounded once, less what earlier hours were charged: 0.0004 TND a call gives 0, 1, 0, -, 1 millimes', async () => {
      expect(await w.charges(a)).toEqual([
        ['01-01T00', 0, 0, false, false], // 0.0004: rounds to 0, and nothing is debited
        ['01-01T01', 1, 1, false, true], // 0.0008: 1 millime
        ['01-01T02', 0, 1, false, false], // 0.0012
        // 03:00: no usage, no charge
        ['01-01T04', 1, 2, false, true], // 0.0020; rounded hour by hour, the hours would give 1 in all
      ]);
      expect(await w.charges(b)).toEqual([['01-01T02', 1, 1, false, true]]); // 0.0012
      expect(await w.charges(idle)).toEqual([]);
    });

    it('debits each charge with one ledger transaction, keyed by account and hour, at the hour', async () => {
      const debits = await w.query(
        `SELECT t.kind, t.idempotency_key, t.occurred_at, t.metadata, e.amount_minor::text AS amount
           FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
           JOIN ledger_accounts l ON l.id = e.ledger_account_id
          WHERE l.account_id = $1 ORDER BY t.occurred_at`,
        [a],
      );
      expect(debits).toEqual([
        { kind: 'usage', idempotency_key: `usage:${a}:${Y}-01-01T01`, occurred_at: at('01-01T01:00:00'), metadata: { hour: at('01-01T01:00:00').toISOString(), monthToDate: '0.001' }, amount: '-1' },
        { kind: 'usage', idempotency_key: `usage:${a}:${Y}-01-01T04`, occurred_at: at('01-01T04:00:00'), metadata: { hour: at('01-01T04:00:00').toISOString(), monthToDate: '0.002' }, amount: '-1' },
      ]);
      expect(await w.ledger.balance(a, 'TND')).toBe(-2n);
    });

    it('rates an hour once: again, it writes nothing', async () => {
      const count = () => w.query(`SELECT (SELECT count(*) FROM usage_hourly)::int AS h, (SELECT count(*) FROM usage_charges)::int AS c, (SELECT count(*) FROM ledger_transactions)::int AS t`);
      const before = await count();

      await w.rating.rateHour(at('01-01T04:00:00'));
      await w.rating.rateHour(at('01-01T00:00:00'));

      expect(await count()).toEqual(before);
      expect(await w.ledger.balance(a, 'TND')).toBe(-2n);
    });

    it("keeps each hour's sums, per function, as the rater takes them", async () => {
      const rows = await w.query(
        `SELECT hour, on_demand_requests::int AS requests, price_book_id = (SELECT id FROM price_books WHERE valid_from = $2) AS book
           FROM usage_hourly WHERE account_id = $1 ORDER BY hour`,
        [a, first],
      );
      expect(rows).toEqual([
        { hour: at('01-01T00:00:00'), requests: 1, book: true },
        { hour: at('01-01T01:00:00'), requests: 1, book: true },
        { hour: at('01-01T02:00:00'), requests: 1, book: true },
        { hour: at('01-01T04:00:00'), requests: 2, book: true },
      ]);
    });

    it('gives the account its balance and this month’s charges, and only its own transactions, newest first, a page at a time', async () => {
      const balance = await w.billing.balance(a, at('01-01T10:00:00'));
      expect(balance).toMatchObject({ currency: 'TND', balance: '-0.002', shadowMode: false, month: `${Y}-01`, charged: '0.002' });

      const firstPage = await w.billing.transactions(a, { limit: 1 });
      expect(firstPage.transactions.map((t) => [t.kind, t.occurredAt, t.amount, t.currency])).toEqual([['usage', at('01-01T04:00:00'), '-0.001', 'TND']]);
      const secondPage = await w.billing.transactions(a, { limit: 1, before: firstPage.next as string });
      expect([secondPage.transactions.map((t) => t.occurredAt), secondPage.next]).toEqual([[at('01-01T01:00:00')], null]);
      const ofB = await w.billing.transactions(b, { limit: 50 });
      expect([ofB.transactions.map((t) => [t.occurredAt, t.amount]), ofB.next]).toEqual([[[at('01-01T02:00:00'), '-0.001']], null]);
    });

    it('refuses an hour whose hour before is not rated: hours are rated in order', async () => {
      await expect(w.rating.rateHour(at('01-01T07:00:00'))).rejects.toThrow(
        `Rate ${at('01-01T06:00:00').toISOString()} before ${at('01-01T07:00:00').toISOString()}: hours are rated in order`,
      );
    });
  });

  describe('February: shadow mode, then debits', () => {
    it('records the charges of shadow mode without debiting them, and once it is off debits each hour its own charge only', async () => {
      const first = at('02-01T00:00:00');
      await w.addBook(first, REQUESTS_ONLY('1000000')); // 1 TND a request
      const a = await w.account();
      const fn = randomUUID();
      for (const time of ['00:05', '00:06', '01:05']) await w.call(a, fn, at(`02-01T${time}:00`));
      await w.startAt(first);

      w.state.shadow = true;
      await rateHours(first, 1);
      w.state.shadow = false;
      await rateHours(at('02-01T01:00:00'), 1);

      expect(await w.charges(a)).toEqual([
        ['02-01T00', 2000, 2000, true, false],
        ['02-01T01', 1000, 3000, false, true], // not 3.000: the shadow hour stays free
      ]);
      expect(await w.ledger.balance(a, 'TND')).toBe(-1000n);
      expect(await w.query(`SELECT hour, shadow FROM rating_runs WHERE hour >= $1 ORDER BY hour LIMIT 2`, [first])).toEqual([
        { hour: first, shadow: true },
        { hour: at('02-01T01:00:00'), shadow: false },
      ]);
    });
  });

  describe('March: a price change', () => {
    it("prices each hour with the book valid in it, either side of a change at a whole hour, and the month's fee with the first", async () => {
      await w.addBook(at('03-01T00:00:00'), REQUESTS_ONLY('1000000')); // 1 TND a request
      await w.addBook(at('03-10T12:00:00'), { ...REQUESTS_ONLY('2000000'), monthlyPlanFee: '9.000' }); // 2 TND from noon on the 10th; its fee from April
      const a = await w.account();
      const fn = randomUUID();
      await w.call(a, fn, at('03-10T11:59:59.999'));
      await w.call(a, fn, at('03-10T12:00:00'));
      await w.startAt(at('03-10T11:00:00'));
      w.state.shadow = false;

      await rateHours(at('03-10T11:00:00'), 2);

      expect(await w.charges(a)).toEqual([
        ['03-10T11', 1000, 1000, false, true],
        ['03-10T12', 2000, 3000, false, true],
      ]);
    });

    it('takes no book that starts within an hour: each hour has one book', async () => {
      for (const start of ['03-20T12:30:00', '03-20T12:00:00.500']) {
        await expect(w.addBook(at(start), REQUESTS_ONLY('1'))).rejects.toThrow(/violates check constraint/);
      }
    });
  });

  describe('April to May: the free tier', () => {
    it("counts the free tier again from a month's first hour", async () => {
      await w.addBook(at('04-01T00:00:00'), REQUESTS_ONLY('1000000'), { requests: 2, gbSeconds: 0 }); // 1 TND a request, the first two free
      const a = await w.account();
      const fn = randomUUID();
      for (const time of ['04-30T23:01', '04-30T23:02', '04-30T23:03', '05-01T00:01', '05-01T00:02', '05-01T00:03']) await w.call(a, fn, at(`${time}:00`));
      await w.startAt(at('04-30T23:00:00'));
      w.state.shadow = false;

      await rateHours(at('04-30T23:00:00'), 2);

      expect(await w.charges(a)).toEqual([
        ['04-30T23', 1000, 1000, false, true],
        ['05-01T00', 1000, 1000, false, true], // not 3.000: May's first two calls are free again
      ]);
    });
  });

  describe('June: minInstances and the monthly fee', () => {
    it('charges held minInstances and their calls at the provisioned prices, without the free tier, and the monthly fee once', async () => {
      const first = at('06-01T00:00:00');
      await w.addBook(
        first,
        {
          requestsPerMillion: '1000', // 0.001 TND a request
          gbSecond: [{ upToGbSeconds: null, price: '0.001' }],
          provisionedGbSecond: '0.001',
          provisionedDurationGbSecond: '0.002',
          monthlyPlanFee: '5.000',
        },
        { requests: 1_000_000, gbSeconds: 400_000 },
      );
      const a = await w.account();
      const [warm, cold] = [randomUUID(), randomUUID()];
      // warm: minInstances 1 of 1,024 MB, sampled at 00:00 and 00:01, then 01:00; two 1 s calls on it.
      for (const minute of ['00:00', '00:01', '01:00']) await w.sample(a, warm, at(`06-01T${minute}:00`), 1, 1, 1024);
      for (const time of ['00:10', '00:11']) await w.call(a, warm, at(`06-01T${time}:00`), { billedMs: 1000, memoryMb: 1024, minInstances: 1 });
      // cold: three calls the free tier covers; and a throttled one, which isn't billed.
      for (const time of ['00:20', '00:21', '00:22']) await w.call(a, cold, at(`06-01T${time}:00`), { billedMs: 100, memoryMb: 128 });
      await w.call(a, cold, at('06-01T00:23:00'), { billedMs: 5000, memoryMb: 128, status: 'throttled' });
      await w.startAt(first);
      w.state.shadow = false;

      await rateHours(first, 2);

      // 00:00: the fee 5.000, two held minutes 120 GB-s × 0.001 = 0.120, the warm calls 2 GB-s × 0.002 + 2 × 0.001 = 0.006.
      // 01:00: one held minute, 0.060.
      expect(await w.charges(a)).toEqual([
        ['06-01T00', 5126, 5126, false, true],
        ['06-01T01', 60, 5186, false, true],
      ]);
    });
  });

  describe('July: reconciliation', () => {
    const first = at('07-01T00:00:00');
    const accounts: string[] = [];

    beforeAll(async () => {
      // The first book's prices, three duration tiers, a minimum billed duration, and a small free tier, so every account pays something.
      await w.addBook(first, { minimumBilledMs: 1000 }, { requests: 10, gbSeconds: 1 });
      let seed = 42;
      const next = (below: number) => (seed = (seed * 16807) % 2147483647) % below; // Park and Miller: exact in a double
      const memories = [128, 256, 512, 1024, 2048];
      const statuses = ['success', 'success', 'success', 'error', 'timeout', 'throttled', 'lost', 'platform_error'];
      for (let i = 0; i < 3; i++) accounts.push(await w.account());
      for (const account of accounts) {
        const fns = [randomUUID(), randomUUID()];
        for (let hour = 0; hour < 6; hour++) {
          for (let c = 0; c < 4 + next(8); c++) {
            const start = new Date(first.getTime() + hour * HOUR_MS + next(3_600_000));
            await w.call(account, fns[next(2)], start, { billedMs: 1 + next(3000), memoryMb: memories[next(5)], minInstances: next(4) === 0 ? 1 : 0, status: statuses[next(8)] });
          }
          await w.sample(account, fns[0], new Date(first.getTime() + hour * HOUR_MS + next(60) * MINUTE), 2, 1, 512);
          await w.call(account, fns[1], new Date(first.getTime() + hour * HOUR_MS + 5 * MINUTE), { billedMs: 1, memoryMb: 10_240 }); // billed as 1 s: 0.0005 TND
        }
        await w.call(account, fns[0], at('07-01T09:00:00'), { billedMs: 600_000, memoryMb: 10_240 }); // after the last hour rated, not charged yet: 0.30 TND
      }
      await w.startAt(first);
      w.state.shadow = true;
      await rateHours(first, 6);
    });

    it("charges each account, to the millime, what its usage records and samples price to, and sums every billed call: the parent's criterion", async () => {
      const result = await reconcile(w.db.dataSource, w.pricing, `${Y}-07`);

      expect(result.ratedUntil).toEqual(at('07-01T06:00:00'));
      expect(result.accounts.map((account) => account.accountId)).toEqual(accounts);
      expect(result.accounts.filter((account) => !reconciled(account))).toEqual([]);
      expect(result.accounts.every((account) => account.chargedMinor > 0n && account.ratedRequests > 0n)).toBe(true);
    });

    it('shows a call whose record arrived after its hour was rated, which no charge includes', async () => {
      await w.call(accounts[1], randomUUID(), at('07-01T02:30:00'), { billedMs: 900_000, memoryMb: 10_240 }); // 9,000 GB-s: 0.4512 TND

      const result = await reconcile(w.db.dataSource, w.pricing, `${Y}-07`);

      const late = result.accounts[1];
      expect(reconciled(late)).toBe(false);
      // The month's total rounds once, so 0.4512 TND more moves it by 451 or 452 millimes.
      expect([late.rawRequests - late.ratedRequests, [451n, 452n].includes(late.estimatedMinor - late.chargedMinor)]).toEqual([1n, true]);
      expect(result.accounts.filter((account) => !reconciled(account)).map((account) => account.accountId)).toEqual([accounts[1]]);
    });
  });
});

run('the hourly rating, interrupted (L2, P-32)', () => {
  let w: Awaited<ReturnType<typeof ratingWorld>>;

  beforeAll(async () => {
    w = await ratingWorld();
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('finishes an hour that a failure stopped half way, charging each account once', async () => {
    const hour = at('08-01T00:00:00');
    await w.addBook(hour, REQUESTS_ONLY('1000000'));
    const first = await w.account();
    const second = String(699999999999); // usage of an account that the database doesn't have yet: its charge fails
    await w.call(first, randomUUID(), at('08-01T00:10:00'));
    await w.call(second, randomUUID(), at('08-01T00:20:00'));
    await w.startAt(hour);
    w.state.shadow = false;

    await expect(w.rating.rateHour(hour)).rejects.toThrow(/violates foreign key constraint/);
    expect([await w.charges(first), await w.query(`SELECT count(*)::int AS n FROM rating_runs WHERE hour = $1`, [hour])]).toEqual([[['08-01T00', 1000, 1000, false, true]], [{ n: 0 }]]);

    await w.db.dataSource.getRepository(Account).save({ id: second, name: 'Late', planId: 'beta', status: AccountStatus.ACTIVE });
    await w.rating.rateHour(hour);

    expect([await w.charges(first), await w.charges(second)]).toEqual([[['08-01T00', 1000, 1000, false, true]], [['08-01T00', 1000, 1000, false, true]]]);
    expect(await w.ledger.balance(first, 'TND')).toBe(-1000n);
  });
});

run('the hourly rating job (L2, P-32)', () => {
  let w: Awaited<ReturnType<typeof ratingWorld>>;
  let a: string;
  const fn = randomUUID();

  beforeAll(async () => {
    w = await ratingWorld();
    a = await w.account();
    // A call in each hour from 10:00 to 20:00, in January.
    for (let hour = 10; hour <= 20; hour++) await w.call(a, fn, at(`01-01T${hour}:30:00`));
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('starts, on its first run, at the first book’s start, 1 October 2026', async () => {
    const hours = await w.rating.dueHours(new Date('2026-10-01T05:00:00Z'));

    expect(hours.map((hour) => hour.toISOString())).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', '2026-10-01T02:00:00.000Z', '2026-10-01T03:00:00.000Z']);
  });

  it('rates an hour once it has settled, 33 minutes after its end, and not before', async () => {
    await w.startAt(at('01-01T10:00:00'));

    expect(await w.rating.rateDueHours(new Date(at('01-01T11:00:00').getTime() + SETTLE - 1))).toBe(0);
    expect(await w.rating.rateDueHours(new Date(at('01-01T11:00:00').getTime() + SETTLE))).toBe(1);
    expect(await w.query(`SELECT hour FROM usage_hourly WHERE account_id = $1`, [a])).toEqual([{ hour: at('01-01T10:00:00') }]);
  });

  it('catches up every hour it missed, in order, after a stop', async () => {
    expect(await w.rating.rateDueHours(at('01-01T15:40:00'))).toBe(4);

    expect((await w.query<Array<{ hour: Date }>>(`SELECT hour FROM rating_runs WHERE hour >= $1 ORDER BY hour`, [at('01-01T10:00:00')])).map((row) => row.hour)).toEqual(
      ['10', '11', '12', '13', '14'].map((hour) => at(`01-01T${hour}:00:00`)),
    );
  });

  it('rates each hour once when two backends take their turn at the same moment, or two turns come here at once', async () => {
    const [other, now] = [w.newRating(), at('01-01T20:40:00')];

    const [here, there] = await Promise.all([w.rating.rateDueHours(now), other.rateDueHours(now)]);

    expect([here + there, Math.min(here, there)]).toEqual([5, 0]);
    expect(await w.query(`SELECT hour::text FROM usage_charges WHERE account_id = $1 GROUP BY hour HAVING count(*) > 1`, [a])).toEqual([]);
    const [busy, idle] = await Promise.all([w.rating.rateDueHours(at('01-01T21:40:00')), w.rating.rateDueHours(at('01-01T21:40:00'))]);
    expect([busy, idle]).toEqual([1, 0]);
  });

  it('says how far the rating has come, in the balance', async () => {
    expect(await w.billing.balance(a, at('01-01T22:00:00'))).toMatchObject({ shadowMode: true, ratedUntil: at('01-01T21:00:00'), charged: '0.000' });
  });
});
