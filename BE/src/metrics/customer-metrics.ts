/**
 * A function's or an account's metrics, as CloudWatch names Lambda's:
 * Invocations, Errors, Throttles and Duration, with FF's ColdStarts and
 * Instances. They come from the usage records, so that they are exact,
 * outlive restarts and deleted functions, and agree with the bill; the
 * instances from the capacity samples; its asynchronous calls' from their
 * counts by the minute. A period is one series point; quiet periods are
 * zeros, and a period without a call has no duration.
 */

/** The periods a point can cover, in seconds: a minute, five, an hour. */
export const PERIODS = [60, 300, 3600] as const;
export type Period = (typeof PERIODS)[number];
/** The most points one answer gives: a day of minutes. */
export const MAX_POINTS = 1440;
/** Without a start, the answer covers this many periods back. */
export const DEFAULT_POINTS = 60;

export interface MetricsWindow {
  /** The first period's start, included. */
  start: Date;
  /** The last period's end, excluded. */
  end: Date;
  period: Period;
}

/** One period's figures, as the queries give them; a period with none has no row. */
export interface PeriodRow {
  /** The period's start, in seconds since the epoch. */
  bucket: number;
  invocations: number;
  errors: number;
  throttles: number;
  coldStarts: number;
  /** null when no call in the period was measured. */
  durationAverage: number | null;
  durationMaximum: number | null;
  durationP50: number | null;
  durationP95: number | null;
  durationP99: number | null;
}

/** A period's asynchronous calls, as the query adds their counts up; a quiet period has no row. */
export interface AsyncRow {
  bucket: number;
  received: number;
  dropped: number;
  destinationFailures: number;
  /** The attempts made, their ages added up, and the oldest, in milliseconds. */
  attempts: number;
  ageMsSum: number;
  ageMsMax: number;
}

/** A period's instances: the most ready at once in one of its minutes, and the mean over its minutes. */
export interface InstancesRow {
  bucket: number;
  maximum: number;
  /** The sum over its minutes of the instances ready: a minute without one counts 0. */
  minuteSum: number;
}

export interface MetricsView {
  period: Period;
  start: Date;
  end: Date;
  /** Each period's start. */
  timestamps: Date[];
  metrics: {
    Invocations: number[];
    Errors: number[];
    Throttles: number[];
    ColdStarts: number[];
    Duration: { Average: Array<number | null>; Maximum: Array<number | null>; p50: Array<number | null>; p95: Array<number | null>; p99: Array<number | null> };
    Instances: { Maximum: number[]; Average: number[] };
    /** Lambda's metrics of asynchronous calls: events kept, their age at each attempt (null without one), events dropped, records a destination didn't take. */
    AsyncEventsReceived: number[];
    AsyncEventAge: { Average: Array<number | null>; Maximum: Array<number | null> };
    AsyncEventsDropped: number[];
    DestinationDeliveryFailures: number[];
  };
}

/**
 * The window a request names, in whole periods of UTC time: its start rounded
 * down, its end up. By default it ends now and starts 60 periods before.
 * Returns why it can't be, for a 400: a start not before the end, or more
 * points than an answer gives.
 */
export function metricsWindow(request: { start?: string; end?: string; period?: number }, now: Date): MetricsWindow | { problem: string } {
  const period = (request.period ?? 60) as Period;
  const ms = period * 1000;
  const endAt = request.end ? new Date(request.end) : now;
  const startAt = request.start ? new Date(request.start) : new Date(endAt.getTime() - DEFAULT_POINTS * ms);
  if (startAt.getTime() >= endAt.getTime()) return { problem: 'start must be before end' };
  const start = new Date(Math.floor(startAt.getTime() / ms) * ms);
  const end = new Date(Math.ceil(endAt.getTime() / ms) * ms);
  const points = (end.getTime() - start.getTime()) / ms;
  if (points > MAX_POINTS) {
    return { problem: `The window holds ${points} periods of ${period} s: at most ${MAX_POINTS}. Take a longer period, or a shorter window` };
  }
  return { start, end, period };
}

