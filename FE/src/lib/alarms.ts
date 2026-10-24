import type { Alarm, AlarmBody, AlarmState } from '../services/api';
import { testUrlProblem } from './notifications';

/** The metrics an alarm watches and the statistics each has, as the API takes them; contract.test.ts checks them against its own. */
export const STATISTICS = {
  Invocations: ['Sum'],
  Errors: ['Sum'],
  Throttles: ['Sum'],
  ColdStarts: ['Sum'],
  Duration: ['Average', 'Maximum', 'p50', 'p95', 'p99'],
  Instances: ['Maximum', 'Average'],
  AsyncEventsReceived: ['Sum'],
  AsyncEventAge: ['Average', 'Maximum'],
  AsyncEventsDropped: ['Sum'],
  DestinationDeliveryFailures: ['Sum'],
  DatabaseConnections: ['Maximum', 'Average'],
  VolumeBytesUsed: ['Maximum', 'Average'],
  BucketSizeBytes: ['Average'],
  NumberOfObjects: ['Average'],
  AllRequests: ['Sum'],
  GetRequests: ['Sum'],
  PutRequests: ['Sum'],
  '4xxErrors': ['Sum'],
  '5xxErrors': ['Sum'],
  BytesDownloaded: ['Sum'],
  BytesUploaded: ['Sum'],
  ApproximateNumberOfMessagesVisible: ['Maximum', 'Average'],
  ApproximateNumberOfMessagesNotVisible: ['Maximum', 'Average'],
  ApproximateNumberOfMessagesDelayed: ['Maximum', 'Average'],
  ApproximateAgeOfOldestMessage: ['Maximum'],
  NumberOfMessagesSent: ['Sum'],
  NumberOfMessagesReceived: ['Sum'],
  NumberOfMessagesDeleted: ['Sum'],
  NumberOfEmptyReceives: ['Sum'],
  SentMessageSize: ['Average', 'Maximum'],
  Balance: ['Latest'],
  MonthToDateCharges: ['Latest'],
} as const;
export type Metric = keyof typeof STATISTICS;
export const METRICS = Object.keys(STATISTICS) as Metric[];
/** The account's money, read as it is: no function, one datapoint. */
export const BILLING_METRICS: readonly Metric[] = ['Balance', 'MonthToDateCharges'];
/** A customer's database's, an hour at a time: alarms on them are made on the database's page. */
export const DATABASE_METRICS: readonly Metric[] = ['DatabaseConnections', 'VolumeBytesUsed'];
/** A customer's bucket's, as CloudWatch names S3's: what it holds, and its requests. */
export const BUCKET_METRICS: readonly Metric[] = ['BucketSizeBytes', 'NumberOfObjects', 'AllRequests', 'GetRequests', 'PutRequests', '4xxErrors', '5xxErrors', 'BytesDownloaded', 'BytesUploaded'];
/** A customer's queue's, as CloudWatch names SQS's: its messages, their age and size, and its requests. */
export const QUEUE_METRICS: readonly Metric[] = [
  'ApproximateNumberOfMessagesVisible',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
  'ApproximateAgeOfOldestMessage',
  'NumberOfMessagesSent',
  'NumberOfMessagesReceived',
  'NumberOfMessagesDeleted',
  'NumberOfEmptyReceives',
  'SentMessageSize',
];

/** Each metric's unit, as the threshold is written. */
export const UNITS: Record<Metric, string> = {
  Invocations: 'calls',
  Errors: 'calls',
  Throttles: 'calls',
  ColdStarts: 'calls',
  Duration: 'ms',
  Instances: 'instances',
  AsyncEventsReceived: 'events',
  AsyncEventAge: 'ms',
  AsyncEventsDropped: 'events',
  DestinationDeliveryFailures: 'records',
  DatabaseConnections: 'sessions',
  VolumeBytesUsed: 'bytes',
  BucketSizeBytes: 'bytes',
  NumberOfObjects: 'objects',
  AllRequests: 'requests',
  GetRequests: 'requests',
  PutRequests: 'requests',
  '4xxErrors': 'requests',
  '5xxErrors': 'requests',
  BytesDownloaded: 'bytes',
  BytesUploaded: 'bytes',
  ApproximateNumberOfMessagesVisible: 'messages',
  ApproximateNumberOfMessagesNotVisible: 'messages',
  ApproximateNumberOfMessagesDelayed: 'messages',
  ApproximateAgeOfOldestMessage: 's',
  NumberOfMessagesSent: 'messages',
  NumberOfMessagesReceived: 'messages',
  NumberOfMessagesDeleted: 'messages',
  NumberOfEmptyReceives: 'receives',
  SentMessageSize: 'bytes',
  Balance: 'TND',
  MonthToDateCharges: 'TND',
};

