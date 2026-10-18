/**
 * L2 (P-45): the invocation history's purge against a real PostgreSQL server,
 * in a scratch database dropped after: each account's history kept for its
 * plan's retention, then deleted; a call still running left to the reaper;
 * usage records kept.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { RetentionService } from './retention.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const MINUTE = 60;
const DAY = 86_400;

run('the invocation history purge (L2, P-45)', () => {
  let db: ScratchDatabase;
  let retention: RetentionService;
  let accounts = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);

  /** An account on `planId`, with one function. */
  async function functionOn(planId: string): Promise<Function> {
    const id = `30000000${String(++accounts).padStart(4, '0')}`;
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${accounts}`, planId, status: AccountStatus.ACTIVE });
    return db.dataSource.getRepository(Function).save({
      name: 'fn',
      accountId: id,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
  }

  /** An invocation that started `secondsAgo` before the database's now, with its usage record. */
  async function invokedAgo(fn: Function, secondsAgo: number, status = 'COMPLETED'): Promise<string> {
    const [{ id }] = await query<Array<{ id: string }>>(
      `INSERT INTO function_invocations (function_id, input, output, status, created_at, updated_at)
       VALUES ($1, '{"name": "a user"}', '"hello"', $3, now() - make_interval(secs => $2), now() - make_interval(secs => $2)) RETURNING id`,
      [fn.id, secondsAgo, status],
    );
    await query(`SELECT ff_ensure_month_partition('usage_records', date_trunc('month', (now() - make_interval(secs => $1)) AT TIME ZONE 'UTC')::date)`, [secondsAgo]);
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $2), $3, $4, 'fn', 'nodejs', 128, 1, 1, 'success')`,
      [id, secondsAgo, fn.accountId, fn.id],
    );
    return id;
  }

  const kept = async () => (await query<Array<{ id: string }>>('SELECT id FROM function_invocations ORDER BY id')).map((row) => row.id).sort();
  const usageRecords = async () => (await query<Array<{ n: number }>>('SELECT count(*)::int AS n FROM usage_records'))[0].n;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await query(`INSERT INTO plans (id, name, limits) VALUES ('short', 'Short', $1)`, [JSON.stringify({ ...BETA_LIMITS, historyRetentionDays: 7 })]);
    retention = new RetentionService(db.dataSource);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM function_invocations');
  });

  it("deletes each account's invocations past its own plan's retention, keeps the others and a call still running, and every usage record", async () => {
    const onBeta = await functionOn('beta'); // 30 days
    const onShort = await functionOn('short'); // 7 days
    const keep = [
      await invokedAgo(onBeta, 30 * DAY - MINUTE),
      await invokedAgo(onBeta, 10 * DAY),
      await invokedAgo(onBeta, 40 * DAY, 'RUNNING'), // the reaper's (P-20), whatever its age
      await invokedAgo(onShort, 7 * DAY - MINUTE),
      await invokedAgo(onShort, 0),
    ];
    for (const [fn, secondsAgo] of [[onBeta, 30 * DAY + MINUTE], [onBeta, 90 * DAY], [onShort, 7 * DAY + MINUTE], [onShort, 20 * DAY]] as const) {
      await invokedAgo(fn, secondsAgo, 'ERROR');
    }
    const records = await usageRecords();

    await expect(retention.purgeHistory()).resolves.toBe(4);

    expect(await kept()).toEqual(keep.sort());
    expect(await usageRecords()).toBe(records);
    await expect(retention.purgeHistory()).resolves.toBe(0); // a second pass finds nothing
  });

  it("deletes a batch at a time until none is left, and only the purged accounts' rows", async () => {
    const onShort = await functionOn('short');
    const other = await functionOn('beta');
    for (let i = 0; i < 5; i++) await invokedAgo(onShort, 8 * DAY + i);
    const untouched = await invokedAgo(other, 8 * DAY);

    await expect(retention.purgeHistory(undefined, 2)).resolves.toBe(5);

    expect(await kept()).toEqual([untouched]);
  });

  it("follows the account's plan: moved to a shorter retention, its older history goes at the next purge", async () => {
    const fn = await functionOn('beta');
    await invokedAgo(fn, 10 * DAY);
    const yesterday = await invokedAgo(fn, DAY);
    await expect(retention.purgeHistory()).resolves.toBe(0);

    await query(`UPDATE accounts SET plan_id = 'short' WHERE id = $1`, [fn.accountId]);

    await expect(retention.purgeHistory()).resolves.toBe(1);
    expect(await kept()).toEqual([yesterday]);
  });

  it('measures the retention back from the time it is given', async () => {
    const fn = await functionOn('short');
    const id = await invokedAgo(fn, DAY);
    const [{ now }] = await query<Array<{ now: Date }>>('SELECT now()');

    await expect(retention.purgeHistory(new Date(now.getTime() + 5 * DAY * 1000))).resolves.toBe(0);
    await expect(retention.purgeHistory(new Date(now.getTime() + 6 * DAY * 1000 + MINUTE * 1000))).resolves.toBe(1);
    expect(await kept()).not.toContain(id);
  });
});
