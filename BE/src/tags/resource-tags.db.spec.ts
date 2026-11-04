/**
 * L2: a function's and a bucket's tags, in FF's database: put, a key there
 * taking its new value, or a bucket's replaced whole; removed by key; 50 at
 * most, two requests at once included; each change in the audit log; gone
 * with their resource. Each run works in a scratch database, dropped
 * afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Bucket } from '../storage/bucket.entity';
import { newStoreName } from '../storage/storage-names';
import { ResourceTag } from './resource-tag.entity';
import { ResourceTagsService, Tagged, taggedBucket, taggedFunction } from './resource-tags.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '750000000001';

run("a function's and a bucket's tags, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  let tags: ResourceTagsService;
  let functionId: string;
  let fn: Tagged;
  let bucket: Tagged;
  const query = <T = unknown>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Tags', planId: 'beta', status: AccountStatus.ACTIVE });
    tags = new ResourceTagsService(db.dataSource.getRepository(ResourceTag), new AuditService(db.dataSource.getRepository(AuditEntry)));
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM functions');
    await query('DELETE FROM buckets');
    // Each test's bucket is new, its name too, so that its entries in the audit log are its own.
    const photos = await db.dataSource.getRepository(Bucket).save({ accountId: ACCOUNT, name: `photos-${randomBytes(4).toString('hex')}`, storeName: newStoreName() });
    bucket = taggedBucket(photos);
    const saved = await db.dataSource.getRepository(Function).save({
      name: 'orders',
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = () => 1',
      codeSha256: 'x'.repeat(44),
      codeSize: 30,
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
    functionId = saved.id;
    fn = taggedFunction(functionId);
  });

  it('puts tags, a key there taking its new value, and removes them by key, a key it lacks no error; each change in the audit log', async () => {
    await tags.tag(ACCOUNT, fn, { team: 'shop', stage: 'dev' });
    await tags.tag(ACCOUNT, fn, { stage: 'prod', owner: 'ops' });
    expect(await tags.of(fn)).toEqual({ owner: 'ops', stage: 'prod', team: 'shop' });

    await tags.untag(ACCOUNT, fn, ['owner', 'team', 'never-there', 'owner']);
    expect(await tags.of(fn)).toEqual({ stage: 'prod' });

    // The audit log keeps every entry: each test's function is new, its entries its own.
    expect(await query(`SELECT action, resource, details FROM audit_log WHERE resource = $1 ORDER BY id`, [`function:${functionId}`])).toEqual([
      { action: 'function.tag', resource: `function:${functionId}`, details: { tags: { team: 'shop', stage: 'dev' } } },
      { action: 'function.tag', resource: `function:${functionId}`, details: { tags: { stage: 'prod', owner: 'ops' } } },
      { action: 'function.untag', resource: `function:${functionId}`, details: { keys: ['never-there', 'owner', 'team'] } },
    ]);
  });

  it('refuses a 51st tag, nothing put, two requests at once included, and a tag AWS would refuse', async () => {
    await tags.tag(ACCOUNT, fn, Object.fromEntries(Array.from({ length: 48 }, (_, n) => [`k${n}`, 'v'])));

    // Each fits alone, not both: one waits for the other, then counts its tags.
    const both = await Promise.allSettled([tags.tag(ACCOUNT, fn, { a: '1', b: '1' }), tags.tag(ACCOUNT, fn, { c: '1', d: '1' })]);

    expect(both.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('A resource has at most 50 tags: these would make it 52.');
    expect(Object.keys(await tags.of(fn))).toHaveLength(50);
    await expect(tags.tag(ACCOUNT, fn, { 'aws:owner': 'x' })).rejects.toThrow('The key aws:owner starts with aws:, which AWS keeps for its own tags.');
    expect(await query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'function.tag' AND resource = $1`, [`function:${functionId}`])).toEqual([{ n: 2 }]);
  });

  it('go with their function', async () => {
    await tags.tag(ACCOUNT, fn, { team: 'shop' });

    await query('DELETE FROM functions WHERE id = $1', [functionId]);

    expect(await query(`SELECT count(*)::int AS n FROM resource_tags`)).toEqual([{ n: 0 }]);
  });

  it("replaces a bucket's tags whole, as S3's PutBucketTagging, and none removes them all; a function's of the same key are its own", async () => {
    await tags.tag(ACCOUNT, fn, { team: 'functions' });
    await tags.replace(ACCOUNT, bucket, { team: 'shop', stage: 'dev' });
    await tags.replace(ACCOUNT, bucket, { team: 'web' });
    expect([await tags.of(bucket), await tags.of(fn)]).toEqual([{ team: 'web' }, { team: 'functions' }]);

    await tags.replace(ACCOUNT, bucket, {});

    expect([await tags.of(bucket), await tags.of(fn)]).toEqual([{}, { team: 'functions' }]);
    expect(await query(`SELECT action, details FROM audit_log WHERE resource = $1 ORDER BY id`, [bucket.resource])).toEqual([
      { action: 'bucket.tag', details: { tags: { team: 'shop', stage: 'dev' }, replaced: true } },
      { action: 'bucket.tag', details: { tags: { team: 'web' }, replaced: true } },
      { action: 'bucket.untag', details: { keys: ['team'] } },
    ]);
  });

  it("refuses a bucket's 51 tags, or one AWS would refuse, its tags as they were; they go with their bucket", async () => {
    await tags.replace(ACCOUNT, bucket, { team: 'shop' });

    await expect(tags.replace(ACCOUNT, bucket, Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`k${n}`, 'v'])))).rejects.toThrow('A resource has at most 50 tags: these would make it 51.');
    await expect(tags.replace(ACCOUNT, bucket, { 'aws:cloudformation:stack-name': 'x' })).rejects.toThrow('starts with aws:');
    expect(await tags.of(bucket)).toEqual({ team: 'shop' });

    await query(`DELETE FROM buckets WHERE id = $1`, [bucket.id]);
    expect(await query(`SELECT count(*)::int AS n FROM resource_tags WHERE bucket_id = $1`, [bucket.id])).toEqual([{ n: 0 }]);
  });
});
