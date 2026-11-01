import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AsyncRow,
  BucketMetricsView,
  CallMetricsView,
  CacheMetricsView,
  DatabaseMetricsView,
  EmailMetricsView,
  InstancesRow,
  REPUTATION_DAYS,
  MetricsView,
  MetricsWindow,
  PeriodRow,
  QueueMetricsView,
  SiteMetricsView,
  bucketMetricsView,
  cacheMetricsView,
  callMetricsView,
  databaseMetricsView,
  emailMetricsView,
  metricsView,
  queueMetricsView,
  siteMetricsView,
} from './customer-metrics';
import { functionNotFound } from '../functions/function-not-found';
import { CallFilter, KeptCalls, callsKept } from '../functions/qualifier';
import { LATEST_SAMPLED } from '../usage/capacity-sample.entity';

/** A call that ran: measured by the runtime, and so in the duration's statistics. */
const RAN = "('success', 'error', 'timeout')";
/** A call that failed: by the function's fault, the platform's, or lost when the backend stopped. */
const FAILED = "('error', 'timeout', 'platform_error', 'lost')";

interface Scope {
  /** The SQL that picks the scope's rows of a table aliased `t`, with its parameters from $4. */
  where: string;
  parameters: unknown[];
}

/** A function's scope. */
function functionScope(accountId: string, functionId: string): Scope {
  return { where: 't."account_id" = $4 AND t."function_id" = $5', parameters: [accountId, functionId] };
}

/** A function's Deployment's capacity samples: $LATEST's, or a version's. */
function deploymentScope(accountId: string, functionId: string, version: number | null): Scope {
  const scope = functionScope(accountId, functionId);
  scope.parameters.push(version ?? LATEST_SAMPLED);
  scope.where += ` AND t."version" = $${3 + scope.parameters.length}`;
  return scope;
}

/** A function's calls whose records hold what `kept` says, in a table with their version and alias. */
function callsScope(accountId: string, functionId: string, kept: KeptCalls): Scope {
  const scope = functionScope(accountId, functionId);
  for (const [column, value] of Object.entries(kept) as Array<[keyof KeptCalls, number | string | null]>) {
    if (value === null) scope.where += ` AND t."${column}" IS NULL`;
    else {
      scope.parameters.push(value);
      scope.where += ` AND t."${column}" = $${3 + scope.parameters.length}`;
    }
  }
  return scope;
}

/**
 * The metrics of a function, or of a whole account, from its usage records,
 * its rate-limited invocations, its capacity samples and its asynchronous
 * calls' counts; of a customer's database, from its hourly samples; of a
 * customer's bucket, from its hourly samples and the front door's request
 * counts; of a customer's queue, from its minute samples and its requests'
 * counts; and of a customer's cache, from its hourly samples
 * (customer-metrics.ts).
 */
@Injectable()
export class CustomerMetricsService {
  constructor(private readonly dataSource: DataSource) {}

  /** A function's, for its own account only: another account's function is not found. */
  async forFunction(accountId: string, functionId: string, window: MetricsWindow): Promise<MetricsView> {
    await this.assertFunction(accountId, functionId);
    return this.metrics(window, functionScope(accountId, functionId));
  }

  /**
   * Some of a function's calls', by what they named and what ran them, as
   * CloudWatch's Resource and ExecutedVersion dimensions pick Lambda's: the
   * series their usage records measure, and, by what ran them alone, the
   * instances of the Deployment that did (CallMetricsView). A version or an
   * alias the function no longer has still has its calls.
   */
  async forCalls(accountId: string, functionId: string, window: MetricsWindow, filter: CallFilter): Promise<CallMetricsView> {
    await this.assertFunction(accountId, functionId);
    const kept = callsKept(filter);
    if (!kept) return callMetricsView(window, []);
    const rows = await this.calls(window, callsScope(accountId, functionId, kept));
    // By what ran them alone: what they named keeps calls of pods that run others too.
    const ranBy = filter.resource === undefined ? kept.version : undefined;
    return callMetricsView(window, rows, ranBy === undefined ? undefined : await this.instances(window, deploymentScope(accountId, functionId, ranBy)));
  }

