/**
 * L2: customers' buckets measured every hour (ADR 0009, §8), on real servers:
 * FF's own PostgreSQL keeps the samples, in a scratch database dropped
 * afterwards, and the S3 store holds the buckets, as the backend reaches it
 * (FF_OBJECT_STORE_*: BE/.env's development SeaweedFS, or the CI's own). Past the plan's
 * storage, its owners told and uploads waiting for room, as the front door
 * reads the account; files deleted, and uploads let in again within a minute.
 */
import 'dotenv/config';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { HOUR_MS, hourOf } from '../billing/rating-hours';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlanLimits } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { Bucket } from './bucket.entity';
import { BucketSamplesService } from './bucket-samples.service';
import { BucketsService } from './buckets.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StoreBuckets } from './store-buckets';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '730000000001';
const SUSPENDED = '730000000002';
const CLOSED = '730000000003';
const OWNER = 'owner@buckets.test';
const MIB = 1_048_576;

run("customers' buckets measured every hour (L2, ADR 0009)", () => {
  const objectStore = {
    endPoint: process.env.FF_OBJECT_STORE_ENDPOINT ?? 'localhost',
    port: Number(process.env.FF_OBJECT_STORE_PORT ?? 9003),
    useSSL: process.env.FF_OBJECT_STORE_USE_SSL === 'true',
    accessKey: process.env.FF_OBJECT_STORE_ACCESS_KEY ?? 'ffdevaccesskey',
    secretKey: process.env.FF_OBJECT_STORE_SECRET_KEY ?? 'ffdevsecretkey-local-only',
  };
  const config = new ConfigService({ objectStore, storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1' }, mail: { consoleUrl: 'https://console.example.tn' } });
  const s3 = new S3Client({
    endpoint: `${objectStore.useSSL ? 'https' : 'http'}://${objectStore.endPoint}:${objectStore.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: objectStore.accessKey, secretAccessKey: objectStore.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  let db: ScratchDatabase;
  let store: StoreBuckets;
  let directory: StorageDirectory;
  /** The plan every account is on, changed by the tests. */
  let limits: Partial<PlanLimits> = {};
  const plans = {
    forAccount: async () => plan(limits),
    forAccounts: async (ids: string[]) => new Map(ids.map((id) => [id, plan(limits)])),
  } as unknown as PlansService;
  const samples = () => new BucketSamplesService(db.dataSource, store, plans, new NotificationsService(db.dataSource, {} as AuditService, config), config);
  const unique = (name: string) => `${name}-${randomBytes(4).toString('hex')}`;
  const make = async (accountId: string, name = unique('photos')): Promise<Bucket> => {
    const buckets = new BucketsService(db.dataSource.getRepository(Bucket), store, onePlan(plan({ buckets: 10 })), new AuditService(db.dataSource.getRepository(AuditEntry)), config);
    await buckets.create(accountId, { name });
    return db.dataSource.getRepository(Bucket).findOneByOrFail({ name });
  };
  const put = (bucket: Bucket, key: string, bytes: number) => s3.send(new PutObjectCommand({ Bucket: bucket.storeName, Key: key, Body: Buffer.alloc(bytes, 7) }));
  const remove = (bucket: Bucket, key: string) => s3.send(new DeleteObjectCommand({ Bucket: bucket.storeName, Key: key }));
  const sampled = (bucketId: string) =>
    db.dataSource.query<Array<{ hour: Date; name: string; size: string; objects: string }>>(
      `SELECT hour, name, size_bytes::text AS size, objects::text AS objects FROM bucket_samples WHERE bucket_id = $1 ORDER BY hour`,
      [bucketId],
    );
  const notice = async (accountId: string) => (await db.dataSource.getRepository(Account).findOneByOrFail({ id: accountId })).bucketStorageNotice;
  const deliveries = () =>
    db.dataSource.query<Array<{ kind: string; target: string; subject: string }>>(
      `SELECT kind, target, payload ->> 'subject' AS subject FROM notification_deliveries WHERE account_id = $1 AND channel = 'email' ORDER BY created_at`,
      [A],
    );
  // The start of this hour: "10 minutes later" stays in it, whenever the suite runs.
  const t0 = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  const hour = (n: number, minutes = 0) => new Date(t0.getTime() + n * HOUR_MS + minutes * 60_000);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const accounts = db.dataSource.getRepository(Account);
    await accounts.save([
      { id: A, name: 'Photos', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: SUSPENDED, name: 'Suspended', planId: 'beta', status: AccountStatus.SUSPENDED },
      { id: CLOSED, name: 'Closed', planId: 'beta', status: AccountStatus.CLOSED, dataDeletionDueAt: new Date(Date.now() + 30 * 86_400_000) },
    ]);
    const user = await db.dataSource.getRepository(User).save({ oidcSub: 'kc-bucket-owner', email: OWNER, name: null, locale: 'en' });
    await db.dataSource.getRepository(Membership).save({ accountId: A, userId: user.id, role: 'owner' });
    store = new StoreBuckets(config);
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    directory = new StorageDirectory(db.dataSource.getRepository(Bucket), db.dataSource.getRepository(StorageKey), encryption);
  });

  afterAll(async () => {
    for (const row of (await db?.dataSource.getRepository(Bucket).find()) ?? []) {
      await store.empty(row.storeName).catch(() => 0);
      await store.delete(row.storeName).catch(() => undefined);
    }
    store?.onModuleDestroy();
    s3.destroy();
    await db?.drop();
  });

  afterEach(async () => {
    // Each test's buckets go, and their samples stay, as a deleted bucket's do; a row alone has nothing in the store.
    for (const row of await db.dataSource.getRepository(Bucket).find()) {
      await store.empty(row.storeName).catch(() => 0);
      await store.delete(row.storeName);
    }
    await db.dataSource.query('DELETE FROM buckets');
    await db.dataSource.query('UPDATE accounts SET bucket_storage_notice = NULL');
    limits = {};
  });

  it("measures each active bucket once an hour: its listing's sizes summed, its objects counted, its name then", async () => {
    const photos = await make(A);
    await put(photos, 'a.jpg', 3 * MIB);
    await put(photos, 'thumbs/a.jpg', 1000);
    const empty = await make(A);

    expect(await samples().sampleDue(hour(0))).toBe(2);
    expect(await samples().sampleDue(hour(0, 10))).toBe(0); // the hour's samples are taken
    await put(photos, 'b.jpg', MIB);
    expect(await samples().sampleDue(hour(1))).toBe(2);

    expect((await sampled(photos.id)).map((row) => [row.hour, row.name, row.size, row.objects])).toEqual([
      [hourOf(hour(0)), photos.name, String(3 * MIB + 1000), '2'],
      [hourOf(hour(1)), photos.name, String(4 * MIB + 1000), '3'],
    ]);
    expect((await sampled(empty.id)).map((row) => [row.size, row.objects])).toEqual([
      ['0', '0'],
      ['0', '0'],
    ]);
  });

  it("measures a new bucket within a minute, and its account's others again, without a second sample for them", async () => {
    const photos = await make(A);
    await put(photos, 'a.jpg', 1000);
    expect(await samples().sampleDue(hour(0))).toBe(1);

    const later = await make(A);
    expect(await samples().sampleDue(hour(0, 20))).toBe(1);

    expect([(await sampled(photos.id)).length, (await sampled(later.id)).length]).toEqual([1, 1]);
  });

  it("measures a suspended account's buckets, which are billed, and not a closed one's, whose files wait for their deletion date", async () => {
    const suspended = await make(SUSPENDED);
    await db.dataSource.getRepository(Bucket).save({ accountId: CLOSED, name: unique('closed'), storeName: `ff-${randomBytes(12).toString('hex')}` });

    expect(await samples().sampleDue(hour(0))).toBe(1);
    expect(await db.dataSource.query(`SELECT account_id FROM bucket_samples WHERE hour = $1 AND account_id IN ($2, $3)`, [hourOf(hour(0)), SUSPENDED, CLOSED])).toEqual([
      { account_id: SUSPENDED },
    ]);
    expect((await sampled(suspended.id)).length).toBe(1);
  });

  it("tells the owners once at 80% of the plan's storage, the buckets together, and again at 100%, when uploads wait for room", async () => {
    limits = { bucketStorageMb: 10 };
    const photos = await make(A);
    const docs = await make(A);
    await put(photos, 'a.bin', 5 * MIB);
    await put(docs, 'b.bin', 3 * MIB);

    await samples().sampleDue(hour(0)); // 8 MB of 10: 80%
    await samples().sampleDue(hour(1)); // still 80%: not told again
    expect([await notice(A), (await directory.account(A))?.bucketStorageNotice]).toEqual([80, 80]);

    await put(docs, 'c.bin', 2 * MIB);
    await samples().sampleDue(hour(2)); // 10 MB of 10: full

    expect([await notice(A), (await directory.account(A))?.bucketStorageNotice]).toEqual([100, 100]);
    expect((await deliveries()).map((row) => [row.kind, row.target, row.subject])).toEqual([
      ['bucket.storage', OWNER, 'Your FF buckets are at 80% of their storage'],
      ['bucket.storage', OWNER, 'Your FF buckets are full: uploads wait for room'],
    ]);
  });

  it('measures a full account every minute: files deleted, its uploads go in again within a minute; samples stay one an hour', async () => {
    const told = (await deliveries()).length;
    limits = { bucketStorageMb: 5 };
    const photos = await make(A);
    await put(photos, 'a.bin', 4 * MIB);
    await put(photos, 'b.bin', MIB);
    await samples().sampleDue(hour(0));
    expect(await notice(A)).toBe(100);

    await remove(photos, 'b.bin');
    expect(await samples().sampleDue(hour(0, 1))).toBe(0);

    expect(await notice(A)).toBe(80); // 4 MB of 5: uploads in, its owners told of 80% already
    expect((await sampled(photos.id)).map((row) => row.size)).toEqual([String(5 * MIB)]);
    expect((await deliveries()).length - told).toBe(1); // 100%, and nothing on the way down
  });

  it('forgets what it told an account whose buckets are all deleted', async () => {
    await db.dataSource.query(`UPDATE accounts SET bucket_storage_notice = 80 WHERE id = $1`, [A]);

    await samples().sampleDue(hour(0, 30));

    expect(await notice(A)).toBeNull();
  });

  it('measures each bucket once when two backends take their turn at the same moment', async () => {
    const photos = await make(A);
    await put(photos, 'a.jpg', 1000);

    const [one, other] = await Promise.all([samples().sampleDue(hour(3)), samples().sampleDue(hour(3))]);

    expect([one + other, (await sampled(photos.id)).length]).toEqual([1, 1]);
  });
});
