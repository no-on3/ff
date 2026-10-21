/**
 * L2: functions' variables are stored sealed, on a real PostgreSQL: what the
 * table holds, what the service saves through the store, and that they go with
 * their function. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { UnsealError } from '../encryption/envelope';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function, Runtime } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000011';

run("functions' environments, sealed in the database (L2)", () => {
  let db: ScratchDatabase;
  let store: EnvironmentStore;
  let functions: FunctionsService;
  const deployed: unknown[] = [];

  const encryption = (keys = [{ id: 'test', key: randomBytes(32) }]) =>
    new EncryptionService({ getOrThrow: () => keys } as unknown as ConfigService);
  const body = (name: string, environment?: Record<string, string>) => ({
    name,
    runtime: Runtime.NODEJS,
    code: 'exports.handler = async () => process.env;',
    memory: 128,
    timeout: 5,
    ...(environment ? { environment } : {}),
  });
  const rowOf = (functionId: string) => db.dataSource.getRepository(FunctionEnvironment).findOneBy({ functionId });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Environments', planId: 'beta', status: AccountStatus.ACTIVE });
    store = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), encryption());
    const orchestrator = {
      deploy: async (fn: unknown) => deployed.push(fn),
      update: async (fn: unknown) => deployed.push(fn),
      waitUntilReady: async () => undefined,
      scale: async () => undefined,
      remove: async () => undefined,
    };
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined, deleteCode: async () => undefined } as never,
      orchestrator as unknown as Orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      {} as never, // no invocations here: no metrics
      onePlan(),
      { record: async () => undefined } as never,
      {} as never, // no invocations: no usage records
      {} as never, // nor a balance check
      store,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    deployed.length = 0;
    await db.dataSource.query('DELETE FROM functions');
  });

  it('keeps no value in clear: neither the row nor the database holds one', async () => {
    const fn = await functions.create(ACCOUNT, body('sealed', { DB_PASSWORD: 'correct-horse-battery', TABLE: 'orders' }));

    const row = await rowOf(fn.id);
    expect(row).toMatchObject({ accountId: ACCOUNT, revision: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(row!.document).toMatchObject({ v: 1, kid: 'test' });
    // Every column of every row, as text.
    const [{ dump }] = await db.dataSource.query<Array<{ dump: string }>>(`SELECT string_agg(e::text, ' ') AS dump FROM function_environments e`);
    expect(dump).not.toContain('correct-horse-battery');
    expect(dump).not.toContain('orders');
    expect(dump).not.toContain('DB_PASSWORD');
  });

  it('opens what it sealed: the service reads the variables back, and the orchestrator was given them', async () => {
    const fn = await functions.create(ACCOUNT, body('readable', { TABLE: 'orders' }));

    expect((await functions.describe(ACCOUNT, fn.id)).environment).toEqual({ TABLE: 'orders' });
    expect(deployed).toEqual([expect.objectContaining({ environment: { revision: (await rowOf(fn.id))!.revision, values: { TABLE: 'orders' } } })]);
  });

  it('saves a change once it is live, with a new revision, and deletes the row when none is left', async () => {
    const fn = await functions.create(ACCOUNT, body('changing', { TABLE: 'orders' }));
    const before = (await rowOf(fn.id))!.revision;

    await functions.update(ACCOUNT, fn.id, { environment: { TABLE: 'invoices' } });
    const after = await rowOf(fn.id);
    expect(after!.revision).not.toBe(before);
    expect((await store.load(fn.id)).variables).toEqual({ TABLE: 'invoices' });

    await functions.update(ACCOUNT, fn.id, { environment: {} });
    expect(await rowOf(fn.id)).toBeNull();
  });

  it("doesn't open a row copied onto another function", async () => {
    const [a, b] = [await functions.create(ACCOUNT, body('a', { SECRET_SAUCE: 'a' })), await functions.create(ACCOUNT, body('b', { OTHER: 'b' }))];
    await db.dataSource.query(`UPDATE function_environments SET document = (SELECT document FROM function_environments WHERE function_id = $1) WHERE function_id = $2`, [a.id, b.id]);

    await expect(store.load(b.id)).rejects.toBeInstanceOf(UnsealError);
  });

  it("doesn't open with another platform key", async () => {
    const fn = await functions.create(ACCOUNT, body('keyed', { TABLE: 'orders' }));
    const otherKeys = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), encryption([{ id: 'test', key: randomBytes(32) }]));

    await expect(otherKeys.load(fn.id)).rejects.toBeInstanceOf(UnsealError);
  });

  it('keeps secrets sealed too: set and removed through the service, never in clear, never in its answers', async () => {
    const fn = await functions.create(ACCOUNT, { ...body('with-secrets', { DB_USER: 'ff' }), secrets: { DB_PASSWORD: 'first-password' } });

    const listed = await functions.updateSecrets(ACCOUNT, fn.id, { DB_PASSWORD: 'second-password', API_TOKEN: 'token-value' });
    const [{ dump }] = await db.dataSource.query<Array<{ dump: string }>>(`SELECT string_agg(e::text, ' ') AS dump FROM function_environments e`);

    expect(listed.secrets.map((secret) => secret.name)).toEqual(['API_TOKEN', 'DB_PASSWORD']);
    expect(dump).not.toMatch(/password|token-value|DB_PASSWORD|API_TOKEN/);
    expect((await store.load(fn.id)).secrets.DB_PASSWORD.value).toBe('second-password');
    expect(JSON.stringify([fn, listed, await functions.describe(ACCOUNT, fn.id)])).not.toMatch(/first-password|second-password|token-value/);

    await functions.updateSecrets(ACCOUNT, fn.id, { API_TOKEN: null });
    expect(Object.keys((await store.load(fn.id)).secrets)).toEqual(['DB_PASSWORD']);
  });

  it('goes with its function: deleting the function deletes its row', async () => {
    const fn = await functions.create(ACCOUNT, body('deleted', { TABLE: 'orders' }));

    await functions.remove(ACCOUNT, fn.id);

    expect(await rowOf(fn.id)).toBeNull();
  });
});