  /** Another account's function is not found. */
  private async assertFunction(accountId: string, functionId: string): Promise<void> {
    const found = await this.dataSource.query<unknown[]>('SELECT 1 FROM "functions" WHERE "id" = $1 AND "account_id" = $2', [functionId, accountId]);
    if (found.length === 0) throw functionNotFound(functionId);
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

  /** A bucket's site's, by the bucket's name, for its own account only: a bucket no longer a site still has its past visits. */
  async forSite(accountId: string, name: string, window: MetricsWindow): Promise<SiteMetricsView> {
    const [found] = await this.dataSource.query<Array<{ id: string }>>('SELECT "id" FROM "buckets" WHERE "name" = $1 AND "account_id" = $2', [name, accountId]);
    if (!found) throw new NotFoundException(`The account has no bucket ${name}`);
    return this.siteMetrics(accountId, found.id, window);
  }

  /** A bucket's site's, by the bucket's ID, as an alarm names it: the website server's counts of its visits alone. */
  async siteMetrics(accountId: string, bucketId: string, window: MetricsWindow): Promise<SiteMetricsView> {
    const periods = await this.dataSource.query<Array<Record<string, string>>>(
      `SELECT floor(extract(epoch FROM "minute") / $3)::bigint * $3 AS "bucket", sum("requests")::text AS "requests", sum("bytes_out")::text AS "bytes_out",
              sum("errors4xx")::text AS "errors4xx", sum("errors5xx")::text AS "errors5xx"
         FROM "storage_request_counts"
        WHERE "minute" >= $1 AND "minute" < $2 AND "account_id" = $4 AND "bucket_id" = $5 AND "class" = 'website'
        GROUP BY 1`,
      [window.start, window.end, window.period, accountId, bucketId],
    );
    return siteMetricsView(
      window,
      periods.map((row) => ({
        bucket: Number(row.bucket),
        requests: Number(row.requests),
        bytesOut: Number(row.bytes_out),
        errors4xx: Number(row.errors4xx),
        errors5xx: Number(row.errors5xx),
      })),
    );
  }

  /** A queue's, by its name, for its own account only: another account's queue, or one deleted, is not found. */
  async forQueue(accountId: string, name: string, window: MetricsWindow): Promise<QueueMetricsView> {
    const [found] = await this.dataSource.query<Array<{ id: string }>>(`SELECT "id" FROM "queues" WHERE "name" = $1 AND "account_id" = $2 AND "kind" = 'customer'`, [name, accountId]);
    if (!found) throw new NotFoundException(`The account has no queue ${name}`);
    return this.queueMetrics(accountId, found.id, window);
  }

  /** A cache's, by its name, for its own account only: another account's cache, or one deleted, is not found. */
  async forCache(accountId: string, name: string, window: MetricsWindow): Promise<CacheMetricsView> {
    const [found] = await this.dataSource.query<Array<{ id: string }>>(`SELECT "id" FROM "caches" WHERE "name" = $1 AND "account_id" = $2 AND "status" <> 'deleting'`, [
      name,
      accountId,
    ]);
    if (!found) throw new NotFoundException(`The account has no cache ${name}`);
    return this.cacheMetrics(accountId, found.id, window);
  }

  /**
   * A cache's, by its ID, as an alarm names it: each hour's sample, and the
   * hits, misses and evictions in the hour, which the next hour's sample says
   * (the window's last hour's too): the difference between the two when they
   * come from the same process, all of the next one's when its process
   * started between them. None without the next hour's sample: the hour now,
   * or one the samples skipped. None found answers hours without a sample.
   */
  async cacheMetrics(accountId: string, cacheId: string, window: MetricsWindow): Promise<CacheMetricsView> {
    const rows = await this.dataSource.query<Array<Record<string, string | null>>>(
      `WITH s AS (
         SELECT "hour", "bytes_used", "connections", "hits", "misses", "evictions",
                lead("hour") OVER w = "hour" + interval '1 hour' AS "followed",
                -- The same process as the next sample's: its start the same, to a few seconds, its counts not gone down.
                abs(extract(epoch FROM lead("process_started_at") OVER w - "process_started_at")) < 5
                  AND lead("hits") OVER w >= "hits" AND lead("misses") OVER w >= "misses" AND lead("evictions") OVER w >= "evictions" AS "continues",
                lead("hits") OVER w AS "hits_after", lead("misses") OVER w AS "misses_after", lead("evictions") OVER w AS "evictions_after"
           FROM "cache_samples"
          WHERE "hour" >= $1 AND "hour" < $2::timestamptz + interval '1 hour' AND "account_id" = $4 AND "cache_id" = $5
         WINDOW w AS (ORDER BY "hour"))
       SELECT floor(extract(epoch FROM "hour") / $3)::bigint * $3 AS "bucket",
              max("bytes_used") AS "bytes_max", avg("bytes_used") AS "bytes_avg", max("connections") AS "connections_max", avg("connections") AS "connections_avg",
              sum(CASE WHEN NOT "followed" THEN NULL WHEN "continues" THEN "hits_after" - "hits" ELSE "hits_after" END) AS "hits",
              sum(CASE WHEN NOT "followed" THEN NULL WHEN "continues" THEN "misses_after" - "misses" ELSE "misses_after" END) AS "misses",
              sum(CASE WHEN NOT "followed" THEN NULL WHEN "continues" THEN "evictions_after" - "evictions" ELSE "evictions_after" END) AS "evictions"
         FROM s
        WHERE "hour" < $2
        GROUP BY 1`,
      [window.start, window.end, window.period, accountId, cacheId],
    );
    const count = (value: string | null) => (value === null ? null : Number(value));
    return cacheMetricsView(
      window,
      rows.map((row) => ({
        bucket: Number(row.bucket),
        bytesMaximum: Number(row.bytes_max),
        bytesAverage: Number(row.bytes_avg),
        connectionsMaximum: Number(row.connections_max),
        connectionsAverage: Number(row.connections_avg),
        hits: count(row.hits),
        misses: count(row.misses),
        evictions: count(row.evictions),
      })),
    );
  }

  /**
   * The account's mail's, a point an hour, from its messages' recipients
   * (ADR 0012): the window's hours, and the 14 days before it that its
   * reputation is judged on. Messages are kept 30 days, so an hour before that
   * has none.
   */
  async emailMetrics(accountId: string, window: MetricsWindow): Promise<EmailMetricsView> {
    const rows = await this.dataSource.query<Array<Record<string, string>>>(
      `SELECT floor(extract(epoch FROM m."created_at") / $3)::bigint * $3 AS "bucket",
              count(*) AS "send",
              count(*) FILTER (WHERE r->>'status' IN ('SENT', 'COMPLAINED')) AS "delivery",
              count(*) FILTER (WHERE r->>'status' IN ('BOUNCED', 'SUPPRESSED')) AS "bounce",
              count(*) FILTER (WHERE r->>'status' = 'COMPLAINED') AS "complaint",
              count(*) FILTER (WHERE r->>'status' IN ('SENT', 'BOUNCED', 'COMPLAINED')) AS "reached",
              count(*) FILTER (WHERE r->>'status' = 'BOUNCED' AND r->>'permanent' = 'true') AS "hard"
         FROM "email_messages" m, jsonb_array_elements(m."recipients") r
        WHERE m."account_id" = $4 AND m."created_at" >= $1::timestamptz - make_interval(days => $5) AND m."created_at" < $2
        GROUP BY 1`,
      [window.start, window.end, window.period, accountId, REPUTATION_DAYS],
    );
    return emailMetricsView(
      window,
      rows.map((row) => ({
        bucket: Number(row.bucket),
        send: Number(row.send),
        delivery: Number(row.delivery),
        bounce: Number(row.bounce),
        complaint: Number(row.complaint),
        reached: Number(row.reached),
        hardBounces: Number(row.hard),
      })),
    );
  }

  /** A queue's, by its ID, as an alarm names it: none found answers an empty, quiet queue. */
  async queueMetrics(accountId: string, queueId: string, window: MetricsWindow): Promise<QueueMetricsView> {
    const [samples, counts] = await Promise.all([
      this.dataSource.query<Array<Record<string, string>>>(
        `SELECT floor(extract(epoch FROM "minute") / $3)::bigint * $3 AS "bucket",
                max("visible") AS "visible_max", sum("visible") AS "visible_sum", max("not_visible") AS "not_visible_max", sum("not_visible") AS "not_visible_sum",
                max("delayed") AS "delayed_max", sum("delayed") AS "delayed_sum", max("oldest_age_seconds") AS "oldest_age"
           FROM "queue_samples"
          WHERE "minute" >= $1 AND "minute" < $2 AND "account_id" = $4 AND "queue_id" = $5
          GROUP BY 1`,
        [window.start, window.end, window.period, accountId, queueId],
      ),
      this.dataSource.query<Array<Record<string, string>>>(
        `SELECT floor(extract(epoch FROM "minute") / $3)::bigint * $3 AS "bucket", sum("sent")::text AS "sent", sum("received")::text AS "received",
                sum("deleted")::text AS "deleted", sum("empty_receives")::text AS "empty_receives", sum("sent_bytes")::text AS "sent_bytes", max("sent_max_bytes") AS "sent_max_bytes"
           FROM "queue_request_counts"
          WHERE "minute" >= $1 AND "minute" < $2 AND "account_id" = $4 AND "queue_id" = $5
          GROUP BY 1`,
        [window.start, window.end, window.period, accountId, queueId],
      ),
    ]);
    const gauge = (row: Record<string, string>, column: string) => ({ maximum: Number(row[`${column}_max`]), minuteSum: Number(row[`${column}_sum`]) });
    return queueMetricsView(
      window,
      samples.map((row) => ({
        bucket: Number(row.bucket),
        ApproximateNumberOfMessagesVisible: gauge(row, 'visible'),
        ApproximateNumberOfMessagesNotVisible: gauge(row, 'not_visible'),
        ApproximateNumberOfMessagesDelayed: gauge(row, 'delayed'),
        oldestAgeSeconds: Number(row.oldest_age),
      })),
      counts.map((row) => ({
        bucket: Number(row.bucket),
        NumberOfMessagesSent: Number(row.sent),
        NumberOfMessagesReceived: Number(row.received),
        NumberOfMessagesDeleted: Number(row.deleted),
        NumberOfEmptyReceives: Number(row.empty_receives),
        sentBytes: Number(row.sent_bytes),
        sentMaxBytes: Number(row.sent_max_bytes),
      })),
    );
  }

  private async metrics(window: MetricsWindow, scope: Scope): Promise<MetricsView> {
    const [rows, refused, instances, calls] = await Promise.all([
      this.calls(window, scope),
      this.refused(window, scope),
      this.instances(window, scope),
      this.asynchronous(window, scope),
    ]);
    const throttled = new Map(refused.map((row) => [row.bucket, row.count]));
    const seen = new Set(rows.map((row) => row.bucket));
    const merged = rows.map((row) => ({ ...row, throttles: row.throttles + (throttled.get(row.bucket) ?? 0) }));
    for (const [bucket, count] of throttled) if (!seen.has(bucket)) merged.push(emptyRow(bucket, count));
    return metricsView(window, merged, instances, calls);
  }

  /** The scope's functions' asynchronous calls, per period, from their counts by the minute. */
  private async asynchronous(window: MetricsWindow, scope: Scope): Promise<AsyncRow[]> {
    const rows = await this.dataSource.query<Array<Record<string, string>>>(
      `SELECT floor(extract(epoch FROM t."minute") / $3)::bigint * $3 AS "bucket", sum(t."received")::text AS "received", sum(t."dropped")::text AS "dropped",
              sum(t."destination_failures")::text AS "destination_failures", sum(t."attempts")::text AS "attempts", sum(t."age_ms_sum")::text AS "age_ms_sum",
              max(t."age_ms_max") AS "age_ms_max"
         FROM "async_event_counts" t
        WHERE t."minute" >= $1 AND t."minute" < $2 AND ${scope.where}
        GROUP BY 1`,
      [window.start, window.end, window.period, ...scope.parameters],
    );
    return rows.map((row) => ({
      bucket: Number(row.bucket),
      received: Number(row.received),
      dropped: Number(row.dropped),
      destinationFailures: Number(row.destination_failures),
      attempts: Number(row.attempts),
      ageMsSum: Number(row.age_ms_sum),
      ageMsMax: Number(row.age_ms_max),
    }));
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
