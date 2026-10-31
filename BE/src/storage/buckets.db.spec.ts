import 'dotenv/config';
import { CreateMultipartUploadCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { Bucket } from './bucket.entity';
import { BucketsService } from './buckets.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageKeysService } from './storage-keys.service';
import { StoreBuckets } from './store-buckets';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '710000000001';
const OTHER = '710000000002';

run("buckets and access keys, in FF's database and the store (L2)", () => {
  // The store's settings as the backend reads them, FF_OBJECT_STORE_*, alone: BE/.env's development SeaweedFS, or the CI's own.
  const objectStore = {
    endPoint: process.env.FF_OBJECT_STORE_ENDPOINT ?? 'localhost',
    port: Number(process.env.FF_OBJECT_STORE_PORT ?? 9003),
    useSSL: process.env.FF_OBJECT_STORE_USE_SSL === 'true',
    accessKey: process.env.FF_OBJECT_STORE_ACCESS_KEY ?? 'ffdevaccesskey',
    secretKey: process.env.FF_OBJECT_STORE_SECRET_KEY ?? 'ffdevsecretkey-local-only',
  };
  const config = new ConfigService({ objectStore, storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1' }, website: { base: 'https://site.example.tn' }, sqs: { base: 'https://sqs.example.tn', region: 'tn-tunis-1' }, ses: { base: 'https://email.example.tn' } });
  const store = new S3Client({
    endpoint: `${objectStore.useSSL ? 'https' : 'http'}://${objectStore.endPoint}:${objectStore.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: objectStore.accessKey, secretAccessKey: objectStore.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const exists = (storeName: string) => store.send(new HeadBucketCommand({ Bucket: storeName })).then(() => true, () => false);
  let db: ScratchDatabase;
  let storeBuckets: StoreBuckets;
  let directory: StorageDirectory;
  let audit: AuditService;
  const service = (limits = {}, buckets = storeBuckets) => new BucketsService(db.dataSource.getRepository(Bucket), buckets, onePlan(plan(limits)), audit, config);
  const keys = () => new StorageKeysService(db.dataSource.getRepository(StorageKey), directory, audit, config);
  const rowOf = (name: string) => db.dataSource.getRepository(Bucket).findOneBy({ name });
  const actions = async (accountId: string) =>
    (await db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { at: 'ASC' } })).map((entry) => `${entry.action} ${entry.resource}`);
  const unique = (name: string) => `${name}-${randomBytes(4).toString('hex')}`;
  const made: string[] = [];

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Photos', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    storeBuckets = new StoreBuckets(config);
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    directory = new StorageDirectory(db.dataSource.getRepository(Bucket), db.dataSource.getRepository(StorageKey), encryption);
    audit = new AuditService(db.dataSource.getRepository(AuditEntry));
  });

  afterAll(async () => {
    for (const row of await db.dataSource.getRepository(Bucket).find()) made.push(row.storeName);
    for (const storeName of made) {
      await storeBuckets.empty(storeName).catch(() => 0);
      await storeBuckets.delete(storeName).catch(() => undefined);
    }
    storeBuckets?.onModuleDestroy();
    store.destroy();
    await db?.drop();
  });

  it("makes a bucket in the store under a name of FF's, with its address; its name is FF's once, whoever asks", async () => {
    const name = unique('photos');

    const view = await service().create(ACCOUNT, { name });

    const row = await rowOf(name);
    expect(view).toEqual({
      name,
      status: 'active',
      region: 'tn-tunis-1',
      endpoint: 'https://s3.example.tn',
      url: `https://${name}.s3.example.tn`,
      sizeBytes: null, // not measured yet
      objects: null,
      measuredAt: null,
      siteUrl: null, // no site until its website configuration is set
      createdAt: row?.createdAt,
    });
    expect(row?.storeName).toMatch(/^ff-[0-9a-f]{24}$/);
    expect(await exists(row!.storeName)).toBe(true);
    await expect(service().create(OTHER, { name })).rejects.toThrow(new ConflictException(`The bucket name "${name}" is taken: bucket names are unique across FF, as on AWS`));
    expect(await service().list(ACCOUNT)).toEqual([view]);
    // Once measured, its view says what it held at its last measure, in the list and alone.
    for (const [hour, size] of [['2026-10-23T08:00:00Z', 10], ['2026-10-23T09:00:00Z', 7_634_423]] as const) {
      await db.dataSource.query(`INSERT INTO bucket_samples (bucket_id, hour, account_id, name, size_bytes, objects) VALUES ($1, $2, $3, $4, $5, 3)`, [row!.id, hour, ACCOUNT, name, size]);
    }
    const measured = { ...view, sizeBytes: 7_634_423, objects: 3, measuredAt: new Date('2026-10-23T09:00:00Z') };
    expect([await service().list(ACCOUNT), await service().get(ACCOUNT, name)]).toEqual([[measured], measured]);
    expect(await service().list(OTHER)).toEqual([]);
    await expect(service().get(OTHER, name)).rejects.toThrow(NotFoundException);
    expect(await actions(ACCOUNT)).toContain(`bucket.create bucket:${name}`);
  });

  it('counts the plan under a lock: of two at once past it, one is refused', async () => {
    const before = await db.dataSource.getRepository(Bucket).countBy({ accountId: OTHER });
    const results = await Promise.allSettled([service({ buckets: before + 1 }).create(OTHER, { name: unique('a') }), service({ buckets: before + 1 }).create(OTHER, { name: unique('b') })]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    expect(await db.dataSource.getRepository(Bucket).countBy({ accountId: OTHER })).toBe(before + 1);
  });

  it("makes nothing when the store can't: its row is taken back, the name free again", async () => {
    const name = unique('failing');
    const failing = Object.assign(Object.create(StoreBuckets.prototype) as StoreBuckets, { create: async () => Promise.reject(new Error('the store is away')) });

    await expect(service({}, failing).create(ACCOUNT, { name })).rejects.toThrow(ServiceUnavailableException);

    expect(await rowOf(name)).toBeNull();
  });

  it("refuses an account whose storage FF turned off, saying why", async () => {
    await db.dataSource.getRepository(Account).update({ id: OTHER }, { storageDisabledAt: new Date(), storageDisabledReason: 'Abuse' });
    try {
      await expect(service().create(OTHER, { name: unique('off') })).rejects.toThrow(new ForbiddenException("FF turned this account's databases, buckets and queues off: Abuse"));
    } finally {
      await db.dataSource.getRepository(Account).update({ id: OTHER }, { storageDisabledAt: null, storageDisabledReason: null });
    }
  });

  it('deletes an empty bucket; refuses one with files unless asked to empty it, which deletes them and the uploads under way', async () => {
    const empty = unique('empty');
    const full = unique('full');
    await service().create(ACCOUNT, { name: empty });
    await service().create(ACCOUNT, { name: full });
    const { storeName } = (await rowOf(full))!;
    for (const key of ['a.txt', 'b/c.txt']) await store.send(new PutObjectCommand({ Bucket: storeName, Key: key, Body: key }));
    await store.send(new CreateMultipartUploadCommand({ Bucket: storeName, Key: 'unfinished.bin' }));

    await service().remove(ACCOUNT, empty, false);
    await expect(service().remove(ACCOUNT, full, false)).rejects.toThrow(
      new ConflictException(`The bucket ${full} isn't empty: delete its objects first, or delete it with ?force=true, which deletes them all`),
    );
    await service().remove(ACCOUNT, full, true);

    expect([await rowOf(empty), await rowOf(full), await exists(storeName)]).toEqual([null, null, false]);
    const entry = await db.dataSource.getRepository(AuditEntry).findOneByOrFail({ accountId: ACCOUNT, action: 'bucket.delete', resource: `bucket:${full}` });
    expect(entry.details).toEqual({ name: full, store: storeName, objects: 2 });
    // The name is free again, for anyone.
    await expect(service().create(OTHER, { name: full })).resolves.toMatchObject({ name: full });
  });

  it('gives an account two access keys at most, each secret shown once and sealed, opening for the front door alone, and revokes them', async () => {
    const first = await keys().create(ACCOUNT, {});
    const second = await keys().create(ACCOUNT, { buckets: ['photos'], queues: ['orders'], readOnly: true });

    await expect(keys().create(ACCOUNT, {})).rejects.toThrow(ConflictException);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^AKFF[A-Z2-7]{16}$/),
      secretAccessKey: expect.stringMatching(/^[A-Za-z0-9+/]{40}$/),
      endpoint: 'https://s3.example.tn',
      sqsEndpoint: 'https://sqs.example.tn',
      sesEndpoint: 'https://email.example.tn',
      region: 'tn-tunis-1',
    });
    expect(await keys().list(ACCOUNT)).toEqual([
      { id: first.id, buckets: null, queues: null, readOnly: false, createdAt: expect.any(Date), lastUsedAt: null },
      { id: second.id, buckets: ['photos'], queues: ['orders'], readOnly: true, createdAt: expect.any(Date), lastUsedAt: null },
    ]);
    const row = await db.dataSource.getRepository(StorageKey).findOneByOrFail({ id: first.id });
    expect(JSON.stringify(row.secret)).not.toContain(first.secretAccessKey);
    expect(await directory.key(first.id)).toMatchObject({ accountId: ACCOUNT, secret: first.secretAccessKey, buckets: null, queues: null, readOnly: false });
    expect(await directory.key(second.id)).toMatchObject({ buckets: ['photos'], queues: ['orders'] });

    await expect(keys().revoke(OTHER, first.id)).rejects.toThrow(NotFoundException);
    await keys().revoke(ACCOUNT, first.id);

    expect(await directory.key(first.id)).toBeNull();
    await expect(keys().revoke(ACCOUNT, first.id)).rejects.toThrow(NotFoundException);
    await expect(keys().create(ACCOUNT, {})).resolves.toMatchObject({ id: expect.any(String) });
    expect((await actions(ACCOUNT)).filter((action) => action.startsWith('storage_key'))).toEqual([
      `storage_key.create storage_key:${first.id}`,
      `storage_key.create storage_key:${second.id}`,
      `storage_key.delete storage_key:${first.id}`,
      expect.stringMatching(/^storage_key\.create storage_key:AKFF/),
    ]);
  });

  it("deletes a closed account's buckets with their files, and revokes its keys", async () => {
    const name = unique('closed');
    await service().create(OTHER, { name });
    const { storeName } = (await rowOf(name))!;
    await store.send(new PutObjectCommand({ Bucket: storeName, Key: 'left.txt', Body: 'left' }));
    const key = await keys().create(OTHER, {});

    const count = await service().deleteAll(OTHER);

    expect(count).toBeGreaterThanOrEqual(1);
    expect([await rowOf(name), await exists(storeName), await directory.key(key.id)]).toEqual([null, false, null]);
    expect(await db.dataSource.getRepository(Bucket).countBy({ accountId: OTHER })).toBe(0);
    const left = await store.send(new ListObjectsV2Command({ Bucket: storeName })).catch((error: { name: string }) => error.name);
    expect(left).toBe('NoSuchBucket');
  });
});
