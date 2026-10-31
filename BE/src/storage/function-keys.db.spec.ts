import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { AwsEndpoint, awsEndpointsOf } from '../functions/entities/function.entity';
import { Bucket } from './bucket.entity';
import { FunctionCredentials, FunctionKeys } from './function-keys.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageKeysService } from './storage-keys.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '720000000001';
const ENDPOINT = 'http://10.43.0.251:3002';
const SQS_ENDPOINT = 'http://10.43.0.251:3003';
const SES_ENDPOINT = 'http://10.43.0.251:3005';

run("functions' own keys to their account's buckets, queues and mail, in FF's database (L2)", () => {
  const config = (functionEndpoint = ENDPOINT, sqsEndpoint = SQS_ENDPOINT, sesEndpoint = SES_ENDPOINT) =>
    new ConfigService({
      storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1', functionEndpoint },
      sqs: { base: 'https://sqs.example.tn', region: 'tn-tunis-1', functionEndpoint: sqsEndpoint },
      ses: { base: 'https://email.example.tn', region: 'tn-tunis-1', functionEndpoint: sesEndpoint },
    });
  let db: ScratchDatabase;
  let directory: StorageDirectory;
  let keys: FunctionKeys;
  const rowsOf = (functionId: string) => db.dataSource.getRepository(StorageKey).find({ where: { functionId }, order: { createdAt: 'ASC' } });
  const fn = () => ({ id: randomUUID(), accountId: ACCOUNT, awsEndpoints: awsEndpointsOf() });
  /** The key's ID, as the pods get it. */
  const keyOf = (credentials: FunctionCredentials | undefined) => credentials!.variables.AWS_ACCESS_KEY_ID;
  const endpoints = (variables: Record<string, string>) => Object.keys(variables).filter((name) => name.startsWith('AWS_ENDPOINT_URL'));

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
      revision: keyOf(first),
      variables: {
        AWS_ACCESS_KEY_ID: expect.stringMatching(/^AKFF[A-Z2-7]{16}$/),
        AWS_SECRET_ACCESS_KEY: expect.stringMatching(/^[A-Za-z0-9+/]{40}$/),
        AWS_REGION: 'tn-tunis-1',
        AWS_DEFAULT_REGION: 'tn-tunis-1',
        AWS_ENDPOINT_URL_S3: ENDPOINT,
        AWS_ENDPOINT_URL_SQS: SQS_ENDPOINT,
        AWS_ENDPOINT_URL_SESV2: SES_ENDPOINT,
      },
    });
    expect(again).toEqual(first);
    const [row] = await rowsOf(function_.id);
    expect(row).toMatchObject({ id: keyOf(first), accountId: ACCOUNT, functionId: function_.id, buckets: null, readOnly: false, revokedAt: null });
    expect(JSON.stringify(row.secret)).not.toContain(first!.variables.AWS_SECRET_ACCESS_KEY);
    // The front door finds it as any key, and checks its signatures with that secret.
    expect(await directory.key(keyOf(first))).toMatchObject({ accountId: ACCOUNT, functionId: function_.id, buckets: null, readOnly: false, secret: first!.variables.AWS_SECRET_ACCESS_KEY });
  });

  it('makes one key when two deploys of the function ask at once: the index keeps one that works', async () => {
    const function_ = fn();

    const answers = await Promise.all([keys.credentialsFor(function_), keys.credentialsFor(function_), keys.credentialsFor(function_)]);

    expect(new Set(answers.map(keyOf)).size).toBe(1);
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

    expect(await directory.key(keyOf(made))).toBeNull();
    expect(await rowsOf(function_.id)).toEqual([expect.objectContaining({ id: keyOf(made), revokedAt: expect.any(Date) })]);
    // A function whose record outlived its removal gets a key of its own again at its next deploy.
    const next = await keys.credentialsFor(function_);
    expect(keyOf(next)).not.toBe(keyOf(made));
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

  it('makes none where FF gives functions no endpoint: none has an address for them', async () => {
    const function_ = fn();
    const none = new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', '', ''));

    expect(await none.credentialsFor(function_)).toBeUndefined();
    expect(await rowsOf(function_.id)).toEqual([]);
  });

  it('gives the endpoints there are an address for, each alone: buckets, queues or mail without the others', async () => {
    const buckets = await new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config(ENDPOINT, '', '')).credentialsFor(fn());
    const queues = await new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', SQS_ENDPOINT, '')).credentialsFor(fn());
    const mail = await new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', '', SES_ENDPOINT)).credentialsFor(fn());

    expect(endpoints(buckets!.variables)).toEqual(['AWS_ENDPOINT_URL_S3']);
    expect(queues!.variables).toMatchObject({ AWS_ACCESS_KEY_ID: keyOf(queues), AWS_REGION: 'tn-tunis-1', AWS_ENDPOINT_URL_SQS: SQS_ENDPOINT });
    expect(endpoints(queues!.variables)).toEqual(['AWS_ENDPOINT_URL_SQS']);
    expect(mail!.variables).toMatchObject({ AWS_ACCESS_KEY_ID: keyOf(mail), AWS_REGION: 'tn-tunis-1', AWS_ENDPOINT_URL_SESV2: SES_ENDPOINT });
    expect(endpoints(mail!.variables)).toEqual(['AWS_ENDPOINT_URL_SESV2']);
    // Every endpoint there is, for a function that takes them all: no new version, as before endpoints could be left out.
    expect([buckets!.revision, queues!.revision, mail!.revision]).toEqual([keyOf(buckets), keyOf(queues), keyOf(mail)]);
  });

  it('gives only the endpoints the function takes, with its key and region still, each change of them a new version of the same key', async () => {
    const function_ = fn();

    const every = await keys.credentialsFor(function_);
    const queuesAndMail = await keys.credentialsFor({ ...function_, awsEndpoints: [AwsEndpoint.SQS, AwsEndpoint.SESV2] });
    const none = await keys.credentialsFor({ ...function_, awsEndpoints: [] });

    expect(endpoints(queuesAndMail!.variables)).toEqual(['AWS_ENDPOINT_URL_SQS', 'AWS_ENDPOINT_URL_SESV2']);
    expect(queuesAndMail!.variables).toMatchObject({ AWS_ACCESS_KEY_ID: keyOf(every), AWS_SECRET_ACCESS_KEY: every!.variables.AWS_SECRET_ACCESS_KEY, AWS_REGION: 'tn-tunis-1' });
    expect(endpoints(none!.variables)).toEqual([]);
    expect(none!.variables).toMatchObject({ AWS_ACCESS_KEY_ID: keyOf(every), AWS_REGION: 'tn-tunis-1', AWS_DEFAULT_REGION: 'tn-tunis-1' });
    expect([every!.revision, queuesAndMail!.revision, none!.revision]).toEqual([keyOf(every), `${keyOf(every)}:sqs,sesv2`, `${keyOf(every)}:`]);
    expect(await rowsOf(function_.id)).toHaveLength(1);
  });

  it("counts only the endpoints FF has an address for: where it has the queues' alone, a function that takes them takes every one there is", async () => {
    const queuesOnly = new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, config('', SQS_ENDPOINT, ''));
    const function_ = fn();

    const every = await queuesOnly.credentialsFor(function_);
    const buckets = await queuesOnly.credentialsFor({ ...function_, awsEndpoints: [AwsEndpoint.S3, AwsEndpoint.SQS] });
    const bucketsAlone = await queuesOnly.credentialsFor({ ...function_, awsEndpoints: [AwsEndpoint.S3] });

    expect([every!.revision, buckets!.revision, bucketsAlone!.revision]).toEqual([keyOf(every), keyOf(every), `${keyOf(every)}:`]);
    expect(endpoints(bucketsAlone!.variables)).toEqual([]);
  });
});
