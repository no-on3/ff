import type { MetricsView } from '../metrics/customer-metrics';

/**
 * An alarm's rules, as CloudWatch's: a metric and its statistic over a
 * period, compared with a threshold, "M out of N" periods breaching, and what
 * a period without a datapoint counts as. The metrics are those of the
 * metrics API, and two of the account's money, read as they are.
 */

/** The metrics an alarm watches, and the statistics each has. */
export const STATISTICS = {
  Invocations: ['Sum'],
  Errors: ['Sum'],
  Throttles: ['Sum'],
  ColdStarts: ['Sum'],
  Duration: ['Average', 'Maximum', 'p50', 'p95', 'p99'],
  Instances: ['Maximum', 'Average'],
  // The account's money, in the prices' currency, read as it is at each evaluation.
  Balance: ['Latest'],
  MonthToDateCharges: ['Latest'],
} as const;
export type Metric = keyof typeof STATISTICS;
export type Statistic = (typeof STATISTICS)[Metric][number];
export const METRICS = Object.keys(STATISTICS) as Metric[];
export const ALL_STATISTICS = [...new Set(Object.values(STATISTICS).flat())] as Statistic[];
/** The account's money: account-wide, one datapoint, read as it is. */
export const BILLING_METRICS: readonly Metric[] = ['Balance', 'MonthToDateCharges'];

export const COMPARISONS = ['GreaterThanThreshold', 'GreaterThanOrEqualToThreshold', 'LessThanThreshold', 'LessThanOrEqualToThreshold'] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** What a period without a datapoint counts as, as CloudWatch's TreatMissingData. */
export const MISSING_DATA = ['missing', 'notBreaching', 'breaching', 'ignore'] as const;
export type MissingData = (typeof MISSING_DATA)[number];

export const STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const;
export type AlarmState = (typeof STATES)[number];

export const ALARM_PERIODS = [60, 300, 3600] as const;
export const MAX_EVALUATION_PERIODS = 60;
/** The longest an alarm looks back: N periods of at most a day. */
export const MAX_LOOKBACK_SECONDS = 86_400;
export const MAX_WEBHOOKS = 5;
export const MAX_ALARMS = 50;

export interface AlarmRule {
  functionId: string | null;
  metric: Metric;
  statistic: Statistic;
  period: number;
  comparison: Comparison;
  threshold: number;
  evaluationPeriods: number;
  datapointsToAlarm: number;
  treatMissingData: MissingData;
}

/** Why an alarm can't be, or null: a statistic its metric has, its periods, and a billing metric's own rules. */
export function alarmProblem(rule: AlarmRule): string | null {
  const statistics = STATISTICS[rule.metric] as readonly string[];
  if (!statistics.includes(rule.statistic)) return `${rule.metric} has the statistic${statistics.length > 1 ? 's' : ''} ${statistics.join(', ')}, not ${rule.statistic}`;
  if (rule.datapointsToAlarm > rule.evaluationPeriods) return `datapointsToAlarm (${rule.datapointsToAlarm}) can't be more than evaluationPeriods (${rule.evaluationPeriods})`;
  if (BILLING_METRICS.includes(rule.metric)) {
    if (rule.functionId) return `${rule.metric} is the account's: a billing alarm names no function`;
    if (rule.evaluationPeriods !== 1 || rule.datapointsToAlarm !== 1) return `${rule.metric} is read as it is: evaluationPeriods and datapointsToAlarm must be 1`;
    return null;
  }
  if (rule.period * rule.evaluationPeriods > MAX_LOOKBACK_SECONDS) {
    return `${rule.evaluationPeriods} periods of ${rule.period} s look back more than a day: take fewer periods, or shorter ones`;
  }
  return null;
}

/** The periods an alarm judges: the last N whole ones that have been over at least `settleSeconds`, so that calls ending late still count. */
export function evaluationWindow(rule: Pick<AlarmRule, 'period' | 'evaluationPeriods'>, now: Date, settleSeconds: number): { start: Date; end: Date } {
  const ms = rule.period * 1000;
  const end = Math.floor((now.getTime() - settleSeconds * 1000) / ms) * ms;
  return { start: new Date(end - rule.evaluationPeriods * ms), end: new Date(end) };
}