const round3 = (value: number | null): number | null => (value === null ? null : Math.round(value * 1000) / 1000);

/** The series of the window, a point per period, quiet periods at zero, and no duration or age where nothing was measured. */
export function metricsView(window: MetricsWindow, rows: PeriodRow[], instances: InstancesRow[], calls: AsyncRow[] = []): MetricsView {
  const seconds = window.period;
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const instancesByBucket = new Map(instances.map((row) => [row.bucket, row]));
  const callsByBucket = new Map(calls.map((row) => [row.bucket, row]));
  const view: MetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: {
      Invocations: [],
      Errors: [],
      Throttles: [],
      ColdStarts: [],
      Duration: { Average: [], Maximum: [], p50: [], p95: [], p99: [] },
      Instances: { Maximum: [], Average: [] },
      AsyncEventsReceived: [],
      AsyncEventAge: { Average: [], Maximum: [] },
      AsyncEventsDropped: [],
      DestinationDeliveryFailures: [],
    },
  };
  const m = view.metrics;
  for (let bucket = window.start.getTime() / 1000; bucket < window.end.getTime() / 1000; bucket += seconds) {
    const row = byBucket.get(bucket);
    const ready = instancesByBucket.get(bucket);
    view.timestamps.push(new Date(bucket * 1000));
    m.Invocations.push(row?.invocations ?? 0);
    m.Errors.push(row?.errors ?? 0);
    m.Throttles.push(row?.throttles ?? 0);
    m.ColdStarts.push(row?.coldStarts ?? 0);
    m.Duration.Average.push(round3(row?.durationAverage ?? null));
    m.Duration.Maximum.push(round3(row?.durationMaximum ?? null));
    m.Duration.p50.push(round3(row?.durationP50 ?? null));
    m.Duration.p95.push(round3(row?.durationP95 ?? null));
    m.Duration.p99.push(round3(row?.durationP99 ?? null));
    m.Instances.Maximum.push(ready?.maximum ?? 0);
    m.Instances.Average.push(ready ? round3(ready.minuteSum / (seconds / 60)) ?? 0 : 0);
    const call = callsByBucket.get(bucket);
    const attempted = call !== undefined && call.attempts > 0;
    m.AsyncEventsReceived.push(call?.received ?? 0);
    m.AsyncEventAge.Average.push(attempted ? round3(call.ageMsSum / call.attempts) : null);
    m.AsyncEventAge.Maximum.push(attempted ? call.ageMsMax : null);
    m.AsyncEventsDropped.push(call?.dropped ?? 0);
    m.DestinationDeliveryFailures.push(call?.destinationFailures ?? 0);
  }
  return view;
}

/** A database's metrics have a point an hour: its samples' (ADR 0008). */
export const DATABASE_PERIOD = 3600;

/**
 * A customer's database's metrics, as CloudWatch names RDS's and Aurora's:
 * its sessions (DatabaseConnections) and the storage it uses
 * (VolumeBytesUsed), from its hourly samples. An hour without a sample has
 * none: null.
 */
export interface DatabaseMetricsView {
  period: number;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: {
    DatabaseConnections: { Maximum: Array<number | null>; Average: Array<number | null> };
    VolumeBytesUsed: { Maximum: Array<number | null>; Average: Array<number | null> };
  };
}

/** An hour's samples of a database, as the query gives them: their most and their mean. */
export interface DatabaseHourRow {
  bucket: number;
  connectionsMaximum: number;
  connectionsAverage: number;
  bytesMaximum: number;
  bytesAverage: number;
}

/** The series of the window, a point an hour, null where the database wasn't sampled. */
export function databaseMetricsView(window: MetricsWindow, rows: DatabaseHourRow[]): DatabaseMetricsView {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const view: DatabaseMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: { DatabaseConnections: { Maximum: [], Average: [] }, VolumeBytesUsed: { Maximum: [], Average: [] } },
  };
  const m = view.metrics;
  for (let bucket = window.start.getTime() / 1000; bucket < window.end.getTime() / 1000; bucket += window.period) {
    const row = byBucket.get(bucket);
    view.timestamps.push(new Date(bucket * 1000));
    m.DatabaseConnections.Maximum.push(row ? row.connectionsMaximum : null);
    m.DatabaseConnections.Average.push(row ? round3(row.connectionsAverage) : null);
    m.VolumeBytesUsed.Maximum.push(row ? row.bytesMaximum : null);
    m.VolumeBytesUsed.Average.push(row ? Math.round(row.bytesAverage) : null);
  }
  return view;
}

