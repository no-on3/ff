import {
  BucketLocationConstraint,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketTaggingCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeletePublicAccessBlockCommand,
  GetBucketAccelerateConfigurationCommand,
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketReplicationCommand,
  GetBucketRequestPaymentCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BadRequestException, ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { currentRequest } from '../common/request-context';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { plan } from '../plans/test-fixtures';
import { BucketEvent, BucketEvents } from './bucket-events';
import { NotificationRule } from './bucket-notifications';
import { BucketNotificationsService } from './bucket-notifications.service';
import { ChangedBy } from './bucket-changes';
import { BucketWebsitesService } from './bucket-websites.service';
import { BucketAccessService } from './bucket-access.service';
import { PublicAccessBlock } from './bucket-access';
import { Bucket, BucketStatus } from './bucket.entity';
import { BucketsService } from './buckets.service';
import { S3FrontDoor } from './front-door';
import { CountedRequest } from './request-tally';
import { RequestSignature, checkSignature, readSignature, signedForStore } from './s3-signature';
import { ActiveKey, EXPIRED, StorageDirectory } from './storage-directory.service';
import { notedUses, useLine } from './test-fixtures';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { WebsiteConfiguration } from './website';

const STORE_KEY = 'storekey';
const STORE_SECRET = 'store-secret';
const KEY: ActiveKey = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: '000000000001', name: null, functionId: null, buckets: null, queues: null, functions: null, functionAccess: null, readOnly: false, secret: 'a'.repeat(40) };
const READ_ONLY: ActiveKey = { ...KEY, id: 'AKFFBBBBBBBBBBBBBBBB', readOnly: true };
const OTHERS: ActiveKey = { ...KEY, id: 'AKFFCCCCCCCCCCCCCCCC', accountId: '000000000002' };
const NARROW: ActiveKey = { ...KEY, id: 'AKFFDDDDDDDDDDDDDDDD', buckets: ['photos'] };
/** A key that names queues alone: it reaches no bucket. */
const QUEUES_ONLY: ActiveKey = { ...KEY, id: 'AKFFEEEEEEEEEEEEEEEE', queues: ['orders'] };
/** A function's key past its end, which the directory says so of. */
const ENDED = 'AKFFFFFFFFFFFFFFFFFF';
const bucket = (name: string, accountId: string, storeName: string): Bucket =>
  Object.assign(new Bucket(), { id: `id-${name}`, accountId, name, storeName, status: BucketStatus.ACTIVE, policy: null, publicAccessBlock: null, createdAt: new Date('2026-10-23T06:00:00Z') });
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
/** How many HEADs of an object the store answers 404 before it shows it, as a store may just after its write. */
let headsBeforeShown = 0;

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
        if (!object || headsBeforeShown-- > 0) response.writeHead(404).end();
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
    key: async (id: string) => (id === ENDED ? EXPIRED : (keys.get(id) ?? null)),
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
  /** What FF's bucket service was asked, under whom the audit log would name; or the refusal it answers. Its buckets' tags. */
  const bucketChanges: string[] = [];
  let bucketRefusal: Error | undefined;
  const bucketTags = new Map<string, Record<string, string>>();
  const buckets = {
    create: async (accountId: string, dto: { name: string }, tags: Record<string, string> = {}) => {
      if (bucketRefusal) throw bucketRefusal;
      bucketChanges.push(`create ${accountId} ${dto.name}${Object.keys(tags).length ? ` ${JSON.stringify(tags)}` : ''} by ${currentRequest()?.actor?.id}`);
      return {};
    },
    tagsOf: async (bucket: Bucket) => bucketTags.get(bucket.name) ?? {},
    replaceTags: async (accountId: string, bucket: Bucket, tags: Record<string, string>) => {
      bucketChanges.push(`tags ${accountId} ${bucket.name} ${JSON.stringify(tags)} by ${currentRequest()?.actor?.id}`);
      bucketTags.set(bucket.name, tags);
    },
    remove: async (accountId: string, name: string, force: boolean) => {
      if (bucketRefusal) throw bucketRefusal;
      bucketChanges.push(`remove ${accountId} ${name} ${force ? 'forced' : 'empty'} by ${currentRequest()?.actor?.id}`);
    },
  } as unknown as BucketsService;
  /** What the buckets' policies and public access blocks got, and by whom: each kept on its bucket, as the database keeps it. */
  const accessChanges: string[] = [];
  const access = {
    keepPolicy: async (bucket: Bucket, policy: string | null, by: ChangedBy) => {
      accessChanges.push(`policy ${bucket.name} ${policy ?? 'removed'} by ${by.actor?.id}`);
      bucket.policy = policy;
    },
    keepPublicAccessBlock: async (bucket: Bucket, block: PublicAccessBlock | null, by: ChangedBy) => {
      accessChanges.push(`block ${bucket.name} ${block ? JSON.stringify(block) : 'removed'} by ${by.actor?.id}`);
      bucket.publicAccessBlock = block;
    },
  } as unknown as BucketAccessService;
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
    frontDoor = new S3FrontDoor(config, directory, counts, plans, credit, throttler, notifications, bucketEvents, websites, keyUses, buckets, access);
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
  });

  afterAll(async () => {
    await frontDoor.onModuleDestroy();
    await new Promise<void>((resolve) => store.close(() => resolve()));
  });

  beforeEach(() => {
    headsBeforeShown = 0;
    seen.length = 0;
    counted.length = 0;
    hits.clear();
    kept.length = 0;
    published.length = 0;
    keptWebsites.length = 0;
    keyUses.seen.length = 0;
    bucketChanges.length = 0;
    bucketRefusal = undefined;
    bucketTags.clear();
    accessChanges.length = 0;
    for (const each of BUCKETS) Object.assign(each, { policy: null, publicAccessBlock: null });
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

  it("refuses, in S3's words, before the store hears of it: a wrong secret, an unknown key, one past its end, another account's bucket, a bucket the key doesn't reach, a write with a read-only key, none at all", async () => {
    const get = new GetObjectCommand({ Bucket: 'photos', Key: 'range.txt' });

    expect(await refused(client(KEY, 'b'.repeat(40)).send(get))).toBe('403 SignatureDoesNotMatch');
    expect(await refused(client({ ...KEY, id: 'AKFFZZZZZZZZZZZZZZZZ' }).send(get))).toBe('403 InvalidAccessKeyId');
    expect(await refused(client({ ...KEY, id: ENDED }).send(get))).toBe('400 ExpiredToken');
    expect(await refused(client().send(new GetObjectCommand({ Bucket: 'theirs', Key: 'x' })))).toBe('403 AccessDenied');
    expect(await refused(client(NARROW).send(new ListObjectsV2Command({ Bucket: 'exports' })))).toBe('403 AccessDenied');
    expect(await refused(client(QUEUES_ONLY).send(new ListObjectsV2Command({ Bucket: 'photos' })))).toBe('403 AccessDenied');
    expect(await refused(client(READ_ONLY).send(new PutObjectCommand({ Bucket: 'photos', Key: 'x', Body: 'x' })))).toBe('403 AccessDenied');
    expect(await refused(client().send(new GetObjectCommand({ Bucket: 'nowhere', Key: 'x' })))).toBe('404 NoSuchBucket');
    expect(await refused(client().send(new PutBucketCorsCommand({ Bucket: 'photos', CORSConfiguration: { CORSRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] } })))).toBe('501 NotImplemented');
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
  describe("a bucket made and deleted through S3, by FF's bucket service", () => {
    // AWS's SDK types its regions: FF's is none of AWS's.
    const FF_REGION = 'tn-tunis-1' as BucketLocationConstraint;
    const create = (name: string, key: ActiveKey = KEY) => client(key).send(new CreateBucketCommand({ Bucket: name, CreateBucketConfiguration: { LocationConstraint: FF_REGION } }));

    it('makes one with CreateBucket, its Location its path, and deletes an empty one with DeleteBucket, 204, both under the key; the store never hears of them', async () => {
      const made = await create('albums');
      await client().send(new DeleteBucketCommand({ Bucket: 'exports' }));

      expect(made.Location).toBe('/albums');
      expect(bucketChanges).toEqual([`create ${KEY.accountId} albums by access_key:${KEY.id}`, `remove ${KEY.accountId} exports empty by access_key:${KEY.id}`]);
      expect(counted.map((request) => `${request.bucketName} ${request.class} ${request.status}`)).toEqual(['exports free 204']);
      expect(seen).toEqual([]);
    });

    it("says the service's refusals in S3's words: the plan's buckets, a name taken meanwhile, a store away, a bucket not empty", async () => {
      bucketRefusal = new BadRequestException('The Beta plan allows 5 buckets, and the account has 5: delete one first');
      const tooMany = await create('albums').then(
        () => undefined,
        (error: Error) => error,
      );
      expect([tooMany?.name, tooMany?.message]).toEqual(['TooManyBuckets', 'You have attempted to create more buckets than allowed: The Beta plan allows 5 buckets, and the account has 5: delete one first']);
      bucketRefusal = new ConflictException('The bucket name "albums" is taken');
      expect(await refused(create('albums'))).toBe('409 BucketAlreadyExists');
      bucketRefusal = new ServiceUnavailableException("The store couldn't do it");
      expect(await refused(create('albums'))).toBe('503 ServiceUnavailable');
      bucketRefusal = new ConflictException("The bucket exports isn't empty");
      expect(await refused(client().send(new DeleteBucketCommand({ Bucket: 'exports' })))).toBe('409 BucketNotEmpty');
    });

    it('makes one with the tags its configuration gives, as S3 keeps them with it', async () => {
      await client().send(
        new CreateBucketCommand({ Bucket: 'albums', CreateBucketConfiguration: { LocationConstraint: FF_REGION, Tags: [{ Key: 'team', Value: 'web' }] } }),
      );

      expect(bucketChanges).toEqual([`create ${KEY.accountId} albums {"team":"web"} by access_key:${KEY.id}`]);
    });

    it("answers a name already the account's, or another's, without asking the service; a read-only key, or one naming other buckets, AccessDenied", async () => {
      expect(await refused(create('photos'))).toBe('409 BucketAlreadyOwnedByYou');
      expect(await refused(create('theirs'))).toBe('409 BucketAlreadyExists');
      expect(await refused(create('albums', READ_ONLY))).toBe('403 AccessDenied');
      expect(await refused(create('albums', NARROW))).toBe('403 AccessDenied');
      expect(await refused(client(READ_ONLY).send(new DeleteBucketCommand({ Bucket: 'exports' })))).toBe('403 AccessDenied');
      expect(await refused(client().send(new DeleteBucketCommand({ Bucket: 'theirs' })))).toBe('403 AccessDenied');
      expect(bucketChanges).toEqual([]);
    });
  });

  describe("a bucket's tags, as S3's", () => {
    it('replaces them with PutBucketTagging, 204, under the key, and reads them with GetBucketTagging; the store never hears of them', async () => {
      await client().send(new PutBucketTaggingCommand({ Bucket: 'photos', Tagging: { TagSet: [{ Key: 'team', Value: 'web' }, { Key: 'stage', Value: '' }] } }));
      const read = await client(READ_ONLY).send(new GetBucketTaggingCommand({ Bucket: 'photos' }));

      expect(bucketChanges).toEqual([`tags ${KEY.accountId} photos {"team":"web","stage":""} by access_key:${KEY.id}`]);
      expect(read.TagSet).toEqual([
        { Key: 'team', Value: 'web' },
        { Key: 'stage', Value: '' },
      ]);
      expect(counted.map((request) => `${request.class} ${request.status}`)).toEqual(['tier1 204', 'tier2 200']);
      expect(seen).toEqual([]);
    });

    it("removes them with DeleteBucketTagging, 204; a bucket without tags answers S3's NoSuchTagSet", async () => {
      bucketTags.set('photos', { team: 'web' });

      await client().send(new DeleteBucketTaggingCommand({ Bucket: 'photos' }));

      expect(bucketChanges).toEqual([`tags ${KEY.accountId} photos {} by access_key:${KEY.id}`]);
      expect(await refused(client().send(new GetBucketTaggingCommand({ Bucket: 'photos' })))).toBe('404 NoSuchTagSet');
    });

    it("refuses a key twice, InvalidTag, nothing changed; a read-only key changes nothing; another account's bucket, AccessDenied", async () => {
      const put = (key: ActiveKey, Bucket = 'photos') =>
        refused(client(key).send(new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: [{ Key: 'team', Value: 'web' }, { Key: 'team', Value: 'shop' }] } })));

      expect(await put(KEY)).toBe('400 InvalidTag');
      expect(await refused(client(READ_ONLY).send(new DeleteBucketTaggingCommand({ Bucket: 'photos' })))).toBe('403 AccessDenied');
      expect(await refused(client().send(new GetBucketTaggingCommand({ Bucket: 'theirs' })))).toBe('403 AccessDenied');
      expect(bucketChanges).toEqual([]);
    });
  });

  describe("a bucket's settings FF's buckets don't have, read as S3 answers a bucket without them", () => {
    it("answers that there is none: no CORS, lifecycle, replication, encryption or Object Lock of its own, in S3's errors", async () => {
      const answers = await Promise.all([
        refused(client().send(new GetBucketCorsCommand({ Bucket: 'photos' }))),
        refused(client().send(new GetBucketLifecycleConfigurationCommand({ Bucket: 'photos' }))),
        refused(client().send(new GetBucketReplicationCommand({ Bucket: 'photos' }))),
        refused(client().send(new GetBucketEncryptionCommand({ Bucket: 'photos' }))),
        refused(client().send(new GetObjectLockConfigurationCommand({ Bucket: 'photos' }))),
      ]);

      expect(answers).toEqual([
        '404 NoSuchCORSConfiguration',
        '404 NoSuchLifecycleConfiguration',
        '404 ReplicationConfigurationNotFoundError',
        '404 ServerSideEncryptionConfigurationNotFoundError',
        '404 ObjectLockConfigurationNotFoundError',
      ]);
      // Each counted, as S3 bills a request it refuses, and the store never asked.
      expect(counted.map((request) => `${request.method} ${request.class} ${request.status}`)).toEqual(Array(5).fill('GET tier2 404'));
      expect(seen).toEqual([]);
    });

    it('answers the rest as S3 does for a new bucket: versioning, acceleration and logging never on, the owner paying, and owning every object without ACLs; a read-only key reads them', async () => {
      const reader = client(READ_ONLY);
      const versioning = await reader.send(new GetBucketVersioningCommand({ Bucket: 'photos' }));
      const accelerate = await reader.send(new GetBucketAccelerateConfigurationCommand({ Bucket: 'photos' }));
      const logging = await reader.send(new GetBucketLoggingCommand({ Bucket: 'photos' }));
      const payment = await reader.send(new GetBucketRequestPaymentCommand({ Bucket: 'photos' }));
      const ownership = await reader.send(new GetBucketOwnershipControlsCommand({ Bucket: 'photos' }));
      const acl = await reader.send(new GetBucketAclCommand({ Bucket: 'photos' }));

      expect([versioning.Status, versioning.MFADelete, accelerate.Status, logging.LoggingEnabled, payment.Payer]).toEqual([undefined, undefined, undefined, undefined, 'BucketOwner']);
      expect(ownership.OwnershipControls?.Rules).toEqual([{ ObjectOwnership: 'BucketOwnerEnforced' }]);
      const owner = { ID: KEY.accountId, DisplayName: KEY.accountId };
      expect([acl.Owner, acl.Grants]).toEqual([owner, [{ Grantee: { ...owner, Type: 'CanonicalUser' }, Permission: 'FULL_CONTROL' }]]);
      // Each a GET, as S3 bills it.
      expect(counted.map((request) => `${request.method} ${request.class} ${request.status}`)).toEqual(Array(6).fill('GET tier2 200'));
    });

    it("refuses another account's bucket, AccessDenied, before it answers", async () => {
      expect(await refused(client().send(new GetBucketVersioningCommand({ Bucket: 'theirs' })))).toBe('403 AccessDenied');
      expect(await refused(client().send(new GetBucketPolicyCommand({ Bucket: 'theirs' })))).toBe('403 AccessDenied');
    });
  });

  describe("a bucket's policy and public access block, kept as S3 keeps them, without effect on FF", () => {
    const POLICY = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Sid: 'site', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::photos/*' }],
    });

    it('keeps PutBucketPolicy\'s document as sent, 204, under the key, gives it back with GetBucketPolicy, and removes it with DeleteBucketPolicy; the store never hears of it', async () => {
      await client().send(new PutBucketPolicyCommand({ Bucket: 'photos', Policy: POLICY }));
      const read = await client(READ_ONLY).send(new GetBucketPolicyCommand({ Bucket: 'photos' }));
      await client().send(new DeleteBucketPolicyCommand({ Bucket: 'photos' }));

      expect(read.Policy).toBe(POLICY);
      expect(accessChanges).toEqual([`policy photos ${POLICY} by access_key:${KEY.id}`, `policy photos removed by access_key:${KEY.id}`]);
      expect(await refused(client().send(new GetBucketPolicyCommand({ Bucket: 'photos' })))).toBe('404 NoSuchBucketPolicy');
      // A PUT and a GET as S3 bills them, the DELETE free, the read of none a GET too.
      expect(counted.map((request) => `${request.method} ${request.class} ${request.status}`)).toEqual(['PUT tier1 204', 'GET tier2 200', 'DELETE free 204', 'GET tier2 404']);
      expect(seen).toEqual([]);
    });

    it("refuses a policy that isn't a JSON object with a Statement, MalformedPolicy, nothing kept; a read-only key, or another account's bucket, AccessDenied", async () => {
      const put = (Policy: string, key = KEY, Bucket = 'photos') => refused(client(key).send(new PutBucketPolicyCommand({ Bucket, Policy })));

      expect(await put('not json')).toBe('400 MalformedPolicy');
      expect(await put('{"Version": "2012-10-17"}')).toBe('400 MalformedPolicy');
      expect(await put(POLICY, READ_ONLY)).toBe('403 AccessDenied');
      expect(await put(POLICY, KEY, 'theirs')).toBe('403 AccessDenied');
      expect(await refused(client().send(new DeleteBucketPolicyCommand({ Bucket: 'theirs' })))).toBe('403 AccessDenied');
      expect(accessChanges).toEqual([]);
    });

    it("keeps PutPublicAccessBlock's four switches, any left out false, reads them back, and removes them; none, NoSuchPublicAccessBlockConfiguration", async () => {
      expect(await refused(client().send(new GetPublicAccessBlockCommand({ Bucket: 'photos' })))).toBe('404 NoSuchPublicAccessBlockConfiguration');

      await client().send(new PutPublicAccessBlockCommand({ Bucket: 'photos', PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: false } }));
      const read = await client(READ_ONLY).send(new GetPublicAccessBlockCommand({ Bucket: 'photos' }));
      await client().send(new DeletePublicAccessBlockCommand({ Bucket: 'photos' }));

      expect(read.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false });
      expect(accessChanges).toEqual([
        `block photos {"blockPublicAcls":true,"ignorePublicAcls":false,"blockPublicPolicy":false,"restrictPublicBuckets":false} by access_key:${KEY.id}`,
        `block photos removed by access_key:${KEY.id}`,
      ]);
      expect(await refused(client().send(new GetPublicAccessBlockCommand({ Bucket: 'photos' })))).toBe('404 NoSuchPublicAccessBlockConfiguration');
      expect(await refused(client(READ_ONLY).send(new DeletePublicAccessBlockCommand({ Bucket: 'photos' })))).toBe('403 AccessDenied');
      // Removing what isn't there changes nothing, as S3 answers it.
      await client().send(new DeletePublicAccessBlockCommand({ Bucket: 'photos' }));
      expect(accessChanges).toHaveLength(2);
    });
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

    it("asks the store again for a created object's size and ETag while it doesn't show the object yet, and sends the event without them after three tries", async () => {
      photos.notifications = [{ id: 'thumbs', target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], prefix: null, suffix: null }];
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      headsBeforeShown = 2;
      await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'late.txt', Body: 'hello' }));
      await frontDoor.notified();
      headsBeforeShown = 3;
      await client().send(new PutObjectCommand({ Bucket: 'photos', Key: 'never.txt', Body: 'hello' }));
      await frontDoor.notified();

      expect(records()).toEqual([
        ['ObjectCreated:Put', 'thumbs', 'late.txt', 5],
        ['ObjectCreated:Put', 'thumbs', 'never.txt', undefined],
      ]);
      expect(seen.filter((request) => request.method === 'HEAD')).toHaveLength(6);
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(/^The store answered 404 to 3 HEADs of \/[^ ]+\/never\.txt after its write/));
      warned.mockRestore();
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
