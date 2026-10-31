import {
  CopyObjectCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketWebsiteCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { plan } from '../plans/test-fixtures';
import { BucketEvent, BucketEvents } from './bucket-events';
import { NotificationRule } from './bucket-notifications';
import { BucketNotificationsService, ChangedBy } from './bucket-notifications.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { Bucket, BucketStatus } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { CountedRequest } from './request-tally';
import { RequestSignature, checkSignature, readSignature, signedForStore } from './sigv4';
import { ActiveKey, StorageDirectory } from './storage-directory.service';
import { notedUses, useLine } from './test-fixtures';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { WebsiteConfiguration } from './website';

const STORE_KEY = 'storekey';
const STORE_SECRET = 'store-secret';
const KEY: ActiveKey = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: '000000000001', functionId: null, buckets: null, queues: null, readOnly: false, secret: 'a'.repeat(40) };
const READ_ONLY: ActiveKey = { ...KEY, id: 'AKFFBBBBBBBBBBBBBBBB', readOnly: true };
const OTHERS: ActiveKey = { ...KEY, id: 'AKFFCCCCCCCCCCCCCCCC', accountId: '000000000002' };
const NARROW: ActiveKey = { ...KEY, id: 'AKFFDDDDDDDDDDDDDDDD', buckets: ['photos'] };
/** A key that names queues alone: it reaches no bucket. */
const QUEUES_ONLY: ActiveKey = { ...KEY, id: 'AKFFEEEEEEEEEEEEEEEE', queues: ['orders'] };
const bucket = (name: string, accountId: string, storeName: string): Bucket =>
  Object.assign(new Bucket(), { id: `id-${name}`, accountId, name, storeName, status: BucketStatus.ACTIVE, createdAt: new Date('2026-10-23T06:00:00Z') });
const BUCKETS = [bucket('photos', KEY.accountId, 'ff-000000000000000000000001'), bucket('exports', KEY.accountId, 'ff-000000000000000000000002'), bucket('theirs', OTHERS.accountId, 'ff-000000000000000000000003')];

/** What the store got: each request, as it came, and whether its body arrived whole. */
interface StoreRequestSeen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
  complete: boolean;
}

/**
 * A store in memory that checks FF's own signature to it, as any S3 store
 * would, keeps what is put, and lists it in its own name for the bucket.
 */
function fakeStore(seen: StoreRequestSeen[]): Server {
  const objects = new Map<string, Buffer>();
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('close', () => {
      if (!request.complete) seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks), complete: false });
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body, complete: true });
      const [rawPath, rawQuery = ''] = (request.url ?? '/').split('?');
      const signature = readSignature(request.headers, new URLSearchParams(rawQuery)) as RequestSignature;
      try {
        checkSignature({ method: request.method ?? '', rawPath, rawQuery, rawHeaders: request.rawHeaders }, signature, STORE_SECRET, new Date());
      } catch {
        response.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      const [, storeName, ...key] = rawPath.split('/');
      const name = `${storeName}/${decodeURIComponent(key.join('/'))}`;
      if (request.method === 'PUT' && request.headers['x-amz-copy-source']) {
        const source = decodeURIComponent((request.headers['x-amz-copy-source'] as string).replace(/^\//, ''));
        objects.set(name, objects.get(source) ?? Buffer.alloc(0));
        response.writeHead(200, { 'content-type': 'application/xml' }).end(`<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>`);
      } else if (request.method === 'PUT') {
        objects.set(name, body);
        response.writeHead(200, { etag: '"etag-1"', 'x-amz-checksum-crc32': 'must-not-reach-the-client' }).end();
      } else if (request.method === 'GET' && key.length) {
        const object = objects.get(name);
        if (!object) {
          response.writeHead(404, { 'content-type': 'application/xml' }).end(`<Error><Code>NoSuchKey</Code><BucketName>${storeName}</BucketName></Error>`);
          return;
        }
        const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '');
        const part = range ? object.subarray(Number(range[1]), Number(range[2]) + 1) : object;
        response.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': part.length, etag: '"etag-1"', 'x-amz-meta-owner': 'me' }).end(part);
      } else if (request.method === 'GET') {
        const keys = [...objects.keys()].filter((object) => object.startsWith(`${storeName}/`)).map((object) => object.slice(storeName.length + 1));
        response
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${storeName}</Name><KeyCount>${keys.length}</KeyCount>${keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      } else if (request.method === 'HEAD' && key.length) {
        const object = objects.get(name);
        if (!object) response.writeHead(404).end();
        else response.writeHead(200, { 'content-length': object.length, etag: '"etag-1"' }).end();
      } else if (request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/xml' }).end('<DeleteResult><Deleted><Key>a.txt</Key></Deleted></DeleteResult>');
      } else if (request.method === 'DELETE' && key.length) {
        objects.delete(name);
        response.writeHead(204).end();
      } else {
        response.writeHead(204).end();
      }
    });
  });
}

