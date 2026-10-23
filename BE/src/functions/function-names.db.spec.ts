/**
 * L2: a function's name is unique within its account, on a real PostgreSQL: the
 * service's check under the account's lock, and the database's index behind it.
 * Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { memoryEnvironments, noFunctionKeys, noPackages } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000001';
const OTHER = '400000000002';

run("functions' names (L2)", () => {
  let db: ScratchDatabase;
  let functions: FunctionsService;
  const waitUntilReady = jest.fn<Promise<void>, Parameters<Orchestrator['waitUntilReady']>>();
  /** What the audit log does with an entry, inside the create's transaction: by default, nothing. */
  let audited: () => Promise<void>;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const body = (name: string) => ({ name, runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 });
  const namesOf = async (accountId: string) =>
    (await db.dataSource.getRepository(Function).find({ where: { accountId }, order: { name: 'ASC' } })).map((fn) => fn.name);
  /** Waits until another session waits for a lock: a row's, or the account's. */
  async function someoneWaitsForALock(): Promise<void> {
    for (let tries = 0; tries < 250; tries++) {
      const [{ n }] = await query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Nobody waited for a lock');
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Names', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other names', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    const orchestrator = { deploy: async () => undefined, update: async () => undefined, waitUntilReady, scale: async () => undefined };
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined, deleteCode: async () => undefined } as never,
      orchestrator as unknown as Orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      {} as never, // no invocations here: no metrics
      onePlan(),
      { record: () => audited() } as never,
      {} as never, // no invocations: no usage records
      {} as never, // nor a balance check
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM functions');
    audited = async () => undefined;
    waitUntilReady.mockReset();
    waitUntilReady.mockResolvedValue(undefined);
  });

  it('makes one function of two creates of one name at once, and answers the other 409', async () => {
    // The first create holds its transaction open once its row is in, and the account's lock with it.
    let saved!: () => void;
    const holding = new Promise<void>((inside) => {
      audited = () => {
        inside();
        return new Promise<void>((resolve) => (saved = resolve));
      };
    });
    const first = functions.create(ACCOUNT, body('twin'));
    await holding;
    audited = async () => undefined;
    const second = functions.create(ACCOUNT, body('twin')).catch((error: unknown) => error);
    await someoneWaitsForALock();
    saved();

    await expect(first).resolves.toMatchObject({ name: 'twin', status: FunctionStatus.ACTIVE });
    const refused = await second;
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).message).toBe(
      'A function named "twin" already exists in this account: choose another name, or change that function',
    );
    expect(await namesOf(ACCOUNT)).toEqual(['twin']);
  });

  it("is no conflict with another account's function of the same name", async () => {
    await functions.create(ACCOUNT, body('shared'));

    await expect(functions.create(OTHER, body('shared'))).resolves.toMatchObject({ name: 'shared', accountId: OTHER });
    expect(await namesOf(ACCOUNT)).toEqual(['shared']);
    expect(await namesOf(OTHER)).toEqual(['shared']);
  });

  it('compares names exactly, case included', async () => {
    await functions.create(ACCOUNT, body('Hello'));

    await expect(functions.create(ACCOUNT, body('hello'))).resolves.toMatchObject({ name: 'hello' });
    expect(await namesOf(ACCOUNT)).toEqual(['Hello', 'hello']);
  });

  it("is kept by the database too, whatever writes the row: the index refuses a second one in the account, not in another's", async () => {
    const row = { accountId: ACCOUNT, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5, status: FunctionStatus.ACTIVE };
    await db.dataSource.getRepository(Function).insert({ ...row, name: 'direct' });

    const refused = await db.dataSource.getRepository(Function).insert({ ...row, name: 'direct' }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(QueryFailedError);
    expect((refused as QueryFailedError & { driverError: { code: string } }).driverError.code).toBe('23505'); // unique_violation
    await expect(db.dataSource.getRepository(Function).insert({ ...row, accountId: OTHER, name: 'direct' })).resolves.toBeDefined();
  });

  it('refuses a rename to a name in use, and changes nothing', async () => {
    await functions.create(ACCOUNT, body('first'));
    const second = await functions.create(ACCOUNT, body('second'));

    await expect(functions.update(ACCOUNT, second.id, { name: 'first', memory: 256 })).rejects.toBeInstanceOf(ConflictException);

    expect(await db.dataSource.getRepository(Function).findOneByOrFail({ id: second.id })).toMatchObject({ name: 'second', memory: 128 });
  });

  it('keeps the record true to the version that went live when a create took the new name during the rollout', async () => {
    const renamed = await functions.create(ACCOUNT, body('old-name'));
    let rolledOut!: () => void;
    const rollingOut = new Promise<void>((started) => {
      waitUntilReady.mockImplementationOnce(() => {
        started();
        return new Promise<void>((resolve) => (rolledOut = resolve));
      });
    });
    const update = functions.update(ACCOUNT, renamed.id, { name: 'wanted', code: 'exports.handler = async () => 2;' }).catch((error: unknown) => error);
    await rollingOut;

    await functions.create(ACCOUNT, body('wanted'));
    rolledOut();

    const answer = await update;
    expect(answer).toBeInstanceOf(ConflictException);
    expect((answer as ConflictException).message).toBe(
      'The new version is live, but the function keeps its name "old-name": another function was given the name "wanted" meanwhile',
    );
    expect(await db.dataSource.getRepository(Function).findOneByOrFail({ id: renamed.id })).toMatchObject({
      name: 'old-name',
      code: 'exports.handler = async () => 2;',
      status: FunctionStatus.ACTIVE,
    });
    expect(await namesOf(ACCOUNT)).toEqual(['old-name', 'wanted']);
  });
});