/** A cache's metrics have a point an hour: its samples' (ADR 0013). */
export const CACHE_PERIOD = 3600;

/**
 * A customer's cache's metrics, as CloudWatch names ElastiCache's: what its
 * keys use (BytesUsedForCache) and its connections (CurrConnections), from
 * its hour's sample; and its hits, misses and evictions in the hour
 * (CacheHits, CacheMisses, Evictions), from its sample to the next hour's,
 * all of the next one's own when its process started again between them. An
 * hour without a sample has none: null; its counts are null too without the
 * next hour's, as in the hour now.
 */
export interface CacheMetricsView {
  period: number;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: {
    BytesUsedForCache: { Maximum: Array<number | null>; Average: Array<number | null> };
    CurrConnections: { Maximum: Array<number | null>; Average: Array<number | null> };
    CacheHits: { Sum: Array<number | null> };
    CacheMisses: { Sum: Array<number | null> };
    Evictions: { Sum: Array<number | null> };
  };
}

/** An hour's samples of a cache, as the query gives them: their most and their mean, and the hour's counts, null without the next hour's sample. */
export interface CacheHourRow {
  bucket: number;
  bytesMaximum: number;
  bytesAverage: number;
  connectionsMaximum: number;
  connectionsAverage: number;
  hits: number | null;
  misses: number | null;
  evictions: number | null;
}

/** The series of the window, a point an hour, null where the cache wasn't sampled. */
export function cacheMetricsView(window: MetricsWindow, rows: CacheHourRow[]): CacheMetricsView {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const view: CacheMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: {
      BytesUsedForCache: { Maximum: [], Average: [] },
      CurrConnections: { Maximum: [], Average: [] },
      CacheHits: { Sum: [] },
      CacheMisses: { Sum: [] },
      Evictions: { Sum: [] },
    },
  };
  const m = view.metrics;
  for (let bucket = window.start.getTime() / 1000; bucket < window.end.getTime() / 1000; bucket += window.period) {
    const row = byBucket.get(bucket);
    view.timestamps.push(new Date(bucket * 1000));
    m.BytesUsedForCache.Maximum.push(row ? row.bytesMaximum : null);
    m.BytesUsedForCache.Average.push(row ? Math.round(row.bytesAverage) : null);
    m.CurrConnections.Maximum.push(row ? row.connectionsMaximum : null);
    m.CurrConnections.Average.push(row ? round3(row.connectionsAverage) : null);
    m.CacheHits.Sum.push(row ? row.hits : null);
    m.CacheMisses.Sum.push(row ? row.misses : null);
    m.Evictions.Sum.push(row ? row.evictions : null);
  }
  return view;
}

/** Mail's metrics have a point an hour (ADR 0012), as caches' do. */
export const EMAIL_PERIOD = 3600;
/** The days a reputation rate is judged on, as FF's enforcement judges it: those of the last 14. */
export const REPUTATION_DAYS = 14;

/**
 * An account's mail's metrics, as CloudWatch names SES's, a point an hour from
 * its messages, each recipient one, counted in its message's hour: sent
 * (Send), taken by the receiving side and not bounced since, complaints
 * included (Delivery), bounced or kept off by the suppression list (Bounce),
 * complained of (Complaint). And its reputation at each hour's end, over the
 * 14 days before it, as FF's enforcement judges it: the share of the
 * recipients its mail reached that bounced for good, and that complained, a
 * fraction as SES gives it (Reputation.BounceRate, Reputation.ComplaintRate);
 * null without a recipient reached in those days.
 */
