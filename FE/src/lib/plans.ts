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
  ];
}