export const COMPARISONS = [
  { value: 'GreaterThanThreshold', symbol: '>' },
  { value: 'GreaterThanOrEqualToThreshold', symbol: '>=' },
  { value: 'LessThanThreshold', symbol: '<' },
  { value: 'LessThanOrEqualToThreshold', symbol: '<=' },
] as const;
export type Comparison = (typeof COMPARISONS)[number]['value'];

export const PERIODS = [
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 3600, label: '1 hour' },
] as const;

export const MISSING_DATA = [
  { value: 'missing', label: 'Missing', help: 'Left out; with none at all, Insufficient data' },
  { value: 'notBreaching', label: 'Not breaching', help: 'Counted as good' },
  { value: 'breaching', label: 'Breaching', help: 'Counted as bad' },
  { value: 'ignore', label: 'Ignore', help: 'With none at all, the state stays' },
] as const;
export type MissingData = (typeof MISSING_DATA)[number]['value'];

export const MAX_EVALUATION_PERIODS = 60;
export const MAX_WEBHOOKS = 5;

/** The form's fields, as typed. */
export interface AlarmForm {
  name: string;
  /** '': the account's, or a database's. */
  functionId: string;
  /** '': none; a database's for its own metrics. */
  databaseId: string;
  /** '': none; a bucket's name, for its own metrics. */
  bucketName: string;
  /** '': none; a queue's name, for its own metrics. */
  queueName: string;
  metric: Metric;
  statistic: string;
  period: number;
  comparison: Comparison;
  threshold: string;
  evaluationPeriods: string;
  datapointsToAlarm: string;
  treatMissingData: MissingData;
  email: boolean;
  /** One URL per line. */
  webhookUrls: string;
}

/**
 * A new alarm: a function's errors, as soon as there is one; a database's storage, an hour at a time; a bucket's 5xx
 * errors; a queue's messages waiting, as a dead-letter queue's are watched; told to the owners.
 */
export const emptyForm = (functionId = '', databaseId = '', bucketName = '', queueName = ''): AlarmForm => ({
  name: '',
  functionId: databaseId || bucketName || queueName ? '' : functionId,
  databaseId: bucketName || queueName ? '' : databaseId,
  bucketName: queueName ? '' : bucketName,
  queueName,
  metric: queueName ? 'ApproximateNumberOfMessagesVisible' : bucketName ? '5xxErrors' : databaseId ? 'VolumeBytesUsed' : functionId ? 'Errors' : 'Invocations',
  statistic: queueName || (databaseId && !bucketName) ? 'Maximum' : 'Sum',
  period: databaseId && !bucketName && !queueName ? 3600 : bucketName && !queueName ? 300 : 60,
  comparison: 'GreaterThanThreshold',
  threshold: '0',
  evaluationPeriods: '1',
  datapointsToAlarm: '1',
  treatMissingData: 'missing',
  email: true,
  webhookUrls: '',
});

export const formFromAlarm = (alarm: Alarm): AlarmForm => ({
  name: alarm.name,
  functionId: alarm.functionId ?? '',
  databaseId: alarm.databaseId ?? '',
  bucketName: alarm.bucketName ?? '',
  queueName: alarm.queueName ?? '',
  metric: alarm.metric as Metric,
  statistic: alarm.statistic,
  period: alarm.period,
  comparison: alarm.comparison as Comparison,
  threshold: String(alarm.threshold),
  evaluationPeriods: String(alarm.evaluationPeriods),
  datapointsToAlarm: String(alarm.datapointsToAlarm),
  treatMissingData: alarm.treatMissingData as MissingData,
  email: alarm.actions.email,
  webhookUrls: alarm.actions.webhookUrls.join('\n'),
});

