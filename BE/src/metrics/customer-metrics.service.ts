import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  BucketMetricsView,
  DatabaseMetricsView,
  InstancesRow,
  MetricsView,
  MetricsWindow,
  PeriodRow,
  bucketMetricsView,
  databaseMetricsView,
  metricsView,
} from './customer-metrics';

/** A call that ran: measured by the runtime, and so in the duration's statistics. */
const RAN = "('success', 'error', 'timeout')";
/** A call that failed: by the function's fault, the platform's, or lost when the backend stopped. */
const FAILED = "('error', 'timeout', 'platform_error', 'lost')";

interface Scope {
  /** The SQL that picks the scope's rows of a table aliased `t`, with its parameters from $4. */
  where: string;
  parameters: unknown[];
}

/**
 * The metrics of a function, or of a whole account, from its usage records,
 * its rate-limited invocations and its capacity samples; of a customer's
 * database, from its hourly samples; and of a customer's bucket, from its
 * hourly samples and the front door's request counts (customer-metrics.ts).
 */
@Injectable()
export class CustomerMetricsService {
  constructor(private readonly dataSource: DataSource) {}

  /** A function's, for its own account only: another account's function is not found. */
  async forFunction(accountId: string, functionId: string, window: MetricsWindow): Promise<MetricsView> {
    const found = await this.dataSource.query<unknown[]>('SELECT 1 FROM "functions" WHERE "id" = $1 AND "account_id" = $2', [functionId, accountId]);
    if (found.length === 0) throw new NotFoundException(`Function with ID ${functionId} not found`);
    return this.metrics(window, { where: 't."account_id" = $4 AND t."function_id" = $5', parameters: [accountId, functionId] });
  }

  /** The account's, all its functions together, those deleted since included. */
  forAccount(accountId: string, window: MetricsWindow): Promise<MetricsView> {
    return this.metrics(window, { where: 't."account_id" = $4', parameters: [accountId] });
  }

  /** A database's, for its own account only: another account's database, or one deleted, is not found. */
  async forDatabase(accountId: string, databaseId: string, window: MetricsWindow): Promise<DatabaseMetricsView> {
    const found = await this.dataSource.query<unknown[]>('SELECT 1 FROM "databases" WHERE "id" = $1 AND "account_id" = $2', [databaseId, accountId]);
    if (found.length === 0) throw new NotFoundException(`Database ${databaseId} not found`);
    const rows = await this.dataSource.query<Array<{ bucket: string; connections_max: number; connections_avg: string; bytes_max: string; bytes_avg: string }>>(
      `SELECT floor(extract(epoch FROM t."hour") / $3)::bigint * $3 AS "bucket",
              max(t."connections") AS "connections_max", avg(t."connections") AS "connections_avg",
              max(t."size_bytes") AS "bytes_max", avg(t."size_bytes") AS "bytes_avg"
         FROM "database_samples" t
        WHERE t."hour" >= $1 AND t."hour" < $2 AND t."account_id" = $4 AND t."database_id" = $5
        GROUP BY 1`,
      [window.start, window.end, window.period, accountId, databaseId],
    );
    return databaseMetricsView(
      window,
      rows.map((row) => ({
        bucket: Number(row.bucket),
        connectionsMaximum: Number(row.connections_max),
        connectionsAverage: Number(row.connections_avg),
        bytesMaximum: Number(row.bytes_max),
        bytesAverage: Number(row.bytes_avg),
      })),
    );
  }

  /** A bucket's, by its name, for its own account only: another account's bucket, or one deleted, is not found. */
  async forBucket(accountId: string, name: string, window: MetricsWindow): Promise<BucketMetricsView> {
    const [found] = await this.dataSource.query<Array<{ id: string }>>('SELECT "id" FROM "buckets" WHERE "name" = $1 AND "account_id" = $2', [name, accountId]);
    if (!found) throw new NotFoundException(`The account has no bucket ${name}`);
    return this.bucketMetrics(accountId, found.id, window);
  }

  /** A bucket's, by its ID, as an alarm names it: none found answers no datapoint. */
  async bucketMetrics(accountId: string, bucketId: string, window: MetricsWindow): Promise<BucketMetricsView> {
    // Every hour a period of the window falls in: a period's storage is its hour's measure.
    const firstHour = new Date(Math.floor(window.start.getTime() / 3_600_000) * 3_600_000);
    const [hours, periods] = await Promise.all([
      this.dataSource.query<Array<{ hour: string; size_bytes: string; objects: string }>>(
        `SELECT extract(epoch FROM "hour")::bigint AS "hour", "size_bytes"::text, "objects"::text FROM "bucket_samples"
          WHERE "hour" >= $1 AND "hour" < $2 AND "account_id" = $3 AND "bucket_id" = $4`,
        [firstHour, window.end, accountId, bucketId],
      ),
      this.dataSource.query<Array<Record<string, string>>>(
        `SELECT floor(extract(epoch FROM "minute") / $3)::bigint * $3 AS "bucket", sum("requests")::text AS "AllRequests", sum("gets")::text AS "GetRequests",
                sum("puts")::text AS "PutRequests", sum("errors4xx")::text AS "4xxErrors", sum("errors5xx")::text AS "5xxErrors",
                sum("bytes_out")::text AS "BytesDownloaded", sum("bytes_in")::text AS "BytesUploaded"
           FROM "storage_request_counts"
          WHERE "minute" >= $1 AND "minute" < $2 AND "account_id" = $4 AND "bucket_id" = $5
          GROUP BY 1`,
        [window.start, window.end, window.period, accountId, bucketId],
      ),
    ]);
    return bucketMetricsView(
      window,
      hours.map((row) => ({ hour: Number(row.hour), sizeBytes: Number(row.size_bytes), objects: Number(row.objects) })),
      periods.map((row) => ({
        bucket: Number(row.bucket),
        AllRequests: Number(row.AllRequests),
        GetRequests: Number(row.GetRequests),
        PutRequests: Number(row.PutRequests),
        '4xxErrors': Number(row['4xxErrors']),
        '5xxErrors': Number(row['5xxErrors']),
        BytesDownloaded: Number(row.BytesDownloaded),
        BytesUploaded: Number(row.BytesUploaded),
      })),
    );
  }

