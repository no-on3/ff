import type { Function, FunctionStatus, Runtime } from '../services/api';

/** A runtime, as the list says it: no version, which the API doesn't give. */
export const RUNTIME_LABELS: Record<Runtime, string> = { nodejs: 'Node.js', python: 'Python' };

/** A function's status as a word, beside its pill's tone: ready, being made, or failed. */
export const STATUS_INFO: Record<FunctionStatus, { label: string; tone: 'ok' | 'busy' | 'failed' }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  CREATING: { label: 'Creating', tone: 'busy' },
  ERROR: { label: 'Error', tone: 'failed' },
  DELETED: { label: 'Deleted', tone: 'failed' },
};

export interface FunctionFilter {
  /** Part of the name, in any case. */
  query: string;
  runtime: Runtime | 'all';
  status: FunctionStatus | 'all';
}

export const NO_FILTER: FunctionFilter = { query: '', runtime: 'all', status: 'all' };

/** The functions the list shows: whose name holds the query, of the runtime and in the status chosen, in the API's order. */
export function filterFunctions<F extends Pick<Function, 'name' | 'runtime' | 'status'>>(functions: readonly F[], filter: FunctionFilter): F[] {
  const query = filter.query.trim().toLowerCase();
  return functions.filter(
    (fn) =>
      (query === '' || fn.name.toLowerCase().includes(query)) &&
      (filter.runtime === 'all' || fn.runtime === filter.runtime) &&
      (filter.status === 'all' || fn.status === filter.status),
  );
}

/** How many the list shows, said above it: "6 functions", or "2 of 6 functions" once filtered. */
export function countText(shown: number, total: number): string {
  const noun = total === 1 ? 'function' : 'functions';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

/**
 * When something happened, as a list says it: "just now", "5 min ago", "3 h ago", "2 days ago"; after a week, the
 * date, "22 Oct 2026", in the browser's time zone.
 */
export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A series as a sparkline's points, `x,y` pairs from left to right in a box of `width` by `height`: the values are
 * summed into `buckets` slots first, so that a day of five-minute points draws as a calm line; the highest touches
 * the top, zero the bottom.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number, buckets = 48): string {
  if (values.length === 0) return '';
  const size = Math.max(1, Math.ceil(values.length / buckets));
  const sums: number[] = [];
  for (let i = 0; i < values.length; i += size) sums.push(values.slice(i, i + size).reduce((a, b) => a + b, 0));
  const top = Math.max(...sums) || 1;
  const step = sums.length > 1 ? width / (sums.length - 1) : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return sums.map((sum, i) => `${round(i * step)},${round(height - (sum / top) * height)}`).join(' ');
}