/** The metrics a scope offers: a function's calls, durations and instances; the account's too, and its money; a database's, a bucket's and a queue's their own. */
export const metricsFor = (functionId: string, databaseId = '', bucketName = '', queueName = ''): Metric[] =>
  queueName
    ? [...QUEUE_METRICS]
    : bucketName
      ? [...BUCKET_METRICS]
      : databaseId
        ? [...DATABASE_METRICS]
        : METRICS.filter(
            (metric) => !DATABASE_METRICS.includes(metric) && !BUCKET_METRICS.includes(metric) && !QUEUE_METRICS.includes(metric) && !(functionId && BILLING_METRICS.includes(metric)),
          );

/** The form once the metric changes: a statistic it has; for the money the account's, one datapoint; for a database's, an hour a period; for a bucket's or a queue's, it alone. */
export function withMetric(form: AlarmForm, metric: Metric): AlarmForm {
  const statistics = STATISTICS[metric] as readonly string[];
  const next = { ...form, metric, statistic: statistics.includes(form.statistic) ? form.statistic : statistics[0] };
  if (BILLING_METRICS.includes(metric)) return { ...next, functionId: '', databaseId: '', bucketName: '', queueName: '', evaluationPeriods: '1', datapointsToAlarm: '1' };
  if (BUCKET_METRICS.includes(metric)) return { ...next, functionId: '', databaseId: '', queueName: '' };
  if (QUEUE_METRICS.includes(metric)) return { ...next, functionId: '', databaseId: '', bucketName: '' };
  return DATABASE_METRICS.includes(metric) ? { ...next, functionId: '', bucketName: '', queueName: '', period: 3600 } : { ...next, bucketName: '', queueName: '' };
}

/**
 * The form once its scope changes: the account (''), a function (its ID), a database ('database:' and its ID), a bucket
 * ('bucket:' and its name) or a queue ('queue:' and its name), each with a metric it has.
 */
export function withScope(form: AlarmForm, scope: string): AlarmForm {
  const queueName = scope.startsWith('queue:') ? scope.slice('queue:'.length) : '';
  const bucketName = scope.startsWith('bucket:') ? scope.slice('bucket:'.length) : '';
  const databaseId = scope.startsWith('database:') ? scope.slice('database:'.length) : '';
  const functionId = databaseId || bucketName || queueName ? '' : scope;
  const metrics = metricsFor(functionId, databaseId, bucketName, queueName);
  const next = { ...form, functionId, databaseId, bucketName, queueName };
  const fallback: Metric = queueName ? 'ApproximateNumberOfMessagesVisible' : bucketName ? '5xxErrors' : databaseId ? 'VolumeBytesUsed' : 'Errors';
  return withMetric(next, metrics.includes(form.metric) ? form.metric : fallback);
}

/** The form's scope, as the scope select names it. */
export const scopeOf = (form: Pick<AlarmForm, 'functionId' | 'databaseId' | 'bucketName' | 'queueName'>): string =>
  form.queueName ? `queue:${form.queueName}` : form.bucketName ? `bucket:${form.bucketName}` : form.databaseId ? `database:${form.databaseId}` : form.functionId;

const webhookList = (text: string) => text.split('\n').map((url) => url.trim()).filter(Boolean);
const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text) : NaN);

