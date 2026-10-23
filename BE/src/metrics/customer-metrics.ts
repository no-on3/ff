/**
 * A function's or an account's metrics, as CloudWatch names Lambda's:
 * Invocations, Errors, Throttles and Duration, with FF's ColdStarts and
 * Instances. They come from the usage records, so that they are exact,
 * outlive restarts and deleted functions, and agree with the bill; the
 * instances from the capacity samples. A period is one series point; quiet
 * periods are zeros, and a period without a call has no duration.
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

/** The series of the window, a point per period, quiet periods at zero, and no duration where nothing was measured. */
export function metricsView(window: MetricsWindow, rows: PeriodRow[], instances: InstancesRow[]): MetricsView {
  const seconds = window.period;
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const instancesByBucket = new Map(instances.map((row) => [row.bucket, row]));
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
