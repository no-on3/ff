import type { Metrics } from '../services/api';

/** The time ranges the metrics tab offers, each with the period that keeps its chart readable. */
export const METRIC_RANGES = [
  { key: '1h', label: 'Last hour', seconds: 3_600, period: 60 },
  { key: '6h', label: 'Last 6 hours', seconds: 21_600, period: 300 },
  { key: '24h', label: 'Last 24 hours', seconds: 86_400, period: 300 },
  { key: '7d', label: 'Last 7 days', seconds: 604_800, period: 3_600 },
] as const;
export type MetricRange = (typeof METRIC_RANGES)[number]['key'];

/** The API's parameters for a range, ending now. */
export function rangeQuery(range: MetricRange, now = new Date()): { period: number; start: string; end: string } {
  const { seconds, period } = METRIC_RANGES.find((r) => r.key === range) ?? METRIC_RANGES[0];
  return { period, start: new Date(now.getTime() - seconds * 1000).toISOString(), end: now.toISOString() };
}

/** One point, as the charts and the table read it. */
export interface MetricRow {
  time: string;
  Invocations: number;
  Errors: number;
  Throttles: number;
  ColdStarts: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  Maximum: number | null;
  Instances: number;
}

/** The series as rows, one per period, oldest first. */
export function metricRows(view: Metrics): MetricRow[] {
  const m = view.metrics;
  return view.timestamps.map((time, i) => ({
    time,
    Invocations: m.Invocations[i],
    Errors: m.Errors[i],
    Throttles: m.Throttles[i],
    ColdStarts: m.ColdStarts[i],
    p50: m.Duration.p50[i],
    p95: m.Duration.p95[i],
    p99: m.Duration.p99[i],
    Maximum: m.Duration.Maximum[i],
    Instances: m.Instances.Maximum[i],
  }));
}

/** The range's totals, for the figures above the charts. */
export interface MetricTotals {
  invocations: number;
  errors: number;
  /** Errors over invocations, in percent; null without invocations. */
  errorRate: number | null;
  throttles: number;
  coldStarts: number;
  /** The slowest call of the range, in milliseconds; null without one. */
  slowest: number | null;
  /** The most instances ready at once. */
  peakInstances: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function metricTotals(view: Metrics): MetricTotals {
  const m = view.metrics;
  const invocations = sum(m.Invocations);
  const errors = sum(m.Errors);
  const measured = m.Duration.Maximum.filter((v): v is number => v !== null);
  return {
    invocations,
    errors,
    errorRate: invocations > 0 ? Math.round((errors / invocations) * 1000) / 10 : null,
    throttles: sum(m.Throttles),
    coldStarts: sum(m.ColdStarts),
    slowest: measured.length ? Math.max(...measured) : null,
    peakInstances: m.Instances.Maximum.length ? Math.max(...m.Instances.Maximum) : 0,
  };
}

/** A period's start, as the axis and the table show it: the time for a short range, the day too for a long one. */
export function pointLabel(time: string, period: number): string {
  const at = new Date(time);
  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return period >= 3_600 ? `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock}` : clock;
}

/** Milliseconds to read: "12.3 ms", "1,450 ms", or a dash for none. */
export const milliseconds = (value: number | null): string =>
  value === null ? '–' : `${value.toLocaleString('en', { maximumFractionDigits: value < 100 ? 1 : 0 })} ms`;