export interface EmailMetricsView {
  period: number;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: {
    Send: { Sum: number[] };
    Delivery: { Sum: number[] };
    Bounce: { Sum: number[] };
    Complaint: { Sum: number[] };
    'Reputation.BounceRate': { Average: Array<number | null> };
    'Reputation.ComplaintRate': { Average: Array<number | null> };
  };
}

/** An hour's recipients, as the query counts them: what became of them, and those its reputation is judged on. */
export interface EmailHourRow {
  bucket: number;
  send: number;
  delivery: number;
  bounce: number;
  complaint: number;
  /** Reached: taken, bounced or complained of, as the enforcement counts them. */
  reached: number;
  /** Bounced for good. */
  hardBounces: number;
}

/** The series of the window, a point an hour; the rows reach 14 days before it, for the rates. */
export function emailMetricsView(window: MetricsWindow, rows: EmailHourRow[]): EmailMetricsView {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const view: EmailMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: { Send: { Sum: [] }, Delivery: { Sum: [] }, Bounce: { Sum: [] }, Complaint: { Sum: [] }, 'Reputation.BounceRate': { Average: [] }, 'Reputation.ComplaintRate': { Average: [] } },
  };
  const m = view.metrics;
  const days = REPUTATION_DAYS * 86_400;
  for (let bucket = window.start.getTime() / 1000; bucket < window.end.getTime() / 1000; bucket += window.period) {
    const row = byBucket.get(bucket);
    view.timestamps.push(new Date(bucket * 1000));
    m.Send.Sum.push(row?.send ?? 0);
    m.Delivery.Sum.push(row?.delivery ?? 0);
    m.Bounce.Sum.push(row?.bounce ?? 0);
    m.Complaint.Sum.push(row?.complaint ?? 0);
    // The 14 days that end with the hour.
    const end = bucket + window.period;
    const judged = rows.filter((one) => one.bucket >= end - days && one.bucket < end);
    const reached = judged.reduce((sum, one) => sum + one.reached, 0);
    const rate = (count: (one: EmailHourRow) => number) => (reached === 0 ? null : Math.round((judged.reduce((sum, one) => sum + count(one), 0) / reached) * 1e6) / 1e6);
    m['Reputation.BounceRate'].Average.push(rate((one) => one.hardBounces));
    m['Reputation.ComplaintRate'].Average.push(rate((one) => one.complaint));
  }
  return view;
}

/** The request metrics a bucket has, each period's Sum, as CloudWatch names S3's. */
export const BUCKET_REQUEST_METRICS = ['AllRequests', 'GetRequests', 'PutRequests', '4xxErrors', '5xxErrors', 'BytesDownloaded', 'BytesUploaded'] as const;
export type BucketRequestMetric = (typeof BUCKET_REQUEST_METRICS)[number];

/**
 * A customer's bucket's metrics, as CloudWatch names S3's (ADR 0009): what it
 * holds (BucketSizeBytes) and its objects (NumberOfObjects), its hour's
 * measure in each period of the hour, null in an hour it wasn't measured in;
 * and its requests, each period's Sum, from the front door's minute counts:
 * all of them, the GETs and the PUTs, those answered 4xx and 5xx, the bytes
 * downloaded and uploaded. A quiet period's requests are zeros.
 */
export interface BucketMetricsView {
  period: Period;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: { BucketSizeBytes: { Average: Array<number | null> }; NumberOfObjects: { Average: Array<number | null> } } & Record<BucketRequestMetric, { Sum: number[] }>;
}

/** An hour's measure of a bucket, its start in seconds since the epoch. */
export interface BucketHourRow {
  hour: number;
  sizeBytes: number;
  objects: number;
}

/** A period's requests to a bucket, as the query sums them; a quiet period has no row. */
export type BucketPeriodRow = { bucket: number } & Record<BucketRequestMetric, number>;

