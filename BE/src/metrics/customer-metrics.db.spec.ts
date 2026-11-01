/**
 * L2: the metrics against a real PostgreSQL server, in a scratch database
 * dropped after, each figure worked out by hand from the rows written here:
 * the counts, the duration's statistics (percentiles interpolated), the
 * throttles of both kinds, the cold starts and the instances, a function's
 * and its account's, its asynchronous calls', quiet periods and the window's
 * edges; a customer's database's, from its hourly samples; a bucket's; a
 * queue's, sampled each minute from its messages, with its requests' counts;
 * and a cache's, from its hourly samples, its counts from one to the next.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { monthPartitions } from '../usage/usage.service';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { CustomerQueues } from '../queues/customer-queues';
import { QueueSamples } from '../queues/queue-samples.service';
import { Queue } from '../queues/queue.entity';
import { CustomerMetricsService } from './customer-metrics.service';
import { MetricsWindow } from './customer-metrics';
import { RefusedInvocationsService } from './refused-invocations.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '600000000001';
const B = '600000000002';
/** Three periods of five minutes. */
const WINDOW: MetricsWindow = { start: new Date('2026-10-01T10:00:00Z'), end: new Date('2026-10-01T10:15:00Z'), period: 300 };

run('metrics (L2)', () => {
  let db: ScratchDatabase;
  let metrics: CustomerMetricsService;
  let f1: Function;
  let f2: Function;
  let g: Function;
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const fn = (accountId: string, name: string) =>
    db.dataSource.getRepository(Function).save({ name, accountId, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5, status: FunctionStatus.ACTIVE });
  /** A usage record of the function, started at the time. */
  async function record(f: Function, at: string, status: string, durationMs: number, initMs: number | null = null): Promise<void> {
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, init_ms, status)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, 'nodejs', 128, $5, ceil($5::numeric)::int, $6, $7)`,
      [at, f.accountId, f.id, f.name, durationMs, initMs, status],
    );
    n++;
  }
  const sample = (f: Function, minute: string, instances: number) =>
    query(`INSERT INTO capacity_samples (function_id, minute, account_id, instances, min_instances, memory_mb) VALUES ($1, $2, $3, $4, 0, 128)`, [f.id, minute, f.accountId, instances]);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await monthPartitions(db.dataSource, ['2026-10']);
    for (const [id, name] of [[A, 'A'], [B, 'B']]) await db.dataSource.getRepository(Account).save({ id, name, planId: 'beta', status: AccountStatus.ACTIVE });
    metrics = new CustomerMetricsService(db.dataSource);
    f1 = await fn(A, 'f1');
    f2 = await fn(A, 'f2');
    g = await fn(B, 'g');

    // The first period, 10:00 to 10:05: five calls that ran (10 to 50 ms), the 30 ms one after a cold start,
    // a failure on FF's side and a lost call (not measured), and two calls no instance could take.
    await record(f1, '2026-10-01T10:00:00Z', 'success', 10, 812);
    await record(f1, '2026-10-01T10:01:00Z', 'success', 20);
    await record(f1, '2026-10-01T10:02:00Z', 'success', 30, 640);
    await record(f1, '2026-10-01T10:03:00Z', 'error', 40);
    await record(f1, '2026-10-01T10:04:59.999Z', 'timeout', 50);
    await record(f1, '2026-10-01T10:02:30Z', 'platform_error', 0);
    await record(f1, '2026-10-01T10:03:30Z', 'lost', 0);
    await record(f1, '2026-10-01T10:01:30Z', 'throttled', 0);
    await record(f1, '2026-10-01T10:01:31Z', 'throttled', 0);
    // Five more the account's rate limit refused, in two minutes.
    await query(`INSERT INTO rate_limited_invocations (function_id, minute, account_id, count) VALUES ($1, '2026-10-01T10:03:00Z', $2, 3), ($1, '2026-10-01T10:04:00Z', $2, 2)`, [f1.id, A]);
    // The second period is quiet. The third: one call of 7.5 ms, and a refused one alone in its minute.
    await record(f1, '2026-10-01T10:10:00Z', 'success', 7.5);
    await query(`INSERT INTO rate_limited_invocations (function_id, minute, account_id, count) VALUES ($1, '2026-10-01T10:14:00Z', $2, 1)`, [f1.id, A]);
    // Outside the window, on both sides.
    await record(f1, '2026-10-01T09:59:59.999Z', 'success', 1000);
    await record(f1, '2026-10-01T10:15:00Z', 'success', 1000);
    // Another function of the account, and another account's.
    await record(f2, '2026-10-01T10:02:00Z', 'success', 100);
    await record(g, '2026-10-01T10:02:00Z', 'error', 999);
    await query(`INSERT INTO rate_limited_invocations (function_id, minute, account_id, count) VALUES ($1, '2026-10-01T10:03:00Z', $2, 50)`, [g.id, B]);
    // Ready instances: f1 2 then 3, f2 1 at the second minute; g 9.
    await sample(f1, '2026-10-01T10:00:00Z', 2);
    await sample(f1, '2026-10-01T10:01:00Z', 3);
    await sample(f2, '2026-10-01T10:01:00Z', 1);
    await sample(g, '2026-10-01T10:01:00Z', 9);
    await sample(f1, '2026-10-01T10:12:00Z', 1);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("gives a function's figures per period, each worked out by hand", async () => {
    const view = await metrics.forFunction(A, f1.id, WINDOW);

    expect(view.timestamps).toEqual([new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:05:00Z'), new Date('2026-10-01T10:10:00Z')]);
    expect(view.metrics).toEqual({
      // Every call that reached it, failed or not; not the throttled.
      Invocations: [7, 0, 1],
      // Its error, its timeout, FF's failure and the lost call.
      Errors: [4, 0, 0],
      // Two no instance took, three and two the rate limit refused; then one refused alone.
      Throttles: [7, 0, 1],
      ColdStarts: [2, 0, 0],
      Duration: {
        // 10, 20, 30, 40, 50: the mean 30, the median 30; p95 at 3.8 of 4 steps, 48; p99 at 3.96, 49.6.
        Average: [30, null, 7.5],
        Maximum: [50, null, 7.5],
        p50: [30, null, 7.5],
        p95: [48, null, 7.5],
        p99: [49.6, null, 7.5],
      },
      // 2 then 3 ready: at most 3, and 5 instance-minutes over 5 minutes, 1 on average; 1 for a minute later.
      Instances: { Maximum: [3, 0, 1], Average: [1, 0, 0.2] },
      // No call without waiting yet.
      AsyncEventsReceived: [0, 0, 0],
      AsyncEventAge: { Average: [null, null, null], Maximum: [null, null, null] },
      AsyncEventsDropped: [0, 0, 0],
      DestinationDeliveryFailures: [0, 0, 0],
    });
  });

  it("gives a function's asynchronous calls as Lambda counts them, each backend's counts added up: received, their age at each attempt, dropped, not delivered", async () => {
    const counted = (f: Function, minute: string, received: number, attempts: number, ageMsSum: number, ageMsMax: number, dropped: number, failures: number) =>
      query(
        `INSERT INTO async_event_counts (function_id, minute, writer, account_id, received, dropped, destination_failures, attempts, age_ms_sum, age_ms_max)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, $9)`,
        [f.id, minute, f.accountId, received, dropped, failures, attempts, ageMsSum, ageMsMax],
      );
    await counted(f1, '2026-10-01T10:00:00Z', 3, 2, 400, 300, 0, 0);
    await counted(f1, '2026-10-01T10:01:00Z', 1, 1, 200, 200, 0, 0); // another backend's, the same period
    await counted(f1, '2026-10-01T10:11:00Z', 0, 1, 61_000, 61_000, 1, 1);
    await counted(g, '2026-10-01T10:00:00Z', 9, 9, 9, 9, 9, 9); // another account's

    const view = await metrics.forFunction(A, f1.id, WINDOW);

    expect([view.metrics.AsyncEventsReceived, view.metrics.AsyncEventAge, view.metrics.AsyncEventsDropped, view.metrics.DestinationDeliveryFailures]).toEqual([
      [4, 0, 0],
      // Three attempts, 600 ms together: 200 on average, the oldest 300; then one of 61 s.
      { Average: [200, null, 61_000], Maximum: [300, null, 61_000] },
      [0, 0, 1],
      [0, 0, 1],
    ]);
    expect((await metrics.forAccount(A, WINDOW)).metrics.AsyncEventsReceived).toEqual([4, 0, 0]);
  });

  it("gives the account's, all its functions together, a deleted one included, no other account's", async () => {
    await db.dataSource.getRepository(Function).delete({ id: f2.id });

    const view = await metrics.forAccount(A, WINDOW);

    expect(view.metrics.Invocations).toEqual([8, 0, 1]);
    expect(view.metrics.Errors).toEqual([4, 0, 0]);
    expect(view.metrics.Throttles).toEqual([7, 0, 1]);
    // 10, 20, 30, 40, 50 and f2's 100: the mean 41.667, the median 35 (2.5 of 5 steps); p95 at 4.75, 87.5; p99 at 4.95, 97.5.
    expect(view.metrics.Duration).toEqual({ Average: [41.667, null, 7.5], Maximum: [100, null, 7.5], p50: [35, null, 7.5], p95: [87.5, null, 7.5], p99: [97.5, null, 7.5] });
    // Each minute's instances added up first: 2, then 3 + 1: at most 4, 6 instance-minutes over 5 minutes.
    expect(view.metrics.Instances).toEqual({ Maximum: [4, 0, 1], Average: [1.2, 0, 0.2] });
  });

  it("gives a database's sessions and bytes a point an hour, from its samples, none where it wasn't sampled, and no other account's", async () => {
    const [{ id: orders }] = await query<Array<{ id: string }>>(
      `INSERT INTO databases (account_id, name, db_name, status) VALUES ($1, 'orders', 'ff_00000000000000000000000b', 'active') RETURNING id`,
      [A],
    );
    const [{ id: theirs }] = await query<Array<{ id: string }>>(
      `INSERT INTO databases (account_id, name, db_name, status) VALUES ($1, 'orders', 'ff_00000000000000000000000c', 'active') RETURNING id`,
      [B],
    );
    const sampleOf = (databaseId: string, accountId: string, hour: string, sizeBytes: number, connections: number) =>
      query(`INSERT INTO database_samples (database_id, hour, account_id, name, size_bytes, connections) VALUES ($1, $2, $3, 'orders', $4, $5)`, [
        databaseId,
        hour,
        accountId,
        sizeBytes,
        connections,
      ]);
    await sampleOf(orders, A, '2026-10-01T08:00:00Z', 7_634_423, 2);
    await sampleOf(orders, A, '2026-10-01T10:00:00Z', 8_000_000, 5);
    await sampleOf(theirs, B, '2026-10-01T09:00:00Z', 1, 1);
    const hours: MetricsWindow = { start: new Date('2026-10-01T08:00:00Z'), end: new Date('2026-10-01T11:00:00Z'), period: 3600 };

    const view = await metrics.forDatabase(A, orders, hours);

    expect(view.metrics).toEqual({
      DatabaseConnections: { Maximum: [2, null, 5], Average: [2, null, 5] },
      VolumeBytesUsed: { Maximum: [7_634_423, null, 8_000_000], Average: [7_634_423, null, 8_000_000] },
    });
    await expect(metrics.forDatabase(A, theirs, hours)).rejects.toThrow(new NotFoundException(`Database ${theirs} not found`));
  });

  it("gives a bucket's storage, its hour's measure in each period, and its requests summed per period, by its name, and no other account's", async () => {
    const [{ id: photos }] = await query<Array<{ id: string }>>(`INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'm-photos', 'ff-00000000000000000000000d') RETURNING id`, [A]);
    const [{ id: theirs }] = await query<Array<{ id: string }>>(`INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'm-theirs', 'ff-00000000000000000000000e') RETURNING id`, [B]);
    await query(`INSERT INTO bucket_samples (bucket_id, hour, account_id, name, size_bytes, objects) VALUES ($1, '2026-10-01T08:00:00Z', $2, 'm-photos', 161480253, 1204)`, [photos, A]);
    const counted = (bucketId: string, accountId: string, minute: string, kind: string, requests: number, gets: number, puts: number, errors4xx: number, bytesOut: number) =>
      query(
        `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, 'm', $5, $6, $7, $8, 0, $9, $10)`,
        [bucketId, minute, kind, accountId, requests, gets, puts, errors4xx, puts * 1000, bytesOut],
      );
    await counted(photos, A, '2026-10-01T08:58:00Z', 'tier1', 3, 0, 3, 0, 0);
    await counted(photos, A, '2026-10-01T09:01:00Z', 'tier2', 9, 9, 0, 2, 9000);
    await counted(photos, A, '2026-10-01T09:01:00Z', 'tier1', 1, 0, 1, 0, 0); // another class, the same minute, written apart
    await counted(theirs, B, '2026-10-01T09:01:00Z', 'tier2', 50, 50, 0, 0, 1);
    const periods: MetricsWindow = { start: new Date('2026-10-01T08:55:00Z'), end: new Date('2026-10-01T09:05:00Z'), period: 300 };

    const view = await metrics.forBucket(A, 'm-photos', periods);

    expect(view.metrics).toEqual({
      BucketSizeBytes: { Average: [161_480_253, null] }, // 08:55 is in the hour measured at 08:00; 09:00's hour wasn't measured
      NumberOfObjects: { Average: [1_204, null] },
      AllRequests: { Sum: [3, 10] },
      GetRequests: { Sum: [0, 9] },
      PutRequests: { Sum: [3, 1] },
      '4xxErrors': { Sum: [0, 2] },
      '5xxErrors': { Sum: [0, 0] },
      BytesDownloaded: { Sum: [0, 9_000] },
      BytesUploaded: { Sum: [3_000, 1_000] },
    });
    await expect(metrics.forBucket(A, 'm-theirs', periods)).rejects.toThrow(new NotFoundException('The account has no bucket m-theirs'));
    await expect(metrics.forBucket(A, 'm-nobody', periods)).rejects.toThrow(NotFoundException);
  });

  it("gives a site's visits, the website server's counts alone, and the shares of them that failed, by its bucket's name, and no other account's", async () => {
    const [{ id: shop }] = await query<Array<{ id: string }>>(`INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'm-shop', 'ff-00000000000000000000000f') RETURNING id`, [A]);
    const [{ id: theirs }] = await query<Array<{ id: string }>>(`INSERT INTO buckets (account_id, name, store_name) VALUES ($1, 'm-their-shop', 'ff-000000000000000000000010') RETURNING id`, [B]);
    const counted = (bucketId: string, accountId: string, minute: string, kind: string, requests: number, errors4xx: number, errors5xx: number, bytesOut: number) =>
      query(
        `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, 'm', $5, $5, 0, $6, $7, 0, $8)`,
        [bucketId, minute, kind, accountId, requests, errors4xx, errors5xx, bytesOut],
      );
    await counted(shop, A, '2026-10-01T09:00:00Z', 'website', 6, 1, 0, 60_000);
    await counted(shop, A, '2026-10-01T09:03:00Z', 'website', 2, 0, 1, 1_000); // another minute of the period, written apart
    await counted(shop, A, '2026-10-01T09:01:00Z', 'tier2', 40, 40, 0, 1); // its S3 API's, never the site's
    await counted(theirs, B, '2026-10-01T09:01:00Z', 'website', 50, 0, 0, 1);
    const periods: MetricsWindow = { start: new Date('2026-10-01T09:00:00Z'), end: new Date('2026-10-01T09:10:00Z'), period: 300 };

    const view = await metrics.forSite(A, 'm-shop', periods);

    expect(view.metrics).toEqual({
      Requests: { Sum: [8, 0] },
      BytesDownloaded: { Sum: [61_000, 0] },
      '4xxErrorRate': { Average: [12.5, null] },
      '5xxErrorRate': { Average: [12.5, null] },
      TotalErrorRate: { Average: [25, null] },
    });
    await expect(metrics.forSite(A, 'm-their-shop', periods)).rejects.toThrow(new NotFoundException('The account has no bucket m-their-shop'));
  });

  it("samples each queue holding a message each minute, as SQS's approximate counts, and gives its metrics by its name, with its requests' counts, no other account's", async () => {
    const queues = new CustomerQueues(db.dataSource, db.dataSource.getRepository(Queue));
    const made = async (accountId: string, name: string) => (await queues.create(accountId, name, {}, { limit: 10, name: 'Beta' }, 'tn-tunis-1')).queue;
    const [orders, , theirs] = [await made(A, 'm-orders'), await made(A, 'm-empty'), await made(B, 'm-theirs')];
    const message = (body: string, delaySeconds = 0) => ({ messageId: randomUUID(), body, meta: {}, sizeBytes: Buffer.byteLength(body), delaySeconds });
    const now = new Date();
    // Sent 90 s ago: two waiting, one received now and in flight, one delayed ten minutes.
    await queues.send(orders, [message('one'), message('two'), message('three'), message('later', 600)], new Date(now.getTime() - 90_000));
    await queues.receive(orders, 1, 30, now);
    await queues.send(theirs, [message('theirs')], now);
    const sampler = new QueueSamples(db.dataSource);

    expect(await sampler.sample(now)).toBe(2); // the empty queue has no row
    expect(await sampler.sample(now)).toBe(0); // the same minute again keeps its first rows

    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await query(
      `INSERT INTO queue_request_counts (queue_id, minute, writer, account_id, name, requests, sent, received, deleted, empty_receives, sent_bytes, sent_max_bytes)
       VALUES ($1, $2, gen_random_uuid(), $3, 'm-orders', 6, 4, 1, 0, 2, 16, 5)`,
      [orders.id, minute, A],
    );
    const window: MetricsWindow = { start: minute, end: new Date(minute.getTime() + 60_000), period: 60 };

    expect((await metrics.forQueue(A, 'm-orders', window)).metrics).toEqual({
      ApproximateNumberOfMessagesVisible: { Maximum: [2], Average: [2] },
      ApproximateNumberOfMessagesNotVisible: { Maximum: [1], Average: [1] },
      ApproximateNumberOfMessagesDelayed: { Maximum: [1], Average: [1] },
      ApproximateAgeOfOldestMessage: { Maximum: [90] },
      NumberOfMessagesSent: { Sum: [4] },
      NumberOfMessagesReceived: { Sum: [1] },
      NumberOfMessagesDeleted: { Sum: [0] },
      NumberOfEmptyReceives: { Sum: [2] },
      SentMessageSize: { Average: [4], Maximum: [5] },
    });
    const quiet = (await metrics.forQueue(A, 'm-empty', window)).metrics;
    expect([quiet.ApproximateNumberOfMessagesVisible, quiet.SentMessageSize]).toEqual([{ Maximum: [0], Average: [0] }, { Average: [null], Maximum: [null] }]);
    await expect(metrics.forQueue(A, 'm-theirs', window)).rejects.toThrow(new NotFoundException('The account has no queue m-theirs'));
  });

  it("gives a cache's memory and connections from each hour's sample, and the hour's hits, misses and evictions from the next hour's, by its name, and no other account's", async () => {
    const cacheOf = async (accountId: string, name: string, port: number) =>
      (
        await query<Array<{ id: string }>>(
          `INSERT INTO caches (account_id, name, server_name, port, memory_mb, status, password_sha256) VALUES ($1, $2, $3, $4, 64, 'active', repeat('0', 64)) RETURNING id`,
          [accountId, name, `ffc-${port}`, port],
        )
      )[0].id;
    const sessions = await cacheOf(A, 'm-sessions', 6401);
    const theirs = await cacheOf(B, 'm-theirs', 6402);
    const sampleOf = (cacheId: string, accountId: string, hour: string, bytesUsed: number, connections: number, hits: number, misses: number, evictions: number, startedAt: string) =>
      query(
        `INSERT INTO cache_samples (cache_id, hour, account_id, name, memory_mb, bytes_used, connections, hits, misses, evictions, process_started_at)
         VALUES ($1, $2, $3, 'm-sessions', 64, $4, $5, $6, $7, $8, $9)`,
        [cacheId, hour, accountId, bytesUsed, connections, hits, misses, evictions, startedAt],
      );
    await sampleOf(sessions, A, '2026-10-01T08:00:00Z', 1_000_000, 2, 100, 10, 0, '2026-10-01T07:30:00Z');
    // The same process, its start read 2 s apart from its uptime.
    await sampleOf(sessions, A, '2026-10-01T09:00:00Z', 3_000_000, 4, 400, 30, 5, '2026-10-01T07:30:02Z');
    // Started again at 09:40: its counts from zero.
    await sampleOf(sessions, A, '2026-10-01T10:00:00Z', 500_000, 1, 20, 2, 0, '2026-10-01T09:40:00Z');
    await sampleOf(sessions, A, '2026-10-01T11:00:00Z', 600_000, 1, 50, 4, 0, '2026-10-01T09:40:01Z');
    await sampleOf(theirs, B, '2026-10-01T09:00:00Z', 1, 1, 1, 1, 1, '2026-10-01T07:00:00Z');
    const hours = (start: string, end: string): MetricsWindow => ({ start: new Date(start), end: new Date(end), period: 3600 });

    expect((await metrics.forCache(A, 'm-sessions', hours('2026-10-01T08:00:00Z', '2026-10-01T11:00:00Z'))).metrics).toEqual({
      BytesUsedForCache: { Maximum: [1_000_000, 3_000_000, 500_000], Average: [1_000_000, 3_000_000, 500_000] },
      CurrConnections: { Maximum: [2, 4, 1], Average: [2, 4, 1] },
      // 08:00 to 09:00, from one process; 09:00, the new process's own; 10:00, the 11:00 sample less the 10:00 one.
      CacheHits: { Sum: [300, 20, 30] },
      CacheMisses: { Sum: [20, 2, 2] },
      Evictions: { Sum: [5, 0, 0] },
    });
    // The hour 11:00 has no next sample yet, and 12:00 none of its own.
    const later = (await metrics.forCache(A, 'm-sessions', hours('2026-10-01T10:00:00Z', '2026-10-01T13:00:00Z'))).metrics;
    expect([later.BytesUsedForCache.Maximum, later.CacheHits.Sum, later.Evictions.Sum]).toEqual([
      [500_000, 600_000, null],
      [30, null, null],
      [0, null, null],
    ]);
    await expect(metrics.forCache(A, 'm-theirs', hours('2026-10-01T08:00:00Z', '2026-10-01T11:00:00Z'))).rejects.toThrow(new NotFoundException('The account has no cache m-theirs'));
  });

  it("gives the account's mail an hour at a time from its messages, each recipient one, and its reputation over the 14 days before each hour's end, no other account's", async () => {
    const messageOf = (accountId: string, createdAt: string, recipients: Array<{ status: string; permanent?: boolean }>) =>
      query(
        `INSERT INTO email_messages (id, account_id, identity, from_address, return_path, recipients, recipient_count, size_bytes, status, created_at)
         VALUES (gen_random_uuid(), $1, 'shop.example.tn', 'orders@shop.example.tn', 'b-0@bounces.mail.ff.test', $2, $3, 1000, 'SENT', $4)`,
        [accountId, JSON.stringify(recipients.map((recipient, index) => ({ address: `r${index}@example.tn`, ...recipient }))), recipients.length, createdAt],
      );
    const sent = (n: number) => Array.from({ length: n }, () => ({ status: 'SENT' }));
    // 08:10: two taken, one bounced for good, one kept off by the suppression list. 09:30: one complained of, one still queued.
    await messageOf(A, '2026-10-01T08:10:00Z', [...sent(2), { status: 'BOUNCED', permanent: true }, { status: 'SUPPRESSED' }]);
    await messageOf(A, '2026-10-01T09:30:00Z', [{ status: 'COMPLAINED' }, { status: 'QUEUED' }]);
    // Six days before, six taken; 21 days before, ten bounced, too long ago to count.
    await messageOf(A, '2026-09-25T12:00:00Z', sent(6));
    await messageOf(A, '2026-09-10T12:00:00Z', Array.from({ length: 10 }, () => ({ status: 'BOUNCED', permanent: true })));
    await messageOf(B, '2026-10-01T08:20:00Z', Array.from({ length: 3 }, () => ({ status: 'BOUNCED', permanent: true })));

    const view = await metrics.emailMetrics(A, { start: new Date('2026-10-01T08:00:00Z'), end: new Date('2026-10-01T10:00:00Z'), period: 3600 });

    expect(view.metrics).toEqual({
      Send: { Sum: [4, 2] },
      Delivery: { Sum: [2, 1] },
      Bounce: { Sum: [2, 0] },
      Complaint: { Sum: [0, 1] },
      // By 09:00, 9 recipients reached in 14 days, 1 bounced for good; by 10:00, 10, and 1 complaint.
      'Reputation.BounceRate': { Average: [0.111111, 0.1] },
      'Reputation.ComplaintRate': { Average: [0, 0.1] },
    });
    expect(view.timestamps).toEqual([new Date('2026-10-01T08:00:00Z'), new Date('2026-10-01T09:00:00Z')]);
  });

  it("answers another account's function, and one that doesn't exist, with 404", async () => {
    await expect(metrics.forFunction(B, f1.id, WINDOW)).rejects.toThrow(new NotFoundException(`Function with ID ${f1.id} not found`));
    await expect(metrics.forFunction(A, g.id, WINDOW)).rejects.toThrow(NotFoundException);
    // Deleted: its records still count in the account's totals, but it has no page.
    await expect(metrics.forFunction(A, f2.id, WINDOW)).rejects.toThrow(NotFoundException);
  });

  it('gives periods of a minute and an hour, from the same rows', async () => {
    const minutes = await metrics.forFunction(A, f1.id, { start: new Date('2026-10-01T10:00:00Z'), end: new Date('2026-10-01T10:05:00Z'), period: 60 });
    expect(minutes.metrics.Invocations).toEqual([1, 1, 2, 2, 1]);
    expect(minutes.metrics.Throttles).toEqual([0, 2, 0, 3, 2]);
    expect(minutes.metrics.Instances.Average).toEqual([2, 3, 0, 0, 0]);
    // The third period by the minute: the call at 10:10, the instance at 10:12, and the refused call alone at 10:14.
    const later = await metrics.forFunction(A, f1.id, { start: new Date('2026-10-01T10:10:00Z'), end: new Date('2026-10-01T10:15:00Z'), period: 60 });
    expect([later.metrics.Invocations, later.metrics.Throttles, later.metrics.Duration.p50, later.metrics.Instances.Maximum]).toEqual([
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1],
      [7.5, null, null, null, null],
      [0, 0, 1, 0, 0],
    ]);

    const hour = await metrics.forFunction(A, f1.id, { start: new Date('2026-10-01T10:00:00Z'), end: new Date('2026-10-01T11:00:00Z'), period: 3600 });
    // The record at 10:15 is in this hour, and so is the minute at 10:12.
    expect([hour.metrics.Invocations, hour.metrics.Throttles, hour.metrics.Duration.Maximum, hour.metrics.Instances.Maximum]).toEqual([[9], [8], [1000], [3]]);
  });

  it("writes the rate limit's refusals for the account's own functions, adding to what a minute has", async () => {
    const refused = new RefusedInvocationsService(db.dataSource);
    const at = new Date('2026-10-01T10:14:20Z');
    refused.count(A, f1.id, at);
    refused.count(A, f1.id, at);
    refused.count(B, f1.id, at); // not account B's function: dropped
    refused.count(A, '00000000-0000-4000-8000-000000000000', at); // no such function: dropped

    await refused.flush();

    expect(await query(`SELECT function_id, account_id, count FROM rate_limited_invocations WHERE minute = '2026-10-01T10:14:00Z' ORDER BY function_id`)).toEqual([
      { function_id: f1.id, account_id: A, count: 3 },
    ]);
    expect((await metrics.forFunction(A, f1.id, WINDOW)).metrics.Throttles).toEqual([7, 0, 3]);
    expect(n).toBeGreaterThan(0);
  });
});
