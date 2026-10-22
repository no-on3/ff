/**
 * L2: the scheduler on a real PostgreSQL: two schedulers ticking at once never
 * run a schedule twice; a disabled one never runs; a run moves its schedule on;
 * deleting the function deletes its schedules; every plan has its limit on
 * them. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { InvocationStatus } from '../functions/entities/function-invocation.entity';
import { EventFormat, Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { parsePlanLimits } from '../plans/plan-limits';
import { plan } from '../plans/test-fixtures';
import { Schedule } from './schedule.entity';
import { SchedulerService } from './scheduler.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000041';
const NOW = new Date('2026-10-21T08:00:03Z');

run('the scheduler, in the database (L2)', () => {
  let db: ScratchDatabase;
  /** Each schedule's runs, by the schedule's ID; each call takes a moment, as a real one does. */
  const calls: string[] = [];
  let fn: Function;

  const scheduler = () => {
    const functions = {
      findOne: async () => fn,
      call: async (_fn: unknown, event: { resources?: string[] } | null, options: { requestId: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        calls.push(options.requestId);
        return { ok: true, invocation: { id: options.requestId, status: InvocationStatus.COMPLETED }, output: event };
      },
    };
    return new SchedulerService(
      { getOrThrow: (key: string) => ({ 'schedules.intervalSeconds': 0, 'schedules.region': 'tn-tunis-1' })[key] } as unknown as ConfigService,
      db.dataSource,
      functions as never,
      { admit: async () => undefined } as never,
      { get: async () => plan({ invokesPerSecond: 1000 }) } as never,
      { count: () => undefined } as never,
      db.dataSource.getRepository(Account),
      new ThrottlerStorageService(),
    );
  };
  const due = (name: string, values: Partial<Schedule> = {}) =>
    db.dataSource.getRepository(Schedule).save({
      accountId: ACCOUNT,
      functionId: fn.id,
      name,
      expression: 'rate(5 minutes)',
      enabled: true,
      nextRunAt: new Date('2026-10-21T08:00:00Z'),
      anchorAt: new Date('2026-10-21T07:55:00Z'),
      ...values,
    });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Schedules', planId: 'beta', status: AccountStatus.ACTIVE });
    fn = await db.dataSource.getRepository(Function).save({
      accountId: ACCOUNT,
      name: 'scheduled',
      runtime: Runtime.NODEJS,
      code: 'exports.handler = async (event) => event;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
      eventFormat: EventFormat.LAMBDA,
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    calls.length = 0;
    await db.dataSource.query('DELETE FROM schedules');
  });

  it('gives every plan its limit on schedules: the beta plan 20, read as valid', async () => {
    const beta = await db.dataSource.getRepository(Plan).findOneByOrFail({ id: 'beta' });

    expect(parsePlanLimits('beta', beta.limits).schedules).toBe(20);
  });

  it('never runs a schedule twice, though two schedulers tick at once', async () => {
    for (let i = 0; i < 20; i++) await due(`s-${i}`);
    const [a, b] = [scheduler(), scheduler()];

    const taken = await Promise.all([a.tick(NOW), b.tick(NOW), a.tick(NOW), b.tick(NOW)]);
    await Promise.all([a.settled(), b.settled()]);

    expect(taken.reduce((sum, n) => sum + n, 0)).toBe(20);
    expect(calls).toHaveLength(20);
    const rows = await db.dataSource.getRepository(Schedule).find();
    // Each moved to its next run, its run's ID and outcome on it.
    expect(rows.every((row) => row.nextRunAt?.toISOString() === '2026-10-21T08:05:00.000Z' && row.lastOutcome === 'success')).toBe(true);
    expect(new Set(rows.map((row) => row.lastRequestId))).toEqual(new Set(calls));
  });

  it('never runs a disabled schedule, nor one not due', async () => {
    await due('off', { enabled: false });
    await due('later', { nextRunAt: new Date('2026-10-21T09:00:00Z') });

    expect(await scheduler().tick(NOW)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("runs a late schedule once, then on its grid after now: missed runs aren't made up", async () => {
    await due('late', { nextRunAt: new Date('2026-10-21T06:00:00Z'), anchorAt: new Date('2026-10-21T05:55:00Z') });
    const s = scheduler();

    await s.tick(NOW);
    await s.settled();

    const row = await db.dataSource.getRepository(Schedule).findOneByOrFail({ name: 'late' });
    expect([calls.length, row.lastRunAt?.toISOString(), row.nextRunAt?.toISOString()]).toEqual([1, '2026-10-21T06:00:00.000Z', '2026-10-21T08:05:00.000Z']);
  });

  it('deletes the schedules with their function', async () => {
    const other = await db.dataSource.getRepository(Function).save({
      accountId: ACCOUNT,
      name: 'going',
      runtime: Runtime.NODEJS,
      code: 'exports.handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
    await db.dataSource.getRepository(Schedule).save({ accountId: ACCOUNT, functionId: other.id, name: 'gone', expression: 'rate(1 hour)' });

    await db.dataSource.getRepository(Function).delete({ id: other.id });

    expect(await db.dataSource.getRepository(Schedule).countBy({ functionId: other.id })).toBe(0);
  });
});
