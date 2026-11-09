/**
 * The SQS endpoint as AWS's SDK calls it. The requests on the wire that ff local's SQS shares, and its answers, are
 * sqs-examples.json's `frontDoor`, which its tests read too; what only FF has, its keys past their end, its accounts,
 * its plan's rate and its credit, the endpoint functions reach in the cluster, stays here.
 */
import { GetQueueUrlCommand, ReceiveMessageCommand, SQSClient, SQSServiceException, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { AccountStatus } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { ActiveKey, EXPIRED, StorageDirectory } from '../storage/storage-directory.service';
import { notedUses, useLine } from '../storage/test-fixtures';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { CustomerQueues } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueRequestCounts } from './queue-request-counts.service';
import { QueueStore } from './queue-store';
import { Queue, QueueKind } from './queue.entity';
import { DEFAULT_SETTINGS } from './sqs-attributes';
import { SqsFrontDoor } from './sqs-front-door';
import { SqsOperations } from './sqs-operations';

const BASE = 'http://localhost:3003';
const KEY: ActiveKey = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: '000000000001', name: null, functionId: null, buckets: null, queues: null, functions: null, functionAccess: null, readOnly: false, secret: 'a'.repeat(40) };
const OTHERS: ActiveKey = { ...KEY, id: 'AKFFCCCCCCCCCCCCCCCC', accountId: '000000000002' };
const URL_ = `${BASE}/${KEY.accountId}/orders`;
const ORDERS: Queue = Object.assign(new Queue(), {
  id: 'queue-orders',
  accountId: KEY.accountId,
  name: 'orders',
  kind: QueueKind.CUSTOMER,
  functionId: null,
  ...DEFAULT_SETTINGS,
});

type AccountRow = Awaited<ReturnType<StorageDirectory['account']>>;

/** A request on the wire and its answer, as sqs-examples.json writes them: signed by AWS's SDK, or `request` as it is sent. */
interface Wire {
  title: string;
  /** Signed with a key the account hasn't, or with the account's key and another secret; by default its own. */
  key?: 'another' | 'anotherSecret';
  operation?: string;
  input?: Record<string, unknown>;
  refused?: { status: number; type: string; queryError: string; message: string };
  request?: { method: string; headers?: Record<string, string>; body?: string };
  answer?: { status: number; type: string; queryError: string; message: string; headers?: Record<string, string> };
}

const table = JSON.parse(readFileSync(join(__dirname, 'sqs-examples.json'), 'utf8')) as { frontDoor: Record<string, Wire[]> };

/** The SDK's command for each operation the table's signed requests call. */
const COMMANDS = { GetQueueUrl: GetQueueUrlCommand, SendMessage: SendMessageCommand, ReceiveMessage: ReceiveMessageCommand };

