import type { Plan, PlanLimits } from '../services/api';

/** Every limit a plan has, as the API's plan-limits.ts names them: src/contract.test.ts checks that they agree. */
export const PLAN_LIMIT_KEYS = [
  'functions',
  'memoryMb',
  'timeoutSeconds',
  'instancesPerFunction',
  'quota',
  'writesPerMinute',
  'invokesPerSecond',
  'logRetentionDays',
  'historyRetentionDays',
  'idleSeconds',
  'internetEgress',
  'customDomains',
  'schedules',
  'databases',
  'databaseStorageMb',
  'databaseConnections',
  'buckets',
  'bucketStorageMb',
  'storageRequestsPerSecond',
  'maxObjectMb',
  'queues',
  'eventSourceMappingsPerFunction',
  'queueRequestsPerSecond',
  'queueStorageMb',
] as const satisfies ReadonlyArray<keyof PlanLimits>;

// A limit missing from the list above stops the build.
type Unlisted = Exclude<keyof PlanLimits, (typeof PLAN_LIMIT_KEYS)[number]>;
const everyLimitListed: [Unlisted] extends [never] ? true : never = true;
void everyLimitListed;

/** "15 minutes", "1 minute", "90 s". */
export function formatSeconds(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} s`;
  const minutes = seconds / 60;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** "1 GB", "512 MB", "1.5 GB": a size in MB as the plans give it. */
export function formatMegabytes(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** What the account page shows of a plan: each limit as a label and a value. */
export function planLimitRows({ limits }: Pick<Plan, 'limits'>): Array<[label: string, value: string]> {
  return [
    ['Functions', String(limits.functions)],
    ['Memory per function', `up to ${limits.memoryMb} MB`],
    ['Timeout per function', `up to ${limits.timeoutSeconds} s`],
    ['Instances per function', `up to ${limits.instancesPerFunction}`],
    ['All functions together', `${limits.quota.pods} instances, ${limits.quota.cpu} CPU, ${limits.quota.memory} of memory`],
    ['Changes', `${limits.writesPerMinute} per minute`],
    ['Invocations', `${limits.invokesPerSecond} per second`],
    ['Scale to zero after', `${formatSeconds(limits.idleSeconds)} without a call`],
    ['Invocation history kept', `${limits.historyRetentionDays} days`],
    ['Logs kept', `${limits.logRetentionDays} days`],
    // The plan's value is where a new account starts; FF turns it on or off for each account.
    ['Internet access for functions', limits.internetEgress ? 'Yes, unless turned off for the account' : 'No, unless turned on for the account'],
    ["Your own domains for functions' URLs", String(limits.customDomains)],
    ['Schedules', String(limits.schedules)],
    ['Databases', String(limits.databases)],
    ['Storage per database', `${formatMegabytes(limits.databaseStorageMb)}, then its new sessions are read-only`],
    ['Sessions per database', `up to ${limits.databaseConnections} at once`],
    ['Buckets', String(limits.buckets)],
    ['Storage of the buckets', `${formatMegabytes(limits.bucketStorageMb)} together`],
    ['Requests to the buckets', `${limits.storageRequestsPerSecond} per second`],
    ['Largest file in one upload', `${formatMegabytes(limits.maxObjectMb)}; more in parts`],
    ['Queues', String(limits.queues)],
    ['Queues one function reads', String(limits.eventSourceMappingsPerFunction)],
    ['Requests to the queues', `${limits.queueRequestsPerSecond} per second`],
    ['Messages waiting', `${formatMegabytes(limits.queueStorageMb)} together, asynchronous calls included`],
  ];
}