const COMPARE: Record<Comparison, (value: number, threshold: number) => boolean> = {
  GreaterThanThreshold: (v, t) => v > t,
  GreaterThanOrEqualToThreshold: (v, t) => v >= t,
  LessThanThreshold: (v, t) => v < t,
  LessThanOrEqualToThreshold: (v, t) => v <= t,
};
export const SYMBOL: Record<Comparison, string> = {
  GreaterThanThreshold: '>',
  GreaterThanOrEqualToThreshold: '>=',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '<=',
};

/** How an evaluation went: its parts, which the reason and each language's e-mail are written from. */
export interface Evaluation {
  state: AlarmState;
  /** The datapoints judged, oldest first; null for a period without one. */
  datapoints: Array<number | null>;
  breaching: number;
  missing: number;
  /** The newest datapoint there is. */
  latest: number | null;
}

/**
 * The state the datapoints give: ALARM when M or more of the N breach, OK
 * when fewer do. A missing datapoint counts as the rule says: as missing, it
 * is left out, and all N missing is INSUFFICIENT_DATA; as breaching or not;
 * or ignored, all N missing then keeping the current state.
 */
export function evaluate(rule: Pick<AlarmRule, 'comparison' | 'threshold' | 'datapointsToAlarm' | 'treatMissingData'>, datapoints: Array<number | null>, current: AlarmState): Evaluation {
  const missing = datapoints.filter((value) => value === null).length;
  const present = datapoints.filter((value): value is number => value !== null);
  const latest = present.length ? present[present.length - 1] : null;
  let breaching = present.filter((value) => COMPARE[rule.comparison](value, rule.threshold)).length;
  if (rule.treatMissingData === 'breaching') breaching += missing;
  let state: AlarmState;
  if (missing === datapoints.length && (rule.treatMissingData === 'missing' || rule.treatMissingData === 'ignore')) {
    state = rule.treatMissingData === 'ignore' ? current : 'INSUFFICIENT_DATA';
  } else {
    state = breaching >= rule.datapointsToAlarm ? 'ALARM' : 'OK';
  }
  return { state, datapoints, breaching, missing, latest };
}

/** Why an alarm is in its state, in English, as the API and the webhook give it. */
export function stateReason(rule: Pick<AlarmRule, 'metric' | 'statistic' | 'period' | 'comparison' | 'threshold' | 'datapointsToAlarm'>, evaluation: Evaluation): string {
  const what = BILLING_METRICS.includes(rule.metric) ? rule.metric : `${rule.metric} ${rule.statistic}`;
  if (evaluation.missing === evaluation.datapoints.length) return `No datapoint for ${what} in the last ${evaluation.datapoints.length} period(s) of ${rule.period} s`;
  const breach = `${what} ${SYMBOL[rule.comparison]} ${rule.threshold}`;
  if (BILLING_METRICS.includes(rule.metric)) return `${rule.metric} is ${evaluation.latest}: ${evaluation.breaching ? 'breaching' : 'not breaching'} ${breach}`;
  const missing = evaluation.missing ? `, ${evaluation.missing} missing` : '';
  return `${evaluation.breaching} of the last ${evaluation.datapoints.length} period(s) of ${rule.period} s breaching ${breach} (${rule.datapointsToAlarm} needed${missing}); latest ${evaluation.latest}`;
}

/** Whether a change of state is told: into ALARM, and out of it. */
export const notifies = (from: AlarmState, to: AlarmState): boolean => from !== to && (to === 'ALARM' || from === 'ALARM');

/** A metric's datapoints in a metrics answer, oldest first: a count's every period, a duration's null where no call was measured. */
export function datapointsOf(view: MetricsView, metric: Metric, statistic: Statistic): Array<number | null> {
  const m = view.metrics;
  switch (metric) {
    case 'Invocations':
    case 'Errors':
    case 'Throttles':
    case 'ColdStarts':
      return m[metric];
    case 'Duration':
      return m.Duration[statistic as keyof MetricsView['metrics']['Duration']];
    case 'Instances':
      return m.Instances[statistic as keyof MetricsView['metrics']['Instances']];
    default:
      throw new Error(`${metric} isn't in the metrics API`);
  }
}

