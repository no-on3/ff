import 'dotenv/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { CreditService } from '../billing/credit.service';
import { onePlan } from '../plans/test-fixtures';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Bucket } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { StorageDirectory } from './storage-directory.service';
import { BucketEvents } from './bucket-events';
import { BucketNotificationsService } from './bucket-notifications.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey, newStoreName } from './storage-names';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '700000000001';
const OTHER = '700000000002';
const MB = 1024 * 1024;

run("buckets' S3 front door, in front of the store, its keys and buckets in FF's database (L2)", () => {
  // The store's settings as the backend reads them, FF_OBJECT_STORE_*, alone: BE/.env's development SeaweedFS, or the CI's own.
  const objectStore = {
    endPoint: process.env.FF_OBJECT_STORE_ENDPOINT ?? 'localhost',
    port: Number(process.env.FF_OBJECT_STORE_PORT ?? 9003),
    useSSL: process.env.FF_OBJECT_STORE_USE_SSL === 'true',
    accessKey: process.env.FF_OBJECT_STORE_ACCESS_KEY ?? 'ffdevaccesskey',
    secretKey: process.env.FF_OBJECT_STORE_SECRET_KEY ?? 'ffdevsecretkey-local-only',
  };
  /** The store itself, with FF's credentials: what it really keeps. */
  const store = new S3Client({
    endpoint: `${objectStore.useSSL ? 'https' : 'http'}://${objectStore.endPoint}:${objectStore.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: objectStore.accessKey, secretAccessKey: objectStore.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
  let db: ScratchDatabase;
  let frontDoor: S3FrontDoor;
  let counts: StorageRequestCountsService;
  let endpoint: string;
  const photos = { name: `photos-${randomBytes(4).toString('hex')}`, storeName: newStoreName() };
  const theirs = { name: `theirs-${randomBytes(4).toString('hex')}`, storeName: newStoreName() };
  const key = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const client = (secret = key.secret) =>
    new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: key.id, secretAccessKey: secret }, maxAttempts: 1 });
  const stored = async (name: string) => {
    const object = await store.send(new GetObjectCommand({ Bucket: photos.storeName, Key: name }));
    return Buffer.from(await (object.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  };

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Photos', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    // A store just started answers before it can keep anything: the first bucket waits for it, 30 s at most.
    for (let tries = 0; ; tries++) {
      try {
        await store.send(new CreateBucketCommand({ Bucket: photos.storeName }));
        break;
      } catch (error) {
        if (tries >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await store.send(new CreateBucketCommand({ Bucket: theirs.storeName }));
    const buckets = db.dataSource.getRepository(Bucket);
    await buckets.save([
      { accountId: ACCOUNT, name: photos.name, storeName: photos.storeName },
      { accountId: OTHER, name: theirs.name, storeName: theirs.storeName },
    ]);
    const directory = new StorageDirectory(buckets, db.dataSource.getRepository(StorageKey), encryption);
    await db.dataSource.getRepository(StorageKey).save({ id: key.id, accountId: ACCOUNT, secret: directory.sealSecret(key.id, key.secret) });
    counts = new StorageRequestCountsService(db.dataSource.getRepository(StorageRequestCount));
    // Every account on the beta plan, with credit, and as many requests a second as it sends: the API's checks have their own tests.
    const credit = { admit: async () => undefined } as unknown as CreditService;
    const throttler = { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) };
    frontDoor = new S3FrontDoor(
      new ConfigService({ storage: { base: 'http://s3.localhost:3002', region: 'tn-tunis-1' }, objectStore }),
      directory,
      counts,
      onePlan(),
      credit,
      throttler,
      // The buckets here have no notifications, nor sites: their own suites have them.
      {} as BucketNotificationsService,
      new BucketEvents(),
      {} as BucketWebsitesService,
    );
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
  });

  afterAll(async () => {
    await frontDoor?.onModuleDestroy();
    for (const bucket of [photos, theirs]) {
      const listed = await store.send(new ListObjectsV2Command({ Bucket: bucket.storeName })).catch(() => ({ Contents: [] }));
      for (const object of listed.Contents ?? []) await store.send(new DeleteObjectCommand({ Bucket: bucket.storeName, Key: object.Key }));
      await store.send(new DeleteBucketCommand({ Bucket: bucket.storeName })).catch(() => undefined);
    }
    store.destroy();
    await db?.drop();
  });

  it("puts and gets an object, which the store keeps under its own name, byte for byte, FF's signature to it checked by the store itself", async () => {
    await client().send(new PutObjectCommand({ Bucket: photos.name, Key: 'notes/héllo world.txt', Body: 'Hello, Tunis', ContentType: 'text/plain' }));

    const got = await client().send(new GetObjectCommand({ Bucket: photos.name, Key: 'notes/héllo world.txt' }));
    expect([await got.Body?.transformToString(), got.ContentType]).toEqual(['Hello, Tunis', 'text/plain']);
    expect((await stored('notes/héllo world.txt')).toString()).toBe('Hello, Tunis');
  });

  it("puts a 6 MB stream as the SDK sends one, aws-chunked with a trailing CRC-32, and the store has the data alone", async () => {
    const data = randomBytes(6 * MB);

    await client().send(new PutObjectCommand({ Bucket: photos.name, Key: 'stream.bin', Body: Readable.from([data.subarray(0, 3 * MB), data.subarray(3 * MB)]), ContentLength: data.length }));

    const head = await client().send(new HeadObjectCommand({ Bucket: photos.name, Key: 'stream.bin' }));
    expect(head.ContentLength).toBe(data.length);
    expect(createHash('sha256').update(await stored('stream.bin')).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('reads a range, and lists by prefix and delimiter, page by page, in the bucket\'s own name', async () => {
    for (const name of ['2026/01/a.jpg', '2026/01/b.jpg', '2026/02/c.jpg', 'top.txt']) await client().send(new PutObjectCommand({ Bucket: photos.name, Key: name, Body: name }));

    const range = await client().send(new GetObjectCommand({ Bucket: photos.name, Key: '2026/01/a.jpg', Range: 'bytes=5-6' }));
    const folders = await client().send(new ListObjectsV2Command({ Bucket: photos.name, Prefix: '2026/', Delimiter: '/' }));
    const first = await client().send(new ListObjectsV2Command({ Bucket: photos.name, Prefix: '2026/', MaxKeys: 2 }));
    const second = await client().send(new ListObjectsV2Command({ Bucket: photos.name, Prefix: '2026/', MaxKeys: 2, ContinuationToken: first.NextContinuationToken }));

    expect(await range.Body?.transformToString()).toBe('01');
    expect([folders.Name, folders.CommonPrefixes?.map((p) => p.Prefix)]).toEqual([photos.name, ['2026/01/', '2026/02/']]);
    expect([first.KeyCount, first.IsTruncated, second.Contents?.map((o) => o.Key)]).toEqual([2, true, ['2026/02/c.jpg']]);
  });

  it('copies, deletes a batch, and deletes one', async () => {
    await client().send(new CopyObjectCommand({ Bucket: photos.name, Key: 'copy.txt', CopySource: `${photos.name}/top.txt` }));
    expect((await stored('copy.txt')).toString()).toBe('top.txt');

    const batch = await client().send(new DeleteObjectsCommand({ Bucket: photos.name, Delete: { Objects: [{ Key: 'copy.txt' }, { Key: '2026/02/c.jpg' }] } }));
    await client().send(new DeleteObjectCommand({ Bucket: photos.name, Key: 'top.txt' }));

    expect(batch.Deleted?.map((d) => d.Key).sort()).toEqual(['2026/02/c.jpg', 'copy.txt']);
    const left = await client().send(new ListObjectsV2Command({ Bucket: photos.name }));
    expect(left.Contents?.map((o) => o.Key)).not.toEqual(expect.arrayContaining(['copy.txt', 'top.txt', '2026/02/c.jpg']));
  });

  it("uploads in two parts, its parts listed on the way, its completion naming the customer's bucket; and aborts another", async () => {
    const parts = [randomBytes(5 * MB), randomBytes(MB)];
    const upload = await client().send(new CreateMultipartUploadCommand({ Bucket: photos.name, Key: 'big.bin' }));
    const etags: string[] = [];
    for (const [n, part] of parts.entries()) {
      etags.push((await client().send(new UploadPartCommand({ Bucket: photos.name, Key: 'big.bin', UploadId: upload.UploadId, PartNumber: n + 1, Body: part }))).ETag as string);
    }
    const listed = await client().send(new ListPartsCommand({ Bucket: photos.name, Key: 'big.bin', UploadId: upload.UploadId }));
    const done = await client().send(
      new CompleteMultipartUploadCommand({
        Bucket: photos.name,
        Key: 'big.bin',
        UploadId: upload.UploadId,
        MultipartUpload: { Parts: etags.map((ETag, n) => ({ ETag, PartNumber: n + 1 })) },
      }),
    );
    const aborted = await client().send(new CreateMultipartUploadCommand({ Bucket: photos.name, Key: 'never.bin' }));
    await client().send(new AbortMultipartUploadCommand({ Bucket: photos.name, Key: 'never.bin', UploadId: aborted.UploadId }));

    expect([upload.Bucket, listed.Parts?.map((p) => p.Size), done.Bucket]).toEqual([photos.name, [5 * MB, MB], photos.name]);
    expect(done.Location).toBe(`http://127.0.0.1:${new URL(endpoint).port}/${photos.name}/big.bin`);
    expect((await stored('big.bin')).equals(Buffer.concat(parts))).toBe(true);
  });

  it("refuses a wrong secret and another account's bucket, the store untouched", async () => {
    const refused = async (call: Promise<unknown>) => call.then(() => 'accepted', (error: { name: string }) => error.name);

    expect(await refused(client('x'.repeat(40)).send(new PutObjectCommand({ Bucket: photos.name, Key: 'bad.txt', Body: 'bad' })))).toBe('SignatureDoesNotMatch');
    expect(await refused(client().send(new PutObjectCommand({ Bucket: theirs.name, Key: 'bad.txt', Body: 'bad' })))).toBe('AccessDenied');
    expect(await refused(stored('bad.txt'))).toBe('NoSuchKey');
  });

  it("writes the requests' minutes, by AWS's classes, and when the key was last used", async () => {
    await counts.flush();

    const rows = await db.dataSource.query(
      `SELECT class, sum(requests)::int AS requests, sum(bytes_in)::bigint > 0 AS uploaded, sum(bytes_out)::bigint > 0 AS downloaded, sum(errors4xx)::int AS refused
         FROM storage_request_counts WHERE name = $1 AND writer = $2 GROUP BY class ORDER BY class`,
      [photos.name, counts.writer],
    );
    expect(rows).toEqual([
      { class: 'free', requests: 3, uploaded: true, downloaded: true, refused: 0 },
      { class: 'tier1', requests: expect.any(Number), uploaded: true, downloaded: true, refused: 0 },
      { class: 'tier2', requests: expect.any(Number), uploaded: false, downloaded: true, refused: 0 },
    ]);
    expect(rows[1].requests).toBeGreaterThanOrEqual(13);
    expect((await db.dataSource.getRepository(StorageKey).findOneByOrFail({ id: key.id })).lastUsedAt).toBeInstanceOf(Date);
  });
});
