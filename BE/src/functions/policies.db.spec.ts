/**
 * L2: Lambda's permissions, in FF's database: the function's policy, a
 * version's and an alias's, each statement's ID once in each, two adds of one
 * ID at once included; 20 KB of statements at most; removed by ID; each change
 * in the audit log; gone with what they are the policy of. Each run works in a
 * scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionPolicyStatement } from './entities/function-policy-statement.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionPoliciesService, POLICY_MAX_BYTES } from './policies.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '750000000002';

/** A statement as Lambda's AddPermission writes one, its ID its Sid. */
const statement = (sid: string, more: Record<string, unknown> = {}) => ({ Sid: sid, Effect: 'Allow', Principal: '*', Action: 'lambda:InvokeFunction', ...more });

run("a function's permissions, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  let policies: FunctionPoliciesService;
  let functionId: string;
  const query = <T = unknown>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);
  const sids = async (qualifier?: string) => (await policies.policy(ACCOUNT, functionId, qualifier)).map((kept) => kept.Sid);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Permissions', planId: 'beta', status: AccountStatus.ACTIVE });
    policies = new FunctionPoliciesService(db.dataSource.getRepository(FunctionPolicyStatement), new AuditService(db.dataSource.getRepository(AuditEntry)));
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
    // Version 1 as a publish leaves it, and the alias live naming it.
    await query(
      `INSERT INTO function_versions (function_id, version, account_id, runtime, handler, package_type, code, code_sha256, code_size, package_sha256, memory, timeout, event_format, aws_endpoints)
       VALUES ($1, 1, $2, 'nodejs', 'function.handler', 'inline', 'x', $3, 1, $3, 128, 5, 'lambda', '{}')`,
      [functionId, ACCOUNT, 'x'.repeat(44)],
    );
    await query(`INSERT INTO function_aliases (function_id, name, account_id, version) VALUES ($1, 'live', $2, 1)`, [functionId, ACCOUNT]);
  });

  it("keeps the function's policy, a version's and an alias's apart, an ID once in each, in the order they came; each change in the audit log", async () => {
    await policies.add(ACCOUNT, functionId, undefined, 's3', statement('s3'));
    await policies.add(ACCOUNT, functionId, undefined, 'events', statement('events'));
    await policies.add(ACCOUNT, functionId, '1', 's3', statement('s3'));
    await policies.add(ACCOUNT, functionId, 'live', 's3', statement('s3'));

    expect([await sids(), await sids('1'), await sids('live')]).toEqual([['s3', 'events'], ['s3'], ['s3']]);
    expect(await policies.policy(ACCOUNT, functionId, undefined)).toEqual([statement('s3'), statement('events')]);
    await expect(policies.add(ACCOUNT, functionId, 'live', 's3', statement('s3'))).rejects.toThrow(
      'The statement id (s3) provided already exists. Please provide a new statement id, or remove the existing statement.',
    );
    // Another account's function has no policy here.
    expect(await policies.policy('750000000099', functionId)).toEqual([]);

    await policies.remove(ACCOUNT, functionId, undefined, 's3');
    expect([await sids(), await sids('1')]).toEqual([['events'], ['s3']]);
    await expect(policies.remove(ACCOUNT, functionId, undefined, 's3')).rejects.toThrow('Statement s3 is not found in resource policy.');

    expect(await query(`SELECT action, details FROM audit_log WHERE resource = $1 ORDER BY id`, [`function:${functionId}`])).toEqual([
      { action: 'function.add_permission', details: { statementId: 's3' } },
      { action: 'function.add_permission', details: { statementId: 'events' } },
      { action: 'function.add_permission', details: { statementId: 's3', qualifier: '1' } },
      { action: 'function.add_permission', details: { statementId: 's3', qualifier: 'live' } },
      { action: 'function.remove_permission', details: { statementId: 's3' } },
    ]);
  });

  it('adds one of two statements of one ID sent at once, the other refused, as the function lock orders them', async () => {
    const both = await Promise.allSettled([policies.add(ACCOUNT, functionId, undefined, 'same', statement('same')), policies.add(ACCOUNT, functionId, undefined, 'same', statement('same'))]);

    expect(both.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await sids()).toEqual(['same']);
  });

  it("refuses a statement that would take the policy past 20 KB, in Lambda's words, the policy as it was", async () => {
    const big = (sid: string) => statement(sid, { Condition: { ArnLike: { 'AWS:SourceArn': `arn:aws:s3:::${'b'.repeat(4000)}` } } });
    for (const sid of ['a', 'b', 'c', 'd']) await policies.add(ACCOUNT, functionId, undefined, sid, big(sid));

    const refusal = (await policies.add(ACCOUNT, functionId, undefined, 'e', big('e')).catch((error: unknown) => error)) as BadRequestException;
    expect(refusal.getResponse()).toEqual({
      statusCode: 400,
      error: 'PolicyLengthExceededException',
      message: expect.stringMatching(new RegExp(`^The final policy size \\(\\d+\\) is bigger than the limit \\(${POLICY_MAX_BYTES}\\)\\.$`)),
    });
    expect(await sids()).toEqual(['a', 'b', 'c', 'd']);
    // Another policy of the function has room of its own.
    await policies.add(ACCOUNT, functionId, 'live', 'e', big('e'));
  });

  it("goes with what it is the policy of: the alias, the version, then the function; a version deleted meanwhile is the function's no more", async () => {
    await policies.add(ACCOUNT, functionId, undefined, 'own', statement('own'));
    await policies.add(ACCOUNT, functionId, '1', 'v1', statement('v1'));
    await policies.add(ACCOUNT, functionId, 'live', 'live', statement('live'));

    await query(`DELETE FROM function_aliases WHERE function_id = $1`, [functionId]);
    expect([await sids('live'), await sids('1')]).toEqual([[], ['v1']]);
    await query(`DELETE FROM function_versions WHERE function_id = $1`, [functionId]);
    expect(await sids('1')).toEqual([]);
    await expect(policies.add(ACCOUNT, functionId, '1', 'late', statement('late'))).rejects.toThrow('The function has no version 1');

    await query(`DELETE FROM functions WHERE id = $1`, [functionId]);
    expect(await query(`SELECT count(*)::int AS n FROM function_policies`)).toEqual([{ n: 0 }]);
  });
});
