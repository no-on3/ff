/**
 * Plans and their limits (D5), as the admin routes give them (P-71, P-73).
 * contract.test.ts checks the limits against the backend's planLimitsSchema.
 */
export interface PlanLimits {
  functions: number;
  memoryMb: number;
  timeoutSeconds: number;
  instancesPerFunction: number;
  quota: { pods: number; cpu: string; memory: string };
  writesPerMinute: number;
  invokesPerSecond: number;
  logRetentionDays: number;
  historyRetentionDays: number;
  idleSeconds: number;
  internetEgress: boolean;
}

export interface Plan {
  id: string;
  name: string;
  limits: PlanLimits;
}

type Kind = 'whole' | 'quantity' | 'boolean';

/** Each limit, in the order the page shows them; quota's three are one limit of D5. */
export const LIMIT_FIELDS: Array<{ path: [keyof PlanLimits] | ['quota', keyof PlanLimits['quota']]; label: string; unit?: string; kind: Kind }> = [
  { path: ['functions'], label: 'Functions per account', kind: 'whole' },
  { path: ['memoryMb'], label: 'Memory per function', unit: 'MB, 128 to 10,240', kind: 'whole' },
  { path: ['timeoutSeconds'], label: 'Timeout per function', unit: 's, 1 to 900', kind: 'whole' },
  { path: ['instancesPerFunction'], label: 'Instances per function', unit: '1 to 100', kind: 'whole' },
  { path: ['quota', 'pods'], label: 'Quota: instances', unit: 'all functions together', kind: 'whole' },
  { path: ['quota', 'cpu'], label: 'Quota: CPU', unit: 'such as 8 or 500m', kind: 'quantity' },
  { path: ['quota', 'memory'], label: 'Quota: memory', unit: 'such as 8Gi', kind: 'quantity' },
  { path: ['writesPerMinute'], label: 'Changes per minute', kind: 'whole' },
  { path: ['invokesPerSecond'], label: 'Invocations per second', unit: 'all functions together', kind: 'whole' },
  { path: ['logRetentionDays'], label: 'Log retention', unit: 'days', kind: 'whole' },
  { path: ['historyRetentionDays'], label: 'History retention', unit: 'days', kind: 'whole' },
  { path: ['idleSeconds'], label: 'Idle time before scale to zero', unit: 's', kind: 'whole' },
  { path: ['internetEgress'], label: 'Internet egress, by default', kind: 'boolean' },
];

const QUANTITY = /^\d+(\.\d+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;
const fieldName = (path: string[]) => path.join('.');

/** The limits as the form's text, one entry per field. */
export function formOfLimits(limits: PlanLimits): Record<string, string> {
  return Object.fromEntries(
    LIMIT_FIELDS.map(({ path }) => [fieldName(path), String(path.length === 2 ? limits.quota[path[1]] : limits[path[0]])]),
  );
}

/** The limits a form gives, or each field that isn't one, named. The API checks the bounds again. */
export function limitsOfForm(form: Record<string, string>): { limits: PlanLimits } | { problems: string[] } {
  const problems: string[] = [];
  const values: Record<string, unknown> = {};
  for (const { path, label, kind } of LIMIT_FIELDS) {
    const text = (form[fieldName(path)] ?? '').trim();
    let value: unknown;
    if (kind === 'boolean') value = text === 'true';
    else if (kind === 'quantity') {
      if (!QUANTITY.test(text)) problems.push(`${label}: must be a Kubernetes quantity, such as 8, 500m or 8Gi`);
      value = text;
    } else {
      if (!/^\d+$/.test(text) || Number(text) < 1) problems.push(`${label}: must be a whole number, 1 or more`);
      value = Number(text);
    }
    values[fieldName(path)] = value;
  }
  if (problems.length) return { problems };
  const limits = Object.fromEntries(LIMIT_FIELDS.filter(({ path }) => path.length === 1).map(({ path }) => [path[0], values[path[0]]])) as unknown as PlanLimits;
  limits.quota = { pods: values['quota.pods'] as number, cpu: values['quota.cpu'] as string, memory: values['quota.memory'] as string };
  return { limits };
}

const shown = (value: unknown) => (typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));

/** What changes, limit by limit, from → to, as the reason dialog lists them. */
export function limitChanges(before: PlanLimits, after: PlanLimits): string[] {
  return LIMIT_FIELDS.flatMap(({ path, label }) => {
    const from = path.length === 2 ? before.quota[path[1]] : before[path[0]];
    const to = path.length === 2 ? after.quota[path[1]] : after[path[0]];
    return from === to ? [] : [`${label}: ${shown(from)} → ${shown(to)}`];
  });
}

/** A limit to read, as the plan's table shows it. */
export function limitLabel(path: string): string {
  return LIMIT_FIELDS.find((field) => fieldName(field.path) === path)?.label ?? path;
}

/** A plan's quota to read: "20 instances, 8 CPU, 8Gi". */
export const quotaLabel = (quota: PlanLimits['quota']): string => `${quota.pods} instances, ${quota.cpu} CPU, ${quota.memory}`;