/** Why the API would refuse the form, said before sending it; null when it would take it. */
export function formProblem(form: AlarmForm): string | null {
  if (!form.name.trim()) return 'Give the alarm a name';
  if (form.threshold.trim() === '' || !Number.isFinite(Number(form.threshold))) return 'The threshold must be a number';
  const n = wholeNumber(form.evaluationPeriods);
  const m = wholeNumber(form.datapointsToAlarm);
  if (!(n >= 1 && n <= MAX_EVALUATION_PERIODS)) return `The periods judged must be a whole number from 1 to ${MAX_EVALUATION_PERIODS}`;
  if (!(m >= 1 && m <= n)) return `The periods breaching must be a whole number from 1 to the ${n} judged`;
  if (BILLING_METRICS.includes(form.metric)) {
    if (form.functionId) return `${form.metric} is the account's: it watches no function`;
    if (n !== 1) return `${form.metric} is read as it is: one period`;
  } else if (DATABASE_METRICS.includes(form.metric)) {
    if (!form.databaseId) return `${form.metric} is a database's: choose the database it watches`;
    if (form.period !== 3600) return "A database's metrics have a point an hour: the period is an hour";
    if (n > 24) return 'The periods judged look back more than a day: take fewer';
  } else if (BUCKET_METRICS.includes(form.metric) && !form.bucketName) {
    return `${form.metric} is a bucket's: choose the bucket it watches`;
  } else if (QUEUE_METRICS.includes(form.metric) && !form.queueName) {
    return `${form.metric} is a queue's: choose the queue it watches`;
  } else if (form.period * n > 86_400) {
    return 'The periods judged look back more than a day: take fewer, or shorter ones';
  }
  const urls = webhookList(form.webhookUrls);
  if (urls.length > MAX_WEBHOOKS) return `An alarm tells at most ${MAX_WEBHOOKS} webhooks`;
  for (const url of urls) {
    const problem = testUrlProblem(url);
    if (problem) return `${url}: ${problem}`;
  }
  return null;
}

/** The form as the API takes it. */
export const toBody = (form: AlarmForm): AlarmBody => ({
  name: form.name.trim(),
  functionId: form.functionId || null,
  databaseId: form.databaseId || null,
  bucketName: form.bucketName || null,
  queueName: form.queueName || null,
  metric: form.metric,
  statistic: form.statistic,
  period: form.period,
  comparison: form.comparison,
  threshold: Number(form.threshold),
  evaluationPeriods: wholeNumber(form.evaluationPeriods),
  datapointsToAlarm: wholeNumber(form.datapointsToAlarm),
  treatMissingData: form.treatMissingData,
  actions: { email: form.email, webhookUrls: webhookList(form.webhookUrls) },
});

const periodLabel = (seconds: number) => PERIODS.find((p) => p.value === seconds)?.label ?? `${seconds} s`;

/** An alarm's condition, as a person reads it: "Errors Sum > 0 calls, in 1 of the last 1 periods of 1 minute". */
export function conditionText(alarm: Pick<AlarmBody, 'metric' | 'statistic' | 'comparison' | 'threshold' | 'period' | 'evaluationPeriods' | 'datapointsToAlarm'>): string {
  const metric = alarm.metric as Metric;
  const symbol = COMPARISONS.find((c) => c.value === alarm.comparison)?.symbol ?? alarm.comparison;
  const threshold = `${alarm.threshold} ${UNITS[metric] ?? ''}`.trim();
  if (BILLING_METRICS.includes(metric)) return `${metric} ${symbol} ${threshold}, as it is`;
  const periods = alarm.evaluationPeriods === 1 ? `the last period of ${periodLabel(alarm.period)}` : `${alarm.datapointsToAlarm} of the last ${alarm.evaluationPeriods} periods of ${periodLabel(alarm.period)}`;
  return `${metric} ${alarm.statistic} ${symbol} ${threshold}, in ${periods}`;
}

/** A state as the page shows it: a word, beside its badge's tone. */
export const STATE_INFO: Record<AlarmState, { label: string; tone: 'ok' | 'alarm' | 'unknown' }> = {
  OK: { label: 'OK', tone: 'ok' },
  ALARM: { label: 'In alarm', tone: 'alarm' },
  INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'unknown' },
};

/** How many alarms are in alarm: the sidebar's count beside Alarms, the one thing it shows in orange. */
export const firingCount = (alarms: ReadonlyArray<Pick<Alarm, 'state'>>): number => alarms.filter((alarm) => alarm.state === 'ALARM').length;
