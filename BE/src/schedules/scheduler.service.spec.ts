/**
 * L1: the scheduler's runs, with a stand-in database: what a run's call
 * sends (the Scheduled Event, or the schedule's input), kept in its function's
 * queue in the transaction that moves the schedule on, and why a run that
 * can't be made is skipped. The database's part, taking the due schedules
 * once, is L2's (scheduler.db.spec.ts); the run's attempts are the
 * asynchronous calls' worker's.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { EventFormat, FunctionStatus } from '../functions/entities/function.entity';
import { countInvocation } from '../plans/rate-limits';
import { plan } from '../plans/test-fixtures';
import { Schedule } from './schedule.entity';
import { SchedulerService } from './scheduler.service';

const ACCOUNT = '123456789012';
const DUE = new Date('2026-10-21T08:00:00Z');
const NOW = new Date('2026-10-21T08:00:03Z');
const MB = 1024 * 1024;

describe('the scheduler (L1)', () => {
  let scheduler: SchedulerService;
  let throttler: ThrottlerStorageService;
  /** The schedules the stand-in database holds, and the updates it was asked. */
  let rows: Schedule[];
  let updates: Array<[Record<string, unknown>, Record<string, unknown>]>;
  /** The transaction's manager, which the run is queued in. */
  let manager: Record<string, unknown>;
  const fn = { id: 'fn-1', name: 'reports', accountId: ACCOUNT, status: FunctionStatus.ACTIVE, eventFormat: EventFormat.LAMBDA };
  const functions = { findOne: jest.fn() };
  const credit = { admit: jest.fn() };
  const refused = { count: jest.fn() };
  const accounts = { findOne: jest.fn() };
  const plans = { get: jest.fn(async () => plan({ invokesPerSecond: 100 })) };
  const queues = { sendEvent: jest.fn(), accountBytes: jest.fn() };

  const schedule = (values: Partial<Schedule> = {}): Schedule =>
    ({
      id: 's-1',
      accountId: ACCOUNT,
      functionId: 'fn-1',
      name: 'nightly',
      expression: 'rate(5 minutes)',
      input: null,
      enabled: true,
      nextRunAt: DUE,
      anchorAt: new Date('2026-10-21T07:55:00Z'),
      ...values,
    }) as Schedule;

  /** The stand-in database: its query builder answers the due rows, and its updates are kept. */
  const dataSource = () => {
    const builder = {
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      setLock: () => builder,
      setOnLocked: () => builder,
      getMany: async () => rows.filter((row) => row.enabled && (row.nextRunAt as Date) <= NOW),
    };
    manager = {
      getRepository: () => ({ createQueryBuilder: () => builder }),
      update: async (_target: unknown, where: Record<string, unknown>, values: Record<string, unknown>) => void updates.push([where, values]),
    };
    return { transaction: async (work: (m: unknown) => Promise<unknown>) => work(manager) };
  };

  /** One tick; what each run's schedule says, and the runs queued. */
  const tick = async () => {
    await scheduler.tick(NOW);
    return updates.map(([, values]) => values.lastOutcome);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    rows = [schedule()];
    updates = [];
    plans.get.mockImplementation(async () => plan({ invokesPerSecond: 100, queueStorageMb: 100 }));
    functions.findOne.mockImplementation(async () => fn);
    accounts.findOne.mockImplementation(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE, planId: 'beta' }));
    queues.accountBytes.mockImplementation(async () => 0);
    throttler = new ThrottlerStorageService();
    scheduler = new SchedulerService(
      { getOrThrow: (key: string) => ({ 'schedules.intervalSeconds': 0, 'schedules.region': 'tn-tunis-1' })[key] } as unknown as ConfigService,
      dataSource() as never,
      functions as never,
      credit as never,
      plans as never,
      refused as never,
      accounts as never,
      throttler,
      queues as never,
    );
  });

  afterEach(() => {
    throttler.onApplicationShutdown();
    jest.restoreAllMocks();
  });

  it("moves a due schedule to its next run, and keeps its run, EventBridge's Scheduled Event, in its function's queue in the same transaction", async () => {
    expect(await tick()).toEqual(['running']);

    const [[where, values]] = updates;
    expect(where).toEqual({ id: 's-1' });
    // Its runs stay on their grid: every 5 minutes from 07:55.
    expect(values).toEqual({ nextRunAt: new Date('2026-10-21T08:05:00Z'), lastRunAt: DUE, lastOutcome: 'running', lastRequestId: expect.any(String) });
    const [queuedFor, requestId, body, expiresAt, options] = queues.sendEvent.mock.calls[0];
    expect([queuedFor, requestId, options]).toEqual([fn, values.lastRequestId, { manager, attributes: { origin: 'schedule', scheduleId: 's-1' } }]);
    // Kept as long as any function keeps an asynchronous call, and an hour.
    expect((expiresAt as Date).getTime() - NOW.getTime()).toBe(7 * 3600 * 1000);
    expect(JSON.parse(body as string)).toEqual({
      version: '0',
      id: values.lastRequestId,
      'detail-type': 'Scheduled Event',
      source: 'aws.events',
      account: ACCOUNT,
      time: '2026-10-21T08:00:00Z',
      region: 'tn-tunis-1',
      resources: [`arn:aws:events:tn-tunis-1:${ACCOUNT}:rule/reports-nightly`],
      detail: {},
    });
  });

  it("sends the schedule's input when it has one, as SAM's Input", async () => {
    rows = [schedule({ input: { report: 'daily' } })];

    await tick();

    expect(JSON.parse(queues.sendEvent.mock.calls[0][2] as string)).toEqual({ report: 'daily' });
  });

  it('runs a schedule late by any amount once, its next run after now', async () => {
    rows = [schedule({ expression: 'cron(0 * * * ? *)', nextRunAt: new Date('2026-10-21T05:00:00Z'), anchorAt: null })];

    await tick();

    expect(queues.sendEvent).toHaveBeenCalledTimes(1);
    expect(updates[0][1]).toMatchObject({ nextRunAt: new Date('2026-10-21T09:00:00Z'), lastRunAt: new Date('2026-10-21T05:00:00Z') });
  });

  it.each<[string, () => void, string]>([
    ['a function gone', () => functions.findOne.mockRejectedValue(new NotFoundException()), 'skipped: the function is gone'],
    ['a function not ACTIVE', () => functions.findOne.mockResolvedValue({ ...fn, status: FunctionStatus.ERROR }), 'skipped: the function is not ACTIVE'],
    ["a function with FF's original event", () => functions.findOne.mockResolvedValue({ ...fn, eventFormat: EventFormat.WRAPPED }), "skipped: the function takes FF's original wrapped event"],
    ['an account not active', () => accounts.findOne.mockResolvedValue({ id: ACCOUNT, status: AccountStatus.SUSPENDED, planId: 'beta' }), 'skipped: the account is not active'],
    [
      'an account without credit',
      () =>
        credit.admit.mockRejectedValue(
          new InsufficientCreditException(
            { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
            { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
            { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
          ),
        ),
      "skipped: the account's credit has run out",
    ],
    ["an account whose messages hold the plan's room", () => queues.accountBytes.mockResolvedValue(100 * MB), "skipped: the account's messages hold 100 MB together, the Beta plan's limit"],
    ['a check that fails', () => accounts.findOne.mockRejectedValue(new Error('connection lost')), 'skipped: an internal error'],
  ])('skips the run of %s, moving the schedule on, and says why', async (_case, arrange, outcome) => {
    arrange();

    expect(await tick()).toEqual([outcome]);
    expect(updates[0][1]).toMatchObject({ nextRunAt: new Date('2026-10-21T08:05:00Z') });
    expect(queues.sendEvent).not.toHaveBeenCalled();
  });

  it("skips a run over the plan's invocations per second, which the API's invokes and URLs share, counting it as refused", async () => {
    plans.get.mockResolvedValue(plan({ invokesPerSecond: 1 }));
    await countInvocation(throttler, ACCOUNT, 1); // an invoke through the API, this second

    expect(await tick()).toEqual(["skipped: over the plan's invocations per second"]);
    expect(refused.count).toHaveBeenCalledWith(ACCOUNT, 'fn-1');
  });

  it('disables a schedule whose expression it cannot run, and runs the others', async () => {
    rows = [schedule({ id: 'bad', expression: 'every hour' }), schedule({ id: 'good' })];

    expect(await tick()).toEqual(['skipped: its expression is not valid', 'running']);
    expect(updates).toContainEqual([{ id: 'bad' }, { enabled: false, nextRunAt: null, lastOutcome: 'skipped: its expression is not valid' }]);
    expect(queues.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('runs nothing that is disabled or not due', async () => {
    rows = [schedule({ enabled: false }), schedule({ id: 'later', nextRunAt: new Date('2026-10-21T09:00:00Z') })];

    expect(await tick()).toEqual([]);
    expect(queues.sendEvent).not.toHaveBeenCalled();
  });
});
