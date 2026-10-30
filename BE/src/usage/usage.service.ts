import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { PLATFORM_LIMITS } from '../plans/plan-limits';
import { UsageRecord, UsageStatus } from './usage-record.entity';
import { usageRecord } from './usage';
import { BucketMonth, CacheMonth, DatabaseMonth, QueueMonth, UsageAmountsView, UsageMonth } from './usage.dto';
import { Decimal } from '../billing/decimal';
import { BYTES_PER_GB, gbMonths, hoursIn } from '../billing/rating';
import { coldStartSeconds, invocationSeconds, invocations } from '../monitoring/operator-metrics';

/** The outcomes of a call that ran, measured by the runtime. */
const RAN: readonly UsageStatus[] = [UsageStatus.SUCCESS, UsageStatus.ERROR, UsageStatus.TIMEOUT];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** What the history says of a lost call. */
export const LOST_MESSAGE = "Lost: the backend restarted during the call, so its answer is unknown. It isn't billed.";
/** How many months of partitions exist ahead of the current one. */
const MONTHS_AHEAD = 2;
/** The month as YYYY-MM by the UTC calendar. */
export const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

interface UsageRow {
  total: boolean;
  function_id: string | null;
  function_name: string | null;
  deleted: boolean;
  requests: string;
  billed_ms: string;
  gb_seconds: string;
  throttled: string;
  platform_errors: string;
  lost: string;
}
const amounts = (row: UsageRow): UsageAmountsView => ({
  requests: Number(row.requests),
  billedMs: Number(row.billed_ms),
  gbSeconds: row.gb_seconds,
  throttled: Number(row.throttled),
  platformErrors: Number(row.platform_errors),
  lost: Number(row.lost),
});

/**
 * The tables partitioned by month, written once and never changed: usage records, capacity samples, customers'
 * databases', buckets', queues' and caches' samples, buckets' and queues' request counts, and functions' asynchronous calls'.
 */
const MONTHLY_TABLES = [
  'usage_records',
  'capacity_samples',
  'database_samples',
  'bucket_samples',
  'storage_request_counts',
  'queue_request_counts',
  'queue_samples',
  'async_event_counts',
  'cache_samples',
];

/**
 * Usage records (client-readiness plan, P-20, D6): written once per
 * invocation, in its final transaction; lost calls reaped; the monthly
 * partitions of the metering tables created ahead of time.
 */
