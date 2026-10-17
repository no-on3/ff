/**
 * L1 for the log store's queries and answers (P-43): the LogsQL each request
 * becomes, with callers' values that try to change it; the pages and their
 * cursors, lines of the same time included; and the two ways to the store.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { InvalidLogCursorError, LogStoreUnavailableError } from '../orchestrator.errors';
import type { LogsQuery } from '../orchestrator.types';
import { KubeApi, KubeResponse, RequestOptions } from './kube-client';
import { LogStore, StoredLine, decodeCursor, encodeCursor, nineDecimals, pageQuery, quoted, toPage } from './log-store';

const query = (extra: Partial<LogsQuery> = {}): LogsQuery => ({
  start: new Date('2026-10-17T10:00:00Z'),
  end: new Date('2026-10-17T11:00:00Z'),
  limit: 2,
  ...extra,
});
const FIELDS = ' | fields _time, _msg, pod, stream, request_id';
const SORT = ' | sort by (_time desc, pod desc, _msg desc)';
const STREAM = '{namespace="ff-t-abc", function_id="f-1"}';

const row = (time: string, message: string, extra: Partial<StoredLine> = {}): StoredLine => ({
  _time: time,
  _msg: message,
  pod: 'fn-f-1-a-b',
  stream: 'stdout',
  ...extra,
});

describe('quoted', () => {
  it.each([
    ['a phrase', 'time out', '"time out"'],
    ['a quote that would end the string', 'x" | delete', '"x\\" | delete"'],
    ['backslashes', 'C:\\path\\"', '"C:\\\\path\\\\\\""'],
    ['a new line and a control character', 'a\nb\u0000', '"a\\nb\\u0000"'],
    ['LogsQL of its own', '{namespace="ff-t-other"} OR *', '"{namespace=\\"ff-t-other\\"} OR *"'],
  ])('keeps %s inside one string', (_, value, expected) => {
    expect(quoted(value)).toBe(expected);
    // JSON's reading of it gives the value back whole: nothing escapes the string.
    expect(JSON.parse(quoted(value))).toBe(value);
  });
});

describe('pageQuery', () => {
  it("asks for the function's lines in its account's namespace, in the window, the newest first, one more than the page", () => {
    expect(pageQuery('ff-t-abc', 'f-1', query())).toBe(
      `${STREAM} _time:[2026-10-17T10:00:00.000Z, 2026-10-17T11:00:00.000Z)${SORT} limit 3${FIELDS}`,
    );
  });

  it('narrows to a call and to a phrase, each a quoted value', () => {
    expect(pageQuery('ff-t-abc', 'f-1', query({ requestId: 'r-1', q: 'time out' }))).toBe(
      `${STREAM} _time:[2026-10-17T10:00:00.000Z, 2026-10-17T11:00:00.000Z) request_id:="r-1" _msg:"time out"${SORT} limit 3${FIELDS}`,
    );
  });

  it('keeps a phrase written to widen the query a phrase, so it finds nothing of other functions or accounts', () => {
    const hostile = '"} OR {namespace="ff-t-other"} | delete | "';
    const logsql = pageQuery('ff-t-abc', 'f-1', query({ q: hostile }));

    expect(logsql).toBe(
      `${STREAM} _time:[2026-10-17T10:00:00.000Z, 2026-10-17T11:00:00.000Z) _msg:"\\"} OR {namespace=\\"ff-t-other\\"} | delete | \\""${SORT} limit 3${FIELDS}`,
    );
  });

  it("starts where the page before ended: up to its oldest line's time, included, past the lines of that time it gave", () => {
    const cursor = encodeCursor({ before: '2026-10-17T10:30:00.123456Z', skip: 2 });

    expect(pageQuery('ff-t-abc', 'f-1', query({ cursor }))).toBe(
      `${STREAM} _time:[2026-10-17T10:00:00.000Z, 2026-10-17T10:30:00.123456Z]${SORT} offset 2 limit 3${FIELDS}`,
    );
  });

  it('refuses a cursor that no page gave', () => {
    expect(() => pageQuery('ff-t-abc', 'f-1', query({ cursor: 'bm90IGEgY3Vyc29y' }))).toThrow(InvalidLogCursorError);
  });
});

describe('decodeCursor', () => {
  it('reads what encodeCursor wrote', () => {
    expect(decodeCursor(encodeCursor({ before: '2026-10-17T10:30:00Z', skip: 0 }))).toEqual({ before: '2026-10-17T10:30:00Z', skip: 0 });
  });

  it.each([
    ['not base64url JSON', '%%%'],
    ['JSON of another shape', Buffer.from('[1, 2]').toString('base64url')],
    ['a time with LogsQL after it', encodeCursor({ before: '2026-10-17T10:30:00Z] | delete', skip: 0 })],
    ['a time with an offset', encodeCursor({ before: '2026-10-17T10:30:00+01:00', skip: 0 })],
    ['a negative skip', encodeCursor({ before: '2026-10-17T10:30:00Z', skip: -1 })],
    ['a fractional skip', encodeCursor({ before: '2026-10-17T10:30:00Z', skip: 1.5 })],
    ['a skip past any page', encodeCursor({ before: '2026-10-17T10:30:00Z', skip: 1_000_001 })],
  ])('refuses %s', (_, text) => {
    expect(() => decodeCursor(text)).toThrow(InvalidLogCursorError);
  });
});

describe('toPage', () => {
  it('gives the rows oldest first, as lines, and no cursor when there are no more', () => {
    const page = toPage(
      [
        row('2026-10-17T10:00:02.5Z', 'second', { request_id: 'r-1', stream: 'stderr' }),
        { _time: '2026-10-17T10:00:01Z', _msg: 'FF dropped 3 lines', stream: 'ff' },
      ],
      2,
    );

    expect(page).toEqual({
      lines: [
        { time: '2026-10-17T10:00:01.000000000Z', instance: null, requestId: null, stream: 'ff', message: 'FF dropped 3 lines' },
        { time: '2026-10-17T10:00:02.500000000Z', instance: 'fn-f-1-a-b', requestId: 'r-1', stream: 'stderr', message: 'second' },
      ],
      next: null,
    });
  });

  it("reads a row without a message as an empty line, and a stream it doesn't know as none", () => {
    const [line] = toPage([{ _time: '2026-10-17T10:00:01Z', stream: 'elsewhere' }], 1).lines;

    expect([line.message, line.stream]).toEqual(['', null]);
  });

  it('gives a cursor when the store had one row more than the page: at the oldest line, past the lines of its time given', () => {
    const rows = [row('2026-10-17T10:00:03Z', 'c'), row('2026-10-17T10:00:02Z', 'b2'), row('2026-10-17T10:00:02Z', 'b1')];

    const page = toPage(rows, 2);

    expect(page.lines.map((l) => l.message)).toEqual(['b2', 'c']);
    expect(decodeCursor(page.next!)).toEqual({ before: '2026-10-17T10:00:02Z', skip: 1 });
  });

  it('adds up the lines given at one time across pages, when a page holds nothing but that time', () => {
    const before = encodeCursor({ before: '2026-10-17T10:00:02Z', skip: 1 });
    const rows = [row('2026-10-17T10:00:02Z', 'b3'), row('2026-10-17T10:00:02Z', 'b2'), row('2026-10-17T10:00:02Z', 'b1')];

    expect(decodeCursor(toPage(rows, 2, before).next!)).toEqual({ before: '2026-10-17T10:00:02Z', skip: 3 });
  });

  it('starts the count again at an older time', () => {
    const before = encodeCursor({ before: '2026-10-17T10:00:05Z', skip: 4 });
    const rows = [row('2026-10-17T10:00:04Z', 'd'), row('2026-10-17T10:00:03Z', 'c'), row('2026-10-17T10:00:01Z', 'a')];

    expect(decodeCursor(toPage(rows, 2, before).next!)).toEqual({ before: '2026-10-17T10:00:03Z', skip: 1 });
  });
});

describe('nineDecimals', () => {
  it.each([
    ['2026-10-17T10:00:00Z', '2026-10-17T10:00:00.000000000Z'],
    ['2026-10-17T10:00:00.123456Z', '2026-10-17T10:00:00.123456000Z'],
    ['2026-10-17T10:00:00.123456789Z', '2026-10-17T10:00:00.123456789Z'],
  ])('writes %s as %s', (time, expected) => {
    expect(nineDecimals(time)).toBe(expected);
  });
});

describe('LogStore', () => {
  const LINES = `${JSON.stringify(row('2026-10-17T10:00:01Z', 'one'))}\n${JSON.stringify(row('2026-10-17T10:00:00Z', 'zero'))}\n`;

  /** The API server, as far as the store's queries go: answers what `answer` says, and keeps each request. */
  class FakeApi implements Pick<KubeApi, 'request'> {
    requests: Array<{ method: string; path: string; options?: RequestOptions }> = [];
    constructor(private readonly answer: () => Promise<KubeResponse>) {}
    request(method: string, path: string, options?: RequestOptions): Promise<KubeResponse> {
      this.requests.push({ method, path, options });
      return this.answer();
    }
  }
  const store = (api: FakeApi, url?: string) => new LogStore('proxy', api as unknown as KubeApi, url);

  it("reaches the store through the API server's Service proxy, as a backend outside the cluster does", async () => {
    const api = new FakeApi(async () => ({ status: 200, headers: {}, body: LINES }));

    const rows = await store(api).query('{namespace="ff-t-abc"} _time:5m');

    expect(rows.map((r) => r._msg)).toEqual(['one', 'zero']);
    expect(api.requests).toHaveLength(1);
    const { method, path } = api.requests[0];
    const [route, search] = path.split('?');
    expect([method, route]).toEqual(['GET', '/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/select/logsql/query']);
    expect(new URLSearchParams(search).get('query')).toBe('{namespace="ff-t-abc"} _time:5m');
  });

  it('calls the Service itself from inside the cluster', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.end(LINES);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const rows = await new LogStore('direct', {} as KubeApi, url).query('{namespace="ff-t-abc"}');

      expect(rows).toHaveLength(2);
      expect(seen).toEqual([`/select/logsql/query?${new URLSearchParams({ query: '{namespace="ff-t-abc"}' })}`]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([
    ['an error answer', async (): Promise<KubeResponse> => ({ status: 503, headers: {}, body: 'no endpoints available for service "victoria-logs"' }), /answered 503: no endpoints/],
    ['no answer', async (): Promise<KubeResponse> => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), /did not answer: .*ECONNREFUSED/],
    ['an answer that is not JSON lines', async (): Promise<KubeResponse> => ({ status: 200, headers: {}, body: '<html>' }), /not JSON lines/],
  ])('reports %s as the store being unavailable', async (_, answer, message) => {
    const error = await store(new FakeApi(answer)).query('*').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LogStoreUnavailableError);
    expect((error as Error).message).toMatch(message);
  });
});
