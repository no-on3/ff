/**
 * The log store (client-readiness plan P-42 and P-43, ADR 0005): VictoriaLogs in
 * ff-system, which the collector fills and only the backend queries. Its queries
 * are LogsQL, built here: every value a caller gives goes in as a quoted string,
 * so none can change what a query does (D10).
 */
import * as http from 'node:http';
import type { Readable } from 'node:stream';
import { describeError } from '../../common/describe-error';
import { InvalidLogCursorError, LogStoreUnavailableError } from '../orchestrator.errors';
import type { FunctionLogLine, FunctionLogsPage, LogsFilter, LogsQuery } from '../orchestrator.types';
import { KubeApi, paths } from './kube-client';
import type { InvokeMode } from './kubernetes.settings';

/** Where the store is (deploy/k8s/logging): its Service. The admission policy names it too, for the development proxy. */
export const LOG_STORE = { namespace: 'ff-system', service: 'victoria-logs', port: 9428 } as const;
const QUERY_PATH = '/select/logsql/query';
const TAIL_PATH = '/select/logsql/tail';
const DELETE_PATH = '/delete/run_task';
const DELETIONS_PATH = '/delete/active_tasks';
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

/** A deletion task the store is still running (P-45), as /delete/active_tasks lists it. */
export interface DeletionTask {
  task_id: string;
  filter?: string;
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

/** The function's lines, in its account's namespace, narrowed to a call and a phrase when asked. */
function filters(namespace: string, functionId: string, filter: LogsFilter): string[] {
  const parts = [`{namespace=${quoted(namespace)}, function_id=${quoted(functionId)}}`];
  if (filter.requestId !== undefined) parts.push(`request_id:=${quoted(filter.requestId)}`);
  if (filter.q !== undefined) parts.push(`_msg:${quoted(filter.q)}`);
  return parts;
}

const FIELDS = ' | fields _time, _msg, pod, stream, request_id';

/** Every line of an account's namespace: what closing the account deletes (P-45). */
export function namespaceFilter(namespace: string): string {
  return `{namespace=${quoted(namespace)}}`;
}

/**
 * A page's query: the function's lines in the window, or in its part before
 * the cursor, the newest first, and one more than the page, which says whether
 * there are older ones. Lines of the same time are ordered by pod and message,
 * so that a cursor's skip means the same lines on every read.
 */
export function pageQuery(namespace: string, functionId: string, query: LogsQuery): string {
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const [stream, ...narrowing] = filters(namespace, functionId, query);
  const window = cursor ? `_time:[${query.start.toISOString()}, ${cursor.before}]` : `_time:[${query.start.toISOString()}, ${query.end.toISOString()})`;
  const offset = cursor && cursor.skip > 0 ? ` offset ${cursor.skip}` : '';
  return `${[stream, window, ...narrowing].join(' ')} | sort by (_time desc, pod desc, _msg desc)${offset} limit ${query.limit + 1}${FIELDS}`;
}

/** A live tail's query: the same lines as they come. The store refuses pipes such as sort in a tail. */
export function tailQuery(namespace: string, functionId: string, filter: LogsFilter): string {
  return `${filters(namespace, functionId, filter).join(' ')}${FIELDS}`;
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

export function toLine(row: StoredLine): FunctionLogLine {
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

  /**
   * Starts deleting the lines `filter` (LogsQL) matches (P-45): the store's
   * own task, which answers at once with its ID. The key goes in a form body,
   * so that it is in no URL, which the API server's proxy and any request log
   * would see; the store's refusals don't repeat it.
   */
  async startDeletion(filter: string, key: string): Promise<string> {
    const answer = parsed(await this.post(DELETE_PATH, { filter, authKey: key })) as { task_id?: unknown } | null;
    if (typeof answer?.task_id !== 'string' || !answer.task_id) throw new LogStoreUnavailableError("The log store's answer has no task ID");
    return answer.task_id;
  }

  /** The deletion tasks the store is still running. */
  async activeDeletions(key: string): Promise<DeletionTask[]> {
    const tasks = parsed(await this.post(DELETIONS_PATH, { authKey: key }));
    if (!Array.isArray(tasks) || !tasks.every((task) => typeof (task as DeletionTask | null)?.task_id === 'string')) {
      throw new LogStoreUnavailableError("The log store's list of deletion tasks is not one");
    }
    return tasks as DeletionTask[];
  }

  /** A POST of a form to the store; its answer's text, or LogStoreUnavailableError. */
  private async post(path: string, form: Record<string, string>): Promise<string> {
    const body = new URLSearchParams(form).toString();
    let answer: { status: number; body: string };
    try {
      answer =
        this.mode === 'proxy'
          ? await this.api.request('POST', paths.serviceProxy(LOG_STORE.namespace, LOG_STORE.service, String(LOG_STORE.port), path), {
              body,
              contentType: FORM,
              timeoutMs: QUERY_TIMEOUT_MS,
            })
          : await postText(`${this.directUrl}${path}`, body, QUERY_TIMEOUT_MS);
    } catch (error) {
      throw new LogStoreUnavailableError(`The log store did not answer: ${describeError(error)}`);
    }
    if (answer.status !== 200) throw new LogStoreUnavailableError(`The log store answered ${answer.status}: ${answer.body.slice(0, 300)}`);
    return answer.body;
  }

  /**
   * A live tail: the rows of `logsql` as the store gets them, for as long as
   * `signal` lets it run. The store holds each line back 5 s, by its own time,
   * for those that reach it late. The request goes out on the first read, and
   * nothing waits for the store's answer before that: through the API server's
   * proxy, the answer's headers come only with its first row. A store that
   * can't start the tail makes the reading fail, with LogStoreUnavailableError.
   */
  tail(logsql: string, signal: AbortSignal): AsyncIterable<StoredLine> {
    const path = `${TAIL_PATH}?${new URLSearchParams({ query: logsql }).toString()}`;
    const open = async (): Promise<Readable> => {
      let answer: { status: number; body: Readable };
      try {
        answer =
          this.mode === 'proxy'
            ? await this.api.stream(paths.serviceProxy(LOG_STORE.namespace, LOG_STORE.service, String(LOG_STORE.port), path), signal)
            : await streamGet(`${this.directUrl}${path}`, signal);
      } catch (error) {
        throw new LogStoreUnavailableError(`The log store did not answer: ${describeError(error)}`);
      }
      if (answer.status !== 200) {
        const body = await firstBytes(answer.body, 300);
        throw new LogStoreUnavailableError(`The log store answered ${answer.status}: ${body}`);
      }
      return answer.body;
    };
    return (async function* () {
      yield* jsonLines(await open());
    })();
  }
}

/** Rows from a stream of JSON lines, however its chunks split them. */
async function* jsonLines(body: Readable): AsyncGenerator<StoredLine> {
  let buffer = '';
  body.setEncoding('utf8');
  for await (const chunk of body as AsyncIterable<string>) {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) yield JSON.parse(line) as StoredLine;
    }
  }
}

/** The start of a stream's text, for an error message; the rest is dropped. */
async function firstBytes(body: Readable, max: number): Promise<string> {
  let text = '';
  body.setEncoding('utf8');
  for await (const chunk of body as AsyncIterable<string>) {
    text += chunk;
    if (text.length >= max) break;
  }
  body.destroy();
  return text.slice(0, max);
}

const FORM = 'application/x-www-form-urlencoded';

/** JSON, or null when the text isn't: the callers say what they expected. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A form POSTed straight to the store, inside the cluster; its answer as text. */
function postText(url: string, body: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': FORM, 'content-length': Buffer.byteLength(body) } }, (res) => {
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
    req.end(body);
  });
}

function streamGet(url: string, signal: AbortSignal): Promise<{ status: number; body: Readable }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { signal }, (res) => resolve({ status: res.statusCode ?? 0, body: res }));
    req.on('error', reject);
  });
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
