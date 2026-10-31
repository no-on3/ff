/**
 * L2: the estimate at AWS's prices against a real PostgreSQL server, in a
 * scratch database that is dropped after: three months of an account's usage,
 * as FF counts it, priced with the AWS prices of the migrations' newest book,
 * each line and total worked by hand, in US$ and in TND at the book's rate,
 * beside FF's own prices for the same months.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { PricingService } from '../billing/pricing.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { AwsEstimateService } from './aws-estimate.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
/** Next year: its months have no usage but this test's, whenever it runs. */
const Y = new Date().getUTCFullYear() + 1;
const NOW = new Date(`${Y}-03-10T00:00:00Z`);
const GIB = 1_073_741_824;

run("the estimate at AWS's prices (L2)", () => {
  let db: ScratchDatabase;
  let estimates: AwsEstimateService;
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  async function account(): Promise<string> {
    const id = String(300000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    return id;
  }
  /** `count` calls from `at` on, a minute apart, of `billedMs` at `memoryMb`, the first `cold` of them cold starts of `initMs`. */
  const calls = (accountId: string, at: string, count: number, fields: { billedMs: number; memoryMb: number; cold?: number; initMs?: number }) =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, min_instances, duration_ms, billed_ms, init_ms, status)
       SELECT gen_random_uuid(), $1::timestamptz + make_interval(mins => i), $1::timestamptz + make_interval(mins => i), $2, '00000000-0000-4000-8000-000000000001', 'backend', 'nodejs',
              $4, 0, $5::numeric, $5, CASE WHEN i < $6 THEN $7::int END, 'success'
         FROM generate_series(0, $3 - 1) AS i`,
      [at, accountId, count, fields.memoryMb, fields.billedMs, fields.cold ?? 0, fields.initMs ?? null],
    );
  /** A database or a cache sampled each hour of [from, from + hours). */
  const hourly = (sql: string, from: string, hours: number, parameters: unknown[]) =>
    query(`INSERT INTO ${sql} FROM generate_series(0, $2 - 1) AS i`, [from, hours, ...parameters]);
  const requests = (accountId: string, minute: string, kind: 'tier2' | 'website', count: number, bytesOut: number) =>
    query(
      `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
       VALUES ('00000000-0000-4000-8000-0000000000b1', $1, $2, gen_random_uuid(), $3, 'receipts', $4, $4, 0, 0, 0, 0, $5)`,
      [minute, kind, accountId, count, bytesOut],
    );

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const table of ['usage_records', 'database_samples', 'cache_samples', 'storage_request_counts', 'queue_request_counts', 'email_sends']) {
      for (const month of ['01', '02', '03']) await query('SELECT ff_ensure_month_partition($1, $2::date)', [table, `${Y}-${month}-01`]);
    }
    const ds = db.dataSource;
    const pricing = new PricingService(ds.getRepository(PriceBook), ds.getRepository(Currency));
    const plans = new PlansService(ds.getRepository(Plan), ds.getRepository(Account), {} as Orchestrator, new AuditService(ds.getRepository(AuditEntry)));
    estimates = new AwsEstimateService(ds.getRepository(PriceBook), ds.getRepository(Currency), pricing, plans);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("prices three months as FF counted them, each line in US$, the totals in US$ and TND, beside FF's own prices", async () => {
    const id = await account();
    // January: 50 calls of 900 s at 10,240 MB, 5 of them cold starts of 10 s; a database of 1 GB all month; 120 GB out of a
    // bucket and a site's 2 million requests and 50 GB; 500,000 queue requests.
    await calls(id, `${Y}-01-05T00:00:00Z`, 50, { billedMs: 900_000, memoryMb: 10_240, cold: 5, initMs: 10_000 });
    await hourly(
      `database_samples (database_id, hour, account_id, name, size_bytes, connections)
       SELECT '00000000-0000-4000-8000-0000000000d1', $1::timestamptz + make_interval(hours => i), $3, 'orders', $4, 1`,
      `${Y}-01-01T00:00:00Z`,
      744,
      [id, GIB],
    );
    await requests(id, `${Y}-01-07T10:00:00Z`, 'tier2', 10_000, 120 * GIB);
    await requests(id, `${Y}-01-07T10:01:00Z`, 'website', 2_000_000, 50 * GIB);
    await query(
      `INSERT INTO queue_request_counts (queue_id, minute, writer, account_id, name, requests, sent, received, deleted, empty_receives, sent_bytes, sent_max_bytes)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'orders', 500000, 500000, 0, 0, 0, 0, 0)`,
      [`${Y}-01-09T00:00:00Z`, id],
    );
    // February: a cache of 512 MB for 100 hours, and mail to 3,000 recipients. March, so far: nothing.
    await hourly(
      `cache_samples (cache_id, hour, account_id, name, memory_mb, bytes_used, connections, hits, misses, evictions, process_started_at)
       SELECT '00000000-0000-4000-8000-0000000000c1', $1::timestamptz + make_interval(hours => i), $3, 'sessions', 512, 0, 0, 0, 0, 0, $1::timestamptz`,
      `${Y}-02-02T00:00:00Z`,
      100,
      [id],
    );
    await query(`INSERT INTO email_sends (message_id, sent_at, account_id, identity, recipients, attachment_bytes) VALUES (gen_random_uuid(), $1, $2, 'shop.example.tn', 3000, 0)`, [
      `${Y}-02-14T09:00:00Z`,
      id,
    ]);

    const view = await estimates.estimate(id, 3, [], NOW);

    const [newest] = await db.dataSource.getRepository(PriceBook).find({ order: { validFrom: 'DESC' }, take: 1 });
    expect({ ...view, months: [] }).toEqual({
      currency: 'TND',
      usdRate: '3.0080',
      usdRateDate: '2026-10-14',
      region: 'us-east-1',
      pricesReadOn: ['2026-10-17', '2026-10-31'],
      priceBook: newest.id,
      months: [],
    });
    expect(view.months.map((month) => [month.month, month.until, month.requests, Object.fromEntries(month.lines.map((line) => [line.line, line.usd])), month.totalUsd, month.total, month.ffTotal])).toEqual([
      [
        `${Y}-01`,
        null,
        50,
        {
          functions: '0.83', // 450,000 GB-s, 50,000 past the free 400,000, × $0.0000166667
          databaseStorage: '0.12', // 1 GB-month × $0.115
          buckets: '0.00', // 10,000 GETs × $0.0004 per 1,000: the site's requests are CloudFront's
          queues: '0.00', // within the free million
          mail: '0.00',
          coldStarts: '0.01', // 500 GB-s × $0.0000166667
          databaseInstances: '14.09', // 744 hours × $0.016, and 19 GB-months short of RDS's 20 GB × $0.115
          cacheNodes: '0.00',
          dataOut: '1.80', // 20 GB past the free 100 × $0.09
          logs: '0.00', // 50 KB
          cloudFront: '0.00', // 50 GB, 2 million requests and functions, within its free tier
          natGateway: '37.20', // 744 hours with a database × ($0.045 + $0.005)
        },
        '54.05',
        '162.581', // $54.0496928 × 3.0080
        '4.901', // FF: 50,000 GB-s × 0.0000501334336, and 1,990,000 GETs past the free 20,000 × 0.0012032 per 1,000
      ],
      [
        `${Y}-02`,
        null,
        0,
        {
          functions: '0.00',
          databaseStorage: '0.00',
          buckets: '0.00',
          queues: '0.00',
          mail: '0.30', // 3,000 recipients × $0.10 per 1,000
          coldStarts: '0.00',
          databaseInstances: '0.00',
          cacheNodes: '1.28', // 100 hours × $0.0128
          dataOut: '0.00',
          logs: '0.00',
          cloudFront: '0.00',
          natGateway: '5.00', // 100 hours with a cache × $0.05
        },
        '6.58',
        '19.793',
        '4.753', // FF: 50 GB-hours of cache × 0.0770048, 3,000 recipients × 0.3008 per 1,000
      ],
      [`${Y}-03`, NOW, 0, expect.any(Object), '0.00', '0.000', '0.000'],
    ]);
  });

  it("leaves out of the totals the lines of what AWS bills that FF doesn't asked for, still listed, and estimates as many months as asked", async () => {
    const id = await account();
    await hourly(
      `cache_samples (cache_id, hour, account_id, name, memory_mb, bytes_used, connections, hits, misses, evictions, process_started_at)
       SELECT '00000000-0000-4000-8000-0000000000c2', $1::timestamptz + make_interval(hours => i), $3, 'sessions', 512, 0, 0, 0, 0, 0, $1::timestamptz`,
      `${Y}-03-01T00:00:00Z`,
      100,
      [id],
    );

    const view = await estimates.estimate(id, 1, ['natGateway'], NOW);

    expect(view.months.map((month) => month.month)).toEqual([`${Y}-03`]);
    const [march] = view.months;
    expect(march.lines.filter((line) => line.leftOut).map((line) => [line.line, line.usd, line.extra])).toEqual([['natGateway', '5.00', true]]);
    expect([march.totalUsd, march.total]).toEqual(['1.28', '3.850']); // the node alone: $1.28 × 3.0080
    expect(march.lines.filter((line) => !line.extra).map((line) => line.assumption)).toEqual([null, null, null, null, null]);
  });

  it("counts nothing of another account's usage", async () => {
    const view = await estimates.estimate(await account(), 3, [], NOW);

    expect(view.months.map((month) => [month.requests, month.totalUsd])).toEqual([
      [0, '0.00'],
      [0, '0.00'],
      [0, '0.00'],
    ]);
  });
});
