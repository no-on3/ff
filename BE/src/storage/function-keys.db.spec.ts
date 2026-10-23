import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Bucket } from './bucket.entity';
import { FunctionKeys } from './function-keys.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageKeysService } from './storage-keys.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '720000000001';
const ENDPOINT = 'http://10.43.0.251:3002';
const SQS_ENDPOINT = 'http://10.43.0.251:3003';

run("functions' own keys to their account's buckets and queues, in FF's database (L2)", () => {
  const config = (functionEndpoint = ENDPOINT, sqsEndpoint = SQS_ENDPOINT) =>
    new ConfigService({
      storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1', functionEndpoint },
      sqs: { base: 'https://sqs.example.tn', region: 'tn-tunis-1', functionEndpoint: sqsEndpoint },
    });
  let db: ScratchDatabase;
  let directory: StorageDirectory;
  let keys: FunctionKeys;
  const rowsOf = (functionId: string) => db.dataSource.getRepository(StorageKey).find({ where: { functionId }, order: { createdAt: 'ASC' } });
  const fn = () => ({ id: randomUUID(), accountId: ACCOUNT });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Functions', planId: 'beta', status: AccountStatus.ACTIVE });
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    directory = new StorageDirectory(db.dataSource.getRepository(Bucket), db.dataSource.getRepository(StorageKey), encryption);
    keys = new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config());
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("makes the function's key at its first deploy and gives the same one after, under the names AWS's SDKs read, its secret sealed", async () => {
    const function_ = fn();

    const first = await keys.credentialsFor(function_);
    const again = await keys.credentialsFor(function_);

    expect(first).toEqual({
      keyId: expect.stringMatching(/^AKFF[A-Z2-7]{16}$/),
      variables: {
        AWS_ACCESS_KEY_ID: first!.keyId,
        AWS_SECRET_ACCESS_KEY: expect.stringMatching(/^[A-Za-z0-9+/]{40}$/),
        AWS_REGION: 'tn-tunis-1',
        AWS_DEFAULT_REGION: 'tn-tunis-1',
        AWS_ENDPOINT_URL_S3: ENDPOINT,
        AWS_ENDPOINT_URL_SQS: SQS_ENDPOINT,
      },
    });
    expect(again).toEqual(first);
    const [row] = await rowsOf(function_.id);
    expect(row).toMatchObject({ id: first!.keyId, accountId: ACCOUNT, functionId: function_.id, buckets: null, readOnly: false, revokedAt: null });
    expect(JSON.stringify(row.secret)).not.toContain(first!.variables.AWS_SECRET_ACCESS_KEY);
    // The front door finds it as any key, and checks its signatures with that secret.
    expect(await directory.key(first!.keyId)).toMatchObject({ accountId: ACCOUNT, functionId: function_.id, buckets: null, readOnly: false, secret: first!.variables.AWS_SECRET_ACCESS_KEY });
  });

  it('makes one key when two deploys of the function ask at once: the index keeps one that works', async () => {
    const function_ = fn();

    const answers = await Promise.all([keys.credentialsFor(function_), keys.credentialsFor(function_), keys.credentialsFor(function_)]);

    expect(new Set(answers.map((answer) => answer!.keyId)).size).toBe(1);
    expect(new Set(answers.map((answer) => answer!.variables.AWS_SECRET_ACCESS_KEY)).size).toBe(1);
    expect(await rowsOf(function_.id)).toHaveLength(1);
    await expect(
      db.dataSource.getRepository(StorageKey).insert({ id: 'AKFFAAAAAAAAAAAAAAAA', accountId: ACCOUNT, functionId: function_.id, secret: directory.sealSecret('AKFFAAAAAAAAAAAAAAAA', 'x') }),
    ).rejects.toThrow(/UQ_storage_keys_function/);
  });

  it("revokes it when the function goes: the front door refuses it at once, and its row stays, so its ID is never another's", async () => {
    const function_ = fn();
    const made = await keys.credentialsFor(function_);

    await keys.revoke(function_.id);
    await keys.revoke(function_.id);

    expect(await directory.key(made!.keyId)).toBeNull();
    expect(await rowsOf(function_.id)).toEqual([expect.objectContaining({ id: made!.keyId, revokedAt: expect.any(Date) })]);
    // A function whose record outlived its removal gets a key of its own again at its next deploy.
    const next = await keys.credentialsFor(function_);
    expect(next!.keyId).not.toBe(made!.keyId);
    expect((await rowsOf(function_.id)).map((row) => row.revokedAt === null)).toEqual([false, true]);
  });

  it("is never one of the account's own keys: not listed with them, nor counted against their two", async () => {
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    const own = new StorageKeysService(db.dataSource.getRepository(StorageKey), directory, audit, config());
    const function_ = fn();
    await keys.credentialsFor(function_);

    const made = [await own.create(ACCOUNT, {}), await own.create(ACCOUNT, {})];

    expect((await own.list(ACCOUNT)).map((key) => key.id)).toEqual(made.map((key) => key.id));
    expect(await db.dataSource.getRepository(AuditEntry).countBy({ accountId: ACCOUNT, action: 'storage_key.create' })).toBe(2);
  });

  it('makes none where FF gives functions neither endpoint: neither has an address for them', async () => {
    const function_ = fn();
    const none = new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', ''));

    expect(await none.credentialsFor(function_)).toBeUndefined();
    expect(await rowsOf(function_.id)).toEqual([]);
  });

  it('gives the endpoints there are an address for, each alone: buckets without queues, queues without buckets', async () => {
    const buckets = await new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config(ENDPOINT, '')).credentialsFor(fn());
    const queues = await new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', SQS_ENDPOINT)).credentialsFor(fn());

    expect(Object.keys(buckets!.variables).filter((name) => name.startsWith('AWS_ENDPOINT_URL'))).toEqual(['AWS_ENDPOINT_URL_S3']);
    expect(queues!.variables).toMatchObject({ AWS_ACCESS_KEY_ID: queues!.keyId, AWS_REGION: 'tn-tunis-1', AWS_ENDPOINT_URL_SQS: SQS_ENDPOINT });
    expect(queues!.variables).not.toHaveProperty('AWS_ENDPOINT_URL_S3');
  });
});
