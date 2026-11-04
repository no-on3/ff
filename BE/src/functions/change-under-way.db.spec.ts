/**
 * L2: one change of a function at a time, on a real PostgreSQL: a change takes
 * its function in one conditional UPDATE, which a second take, waiting on the
 * row's lock meanwhile, finds taken; a record whose revision moved since it was
 * read isn't taken; a change past its bound is taken over, and its end then
 * saves nothing. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { ChangeUnderWay, SUCCEEDED, changeBoundMs, endChange, failedFor, isUnderWay, takeFunction } from './change-under-way';
import { Function, FunctionStatus, Runtime, UpdateStatus } from './entities/function.entity';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000031';
/** 90 s for an instance to be ready, as FF waits by default. */
const BOUND = changeBoundMs(90_000);

run('one change of a function at a time (L2)', () => {
  let db: ScratchDatabase;

  const functions = () => db.dataSource.getRepository(Function);
  const row = (id: string) => functions().findOneByOrFail({ id });
  /** A function as a request reads it. */
  async function readFunction(): Promise<Function> {
    const { identifiers } = await functions().insert({ accountId: ACCOUNT, name: 'orders', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5, status: FunctionStatus.ACTIVE });
    return row(identifiers[0].id as string);
  }
  /** Waits until another session waits for a lock: the row's. */
  async function someoneWaitsForALock(): Promise<void> {
    for (let tries = 0; tries < 250; tries++) {
      const [{ n }] = await db.dataSource.query<Array<{ n: number }>>(
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
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Changes', planId: 'beta', status: AccountStatus.ACTIVE });
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.dataSource.query('DELETE FROM functions');
  });

  it('takes a function for one of two changes at once: the second, which waited for the row, finds it taken', async () => {
    const read = await readFunction();
    let second!: Promise<ChangeUnderWay | null>;

    await db.dataSource.transaction(async (manager) => {
      await expect(takeFunction(manager, read, new Date(), BOUND)).resolves.toMatchObject({ functionId: read.id });
      second = takeFunction(db.dataSource.manager, read, new Date(), BOUND);
      await someoneWaitsForALock();
    });

    await expect(second).resolves.toBeNull();
    const taken = await row(read.id);
    expect(taken).toMatchObject({ updateStatus: UpdateStatus.IN_PROGRESS, updateReason: null, updateStartedAt: expect.any(Date) });
    expect(isUnderWay(taken, new Date(), BOUND)).toBe(true);
  });

  it("doesn't take a function whose revision moved since it was read", async () => {
    const read = await readFunction();
    await functions().update({ id: read.id }, { revisionId: '6a1f3c2e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' });

    await expect(takeFunction(db.dataSource.manager, read, new Date(), BOUND)).resolves.toBeNull();
    await expect(takeFunction(db.dataSource.manager, await row(read.id), new Date(), BOUND)).resolves.not.toBeNull();
  });

  it('ends a change once, saying how it went, which frees the function', async () => {
    const read = await readFunction();
    const change = (await takeFunction(db.dataSource.manager, read, new Date(), BOUND)) as ChangeUnderWay;

    await expect(endChange(db.dataSource.manager, change, failedFor('boom'), { status: FunctionStatus.ERROR, error: 'boom' })).resolves.toBe(true);
    await expect(endChange(db.dataSource.manager, change, SUCCEEDED)).resolves.toBe(false);

    const ended = await row(read.id);
    expect(ended).toMatchObject({ status: FunctionStatus.ERROR, error: 'boom', updateStatus: UpdateStatus.FAILED, updateReason: 'boom', updateStartedAt: null });
    expect(isUnderWay(ended, new Date(), BOUND)).toBe(false);
    await expect(takeFunction(db.dataSource.manager, ended, new Date(), BOUND)).resolves.not.toBeNull();
  });

  it('takes over a change past its bound, as stopped: its end then saves nothing, the new one ends it', async () => {
    const read = await readFunction();
    const stopped = (await takeFunction(db.dataSource.manager, read, new Date(Date.now() - BOUND - 1_000), BOUND)) as ChangeUnderWay;
    // Within its bound, it holds the function still.
    await expect(takeFunction(db.dataSource.manager, read, new Date(stopped.startedAt.getTime() + BOUND - 1_000), BOUND)).resolves.toBeNull();

    const next = await takeFunction(db.dataSource.manager, read, new Date(), BOUND);

    expect(next).not.toBeNull();
    await expect(endChange(db.dataSource.manager, stopped, SUCCEEDED)).resolves.toBe(false);
    expect(await row(read.id)).toMatchObject({ updateStatus: UpdateStatus.IN_PROGRESS, updateStartedAt: (next as ChangeUnderWay).startedAt });
    await expect(endChange(db.dataSource.manager, next as ChangeUnderWay, SUCCEEDED)).resolves.toBe(true);
    expect(await row(read.id)).toMatchObject({ updateStatus: UpdateStatus.SUCCESSFUL, updateReason: null, updateStartedAt: null });
  });
});
