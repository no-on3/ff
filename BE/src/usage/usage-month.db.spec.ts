/**
 * L2: an account's usage in a month (client-readiness plan, P-22) against a
 * real PostgreSQL server, in a scratch database that is dropped after: the
 * totals are the raw records' own sums, exactly, the month is the UTC
 * calendar's, and only the account's records count; its databases, buckets
 * and caches from their hourly samples, its buckets' and queues' requests from
 * their counts.
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
      for (const table of ['usage_records', 'database_samples', 'bucket_samples', 'storage_request_counts', 'cache_samples']) await query(`SELECT ff_ensure_month_partition($1, $2)`, [table, month]);
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

  it("measures each of the account's buckets in the month: GB-months from its hourly samples, what it held last, its requests by S3's class, deletes free, and the bytes of every request", async () => {
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
    const requests = (accountId: string, bucketId: string, name: string, minute: string, kind: string, count: number, bytesIn = 0, bytesOut = 0) =>
      query(
        `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6, 0, 0, 0, 0, $7, $8)`,
        [bucketId, minute, kind, accountId, name, count, bytesIn, bytesOut],
      );
    const [{ id: photos }] = await query<Array<{ id: string }>>(
      `INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'photos', 'ff-00000000000000000000000a') RETURNING id`,
      [A],
    );
    const deleted = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a';
    const asked = '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b'; // deleted too, asked something and never measured
    const emptied = '7a8b9c0d-1e2f-4a3b-8c4d-6e7f8a9b0c1d'; // deleted too, its month only deletes: free, their bytes counted
    // October has 744 hours: 372 GB for an hour is half a GB-month.
    await sample(A, photos, 'photos', '2026-10-01T00:00:00Z', 372n * GIB, 10);
    await sample(A, photos, 'photos', '2026-10-31T23:00:00Z', 744n * GIB, 12);
    await sample(A, deleted, 'logs', '2026-10-02T00:00:00Z', 30n * GIB, 3);
    await sample(A, photos, 'photos', '2026-11-01T00:00:00Z', 744n * GIB, 12); // November's
    await sample(B, '6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c', 'b-bucket', '2026-10-05T00:00:00Z', GIB, 1); // account B's
    // 5 GiB sent out, more than a 32-bit count holds, as the front door counts bytes each minute.
    await requests(A, photos, 'photos', '2026-10-01T00:05:00Z', 'tier1', 2_000, 700_000_000, 1_500);
    await requests(A, photos, 'photos', '2026-10-31T23:59:00Z', 'tier2', 30_000, 0, Number(5n * GIB));
    await requests(A, photos, 'photos', '2026-10-10T08:00:00Z', 'free', 40, 8_400, 0);
    await requests(A, photos, 'photos', '2026-11-01T00:00:00Z', 'tier2', 1_000, 0, 9_999); // November's
    await requests(B, '6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c', 'b-bucket', '2026-10-05T00:01:00Z', 'tier2', 9, 0, 9_999); // account B's
    await requests(A, asked, 'temp', '2026-10-20T12:00:00Z', 'tier2', 5, 0, 120);
    await requests(A, deleted, 'logs', '2026-10-21T12:00:00Z', 'free', 3);
    await requests(A, emptied, 'scratch', '2026-10-22T09:00:00Z', 'free', 2, 1_200, 400);

    expect(await usage.monthlyBuckets(A, '2026-10')).toEqual([
      {
        bucketId: photos,
        name: 'photos',
        deleted: false,
        hours: 2,
        gbMonths: '1.5',
        sizeBytes: Number(744n * GIB),
        objects: 12,
        tier1Requests: 2_000,
        tier2Requests: 30_000,
        bytesDownloaded: Number(5n * GIB) + 1_500,
        bytesUploaded: 700_008_400,
      },
      // 30 GB-hours over 744: 0.04032258…
      {
        bucketId: deleted,
        name: 'logs',
        deleted: true,
        hours: 1,
        gbMonths: '0.040323',
        sizeBytes: Number(30n * GIB),
        objects: 3,
        tier1Requests: 0,
        tier2Requests: 0,
        bytesDownloaded: 0,
        bytesUploaded: 0,
      },
      {
        bucketId: emptied,
        name: 'scratch',
        deleted: true,
        hours: 0,
        gbMonths: '0',
        sizeBytes: 0,
        objects: 0,
        tier1Requests: 0,
        tier2Requests: 0,
        bytesDownloaded: 400,
        bytesUploaded: 1_200,
      },
      {
        bucketId: asked,
        name: 'temp',
        deleted: true,
        hours: 0,
        gbMonths: '0',
        sizeBytes: 0,
        objects: 0,
        tier1Requests: 0,
        tier2Requests: 5,
        bytesDownloaded: 120,
        bytesUploaded: 0,
      },
    ]);
    expect(await usage.monthlyBuckets(A, '2026-12')).toEqual([]);
  });

  it("counts each of the account's queues in the month: its requests as SQS bills them, the messages sent and received, the most requests first, a deleted one's by its name then", async () => {
    const counted = (accountId: string, queueId: string, name: string, minute: string, requests: number, sent: number, received: number, deleted = 0) =>
      query(
        `INSERT INTO queue_request_counts (queue_id, minute, writer, account_id, name, requests, sent, received, deleted, empty_receives, sent_bytes, sent_max_bytes)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, 0, 0, 0)`,
        [queueId, minute, accountId, name, requests, sent, received, deleted],
      );
    const [{ id: orders }] = await query<Array<{ id: string }>>(`INSERT INTO queues (account_id, name, kind) VALUES ($1, 'orders', 'customer') RETURNING id`, [A]);
    const old = '8b9c0d1e-2f3a-4b4c-9d5e-7f8a9b0c1d2e'; // deleted since
    const drained = '9c0d1e2f-3a4b-4c5d-8e6f-8a9b0c1d2e3f'; // deleted too: only FF's deletes after a function's batch, not billed
    await counted(A, orders, 'orders', '2026-10-01T00:05:00Z', 1_000, 400, 380, 380);
    await counted(A, orders, 'orders', '2026-10-31T23:59:00Z', 2_500, 0, 1_000);
    await counted(A, orders, 'orders', '2026-11-01T00:00:00Z', 9_999, 9, 9); // November's
    await counted(A, old, 'old', '2026-10-15T12:00:00Z', 3_000, 1_500, 0);
    await counted(A, drained, 'drained', '2026-10-16T12:00:00Z', 0, 0, 0, 5);
    await counted(B, '0d1e2f3a-4b5c-4d6e-9f7a-9b0c1d2e3f4a', 'b-queue', '2026-10-05T00:01:00Z', 50, 50, 50); // account B's

    expect(await usage.monthlyQueues(A, '2026-10')).toEqual([
      { queueId: orders, name: 'orders', deleted: false, requests: 3_500, messagesSent: 400, messagesReceived: 1_380 },
      { queueId: old, name: 'old', deleted: true, requests: 3_000, messagesSent: 1_500, messagesReceived: 0 },
      { queueId: drained, name: 'drained', deleted: true, requests: 0, messagesSent: 0, messagesReceived: 0 },
    ]);
    expect(await usage.monthlyQueues(A, '2026-12')).toEqual([]);
  });

  it("measures each of the account's caches in the month: its hours, its memory at its latest sample, its GB-hours as ElastiCache bills a node, the most first, a deleted one's by its name then", async () => {
    const sampled = (accountId: string, cacheId: string, name: string, hour: string, memoryMb: number) =>
      query(
        `INSERT INTO cache_samples (cache_id, hour, account_id, name, memory_mb, bytes_used, connections, hits, misses, evictions, process_started_at)
         VALUES ($1, $2, $3, $4, $5, 1000, 1, 0, 0, 0, $2)`,
        [cacheId, hour, accountId, name, memoryMb],
      );
    const [{ id: sessions }] = await query<Array<{ id: string }>>(
      `INSERT INTO caches (account_id, name, server_name, port, memory_mb, status, password_sha256) VALUES ($1, 'sessions', 'fc-000000000000000000000001', 6400, 128, 'active', repeat('0', 64)) RETURNING id`,
      [A],
    );
    const old = '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b'; // deleted since
    // sessions: 64 MB the month's first two hours, 128 MB its last, its plan's memory raised; November's hour isn't October's.
    await sampled(A, sessions, 'sessions', '2026-10-01T00:00:00Z', 64);
    await sampled(A, sessions, 'sessions', '2026-10-01T01:00:00Z', 64);
    await sampled(A, sessions, 'sessions', '2026-10-31T23:00:00Z', 128);
    await sampled(A, sessions, 'sessions', '2026-11-01T00:00:00Z', 128);
    await sampled(A, old, 'rates', '2026-10-15T12:00:00Z', 64);
    await sampled(B, '2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c', 'b-cache', '2026-10-05T00:00:00Z', 64); // account B's

    expect(await usage.monthlyCaches(A, '2026-10')).toEqual([
      // 64 + 64 + 128 MB for an hour each: 0.25 GB-hours, over October's 744 hours 0.000336 GB-months.
      { cacheId: sessions, name: 'sessions', deleted: false, hours: 3, memoryMb: 128, gbHours: '0.25', gbMonths: '0.000336' },
      { cacheId: old, name: 'rates', deleted: true, hours: 1, memoryMb: 64, gbHours: '0.0625', gbMonths: '0.000084' },
    ]);
    expect(await usage.monthlyCaches(A, '2026-12')).toEqual([]);
  });

  it("counts only the account's own records, and each month by the UTC calendar", async () => {
    const b = await usage.monthly(B, '2026-10');
    const september = await usage.monthly(A, '2026-09');
    const november = await usage.monthly(A, '2026-11');

    expect(b.functions.map((fn) => [fn.functionName, fn.billedMs])).toEqual([['b-fn', 50]]);
    expect([september.totals.billedMs, november.totals.billedMs]).toEqual([1_000, 1_000]);
  });
});
