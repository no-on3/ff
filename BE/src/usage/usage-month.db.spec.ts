/**
 * L2: an account's usage in a month (client-readiness plan, P-22) against a
 * real PostgreSQL server, in a scratch database that is dropped after: the
 * totals are the raw records' own sums, exactly, the month is the UTC
 * calendar's, and only the account's records count; its databases from their
 * hourly samples.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, Runtime } from '../functions/entities/function.entity';
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '500000000001';
const B = '500000000002';
/** 13 decimals: GB-s is whole MB-ms over 1,024,000 = 2^13 × 5^3. */
const SCALE = 10n ** 13n;
/** An exact decimal as a whole number of 10^-13. */
const scaled = (decimal: string) => {
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(13, '0'));
};

run("an account's usage in a month (L2, P-22)", () => {
  let db: ScratchDatabase;
  let usage: UsageService;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const record = (accountId: string, functionId: string, name: string, startedAt: string, memoryMb: number, billedMs: number, status = 'success') =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb,
         duration_ms, billed_ms, status) VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, 'nodejs', $5, $6::numeric, $6::int, $7)`,
      [startedAt, accountId, functionId, name, memoryMb, billedMs, status],
    );
  let kept: Function;
  const gone = 'a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b'; // a function deleted since: only its records are left

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [A, B]) {
      await db.dataSource.getRepository(Account).save({ id, name: `Account ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    }
    for (const month of ['2026-09-01', '2026-10-01', '2026-11-01']) {
      for (const table of ['usage_records', 'database_samples', 'bucket_samples', 'storage_request_counts']) await query(`SELECT ff_ensure_month_partition($1, $2)`, [table, month]);
    }
    kept = await db.dataSource.getRepository(Function).save({ name: 'new', accountId: A, runtime: Runtime.NODEJS, code: 'x', memory: 256, timeout: 5 });
    const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
    usage = new UsageService(db.dataSource.getRepository(UsageRecord), db.dataSource, config);

    // Account A in October: the kept function, renamed and given more memory during the month, every outcome of D7.
    await record(A, kept.id, 'old', '2026-10-01T00:00:00Z', 128, 1); // the month's first instant
    await record(A, kept.id, 'old', '2026-10-02T10:00:00Z', 128, 2);
    await record(A, kept.id, 'old', '2026-10-03T10:00:00Z', 128, 13, 'error');
    await record(A, kept.id, 'new', '2026-10-31T23:59:59.999Z', 256, 3_000, 'timeout'); // the month's last instant
    await record(A, kept.id, 'new', '2026-10-05T10:00:00Z', 256, 0, 'throttled');
    await record(A, kept.id, 'new', '2026-10-06T10:00:00Z', 256, 0, 'platform_error');
    await record(A, kept.id, 'new', '2026-10-07T10:00:00Z', 256, 0, 'lost');
    // The deleted function, at a memory whose GB-s needs all 13 decimals.
    await record(A, gone, 'gone', '2026-10-08T10:00:00Z', 129, 7);
    // Not A's October: September's last instant, November's first, and account B.
    await record(A, kept.id, 'new', '2026-09-30T23:59:59.999Z', 256, 1_000);
    await record(A, kept.id, 'new', '2026-11-01T00:00:00Z', 256, 1_000);
    await record(B, '5e2b9c7a-1d4f-4a6e-8b3c-9f0e1d2c3b4a', 'b-fn', '2026-10-10T10:00:00Z', 128, 50);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("gives each function's month, the most GB-seconds first, with its latest name, and whether it was deleted", async () => {
    const view = await usage.monthly(A, '2026-10');

    expect(view.functions).toEqual([
      {
        functionId: kept.id,
        functionName: 'new',
        deleted: false,
        requests: 4, // successes, the error and the timeout
        billedMs: 3_016,
        gbSeconds: '0.752', // (1 + 2 + 13) ms × 128 MB + 3,000 ms × 256 MB = 770,048 MB-ms
        throttled: 1,
        platformErrors: 1,
        lost: 1,
      },
      {
        functionId: gone,
        functionName: 'gone',
        deleted: true,
        requests: 1,
        billedMs: 7,
        gbSeconds: '0.0008818359375', // 7 ms × 129 MB = 903 MB-ms
        throttled: 0,
        platformErrors: 0,
        lost: 0,
      },
    ]);
  });

  it("totals the account's records themselves, exactly: the same as adding up its functions, and as the raw records", async () => {
    const view = await usage.monthly(A, '2026-10');
    const [raw] = await query<Array<{ mb_ms: string; billed_ms: string }>>(
      `SELECT sum(billed_ms::numeric * memory_mb)::text AS mb_ms, sum(billed_ms)::text AS billed_ms FROM usage_records
        WHERE account_id = $1 AND started_at >= '2026-10-01T00:00:00Z' AND started_at < '2026-11-01T00:00:00Z'`,
      [A],
    );

    expect(view.totals).toEqual({ requests: 5, billedMs: 3_023, gbSeconds: '0.7528818359375', throttled: 1, platformErrors: 1, lost: 1 });
    // Exact arithmetic, in whole 10^-13 GB-s: no float rounding anywhere.
    expect(scaled(view.totals.gbSeconds) * 1_024_000n).toBe(BigInt(raw.mb_ms) * SCALE);
    expect(view.functions.reduce((sum, fn) => sum + scaled(fn.gbSeconds), 0n)).toBe(scaled(view.totals.gbSeconds));
    expect(view.totals.billedMs).toBe(Number(raw.billed_ms));
  });

  it('answers a month without calls with no function and zero totals', async () => {
    expect(await usage.monthly(A, '2026-12')).toEqual({
      month: '2026-12',
      functions: [],
      totals: { requests: 0, billedMs: 0, gbSeconds: '0', throttled: 0, platformErrors: 0, lost: 0 },
    });
  });

  it("measures each of the account's databases in the month by its hourly samples: GB-months, the latest size and name, a deleted one's too, the most first", async () => {
    const GIB = 1_073_741_824n;
    const sample = (accountId: string, databaseId: string, name: string, hour: string, sizeBytes: bigint) =>
      query(`INSERT INTO database_samples (database_id, hour, account_id, name, size_bytes, connections) VALUES ($1, $2, $3, $4, $5, 0)`, [
        databaseId,
        hour,
        accountId,
        name,
        sizeBytes.toString(),
      ]);
    const [{ id: orders }] = await query<Array<{ id: string }>>(
      `INSERT INTO databases (account_id, name, db_name, status) VALUES ($1, 'orders', 'ff_00000000000000000000000a', 'active') RETURNING id`,
      [A],
    );
    const deleted = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    // October has 744 hours: 372 GB for an hour is half a GB-month.
    await sample(A, orders, 'orders', '2026-10-01T00:00:00Z', 372n * GIB);
    await sample(A, orders, 'orders', '2026-10-31T23:00:00Z', 744n * GIB);
    await sample(A, deleted, 'old-name', '2026-10-02T00:00:00Z', 10n * GIB);
    await sample(A, deleted, 'audit', '2026-10-03T00:00:00Z', 20n * GIB);
    await sample(A, orders, 'orders', '2026-11-01T00:00:00Z', 744n * GIB); // November's
    await sample(B, '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f', 'b-db', '2026-10-05T00:00:00Z', GIB); // account B's

    expect(await usage.monthlyDatabases(A, '2026-10')).toEqual([
      { databaseId: orders, name: 'orders', deleted: false, hours: 2, gbMonths: '1.5', sizeBytes: Number(744n * GIB) },
      // 30 GB-hours over 744: 0.04032258…
      { databaseId: deleted, name: 'audit', deleted: true, hours: 2, gbMonths: '0.040323', sizeBytes: Number(20n * GIB) },
    ]);
    expect(await usage.monthlyDatabases(A, '2026-12')).toEqual([]);
  });

  it("measures each of the account's buckets in the month: GB-months from its hourly samples, what it held last, and its requests by S3's class, deletes free", async () => {
    const GIB = 1_073_741_824n;
    const sample = (accountId: string, bucketId: string, name: string, hour: string, sizeBytes: bigint, objects: number) =>
      query(`INSERT INTO bucket_samples (bucket_id, hour, account_id, name, size_bytes, objects) VALUES ($1, $2, $3, $4, $5, $6)`, [
        bucketId,
        hour,
        accountId,
        name,
        sizeBytes.toString(),
        objects,
      ]);
    const requests = (accountId: string, bucketId: string, name: string, minute: string, kind: string, count: number) =>
      query(
        `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6, 0, 0, 0, 0, 0, 0)`,
        [bucketId, minute, kind, accountId, name, count],
      );
    const [{ id: photos }] = await query<Array<{ id: string }>>(
      `INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'photos', 'ff-00000000000000000000000a') RETURNING id`,
      [A],
    );
    const deleted = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a';
    const asked = '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b'; // deleted too, asked something and never measured
    // October has 744 hours: 372 GB for an hour is half a GB-month.
    await sample(A, photos, 'photos', '2026-10-01T00:00:00Z', 372n * GIB, 10);
    await sample(A, photos, 'photos', '2026-10-31T23:00:00Z', 744n * GIB, 12);
    await sample(A, deleted, 'logs', '2026-10-02T00:00:00Z', 30n * GIB, 3);
    await sample(A, photos, 'photos', '2026-11-01T00:00:00Z', 744n * GIB, 12); // November's
    await sample(B, '6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c', 'b-bucket', '2026-10-05T00:00:00Z', GIB, 1); // account B's
    await requests(A, photos, 'photos', '2026-10-01T00:05:00Z', 'tier1', 2_000);
    await requests(A, photos, 'photos', '2026-10-31T23:59:00Z', 'tier2', 30_000);
    await requests(A, photos, 'photos', '2026-10-10T08:00:00Z', 'free', 40);
    await requests(A, photos, 'photos', '2026-11-01T00:00:00Z', 'tier2', 1_000); // November's
    await requests(A, asked, 'temp', '2026-10-20T12:00:00Z', 'tier2', 5);
    await requests(A, deleted, 'logs', '2026-10-21T12:00:00Z', 'free', 3);

    expect(await usage.monthlyBuckets(A, '2026-10')).toEqual([
      { bucketId: photos, name: 'photos', deleted: false, hours: 2, gbMonths: '1.5', sizeBytes: Number(744n * GIB), objects: 12, tier1Requests: 2_000, tier2Requests: 30_000 },
      // 30 GB-hours over 744: 0.04032258…
      { bucketId: deleted, name: 'logs', deleted: true, hours: 1, gbMonths: '0.040323', sizeBytes: Number(30n * GIB), objects: 3, tier1Requests: 0, tier2Requests: 0 },
      { bucketId: asked, name: 'temp', deleted: true, hours: 0, gbMonths: '0', sizeBytes: 0, objects: 0, tier1Requests: 0, tier2Requests: 5 },
    ]);
    expect(await usage.monthlyBuckets(A, '2026-12')).toEqual([]);
  });

  it("counts only the account's own records, and each month by the UTC calendar", async () => {
    const b = await usage.monthly(B, '2026-10');
    const september = await usage.monthly(A, '2026-09');
    const november = await usage.monthly(A, '2026-11');

    expect(b.functions.map((fn) => [fn.functionName, fn.billedMs])).toEqual([['b-fn', 50]]);
    expect([september.totals.billedMs, november.totals.billedMs]).toEqual([1_000, 1_000]);
  });
});