/** The series of the window, a point per period: the storage of its hour, null where unmeasured; the requests, zeros where quiet. */
export function bucketMetricsView(window: MetricsWindow, hours: BucketHourRow[], periods: BucketPeriodRow[]): BucketMetricsView {
  const byHour = new Map(hours.map((row) => [row.hour, row]));
  const byPeriod = new Map(periods.map((row) => [row.bucket, row]));
  const requests = Object.fromEntries(BUCKET_REQUEST_METRICS.map((metric) => [metric, { Sum: [] as number[] }])) as Record<BucketRequestMetric, { Sum: number[] }>;
  const view: BucketMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: { BucketSizeBytes: { Average: [] }, NumberOfObjects: { Average: [] }, ...requests },
  };
  for (let start = window.start.getTime() / 1000; start < window.end.getTime() / 1000; start += window.period) {
    const measure = byHour.get(Math.floor(start / 3600) * 3600);
    const period = byPeriod.get(start);
    view.timestamps.push(new Date(start * 1000));
    view.metrics.BucketSizeBytes.Average.push(measure ? measure.sizeBytes : null);
    view.metrics.NumberOfObjects.Average.push(measure ? measure.objects : null);
    for (const metric of BUCKET_REQUEST_METRICS) view.metrics[metric].Sum.push(period?.[metric] ?? 0);
  }
  return view;
}

/** A site's metrics, as CloudWatch names a CloudFront distribution's: its visits and their bytes, each period's Sum; the shares of them that failed, in percent. */
export const SITE_METRICS = ['Requests', 'BytesDownloaded', '4xxErrorRate', '5xxErrorRate', 'TotalErrorRate'] as const;
export type SiteMetric = (typeof SITE_METRICS)[number];
/** Of them, the shares, each period's Average. */
export const SITE_RATES = ['4xxErrorRate', '5xxErrorRate', 'TotalErrorRate'] as const;
export type SiteRate = (typeof SITE_RATES)[number];

/**
 * A bucket's site's metrics, as CloudWatch names a CloudFront distribution's
 * (ADR 0011), from the website server's counts by the minute: its visits
 * (Requests) and the bytes they sent (BytesDownloaded), each period's Sum, a
 * quiet period's 0; and the share of the visits answered 4xx, 5xx and either,
 * in percent, each period's Average, null in a period without a visit. The
 * bucket's own metrics count its site's visits among its requests.
 */
export interface SiteMetricsView {
  period: Period;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: { Requests: { Sum: number[] }; BytesDownloaded: { Sum: number[] } } & Record<SiteRate, { Average: Array<number | null> }>;
}

/** A period's visits to a site, as the query sums them; a quiet period has no row. */
export interface SitePeriodRow {
  bucket: number;
  requests: number;
  bytesOut: number;
  errors4xx: number;
  errors5xx: number;
}

/** The series of the window, a point per period: zeros where quiet, the shares null where there was no visit. */
export function siteMetricsView(window: MetricsWindow, periods: SitePeriodRow[]): SiteMetricsView {
  const byPeriod = new Map(periods.map((row) => [row.bucket, row]));
  const view: SiteMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: { Requests: { Sum: [] }, BytesDownloaded: { Sum: [] }, '4xxErrorRate': { Average: [] }, '5xxErrorRate': { Average: [] }, TotalErrorRate: { Average: [] } },
  };
  const share = (part: number, all: number) => (all === 0 ? null : round3((100 * part) / all));
  for (let start = window.start.getTime() / 1000; start < window.end.getTime() / 1000; start += window.period) {
    const { requests = 0, bytesOut = 0, errors4xx = 0, errors5xx = 0 } = byPeriod.get(start) ?? {};
    view.timestamps.push(new Date(start * 1000));
    view.metrics.Requests.Sum.push(requests);
    view.metrics.BytesDownloaded.Sum.push(bytesOut);
    view.metrics['4xxErrorRate'].Average.push(share(errors4xx, requests));
    view.metrics['5xxErrorRate'].Average.push(share(errors5xx, requests));
    view.metrics.TotalErrorRate.Average.push(share(errors4xx + errors5xx, requests));
  }
  return view;
}

