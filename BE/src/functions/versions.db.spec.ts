/**
 * L2: functions' versions and aliases, on a real PostgreSQL: versions numbered
 * under the function's lock, never a number twice; frozen as they were
 * published, their variables sealed for each alone; refused as Lambda's
 * PublishVersion refuses. Aliases naming versions that are there, which can't
 * be deleted while one names them; refused as Lambda's CreateAlias and
 * UpdateAlias refuse. Both gone with their function. A version's pods, as the
 * service asks the cluster for them: $LATEST's label at a publish, a version's
 * objects deleted with it. Each run works in a scratch database, dropped
 * afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ConflictException, InternalServerErrorException, NotFoundException, PreconditionFailedException } from '@nestjs/common';
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
import { FunctionAliasesService } from './aliases.service';
import { FunctionAlias } from './entities/function-alias.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Function, Runtime } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';
import { noFunctionKeys, noPackages } from './test-fixtures';
import { FunctionVersionsService } from './versions.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000021';
const OTHER = '400000000022';

run("functions' versions and aliases (L2)", () => {
  let db: ScratchDatabase;
  let functions: FunctionsService;
  let versions: FunctionVersionsService;
  let aliases: FunctionAliasesService;

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
  /** The cluster as the services ask it: what they asked is what each mock was called with. */
  const orchestrator = {
    deploy: async () => undefined,
    update: async () => undefined,
    waitUntilReady: async () => undefined,
    scale: async () => undefined,
    remove: jest.fn(async () => undefined),
    labelLatest: jest.fn(async () => undefined),
    removeVersion: jest.fn(async () => undefined),
  };
  /** The calls of a mock for one function: the suite's functions share the cluster. */
  const callsFor = (mock: jest.Mock, id: string) => mock.mock.calls.filter(([fn]) => fn.id === id);
  const query = <T>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [ACCOUNT, OTHER]) await db.dataSource.getRepository(Account).save({ id, name: `Versions ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    const keys = [{ id: 'test', key: randomBytes(32) }];
    const store = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), new EncryptionService({ getOrThrow: () => keys } as unknown as ConfigService));
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
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
    const region = { getOrThrow: () => 'tn-tunis-1' } as unknown as ConfigService;
    versions = new FunctionVersionsService(db.dataSource.getRepository(FunctionVersion), functions, store, packages, audit, orchestrator as unknown as Orchestrator, region);
    aliases = new FunctionAliasesService(db.dataSource.getRepository(FunctionAlias), functions, audit, region);
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

  it('goes with its function, its pods with its own', async () => {
    const fn = await functions.create(ACCOUNT, body('deleted'));
    await versions.publish(ACCOUNT, fn.id, {});
    await functions.update(ACCOUNT, fn.id, { memory: 256 });
    await versions.publish(ACCOUNT, fn.id, {});
    await versions.remove(ACCOUNT, fn.id, 1);

    await functions.remove(ACCOUNT, fn.id);

    expect(await query(`SELECT * FROM function_versions WHERE function_id = $1`, [fn.id])).toEqual([]);
    // By its name: the record removed, TypeORM cleared its ID, which the call's argument is.
    expect(orchestrator.remove).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, name: 'deleted' }), [2]);
  });

  it("starts moving $LATEST's pods onto their label at each new version, and only then; a failure to doesn't stop the publish", async () => {
    const fn = await functions.create(ACCOUNT, body('labelled'));

    await versions.publish(ACCOUNT, fn.id, {});
    await versions.publish(ACCOUNT, fn.id, { description: 'nothing else changed' });
    expect(callsFor(orchestrator.labelLatest, fn.id)).toEqual([[{ id: fn.id, accountId: ACCOUNT }]]);

    orchestrator.labelLatest.mockRejectedValueOnce(new Error('the API server is down'));
    await functions.update(ACCOUNT, fn.id, { memory: 256 });
    expect((await versions.publish(ACCOUNT, fn.id, {})).version).toBe('2');
    expect(callsFor(orchestrator.labelLatest, fn.id)).toHaveLength(2);
  });

  it("deletes a version's pods before its record; when they can't be, the version stays, to be deleted again", async () => {
    const fn = await functions.create(ACCOUNT, body('unpublished'));
    await versions.publish(ACCOUNT, fn.id, {});

    orchestrator.removeVersion.mockRejectedValueOnce(new Error('the API server is down'));
    await expect(versions.remove(ACCOUNT, fn.id, 1)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(await numbers(fn.id)).toEqual(['1']);
    const deletions = () => query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'version.delete' AND resource = $1`, [`function:${fn.id}`]);
    expect((await deletions())[0].n).toBe(0);

    await versions.remove(ACCOUNT, fn.id, 1);
    expect(await numbers(fn.id)).toEqual([]);
    expect(callsFor(orchestrator.removeVersion, fn.id)).toEqual([[{ id: fn.id, accountId: ACCOUNT, version: 1 }], [{ id: fn.id, accountId: ACCOUNT, version: 1 }]]);
    expect((await deletions())[0].n).toBe(1);
  });

  describe('aliases', () => {
    /** A function with versions 1, 2 and 3, each of its memory. */
    const withVersions = async (name: string) => {
      const fn = await functions.create(ACCOUNT, body(name));
      for (const memory of [256, 512, 1024]) {
        await versions.publish(ACCOUNT, fn.id, {});
        await functions.update(ACCOUNT, fn.id, { memory });
      }
      return fn;
    };
    const names = async (id: string) => (await aliases.list(ACCOUNT, id)).map((alias) => `${alias.name}:${alias.functionVersion}`);
    const audited = async (id: string, action: string) =>
      (await query<Array<{ details: unknown }>>(`SELECT details FROM audit_log WHERE action = $1 AND resource = $2 ORDER BY id`, [action, `function:${id}`])).map((entry) => entry.details);

    it('names a version or $LATEST, and another version with its share; lists them by name', async () => {
      const fn = await withVersions('aliased');

      const live = await aliases.create(ACCOUNT, fn.id, { name: 'live', functionVersion: '2', description: 'The shop', routingConfig: { additionalVersionWeights: { '3': 0.1 } } });
      expect(live).toEqual({
        aliasArn: `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:aliased:live`,
        name: 'live',
        functionVersion: '2',
        description: 'The shop',
        routingConfig: { additionalVersionWeights: { '3': 0.1 } },
        revisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      const dev = await aliases.create(ACCOUNT, fn.id, { name: 'dev', functionVersion: '$LATEST' });
      expect(dev).not.toHaveProperty('routingConfig');

      expect(await names(fn.id)).toEqual(['dev:$LATEST', 'live:2']);
      expect(await aliases.get(ACCOUNT, fn.id, 'live')).toEqual(live);
      expect(await audited(fn.id, 'alias.create')).toEqual([
        { name: 'live', version: '2', additionalVersion: '3', additionalWeight: 0.1 },
        { name: 'dev', version: '$LATEST' },
      ]);
    });

    it("refuses a name the function has, two at once making one; a version it hasn't; a share beside $LATEST or beside its own version", async () => {
      const fn = await withVersions('refusing');

      const twice = await Promise.allSettled([1, 2].map((n) => aliases.create(ACCOUNT, fn.id, { name: 'live', functionVersion: String(n) })));
      expect(twice.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(twice.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictException) });
      await expect(aliases.create(ACCOUNT, fn.id, { name: 'beta', functionVersion: '7' })).rejects.toThrow(
        new NotFoundException('The function refusing has no version 7: GET /functions/{id}/versions lists them'),
      );
      await expect(aliases.create(ACCOUNT, fn.id, { name: 'beta', functionVersion: '1', routingConfig: { additionalVersionWeights: { '7': 0.5 } } })).rejects.toBeInstanceOf(NotFoundException);
      await expect(aliases.create(ACCOUNT, fn.id, { name: 'beta', functionVersion: '$LATEST', routingConfig: { additionalVersionWeights: { '1': 0.5 } } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(aliases.create(ACCOUNT, fn.id, { name: 'beta', functionVersion: '1', routingConfig: { additionalVersionWeights: { '1': 0.5 } } })).rejects.toBeInstanceOf(BadRequestException);
      expect(await names(fn.id)).toHaveLength(1);
    });

    it('keeps in the database what the service refuses: a share without its version or beyond 0 to 1, another version beside $LATEST', async () => {
      const fn = await withVersions('checked');
      const insert = (version: number | null, additionalVersion: number | null, additionalWeight: number | null) =>
        query(`INSERT INTO function_aliases (function_id, name, account_id, version, additional_version, additional_weight) VALUES ($1, 'x', $2, $3, $4, $5)`, [
          fn.id,
          ACCOUNT,
          version,
          additionalVersion,
          additionalWeight,
        ]);

      const refused: Array<[number | null, number | null, number | null]> = [
        [1, 2, null],
        [1, null, 0.5],
        [1, 2, 1.5],
        [null, 2, 0.5],
      ];
      for (const [version, additionalVersion, additionalWeight] of refused) {
        await expect(insert(version, additionalVersion, additionalWeight)).rejects.toThrow(/violates check constraint/);
      }
      await insert(1, 2, 0.5);
    });

    it("changes what the request names and keeps the rest, with a new revision; refuses another revision's change", async () => {
      const fn = await withVersions('changed');
      const live = await aliases.create(ACCOUNT, fn.id, { name: 'live', functionVersion: '1', description: 'The shop', routingConfig: { additionalVersionWeights: { '2': 0.1 } } });

      const moved = await aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '3', revisionId: live.revisionId });
      expect(moved).toMatchObject({ functionVersion: '3', description: 'The shop', routingConfig: { additionalVersionWeights: { '2': 0.1 } } });
      expect(moved.revisionId).not.toBe(live.revisionId);
      await expect(aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '2', revisionId: live.revisionId })).rejects.toBeInstanceOf(PreconditionFailedException);
      // Nothing changed: no new revision, nothing audited.
      expect((await aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '3', description: 'The shop' })).revisionId).toBe(moved.revisionId);
      // $LATEST with a share is refused, unless the share goes in the same change.
      await expect(aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '$LATEST' })).rejects.toBeInstanceOf(BadRequestException);
      const latest = await aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '$LATEST', routingConfig: { additionalVersionWeights: {} } });
      expect(latest).toMatchObject({ functionVersion: '$LATEST', description: 'The shop' });
      expect(latest).not.toHaveProperty('routingConfig');
      await expect(aliases.update(ACCOUNT, fn.id, 'beta', {})).rejects.toThrow(new NotFoundException('The function changed has no alias beta: GET /functions/{id}/aliases lists them'));

      expect(await audited(fn.id, 'alias.update')).toEqual([
        { name: 'live', before: { version: '1', additionalVersion: '2', additionalWeight: 0.1 }, after: { version: '3', additionalVersion: '2', additionalWeight: 0.1 } },
        { name: 'live', before: { version: '3', additionalVersion: '2', additionalWeight: 0.1 }, after: { version: '$LATEST' } },
      ]);
    });

    it('keeps a version an alias names, as its own or with a share, until the alias points elsewhere or goes', async () => {
      const fn = await withVersions('kept');
      await aliases.create(ACCOUNT, fn.id, { name: 'live', functionVersion: '1' });
      await aliases.create(ACCOUNT, fn.id, { name: 'canary', functionVersion: '2', routingConfig: { additionalVersionWeights: { '1': 0.5 } } });

      await expect(versions.remove(ACCOUNT, fn.id, 1)).rejects.toThrow(
        new ConflictException('Version 1 of the function kept is named by its aliases canary, live: point them at another version, or delete them, first'),
      );
      await aliases.update(ACCOUNT, fn.id, 'live', { functionVersion: '3' });
      await aliases.remove(ACCOUNT, fn.id, 'canary');
      await versions.remove(ACCOUNT, fn.id, 1);

      expect(await numbers(fn.id)).toEqual(['2', '3']);
      await expect(aliases.remove(ACCOUNT, fn.id, 'canary')).rejects.toBeInstanceOf(NotFoundException);
      expect(await audited(fn.id, 'alias.delete')).toEqual([{ name: 'canary' }]);
    });

    it("is the account's own, and goes with its function", async () => {
      const fn = await withVersions('owned');
      await aliases.create(ACCOUNT, fn.id, { name: 'live', functionVersion: '1' });

      for (const call of [
        aliases.create(OTHER, fn.id, { name: 'other', functionVersion: '1' }),
        aliases.list(OTHER, fn.id),
        aliases.get(OTHER, fn.id, 'live'),
        aliases.update(OTHER, fn.id, 'live', { functionVersion: '2' }),
        aliases.remove(OTHER, fn.id, 'live'),
      ]) {
        await expect(call).rejects.toThrow(new NotFoundException(`Function with ID ${fn.id} not found`));
      }
      expect(await names(fn.id)).toEqual(['live:1']);

      await functions.remove(ACCOUNT, fn.id);
      expect(await query(`SELECT * FROM function_aliases WHERE function_id = $1`, [fn.id])).toEqual([]);
    });
  });
});