const listening = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
};

describe('the S3 front door, as AWS\'s SDK for JavaScript calls it', () => {
  let store: Server;
  let frontDoor: S3FrontDoor;
  let endpoint: string;
  const seen: StoreRequestSeen[] = [];
  const counted: CountedRequest[] = [];
  const keys = new Map([KEY, READ_ONLY, OTHERS, NARROW, QUEUES_ONLY].map((key) => [key.id, key]));
  const directory = {
    key: async (id: string) => keys.get(id) ?? null,
    bucket: async (name: string) => BUCKETS.find((b) => b.name === name) ?? null,
    bucketsOf: async (accountId: string) => BUCKETS.filter((b) => b.accountId === accountId),
    touch: () => undefined,
  } as unknown as StorageDirectory;
  const counts = { count: (request: CountedRequest) => counted.push(request) } as unknown as StorageRequestCountsService;
  const accounts = new Map(
    [KEY.accountId, OTHERS.accountId].map((id) => [id, { id, status: AccountStatus.ACTIVE, planId: 'beta', storageDisabledAt: null as Date | null, storageDisabledReason: null as string | null }]),
  );
  Object.assign(directory, { account: async (id: string) => accounts.get(id) ?? null });
  let currentPlan: PlanView = plan();
  const plans = { get: async () => currentPlan } as unknown as PlansService;
  const outOfCredit = new Set<string>();
  const credit = {
    admit: async (accountId: string) => {
      if (outOfCredit.has(accountId)) throw Object.create(InsufficientCreditException.prototype) as InsufficientCreditException;
    },
  } as unknown as CreditService;
  /** The throttler's storage, as its in-memory one counts: hits per key in the window. */
  const hits = new Map<string, number>();
  const throttler = {
    increment: async (key: string, _ttl: number, limit: number) => {
      const total = (hits.get(key) ?? 0) + 1;
      hits.set(key, total);
      return { totalHits: total, timeToExpire: 1, isBlocked: total > limit, timeToBlockExpire: 1 };
    },
  };
  /** What the bucket's notifications got: each configuration kept, and each event published. */
  const kept: Array<[Bucket, NotificationRule[], unknown]> = [];
  const notifications = { keep: async (bucket: Bucket, rules: NotificationRule[], options: unknown) => void kept.push([bucket, rules, options]) } as unknown as BucketNotificationsService;
  const published: BucketEvent[] = [];
  const bucketEvents = { publish: async (event: BucketEvent) => void published.push(event) } as unknown as BucketEvents;
  /** What the buckets' website configurations got: each kept, or removed, and by whom. */
  const keptWebsites: Array<[string, WebsiteConfiguration | null, ChangedBy]> = [];
  const websites = { keep: async (bucket: Bucket, website: WebsiteConfiguration | null, by: ChangedBy) => void keptWebsites.push([bucket.name, website, by]) } as unknown as BucketWebsitesService;
  /** What each key used, as the front door noted it. */
  const keyUses = notedUses();
  const client = (key: ActiveKey = KEY, secret = key.secret) =>
    new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: key.id, secretAccessKey: secret }, maxAttempts: 1 });
  /** The SDK's error for a refused call: its name and status. */
  const refused = async (call: Promise<unknown>) => {
    try {
      await call;
      return 'accepted';
    } catch (error) {
      const failure = error as { name: string; $metadata?: { httpStatusCode?: number } };
      return `${failure.$metadata?.httpStatusCode} ${failure.name}`;
    }
  };

  beforeAll(async () => {
    store = fakeStore(seen);
    const storePort = await listening(store);
    const config = new ConfigService({
      storage: { base: 'http://s3.example.test:3002', region: 'tn-tunis-1' },
      objectStore: { endPoint: '127.0.0.1', port: storePort, useSSL: false, accessKey: STORE_KEY, secretKey: STORE_SECRET },
    });
    frontDoor = new S3FrontDoor(config, directory, counts, plans, credit, throttler, notifications, bucketEvents, websites, keyUses);
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
  });

  afterAll(async () => {
    await frontDoor.onModuleDestroy();
    await new Promise<void>((resolve) => store.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    counted.length = 0;
    hits.clear();
    kept.length = 0;
    published.length = 0;
    keptWebsites.length = 0;
    keyUses.seen.length = 0;
  });

  it("notes what each key used, by S3's names, for the export's roles: a bucket, a copy's source as a read of it, the account's list, nothing refused", async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'noted.txt', Body: 'noted' }));
    await client().send(new CopyObjectCommand({ Bucket: 'exports', Key: 'noted.txt', CopySource: 'photos/noted.txt' }));
    await client().send(new ListBucketsCommand({}));
    await client(READ_ONLY).send(new GetObjectCommand({ Bucket: 'photos', Key: 'noted.txt' }));
    await refused(client(READ_ONLY).send(new PutObjectCommand({ Bucket: 'photos', Key: 'refused.txt', Body: 'no' })));
    await refused(client(NARROW).send(new GetObjectCommand({ Bucket: 'exports', Key: 'noted.txt' })));
    await refused(client().send(new GetObjectCommand({ Bucket: 'theirs', Key: 'noted.txt' })));

    expect(keyUses.seen.map(useLine)).toEqual([
      `${KEY.id} s3 photos PutObject`,
      `${KEY.id} s3 exports CopyObject`,
      `${KEY.id} s3 photos GetObject`,
      `${KEY.id} s3 (the account) ListBuckets`,
      `${READ_ONLY.id} s3 photos GetObject`,
    ]);
    // Nothing left in the buckets that other tests list.
    for (const Bucket of ['photos', 'exports']) await client().send(new DeleteObjectCommand({ Bucket, Key: 'noted.txt' }));
  });

  it("puts a string, its SHA-256 and CRC-32 checked, and the store gets the object under its own name, FF's signature, no checksum", async () => {
    const put = await client().send(new PutObjectCommand({ Bucket: 'photos', Key: '2026/a b.txt', Body: 'Hello, Tunis', ContentType: 'text/plain' }));

    expect(put.ETag).toBe('"etag-1"');
    expect(put.ChecksumCRC32).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/ff-000000000000000000000001/2026/a%20b.txt', complete: true });
    expect(seen[0].body.toString()).toBe('Hello, Tunis');
    expect(seen[0].headers).toMatchObject({ 'content-type': 'text/plain', 'content-length': '12', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' });
    expect(seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=storekey\//);
    expect(Object.keys(seen[0].headers).filter((name) => /checksum/.test(name))).toEqual([]);
    expect(counted).toEqual([expect.objectContaining({ bucketName: 'photos', class: 'tier1', method: 'PUT', status: 200, bytesIn: 12, bytesOut: 0 })]);
  });

  it("stores an object sent without a type as S3 does, binary/octet-stream, and a copy keeping its source's metadata as it is", async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'untyped.css', Body: 'body {}' }));
    await client().send(new CopyObjectCommand({ Bucket: 'photos', Key: 'copy.css', CopySource: 'photos/untyped.css' }));
    await client().send(new CopyObjectCommand({ Bucket: 'photos', Key: 'replaced.css', CopySource: 'photos/untyped.css', MetadataDirective: 'REPLACE' }));

    // The SDK sends a body without a type as application/octet-stream itself; a request with none at all, as the copy that
    // replaces its metadata here, would have the store guess one from the bytes, which a site would serve: text/plain for a style sheet.
    expect(seen.map((request) => request.headers['content-type'])).toEqual(['application/octet-stream', undefined, 'binary/octet-stream']);
  });

  it("puts a stream as the SDK sends one, aws-chunked with a trailing CRC-32, and the store gets the data alone, whole", async () => {
    const data = Buffer.alloc(200_000, 'z');
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'stream.bin', Body: Readable.from([data.subarray(0, 70_000), data.subarray(70_000)]), ContentLength: data.length }));

    expect(seen[0]).toMatchObject({ method: 'PUT', complete: true });
    expect(seen[0].headers['content-length']).toBe(String(data.length));
    expect(seen[0].headers['content-encoding']).toBeUndefined();
    expect(seen[0].body.equals(data)).toBe(true);
    expect(counted[0]).toMatchObject({ class: 'tier1', bytesIn: data.length });
  });

  it('gets a range, its bytes and metadata as the store sent them', async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'range.txt', Body: '0123456789' }));
    counted.length = 0;

    const got = await client().send(new GetObjectCommand({ Bucket: 'photos', Key: 'range.txt', Range: 'bytes=2-5' }));

    expect(await got.Body?.transformToString()).toBe('2345');
    expect([got.ContentLength, got.ETag, got.Metadata]).toEqual([4, '"etag-1"', { owner: 'me' }]);
    expect(seen.at(-1)?.headers.range).toBe('bytes=2-5');
    expect(counted).toEqual([expect.objectContaining({ class: 'tier2', method: 'GET', status: 206, bytesOut: 4 })]);
  });

  it("lists a bucket in the customer's name for it, never the store's", async () => {
    await client().send(new PutObjectCommand({ Bucket: 'exports', Key: 'a.csv', Body: 'a' }));

    const listed = await client().send(new ListObjectsV2Command({ Bucket: 'exports' }));

    expect([listed.Name, listed.Contents?.map((object) => object.Key)]).toEqual(['exports', ['a.csv']]);
  });

  it('copies within the account, the source named as the store names it', async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'source.txt', Body: 'copy me' }));

    await client().send(new CopyObjectCommand({ Bucket: 'exports', Key: 'copy.txt', CopySource: 'photos/source.txt' }));

    expect(seen.at(-1)?.headers['x-amz-copy-source']).toBe('/ff-000000000000000000000001/source.txt');
    expect(await refused(client().send(new CopyObjectCommand({ Bucket: 'photos', Key: 'stolen.txt', CopySource: 'theirs/secret.txt' })))).toBe('403 AccessDenied');
  });

  it('deletes a batch, its XML read whole and sent with its MD5', async () => {
    const deleted = await client().send(new DeleteObjectsCommand({ Bucket: 'photos', Delete: { Objects: [{ Key: 'a.txt' }] } }));

    expect(deleted.Deleted).toEqual([{ Key: 'a.txt' }]);
    expect(seen.at(-1)?.headers['content-md5']).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(counted.at(-1)).toMatchObject({ class: 'free', method: 'POST' });
  });

  it("answers ListBuckets, GetBucketLocation and HeadBucket itself, from FF's own records", async () => {
    const listed = await client().send(new ListBucketsCommand({}));
    const narrow = await client(NARROW).send(new ListBucketsCommand({}));
    const queuesOnly = await client(QUEUES_ONLY).send(new ListBucketsCommand({}));
    const location = await client().send(new GetBucketLocationCommand({ Bucket: 'photos' }));
    const head = await client().send(new HeadBucketCommand({ Bucket: 'photos' }));

    expect(listed.Buckets?.map((b) => b.Name)).toEqual(['photos', 'exports']);
    expect(narrow.Buckets?.map((b) => b.Name)).toEqual(['photos']);
    expect(queuesOnly.Buckets ?? []).toEqual([]);
    expect(location.LocationConstraint).toBe('tn-tunis-1');
    expect(head.$metadata.httpStatusCode).toBe(200);
    expect(seen).toEqual([]);
  });

  it("refuses, in S3's words, before the store hears of it: a wrong secret, an unknown key, another account's bucket, a bucket the key doesn't reach, a write with a read-only key, none at all", async () => {
    const get = new GetObjectCommand({ Bucket: 'photos', Key: 'range.txt' });

    expect(await refused(client(KEY, 'b'.repeat(40)).send(get))).toBe('403 SignatureDoesNotMatch');
    expect(await refused(client({ ...KEY, id: 'AKFFZZZZZZZZZZZZZZZZ' }).send(get))).toBe('403 InvalidAccessKeyId');
    expect(await refused(client().send(new GetObjectCommand({ Bucket: 'theirs', Key: 'x' })))).toBe('403 AccessDenied');
    expect(await refused(client(NARROW).send(new ListObjectsV2Command({ Bucket: 'exports' })))).toBe('403 AccessDenied');
    expect(await refused(client(QUEUES_ONLY).send(new ListObjectsV2Command({ Bucket: 'photos' })))).toBe('403 AccessDenied');
    expect(await refused(client(READ_ONLY).send(new PutObjectCommand({ Bucket: 'photos', Key: 'x', Body: 'x' })))).toBe('403 AccessDenied');
    expect(await refused(client().send(new GetObjectCommand({ Bucket: 'nowhere', Key: 'x' })))).toBe('404 NoSuchBucket');
    expect(await refused(client().send(new PutBucketPolicyCommand({ Bucket: 'photos', Policy: '{}' })))).toBe('501 NotImplemented');
    const anonymous = await fetch(`${endpoint}/photos/range.txt`);
    expect([anonymous.status, await anonymous.text()]).toEqual([403, expect.stringContaining('<Code>AccessDenied</Code>')]);
    expect(seen).toEqual([]);
    // Only a request let into a bucket of the key's own counts there: the read-only key's refused write, a 4xx in its minute.
    expect(counted.map((request) => `${request.bucketName} ${request.status}`)).toEqual(['photos 403']);
  });

  it("a read-only key reads", async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'shared.txt', Body: 'shared' }));

    expect(await (await client(READ_ONLY).send(new GetObjectCommand({ Bucket: 'photos', Key: 'shared.txt' }))).Body?.transformToString()).toBe('shared');
  });

  it("refuses every key of an account that isn't active, or whose storage FF turned off, in AWS's words for it, saying why", async () => {
    const account = accounts.get(KEY.accountId)!;
    const get = () => client().send(new ListBucketsCommand({}));
    try {
      account.status = AccountStatus.SUSPENDED;
      expect(await refused(get())).toBe('403 AccountProblem');
      account.status = AccountStatus.ACTIVE;
      account.storageDisabledAt = new Date();
      account.storageDisabledReason = 'Abuse';
      expect(await refused(get())).toBe('403 AccountProblem');
    } finally {
      Object.assign(account, { status: AccountStatus.ACTIVE, storageDisabledAt: null, storageDisabledReason: null });
    }
    expect(seen).toEqual([]);
  });

  it('out of credit, an upload waits for it; a read and a delete go on', async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'kept.txt', Body: 'kept' }));
    outOfCredit.add(KEY.accountId);
    try {
      expect(await refused(client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'more.txt', Body: 'more' })))).toBe('403 AccountProblem');
      expect(await (await client().send(new GetObjectCommand({ Bucket: 'photos', Key: 'kept.txt' }))).Body?.transformToString()).toBe('kept');
      expect(await refused(client().send(new DeleteObjectsCommand({ Bucket: 'photos', Delete: { Objects: [{ Key: 'kept.txt' }] } })))).toBe('accepted');
    } finally {
      outOfCredit.delete(KEY.accountId);
    }
  });

  it("full buckets, an upload waits for room, saying so; a read and a delete go on, and once there is room the upload goes in", async () => {
    await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'kept.txt', Body: 'kept' }));
    const account = accounts.get(KEY.accountId)!;
    const upload = () => client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'more.txt', Body: 'more' }));
    try {
      Object.assign(account, { bucketStorageNotice: 100 });
      const failure = (await upload().catch((error: unknown) => error)) as { name: string; message: string };
      expect([failure.name, failure.message]).toEqual([
        'AccountProblem',
        'There is a problem with your FF account that prevents the action from completing successfully: its buckets hold the 5,120 MB its Beta plan gives them: its files are read and deleted, and uploads wait for room.',
      ]);
      expect(await (await client().send(new GetObjectCommand({ Bucket: 'photos', Key: 'kept.txt' }))).Body?.transformToString()).toBe('kept');
      expect(await refused(client().send(new DeleteObjectsCommand({ Bucket: 'photos', Delete: { Objects: [{ Key: 'kept.txt' }] } })))).toBe('accepted');
      Object.assign(account, { bucketStorageNotice: 80 });
      expect(await refused(upload())).toBe('accepted');
    } finally {
      Object.assign(account, { bucketStorageNotice: null });
    }
  });

  it("answers SlowDown past the plan's requests a second, the account's keys together", async () => {
    currentPlan = plan({ storageRequestsPerSecond: 3 });
    try {
      const answers = [];
      for (const key of [KEY, READ_ONLY, KEY, READ_ONLY, KEY]) answers.push(await refused(client(key).send(new ListBucketsCommand({}))));

      expect(answers).toEqual(['accepted', 'accepted', 'accepted', '503 SlowDown', '503 SlowDown']);
    } finally {
      currentPlan = plan();
    }
  });

  it("refuses a PutObject larger than the plan's largest object, before the store hears of it; a part may be larger", async () => {
    currentPlan = plan({ maxObjectMb: 1 });
    try {
      expect(await refused(client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'big.bin', Body: Buffer.alloc(1024 * 1024 + 1) })))).toBe('400 EntityTooLarge');
      expect(seen).toEqual([]);
      expect(await refused(client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'fits.bin', Body: Buffer.alloc(1024 * 1024) })))).toBe('accepted');
    } finally {
      currentPlan = plan();
    }
  });

  /** A request signed with the key, an unsigned body declared, as any client may send one. */
  const signedRequest = (headers: Record<string, string>, body: Buffer, onContinue?: () => void) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${endpoint}/photos/checked.bin`);
      const signed = signedForStore({ method: 'PUT', host: url.host, rawPath: url.pathname, rawQuery: '', headers }, { accessKeyId: KEY.id, secretAccessKey: KEY.secret, region: 'us-east-1' }, new Date());
      const request = httpRequest(url, { method: 'PUT', headers: signed }, (response) => {
        text(response).then((answer) => resolve({ status: response.statusCode ?? 0, body: answer }), reject);
      });
      request.on('error', reject);
      if (headers.expect) {
        request.on('continue', () => {
          onContinue?.();
          request.end(body);
        });
      } else {
        request.end(body);
      }
    });

  it('cuts a body whose checksum fails before its end: the store never has it whole, and the client gets BadDigest', async () => {
    const body = Buffer.alloc(300_000, 'q');

    const answer = await signedRequest({ 'content-length': String(body.length), 'x-amz-checksum-crc32': 'AAAAAA==' }, body);

    expect(answer.status).toBe(400);
    expect(answer.body).toContain('<Code>BadDigest</Code>');
    // The store sees its request closed a moment after the client has its answer: later on a busy machine.
    for (const deadline = Date.now() + 5_000; seen.length === 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((request) => [request.method, request.complete])).toEqual([['PUT', false]]);
  });

  it('lets a client that asks for "100 Continue" send its body only once it is let in', async () => {
    let continued = false;
    const body = Buffer.from('waited');

    const ok = await signedRequest({ 'content-length': String(body.length), expect: '100-continue' }, body, () => (continued = true));
    expect([ok.status, continued]).toEqual([200, true]);

    continued = false;
    keys.set(KEY.id, { ...KEY, readOnly: true });
    try {
      const refusal = await signedRequest({ 'content-length': String(body.length), expect: '100-continue' }, body, () => (continued = true));
      expect([refusal.status, continued]).toEqual([403, false]);
    } finally {
      keys.set(KEY.id, KEY);
    }
  });

  it("lets the edge get certificates for its own host and its buckets' only, whatever their case", async () => {
    const asked = ['s3.example.test', 'Photos.S3.example.test', 'nowhere.s3.example.test', 'evil.example.test', 'a.photos.s3.example.test', 'theirs.s3.example.test'];

    expect(await Promise.all(asked.map((domain) => frontDoor.allowsCertificate(domain)))).toEqual([true, true, false, false, false, true]);
  });
  describe("a bucket's website configuration, as S3's", () => {
    const photos = BUCKETS[0];

    afterEach(() => {
      photos.website = null;
    });

    it("keeps PutBucketWebsite's index and error documents under the key, the single-page setting as it was, counted as a PUT; the store never hears of it", async () => {
      photos.website = { indexDocument: 'old.html', errorDocument: null, singlePageApp: true };

      await client().send(new PutBucketWebsiteCommand({ Bucket: 'photos', WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' }, ErrorDocument: { Key: 'errors/404.html' } } }));

      expect(keptWebsites).toEqual([
        [
          'photos',
          { indexDocument: 'index.html', errorDocument: 'errors/404.html', singlePageApp: true },
          { actor: { id: `access_key:${KEY.id}`, label: `access key ${KEY.id}` }, ip: '127.0.0.1', requestId: expect.any(String) },
        ],
      ]);
      expect(counted.map((request) => [request.bucketName, request.class, request.status])).toEqual([['photos', 'tier1', 200]]);
      expect(seen).toEqual([]);
    });

    it("refuses what FF's sites don't do yet, and an index document with a slash, as S3 refuses them; a read-only key may change nothing", async () => {
      const put = (WebsiteConfiguration: ConstructorParameters<typeof PutBucketWebsiteCommand>[0]['WebsiteConfiguration'], key = KEY) =>
        refused(client(key).send(new PutBucketWebsiteCommand({ Bucket: 'photos', WebsiteConfiguration })));

      expect(await put({ RedirectAllRequestsTo: { HostName: 'example.tn' } })).toBe('501 NotImplemented');
      expect(await put({ IndexDocument: { Suffix: 'index.html' }, RoutingRules: [{ Redirect: { ReplaceKeyWith: 'b' } }] })).toBe('501 NotImplemented');
      expect(await put({ IndexDocument: { Suffix: 'pages/index.html' } })).toBe('400 InvalidArgument');
      expect(await put({ ErrorDocument: { Key: '404.html' } })).toBe('400 InvalidArgument');
      expect(await put({ IndexDocument: { Suffix: 'index.html' } }, READ_ONLY)).toBe('403 AccessDenied');
      expect(await refused(client(READ_ONLY).send(new DeleteBucketWebsiteCommand({ Bucket: 'photos' })))).toBe('403 AccessDenied');
      expect(await put({ IndexDocument: { Suffix: 'index.html' } }, OTHERS)).toBe('403 AccessDenied');
      expect(keptWebsites).toEqual([]);
    });

    it("answers GetBucketWebsite in S3's XML, which AWS's SDK reads, and S3's NoSuchWebsiteConfiguration for a bucket that is no site", async () => {
      expect(await refused(client().send(new GetBucketWebsiteCommand({ Bucket: 'photos' })))).toBe('404 NoSuchWebsiteConfiguration');

      photos.website = { indexDocument: 'index.html', errorDocument: '404 & gone.html', singlePageApp: false };
      const got = await client().send(new GetBucketWebsiteCommand({ Bucket: 'photos' }));

      expect([got.IndexDocument, got.ErrorDocument]).toEqual([{ Suffix: 'index.html' }, { Key: '404 & gone.html' }]);
      expect(got.RedirectAllRequestsTo).toBeUndefined();
      expect(await refused(client(READ_ONLY).send(new GetBucketWebsiteCommand({ Bucket: 'photos' })))).toBe('accepted');
      expect(seen).toEqual([]);
    });

    it('removes it with DeleteBucketWebsite, 204, under the key; a bucket that is no site has nothing to remove', async () => {
      await client().send(new DeleteBucketWebsiteCommand({ Bucket: 'photos' }));
      expect(keptWebsites).toEqual([]);

      photos.website = { indexDocument: 'index.html', errorDocument: null, singlePageApp: false };
      await client().send(new DeleteBucketWebsiteCommand({ Bucket: 'photos' }));

      expect(keptWebsites.map(([name, website, by]) => [name, website, by.actor?.id])).toEqual([['photos', null, `access_key:${KEY.id}`]]);
      expect(counted.map((request) => [request.class, request.status])).toEqual([
        ['free', 204],
        ['free', 204],
      ]);
    });
  });

  describe("a bucket's notifications, as S3's", () => {
    const FUNCTION_ARN = `arn:aws:lambda:tn-tunis-1:${KEY.accountId}:function:thumbnails`;
    const QUEUE_ARN = `arn:aws:sqs:tn-tunis-1:${KEY.accountId}:uploads`;
    const photos = BUCKETS[0];
    const records = () =>
      published.map((event) => {
        const { eventName, s3 } = (event as unknown as { record: { eventName: string; s3: { configurationId: string; object: Record<string, unknown> } } }).record;
        return [eventName, s3.configurationId, s3.object.key, s3.object.size];
      });

    afterEach(() => {
      photos.notifications = null;
    });

    it("answers GetBucketNotificationConfiguration in S3's XML, which AWS's SDK reads; the store never hears of it", async () => {
      photos.notifications = [
        { id: 'thumbs', target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], prefix: 'images/', suffix: '.jpg' },
        { id: 'removals', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'], prefix: null, suffix: null },
      ];

      const got = await client().send(new GetBucketNotificationConfigurationCommand({ Bucket: 'photos' }));

      expect(got.LambdaFunctionConfigurations).toEqual([
        {
          Id: 'thumbs',
          LambdaFunctionArn: FUNCTION_ARN,
          Events: ['s3:ObjectCreated:*'],
          Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'images/' }, { Name: 'suffix', Value: '.jpg' }] } },
        },
      ]);
      expect(got.QueueConfigurations).toEqual([{ Id: 'removals', QueueArn: QUEUE_ARN, Events: ['s3:ObjectRemoved:*'] }]);
      expect(seen).toEqual([]);
    });

    it("reads PutBucketNotificationConfiguration as AWS's SDK writes it, and keeps it under the key, which may skip the destinations' check", async () => {
      await client().send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: 'photos',
          NotificationConfiguration: {
            LambdaFunctionConfigurations: [{ Id: 'thumbs', LambdaFunctionArn: FUNCTION_ARN, Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'images/' }] } } }],
            QueueConfigurations: [{ QueueArn: QUEUE_ARN, Events: ['s3:ObjectRemoved:Delete'] }],
          },
          SkipDestinationValidation: true,
        }),
      );

      expect(kept).toHaveLength(1);
      const [bucket, rules, options] = kept[0];
      expect([bucket.name, rules.length]).toEqual(['photos', 2]);
      expect(rules).toEqual(
        expect.arrayContaining([
          { id: 'thumbs', target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], prefix: 'images/', suffix: null },
          { id: expect.stringMatching(/^[A-Za-z0-9+/=]+$/), target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectRemoved:Delete'], prefix: null, suffix: null },
        ]),
      );
      expect(options).toEqual({
        skipDestinationValidation: true,
        changedBy: { actor: { id: `access_key:${KEY.id}`, label: `access key ${KEY.id}` }, ip: '127.0.0.1', requestId: expect.any(String) },
      });
      expect(seen).toEqual([]);
      expect(await refused(client(READ_ONLY).send(new PutBucketNotificationConfigurationCommand({ Bucket: 'photos', NotificationConfiguration: {} })))).toBe('403 AccessDenied');
      expect(
        await refused(
          client().send(
            new PutBucketNotificationConfigurationCommand({
              Bucket: 'photos',
              NotificationConfiguration: { TopicConfigurations: [{ TopicArn: 'arn:aws:sns:tn-tunis-1:000000000001:t', Events: ['s3:ObjectCreated:*'] }] },
            }),
          ),
        ),
      ).toBe('400 InvalidArgument');
      expect(kept).toHaveLength(1);
    });

    it("sends S3's event for a write the store took to the destination of the rule that names it, a created object's with its size and ETag; none for a key no rule names", async () => {
      photos.notifications = [{ id: 'thumbs', target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], prefix: 'images/', suffix: null }];

      await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'images/red flower(1).jpg', Body: 'hello' }));
      await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'docs/a.txt', Body: 'not an image' }));
      await frontDoor.notified();

      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ kind: 'record', accountId: KEY.accountId, bucket: 'photos', rule: { id: 'thumbs' } });
      expect((published[0] as { record: unknown }).record).toEqual({
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'tn-tunis-1',
        eventTime: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        eventName: 'ObjectCreated:Put',
        userIdentity: { principalId: `AWS:${KEY.id}` },
        requestParameters: { sourceIPAddress: '127.0.0.1' },
        responseElements: { 'x-amz-request-id': expect.any(String), 'x-amz-id-2': expect.any(String) },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'thumbs',
          bucket: { name: 'photos', ownerIdentity: { principalId: KEY.accountId }, arn: 'arn:aws:s3:::photos' },
          object: { key: 'images%2Fred+flower%281%29.jpg', size: 5, eTag: 'etag-1', sequencer: expect.stringMatching(/^[0-9A-F]{18}$/) },
        },
      });
      // The object's size and ETag, asked of the store once, for the write a rule named.
      expect(seen.filter((request) => request.method === 'HEAD')).toHaveLength(1);
    });

    it('sends a copy as ObjectCreated:Copy, and a deletion as ObjectRemoved:Delete, one for each key DeleteObjects deleted', async () => {
      photos.notifications = [
        { id: 'copies', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectCreated:Copy'], prefix: null, suffix: null },
        { id: 'removals', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'], prefix: null, suffix: null },
      ];

      await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'original.txt', Body: 'abc' }));
      await client().send(new CopyObjectCommand({ Bucket: 'photos', Key: 'copy.txt', CopySource: 'photos/original.txt' }));
      await client().send(new DeleteObjectCommand({ Bucket: 'photos', Key: 'copy.txt' }));
      const deleted = await client().send(new DeleteObjectsCommand({ Bucket: 'photos', Delete: { Objects: [{ Key: 'a.txt' }] } }));
      await frontDoor.notified();

      expect(deleted.Deleted).toEqual([{ Key: 'a.txt' }]);
      expect(records()).toEqual([
        ['ObjectCreated:Copy', 'copies', 'copy.txt', 3],
        ['ObjectRemoved:Delete', 'removals', 'copy.txt', undefined],
        ['ObjectRemoved:Delete', 'removals', 'a.txt', undefined],
      ]);
    });
  });
});
