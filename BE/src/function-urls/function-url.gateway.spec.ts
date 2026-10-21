/**
 * L1: the function URL gateway through real HTTP, as callers reach it: the
 * request's host finds its URL, the caller and the account are checked, the
 * call counts against the plan's rate, the function gets AWS Lambda's event,
 * and its return value is the answer. The services behind it are stand-ins;
 * the rate's count is the throttler's own storage.
 */
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { IncomingHttpHeaders, request as httpRequest } from 'node:http';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { InsufficientCreditException } from '../billing/credit-policy';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { FunctionUrl, UrlAuthType, UrlCors, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { EventFormat, Function, FunctionStatus } from '../functions/entities/function.entity';
import { refusals, urlResponses } from '../monitoring/operator-metrics';
import { valueOf } from '../monitoring/test-fixtures';
import { FunctionRuntimeError, FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { countInvocation } from '../plans/rate-limits';
import { plan } from '../plans/test-fixtures';
import { FunctionUrlGateway, URL_PAYLOAD_LIMIT } from './function-url.gateway';
import { FunctionUrlEvent } from './url-event';

const ACCOUNT = '123456789012';
const PUBLIC = 'p0000000000000000000000000000001';
const PRIVATE = 'k0000000000000000000000000000001';
const WITH_CORS = 'c0000000000000000000000000000001';
const host = (urlId: string) => `${urlId}.fn.localhost:3001`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CORS: UrlCors = { allowOrigins: ['https://app.example.tn'], allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'], maxAge: 300 };

const urlRow = (urlId: string, authType: UrlAuthType, cors: UrlCors | null = null): FunctionUrl =>
  ({ functionId: `fn-${urlId[0]}`, accountId: ACCOUNT, urlId, authType, cors, invokeMode: UrlInvokeMode.BUFFERED }) as FunctionUrl;

const KEY: Principal = {
  accountId: ACCOUNT,
  accountStatus: AccountStatus.ACTIVE,
  planId: 'beta',
  keyId: 'k1a2b3c4d5e6',
  keyName: 'deploy',
  userId: 'u-1',
  role: 'developer',
  scopes: ['functions:invoke'],
};

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body's JSON Message, for the gateway's own answers. */
  message?: string;
}

describe('the function URL gateway (L1)', () => {
  let gateway: FunctionUrlGateway;
  let port: number;
  let throttler: ThrottlerStorageService;
  const urls = new Map<string, FunctionUrl>();
  /** Customers' verified domains, each to its function. */
  const domains = new Map<string, string>();
  const functions = { findOne: jest.fn(), call: jest.fn() };
  const apiKeys = { authenticate: jest.fn() };
  const credit = { admit: jest.fn() };
  const plans = { get: jest.fn() };
  const refused = { count: jest.fn() };
  const accounts = { findOne: jest.fn() };
  const config = {
    getOrThrow: (key: string) => ({ 'functionUrls.base': 'http://fn.localhost:3001', 'http.trustProxy': ['loopback'] })[key],
  } as unknown as ConfigService;

  /** The function's answer to the next calls, and the calls it got. */
  let output: unknown;
  const calls = () => functions.call.mock.calls as Array<[Function, FunctionUrlEvent, { source: InvocationSource; requestId: string; history: FunctionUrlEvent }]>;
  const lastEvent = () => calls().at(-1)![1];

  const send = (
    urlId: string,
    path = '/',
    { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string | string[]>; body?: string | Buffer } = {},
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: host(urlId), ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const answer: Answer = { status: response.statusCode as number, headers: response.headers, body: Buffer.concat(chunks) };
          try {
            answer.message = (JSON.parse(answer.body.toString()) as { Message?: string }).Message;
          } catch {
            // The function's own answer, which needn't be JSON whatever its type says.
          }
          resolve(answer);
        });
      });
      request.on('error', reject);
      request.end(body);
    });

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    urls.clear();
    domains.clear();
    for (const row of [urlRow(PUBLIC, UrlAuthType.NONE), urlRow(PRIVATE, UrlAuthType.AWS_IAM), urlRow(WITH_CORS, UrlAuthType.NONE, CORS)]) urls.set(row.urlId, row);
    output = { statusCode: 200, body: 'ok' };
    functions.findOne.mockImplementation(async (accountId: string, id: string) => ({
      id,
      accountId,
      status: FunctionStatus.ACTIVE,
      eventFormat: EventFormat.LAMBDA,
    }));
    functions.call.mockImplementation(async (_fn: Function, _event: unknown, options: { requestId: string }) => ({
      ok: true,
      invocation: { id: options.requestId },
      output,
    }));
    plans.get.mockImplementation(async () => plan({ invokesPerSecond: 100 }));
    accounts.findOne.mockImplementation(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE, planId: 'beta' }));
    apiKeys.authenticate.mockImplementation(async () => KEY);
    throttler = new ThrottlerStorageService();
    gateway = new FunctionUrlGateway(
      config,
      {
        forUrlId: async (urlId: string) => urls.get(urlId) ?? null,
        forFunction: async (functionId: string) => [...urls.values()].find((url) => url.functionId === functionId) ?? null,
      } as never,
      { forHost: async (host: string) => (domains.has(host) ? { domain: host, functionId: domains.get(host) } : null) } as never,
      functions as never,
      apiKeys as never,
      credit as never,
      plans as never,
      refused as never,
      accounts as never,
      throttler,
    );
    port = (await gateway.listen(0, '127.0.0.1')).port;
  });

  afterEach(async () => {
    await gateway.onModuleDestroy();
    throttler.onApplicationShutdown();
    jest.restoreAllMocks();
  });

  it('answers 404 for a host that is no function URL, naming the request all the same', async () => {
    for (const urlId of ['z0000000000000000000000000000001', 'not-an-id']) {
      const answer = await send(urlId);

      expect([answer.status, answer.message]).toEqual([404, 'Not Found']);
      expect(answer.headers['x-amzn-requestid']).toMatch(UUID);
    }
    expect(functions.call).not.toHaveBeenCalled();
  });

  it("calls the function with AWS Lambda's event, under the request's ID, and answers with its response", async () => {
    output = { statusCode: 201, headers: { 'content-type': 'text/plain', 'x-greeting': 'hi' }, cookies: ['seen=1; Max-Age=60', 'lang=ar'], body: 'Hi Amira' };

    const answer = await send(PUBLIC, '/hello/world?name=Amira&tag=a&tag=b', {
      headers: { cookie: 'theme=dark', 'user-agent': 'curl/8', 'x-forwarded-for': '197.0.0.9' },
    });

    expect(answer.status).toBe(201);
    expect(answer.body.toString()).toBe('Hi Amira');
    expect(answer.headers['content-type']).toBe('text/plain');
    expect(answer.headers['x-greeting']).toBe('hi');
    expect(answer.headers['set-cookie']).toEqual(['seen=1; Max-Age=60', 'lang=ar']);
    const [fn, event, options] = calls()[0];
    expect(fn).toMatchObject({ id: 'fn-p', accountId: ACCOUNT });
    expect(options).toMatchObject({ source: InvocationSource.URL, requestId: answer.headers['x-amzn-requestid'] });
    expect(event).toMatchObject({
      version: '2.0',
      rawPath: '/hello/world',
      rawQueryString: 'name=Amira&tag=a&tag=b',
      queryStringParameters: { name: 'Amira', tag: 'a,b' },
      cookies: ['theme=dark'],
      isBase64Encoded: false,
      requestContext: {
        accountId: 'anonymous',
        apiId: PUBLIC,
        domainName: `${PUBLIC}.fn.localhost`,
        domainPrefix: PUBLIC,
        // The edge in front, which the settings trust, names the caller.
        http: { method: 'GET', path: '/hello/world', protocol: 'HTTP/1.1', sourceIp: '197.0.0.9', userAgent: 'curl/8' },
        requestId: answer.headers['x-amzn-requestid'],
      },
    });
    expect(event).not.toHaveProperty('body');
    expect(event.headers).toMatchObject({ host: host(PUBLIC), 'user-agent': 'curl/8' });
  });

  it("answers 200 with the value's JSON when the function returns no response, as Lambda does", async () => {
    output = 'Hello';

    const answer = await send(PUBLIC);

    expect([answer.status, answer.headers['content-type'], answer.body.toString()]).toEqual([200, 'application/json', '"Hello"']);
  });

  it('passes a JSON body as text, and bytes in base64', async () => {
    await send(PUBLIC, '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"item":"قهوة"}' });
    expect([lastEvent().body, lastEvent().isBase64Encoded]).toEqual(['{"item":"قهوة"}', false]);

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await send(PUBLIC, '/upload', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
    expect([lastEvent().body, lastEvent().isBase64Encoded]).toEqual([bytes.toString('base64'), true]);
  });

  it("keeps none of its callers' credentials in the history, though the function gets them", async () => {
    await send(PUBLIC, '/', { headers: { authorization: 'Bearer their-own-token', cookie: 'session=abc' } });

    const [, event, { history }] = calls()[0];
    expect(event.headers.authorization).toBe('Bearer their-own-token');
    expect(event.cookies).toEqual(['session=abc']);
    expect(history.headers.authorization).toBe('***');
    expect(history).not.toHaveProperty('cookies');
  });

  it("answers 502 when the call fails, never with the function's error, which is its account's to read", async () => {
    functions.call.mockImplementation(async () => ({
      ok: false,
      invocation: {},
      error: new FunctionRuntimeError('Error', 'database password is hunter2'),
      visible: 'Error: database password is hunter2',
    }));

    const answer = await send(PUBLIC);

    expect([answer.status, answer.body.toString()]).toEqual([502, '{"Message":"Internal Server Error"}']);
  });

  it('answers 429 when no instance was free in time, which the caller may retry', async () => {
    functions.call.mockImplementation(async () => ({ ok: false, invocation: {}, error: new FunctionThrottledError('busy'), visible: 'busy' }));

    expect((await send(PUBLIC)).status).toBe(429);
  });

  it("answers 502 for a response that can't be sent, and logs why", async () => {
    output = { statusCode: 200, headers: { 'X-Bad': 'a\r\nInjected: 1' } };

    const answer = await send(PUBLIC);

    expect(answer.status).toBe(502);
    expect(answer.headers).not.toHaveProperty('injected');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining("the header X-Bad's value holds a line break or NUL"));
  });

  it("answers 500 when the gateway itself fails, the details only in the log", async () => {
    functions.call.mockRejectedValue(new Error('connection to the database lost'));

    const answer = await send(PUBLIC);

    expect([answer.status, answer.message]).toEqual([500, 'Internal Server Error']);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('connection to the database lost'), expect.anything());
  });

  describe('a URL that takes the account\'s credentials (AWS_IAM)', () => {
    it("calls with an API key of the account that may invoke, which the function never sees, and names the caller", async () => {
      const answer = await send(PRIVATE, '/', { headers: { authorization: 'Bearer ffk_k1a2b3c4d5e6_secret' } });

      expect(answer.status).toBe(200);
      expect(apiKeys.authenticate).toHaveBeenCalledWith('ffk_k1a2b3c4d5e6_secret');
      expect(lastEvent().headers).not.toHaveProperty('authorization');
      expect(lastEvent().requestContext.accountId).toBe(ACCOUNT);
      expect(lastEvent().requestContext.authorizer?.iam).toMatchObject({ accessKey: 'k1a2b3c4d5e6', accountId: ACCOUNT, userId: 'u-1' });
      expect(accounts.findOne).not.toHaveBeenCalled(); // the key says the account's state
    });

    it.each<[string, Record<string, string>, (() => void) | undefined, string]>([
      ['no key', {}, undefined, 'Forbidden: this URL takes an API key of its account, as "Authorization: Bearer ffk_…"'],
      ['a token that is no API key', { authorization: 'Bearer eyJhbGciOi' }, undefined, 'Forbidden: this URL takes an API key of its account, as "Authorization: Bearer ffk_…"'],
      ['a key that is invalid, revoked or expired', { authorization: 'Bearer ffk_x' }, () => apiKeys.authenticate.mockRejectedValue(new UnauthorizedException('The API key was revoked')), 'Forbidden'],
      ["another account's key", { authorization: 'Bearer ffk_x' }, () => apiKeys.authenticate.mockResolvedValue({ ...KEY, accountId: '999999999999' }), 'Forbidden'],
      ['a key without functions:invoke', { authorization: 'Bearer ffk_x' }, () => apiKeys.authenticate.mockResolvedValue({ ...KEY, scopes: ['functions:read'] }), 'Forbidden: the API key lacks the scope functions:invoke'],
      ["a viewer's key", { authorization: 'Bearer ffk_x' }, () => apiKeys.authenticate.mockResolvedValue({ ...KEY, role: 'viewer' }), "Forbidden: the API key's creator has the viewer role, which can't invoke"],
    ])('refuses %s with 403, calling nothing', async (_case, headers, arrange, message) => {
      arrange?.();

      const answer = await send(PRIVATE, '/', { headers });

      expect([answer.status, answer.message]).toEqual([403, message]);
      expect(functions.call).not.toHaveBeenCalled();
    });
  });

  it('refuses the calls of an account that is not active, as the API does', async () => {
    accounts.findOne.mockResolvedValue({ id: ACCOUNT, status: AccountStatus.SUSPENDED, planId: 'beta' });

    const answer = await send(PUBLIC);

    expect([answer.status, answer.message]).toEqual([403, 'Forbidden']);
    expect(functions.call).not.toHaveBeenCalled();
  });

  it("counts its calls against the plan's invocations per second with the API's invokes, and refuses past it", async () => {
    plans.get.mockResolvedValue(plan({ invokesPerSecond: 2 }));
    await countInvocation(throttler, ACCOUNT, 2); // an invoke through the API, this second
    const refusedBefore = await valueOf(refusals, { reason: 'rate_limit' });

    const first = await send(PUBLIC);
    const second = await send(PUBLIC);

    expect([first.status, second.status]).toEqual([200, 429]);
    expect([second.message, second.headers['retry-after']]).toEqual(['Too Many Requests', '1']);
    expect(functions.call).toHaveBeenCalledTimes(1);
    // A refused call is counted for the Throttles metric, and for the operator, as the API's are.
    expect(refused.count).toHaveBeenCalledWith(ACCOUNT, 'fn-p');
    expect(await valueOf(refusals, { reason: 'rate_limit' })).toBe(refusedBefore + 1);
  });

  it.each<[string, () => void, number, string]>([
    ["a function that isn't active", () => functions.findOne.mockResolvedValue({ id: 'fn-p', status: FunctionStatus.ERROR, eventFormat: EventFormat.LAMBDA }), 503, 'Service Unavailable'],
    ['a function deleted meanwhile', () => functions.findOne.mockRejectedValue(new NotFoundException()), 404, 'Not Found'],
    [
      'an account without credit, saying nothing of its balance',
      () =>
        credit.admit.mockRejectedValue(
          new InsufficientCreditException(
            { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
            { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
            { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
          ),
        ),
      402,
      'Payment Required',
    ],
  ])('answers %s without calling it', async (_case, arrange, status, message) => {
    arrange();

    const answer = await send(PUBLIC);

    expect([answer.status, answer.message]).toEqual([status, message]);
    expect(answer.body.toString()).not.toContain('TND');
    expect(functions.call).not.toHaveBeenCalled();
  });

  it("refuses a request over AWS Lambda's 6 MB with 413: one that says so, and one whose event would be larger", async () => {
    const declared = await send(PUBLIC, '/', { method: 'POST', headers: { 'content-length': String(URL_PAYLOAD_LIMIT + 1) } });
    // 5 MB of bytes is 6.7 MB in base64.
    const encoded = await send(PUBLIC, '/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(5 * 1024 * 1024, 1) });

    expect([declared.status, declared.message, declared.headers.connection]).toEqual([413, 'Request Entity Too Large', 'close']);
    expect([encoded.status, encoded.message]).toEqual([413, 'Request Entity Too Large']);
    expect(functions.call).not.toHaveBeenCalled();
  });

  it("answers HEAD with the GET's headers and no body", async () => {
    output = { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'twelve bytes' };

    const answer = await send(PUBLIC, '/', { method: 'HEAD' });

    expect([answer.status, answer.headers['content-length'], answer.body.length]).toEqual([200, '12', 0]);
  });

  describe('CORS', () => {
    it("answers an allowed origin's preflight itself, without calling the function", async () => {
      const answer = await send(WITH_CORS, '/orders', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.tn', 'access-control-request-method': 'POST' },
      });

      expect(answer.status).toBe(204);
      expect(answer.headers).toMatchObject({
        'access-control-allow-origin': 'https://app.example.tn',
        'access-control-allow-methods': 'GET,POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '300',
        vary: 'Origin',
      });
      expect(functions.call).not.toHaveBeenCalled();
    });

    it("answers another origin's preflight without CORS headers, which the browser refuses", async () => {
      const answer = await send(WITH_CORS, '/', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });

      expect(answer.status).toBe(204);
      expect(Object.keys(answer.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    });

    it("puts its headers on the function's answer, in place of the function's own", async () => {
      output = { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'content-type': 'text/plain' }, body: 'ok' };

      const answer = await send(WITH_CORS, '/', { headers: { origin: 'https://app.example.tn' } });

      expect(answer.headers['access-control-allow-origin']).toBe('https://app.example.tn');
      expect(answer.headers.vary).toBe('Origin');
    });

    it('puts them on a refusal too, which a browser can then read', async () => {
      functions.call.mockImplementation(async () => ({ ok: false, invocation: {}, error: new FunctionRuntimeError('Error', 'x'), visible: 'x' }));

      const answer = await send(WITH_CORS, '/', { headers: { origin: 'https://app.example.tn' } });

      expect([answer.status, answer.headers['access-control-allow-origin']]).toEqual([502, 'https://app.example.tn']);
    });

    it('leaves a preflight to the function when the URL has no CORS configuration', async () => {
      output = { statusCode: 200, headers: { 'access-control-allow-origin': 'https://mine.example' } };

      const answer = await send(PUBLIC, '/', { method: 'OPTIONS', headers: { origin: 'https://mine.example', 'access-control-request-method': 'PUT' } });

      expect([answer.status, answer.headers['access-control-allow-origin']]).toEqual([200, 'https://mine.example']);
      expect(lastEvent().requestContext.http.method).toBe('OPTIONS');
    });
  });

  describe("a customer's own domain", () => {
    const onDomain = (domain: string, path = '/', headers: Record<string, string> = {}) =>
      send('', path, { headers: { host: domain, ...headers } });

    it('reaches its function once verified, and the event names the domain', async () => {
      domains.set('shop.example.tn', 'fn-p');

      const answer = await onDomain('Shop.Example.TN:443', '/cart?item=1');

      expect(answer.status).toBe(200);
      expect(calls()[0][0]).toMatchObject({ id: 'fn-p' });
      expect(lastEvent().requestContext).toMatchObject({ domainName: 'shop.example.tn', domainPrefix: 'shop', apiId: PUBLIC });
      expect(lastEvent().rawPath).toBe('/cart');
    });

    it('answers 404 for a domain not verified, or whose URL is gone', async () => {
      domains.set('gone.example.tn', 'fn-none');

      expect((await onDomain('pending.example.tn')).status).toBe(404);
      expect((await onDomain('gone.example.tn')).status).toBe(404);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it("leaves a function's own /tls/allowed to it on its domain", async () => {
      domains.set('shop.example.tn', 'fn-p');

      await onDomain('shop.example.tn', '/tls/allowed?domain=anything.example');

      expect(lastEvent().rawPath).toBe('/tls/allowed');
    });

    it('gets a certificate on demand once verified, and not before', async () => {
      domains.set('shop.example.tn', 'fn-p');
      const ask = (domain: string) => send('', `/tls/allowed?domain=${domain}`, { headers: { host: 'ff-backend.ff-system.svc.cluster.local:3001' } });

      expect([(await ask('shop.example.tn')).status, (await ask('pending.example.tn')).status]).toEqual([200, 404]);
    });
  });

  describe("the edge's question before a certificate on demand", () => {
    const ask = (domain: string | undefined, host = 'ff-backend.ff-system.svc.cluster.local:3001') =>
      send('', `/tls/allowed${domain === undefined ? '' : `?domain=${encodeURIComponent(domain)}`}`, { headers: { host } });

    it("says yes for a function URL's host, whatever its case", async () => {
      const answers = [await ask(`${PUBLIC}.fn.localhost`), await ask(`${PRIVATE.toUpperCase()}.FN.localhost`)];

      expect(answers.map((answer) => [answer.status, answer.body.toString()])).toEqual([
        [200, 'allowed'],
        [200, 'allowed'],
      ]);
    });

    it.each([
      ['an ID no URL has', 'z0000000000000000000000000000001.fn.localhost'],
      ['the function domain itself', 'fn.localhost'],
      ['another domain', `${PUBLIC}.fn.example.com`],
      ['no domain', undefined],
    ])('says no for %s, so that nobody gets the edge to ask for names of their choosing', async (_case, domain) => {
      expect((await ask(domain)).status).toBe(404);
    });

    it("is a path like any other on a function URL's host: the function's", async () => {
      await send(PUBLIC, `/tls/allowed?domain=${PUBLIC}.fn.localhost`);

      expect(lastEvent().rawPath).toBe('/tls/allowed');
    });
  });

  it('counts each answer by its status class, apart from the API\'s', async () => {
    const before = { ok: await valueOf(urlResponses, { class: '2xx' }), missing: await valueOf(urlResponses, { class: '4xx' }) };

    await send(PUBLIC);
    await send('z0000000000000000000000000000001');

    expect(await valueOf(urlResponses, { class: '2xx' })).toBe(before.ok + 1);
    expect(await valueOf(urlResponses, { class: '4xx' })).toBe(before.missing + 1);
  });
});
