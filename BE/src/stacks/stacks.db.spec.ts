/**
 * L2: stacks in FF's database (ADR 0016): put whole, made or replaced, read,
 * listed and forgotten, what they made staying; a function, a queue or a
 * bucket named only if it is the account's, in one stack at most, two puts
 * at once included; each change in the audit log; the stack each function is
 * in. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Queue, QueueKind } from '../queues/queue.entity';
import { Bucket } from '../storage/bucket.entity';
import { newStoreName } from '../storage/storage-names';
import { PutStackDto } from './dto/stack.dto';
import { Stack, StackResource } from './stack.entity';
import { MAX_STACKS, StacksService } from './stacks.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '760000000001';
const OTHER = '760000000002';
const SHA = 'a'.repeat(64);

run('stacks, in FF\'s database (L2)', () => {
  let db: ScratchDatabase;
  let stacks: StacksService;
  // The audit log is append-only: each test reads the entries made since it started.
  let lastAudited: string;
  const query = <T = unknown>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);
  const fn = (logicalId: string, physicalId: string) => ({ logicalId, type: 'AWS::Serverless::Function', physicalId });
  const shop = (resources: PutStackDto['resources'], parameters: Record<string, string> = {}): PutStackDto => ({ templateSha256: SHA, parameters, resources });
  // What a refusal says, each problem of a body's as its answer lists them.
  const refusal = (put: Promise<unknown>) =>
    put.then(
      () => [],
      (error: { getResponse(): { message: string | string[] } }) => [error.getResponse().message].flat(),
    );
  const functionNamed = (accountId: string, name: string) =>
    db.dataSource.getRepository(Function).save({
      name,
      accountId,
      runtime: Runtime.NODEJS,
      code: 'export const handler = () => 1',
      codeSha256: 'x'.repeat(44),
      codeSize: 30,
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
  const audited = (action: string) => query(`SELECT resource, details FROM audit_log WHERE id > $1 AND action = $2 ORDER BY id`, [lastAudited, action]);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [ACCOUNT, OTHER]) await db.dataSource.getRepository(Account).save({ id, name: `Stacks ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    const repository = <T extends object>(entity: new () => T) => db.dataSource.getRepository(entity);
    stacks = new StacksService(repository(Stack), repository(StackResource), repository(Function), repository(Queue), repository(Bucket), new AuditService(repository(AuditEntry)));
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    for (const table of ['stacks', 'functions', 'queues', 'buckets']) await query(`DELETE FROM ${table}`);
    [{ id: lastAudited }] = await query<Array<{ id: string }>>(`SELECT coalesce(max(id), 0)::text AS id FROM audit_log`);
    await functionNamed(ACCOUNT, 'orders');
    await functionNamed(ACCOUNT, 'reports');
    await db.dataSource.getRepository(Queue).save({ accountId: ACCOUNT, name: 'orders-queue', kind: QueueKind.CUSTOMER });
    await db.dataSource.getRepository(Bucket).save({ accountId: OTHER, name: 'their-photos', storeName: newStoreName() });
  });

  it('makes a stack, then replaces it whole, its resources by logical ID; each put in the audit log with what changed', async () => {
    const made = await stacks.put(ACCOUNT, 'shop', shop([fn('Orders', 'orders'), { logicalId: 'Queue', type: 'AWS::SQS::Queue', physicalId: 'orders-queue' }], { Stage: 'dev' }));
    const replaced = await stacks.put(
      ACCOUNT,
      'shop',
      shop([fn('Reports', 'reports'), { logicalId: 'Queue', type: 'AWS::SQS::Queue', physicalId: 'orders-queue' }, { logicalId: 'Allow', type: 'AWS::Lambda::Permission', physicalId: null }], {
        Stage: 'prod',
      }),
    );

    expect([made.resources.map((resource) => resource.logicalId), replaced.parameters, replaced.resources]).toEqual([
      ['Orders', 'Queue'],
      { Stage: 'prod' },
      [
        { logicalId: 'Allow', type: 'AWS::Lambda::Permission', physicalId: null },
        { logicalId: 'Queue', type: 'AWS::SQS::Queue', physicalId: 'orders-queue' },
        fn('Reports', 'reports'),
      ],
    ]);
    expect(await stacks.get(ACCOUNT, 'shop')).toEqual(replaced);
    expect(replaced.createdAt).toEqual(made.createdAt);
    expect(await audited('stack.put')).toEqual([
      { resource: 'stack:shop', details: { templateSha256: SHA, created: true, added: ['Orders', 'Queue'], changed: [], removed: [] } },
      { resource: 'stack:shop', details: { templateSha256: SHA, created: false, added: ['Reports', 'Allow'], changed: [], removed: ['Orders'] } },
    ]);
  });

  it("lists the account's stacks by name, their resources counted, and no other account's", async () => {
    await stacks.put(ACCOUNT, 'shop', shop([fn('Orders', 'orders'), fn('Reports', 'reports')]));
    await stacks.put(ACCOUNT, 'empty', shop([]));
    await stacks.put(OTHER, 'theirs', shop([]));

    expect((await stacks.list(ACCOUNT)).map(({ name, resources }) => [name, resources])).toEqual([
      ['empty', 0],
      ['shop', 2],
    ]);
    await expect(stacks.get(OTHER, 'shop')).rejects.toThrow('The account has no stack named "shop"');
  });

  it("refuses a name CloudFormation wouldn't take, a logical ID or an FF resource given twice, and what the account hasn't, another account's bucket among them", async () => {
    await expect(stacks.put(ACCOUNT, '1shop', shop([]))).rejects.toThrow("A stack's name is letters, digits and hyphens, a letter first, 128 at most, as CloudFormation's");
    const refused = await refusal(
      stacks.put(
        ACCOUNT,
        'shop',
        shop([
          fn('Orders', 'orders'),
          fn('Orders', 'reports'),
          fn('Again', 'orders'),
          fn('Missing', 'nowhere'),
          { logicalId: 'Photos', type: 'AWS::S3::Bucket', physicalId: 'their-photos' },
          { logicalId: 'Live', type: 'AWS::Lambda::Alias', physicalId: 'nowhere:live' },
          { logicalId: 'Url', type: 'AWS::Lambda::Url', physicalId: 'orders' },
        ]),
      ),
    );

    expect(refused).toEqual([
      "Orders is given twice: a logical ID is a template's once",
      'Orders and Again are both the AWS::Serverless::Function orders: an FF resource is a stack\'s once',
      'Missing: the account has no function named "nowhere"',
      'Photos: the account has no bucket named "their-photos"',
      'Live: the account has no function named "nowhere"',
    ]);
    expect(await query(`SELECT count(*)::int AS n FROM stacks`)).toEqual([{ n: 0 }]);
  });

  it('keeps a function, a queue or a bucket in one stack at most, two puts at once included, naming the stack that has it', async () => {
    await stacks.put(ACCOUNT, 'shop', shop([fn('Orders', 'orders')]));

    expect(await refusal(stacks.put(ACCOUNT, 'billing', shop([{ logicalId: 'Billing', type: 'AWS::Lambda::Function', physicalId: 'orders' }])))).toEqual([
      'Billing: the function "orders" is the stack shop\'s, its Orders: a function, a queue or a bucket is in one stack at most',
    ]);

    // Each passes the check alone; the unique index lets one of them save.
    const both = await Promise.all([refusal(stacks.put(ACCOUNT, 'one', shop([fn('Reports', 'reports')]))), refusal(stacks.put(ACCOUNT, 'two', shop([fn('Reports', 'reports')])))]);
    expect(both.map((problems) => problems.length).sort()).toEqual([0, 1]);
    expect(both.flat()[0]).toMatch(
      /^(Another of the account's stacks was given one of these resources meanwhile: deploy again|Reports: the function "reports" is the stack (one|two)'s, its Reports: .*)$/,
    );
    expect(await stacks.ofFunctions(ACCOUNT, ['orders', 'reports', 'nowhere'])).toEqual(
      new Map([
        ['orders', 'shop'],
        ['reports', (await stacks.list(ACCOUNT)).find((stack) => stack.name !== 'shop')?.name],
      ]),
    );
  });

  it("forgets a stack, what it made staying, in the audit log; another account's is not found", async () => {
    await stacks.put(ACCOUNT, 'shop', shop([fn('Orders', 'orders')]));
    await expect(stacks.remove(OTHER, 'shop')).rejects.toThrow('The account has no stack named "shop"');

    await stacks.remove(ACCOUNT, 'shop');

    expect([await stacks.list(ACCOUNT), await query(`SELECT count(*)::int AS n FROM stack_resources`), await query(`SELECT name FROM functions WHERE name = 'orders'`)]).toEqual([
      [],
      [{ n: 0 }],
      [{ name: 'orders' }],
    ]);
    expect(await audited('stack.delete')).toEqual([{ resource: 'stack:shop', details: { resources: 1 } }]);
    await expect(stacks.remove(ACCOUNT, 'shop')).rejects.toThrow('The account has no stack named "shop"');
  });

  it("refuses a new stack past CloudFormation's 2,000 in an account, nothing kept; the ones there still change", async () => {
    await query(`INSERT INTO stacks (account_id, name, template_sha256, parameters) SELECT $1, 's' || n, $2, '{}' FROM generate_series(1, $3::int) AS n`, [ACCOUNT, SHA, MAX_STACKS]);

    await expect(stacks.put(ACCOUNT, 'shop', shop([]))).rejects.toThrow("The account has 2,000 stacks, CloudFormation's most: delete one first");
    expect((await stacks.put(ACCOUNT, 's1', shop([fn('Orders', 'orders')]))).resources).toHaveLength(1);
    expect(await query(`SELECT count(*)::int AS n FROM stacks WHERE account_id = $1`, [ACCOUNT])).toEqual([{ n: MAX_STACKS }]);
  });
});
