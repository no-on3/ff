/**
 * L2: buckets' notifications, as S3's, on a real PostgreSQL and a real store:
 * configurations put and read through the S3 front door as AWS's SDK sends
 * them, and through FF's API, checked as S3 checks them, each change in the
 * audit log, S3's test event in each queue named; then the events of uploads
 * and deletions delivered, S3's records, to a function's queue of calls that
 * don't wait and to a customer's queue, a configuration whose destination is
 * gone dropping its events. Each run works in a scratch database, dropped
 * afterwards, and buckets of its own in the store.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketNotificationConfigurationCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { CreditService } from '../billing/credit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { onePlan } from '../plans/test-fixtures';
import { BucketEventDelivery } from '../queues/bucket-event-delivery';
import { CustomerQueues } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { QueueRequestCount } from '../queues/queue-request-count.entity';
import { QueueRequestCounts } from '../queues/queue-request-counts.service';
import { QueueStore } from '../queues/queue-store';
import { BucketEvents } from './bucket-events';
import { BucketNotificationsService } from './bucket-notifications.service';
import { Bucket } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey, newStoreName } from './storage-names';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '720000000001';
const OTHER = '720000000002';
const REGION = 'tn-tunis-1';

run("buckets' notifications, as S3's, through the S3 front door and FF's API (L2)", () => {
  // The store's settings as the backend reads them, FF_OBJECT_STORE_*, alone: BE/.env's development SeaweedFS, or the CI's own.
  const objectStore = {
    endPoint: process.env.FF_OBJECT_STORE_ENDPOINT ?? 'localhost',
    port: Number(process.env.FF_OBJECT_STORE_PORT ?? 9003),
    useSSL: process.env.FF_OBJECT_STORE_USE_SSL === 'true',
    accessKey: process.env.FF_OBJECT_STORE_ACCESS_KEY ?? 'ffdevaccesskey',
    secretKey: process.env.FF_OBJECT_STORE_SECRET_KEY ?? 'ffdevsecretkey-local-only',
  };
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
  let delivery: BucketEventDelivery;
  let notifications: BucketNotificationsService;
  let endpoint: string;
  let thumbnails: Function;
  const photos = { name: `photos-${randomBytes(4).toString('hex')}`, storeName: newStoreName() };
  const key = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:thumbnails`;
  const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:uploads`;
  /** AWS's SDK with the account's key, at the front door. */
  let client: S3Client;
  /** S3's error for a refused call: its name and message. */
  const refused = async (call: Promise<unknown>) => {
    try {
      await call;
      return 'accepted';
    } catch (error) {
      if (error instanceof S3ServiceException) return `${error.name}: ${error.message}`;
      throw error;
    }
  };
  /** The bodies waiting in the customer's queue, oldest first. */
  const inQueue = async () =>
    (
      await db.dataSource.query<Array<{ body: string }>>(
        `SELECT m.body FROM queue_messages m JOIN queues q ON q.id = m.queue_id WHERE q.account_id = $1 AND q.name = 'uploads' AND q.kind = 'customer' ORDER BY m.id`,
        [ACCOUNT],
      )
    ).map((row) => JSON.parse(row.body) as Record<string, unknown>);
  /** The function's calls that don't wait, kept for its worker: their events, oldest first. */
  const calls = async () =>
    (await db.dataSource.query<Array<{ body: string }>>(`SELECT body FROM queue_messages WHERE function_id = $1 ORDER BY id`, [thumbnails.id])).map(
      (row) => JSON.parse(row.body) as { Records: Array<{ eventName: string; s3: { configurationId: string; object: Record<string, unknown> } }> },
    );
  const clear = () => db.dataSource.query(`DELETE FROM queue_messages`);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    await ds.getRepository(Account).save([
      { id: ACCOUNT, name: 'Photos', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    // A store just started answers before it can keep anything: the bucket waits for it, 30 s at most.
    for (let tries = 0; ; tries++) {
      try {
        await store.send(new CreateBucketCommand({ Bucket: photos.storeName }));
        break;
      } catch (error) {
        if (tries >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    const buckets = ds.getRepository(Bucket);
    await buckets.save({ accountId: ACCOUNT, name: photos.name, storeName: photos.storeName });
    const directory = new StorageDirectory(buckets, ds.getRepository(StorageKey), encryption);
    await ds.getRepository(StorageKey).save({ id: key.id, accountId: ACCOUNT, secret: directory.sealSecret(key.id, key.secret) });
    thumbnails = await ds.getRepository(Function).save({
      name: 'thumbnails',
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
    const customerQueues = new CustomerQueues(ds, ds.getRepository(Queue));
    await customerQueues.create(ACCOUNT, 'uploads', {}, { limit: 10, name: 'Beta' }, REGION);
    await customerQueues.create(OTHER, 'uploads', {}, { limit: 10, name: 'Beta' }, REGION);
    const config = new ConfigService({ storage: { base: 'http://s3.localhost:3002', region: REGION }, objectStore });
    const events = new BucketEvents();
    notifications = new BucketNotificationsService(buckets, ds.getRepository(Function), ds.getRepository(Queue), new AuditService(ds.getRepository(AuditEntry)), events, config);
    delivery = new BucketEventDelivery(events, customerQueues, new QueueStore(ds), onePlan(), ds.getRepository(Function), new QueueRequestCounts(ds.getRepository(QueueRequestCount)));
    delivery.onModuleInit();
    frontDoor = new S3FrontDoor(
      config,
      directory,
      new StorageRequestCountsService(ds.getRepository(StorageRequestCount)),
      onePlan(),
      { admit: async () => undefined } as unknown as CreditService,
      { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) },
      notifications,
      events,
    );
    endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: key.id, secretAccessKey: key.secret }, maxAttempts: 1 });
  });

  afterAll(async () => {
    delivery?.onModuleDestroy();
    await frontDoor?.onModuleDestroy();
    const listed = await store.send(new ListObjectsV2Command({ Bucket: photos.storeName })).catch(() => ({ Contents: [] }));
    for (const object of listed.Contents ?? []) await store.send(new DeleteObjectCommand({ Bucket: photos.storeName, Key: object.Key }));
    await store.send(new DeleteBucketCommand({ Bucket: photos.storeName })).catch(() => undefined);
    store.destroy();
    client?.destroy();
    await db?.drop();
  });

  beforeEach(clear);

  it("keeps a configuration as AWS's SDK puts it, reads it back, logs it under the key, and sends each queue it names S3's test event", async () => {
    await client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: photos.name,
        NotificationConfiguration: {
          LambdaFunctionConfigurations: [{ Id: 'thumbs', LambdaFunctionArn: FUNCTION_ARN, Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'images/' }] } } }],
          QueueConfigurations: [{ Id: 'removals', QueueArn: QUEUE_ARN, Events: ['s3:ObjectRemoved:*'] }],
        },
      }),
    );

    const got = await client.send(new GetBucketNotificationConfigurationCommand({ Bucket: photos.name }));
    expect([got.LambdaFunctionConfigurations, got.QueueConfigurations]).toEqual([
      [{ Id: 'thumbs', LambdaFunctionArn: FUNCTION_ARN, Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'images/' }] } } }],
      [{ Id: 'removals', QueueArn: QUEUE_ARN, Events: ['s3:ObjectRemoved:*'] }],
    ]);
    expect(await inQueue()).toEqual([{ Service: 'Amazon S3', Event: 's3:TestEvent', Time: expect.any(String), Bucket: photos.name, RequestId: expect.any(String), HostId: expect.any(String) }]);
    const [entry] = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: ACCOUNT, action: 'bucket.notifications' }, order: { id: 'DESC' }, take: 1 });
    expect([entry.actor, entry.resource, entry.ip]).toEqual([`access_key:${key.id}`, `bucket:${photos.name}`, '127.0.0.1']);
  });

  it("refuses a destination that isn't there, unless told to skip that check, and another account's whatever it is told", async () => {
    const missing = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:missing`;
    const put = (arn: string, skip?: boolean) =>
      client.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: photos.name,
          NotificationConfiguration: { LambdaFunctionConfigurations: [{ LambdaFunctionArn: arn, Events: ['s3:ObjectCreated:*'] }] },
          ...(skip ? { SkipDestinationValidation: true } : {}),
        }),
      );

    expect(await refused(put(missing))).toBe(`InvalidArgument: Unable to validate the following destination configurations: ${missing}: the account has no such function or queue`);
    expect(await refused(put(missing, true))).toBe('accepted');
    expect(await refused(put(`arn:aws:lambda:${REGION}:${OTHER}:function:thumbnails`, true))).toBe(
      `InvalidArgument: A destination must be a function of the bucket's account, in ${REGION}: arn:aws:lambda:${REGION}:${OTHER}:function:thumbnails`,
    );
  });

  it("calls the function with S3's event for an upload its rule names, puts S3's event in the queue for each deletion, DeleteObjects' one per key", async () => {
    // Through FF's API, each destination by its name, kept as its ARN.
    const set = await notifications.put(ACCOUNT, photos.name, {
      lambdaFunctionConfigurations: [{ id: 'thumbs', lambdaFunctionArn: 'thumbnails', events: ['s3:ObjectCreated:*'], filter: { key: { filterRules: [{ name: 'prefix', value: 'images/' }] } } }],
      queueConfigurations: [{ id: 'removals', queueArn: 'uploads', events: ['s3:ObjectRemoved:*'] }],
    });
    expect([set.lambdaFunctionConfigurations[0].lambdaFunctionArn, set.queueConfigurations[0].queueArn]).toEqual([FUNCTION_ARN, QUEUE_ARN]);
    await clear();

    await client.send(new PutObjectCommand({ Bucket: photos.name, Key: 'images/red cat.jpg', Body: 'hello' }));
    await client.send(new PutObjectCommand({ Bucket: photos.name, Key: 'docs/notes.txt', Body: 'not an image' }));
    await client.send(new DeleteObjectCommand({ Bucket: photos.name, Key: 'images/red cat.jpg' }));
    await client.send(new DeleteObjectsCommand({ Bucket: photos.name, Delete: { Objects: [{ Key: 'docs/notes.txt' }] } }));
    // The client has its answer before the event goes, as S3's: the test waits for it.
    await frontDoor.notified();

    const [call, ...others] = await calls();
    expect(others).toEqual([]);
    expect(call.Records).toHaveLength(1);
    expect([call.Records[0].eventName, call.Records[0].s3.configurationId, call.Records[0].s3.object]).toEqual([
      'ObjectCreated:Put',
      'thumbs',
      { key: 'images%2Fred+cat.jpg', size: 5, eTag: createHash('md5').update('hello').digest('hex'), sequencer: expect.stringMatching(/^[0-9A-F]{18}$/) },
    ]);
    const removed = (await inQueue()) as Array<{ Records: Array<{ eventName: string; s3: { object: { key: string } } }> }>;
    expect(removed.map((message) => [message.Records[0].eventName, message.Records[0].s3.object.key])).toEqual([
      ['ObjectRemoved:Delete', 'images%2Fred+cat.jpg'],
      ['ObjectRemoved:Delete', 'docs%2Fnotes.txt'],
    ]);
  });

  it("sets the same configuration through FF's API, in S3's JSON names, its refusals as 400", async () => {
    const answer = await notifications.put(ACCOUNT, photos.name, { queueConfigurations: [{ id: 'all', queueArn: QUEUE_ARN, events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'] }] });

    expect(answer).toEqual({ lambdaFunctionConfigurations: [], queueConfigurations: [{ id: 'all', queueArn: QUEUE_ARN, events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'] }] });
    expect(await notifications.get(ACCOUNT, photos.name)).toEqual(answer);
    await expect(
      notifications.put(ACCOUNT, photos.name, {
        queueConfigurations: [
          { queueArn: QUEUE_ARN, events: ['s3:ObjectCreated:Put'] },
          { queueArn: QUEUE_ARN, events: ['s3:ObjectCreated:*'] },
        ],
      }),
    ).rejects.toEqual(
      new BadRequestException(
        'InvalidArgument: Configuration is ambiguously defined. Cannot have overlapping suffixes in two rules if the prefixes are overlapping for the same event type.',
      ),
    );
    await expect(notifications.get(OTHER, photos.name)).rejects.toThrow(`The account has no bucket named "${photos.name}"`);
    expect(await notifications.put(ACCOUNT, photos.name, {})).toEqual({ lambdaFunctionConfigurations: [], queueConfigurations: [] });
  });

  it("drops the events of a configuration whose destination is gone since, saying so", async () => {
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await notifications.put(ACCOUNT, photos.name, { lambdaFunctionConfigurations: [{ id: 'gone', lambdaFunctionArn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'] }] });
    await db.dataSource.getRepository(Function).delete({ id: thumbnails.id });

    await client.send(new PutObjectCommand({ Bucket: photos.name, Key: 'late.txt', Body: 'x' }));
    await frontDoor.notified();

    expect(await db.dataSource.query(`SELECT count(*)::int AS kept FROM queue_messages WHERE function_id IS NOT NULL`)).toEqual([{ kept: 0 }]);
    expect(warnings).toHaveBeenCalledWith(`An event of bucket ${photos.name} was not delivered to ${FUNCTION_ARN}: it is no function of the account any more`);
    warnings.mockRestore();
  });
});
