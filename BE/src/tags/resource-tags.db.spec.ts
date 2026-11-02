/**
 * L2: a function's tags, in FF's database: put, a key there taking its new
 * value; removed by key; 50 at most, two requests at once included; each
 * change in the audit log; gone with their function. Each run works in a
 * scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { ResourceTag } from './resource-tag.entity';
import { ResourceTagsService } from './resource-tags.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '750000000001';

run("a function's tags, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  let tags: ResourceTagsService;
  let functionId: string;
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
  });

  it('puts tags, a key there taking its new value, and removes them by key, a key it lacks no error; each change in the audit log', async () => {
    await tags.tagFunction(ACCOUNT, functionId, { team: 'shop', stage: 'dev' });
    await tags.tagFunction(ACCOUNT, functionId, { stage: 'prod', owner: 'ops' });
    expect(await tags.ofFunction(functionId)).toEqual({ owner: 'ops', stage: 'prod', team: 'shop' });

    await tags.untagFunction(ACCOUNT, functionId, ['owner', 'team', 'never-there', 'owner']);
    expect(await tags.ofFunction(functionId)).toEqual({ stage: 'prod' });

    // The audit log keeps every entry: each test's function is new, its entries its own.
    expect(await query(`SELECT action, resource, details FROM audit_log WHERE resource = $1 ORDER BY id`, [`function:${functionId}`])).toEqual([
      { action: 'function.tag', resource: `function:${functionId}`, details: { tags: { team: 'shop', stage: 'dev' } } },
      { action: 'function.tag', resource: `function:${functionId}`, details: { tags: { stage: 'prod', owner: 'ops' } } },
      { action: 'function.untag', resource: `function:${functionId}`, details: { keys: ['never-there', 'owner', 'team'] } },
    ]);
  });

  it('refuses a 51st tag, nothing put, two requests at once included, and a tag AWS would refuse', async () => {
    await tags.tagFunction(ACCOUNT, functionId, Object.fromEntries(Array.from({ length: 48 }, (_, n) => [`k${n}`, 'v'])));

    // Each fits alone, not both: one waits for the other, then counts its tags.
    const both = await Promise.allSettled([tags.tagFunction(ACCOUNT, functionId, { a: '1', b: '1' }), tags.tagFunction(ACCOUNT, functionId, { c: '1', d: '1' })]);

    expect(both.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('A resource has at most 50 tags: these would make it 52.');
    expect(Object.keys(await tags.ofFunction(functionId))).toHaveLength(50);
    await expect(tags.tagFunction(ACCOUNT, functionId, { 'aws:owner': 'x' })).rejects.toThrow('The key aws:owner starts with aws:, which AWS keeps for its own tags.');
    expect(await query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'function.tag' AND resource = $1`, [`function:${functionId}`])).toEqual([{ n: 2 }]);
  });

  it('go with their function', async () => {
    await tags.tagFunction(ACCOUNT, functionId, { team: 'shop' });

    await query('DELETE FROM functions WHERE id = $1', [functionId]);

    expect(await query(`SELECT count(*)::int AS n FROM resource_tags`)).toEqual([{ n: 0 }]);
  });
});
