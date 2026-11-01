/**
 * L2: functions' versions, on a real PostgreSQL: numbered under the function's
 * lock, never a number twice; frozen as they were published, their variables
 * sealed for each alone; refused as Lambda's PublishVersion refuses; gone with
 * their function. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ConflictException, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { UnsealError } from '../encryption/envelope';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Function, Runtime } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';
import { noFunctionKeys, noPackages } from './test-fixtures';
import { FunctionVersionsService } from './versions.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000021';
const OTHER = '400000000022';

run("functions' versions (L2)", () => {
  let db: ScratchDatabase;
  let functions: FunctionsService;
  let versions: FunctionVersionsService;

  const body = (name: string) => ({
    name,
    runtime: Runtime.NODEJS,
    code: 'exports.handler = async () => "v1";',
    memory: 128,
    timeout: 5,
    environment: { TABLE: 'orders' },
    secrets: { DB_PASSWORD: 'first-password' },
  });
  const numbers = async (id: string) => (await versions.list(ACCOUNT, id)).map((version) => version.version);
  const query = <T>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [ACCOUNT, OTHER]) await db.dataSource.getRepository(Account).save({ id, name: `Versions ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    const keys = [{ id: 'test', key: randomBytes(32) }];
    const store = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), new EncryptionService({ getOrThrow: () => keys } as unknown as ConfigService));
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    const orchestrator = { deploy: async () => undefined, update: async () => undefined, waitUntilReady: async () => undefined, scale: async () => undefined, remove: async () => undefined };
    const [packages, images] = noPackages();
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined, deleteCode: async () => undefined } as never,
      orchestrator as unknown as Orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      {} as never, // no invocations here: no metrics
      onePlan(),
      audit,
      {} as never, // no invocations: no usage records
      {} as never, // nor a balance check
      store,
      packages,
      images,
      noFunctionKeys(),
    );
    versions = new FunctionVersionsService(
      db.dataSource.getRepository(FunctionVersion),
      functions,
      store,
      packages,
      audit,
      { getOrThrow: () => 'tn-tunis-1' } as unknown as ConfigService,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM functions');
  });

  it('publishes the function as it is, numbered from 1; a publish with nothing changed, but its description, answers the last', async () => {
    const fn = await functions.create(ACCOUNT, body('orders'));

    const first = await versions.publish(ACCOUNT, fn.id, { description: 'First' });
    expect(first).toMatchObject({
      functionId: fn.id,
      functionArn: `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:orders:1`,
      version: '1',
      description: 'First',
      codeSha256: fn.codeSha256,
      memory: 128,
      revisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(await versions.publish(ACCOUNT, fn.id, { description: 'Again' })).toEqual(first);

    await functions.update(ACCOUNT, fn.id, { memory: 256 });
    expect(await versions.publish(ACCOUNT, fn.id, {})).toMatchObject({ version: '2', memory: 256, description: '' });
    expect(await numbers(fn.id)).toEqual(['1', '2']);
    const audited = await query<Array<{ details: unknown }>>(`SELECT details FROM audit_log WHERE action = 'function.publish' AND resource = $1 ORDER BY id`, [`function:${fn.id}`]);
    expect(audited.map((entry) => entry.details)).toEqual([{ version: 1, codeSha256: fn.codeSha256, description: 'First' }, { version: 2, codeSha256: fn.codeSha256 }]);
  });

  it("keeps a version as it was published: its function's changes don't reach it, its environment's either, and its secrets stay sealed", async () => {
    const fn = await functions.create(ACCOUNT, body('frozen'));
    await versions.publish(ACCOUNT, fn.id, {});

    await functions.update(ACCOUNT, fn.id, { code: 'exports.handler = async () => "v2";', environment: { TABLE: 'invoices' } });
    expect(await versions.get(ACCOUNT, fn.id, 1)).toMatchObject({ codeSha256: fn.codeSha256, environment: { TABLE: 'orders' } });
    expect((await versions.publish(ACCOUNT, fn.id, {})).version).toBe('2');
    const second = await versions.get(ACCOUNT, fn.id, 2);
    expect(second).toMatchObject({ version: '2', environment: { TABLE: 'invoices' } });
    expect(second.codeSha256).not.toBe(fn.codeSha256);

    // A secret set again to another value is a change, which a publish makes a version of.
    await functions.updateSecrets(ACCOUNT, fn.id, { DB_PASSWORD: 'second-password' });
    expect((await versions.publish(ACCOUNT, fn.id, {})).version).toBe('3');
    const [{ dump }] = await query<Array<{ dump: string }>>(`SELECT string_agg(v::text, ' ') AS dump FROM function_versions v`);
    expect(dump).not.toMatch(/orders|invoices|password|TABLE|DB_PASSWORD/);
    expect(JSON.stringify(await versions.list(ACCOUNT, fn.id))).not.toMatch(/orders|invoices|password/);
  });

  it("doesn't open a version's environment copied onto another version", async () => {
    const fn = await functions.create(ACCOUNT, body('copied'));
    await versions.publish(ACCOUNT, fn.id, {});
    await functions.update(ACCOUNT, fn.id, { environment: { TABLE: 'invoices' } });
    await versions.publish(ACCOUNT, fn.id, {});
    await query(`UPDATE function_versions SET environment = (SELECT environment FROM function_versions WHERE function_id = $1 AND version = 1) WHERE function_id = $1 AND version = 2`, [fn.id]);

    await expect(versions.get(ACCOUNT, fn.id, 2)).rejects.toBeInstanceOf(UnsealError);
  });

  it("never gives a number twice: a deleted version's, the last one's included", async () => {
    const fn = await functions.create(ACCOUNT, body('renumbered'));
    for (const memory of [256, 512]) {
      await versions.publish(ACCOUNT, fn.id, {});
      await functions.update(ACCOUNT, fn.id, { memory });
    }
    await versions.remove(ACCOUNT, fn.id, 2);
    await expect(versions.remove(ACCOUNT, fn.id, 2)).rejects.toThrow(new NotFoundException('The function renumbered has no version 2: GET /functions/{id}/versions lists them'));
    await expect(versions.get(ACCOUNT, fn.id, 2)).rejects.toBeInstanceOf(NotFoundException);

    const before = await functions.findOne(ACCOUNT, fn.id);
    expect((await versions.publish(ACCOUNT, fn.id, {})).version).toBe('3');
    expect(await numbers(fn.id)).toEqual(['1', '3']);
    // A publish changes nothing of the function's own.
    expect(await functions.findOne(ACCOUNT, fn.id)).toEqual(before);
    const [{ n }] = await query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'version.delete' AND resource = $1`, [`function:${fn.id}`]);
    expect(n).toBe(1);
  });

  it('publishes one version of two publishes at once', async () => {
    const fn = await functions.create(ACCOUNT, body('concurrent'));

    const published = await Promise.all([versions.publish(ACCOUNT, fn.id, {}), versions.publish(ACCOUNT, fn.id, {}), versions.publish(ACCOUNT, fn.id, {})]);

    expect(published.map((version) => version.version)).toEqual(['1', '1', '1']);
    expect(await numbers(fn.id)).toEqual(['1']);
  });

  it("refuses as Lambda: another revision with 412, another code's SHA-256 with 400, a function without working code with 409", async () => {
    const fn = await functions.create(ACCOUNT, body('checked'));
    const read = (await functions.describe(ACCOUNT, fn.id)).revisionId;
    await functions.update(ACCOUNT, fn.id, { timeout: 10 });
    const now = (await functions.describe(ACCOUNT, fn.id)).revisionId;
    expect(now).not.toBe(read);

    await expect(versions.publish(ACCOUNT, fn.id, { revisionId: read })).rejects.toBeInstanceOf(PreconditionFailedException);
    await expect(versions.publish(ACCOUNT, fn.id, { codeSha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await numbers(fn.id)).toEqual([]);
    expect((await versions.publish(ACCOUNT, fn.id, { revisionId: now, codeSha256: fn.codeSha256 })).version).toBe('1');
    // An update that changes nothing changes no revision.
    await functions.update(ACCOUNT, fn.id, { timeout: 10 });
    expect((await functions.describe(ACCOUNT, fn.id)).revisionId).toBe(now);

    await query(`UPDATE functions SET status = 'ERROR' WHERE id = $1`, [fn.id]);
    await expect(versions.publish(ACCOUNT, fn.id, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it("is the account's own: another account's function is not found", async () => {
    const fn = await functions.create(ACCOUNT, body('mine'));
    await versions.publish(ACCOUNT, fn.id, {});

    for (const call of [versions.publish(OTHER, fn.id, {}), versions.list(OTHER, fn.id), versions.get(OTHER, fn.id, 1), versions.remove(OTHER, fn.id, 1)]) {
      await expect(call).rejects.toThrow(new NotFoundException(`Function with ID ${fn.id} not found`));
    }
    expect(await numbers(fn.id)).toEqual(['1']);
  });

  it('goes with its function', async () => {
    const fn = await functions.create(ACCOUNT, body('deleted'));
    await versions.publish(ACCOUNT, fn.id, {});

    await functions.remove(ACCOUNT, fn.id);

    expect(await query(`SELECT * FROM function_versions WHERE function_id = $1`, [fn.id])).toEqual([]);
  });
});
