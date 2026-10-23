import type { PillTone } from '../components/StatusPill';
import type { Database, DatabaseMetrics, DatabaseStatus } from '../services/api';

/** A database's name, as the API takes it: AWS RDS's rule for its instances. contract.test.ts checks it against the API's. */
export const DATABASE_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,62}$/;

/** Why the API would refuse the name, said before sending it; null when it would take it. */
export function databaseNameProblem(name: string): string | null {
  if (name === '') return 'Give the database a name';
  if (DATABASE_NAME.test(name) && !name.endsWith('-')) return null;
  return '1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases';
}

/** Each status in a word, its tone, and what it means. */
export const STATUS_INFO: Record<DatabaseStatus, { label: string; tone: PillTone; title: string }> = {
  creating: { label: 'Creating', tone: 'busy', title: 'Being made on the server' },
  active: { label: 'Available', tone: 'ok', title: 'Its sessions read and write' },
  read_only: { label: 'Read-only', tone: 'warn', title: "Past its plan's storage: its new sessions start read-only until it is back under" },
  suspended: { label: 'Suspended', tone: 'idle', title: "Its user can't log in: the account is suspended, or FF turned its databases off" },
  deleting: { label: 'Deleting', tone: 'busy', title: 'Being dropped, with its data' },
};

const MB = 1_048_576;

/** A size in MB of 1,048,576 bytes, or in GB from 1,024 MB on, to a tenth: "7.3 MB", "1.5 GB"; "–" when unknown. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '–';
  const mb = bytes / MB;
  const [value, unit] = mb >= 1024 ? [mb / 1024, 'GB'] : [mb, 'MB'];
  return `${(Math.round(value * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${unit}`;
}

/** How much of the plan's storage it uses, in whole percent; null when its size is unknown. */
export function storageShare(database: Pick<Database, 'sizeBytes' | 'storageLimitMb'>): number | null {
  if (database.sizeBytes === null) return null;
  return Math.round((database.sizeBytes / (database.storageLimitMb * MB)) * 100);
}

/** The secret a function reads the connection string from, as apps written for AWS often do. */
export const DEFAULT_SECRET = 'DATABASE_URL';

/** psql, with the connection string. */
export const psqlCommand = (connectionString: string): string => `psql "${connectionString}"`;

/** The hours measured in a database's metrics, newest first, those without a measure left out. */
export function measuredHours(metrics: DatabaseMetrics, count = 24): Array<{ at: string; connections: number; sizeBytes: number }> {
  const hours: Array<{ at: string; connections: number; sizeBytes: number }> = [];
  for (let index = metrics.timestamps.length - 1; index >= 0 && hours.length < count; index--) {
    const connections = metrics.metrics.DatabaseConnections.Maximum[index];
    const sizeBytes = metrics.metrics.VolumeBytesUsed.Maximum[index];
    if (connections !== null && sizeBytes !== null) hours.push({ at: metrics.timestamps[index], connections, sizeBytes });
  }
  return hours;
}