describe("queues' SQS endpoint, as AWS's SDK calls it", () => {
  let frontDoor: SqsFrontDoor;
  let endpoint: string;
  let port: number;
  let accounts: Map<string, AccountRow>;
  let throttled: boolean;
  let creditless: boolean;
  const touched: string[] = [];
  /** What each key used, as the endpoint noted it. */
  const keyUses = notedUses();
  const queues = {
    find: jest.fn(async (accountId: string, name: string) => (accountId === KEY.accountId && name === 'orders' ? ORDERS : null)),
    send: jest.fn(async () => undefined),
    receive: jest.fn(async () => []),
  };
  /** A long poll's wait: until the client goes, as each test's wait is cut. */
  const events = { wait: jest.fn((_queueId: string, _ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))) };

  const directory = {
    // A function's key past its end, AKFFFFFF…, the directory says so of.
    key: async (id: string) => (id === 'AKFFFFFFFFFFFFFFFFFF' ? EXPIRED : ([KEY, OTHERS].find((key) => key.id === id) ?? null)),
    account: async (id: string) => accounts.get(id) ?? null,
    touch: (id: string) => void touched.push(id),
  } as unknown as StorageDirectory;
  const credit = {
    admit: async () => {
      if (!creditless) return;
      throw new InsufficientCreditException(
        { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
        { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
        { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
      );
    },
  } as unknown as CreditService;
  const throttler = {
    increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: throttled, timeToBlockExpire: throttled ? 1 : 0 }),
  } as unknown as ThrottlerStorage;
  /** A front door with these settings of the endpoint's, its database's side the tests' stand-ins. */
  const frontDoorWith = (sqs: { base: string; region: string; functionEndpoint?: string }) =>
    new SqsFrontDoor(
      new ConfigService({ sqs }),
      directory,
      new SqsOperations(
        queues as unknown as CustomerQueues,
        { accountBytes: async () => 0 } as unknown as QueueStore,
        events as unknown as QueueEvents,
        { record: async () => undefined } as unknown as AuditService,
        { count: () => undefined } as unknown as QueueRequestCounts,
        {} as ResourceTagsService,
        sqs.base,
        sqs.region,
      ),
      onePlan(),
      credit,
      throttler,
      keyUses,
    );

  beforeAll(async () => {
    frontDoor = frontDoorWith({ base: BASE, region: 'tn-tunis-1' });
    port = (await frontDoor.listen(0, '127.0.0.1')).port;
    endpoint = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    accounts = new Map<string, AccountRow>([
      [KEY.accountId, { id: KEY.accountId, status: AccountStatus.ACTIVE, planId: 'beta', storageDisabledAt: null, storageDisabledReason: null, bucketStorageNotice: null }],
    ]);
    throttled = false;
    creditless = false;
  });

  afterAll(() => frontDoor.onModuleDestroy());

  const client = (key: Pick<ActiveKey, 'id' | 'secret'> = KEY) =>
    new SQSClient({ endpoint, region: 'tn-tunis-1', credentials: { accessKeyId: key.id, secretAccessKey: key.secret }, maxAttempts: 1 });

  /** The SDK's error for a request, as a customer's code sees it: its name, its query code, its status and its message. */
  async function failure(send: Promise<unknown>): Promise<{ name: string; code: unknown; status?: number; message: string; requestId?: string }> {
    try {
      await send;
    } catch (error) {
      if (!(error instanceof SQSServiceException)) throw error;
      return { name: error.name, code: (error as unknown as { Code?: string }).Code, status: error.$metadata.httpStatusCode, message: error.message, requestId: error.$metadata.requestId };
    }
    throw new Error('not refused');
  }

  /** A request as raw HTTP: its status, its headers and its JSON body. */
  function raw(options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, unknown>; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/', method: options.method ?? 'POST', headers: options.headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> }));
      });
      request.on('error', reject);
      request.end(options.body);
    });
  }

  /** The keys the table's `key` names: one the account hasn't, and the account's with another secret. */
  const KEYS = { another: { id: 'AKFFZZZZZZZZZZZZZZZZ', secret: KEY.secret }, anotherSecret: { id: KEY.id, secret: 'b'.repeat(40) } };

  /**
   * Each case of the table's group: a signed request's refusal as the SDK names it, the query code its x-amzn-query-error
   * header gives; or a request as it is sent, its answer's status, the names and message of its body and header, and the
   * headers the table names. Each is named by its title.
   */
  async function answersAsTheTableSays(group: string): Promise<void> {
    for (const example of table.frontDoor[group]) {
      if (example.request) {
        const { status, body, headers } = await raw(example.request);
        const expected = example.answer!;
        expect([example.title, { status, type: String(body.__type).replace('com.amazonaws.sqs#', ''), queryError: headers['x-amzn-query-error'], message: body.message }]).toEqual([
          example.title,
          { status: expected.status, type: expected.type, queryError: expected.queryError, message: expected.message },
        ]);
        expect([example.title, headers]).toEqual([example.title, expect.objectContaining(expected.headers ?? {})]);
        continue;
      }
      const Command = COMMANDS[example.operation as keyof typeof COMMANDS] as unknown as new (input: object) => GetQueueUrlCommand;
      const { name, code, status, message } = await failure(client(example.key ? KEYS[example.key] : KEY).send(new Command(example.input ?? {})));
      const refused = example.refused!;
      expect([example.title, { name, code, status, message }]).toEqual([
        example.title,
        { name: refused.type, code: refused.queryError.split(';')[0], status: refused.status, message: refused.message },
      ]);
    }
  }

  it("answers a request signed with the account's key, with its request ID, and writes the key's use down, and what it used", async () => {
    const answer = await client().send(new GetQueueUrlCommand({ QueueName: 'orders' }));
    expect(answer.QueueUrl).toBe(URL_);
    expect(answer.$metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(touched).toContain(KEY.id);
    expect(keyUses.seen.map(useLine)).toContain(`${KEY.id} sqs orders GetQueueUrl`);
  });

  it("answers a queue's URL under functions' own endpoint for a request to its host, inside the cluster, and under FF_SQS_BASE for any other", async () => {
    // The port first, so that functions' endpoint can name it: the same server, called by two names.
    const probe = createServer();
    const free = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)));
    await new Promise((resolve) => probe.close(resolve));
    const inCluster = frontDoorWith({ base: BASE, region: 'tn-tunis-1', functionEndpoint: `http://127.0.0.1:${free}` });
    await inCluster.listen(free, '127.0.0.1');
    const urlAt = async (at: string) => {
      const sqs = new SQSClient({ endpoint: at, region: 'tn-tunis-1', credentials: { accessKeyId: KEY.id, secretAccessKey: KEY.secret }, maxAttempts: 1 });
      try {
        return (await sqs.send(new GetQueueUrlCommand({ QueueName: 'orders' }))).QueueUrl;
      } finally {
        sqs.destroy();
      }
    };
    try {
      expect(await urlAt(`http://127.0.0.1:${free}`)).toBe(`http://127.0.0.1:${free}/${KEY.accountId}/orders`);
      expect(await urlAt(`http://localhost:${free}`)).toBe(URL_);
    } finally {
      await inCluster.onModuleDestroy();
    }
  });

  it("refuses an unknown key, one past its end, and another secret, as SQS names them", async () => {
    await answersAsTheTableSays('keys');
    // A function's key past its end, which only FF has.
    expect(await failure(client({ id: 'AKFFFFFFFFFFFFFFFFFF', secret: KEY.secret }).send(new GetQueueUrlCommand({ QueueName: 'orders' })))).toMatchObject({
      name: 'ExpiredToken',
      status: 403,
      message: 'The security token included in the request is expired',
    });
  });

  it("names a queue that isn't there, or another account's, by SQS's both names for it", async () => {
    await answersAsTheTableSays('notThere');
    expect((await failure(client().send(new GetQueueUrlCommand({ QueueName: 'gone' })))).requestId).toMatch(/^[0-9a-f-]{36}$/);
    accounts.set(OTHERS.accountId, { ...accounts.get(KEY.accountId), id: OTHERS.accountId } as AccountRow);
    expect((await failure(client(OTHERS).send(new SendMessageCommand({ QueueUrl: URL_, MessageBody: 'not theirs' })))).name).toBe('QueueDoesNotExist');
  });

  it("refuses every key of an account that isn't active, or whose queues FF turned off, saying why", async () => {
    accounts.set(KEY.accountId, { ...accounts.get(KEY.accountId), status: AccountStatus.SUSPENDED } as AccountRow);
    expect(await failure(client().send(new GetQueueUrlCommand({ QueueName: 'orders' })))).toMatchObject({
      name: 'AccessDenied',
      status: 403,
      message: 'The account is suspended: its queues answer no key.',
    });
    accounts.set(KEY.accountId, { ...accounts.get(KEY.accountId), status: AccountStatus.ACTIVE, storageDisabledAt: new Date(), storageDisabledReason: 'unpaid invoice' } as AccountRow);
    expect((await failure(client().send(new GetQueueUrlCommand({ QueueName: 'orders' })))).message).toBe(
      "FF turned the account's databases, buckets and queues off: unpaid invoice",
    );
  });

  it("refuses requests past the plan's queue requests per second, as SQS throttles", async () => {
    throttled = true;
    expect(await failure(client().send(new GetQueueUrlCommand({ QueueName: 'orders' })))).toMatchObject({
      name: 'RequestThrottled',
      status: 400,
      message: `Rate exceeded: the ${plan().name} plan allows ${plan().limits.queueRequestsPerSecond} requests to the queues a second.`,
    });
  });

  it('refuses sending without credit, and goes on receiving', async () => {
    creditless = true;
    expect(await failure(client().send(new SendMessageCommand({ QueueUrl: URL_, MessageBody: 'later' })))).toMatchObject({
      name: 'AccessDenied',
      message: 'The account is out of credit: its messages are received and deleted, and sending waits for credit.',
    });
    expect(queues.send).not.toHaveBeenCalled();
    await expect(client().send(new ReceiveMessageCommand({ QueueUrl: URL_ }))).resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });
  });

  it("refuses a request that isn't signed, with SQS's error and its query code in x-amzn-query-error", async () => {
    await answersAsTheTableSays('unsigned');
    const [unsigned] = table.frontDoor.unsigned;
    expect((await raw(unsigned.request!)).headers['x-amzn-requestid']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers what isn't SQS's JSON protocol as an operation it doesn't support", async () => {
    await answersAsTheTableSays('protocol');
  });

  it('refuses a body over 3 MiB before reading it', async () => {
    await answersAsTheTableSays('tooLarge');
  });

  it('answers an unexpected failure as InternalError, and logs it', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    queues.find.mockRejectedValueOnce(new Error('the database went away'));
    expect(await failure(client().send(new GetQueueUrlCommand({ QueueName: 'orders' })))).toMatchObject({ name: 'InternalError', status: 500 });
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^An SQS request failed \(request [0-9a-f-]{36}\): the database went away$/), expect.any(String));
    logged.mockRestore();
  });

  it("ends a long poll when its client goes, and when the backend stops", async () => {
    const abort = new AbortController();
    const polling = client().send(new ReceiveMessageCommand({ QueueUrl: URL_, WaitTimeSeconds: 20 }), { abortSignal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.wait).toHaveBeenCalled();
    const [, , signal] = events.wait.mock.calls[events.wait.mock.calls.length - 1];
    abort.abort();
    await expect(polling).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(true);

    const second = client().send(new ReceiveMessageCommand({ QueueUrl: URL_, WaitTimeSeconds: 20 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await frontDoor.onModuleDestroy();
    await expect(second).resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
