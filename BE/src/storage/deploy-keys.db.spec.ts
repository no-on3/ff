/**
 * L2: deploys' own keys to a bucket, in FF's database: made by any writer for
 * a bucket of the account, reaching it alone for an hour, then refused as a
 * revoked key is; never listed with the account's own keys nor counted against
 * their two; revoked by their deploy.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Bucket } from './bucket.entity';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { DEPLOY_KEY_MS, StorageKeysService } from './storage-keys.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '720000000011';
const OTHER = '720000000012';

run("deploys' own keys to a bucket, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  let directory: StorageDirectory;
  let keys: StorageKeysService;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Sites', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    await db.dataSource.getRepository(Bucket).insert([
      { accountId: ACCOUNT, name: 'deploy-site', storeName: 'ff-deploy-site' },
      { accountId: OTHER, name: 'deploy-other', storeName: 'ff-deploy-other' },
    ]);
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    directory = new StorageDirectory(db.dataSource.getRepository(Bucket), db.dataSource.getRepository(StorageKey), encryption);
    const config = new ConfigService({ storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1' }, sqs: { base: 'https://sqs.example.tn' } });
    keys = new StorageKeysService(db.dataSource.getRepository(StorageKey), directory, new AuditService(db.dataSource.getRepository(AuditEntry)), config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('reaches the bucket alone, read-write, with the S3 endpoint and the region; its making in the audit log', async () => {
    const made = await keys.createDeployKey(ACCOUNT, 'deploy-site');

    expect(made).toMatchObject({ bucket: 'deploy-site', endpoint: 'https://s3.example.tn', region: 'tn-tunis-1', accessKeyId: expect.stringMatching(/^AKFF[0-9A-Z]{16}$/) });
    expect(await directory.key(made.accessKeyId)).toEqual({
      id: made.accessKeyId,
      accountId: ACCOUNT,
      functionId: null,
      buckets: ['deploy-site'],
      queues: null,
      readOnly: false,
      secret: made.secretAccessKey,
    });
    expect(await db.dataSource.getRepository(AuditEntry).findOneByOrFail({ accountId: ACCOUNT, action: 'bucket.deploy_key' })).toMatchObject({
      resource: 'bucket:deploy-site',
      details: { accessKeyId: made.accessKeyId },
    });
  });

  it('works for an hour, then not, as a revoked key', async () => {
    const now = new Date();
    const made = await keys.createDeployKey(ACCOUNT, 'deploy-site', now);

    expect(made.expiresAt).toEqual(new Date(now.getTime() + DEPLOY_KEY_MS));
    expect(await directory.key(made.accessKeyId, new Date(now.getTime() + DEPLOY_KEY_MS - 1000))).not.toBeNull();
    expect(await directory.key(made.accessKeyId, new Date(now.getTime() + DEPLOY_KEY_MS))).toBeNull();
  });

  it("is never one of the account's own keys: not listed with them, nor counted against their two, nor revoked as one", async () => {
    const deploy = await keys.createDeployKey(ACCOUNT, 'deploy-site');
    const own = [await keys.create(ACCOUNT, {}), await keys.create(ACCOUNT, {})];

    expect((await keys.list(ACCOUNT)).map((key) => key.id)).toEqual(own.map((key) => key.id));
    await expect(keys.revoke(ACCOUNT, deploy.accessKeyId)).rejects.toBeInstanceOf(NotFoundException);
    for (const key of own) await keys.revoke(ACCOUNT, key.id);
  });

  it('is revoked by its deploy, through its bucket alone; another account gets none for a bucket not its own', async () => {
    const made = await keys.createDeployKey(ACCOUNT, 'deploy-site');

    await expect(keys.revokeDeployKey(OTHER, 'deploy-site', made.accessKeyId)).rejects.toThrow('The account has no bucket named "deploy-site"');
    await keys.revokeDeployKey(ACCOUNT, 'deploy-site', made.accessKeyId);
    expect(await directory.key(made.accessKeyId)).toBeNull();
    await expect(keys.revokeDeployKey(ACCOUNT, 'deploy-site', made.accessKeyId)).rejects.toThrow(`The bucket deploy-site has no deploy key ${made.accessKeyId}`);
    await expect(keys.createDeployKey(ACCOUNT, 'deploy-other')).rejects.toThrow('The account has no bucket named "deploy-other"');
  });
});
