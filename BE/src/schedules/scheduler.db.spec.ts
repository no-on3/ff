/**
 * L2: the scheduler on a real PostgreSQL: two schedulers ticking at once never
 * queue a run twice; a run is kept in its function's queue in the transaction
 * that moves its schedule on, so that neither happens without the other; a
 * disabled schedule never runs; a late one runs once; deleting the function
 * deletes its schedules and its queued runs; every plan has its limit on
 * them. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EventFormat, Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { parsePlanLimits } from '../plans/plan-limits';
import { plan } from '../plans/test-fixtures';
import { AsyncEventCounts, AsyncEventUse } from '../queues/async-event-counts.service';
import { QueueStore } from '../queues/queue-store';
import { Schedule } from './schedule.entity';
import { SchedulerService } from './scheduler.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000041';
const NOW = new Date('2026-10-21T08:00:03Z');

run('the scheduler, in the database (L2)', () => {
  let db: ScratchDatabase;
  let fn: Function;
  /** The events counted as received, as Lambda's metrics count them. */
  let counted: AsyncEventUse[] = [];
  const counts = { count: (use: AsyncEventUse) => void counted.push(use) } as unknown as AsyncEventCounts;

  const scheduler = (queues: QueueStore = new QueueStore(db.dataSource, counts)) =>
    new SchedulerService(
      { getOrThrow: (key: string) => ({ 'schedules.intervalSeconds': 0, 'schedules.region': 'tn-tunis-1' })[key] } as unknown as ConfigService,
      db.dataSource,
      { findOne: async () => fn } as never,
      { admit: async () => undefined } as never,
      { get: async () => plan({ invokesPerSecond: 1000 }) } as never,
      { count: () => undefined } as never,
      db.dataSource.getRepository(Account),
      new ThrottlerStorageService(),
      queues,
    );
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
  const queued = () =>
    db.dataSource.query<Array<{ message_id: string; attributes: { origin: string; scheduleId: string }; body: string }>>(
      'SELECT message_id, attributes, body FROM queue_messages WHERE function_id = $1 ORDER BY id',
      [fn.id],
    );

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
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(async () => {
    await db.dataSource.query('DELETE FROM schedules');
    await db.dataSource.query('DELETE FROM queue_messages');
  });

  it('gives every plan its limit on schedules: the beta plan 20, read as valid', async () => {
    const beta = await db.dataSource.getRepository(Plan).findOneByOrFail({ id: 'beta' });

    expect(parsePlanLimits('beta', beta.limits).schedules).toBe(20);
  });

  it("never queues a run twice, though two schedulers tick at once: each run once in its function's queue, as its schedule's", async () => {
    for (let i = 0; i < 20; i++) await due(`s-${i}`);
    const [a, b] = [scheduler(), scheduler()];

    const taken = await Promise.all([a.tick(NOW), b.tick(NOW), a.tick(NOW), b.tick(NOW)]);

    expect(taken.reduce((sum, n) => sum + n, 0)).toBe(20);
    const runs = await queued();
    const rows = await db.dataSource.getRepository(Schedule).find();
    expect(runs).toHaveLength(20);
    // Each moved to its next run, its run's request ID on it, the run queued under that ID and naming its schedule.
    expect(rows.every((row) => row.nextRunAt?.toISOString() === '2026-10-21T08:05:00.000Z' && row.lastOutcome === 'running')).toBe(true);
    expect(new Set(runs.map((r) => r.message_id))).toEqual(new Set(rows.map((row) => row.lastRequestId)));
    expect(new Set(runs.map((r) => r.attributes.scheduleId))).toEqual(new Set(rows.map((row) => row.id)));
    expect(runs.every((r) => r.attributes.origin === 'schedule' && JSON.parse(r.body)['detail-type'] === 'Scheduled Event')).toBe(true);
  });

  it('moves a schedule on only with its run queued: a run that could not be kept leaves its schedule due, and counts no event received', async () => {
    await due('kept-together');
    const failing = new QueueStore(db.dataSource, counts);
    jest.spyOn(failing, 'sendEvent').mockRejectedValueOnce(new Error('the database refused the write'));
    counted = [];

    expect(await scheduler(failing).tick(NOW)).toBe(0);

    const row = await db.dataSource.getRepository(Schedule).findOneByOrFail({ name: 'kept-together' });
    expect([row.nextRunAt?.toISOString(), row.lastRequestId, (await queued()).length, counted.length]).toEqual(['2026-10-21T08:00:00.000Z', null, 0, 0]);
    // The next tick takes it, its run counted once its transaction committed.
    expect(await scheduler().tick(NOW)).toBe(1);
    expect(await queued()).toHaveLength(1);
    expect(counted).toEqual([{ functionId: fn.id, accountId: ACCOUNT, received: 1 }]);
  });

  it('never runs a disabled schedule, nor one not due', async () => {
    await due('off', { enabled: false });
    await due('later', { nextRunAt: new Date('2026-10-21T09:00:00Z') });

    expect(await scheduler().tick(NOW)).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it("runs a late schedule once, then on its grid after now: missed runs aren't made up", async () => {
    await due('late', { nextRunAt: new Date('2026-10-21T06:00:00Z'), anchorAt: new Date('2026-10-21T05:55:00Z') });

    await scheduler().tick(NOW);

    const row = await db.dataSource.getRepository(Schedule).findOneByOrFail({ name: 'late' });
    expect([(await queued()).length, row.lastRunAt?.toISOString(), row.nextRunAt?.toISOString()]).toEqual([1, '2026-10-21T06:00:00.000Z', '2026-10-21T08:05:00.000Z']);
  });

  it('deletes the schedules with their function, and its runs waiting in its queue', async () => {
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
    await new QueueStore(db.dataSource, counts).sendEvent(other, '00000000-0000-4000-8000-000000000041', '{}', new Date(Date.now() + 3600_000), {
      attributes: { origin: 'schedule' },
    });

    await db.dataSource.getRepository(Function).delete({ id: other.id });

    expect(await db.dataSource.getRepository(Schedule).countBy({ functionId: other.id })).toBe(0);
    expect(await db.dataSource.query(`SELECT count(*)::int AS n FROM queue_messages WHERE function_id = $1`, [other.id])).toEqual([{ n: 0 }]);
  });
});
