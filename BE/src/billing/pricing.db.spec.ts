/**
 * L2: price books and pricing (client-readiness plan, P-30, D8) against a real
 * PostgreSQL server, in a scratch database that is dropped after: the first
 * book as the migration loads it, the rule that a started book never changes,
 * and months priced from usage records and capacity samples, a book that
 * starts mid-month and the minimum billed duration included.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { monthPartitions } from '../usage/usage.service';
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { Currency } from './currency.entity';
import { Decimal } from './decimal';
import { PriceBook } from './price-book.entity';
import { PriceDocument } from './price-book';
import { PricingService } from './pricing.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const d = (text: string) => Decimal.parse(text);
/** Next year: its books start in the future whenever the tests run, as the database requires of a new book. */
const Y = new Date().getUTCFullYear() + 1;

run('price books and pricing (L2, P-30)', () => {
  let db: ScratchDatabase;
  let pricing: PricingService;
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const fn = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  async function account(): Promise<string> {
    const id = String(400000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    return id;
  }
  const call = (accountId: string, functionId: string, at: string, fields: { billedMs: number; memoryMb: number; minInstances?: number; status?: string }) =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, min_instances, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, 'fn', 'nodejs', $4, $5, $6::numeric, $6::int, $7)`,
      [at, accountId, functionId, fields.memoryMb, fields.minInstances ?? 0, fields.billedMs, fields.status ?? 'success'],
    );
  /** A minute's sample of a function's $LATEST, or of its version's Deployment. */
  const sample = (accountId: string, functionId: string, minute: string, instances: number, minInstances: number, memoryMb: number, version = 0) =>
    query('INSERT INTO capacity_samples (function_id, version, minute, account_id, instances, min_instances, memory_mb) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      functionId,
      version,
      minute,
      accountId,
      instances,
      minInstances,
      memoryMb,
    ]);
  /** The migrations' last book: from next month's first hour, the one with customers' databases' and buckets' SKUs. */
  const lastSystemBook = () => db.dataSource.getRepository(PriceBook).findOneOrFail({ where: { createdBy: 'system' }, order: { validFrom: 'DESC' } });
  const addBook = (validFrom: string, prices: Partial<PriceDocument['prices']>) =>
    db.dataSource.getRepository(PriceBook).save({
      currency: 'TND',
      validFrom: new Date(validFrom),
      prices: { ...FIRST_PRICE_BOOK, source: { kind: 'test' }, prices: { ...FIRST_PRICE_BOOK.prices, ...prices } },
      createdBy: 'test',
    });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await monthPartitions(db.dataSource, [`${Y}-01`, `${Y}-03`, `${Y}-04`]);
    pricing = new PricingService(db.dataSource.getRepository(PriceBook), db.dataSource.getRepository(Currency));
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('the data', () => {
    it("has TND, whose minor unit is a thousandth, and the first book, from 2026-10-01, as D8 sets it", async () => {
      expect(await query('SELECT code, exponent FROM currencies')).toEqual([{ code: 'TND', exponent: 3 }]);
      const [first] = await db.dataSource.getRepository(PriceBook).find({ order: { validFrom: 'ASC' }, take: 1 });
      expect([first.currency, first.validFrom.toISOString(), first.createdBy, first.prices]).toEqual(['TND', '2026-10-01T00:00:00.000Z', 'system', FIRST_PRICE_BOOK]);
    });

    it('never changes or deletes a book that has started, nor adds one that starts in the past', async () => {
      const [first] = await query<Array<{ id: string }>>(`SELECT id FROM price_books WHERE valid_from = '2026-10-01T00:00:00Z'`);
      const message = `The price book ${first.id} started on 2026-10-01 00:00:00+00: it is never changed or deleted, as past usage keeps its prices`;

      await expect(query(`UPDATE price_books SET prices = '{}' WHERE id = $1`, [first.id])).rejects.toThrow(message);
      await expect(query('DELETE FROM price_books WHERE id = $1', [first.id])).rejects.toThrow(message);
      // The hourly sums name their book (P-32), so the foreign key refuses first; with CASCADE, the triggers do.
      await expect(query('TRUNCATE price_books')).rejects.toThrow('cannot truncate a table referenced in a foreign key constraint');
      await expect(query('TRUNCATE price_books CASCADE')).rejects.toThrow(/is append-only: TRUNCATE refused/);
      await expect(addBook('2026-10-15T00:00:00Z', {})).rejects.toThrow('A price book starts in the future, not on 2026-10-15 00:00:00+00');
    });

    it('takes a book that starts in the future, which can change or go until it starts, though not into the past', async () => {
      const future = await addBook(`${Y + 3}-01-01T00:00:00Z`, { requestsPerMillion: '1' });

      await query(`UPDATE price_books SET valid_from = '${Y + 3}-02-01T00:00:00Z' WHERE id = $1`, [future.id]);
      await expect(query(`UPDATE price_books SET valid_from = '2020-01-01T00:00:00Z' WHERE id = $1`, [future.id])).rejects.toThrow(
        'A price book starts in the future, not on 2020-01-01 00:00:00+00',
      );
      await query('DELETE FROM price_books WHERE id = $1', [future.id]);
    });

    it('gives the usage records from before P-30 no minInstances: 0', async () => {
      const accountId = await account();
      await query(
        `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
         VALUES (gen_random_uuid(), '${Y}-01-02T00:00:00Z', '${Y}-01-02T00:00:00Z', $1, gen_random_uuid(), 'old', 'nodejs', 128, 1, 1, 'success')`,
        [accountId],
      );
      expect(await query('SELECT min_instances FROM usage_records WHERE account_id = $1', [accountId])).toEqual([{ min_instances: 0 }]);
    });
  });

  it('has no estimate for a month that no book covers', async () => {
    await expect(pricing.estimate(await account(), '2026-09')).resolves.toBeNull();
  });

  it("prices a month through a book that starts in its middle: each call with its book, the free tier counted from the month's start", async () => {
    // With a monthly fee, which the book valid at the month's start decides, not this one.
    const later = await addBook(`${Y}-01-16T00:00:00Z`, { requestsPerMillion: '1', gbSecond: [{ upToGbSeconds: null, price: '0.0001' }], monthlyPlanFee: '9.000' });
    const accountId = await account();
    const [onDemand, warm] = [fn(), fn()];
    await call(accountId, onDemand, `${Y}-01-05T10:00:00Z`, { billedMs: 1000, memoryMb: 1024 }); // 1 GB-s, the first book
    await call(accountId, onDemand, `${Y}-01-10T10:00:00Z`, { billedMs: 5000, memoryMb: 1024, status: 'throttled' }); // not billed
    await call(accountId, onDemand, `${Y}-01-20T10:00:00Z`, { billedMs: 2000, memoryMb: 512 }); // 1 GB-s, the later book
    await call(accountId, warm, `${Y}-01-20T10:00:30Z`, { billedMs: 1000, memoryMb: 1024, minInstances: 2 }); // provisioned: no free tier
    for (const minute of ['10:00', '10:01', '10:02']) await sample(accountId, warm, `${Y}-01-20T${minute}:00Z`, 3, 2, 1024);
    await sample(accountId, warm, `${Y}-01-20T10:03:00Z`, 1, 2, 1024); // one of its two minInstances ready
    await call(await account(), onDemand, `${Y}-01-20T10:00:00Z`, { billedMs: 1000, memoryMb: 1024 }); // another account's

    const month = await pricing.estimate(accountId, `${Y}-01`);

    const first = FIRST_PRICE_BOOK.prices;
    // The on-demand calls cost their two books' prices, and the free tier takes all of it off.
    expect(month?.functions.get(onDemand)?.total.toString()).toBe(
      d(first.requestsPerMillion).times(d('0.000001')).plus(d(first.gbSecond[0].price)).plus(d('0.000001')).plus(d('0.0001')).toString(),
    );
    expect(month?.freeTier.toString()).toBe(month?.functions.get(onDemand)?.total.negated().toString());
    // The warm function: its call at the later book's request price and provisioned duration, and the minInstances that
    // were ready, at 1 GB and the provisioned price: 2 for 3 minutes, then 1 for a minute, 420 GB-s.
    const warmCost = d('0.000001').plus(d(first.provisionedDurationGbSecond)).plus(d('420').times(d(first.provisionedGbSecond)));
    expect(month?.functions.get(warm)?.total.toString()).toBe(warmCost.toString());
    expect([month?.total.toString(), month?.total.toFixed(3), month?.currency, month?.exponent]).toEqual([warmCost.toString(), '0.005', 'TND', 3]);
    expect(month?.monthlyFee.isZero()).toBe(true);
    expect(month?.books.map((book) => book.validFrom.toISOString())).toEqual([(await lastSystemBook()).validFrom.toISOString(), later.validFrom.toISOString()]);
    expect(month?.pricedFrom.toISOString()).toBe(`${Y}-01-01T00:00:00.000Z`);
  });

  it("applies the book's minimum billed duration to each call, and prices instance time no call used, a version's at its own memory", async () => {
    await addBook(`${Y}-03-01T00:00:00Z`, { minimumBilledMs: 100, idleInstanceGbSecond: '0.001', monthlyPlanFee: '2.500' });
    const accountId = await account();
    const short = fn();
    // 1,000 calls of 1 ms at 1,024 MB: billed 100 ms each, so 100 GB-s, not 1.
    for (let i = 0; i < 10; i++) {
      await query(
        `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
         SELECT gen_random_uuid(), '${Y}-03-10T10:00:00Z'::timestamptz + make_interval(secs => g), '${Y}-03-10T10:00:00Z', $1, $2, 'short', 'nodejs', 1024, 1, 1, 'success'
           FROM generate_series(${i * 100}, ${i * 100 + 99}) AS g`,
        [accountId, short],
      );
    }
    // 10 minutes of 2 instances at 1,024 MB, none of them minInstances: 1,200 GB-s, of which calls used 100. And version 1's
    // Deployment beside them, sampled apart at the 2,048 MB it was published with: 1,200 GB-s more.
    for (let minute = 0; minute < 10; minute++) {
      await sample(accountId, short, `${Y}-03-10T11:${String(minute).padStart(2, '0')}:00Z`, 2, 0, 1024);
      await sample(accountId, short, `${Y}-03-10T11:${String(minute).padStart(2, '0')}:00Z`, 1, 0, 2048, 1);
    }

    const month = await pricing.estimate(accountId, `${Y}-03`);

    const cost = month?.functions.get(short);
    expect(cost?.duration.toString()).toBe(d('100').times(d(FIRST_PRICE_BOOK.prices.gbSecond[0].price)).toString());
    expect(cost?.idle.toString()).toBe(d('2300').times(d('0.001')).toString());
    expect([month?.monthlyFee.toString(), month?.total.toString()]).toEqual(['2.5', d('2.3').plus(d('2.5')).toString()]);
  });

  it('lists the books valid in a month: the one at its start, and those that start in it', async () => {
    const books = await pricing.booksFor(new Date(`${Y}-01-01T00:00:00Z`), new Date(`${Y}-02-01T00:00:00Z`));

    expect(books.map((book) => book.validFrom.toISOString())).toEqual([(await lastSystemBook()).validFrom.toISOString(), `${Y}-01-16T00:00:00.000Z`]);
  });
});
