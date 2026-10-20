import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The operator's metrics, in Prometheus's text format on an internal port
 * (MonitoringService), never through the API: customers never see them. One
 * registry for the process; the services count into it as things happen, and
 * the gauges read the database at each scrape.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'ff_backend_' });

/** Every invocation that ended, by its usage record's status: success, error, timeout, throttled, platform_error or lost. */
export const invocations = new Counter({ name: 'ff_invocations_total', help: 'Invocations ended, by outcome', labelNames: ['outcome'], registers: [registry] });

/** Invocations refused before they reached a function: the account's rate limit, or its credit. */
export const refusals = new Counter({ name: 'ff_invocations_refused_total', help: 'Invocations refused before running, by reason', labelNames: ['reason'], registers: [registry] });

/** How long the function ran, as the runtime measured it. */
export const invocationSeconds = new Histogram({
  name: 'ff_invocation_duration_seconds',
  help: 'Invocation duration, as the runtime measured it',
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [registry],
});

/** How long a call waited for an instance to load the code. */
export const coldStartSeconds = new Histogram({
  name: 'ff_cold_start_seconds',
  help: "Cold starts: the time to load the function's code",
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
  registers: [registry],
});

/** Each attempt to deliver a notification: delivered, to be retried, or failed for good. */
export const notificationAttempts = new Counter({
  name: 'ff_notification_attempts_total',
  help: 'Notification delivery attempts, by channel and result',
  labelNames: ['channel', 'result'],
  registers: [registry],
});

/** Each alarm evaluated, and each change of state. */
export const alarmEvaluations = new Counter({ name: 'ff_alarm_evaluations_total', help: 'Alarms evaluated', registers: [registry] });
export const alarmChanges = new Counter({ name: 'ff_alarm_state_changes_total', help: 'Alarm state changes, by the state entered', labelNames: ['state'], registers: [registry] });

/** The API's answers, by status class: 2xx, 3xx, 4xx, 5xx. */
export const httpResponses = new Counter({ name: 'ff_http_responses_total', help: "The API's answers, by status class", labelNames: ['class'], registers: [registry] });

/** Read at each scrape (MonitoringService sets how). */
export const ratingLagSeconds = new Gauge({
  name: 'ff_rating_lag_seconds',
  help: 'Seconds since the end of the last hour rated (before the first, since the first price book began)',
  registers: [registry],
});
export const alarmLagSeconds = new Gauge({ name: 'ff_alarm_evaluator_lag_seconds', help: 'Seconds since the alarm judged longest ago was judged', registers: [registry] });
export const deliveriesPending = new Gauge({ name: 'ff_notification_deliveries_pending', help: 'Notification deliveries waiting to be sent', registers: [registry] });
export const reconciliationMismatches = new Gauge({
  name: 'ff_reconciliation_mismatches',
  help: "Accounts whose month's charges don't match their usage (computed at most once an hour)",
  registers: [registry],
});

/**
 * The database's size, and the disk it is on as the deployment says (0 when it doesn't): the database
 * server is outside the cluster, so nothing else there sees its disk.
 */
export const databaseSizeBytes = new Gauge({ name: 'ff_database_size_bytes', help: "The database's size on disk", registers: [registry] });
export const databaseDiskBytes = new Gauge({
  name: 'ff_database_disk_bytes',
  help: "The database server's disk, as FF_DATABASE_DISK_BYTES says; 0 when it isn't set",
  registers: [registry],
});

/** The status class of an HTTP status: "2xx". */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;