  private async metrics(window: MetricsWindow, scope: Scope): Promise<MetricsView> {
    const [rows, refused, instances] = await Promise.all([this.calls(window, scope), this.refused(window, scope), this.instances(window, scope)]);
    const throttled = new Map(refused.map((row) => [row.bucket, row.count]));
    const seen = new Set(rows.map((row) => row.bucket));
    const merged = rows.map((row) => ({ ...row, throttles: row.throttles + (throttled.get(row.bucket) ?? 0) }));
    for (const [bucket, count] of throttled) if (!seen.has(bucket)) merged.push(emptyRow(bucket, count));
    return metricsView(window, merged, instances);
  }

  private async calls(window: MetricsWindow, scope: Scope): Promise<PeriodRow[]> {
    const rows = await this.dataSource.query<
      Array<{ bucket: string; invocations: string; errors: string; throttles: string; cold_starts: string; average: string | null; maximum: string | null; percentiles: number[] | null }>
    >(
      `SELECT floor(extract(epoch FROM t."started_at") / $3)::bigint * $3 AS "bucket",
              count(*) FILTER (WHERE t."status" <> 'throttled') AS "invocations",
              count(*) FILTER (WHERE t."status" IN ${FAILED}) AS "errors",
              count(*) FILTER (WHERE t."status" = 'throttled') AS "throttles",
              count(*) FILTER (WHERE t."init_ms" IS NOT NULL) AS "cold_starts",
              avg(t."duration_ms") FILTER (WHERE t."status" IN ${RAN}) AS "average",
              max(t."duration_ms") FILTER (WHERE t."status" IN ${RAN}) AS "maximum",
              percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY t."duration_ms") FILTER (WHERE t."status" IN ${RAN}) AS "percentiles"
         FROM "usage_records" t
        WHERE t."started_at" >= $1 AND t."started_at" < $2 AND ${scope.where}
        GROUP BY 1`,
      [window.start, window.end, window.period, ...scope.parameters],
    );
    return rows.map((row) => ({
      bucket: Number(row.bucket),
      invocations: Number(row.invocations),
      errors: Number(row.errors),
      throttles: Number(row.throttles),
      coldStarts: Number(row.cold_starts),
      durationAverage: row.average === null ? null : Number(row.average),
      durationMaximum: row.maximum === null ? null : Number(row.maximum),
      durationP50: row.percentiles?.[0] ?? null,
      durationP95: row.percentiles?.[1] ?? null,
      durationP99: row.percentiles?.[2] ?? null,
    }));
  }

  /** Calls the account's rate limit refused: no usage record has them. */
  private async refused(window: MetricsWindow, scope: Scope): Promise<Array<{ bucket: number; count: number }>> {
    const rows = await this.dataSource.query<Array<{ bucket: string; count: string }>>(
      `SELECT floor(extract(epoch FROM t."minute") / $3)::bigint * $3 AS "bucket", sum(t."count") AS "count"
         FROM "rate_limited_invocations" t
        WHERE t."minute" >= $1 AND t."minute" < $2 AND ${scope.where}
        GROUP BY 1`,
      [window.start, window.end, window.period, ...scope.parameters],
    );
    return rows.map((row) => ({ bucket: Number(row.bucket), count: Number(row.count) }));
  }

  /** Each minute's ready instances, the scope's functions added up, then per period: its most, and its sum over its minutes. */
  private async instances(window: MetricsWindow, scope: Scope): Promise<InstancesRow[]> {
    const rows = await this.dataSource.query<Array<{ bucket: string; maximum: string; minute_sum: string }>>(
      `SELECT floor(extract(epoch FROM m."minute") / $3)::bigint * $3 AS "bucket", max(m."instances") AS "maximum", sum(m."instances") AS "minute_sum"
         FROM (SELECT t."minute", sum(t."instances") AS "instances"
                 FROM "capacity_samples" t
                WHERE t."minute" >= $1 AND t."minute" < $2 AND ${scope.where}
                GROUP BY t."minute") m
        GROUP BY 1`,
      [window.start, window.end, window.period, ...scope.parameters],
    );
    return rows.map((row) => ({ bucket: Number(row.bucket), maximum: Number(row.maximum), minuteSum: Number(row.minute_sum) }));
  }
}

const emptyRow = (bucket: number, throttles: number): PeriodRow => ({
  bucket,
  invocations: 0,
  errors: 0,
  throttles,
  coldStarts: 0,
  durationAverage: null,
  durationMaximum: null,
  durationP50: null,
  durationP95: null,
  durationP99: null,
});
