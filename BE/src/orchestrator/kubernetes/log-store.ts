/**
 * The log store (client-readiness plan P-42 and P-43, ADR 0005): VictoriaLogs in
 * ff-system, which the collector fills and only the backend queries. Its queries
 * are LogsQL, built here: every value a caller gives goes in as a quoted string,
 * so none can change what a query does (D10).
 */
import * as http from 'node:http';
import { describeError } from '../../common/describe-error';
import { InvalidLogCursorError, LogStoreUnavailableError } from '../orchestrator.errors';
import type { FunctionLogLine, FunctionLogsPage, LogsQuery } from '../orchestrator.types';
import { KubeApi, paths } from './kube-client';
import type { InvokeMode } from './kubernetes.settings';

/** Where the store is (deploy/k8s/logging): its Service. The admission policy names it too, for the development proxy. */
export const LOG_STORE = { namespace: 'ff-system', service: 'victoria-logs', port: 9428 } as const;
const QUERY_PATH = '/select/logsql/query';
const QUERY_TIMEOUT_MS = 15_000;
/** The most a direct answer may hold: a page is 1,001 lines of at most 16 KiB and their fields. */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const STREAMS = new Set(['stdout', 'stderr', 'ff']);
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;

/** A row of the store's answer, with the fields the queries ask for. */
export interface StoredLine {
  _time: string;
  _msg?: string;
  pod?: string;
  stream?: string;
  request_id?: string;
}

/** Where a page ended: at this line's time, the `skip` lines at it being given already. */
interface Cursor {
  before: string;
  skip: number;
}

/** A LogsQL string. JSON's escapes are Go's, which LogsQL reads, so no value can end the string early. */
export function quoted(value: string): string {
  return JSON.stringify(value);
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ b: cursor.before, s: cursor.skip })).toString('base64url');
}

/** A cursor's contents, checked: its time goes into a query unquoted. */
export function decodeCursor(text: string): Cursor {
  try {
    const { b, s } = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as { b?: unknown; s?: unknown };
    if (typeof b === 'string' && RFC3339_UTC.test(b) && typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 1_000_000) {
      return { before: b, skip: s };
    }
  } catch {
    // not JSON: the same answer
  }
  throw new InvalidLogCursorError();
}

/**
 * A page's query: the function's lines in the window, or in its part before
 * the cursor, the newest first, and one more than the page, which says whether
 * there are older ones. Lines of the same time are ordered by pod and message,
 * so that a cursor's skip means the same lines on every read.
 */
export function pageQuery(namespace: string, functionId: string, query: LogsQuery): string {
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const filters = [
    `{namespace=${quoted(namespace)}, function_id=${quoted(functionId)}}`,
    cursor ? `_time:[${query.start.toISOString()}, ${cursor.before}]` : `_time:[${query.start.toISOString()}, ${query.end.toISOString()})`,
  ];
  if (query.requestId !== undefined) filters.push(`request_id:=${quoted(query.requestId)}`);
  if (query.q !== undefined) filters.push(`_msg:${quoted(query.q)}`);
  const offset = cursor && cursor.skip > 0 ? ` offset ${cursor.skip}` : '';
  return (
    `${filters.join(' ')} | sort by (_time desc, pod desc, _msg desc)${offset} limit ${query.limit + 1}` +
    ' | fields _time, _msg, pod, stream, request_id'
  );
}

/** A page from the newest-first rows: `limit` of them, oldest first, and the cursor to the older ones. */
export function toPage(rows: StoredLine[], limit: number, cursor?: string): FunctionLogsPage {
  const page = rows.slice(0, limit);
  let next: string | null = null;
  if (rows.length > limit && page.length > 0) {
    const oldest = page[page.length - 1]._time;
    const given = page.filter((row) => row._time === oldest).length;
    const before = cursor === undefined ? undefined : decodeCursor(cursor);
    next = encodeCursor({ before: oldest, skip: given + (before?.before === oldest ? before.skip : 0) });
  }
  return { lines: page.reverse().map(toLine), next };
}

function toLine(row: StoredLine): FunctionLogLine {
  return {
    time: nineDecimals(row._time),
    instance: row.pod ?? null,
    requestId: row.request_id ?? null,
    stream: row.stream !== undefined && STREAMS.has(row.stream) ? (row.stream as FunctionLogLine['stream']) : null,
    message: row._msg ?? '',
  };
}

/** RFC 3339 with all nine decimals, as P-40's lines had them: times then sort as text. */
export function nineDecimals(time: string): string {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(time);
  return match ? `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z` : time;
}

/**
 * The store's HTTP API. A backend outside the cluster (development) reaches it
 * through the API server's Service proxy, as it calls functions; inside the
 * cluster it calls the Service, which its NetworkPolicy admits for the backend.
 */
export class LogStore {
  constructor(
    private readonly mode: InvokeMode,
    private readonly api: KubeApi,
    /** Where a direct call goes: the Service's address, unless a test says otherwise. */
    private readonly directUrl = `http://${LOG_STORE.service}.${LOG_STORE.namespace}.svc:${LOG_STORE.port}`,
  ) {}

  async query(logsql: string): Promise<StoredLine[]> {
    const path = `${QUERY_PATH}?${new URLSearchParams({ query: logsql }).toString()}`;
    let answer: { status: number; body: string };
    try {
      answer =
        this.mode === 'proxy'
          ? await this.api.request('GET', paths.serviceProxy(LOG_STORE.namespace, LOG_STORE.service, String(LOG_STORE.port), path), {
              timeoutMs: QUERY_TIMEOUT_MS,
            })
          : await getText(`${this.directUrl}${path}`, QUERY_TIMEOUT_MS);
    } catch (error) {
      throw new LogStoreUnavailableError(`The log store did not answer: ${describeError(error)}`);
    }
    if (answer.status !== 200) throw new LogStoreUnavailableError(`The log store answered ${answer.status}: ${answer.body.slice(0, 300)}`);
    try {
      return answer.body
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StoredLine);
    } catch (error) {
      throw new LogStoreUnavailableError(`The log store's answer is not JSON lines: ${describeError(error)}`);
    }
  }
}

function getText(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) req.destroy(new Error(`answer larger than ${MAX_ANSWER_BYTES} bytes`));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}