/** A queue's approximate counts, sampled each minute: each period's most and its mean over its minutes, as CloudWatch's Maximum and Average. */
export const QUEUE_GAUGES = ['ApproximateNumberOfMessagesVisible', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'] as const;
export type QueueGauge = (typeof QUEUE_GAUGES)[number];
/** A queue's counts of messages and receives, each period's Sum. */
export const QUEUE_COUNTS = ['NumberOfMessagesSent', 'NumberOfMessagesReceived', 'NumberOfMessagesDeleted', 'NumberOfEmptyReceives'] as const;
export type QueueCount = (typeof QUEUE_COUNTS)[number];

/**
 * A customer's queue's metrics, as CloudWatch names SQS's (ADR 0010): its
 * messages that can be received, in flight and delayed, sampled each minute,
 * a minute without a sample an empty queue's; its oldest message's age, the
 * most of the period's minutes; and from its requests' counts by the minute,
 * the messages sent, received and deleted, the receives that found none, and
 * the size of the messages sent, null in a period without one.
 */
export interface QueueMetricsView {
  period: Period;
  start: Date;
  end: Date;
  timestamps: Date[];
  metrics: Record<QueueGauge, { Maximum: number[]; Average: number[] }> &
    Record<QueueCount, { Sum: number[] }> & {
      ApproximateAgeOfOldestMessage: { Maximum: number[] };
      SentMessageSize: { Average: Array<number | null>; Maximum: Array<number | null> };
    };
}

/** A period's samples of a queue, as the query adds them up; a period without one has no row. */
export type QueueSampleRow = { bucket: number; oldestAgeSeconds: number } & Record<QueueGauge, { maximum: number; minuteSum: number }>;

/** A period's counts of a queue, as the query adds them up; a quiet period has no row. */
export type QueueCountRow = { bucket: number; sentBytes: number; sentMaxBytes: number } & Record<QueueCount, number>;

/** The series of the window, a point per period: zeros where the queue was empty or quiet, no message size where none was sent. */
export function queueMetricsView(window: MetricsWindow, samples: QueueSampleRow[], counts: QueueCountRow[]): QueueMetricsView {
  const bySample = new Map(samples.map((row) => [row.bucket, row]));
  const byCount = new Map(counts.map((row) => [row.bucket, row]));
  const minutes = window.period / 60;
  const gauges = Object.fromEntries(QUEUE_GAUGES.map((metric) => [metric, { Maximum: [] as number[], Average: [] as number[] }])) as Record<QueueGauge, { Maximum: number[]; Average: number[] }>;
  const sums = Object.fromEntries(QUEUE_COUNTS.map((metric) => [metric, { Sum: [] as number[] }])) as Record<QueueCount, { Sum: number[] }>;
  const view: QueueMetricsView = {
    period: window.period,
    start: window.start,
    end: window.end,
    timestamps: [],
    metrics: { ...gauges, ...sums, ApproximateAgeOfOldestMessage: { Maximum: [] }, SentMessageSize: { Average: [], Maximum: [] } },
  };
  for (let start = window.start.getTime() / 1000; start < window.end.getTime() / 1000; start += window.period) {
    const sample = bySample.get(start);
    const count = byCount.get(start);
    view.timestamps.push(new Date(start * 1000));
    for (const metric of QUEUE_GAUGES) {
      view.metrics[metric].Maximum.push(sample?.[metric].maximum ?? 0);
      view.metrics[metric].Average.push(round3((sample?.[metric].minuteSum ?? 0) / minutes) as number);
    }
    view.metrics.ApproximateAgeOfOldestMessage.Maximum.push(sample?.oldestAgeSeconds ?? 0);
    for (const metric of QUEUE_COUNTS) view.metrics[metric].Sum.push(count?.[metric] ?? 0);
    const sent = count?.NumberOfMessagesSent ?? 0;
    view.metrics.SentMessageSize.Average.push(sent > 0 ? round3((count as QueueCountRow).sentBytes / sent) : null);
    view.metrics.SentMessageSize.Maximum.push(sent > 0 ? (count as QueueCountRow).sentMaxBytes : null);
  }
  return view;
}
