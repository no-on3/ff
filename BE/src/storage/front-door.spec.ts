import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { Bucket, BucketStatus } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { CountedRequest } from './request-tally';
import { RequestSignature, checkSignature, readSignature, signedForStore } from './sigv4';
import { ActiveKey, StorageDirectory } from './storage-directory.service';
import { StorageRequestCountsService } from './storage-request-counts.service';

const STORE_KEY = 'storekey';
const STORE_SECRET = 'store-secret';
const KEY: ActiveKey = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: '000000000001', functionId: null, buckets: null, readOnly: false, secret: 'a'.repeat(40) };
const READ_ONLY: ActiveKey = { ...KEY, id: 'AKFFBBBBBBBBBBBBBBBB', readOnly: true };
const OTHERS: ActiveKey = { ...KEY, id: 'AKFFCCCCCCCCCCCCCCCC', accountId: '000000000002' };
const NARROW: ActiveKey = { ...KEY, id: 'AKFFDDDDDDDDDDDDDDDD', buckets: ['photos'] };
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
      } else if (request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/xml' }).end('<DeleteResult><Deleted><Key>a.txt</Key></Deleted></DeleteResult>');
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
  const keys = new Map([KEY, READ_ONLY, OTHERS, NARROW].map((key) => [key.id, key]));
  const directory = {
    key: async (id: string) => keys.get(id) ?? null,
    bucket: async (name: string) => BUCKETS.find((b) => b.name === name) ?? null,
    bucketsOf: async (accountId: string) => BUCKETS.filter((b) => b.accountId === accountId),
    touch: () => undefined,
  } as unknown as StorageDirectory;
  const counts = { count: (request: CountedRequest) => counted.push(request) } as unknown as StorageRequestCountsService;
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
      minio: { endPoint: '127.0.0.1', port: storePort, useSSL: false, accessKey: STORE_KEY, secretKey: STORE_SECRET },
    });
    frontDoor = new S3FrontDoor(config, directory, counts);
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
  });

  afterAll(async () => {
    await frontDoor.onModuleDestroy();
    await new Promise<void>((resolve) => store.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    counted.length = 0;
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
    const location = await client().send(new GetBucketLocationCommand({ Bucket: 'photos' }));
    const head = await client().send(new HeadBucketCommand({ Bucket: 'photos' }));

    expect(listed.Buckets?.map((b) => b.Name)).toEqual(['photos', 'exports']);
    expect(narrow.Buckets?.map((b) => b.Name)).toEqual(['photos']);
    expect(location.LocationConstraint).toBe('tn-tunis-1');
    expect(head.$metadata.httpStatusCode).toBe(200);
    expect(seen).toEqual([]);
  });

  it("refuses, in S3's words, before the store hears of it: a wrong secret, an unknown key, another account's bucket, a bucket the key doesn't name, a write with a read-only key, none at all", async () => {
    const get = new GetObjectCommand({ Bucket: 'photos', Key: 'range.txt' });

    expect(await refused(client(KEY, 'b'.repeat(40)).send(get))).toBe('403 SignatureDoesNotMatch');
    expect(await refused(client({ ...KEY, id: 'AKFFZZZZZZZZZZZZZZZZ' }).send(get))).toBe('403 InvalidAccessKeyId');
    expect(await refused(client().send(new GetObjectCommand({ Bucket: 'theirs', Key: 'x' })))).toBe('403 AccessDenied');
    expect(await refused(client(NARROW).send(new ListObjectsV2Command({ Bucket: 'exports' })))).toBe('403 AccessDenied');
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
});
