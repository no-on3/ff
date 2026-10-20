/**
 * L1 for the log store's queries and answers (P-43): the LogsQL each request
 * becomes, with callers' values that try to change it; the pages and their
 * cursors, lines of the same time included; and the two ways to the store.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { InvalidLogCursorError, LogStoreUnavailableError } from '../orchestrator.errors';
import type { LogsQuery } from '../orchestrator.types';
import { KubeApi, KubeResponse, RequestOptions } from './kube-client';
import { LogStore, StoredLine, decodeCursor, encodeCursor, namespaceFilter, nineDecimals, pageQuery, quoted, tailQuery, toPage } from './log-store';

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

describe('tailQuery', () => {
  it("asks for the function's lines in its account's namespace as they come, with no pipe the store refuses in a tail", () => {
    expect(tailQuery('ff-t-abc', 'f-1', {})).toBe(`${STREAM}${FIELDS}`);
  });

  it('narrows to a call and to a phrase, each a quoted value', () => {
    expect(tailQuery('ff-t-abc', 'f-1', { requestId: 'r-1', q: 'x" | sort by (_time)' })).toBe(
      `${STREAM} request_id:="r-1" _msg:"x\\" | sort by (_time)"${FIELDS}`,
    );
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

describe('namespaceFilter (P-45)', () => {
  it("is every line of the namespace, its name a quoted value", () => {
    expect(namespaceFilter('ff-t-abc')).toBe('{namespace="ff-t-abc"}');
    expect(namespaceFilter('ff-t-"} OR {')).toBe('{namespace="ff-t-\\"} OR {"}');
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

  describe('deletion (P-45)', () => {
    const KEY = 'k3y-0f-the-store';
    const form = (options?: RequestOptions) => Object.fromEntries(new URLSearchParams(options?.body ?? ''));

    it("starts a task through the API server's proxy: a POST of a form with the filter and the key, the key in no URL", async () => {
      const api = new FakeApi(async () => ({ status: 200, headers: {}, body: '{"task_id":"1792323545896215532"}' }));

      await expect(store(api).startDeletion(namespaceFilter('ff-t-abc'), KEY)).resolves.toBe('1792323545896215532');

      const [{ method, path, options }] = api.requests;
      expect([method, path]).toEqual(['POST', '/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/delete/run_task']);
      expect(options?.contentType).toBe('application/x-www-form-urlencoded');
      expect(form(options)).toEqual({ filter: '{namespace="ff-t-abc"}', authKey: KEY });
    });

    it('lists the tasks still running the same way, the key in the form', async () => {
      const tasks = [{ task_id: '17', filter: '{namespace="ff-t-abc"}', start_time: '2026-10-18T11:39:05Z' }];
      const api = new FakeApi(async () => ({ status: 200, headers: {}, body: JSON.stringify(tasks) }));

      await expect(store(api).activeDeletions(KEY)).resolves.toEqual(tasks);

      const [{ method, path, options }] = api.requests;
      expect([method, path]).toEqual(['POST', '/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/delete/active_tasks']);
      expect(form(options)).toEqual({ authKey: KEY });
    });

    it("fails with the store's refusal, which names no key: a wrong key's 401, a bad filter's 400; and for an answer that isn't one", async () => {
      const answering = (status: number, body: string) => store(new FakeApi(async () => ({ status, headers: {}, body })));
      const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error);

      const refusals = await Promise.all([
        failure(answering(401, "The provided authKey doesn't match -deleteAuthKey\n").startDeletion('{namespace="x"}', KEY)),
        failure(answering(400, 'cannot parse filter [{namespace=]').startDeletion('{namespace=', KEY)),
        failure(answering(200, '{"status":"ok"}').startDeletion('{namespace="x"}', KEY)),
        failure(answering(200, '{"task_id":17}').activeDeletions(KEY)),
        failure(answering(200, 'not json').activeDeletions(KEY)),
        failure(store(new FakeApi(() => Promise.reject(new Error('connect ECONNREFUSED')))).activeDeletions(KEY)),
      ]);

      expect(refusals.map((error) => [error?.constructor, error?.message])).toEqual([
        [LogStoreUnavailableError, "The log store answered 401: The provided authKey doesn't match -deleteAuthKey\n"],
        [LogStoreUnavailableError, 'The log store answered 400: cannot parse filter [{namespace=]'],
        [LogStoreUnavailableError, "The log store's answer has no task ID"],
        [LogStoreUnavailableError, "The log store's list of deletion tasks is not one"],
        [LogStoreUnavailableError, "The log store's list of deletion tasks is not one"],
        [LogStoreUnavailableError, 'The log store did not answer: connect ECONNREFUSED'],
      ]);
    });

    it('POSTs the form to the Service itself from inside the cluster', async () => {
      const seen: Array<{ method?: string; url?: string; type?: string; body: string }> = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
          res.end('{"task_id":"9"}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        await expect(new LogStore('direct', {} as KubeApi, url).startDeletion('{namespace="ff-t-abc"}', KEY)).resolves.toBe('9');

        expect(seen).toEqual([
          { method: 'POST', url: '/delete/run_task', type: 'application/x-www-form-urlencoded', body: new URLSearchParams({ filter: '{namespace="ff-t-abc"}', authKey: KEY }).toString() },
        ]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('tail', () => {
    /** The API server, for a stream: the answer given, and the paths asked for. */
    const streamingApi = (answer: () => Promise<{ status: number; body: Readable }>) => {
      const paths: string[] = [];
      const api = { stream: (path: string) => (paths.push(path), answer()) } as unknown as KubeApi;
      return { api, paths };
    };
    const bytes = (...chunks: string[]) => Readable.from(chunks.map((chunk) => Buffer.from(chunk)), { objectMode: false });
    const rows = async (lines: AsyncIterable<StoredLine>) => {
      const got: StoredLine[] = [];
      for await (const row of lines) got.push(row);
      return got;
    };

    it("reads the store's live tail through the API server's proxy, rows split across chunks included", async () => {
      const { api, paths } = streamingApi(async () => ({
        status: 200,
        body: bytes('{"_time":"2026-10-17T10:00:00Z","_msg":"one"}\n{"_time":"2026-10-17T10:0', '0:01Z","_msg":"two"}\n\n'),
      }));

      const got = await rows(new LogStore('proxy', api).tail('{namespace="ff-t-abc"}', new AbortController().signal));

      expect(got.map((r) => r._msg)).toEqual(['one', 'two']);
      const [route, search] = paths[0].split('?');
      expect(route).toBe('/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/select/logsql/tail');
      expect(new URLSearchParams(search).get('query')).toBe('{namespace="ff-t-abc"}');
    });

    it("returns before the store answers: through the API server's proxy, the answer begins with its first row", () => {
      const { api } = streamingApi(() => new Promise(() => undefined)); // an answer that never comes

      const lines = new LogStore('proxy', api).tail('*', new AbortController().signal);

      expect(typeof lines[Symbol.asyncIterator]).toBe('function'); // the rows themselves, not a promise of them
    });

    it("fails the reading for a tail the store refuses, with the start of its answer, and for one it can't be asked for", async () => {
      const refused = streamingApi(async () => ({ status: 400, body: bytes('the query cannot be used in live tailing') }));
      const unreachable = streamingApi(() => Promise.reject(new Error('connect ECONNREFUSED')));

      const errors = await Promise.all(
        [refused, unreachable].map(({ api }) => rows(new LogStore('proxy', api).tail('*', new AbortController().signal)).catch((err: unknown) => err)),
      );

      expect(errors.map((e) => [e instanceof LogStoreUnavailableError, (e as Error).message])).toEqual([
        [true, 'The log store answered 400: the query cannot be used in live tailing'],
        [true, 'The log store did not answer: connect ECONNREFUSED'],
      ]);
    });

    it('reads the Service itself from inside the cluster, until the signal aborts the tail', async () => {
      let requestClosed!: () => void;
      const closed = new Promise<void>((resolve) => (requestClosed = resolve));
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"_time":"2026-10-17T10:00:00Z","_msg":"live"}\n'); // then the answer stays open, as a tail's does
        req.on('close', requestClosed);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const abort = new AbortController();
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const iterator = new LogStore('direct', {} as KubeApi, url).tail('*', abort.signal)[Symbol.asyncIterator]();

        const first = await iterator.next();
        abort.abort();
        const after = await iterator.next().catch((err: unknown) => err);
        await closed;

        expect(first.value?._msg).toBe('live');
        // The rows end with the aborted answer's error, which the live tail ignores once stopped; the store saw the request close.
        expect(after).toMatchObject({ code: 'ECONNRESET', message: 'aborted' });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
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
