import type { ApiKey, Scope } from '../services/api';

/** What each scope lets a key do, as the API's routes require them. */
export const SCOPE_INFO: Record<Scope, string> = {
  'functions:read': 'List and read functions, their invocations and scaling',
  'functions:write': 'Create, update and delete functions',
  'functions:invoke': 'Invoke functions',
  'logs:read': "Read functions' logs, live too",
  'metrics:read': 'Read metrics',
  'alarms:read': 'List and read alarms, with their state',
  'alarms:write': 'Create, change and delete alarms',
  'usage:read': 'Read usage, the balance, pro-formas and invoices',
  'databases:read': "List and read databases, with their size and sessions",
  'databases:write': 'Create and delete databases, and give them new passwords',
  'storage:read': "List and read buckets, and the account's access keys to them",
  'storage:write': "Create and delete buckets, and make and revoke the account's access keys to them",
  'queues:read': 'List and read queues, with their attributes and messages counted',
  'queues:write': 'Create, change, purge and delete queues, and send and receive their messages',
};

export type KeyState = 'active' | 'revoked' | 'expired';

/** Whether a key still works: the API stops it once revoked, or from its expiry on. */
export function keyState(key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now: Date): KeyState {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** The expiry choices the form offers; null never expires. */
export const EXPIRY_CHOICES: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'Never', days: null },
  { label: 'In 7 days', days: 7 },
  { label: 'In 30 days', days: 30 },
  { label: 'In 90 days', days: 90 },
  { label: 'In a year', days: 365 },
];

/** POST /api-keys's expiresAt for a choice: `days` from now, or none. */
export function expiresAtFor(days: number | null, now: Date): string | undefined {
  return days === null ? undefined : new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** How a key is shown once its secret is gone: its prefix, which the API logs and lists. */
export function keyPrefix(id: string): string {
  return `ffk_${id}_…`;
}
