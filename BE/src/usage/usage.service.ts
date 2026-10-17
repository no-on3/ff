import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { PLATFORM_LIMITS } from '../plans/plan-limits';
import { UsageRecord, UsageStatus } from './usage-record.entity';
import { usageRecord } from './usage';
import { FunctionUsageView, MonthlyUsageView, UsageAmountsView } from './usage.dto';

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

/** The tables partitioned by month, written once and never changed: usage records (P-20) and capacity samples (P-21). */
const MONTHLY_TABLES = ['usage_records', 'capacity_samples'];

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
   */
  async reapLost(now?: Date): Promise<number> {
    const coldStartSeconds = this.config.get<number>('kubernetes.readyTimeoutSeconds', 90);
    const lost = await this.dataSource.query<
      Array<{ id: string; created_at: Date; function_id: string; account_id: string; name: string; runtime: string; memory: number; timeout: number }>
    >(
      `SELECT i."id", i."created_at", f."id" AS "function_id", f."account_id", f."name", f."runtime", f."memory", f."timeout"
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
        const fn = { id: row.function_id, accountId: row.account_id, name: row.name, runtime: row.runtime, memory: row.memory, timeout: row.timeout };
        await this.record(
          usageRecord(fn, { requestId: row.id, startedAt: row.created_at, endedAt: ended, status: UsageStatus.LOST, durationMs: 0 }),
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
  async monthly(accountId: string, month: string): Promise<MonthlyUsageView> {
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
    const functions: FunctionUsageView[] = rows
      .filter((row) => !row.total)
      .map((row) => ({ functionId: row.function_id as string, functionName: row.function_name as string, deleted: row.deleted, ...amounts(row) }));
    const total = rows.find((row) => row.total);
    return { month, functions, totals: amounts(total as UsageRow) };
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
