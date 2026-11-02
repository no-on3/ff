/**
 * L1: Lambda's endpoint, as AWS's tools call it: requests signed for lambda
 * by the account's keys, each checked as its operation needs (the signature,
 * the key, its level with the function, its account's state, the function's
 * account), changes counted with FF's API's, each answer with its request ID
 * and each refusal in Lambda's shape; then the requests the AWS CLI, AWS's SDK
 * for JavaScript, boto3, and Terraform's provider with OpenTofu and with
 * Terraform sent the spike's endpoint (hack/spikes/lambda/recordings),
 * replayed as they were signed.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { SignatureV4 } from '@smithy/signature-v4';
import { readFileSync, readdirSync } from 'node:fs';
import { IncomingHttpHeaders, OutgoingHttpHeaders, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Sha256 } from '../common/test-fixtures';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { ActiveKey, EXPIRED, StorageDirectory } from '../storage/storage-directory.service';
import { LambdaFrontDoor } from './lambda-front-door';
import { LambdaCall, LambdaCaller, LambdaHandler, LambdaOperations, operationOf } from './lambda-operations';

const ACCOUNT = '000000000001';
const REGION = 'tn-tunis-1';
const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function`;

const key = (id: string, more: Partial<ActiveKey>): ActiveKey => ({
  id,
  accountId: ACCOUNT,
  name: null,
  functionId: null,
  buckets: null,
  queues: null,
  functions: null,
  functionAccess: null,
  readOnly: false,
  secret: `${id.toLowerCase()}-secret`,
  ...more,
});
const WRITER = key('AKFFWRITERAAAAAAAAAA', { name: 'deploy', functions: ['*'], functionAccess: 'write' });
const READER = key('AKFFREADERAAAAAAAAAA', { name: 'reader', functions: ['orders'], functionAccess: 'read' });
const INVOKER = key('AKFFINVOKERAAAAAAAAA', { functions: ['orders'], functionAccess: 'invoke' });
/** A key to the account's buckets, queues and mail, as every key made before keys reached functions. */
const STORAGE = key('AKFFSTORAGEAAAAAAAAA', {});
const FUNCTION_KEY = key('AKFFFUNCTIONAAAAAAAA', { functionId: 'f-billing' });
const OTHERS = key('AKFFOTHERSAAAAAAAAAA', { accountId: '000000000002', name: 'deploy', functions: ['*'], functionAccess: 'write' });
/** A function's key past its end, which the directory says so of. */
const PAST = 'AKFFPASTAAAAAAAAAAAA';

/** The spike's own key, made up, which its recordings are signed with, in the account its ARNs name. */
const SPIKE = key('AKFFSPIKELAMBDA23456', { accountId: '123456789012', functions: ['*'], functionAccess: 'write', secret: 'the-spike-s-own-secret-not-a-real-one' });

const fn = (accountId: string, name: string): Function => Object.assign(new Function(), { id: `f-${name}`, accountId, name });

type AccountRow = Awaited<ReturnType<StorageDirectory['account']>>;

/** Headers in their order and case, names and values in turn: Node sends such a list as it is, which its types don't say. */
const inOrder = (headers: Array<[string, string]>): OutgoingHttpHeaders => headers.flat() as unknown as OutgoingHttpHeaders;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

