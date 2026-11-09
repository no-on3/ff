/**
 * L1: the function URL gateway through real HTTP, as callers reach it: the
 * request's host finds its URL, the caller and the account are checked (an
 * API key, or a signature by an access key, made by AWS's own signer), the
 * call counts against the plan's rate, the function gets AWS Lambda's event,
 * and its return value is the answer; a site's own domain goes to the website
 * server. The services behind it are stand-ins; the rate's count is the
 * throttler's own storage. What a call answers and the URL's CORS are also
 * function-url-examples.json's, which ff local's front door reads too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { SignatureV4 } from '@smithy/signature-v4';
import { IncomingHttpHeaders, ServerResponse, request as httpRequest } from 'node:http';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { InsufficientCreditException } from '../billing/credit-policy';
import { Sha256 } from '../common/test-fixtures';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { FunctionUrl, UrlAuthType, UrlCors, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { EventFormat, Function, FunctionStatus } from '../functions/entities/function.entity';
import { refusals, urlResponses } from '../monitoring/operator-metrics';
import { valueOf } from '../monitoring/test-fixtures';
import { FunctionRuntimeError, FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { countInvocation } from '../plans/rate-limits';
import { plan } from '../plans/test-fixtures';
import { CallTarget } from '../functions/functions.service';
import { ActiveKey, EXPIRED } from '../storage/storage-directory.service';
import { FunctionUrlGateway, URL_PAYLOAD_LIMIT } from './function-url.gateway';
import { FunctionUrlEvent } from './url-event';

const ACCOUNT = '123456789012';
const PUBLIC = 'p0000000000000000000000000000001';
const PRIVATE = 'k0000000000000000000000000000001';
/** The URL of the alias live of fn-p, whose $LATEST URL is PUBLIC. */
const ALIASED = 'a0000000000000000000000000000001';
const host = (urlId: string) => `${urlId}.fn.localhost:3001`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const urlRow = (urlId: string, authType: UrlAuthType, cors: UrlCors | null = null, alias: string | null = null): FunctionUrl =>
  ({ functionId: `fn-${alias ? 'p' : urlId[0]}`, alias, accountId: ACCOUNT, urlId, authType, cors, invokeMode: UrlInvokeMode.BUFFERED }) as FunctionUrl;

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

/** An access key of the account that invokes all its functions, as AWS's tools sign with one. */
const ACCESS: ActiveKey = {
  id: 'AKFFAAAAAAAAAAAAAAAA',
  accountId: ACCOUNT,
  name: 'ci-invoker',
  functionId: null,
  buckets: null,
  queues: null,
  functions: ['*'],
  functionAccess: 'invoke',
  readOnly: false,
  secret: 'a'.repeat(40),
};

/** The headers AWS's signer sends a request to a URL with, signed for `service` by the key: its host, its time, its signature. */
async function signedHeaders(
  urlId: string,
  path = '/',
  { method = 'GET', body = '', key = ACCESS, secret = key.secret, service = 'lambda', at = new Date() }: { method?: string; body?: string; key?: ActiveKey; secret?: string; service?: string; at?: Date } = {},
): Promise<Record<string, string>> {
  const [rawPath, rawQuery = ''] = path.split('?');
  const signer = new SignatureV4({ service, region: 'tn-tunis-1', credentials: { accessKeyId: key.id, secretAccessKey: secret }, sha256: Sha256, uriEscapePath: true });
  const query = Object.fromEntries(new URLSearchParams(rawQuery));
  const request = { method, protocol: 'http:', hostname: host(urlId).split(':')[0], path: rawPath, query, headers: { host: host(urlId) }, body };
  return (await signer.sign(request, { signingDate: at })).headers;
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body's JSON Message, for the gateway's own answers. */
  message?: string;
}

