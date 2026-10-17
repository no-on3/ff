import { apiErrorMessage } from './functions';
import type { FunctionLogLine, LogsQuery } from '../services/api';

/** The time ranges the logs tab offers; `all` is whatever the plan keeps (P-43). */
export const TIME_RANGES = [
  { key: '15m', label: 'Last 15 minutes', seconds: 900 },
  { key: '1h', label: 'Last hour', seconds: 3_600 },
  { key: '24h', label: 'Last 24 hours', seconds: 86_400 },
  { key: '7d', label: 'Last 7 days', seconds: 604_800 },
  { key: 'all', label: 'All that is kept', seconds: undefined },
] as const;
export type TimeRange = (typeof TIME_RANGES)[number]['key'];
const DEFAULT_RANGE: TimeRange = '1h';

/** A page's size: what the API gives by default. */
export const PAGE_LINES = 200;
/** The most lines the tab holds while the live tail adds to them: the oldest go first. */
export const MAX_LINES = 5_000;

/** What the logs tab shows: a time range, a phrase, a call. It lives in the page's address, so that a link opens it. */
export interface LogsFilter {
  range: TimeRange;
  q: string;
  requestId: string;
}

export function filterFromSearch(search: URLSearchParams): LogsFilter {
  const range = search.get('range');
  return {
    range: TIME_RANGES.some((r) => r.key === range) ? (range as TimeRange) : DEFAULT_RANGE,
    q: search.get('q') ?? '',
    requestId: search.get('requestId') ?? '',
  };
}

/** The filter in the address, with `tab=logs`; what is at its default is left out. */
export function searchForFilter(filter: LogsFilter): URLSearchParams {
  const search = new URLSearchParams({ tab: 'logs' });
  if (filter.range !== DEFAULT_RANGE) search.set('range', filter.range);
  if (filter.q.trim()) search.set('q', filter.q.trim());
  if (filter.requestId) search.set('requestId', filter.requestId);
  return search;
}

/** GET /functions/:id/logs's parameters for a page of the filter; `cursor` for the older lines. */
export function pageQuery(filter: LogsFilter, cursor?: string): LogsQuery {
  const query: LogsQuery = { limit: PAGE_LINES };
  const seconds = TIME_RANGES.find((r) => r.key === filter.range)?.seconds;
  if (seconds !== undefined) query.sinceSeconds = seconds;
  if (filter.q.trim()) query.q = filter.q.trim();
  if (filter.requestId) query.requestId = filter.requestId;
  if (cursor) query.cursor = cursor;
  return query;
}

/** An event of a Server-Sent Events stream: its type (`message` when none was given) and its data. */
export interface ServerEvent {
  type: string;
  data: string;
}

/**
 * Reads a Server-Sent Events stream as it comes, in chunks cut anywhere: each
 * blank line ends an event; `data:` lines join with new lines; a comment, a line
 * starting with ':', is skipped, as are fields other than event and data.
 */
export class EventStreamParser {
  private buffer = '';
  private type = '';
  private data: string[] = [];

  push(chunk: string): ServerEvent[] {
    this.buffer += chunk;
    const events: ServerEvent[] = [];
    for (let end = this.buffer.search(/\r?\n/); end >= 0; end = this.buffer.search(/\r?\n/)) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer[end] === '\r' ? 2 : 1));
      if (line === '') {
        if (this.data.length > 0) events.push({ type: this.type || 'message', data: this.data.join('\n') });
        this.type = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') this.type = value;
      else if (field === 'data') this.data.push(value);
    }
    return events;
  }
}

const key = (line: FunctionLogLine) => `${line.time} ${line.instance ?? ''} ${line.stream ?? ''} ${line.message}`;

/**
 * The lines the tab holds once `incoming` comes: those not there already, after
 * them, and the newest `max` of all. The live tail starts a few seconds back, so
 * its first lines can be the page's last ones.
 */
export function mergeLines(existing: FunctionLogLine[], incoming: FunctionLogLine[], max = MAX_LINES): FunctionLogLine[] {
  const seen = new Set(existing.slice(-PAGE_LINES * 2).map(key));
  const added = incoming.filter((line) => {
    const k = key(line);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const all = added.length > 0 ? [...existing, ...added] : existing;
  return all.length > max ? all.slice(all.length - max) : all;
}

/** A line's time in the browser's own zone, to the millisecond, with its day when it isn't today. */
export function lineTime(time: string, now = new Date()): string {
  const at = new Date(time); // RFC 3339; Date keeps the milliseconds
  const clock = at.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(at.getMilliseconds()).padStart(3, '0');
  return at.toDateString() === now.toDateString() ? clock : `${at.toLocaleDateString()} ${clock}`;
}

/** An error of the logs routes, worded for the tab: 503 is the log store being away for a moment. */
export function logsErrorMessage(error: unknown): string {
  const status = (error as { response?: { status?: unknown }; status?: unknown } | null)?.response?.status ?? (error as { status?: unknown } | null)?.status;
  if (status === 503) return 'Logs are unavailable right now. Try again in a minute.';
  return apiErrorMessage(error);
}