describe("Lambda's endpoint (L1)", () => {
  let frontDoor: LambdaFrontDoor;
  let port: number;
  let accounts: Map<string, AccountRow>;
  let throttled: boolean;
  /** The throttler's keys counted, in order. */
  let counted: string[];
  /** The operations built, and what each was given; none built answers that FF doesn't offer it yet. */
  let built: Map<string, LambdaHandler>;
  let calls: Array<{ call: LambdaCall; caller: LambdaCaller }>;
  const touched: string[] = [];

  const directory = {
    key: async (id: string) => (id === PAST ? EXPIRED : ([WRITER, READER, INVOKER, STORAGE, FUNCTION_KEY, OTHERS, SPIKE].find((candidate) => candidate.id === id) ?? null)),
    account: async (id: string) => accounts.get(id) ?? null,
    touch: (id: string) => void touched.push(id),
  } as unknown as StorageDirectory;
  const functions = {
    // The account's two functions, orders and billing; the spike's account has every function its tools named.
    findAll: jest.fn(async (accountId: string, name: string) =>
      (accountId === ACCOUNT && ['orders', 'billing'].includes(name)) || accountId === SPIKE.accountId ? [fn(accountId, name)] : [],
    ),
  } as unknown as FunctionsService;
  const operations = { handler: (name: string) => built.get(name) } as unknown as LambdaOperations;
  const throttler = {
    increment: async (counter: string) => {
      counted.push(counter);
      return { totalHits: 1, timeToExpire: 60, isBlocked: throttled, timeToBlockExpire: throttled ? 42 : 0 };
    },
  } as unknown as ThrottlerStorage;

  /** An operation built: it answers 200 with what it was given, the call and its caller kept for the test. */
  const recording: LambdaHandler = async (call, caller) => {
    calls.push({ call, caller });
    return { status: 200, document: { operation: call.operation.name, named: caller.named ?? null, functionId: caller.function_?.id ?? null } };
  };
  const build = (...names: string[]) => names.forEach((name) => built.set(name, recording));

  beforeAll(async () => {
    frontDoor = new LambdaFrontDoor(new ConfigService({ lambda: { region: REGION } }), directory, functions, operations, onePlan(plan({ writesPerMinute: 3 })), throttler);
    port = (await frontDoor.listen(0, '127.0.0.1')).port;
  });

  beforeEach(() => {
    const active = (id: string): [string, AccountRow] => [id, { id, status: AccountStatus.ACTIVE, planId: 'beta', storageDisabledAt: null, storageDisabledReason: null, bucketStorageNotice: null }];
    accounts = new Map([active(ACCOUNT), active('000000000002'), active(SPIKE.accountId)]);
    throttled = false;
    counted = [];
    built = new Map();
    calls = [];
  });

  afterAll(() => frontDoor.onModuleDestroy());

  /** Sends a request as it goes on the wire, its path escaped as sent, with these headers. */
  function raw(method: string, target: string, headers: Record<string, string> | Array<[string, string]>, body: Buffer = Buffer.alloc(0)): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method, path: target, headers: Array.isArray(headers) ? inOrder(headers) : headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  /**
   * Sends a request signed as AWS's signers sign Lambda's: for lambda, with
   * the key's secret unless another is given, its path escaped once more.
   */
  async function send(
    method: string,
    target: string,
    { as = WRITER, body = '', secret = as.secret, sessionToken, escapePath = true }: { as?: ActiveKey; body?: string; secret?: string; sessionToken?: string; escapePath?: boolean } = {},
  ): Promise<Answer> {
    const [path, rawQuery = ''] = target.split('?');
    const signer = new SignatureV4({ service: 'lambda', region: REGION, credentials: { accessKeyId: as.id, secretAccessKey: secret, sessionToken }, sha256: Sha256, uriEscapePath: escapePath });
    const host = `127.0.0.1:${port}`;
    const headers: Record<string, string> = { host, ...(body ? { 'content-type': 'application/json' } : {}) };
    const signed = await signer.sign({ method, protocol: 'http:', hostname: '127.0.0.1', port, path, query: Object.fromEntries(new URLSearchParams(rawQuery)), headers, body });
    return raw(method, target, signed.headers, Buffer.from(body));
  }

  const refusal = (answer: Answer) => [answer.status, answer.headers['x-amzn-errortype'], answer.body.message];

  describe('answers', () => {
    it("an operation it offers but hasn't built yet, in Lambda's shape: 400 UnknownOperationException, its request ID, its type in the header", async () => {
      const answer = await send('GET', '/2015-03-31/functions/orders/configuration');

      expect(refusal(answer)).toEqual([400, 'UnknownOperationException', "FF doesn't offer GetFunctionConfiguration of Lambda's API yet."]);
      expect(answer.body.Type).toBe('User');
      expect(answer.headers['x-amzn-requestid']).toMatch(/^[0-9a-f-]{36}$/);
      expect(answer.headers['content-type']).toBe('application/json');
    });

    it("an operation it doesn't offer, by its method and its path, once the key is known to be good", async () => {
      expect(refusal(await send('GET', '/2018-10-31/layers'))).toEqual([400, 'UnknownOperationException', "FF doesn't offer this operation of Lambda's API yet: GET /2018-10-31/layers."]);
      // Unsigned, it is a request without a signature first: an unsigned request learns nothing.
      expect(refusal(await raw('GET', '/2018-10-31/layers', {}))[1]).toBe('MissingAuthenticationTokenException');
    });

    it('an operation it has, given the function as named: by its name, its ARN or its partial ARN, its qualifier from the name or the query', async () => {
      build('GetFunction');
      const named = async (target: string) => (await send('GET', target)).body;

      expect(await named('/2015-03-31/functions/orders')).toEqual({ operation: 'GetFunction', named: { name: 'orders' }, functionId: 'f-orders' });
      expect(await named(`/2015-03-31/functions/${encodeURIComponent(`${ARN}:orders:live`)}`)).toMatchObject({ named: { name: 'orders', qualifier: 'live' }, functionId: 'f-orders' });
      expect(await named(`/2015-03-31/functions/${encodeURIComponent(`${ACCOUNT}:function:orders`)}?Qualifier=3`)).toMatchObject({ named: { name: 'orders', qualifier: '3' } });
      expect(await named('/2015-03-31/functions/orders?Qualifier=%24LATEST')).toMatchObject({ named: { name: 'orders' } });
      // The SDKs' signers escape a name's colon; the path then holds %3A, which is signed as %253A.
      expect(await named('/2015-03-31/functions/orders%3Alive')).toMatchObject({ named: { name: 'orders', qualifier: 'live' } });
    });

    it("another account's function as one that doesn't exist, by its name or by its ARN, and another region's", async () => {
      build('GetFunction');

      expect(refusal(await send('GET', '/2015-03-31/functions/orders', { as: OTHERS }))).toEqual([
        404,
        'ResourceNotFoundException',
        'Function not found: arn:aws:lambda:tn-tunis-1:000000000002:function:orders',
      ]);
      expect(refusal(await send('GET', `/2015-03-31/functions/${encodeURIComponent('arn:aws:lambda:tn-tunis-1:000000000002:function:orders:live')}`))).toEqual([
        404,
        'ResourceNotFoundException',
        'Function not found: arn:aws:lambda:tn-tunis-1:000000000002:function:orders:live',
      ]);
      expect(refusal(await send('GET', `/2015-03-31/functions/${encodeURIComponent(`arn:aws:lambda:eu-west-3:${ACCOUNT}:function:orders`)}`))[2]).toBe(
        `Function not found: arn:aws:lambda:eu-west-3:${ACCOUNT}:function:orders`,
      );
      expect(refusal(await send('GET', '/2015-03-31/functions/nothing'))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:nothing`]);
      expect(calls).toEqual([]);
    });

    it('an unexpected failure as ServiceException, the service at fault, and logs it', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      built.set('GetFunction', async () => {
        throw new Error('the database went away');
      });

      const answer = await send('GET', '/2015-03-31/functions/orders');

      expect(refusal(answer)).toEqual([500, 'ServiceException', 'The AWS Lambda service encountered an internal error.']);
      expect(answer.body.Type).toBe('Service');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('the database went away'), expect.any(String));
      logged.mockRestore();
    });
  });

  describe("a key's level with the function", () => {
    beforeEach(() => build('GetFunction', 'Invoke', 'DeleteFunction', 'CreateFunction', 'ListFunctions', 'TagResource', 'ListEventSourceMappings', 'GetEventSourceMapping'));
    const status = async (method: string, target: string, as: ActiveKey, body = '') => {
      const answer = await send(method, target, { as, body });
      return answer.status === 200 ? 200 : `${answer.status} ${String(answer.body.message)}`;
    };

    it('reads at read, invokes too at invoke, changes too at write', async () => {
      const at = (as: ActiveKey) => Promise.all([status('GET', '/2015-03-31/functions/orders', as), status('POST', '/2015-03-31/functions/orders/invocations', as), status('DELETE', '/2015-03-31/functions/orders', as)]);

      expect(await at(READER)).toEqual([
        200,
        '403 The access key reader (AKFFREADERAAAAAAAAAA) may read the function orders, not invoke it.',
        '403 The access key reader (AKFFREADERAAAAAAAAAA) may read the function orders, not change it.',
      ]);
      expect(await at(INVOKER)).toEqual([200, 200, '403 The access key AKFFINVOKERAAAAAAAAA may invoke the function orders, not change it.']);
      expect(await at(WRITER)).toEqual([200, 200, 200]);
    });

    it("refuses a key that doesn't reach the function, one that reaches none, as AccessDeniedException, whether the function exists or not", async () => {
      const denied = await send('GET', '/2015-03-31/functions/billing', { as: READER });

      expect(refusal(denied)).toEqual([403, 'AccessDeniedException', "The access key reader (AKFFREADERAAAAAAAAAA) doesn't reach the function billing."]);
      expect(await status('GET', '/2015-03-31/functions/nothing', READER)).toBe("403 The access key reader (AKFFREADERAAAAAAAAAA) doesn't reach the function nothing.");
      expect(await status('GET', '/2015-03-31/functions/orders', STORAGE)).toBe("403 The access key AKFFSTORAGEAAAAAAAAA doesn't reach the function orders.");
      expect(await status('GET', '/2015-03-31/functions/', STORAGE)).toBe('403 The access key AKFFSTORAGEAAAAAAAAA reaches no function: ListFunctions needs a key that does.');
    });

    it("lets a function's own key invoke its account's functions, and nothing else", async () => {
      expect(await Promise.all(['orders', 'billing'].map((name) => status('POST', `/2015-03-31/functions/${name}/invocations`, FUNCTION_KEY)))).toEqual([200, 200]);
      expect(await status('GET', '/2015-03-31/functions/orders', FUNCTION_KEY)).toBe(
        "403 A function's own key invokes its account's functions and does nothing else with them: GetFunction needs an access key that may read them.",
      );
      expect(await status('GET', '/2015-03-31/functions/', FUNCTION_KEY)).toBe(
        "403 A function's own key invokes its account's functions and does nothing else with them: ListFunctions needs an access key that may read them.",
      );
    });

    it("reads the function from the body, a list's query, or a tag's resource, which must be an ARN; the account's operations ask a key that reaches functions", async () => {
      expect(await status('POST', '/2015-03-31/functions', WRITER, JSON.stringify({ FunctionName: 'thumbnails' }))).toBe(200);
      expect(await status('POST', '/2015-03-31/functions', READER, JSON.stringify({ FunctionName: 'thumbnails' }))).toBe(
        "403 The access key reader (AKFFREADERAAAAAAAAAA) doesn't reach the function thumbnails.",
      );
      expect(await status('POST', '/2015-03-31/functions', WRITER, '{}')).toBe('400 FunctionName is required.');
      expect(await status('GET', '/2015-03-31/event-source-mappings/?FunctionName=billing', READER)).toBe("403 The access key reader (AKFFREADERAAAAAAAAAA) doesn't reach the function billing.");
      expect(await status('GET', '/2015-03-31/event-source-mappings/', READER)).toBe(200);
      expect(await status('POST', `/2017-03-31/tags/${encodeURIComponent(`${ARN}:orders`)}`, WRITER, '{"Tags":{}}')).toBe(200);
      expect(await status('POST', '/2017-03-31/tags/orders', WRITER, '{"Tags":{}}')).toBe("400 The resource must be a function's ARN, arn:aws:lambda:<region>:<account>:function:<name>, not orders.");
      // A creation names a function that doesn't exist yet: only the operations that name one by its path find it.
      expect(calls.map(({ caller }) => caller.function_?.id ?? null)).toEqual([null, null, 'f-orders']);
    });

    it('lets a mapping\'s operations ask what the key may do with the function its record names', async () => {
      expect(await status('GET', '/2015-03-31/event-source-mappings/14e0db71-5d35-4eb5-b481-8945cf9d10c2', READER)).toBe(200);
      const [{ call, caller }] = calls;

      expect(call.groups).toEqual(['14e0db71-5d35-4eb5-b481-8945cf9d10c2']);
      expect([caller.mayUse('orders', 'read'), caller.mayUse('orders', 'write'), caller.mayUse('billing', 'read')]).toEqual([true, false, false]);
      expect(await status('GET', '/2015-03-31/event-source-mappings/14e0db71-5d35-4eb5-b481-8945cf9d10c2', STORAGE)).toBe(
        '403 The access key AKFFSTORAGEAAAAAAAAA reaches no function: GetEventSourceMapping needs a key that does.',
      );
    });
  });

  describe('the request', () => {
    it("names its key as the audit log's actor, its account, FF's region and the plan; its key's use written down", async () => {
      build('DeleteFunction');
      touched.length = 0;

      await send('DELETE', '/2015-03-31/functions/orders');
      const [{ caller }] = calls;

      expect(caller.actor).toEqual({ id: 'access_key:AKFFWRITERAAAAAAAAAA', label: 'access key AKFFWRITERAAAAAAAAAA' });
      expect([caller.accountId, caller.region, caller.plan.id, caller.key.id]).toEqual([ACCOUNT, REGION, 'beta', WRITER.id]);
      expect(touched).toEqual([WRITER.id]);
    });

    it("is refused without a signature, with a key FF doesn't know, one past its end, another secret, a path escaped once, or a session token: in Lambda's words", async () => {
      const target = '/2015-03-31/functions/orders%3Alive';

      expect(refusal(await raw('GET', target, {}))).toEqual([403, 'MissingAuthenticationTokenException', 'Missing Authentication Token']);
      expect(refusal(await send('GET', target, { as: key('AKFFUNKNOWNAAAAAAAAA', {}) }))).toEqual([403, 'UnrecognizedClientException', 'The security token included in the request is invalid.']);
      expect(refusal(await send('GET', target, { as: key(PAST, {}) }))).toEqual([403, 'ExpiredTokenException', 'The security token included in the request is expired']);
      expect(refusal(await send('GET', target, { secret: 'another' }))[1]).toBe('InvalidSignatureException');
      expect(refusal(await send('GET', target, { escapePath: false }))[1]).toBe('InvalidSignatureException');
      expect(refusal(await send('GET', target, { sessionToken: 'a-token' }))).toEqual([403, 'UnrecognizedClientException', 'The security token included in the request is invalid.']);
    });

    it("is refused for a suspended account's key, as the other front doors refuse it", async () => {
      accounts.set(ACCOUNT, { ...(accounts.get(ACCOUNT) as NonNullable<AccountRow>), status: AccountStatus.SUSPENDED });

      expect(refusal(await send('GET', '/2015-03-31/functions/orders'))).toEqual([403, 'AccessDeniedException', 'The account is suspended: its functions answer no key.']);
    });

    it("counts a change against the plan's changes a minute, under FF's API's count, and is refused past it as Lambda throttles: 429, its reason, Retry-After", async () => {
      build('DeleteFunction', 'GetFunction');

      expect((await send('DELETE', '/2015-03-31/functions/orders')).status).toBe(200);
      expect((await send('GET', '/2015-03-31/functions/orders')).status).toBe(200);
      throttled = true;
      const answer = await send('DELETE', '/2015-03-31/functions/orders');

      expect(refusal(answer)).toEqual([429, 'TooManyRequestsException', 'Rate exceeded: the Beta plan allows 3 changes per minute.']);
      expect([answer.body.Reason, answer.headers['retry-after']]).toEqual(['CallerRateLimitExceeded', '42']);
      // Reads aren't counted, as FF's API counts none.
      expect(counted).toEqual([`writes:account:${ACCOUNT}`, `writes:account:${ACCOUNT}`]);
    });

    it("is refused past its operation's limit before it is read, in Lambda's words: 50 MB of code in base64, 6 MB for any other", async () => {
      expect(refusal(await raw('POST', '/2015-03-31/functions', { 'content-length': '69905068' }))).toEqual([
        413,
        'RequestEntityTooLargeException',
        'Request must be smaller than 69905067 bytes for the CreateFunction operation',
      ]);
      expect(refusal(await raw('PUT', '/2015-03-31/functions/orders/configuration', { 'content-length': String(6 * 1024 * 1024 + 1) }))[2]).toBe(
        'Request must be smaller than 6291456 bytes for the UpdateFunctionConfiguration operation',
      );
    });

    it("is refused when its body isn't a JSON object, but for an invocation's payload, which is the function's as sent", async () => {
      build('UpdateFunctionConfiguration', 'Invoke');

      expect(refusal(await send('PUT', '/2015-03-31/functions/orders/configuration', { body: '{"Timeout": 3' }))).toEqual([
        400,
        'InvalidRequestContentException',
        expect.stringMatching(/^Could not parse request body into json: /),
      ]);
      expect(refusal(await send('PUT', '/2015-03-31/functions/orders/configuration', { body: '[1]' }))[2]).toBe('The request body must be a JSON object.');
      expect((await send('POST', '/2015-03-31/functions/orders/invocations', { body: 'not json' })).status).toBe(200);
      expect([calls[0].call.input, calls[0].call.body.toString()]).toEqual([{}, 'not json']);
    });
  });
});

/** A request the spike's endpoint recorded, as its tool signed it. */
interface Recorded {
  at: string;
  tool: string;
  method: string;
  target: string;
  path: string;
  operation: string;
  headers: Array<[string, string]>;
  /** Its body in base64, up to 64 KB; a larger one (a function's code) by its SHA-256 alone. */
  body?: string;
  bodySha256?: string;
}

describe("the requests AWS's tools sent Lambda's API, replayed as they were signed (L1)", () => {
  const recordings = join(__dirname, '../../../hack/spikes/lambda/recordings');
  /** Each tool's requests, by its recording's name: OpenTofu's sign as Terraform/1.13.0, its version of Terraform's. */
  const byTool = new Map(
    readdirSync(recordings)
      .filter((file) => file.endsWith('.requests.jsonl'))
      .map((file) => [
        file.replace('.requests.jsonl', ''),
        readFileSync(join(recordings, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Recorded),
      ]),
  );
  const recorded = [...byTool.values()].flat();
  let frontDoor: LambdaFrontDoor;
  let port: number;
  const reached: string[] = [];

  beforeAll(async () => {
    const answered: LambdaHandler = async (call) => {
      reached.push(call.operation.name);
      return { status: 200, document: {} };
    };
    const directory = {
      key: async (id: string) => (id === SPIKE.id ? SPIKE : null),
      account: async (id: string) => ({ id, status: AccountStatus.ACTIVE, planId: 'beta', storageDisabledAt: null, storageDisabledReason: null, bucketStorageNotice: null }),
      touch: () => undefined,
    } as unknown as StorageDirectory;
    const functions = { findAll: async (accountId: string, name: string) => [fn(accountId, name)] } as unknown as FunctionsService;
    const throttler = { increment: async () => ({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }) } as unknown as ThrottlerStorage;
    frontDoor = new LambdaFrontDoor(new ConfigService({ lambda: { region: REGION } }), directory, functions, { handler: () => answered } as unknown as LambdaOperations, onePlan(), throttler);
    port = (await frontDoor.listen(0, '127.0.0.1')).port;
    // The clock alone is the recording's, so that each signature's time is within its 15 minutes.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'] });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await frontDoor.onModuleDestroy();
  });

  /** Sends a request as its tool sent it: its target, its headers in their order and case, its body. */
  function replay(request: Recorded): Promise<{ status: number; type?: string }> {
    return new Promise((resolve, reject) => {
      const sent = httpRequest({ host: '127.0.0.1', port, method: request.method, path: request.target, headers: inOrder(request.headers) }, (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode ?? 0, type: response.headers['x-amzn-errortype'] as string | undefined }));
      });
      sent.on('error', reject);
      sent.end(Buffer.from(request.body ?? '', 'base64'));
    });
  }

  it('holds the five tools\' requests, every one of the 41 operations among them', () => {
    expect(Object.fromEntries([...byTool].map(([tool, requests]) => [tool, requests.length]))).toEqual({ boto3: 58, cli: 53, sdk: 58, terraform: 49, tofu: 49 });
    expect(new Set(recorded.map((request) => request.operation).filter((name) => name !== 'later')).size).toBe(41);
  });

  it('passes each signature, and takes each request to the operation the spike took it to; an operation FF leaves for later is refused saying so', async () => {
    const whole = recorded.filter((request) => request.body !== undefined);
    const outcomes: string[] = [];
    for (const request of whole) {
      jest.setSystemTime(new Date(request.at));
      reached.length = 0;
      const answer = await replay(request);
      outcomes.push(answer.status === 200 ? reached.join() : `${answer.status} ${answer.type}`);
    }

    expect(whole.length).toBe(264);
    expect(outcomes).toEqual(whole.map((request) => (request.operation === 'later' ? '400 UnknownOperationException' : request.operation)));
  });

  it('routes the three whose 6 MB of code the recordings keep by its hash alone, which a signature is not checked without', () => {
    const byHash = recorded.filter((request) => request.body === undefined);

    expect(byHash.map((request) => request.bodySha256 !== undefined)).toEqual([true, true, true]);
    expect(byHash.map((request) => operationOf(request.method, request.path)?.operation.name)).toEqual(byHash.map((request) => request.operation));
  });
});