@Injectable()
export class UsageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageService.name);
  private reaper?: NodeJS.Timeout;
  private partitioner?: NodeJS.Timeout;

  constructor(
    @InjectRepository(UsageRecord) private readonly records: Repository<UsageRecord>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Before the first call is taken, so none finds its month missing, even after a long stop.
    await this.ensurePartitions().catch((error: unknown) => this.logger.error(`Could not create the monthly partitions: ${describeError(error)}`));
    // Calls lost by the last stop: in the background, as it may find many.
    void this.reapLost().catch((error: unknown) => this.logger.error(`Could not reap lost invocations: ${describeError(error)}`));
    this.reaper = setInterval(
      () => void this.reapLost().catch((error: unknown) => this.logger.error(`Could not reap lost invocations: ${describeError(error)}`)),
      MINUTE_MS,
    );
    this.partitioner = setInterval(
      () => void this.ensurePartitions().catch((error: unknown) => this.logger.error(`Could not create the monthly partitions: ${describeError(error)}`)),
      DAY_MS,
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.reaper);
    clearInterval(this.partitioner);
  }

  /**
   * Writes a usage record, through the transaction that records the
   * invocation's final state. Writing one again is a no-op: the invocation's
   * ID and start are the primary key.
   */
  async record(record: UsageRecord, manager: EntityManager = this.records.manager): Promise<void> {
    await manager.createQueryBuilder().insert().into(UsageRecord).values(record).orIgnore().execute();
    // The operator's metrics: each call's outcome, how long it ran, and its cold start.
    invocations.inc({ outcome: record.status });
    if (RAN.includes(record.status)) invocationSeconds.observe(Number(record.durationMs) / 1000);
    if (record.initMs !== null && record.initMs !== undefined) coldStartSeconds.observe(record.initMs / 1000);
  }

  /**
   * Invocations still RUNNING past the longest a call can take lost their
   * answer: the backend stopped during the call. Each becomes LOST, with a
   * usage record that bills nothing (D6, D7). Returns how many.
   *
   * The longest a call can take: a wait for a free instance of up to its
   * timeout, then its timeout, after a cold start of up to
   * K8S_READY_TIMEOUT_SECONDS; then 30 s more. A function changed since the
   * call started may have had a longer timeout then, so that call gets the
   * platform's maximum. Times are the database's, as the invocations' are.
   * An asynchronous call's lost attempt is its request's: the record names
   * the request, and the event's next claim counts the attempt as failed.
   */
  async reapLost(now?: Date): Promise<number> {
    const coldStartSeconds = this.config.get<number>('kubernetes.readyTimeoutSeconds', 90);
    const lost = await this.dataSource.query<
      Array<{
        id: string;
        request_id: string;
        created_at: Date;
        function_id: string;
        account_id: string;
        name: string;
        runtime: string;
        memory: number;
        timeout: number;
        min_instances: number;
      }>
    >(
      `SELECT i."id", i."request_id", i."created_at", f."id" AS "function_id", f."account_id", f."name", f."runtime", f."memory", f."timeout", f."min_instances"
         FROM "function_invocations" i JOIN "functions" f ON f."id" = i."function_id"
        WHERE i."status" = 'RUNNING'
          AND i."created_at" < coalesce($1::timestamptz, now())
            - make_interval(secs => 2 * CASE WHEN f."updated_at" > i."created_at" THEN $3 ELSE f."timeout" END + $2 + 30)`,
      [now ?? null, coldStartSeconds, PLATFORM_LIMITS.timeoutSeconds],
    );
    let reaped = 0;
    for (const row of lost) {
      const marked = await this.dataSource.transaction(async (manager) => {
        // Only one that is still RUNNING: the call may have ended meanwhile, and then its outcome stands.
        const marking = await manager
          .createQueryBuilder()
          .update(FunctionInvocation)
          .set({ status: InvocationStatus.LOST, error: LOST_MESSAGE })
          .where('id = :id AND status = :running', { id: row.id, running: InvocationStatus.RUNNING })
          .returning(['updatedAt'])
          .execute();
        const ended = (marking.raw as Array<{ updated_at: Date }>)[0]?.updated_at;
        if (!ended) return false;
        const fn = {
          id: row.function_id,
          accountId: row.account_id,
          name: row.name,
          runtime: row.runtime,
          memory: row.memory,
          timeout: row.timeout,
          minInstances: row.min_instances,
        };
        await this.record(
          usageRecord(fn, { requestId: row.request_id, startedAt: row.created_at, endedAt: ended, status: UsageStatus.LOST, durationMs: 0 }),
          manager,
        );
        return true;
      });
      if (marked) reaped++;
    }
    if (reaped) this.logger.warn(`Marked ${reaped} invocation(s) LOST: the backend stopped during the call; they aren't billed`);
    return reaped;
  }

  /**
   * An account's usage in a month by the UTC calendar (P-22), per function and
   * in total, from one read of its records: the totals are the records' own
   * sums, never the functions' added up. GB-s is exact: a sum of whole MB-ms
   * over 1,024,000, which always has a finite decimal form.
   */
  async monthly(accountId: string, month: string): Promise<UsageMonth> {
    const [year, number] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, number - 1, 1));
    const to = new Date(Date.UTC(year, number, 1));
    const rows = await this.records.manager.query<UsageRow[]>(
      `SELECT GROUPING(u."function_id") = 1 AS "total", u."function_id",
              (array_agg(u."function_name" ORDER BY u."started_at" DESC))[1] AS "function_name",
              bool_and(f."id" IS NULL) AS "deleted",
              count(*) FILTER (WHERE u."status" IN ('success', 'error', 'timeout')) AS "requests",
              coalesce(sum(u."billed_ms"), 0) AS "billed_ms",
              coalesce(trim_scale(sum(u."billed_ms"::numeric * u."memory_mb") / 1024000), 0)::text AS "gb_seconds",
              count(*) FILTER (WHERE u."status" = 'throttled') AS "throttled",
              count(*) FILTER (WHERE u."status" = 'platform_error') AS "platform_errors",
              count(*) FILTER (WHERE u."status" = 'lost') AS "lost"
         FROM "usage_records" u
         LEFT JOIN "functions" f ON f."id" = u."function_id" AND f."account_id" = u."account_id"
        WHERE u."account_id" = $1 AND u."started_at" >= $2 AND u."started_at" < $3
        GROUP BY GROUPING SETS ((u."function_id"), ())
        ORDER BY GROUPING(u."function_id"), sum(u."billed_ms"::numeric * u."memory_mb") DESC, 3, 2`,
      [accountId, from, to],
    );
    const functions: UsageMonth['functions'] = rows
      .filter((row) => !row.total)
      .map((row) => ({ functionId: row.function_id as string, functionName: row.function_name as string, deleted: row.deleted, ...amounts(row) }));
    const total = rows.find((row) => row.total);
    return { month, functions, totals: amounts(total as UsageRow) };
  }

  /**
   * An account's databases in a month by the UTC calendar (ADR 0008), from
   * their hourly samples: each one's hours measured, GB-months, and size at
   * its latest sample, the most GB-months first.
   */
  async monthlyDatabases(accountId: string, month: string): Promise<DatabaseMonth[]> {
    const [year, number] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, number - 1, 1));
    const to = new Date(Date.UTC(year, number, 1));
    const rows = await this.records.manager.query<Array<{ id: string; name: string; deleted: boolean; hours: number; byte_hours: string; size_bytes: string }>>(
      `SELECT s."database_id" AS "id", (array_agg(s."name" ORDER BY s."hour" DESC))[1] AS "name", bool_and(d."id" IS NULL) AS "deleted",
              count(*)::int AS "hours", sum(s."size_bytes")::text AS "byte_hours", (array_agg(s."size_bytes" ORDER BY s."hour" DESC))[1]::text AS "size_bytes"
         FROM "database_samples" s
         LEFT JOIN "databases" d ON d."id" = s."database_id"
        WHERE s."account_id" = $1 AND s."hour" >= $2 AND s."hour" < $3
        GROUP BY s."database_id"
        ORDER BY sum(s."size_bytes") DESC, 2, 1`,
      [accountId, from, to],
    );
    return rows.map((row) => ({
      databaseId: row.id,
      name: row.name,
      deleted: row.deleted,
      hours: row.hours,
      gbMonths: gbMonths(BigInt(row.byte_hours), hoursIn(month)).round(6).toString(),
      sizeBytes: Number(row.size_bytes),
    }));
  }

  /**
   * An account's buckets in a month by the UTC calendar (ADR 0009): from
   * their hourly samples, each one's hours measured, GB-months, and what it
   * held at its latest sample; from the front door's counts, its requests of
   * S3's two classes, deletes free. The most GB-months first.
   */
  async monthlyBuckets(accountId: string, month: string): Promise<BucketMonth[]> {
    const [year, number] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, number - 1, 1));
    const to = new Date(Date.UTC(year, number, 1));
    const rows = await this.records.manager.query<
      Array<{
        id: string;
        name: string;
        deleted: boolean;
        hours: number;
        byte_hours: string;
        size_bytes: string;
        objects: string;
        tier1: string;
        tier2: string;
        bytes_out: string;
        bytes_in: string;
      }>
    >(
      // The bytes of every request, deletes' too; the requests of the two classes billed.
      `WITH s AS (SELECT "bucket_id", (array_agg("name" ORDER BY "hour" DESC))[1] AS "name", count(*)::int AS "hours", sum("size_bytes") AS "byte_hours",
                         (array_agg("size_bytes" ORDER BY "hour" DESC))[1] AS "size_bytes", (array_agg("objects" ORDER BY "hour" DESC))[1] AS "objects"
                    FROM "bucket_samples" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3 GROUP BY "bucket_id"),
            r AS (SELECT "bucket_id", max("name") AS "name", coalesce(sum("requests") FILTER (WHERE "class" = 'tier1'), 0) AS "tier1",
                         coalesce(sum("requests") FILTER (WHERE "class" IN ('tier2', 'website')), 0) AS "tier2", sum("bytes_out") AS "bytes_out", sum("bytes_in") AS "bytes_in"
                    FROM "storage_request_counts" WHERE "account_id" = $1 AND "minute" >= $2 AND "minute" < $3 GROUP BY "bucket_id")
       SELECT coalesce(s."bucket_id", r."bucket_id") AS "id", coalesce(s."name", r."name") AS "name", b."id" IS NULL AS "deleted",
              coalesce(s."hours", 0) AS "hours", coalesce(s."byte_hours", 0)::text AS "byte_hours", coalesce(s."size_bytes", 0)::text AS "size_bytes",
              coalesce(s."objects", 0)::text AS "objects", coalesce(r."tier1", 0)::text AS "tier1", coalesce(r."tier2", 0)::text AS "tier2",
              coalesce(r."bytes_out", 0)::text AS "bytes_out", coalesce(r."bytes_in", 0)::text AS "bytes_in"
         FROM s FULL JOIN r ON r."bucket_id" = s."bucket_id"
         LEFT JOIN "buckets" b ON b."id" = coalesce(s."bucket_id", r."bucket_id")
        ORDER BY coalesce(s."byte_hours", 0) DESC, 2, 1`,
      [accountId, from, to],
    );
    return rows.map((row) => ({
      bucketId: row.id,
      name: row.name,
      deleted: row.deleted,
      hours: row.hours,
      gbMonths: gbMonths(BigInt(row.byte_hours), hoursIn(month)).round(6).toString(),
      sizeBytes: Number(row.size_bytes),
      objects: Number(row.objects),
      tier1Requests: Number(row.tier1),
      tier2Requests: Number(row.tier2),
      bytesDownloaded: Number(row.bytes_out),
      bytesUploaded: Number(row.bytes_in),
    }));
  }

  /**
   * An account's queues in a month by the UTC calendar (ADR 0010), from their
   * request counts: each one's requests as SQS bills them, and the messages
   * sent to it and received from it. The most requests first.
   */
  async monthlyQueues(accountId: string, month: string): Promise<QueueMonth[]> {
    const [year, number] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, number - 1, 1));
    const to = new Date(Date.UTC(year, number, 1));
    const rows = await this.records.manager.query<Array<{ id: string; name: string; deleted: boolean; requests: string; sent: string; received: string }>>(
      `SELECT r."queue_id" AS "id", max(r."name") AS "name", bool_and(q."id" IS NULL) AS "deleted", sum(r."requests")::text AS "requests",
              sum(r."sent")::text AS "sent", sum(r."received")::text AS "received"
         FROM "queue_request_counts" r
         LEFT JOIN "queues" q ON q."id" = r."queue_id"
        WHERE r."account_id" = $1 AND r."minute" >= $2 AND r."minute" < $3
        GROUP BY r."queue_id"
        ORDER BY sum(r."requests") DESC, 2, 1`,
      [accountId, from, to],
    );
    return rows.map((row) => ({
      queueId: row.id,
      name: row.name,
      deleted: row.deleted,
      requests: Number(row.requests),
      messagesSent: Number(row.sent),
      messagesReceived: Number(row.received),
    }));
  }

  /**
   * An account's caches in a month by the UTC calendar (ADR 0013), from their
   * hourly samples: each one's hours measured, its memory at its latest
   * sample, and its memory times its hours, as it is billed. The most
   * GB-hours first.
   */
  async monthlyCaches(accountId: string, month: string): Promise<CacheMonth[]> {
    const [year, number] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, number - 1, 1));
    const to = new Date(Date.UTC(year, number, 1));
    const rows = await this.records.manager.query<Array<{ id: string; name: string; deleted: boolean; hours: number; byte_hours: string; memory_mb: number }>>(
      `SELECT s."cache_id" AS "id", (array_agg(s."name" ORDER BY s."hour" DESC))[1] AS "name", bool_and(c."id" IS NULL) AS "deleted",
              count(*)::int AS "hours", sum(s."memory_mb"::bigint * 1048576)::text AS "byte_hours", (array_agg(s."memory_mb" ORDER BY s."hour" DESC))[1] AS "memory_mb"
         FROM "cache_samples" s
         LEFT JOIN "caches" c ON c."id" = s."cache_id"
        WHERE s."account_id" = $1 AND s."hour" >= $2 AND s."hour" < $3
        GROUP BY s."cache_id"
        ORDER BY sum(s."memory_mb") DESC, 2, 1`,
      [accountId, from, to],
    );
    return rows.map((row) => ({
      cacheId: row.id,
      name: row.name,
      deleted: row.deleted,
      hours: row.hours,
      memoryMb: row.memory_mb,
      gbHours: Decimal.ratio(BigInt(row.byte_hours), BYTES_PER_GB).round(6).toString(),
      gbMonths: gbMonths(BigInt(row.byte_hours), hoursIn(month)).round(6).toString(),
    }));
  }

  /**
   * Each function's newest call, by its usage record's start: the records
   * outlive the invocation history, which the plan's retention clears (P-45).
   * A call still running has no record yet. One query, an index lookup each.
   */
  async lastCalls(functionIds: string[]): Promise<Map<string, Date>> {
    if (functionIds.length === 0) return new Map();
    const rows = await this.records.manager.query<Array<{ id: string; at: Date | null }>>(
      `SELECT f."id", (SELECT max(u."started_at") FROM "usage_records" u WHERE u."function_id" = f."id") AS "at"
         FROM unnest($1::uuid[]) AS f("id")`,
      [functionIds],
    );
    return new Map(rows.flatMap((row): Array<[string, Date]> => (row.at ? [[row.id, row.at]] : [])));
  }

  /** The names of the account's functions among these IDs; a function deleted since has none. */
  async functionNames(accountId: string, functionIds: string[]): Promise<Map<string, string>> {
    if (functionIds.length === 0) return new Map();
    const rows = await this.records.manager.query<Array<{ id: string; name: string }>>(
      'SELECT "id", "name" FROM "functions" WHERE "account_id" = $1 AND "id" = ANY($2::uuid[])',
      [accountId, functionIds],
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * This month's partition and the next ones, in UTC, of each metering table:
   * a record or a sample must never find its month missing. Returns their names.
   */
  async ensurePartitions(now = new Date()): Promise<string[]> {
    const partitions: string[] = [];
    for (const table of MONTHLY_TABLES) {
      for (let ahead = 0; ahead <= MONTHS_AHEAD; ahead++) {
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1)).toISOString().slice(0, 10);
        const [{ partition }] = await this.dataSource.query<Array<{ partition: string }>>(
          'SELECT "ff_ensure_month_partition"($1, $2::date) AS "partition"',
          [table, month],
        );
        partitions.push(partition);
      }
    }
    return partitions;
  }
}