/** A case of the table: a request to a URL, with its CORS or none; what its call did; the answer as sent, and what the call and the log saw. */
interface GatewayExample {
  title: string;
  cors?: UrlCors;
  request: { method: string; path: string; headers?: Record<string, string>; body?: string };
  ran?: { output?: unknown; error?: { kind?: 'throttled'; type?: string; message: string } };
  answer: { status: number; headers?: Record<string, string>; noHeadersStartingWith?: string[]; body?: string };
  called?: false | { has: Record<string, unknown> };
  says?: string;
}
const table = JSON.parse(readFileSync(join(__dirname, 'function-url-examples.json'), 'utf8')) as { gateway: Record<string, GatewayExample[]> };

describe('the function URL gateway (L1)', () => {
  let gateway: FunctionUrlGateway;
  let port: number;
  let throttler: ThrottlerStorageService;
  const urls = new Map<string, FunctionUrl>();
  /** Customers' verified domains, each to the URL it serves, by its ID. */
  const domains = new Map<string, string>();
  /** Customers' verified domains for sites, each to its bucket, a site or no longer one. */
  const siteDomains = new Map<string, { name: string; website: object | null }>();
  const websites = { serve: jest.fn(), allowsCertificate: jest.fn() };
  const functions = { findOne: jest.fn(), callTarget: jest.fn(), call: jest.fn() };
  const apiKeys = { authenticate: jest.fn() };
  const credit = { admit: jest.fn() };
  const plans = { get: jest.fn() };
  const refused = { count: jest.fn() };
  const accounts = { findOne: jest.fn() };
  /** The access keys FF knows, by ID, and the accounts' state, as the front doors look them up. */
  const directory = { key: jest.fn(), account: jest.fn(), touch: jest.fn() };
  let accessKeys: ActiveKey[];
  const config = {
    getOrThrow: (key: string) => ({ 'functionUrls.base': 'http://fn.localhost:3001', 'http.trustProxy': ['loopback'] })[key],
  } as unknown as ConfigService;

  /** The function's answer to the next calls, and the calls it got. */
  let output: unknown;
  const calls = () =>
    functions.call.mock.calls as Array<[Function, FunctionUrlEvent, { source: InvocationSource; requestId: string; history: FunctionUrlEvent; target: CallTarget }]>;
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

  /** The case's request sent to a URL with its CORS, its call answered as it says; the answer, the call and the log as it says. */
  async function answersAsItSays(example: GatewayExample): Promise<void> {
    urls.set(PUBLIC, urlRow(PUBLIC, UrlAuthType.NONE, example.cors ?? null));
    if (example.ran?.output !== undefined) output = example.ran.output;
    const error = example.ran?.error;
    if (error) {
      const thrown = error.kind === 'throttled' ? new FunctionThrottledError(error.message) : new FunctionRuntimeError(error.type ?? 'Error', error.message);
      functions.call.mockImplementation(async () => ({ ok: false, invocation: {}, error: thrown, visible: error.message }));
    }

    const { method, path, headers, body } = example.request;
    const answer = await send(PUBLIC, path, { method, headers, body });

    const expected = example.answer;
    expect(answer.status).toBe(expected.status);
    expect(answer.headers).toMatchObject(expected.headers ?? {});
    for (const prefix of expected.noHeadersStartingWith ?? []) expect(Object.keys(answer.headers).filter((name) => name.startsWith(prefix))).toEqual([]);
    if (expected.body !== undefined) expect(answer.body.toString()).toBe(expected.body);
    if (example.called === false) expect(functions.call).not.toHaveBeenCalled();
    for (const [at, value] of Object.entries(example.called ? example.called.has : {})) expect(lastEvent()).toHaveProperty(at.split('.'), value);
    if (example.says) expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining(example.says));
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    urls.clear();
    domains.clear();
    siteDomains.clear();
    websites.serve.mockImplementation(async (_request: unknown, response: ServerResponse, bucket: string) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`the site of ${bucket}`);
    });
    websites.allowsCertificate.mockImplementation(async (domain: string) => domain === 'docs.site.localhost');
    for (const row of [urlRow(PUBLIC, UrlAuthType.NONE), urlRow(PRIVATE, UrlAuthType.AWS_IAM), urlRow(ALIASED, UrlAuthType.NONE, null, 'live')]) {
      urls.set(row.urlId, row);
    }
    output = { statusCode: 200, body: 'ok' };
    functions.findOne.mockImplementation(async (accountId: string, id: string) => ({
      id,
      accountId,
      name: `name-of-${id}`,
      status: FunctionStatus.ACTIVE,
      eventFormat: EventFormat.LAMBDA,
    }));
    functions.callTarget.mockImplementation(async () => ({}));
    functions.call.mockImplementation(async (_fn: Function, _event: unknown, options: { requestId: string }) => ({
      ok: true,
      invocation: { id: options.requestId },
      output,
    }));
    plans.get.mockImplementation(async () => plan({ invokesPerSecond: 100 }));
    accounts.findOne.mockImplementation(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE, planId: 'beta' }));
    apiKeys.authenticate.mockImplementation(async () => KEY);
    accessKeys = [ACCESS];
    // A function's key past its end, AKFFFFFF…, the directory says so of.
    directory.key.mockImplementation(async (id: string) => (id === 'AKFFFFFFFFFFFFFFFFFF' ? EXPIRED : (accessKeys.find((key) => key.id === id) ?? null)));
    directory.account.mockImplementation(async (id: string) => ({ id, status: AccountStatus.ACTIVE, planId: 'beta' }));
    throttler = new ThrottlerStorageService();
    gateway = new FunctionUrlGateway(
      config,
      { forUrlId: async (urlId: string) => urls.get(urlId) ?? null } as never,
      {
        forHost: async (host: string) =>
          domains.has(host)
            ? { domain: host, functionId: urls.get(domains.get(host)!)?.functionId ?? 'fn-none', urlId: domains.get(host) }
            : siteDomains.has(host)
              ? { domain: host, functionId: null, bucketId: `b-${siteDomains.get(host)!.name}`, bucket: siteDomains.get(host) }
              : null,
      } as never,
      functions as never,
      apiKeys as never,
      credit as never,
      plans as never,
      refused as never,
      accounts as never,
      throttler,
      { allowsCertificate: async (domain: string) => ['s3.localhost', 'photos.s3.localhost'].includes(domain.toLowerCase()) } as never,
      websites as never,
      directory as never,
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

  it.each(table.gateway.calls)('$title', answersAsItSays);

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
      ['no key', {}, undefined, 'Forbidden: this URL takes a request signed for lambda by an access key of its account, or an API key of it, as "Authorization: Bearer ffk_…"'],
      ['a token that is no API key', { authorization: 'Bearer eyJhbGciOi' }, undefined, 'Forbidden: this URL takes a request signed for lambda by an access key of its account, or an API key of it, as "Authorization: Bearer ffk_…"'],
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

    it("calls with a request signed for lambda by an access key of the account that may invoke, its body and query as signed, the signature never the function's", async () => {
      const body = '{"item":"قهوة"}';
      const headers = await signedHeaders(PRIVATE, '/orders?tag=b&size=2', { method: 'POST', body });

      // A header it didn't sign reaches the function all the same.
      const answer = await send(PRIVATE, '/orders?tag=b&size=2', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });

      expect(answer.status).toBe(200);
      expect(directory.key).toHaveBeenCalledWith(ACCESS.id);
      expect(apiKeys.authenticate).not.toHaveBeenCalled();
      expect([lastEvent().body, lastEvent().rawQueryString]).toEqual([body, 'tag=b&size=2']);
      expect(lastEvent().headers).not.toHaveProperty('authorization');
      // The key's name says who called, as an IAM user's would.
      expect(lastEvent().requestContext.authorizer?.iam).toMatchObject({ accessKey: ACCESS.id, accountId: ACCOUNT, userId: 'ci-invoker', callerId: 'ci-invoker' });
      expect(directory.touch).toHaveBeenCalledWith(ACCESS.id);
      expect(accounts.findOne).not.toHaveBeenCalled(); // the key's account says its state
    });

    it("calls with a function's own key, which invokes every function of its account as its function, and a key that names the function, to write", async () => {
      const own: ActiveKey = { ...ACCESS, id: 'AKFFBBBBBBBBBBBBBBBB', name: null, functionId: 'fn-w', functions: null, functionAccess: null };
      const writer: ActiveKey = { ...ACCESS, id: 'AKFFDDDDDDDDDDDDDDDD', name: null, functions: ['name-of-fn-k'], functionAccess: 'write' };
      accessKeys = [own, writer];

      const answers = [await send(PRIVATE, '/', { headers: await signedHeaders(PRIVATE, '/', { key: own }) }), await send(PRIVATE, '/', { headers: await signedHeaders(PRIVATE, '/', { key: writer }) })];

      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      expect(calls().map(([, event]) => event.requestContext.authorizer?.iam.userId)).toEqual(['fn-w', writer.id]);
    });

    it.each<[string, () => Promise<Record<string, string>>, string | jest.AsymmetricMatcher]>([
      ['a key FF never made', () => signedHeaders(PRIVATE, '/', { key: { ...ACCESS, id: 'AKFFZZZZZZZZZZZZZZZZ' } }), 'Forbidden: The security token included in the request is invalid.'],
      ['a key past its end', () => signedHeaders(PRIVATE, '/', { key: { ...ACCESS, id: 'AKFFFFFFFFFFFFFFFFFF' } }), 'Forbidden: The security token included in the request is expired.'],
      [
        'a signature by another secret',
        () => signedHeaders(PRIVATE, '/', { secret: 'b'.repeat(40) }),
        'Forbidden: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.',
      ],
      ['a signature for another service', () => signedHeaders(PRIVATE, '/', { service: 's3' }), "Forbidden: Credential should be scoped to correct service: 'lambda'."],
      ['a signature made 20 minutes ago', () => signedHeaders(PRIVATE, '/', { at: new Date(Date.now() - 20 * 60_000) }), expect.stringMatching(/^Forbidden: Signature expired: \d{8}T\d{6}Z is more than 15 minutes/)],
      [
        'a session token, which FF never issues',
        async () => ({ ...(await signedHeaders(PRIVATE)), 'x-amz-security-token': 'FwoGZXIvYXdzE' }),
        'Forbidden: The security token included in the request is invalid.',
      ],
      ['an authorization that is no signature', async () => ({ authorization: 'AWS4-HMAC-SHA256 Credential=AKFFAAAAAAAAAAAAAAAA' }), expect.stringContaining('Forbidden: Authorization header requires')],
    ])('refuses %s with 403, calling nothing', async (_case, signed, message) => {
      const answer = await send(PRIVATE, '/', { headers: await signed() });

      expect([answer.status, answer.message]).toEqual([403, message]);
      expect(functions.call).not.toHaveBeenCalled();
      expect(directory.touch).not.toHaveBeenCalled();
    });

    it('refuses a body other than the one signed', async () => {
      const headers = await signedHeaders(PRIVATE, '/', { method: 'POST', body: '{"amount":1}' });

      const answer = await send(PRIVATE, '/', { method: 'POST', headers, body: '{"amount":1000}' });

      expect([answer.status, answer.message]).toEqual([403, expect.stringContaining('The request signature we calculated does not match')]);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<ActiveKey>, string]>([
      ["another account's key, rightly signed: as good as none, saying nothing of whose the URL is", { accountId: '999999999999' }, 'Forbidden'],
      ['a key that names other functions', { functions: ['billing'] }, "Forbidden: the access key ci-invoker (AKFFCCCCCCCCCCCCCCCC) doesn't reach this URL's function"],
      ['a key made before keys reached functions, named by its ID', { name: null, buckets: ['photos'], functions: null, functionAccess: null }, "Forbidden: the access key AKFFCCCCCCCCCCCCCCCC doesn't reach this URL's function"],
      ['a key that may only read the function', { functionAccess: 'read' }, "Forbidden: the access key ci-invoker (AKFFCCCCCCCCCCCCCCCC) may read this URL's function, not invoke it"],
    ])('refuses %s with 403, calling nothing', async (_case, changes, message) => {
      const key: ActiveKey = { ...ACCESS, id: 'AKFFCCCCCCCCCCCCCCCC', ...changes };
      accessKeys = [key];

      const answer = await send(PRIVATE, '/', { headers: await signedHeaders(PRIVATE, '/', { key }) });

      expect([answer.status, answer.message]).toEqual([403, message]);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it("refuses the calls of an access key whose account is not active, its key's own state", async () => {
      directory.account.mockResolvedValue({ id: ACCOUNT, status: AccountStatus.SUSPENDED, planId: 'beta' });

      const answer = await send(PRIVATE, '/', { headers: await signedHeaders(PRIVATE) });

      expect([answer.status, answer.message]).toEqual([403, 'Forbidden']);
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

  describe('CORS', () => {
    it.each(table.gateway.cors)('$title', answersAsItSays);
  });

  describe("an alias's URL", () => {
    const version2 = { version: 2, eventFormat: EventFormat.LAMBDA };

    it('calls the version its alias names, its share drawn for the call, whatever the state of $LATEST', async () => {
      functions.findOne.mockResolvedValue({ id: 'fn-p', accountId: ACCOUNT, status: FunctionStatus.ERROR, eventFormat: EventFormat.LAMBDA });
      functions.callTarget.mockResolvedValue({ version: version2, alias: 'live' });

      const answer = await send(ALIASED);

      expect([answer.status, answer.body.toString()]).toEqual([200, 'ok']);
      expect(functions.callTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-p' }), 'live');
      expect(calls()[0][2]).toMatchObject({ source: InvocationSource.URL, target: { version: version2, alias: 'live' } });
      expect(lastEvent().requestContext).toMatchObject({ apiId: ALIASED });
    });

    it("runs $LATEST's URL as the function is, naming no alias", async () => {
      await send(PUBLIC);

      expect(functions.callTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-p' }), undefined);
      expect(calls()[0][2].target).toEqual({});
    });

    it('answers 404 once its alias is gone, the URL with it; 503 for $LATEST not ACTIVE through an alias naming it, or a version that takes the wrapped event', async () => {
      functions.callTarget.mockRejectedValueOnce(new NotFoundException('The function fn-p has no alias live'));
      const gone = await send(ALIASED);
      functions.findOne.mockResolvedValueOnce({ id: 'fn-p', accountId: ACCOUNT, status: FunctionStatus.ERROR, eventFormat: EventFormat.LAMBDA });
      functions.callTarget.mockResolvedValueOnce({ alias: 'live' });
      const inactive = await send(ALIASED);
      functions.callTarget.mockResolvedValueOnce({ version: { version: 1, eventFormat: EventFormat.WRAPPED }, alias: 'live' });
      const wrapped = await send(ALIASED);

      expect([gone.status, inactive.status, wrapped.status]).toEqual([404, 503, 503]);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it('serves a domain of its own, as the URL it names', async () => {
      domains.set('api.example.tn', ALIASED);
      functions.callTarget.mockResolvedValue({ version: version2, alias: 'live' });

      const answer = await send('', '/', { headers: { host: 'api.example.tn' } });

      expect(answer.status).toBe(200);
      expect(calls()[0][2].target).toEqual({ version: version2, alias: 'live' });
      expect(lastEvent().requestContext).toMatchObject({ domainName: 'api.example.tn', apiId: ALIASED });
    });
  });

  describe("a customer's own domain", () => {
    const onDomain = (domain: string, path = '/', headers: Record<string, string> = {}) =>
      send('', path, { headers: { host: domain, ...headers } });

    it('reaches its function once verified, and the event names the domain', async () => {
      domains.set('shop.example.tn', PUBLIC);

      const answer = await onDomain('Shop.Example.TN:443', '/cart?item=1');

      expect(answer.status).toBe(200);
      expect(calls()[0][0]).toMatchObject({ id: 'fn-p' });
      expect(lastEvent().requestContext).toMatchObject({ domainName: 'shop.example.tn', domainPrefix: 'shop', apiId: PUBLIC });
      expect(lastEvent().rawPath).toBe('/cart');
    });

    it('answers 404 for a domain not verified, or whose URL is gone', async () => {
      domains.set('gone.example.tn', 'g0000000000000000000000000000001');

      expect((await onDomain('pending.example.tn')).status).toBe(404);
      expect((await onDomain('gone.example.tn')).status).toBe(404);
      expect(functions.call).not.toHaveBeenCalled();
    });

    it("leaves a function's own /tls/allowed to it on its domain", async () => {
      domains.set('shop.example.tn', PUBLIC);

      await onDomain('shop.example.tn', '/tls/allowed?domain=anything.example');

      expect(lastEvent().rawPath).toBe('/tls/allowed');
    });

    it('gets a certificate on demand once verified, and not before', async () => {
      domains.set('shop.example.tn', PUBLIC);
      const ask = (domain: string) => send('', `/tls/allowed?domain=${domain}`, { headers: { host: 'ff-backend.ff-system.svc.cluster.local:3001' } });

      expect([(await ask('shop.example.tn')).status, (await ask('pending.example.tn')).status]).toEqual([200, 404]);
    });

    it("hands a site's domain to the website server, with its bucket, whatever the path", async () => {
      siteDomains.set('docs.example.tn', { name: 'docs', website: { indexDocument: 'index.html' } });

      const answer = await onDomain('Docs.Example.TN:443', '/tls/allowed?domain=anything.example');

      expect([answer.status, answer.body.toString()]).toEqual([200, 'the site of docs']);
      expect(websites.serve).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'docs');
      expect(functions.call).not.toHaveBeenCalled();
    });

    it("gets a site's domain a certificate once verified, as a site's own host, and not before", async () => {
      siteDomains.set('docs.example.tn', { name: 'docs', website: { indexDocument: 'index.html' } });
      const ask = (domain: string) => send('', `/tls/allowed?domain=${domain}`, { headers: { host: 'ff-backend.ff-system.svc.cluster.local:3001' } });

      expect([(await ask('docs.example.tn')).status, (await ask('docs.site.localhost')).status, (await ask('nosite.site.localhost')).status]).toEqual([200, 200, 404]);
      expect(websites.serve).not.toHaveBeenCalled();
    });

    it('serves nothing, and gets no certificate, at the domain of a bucket no longer a site', async () => {
      siteDomains.set('old.example.tn', { name: 'old', website: null });
      const ask = (domain: string) => send('', `/tls/allowed?domain=${domain}`, { headers: { host: 'ff-backend.ff-system.svc.cluster.local:3001' } });

      expect([(await onDomain('old.example.tn')).status, (await ask('old.example.tn')).status]).toEqual([404, 404]);
      expect(websites.serve).not.toHaveBeenCalled();
    });
  });

  describe("the edge's question before a certificate on demand", () => {
    const ask = (domain: string | undefined, host = 'ff-backend.ff-system.svc.cluster.local:3001') =>
      send('', `/tls/allowed${domain === undefined ? '' : `?domain=${encodeURIComponent(domain)}`}`, { headers: { host } });

    it("says yes for buckets' S3 endpoint and a bucket's host, as the front door says, behind the same address", async () => {
      expect([(await ask('s3.localhost')).status, (await ask('photos.s3.localhost')).status, (await ask('nowhere.s3.localhost')).status]).toEqual([200, 200, 404]);
    });

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
