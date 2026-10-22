/**
 * L1: the scheduler's runs, with a stand-in database: what a run sends (the
 * Scheduled Event, or the schedule's input), how it ends, and why a run that
 * can't be made is skipped. The database's part, taking the due schedules
 * once, is L2's (scheduler.db.spec.ts).
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { InvocationSource, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { EventFormat, FunctionStatus } from '../functions/entities/function.entity';
import { countInvocation } from '../plans/rate-limits';
import { plan } from '../plans/test-fixtures';
import { Schedule } from './schedule.entity';
import { SchedulerService } from './scheduler.service';

const ACCOUNT = '123456789012';
const DUE = new Date('2026-10-21T08:00:00Z');
const NOW = new Date('2026-10-21T08:00:03Z');

describe('the scheduler (L1)', () => {
  let scheduler: SchedulerService;
  let throttler: ThrottlerStorageService;
  /** The schedules the stand-in database holds, and the updates it was asked. */
  let rows: Schedule[];
  let updates: Array<[Record<string, unknown>, Record<string, unknown>]>;
  const functions = { findOne: jest.fn(), call: jest.fn() };
  const credit = { admit: jest.fn() };
  const refused = { count: jest.fn() };
  const accounts = { findOne: jest.fn() };
  const plans = { get: jest.fn(async () => plan({ invokesPerSecond: 100 })) };

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
    const update = async (_target: unknown, where: Record<string, unknown>, values: Record<string, unknown>) => {
      updates.push([where, values]);
    };
    const builder = {
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      setLock: () => builder,
      setOnLocked: () => builder,
      getMany: async () => rows.filter((row) => row.enabled && (row.nextRunAt as Date) <= NOW),
    };
    return {
      transaction: async (work: (manager: unknown) => Promise<unknown>) => work({ getRepository: () => ({ createQueryBuilder: () => builder }), update }),
      getRepository: () => ({ update: async (where: Record<string, unknown>, values: Record<string, unknown>) => update(Schedule, where, values) }),
    };
  };

  /** One tick, and its runs ended; the outcome each run recorded. */
  const tick = async () => {
    await scheduler.tick(NOW);
    await scheduler.settled();
    return updates.filter(([, values]) => values.lastOutcome !== undefined && values.lastOutcome !== 'running').map(([, values]) => values.lastOutcome);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    rows = [schedule()];
    updates = [];
    plans.get.mockImplementation(async () => plan({ invokesPerSecond: 100 }));
    functions.findOne.mockImplementation(async () => ({ id: 'fn-1', name: 'reports', status: FunctionStatus.ACTIVE, eventFormat: EventFormat.LAMBDA }));
    functions.call.mockImplementation(async (_fn: unknown, _event: unknown, options: { requestId: string }) => ({
      ok: true,
      invocation: { id: options.requestId, status: InvocationStatus.COMPLETED },
      output: null,
    }));
    accounts.findOne.mockImplementation(async () => ({ id: ACCOUNT, status: AccountStatus.ACTIVE, planId: 'beta' }));
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
    );
  });

  afterEach(() => {
    throttler.onApplicationShutdown();
    jest.restoreAllMocks();
  });

  it("moves a due schedule to its next run, then calls its function with EventBridge's Scheduled Event, as a schedule's call", async () => {
    expect(await tick()).toEqual(['success']);

    const [taken] = updates;
    expect(taken[0]).toEqual({ id: 's-1' });
    // Its runs stay on their grid: every 5 minutes from 07:55.
    expect(taken[1]).toMatchObject({ nextRunAt: new Date('2026-10-21T08:05:00Z'), lastRunAt: DUE, lastOutcome: 'running', lastRequestId: expect.any(String) });
    const [fn, event, options] = functions.call.mock.calls[0];
    expect(fn).toMatchObject({ id: 'fn-1' });
    expect(options).toEqual({ source: InvocationSource.SCHEDULE, requestId: taken[1].lastRequestId });
    expect(event).toEqual({
      version: '0',
      id: taken[1].lastRequestId,
      'detail-type': 'Scheduled Event',
      source: 'aws.events',
      account: ACCOUNT,
      time: '2026-10-21T08:00:00Z',
      region: 'tn-tunis-1',
      resources: [`arn:aws:events:tn-tunis-1:${ACCOUNT}:rule/reports-nightly`],
      detail: {},
    });
    // The outcome goes on the schedule only if no later run has replaced this one.
    expect(updates.at(-1)).toEqual([{ id: 's-1', lastRequestId: taken[1].lastRequestId }, { lastOutcome: 'success' }]);
  });

  it("sends the schedule's input when it has one, as SAM's Input", async () => {
    rows = [schedule({ input: { report: 'daily' } })];

    await tick();

    expect(functions.call.mock.calls[0][1]).toEqual({ report: 'daily' });
  });

  it('runs a schedule late by any amount once, its next run after now', async () => {
    rows = [schedule({ expression: 'cron(0 * * * ? *)', nextRunAt: new Date('2026-10-21T05:00:00Z'), anchorAt: null })];

    await tick();

    expect(functions.call).toHaveBeenCalledTimes(1);
    expect(updates[0][1]).toMatchObject({ nextRunAt: new Date('2026-10-21T09:00:00Z'), lastRunAt: new Date('2026-10-21T05:00:00Z') });
  });

  it('says how a call that failed ended: an error, a timeout, no instance in time', async () => {
    for (const status of [InvocationStatus.ERROR, InvocationStatus.TIMEOUT, InvocationStatus.THROTTLED]) {
      functions.call.mockResolvedValueOnce({ ok: false, invocation: { status }, error: new Error('x'), visible: 'x' });
    }
    rows = [schedule({ id: 'a' }), schedule({ id: 'b' }), schedule({ id: 'c' })];

    expect((await tick()).sort()).toEqual(['error', 'throttled', 'timeout']);
  });

  it.each<[string, () => void, string]>([
    ['a function gone', () => functions.findOne.mockRejectedValue(new NotFoundException()), 'skipped: the function is gone'],
    ['a function not ACTIVE', () => functions.findOne.mockResolvedValue({ id: 'fn-1', status: FunctionStatus.ERROR, eventFormat: EventFormat.LAMBDA }), 'skipped: the function is not ACTIVE'],
    [
      "a function with FF's original event",
      () => functions.findOne.mockResolvedValue({ id: 'fn-1', status: FunctionStatus.ACTIVE, eventFormat: EventFormat.WRAPPED }),
      "skipped: the function takes FF's original wrapped event",
    ],
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
  ])('skips the run of %s, and says why', async (_case, arrange, outcome) => {
    arrange();

    expect(await tick()).toEqual([outcome]);
    expect(functions.call).not.toHaveBeenCalled();
  });

  it("skips a run over the plan's invocations per second, which the API's invokes and URLs share, counting it as refused", async () => {
    plans.get.mockResolvedValue(plan({ invokesPerSecond: 1 }));
    await countInvocation(throttler, ACCOUNT, 1); // an invoke through the API, this second

    expect(await tick()).toEqual(["skipped: over the plan's invocations per second"]);
    expect(refused.count).toHaveBeenCalledWith(ACCOUNT, 'fn-1');
  });

  it('disables a schedule whose expression it cannot run, and runs the others', async () => {
    rows = [schedule({ id: 'bad', expression: 'every hour' }), schedule({ id: 'good' })];

    expect(await tick()).toEqual(['skipped: its expression is not valid', 'success']);
    expect(updates).toContainEqual([{ id: 'bad' }, { enabled: false, nextRunAt: null, lastOutcome: 'skipped: its expression is not valid' }]);
    expect(functions.call).toHaveBeenCalledTimes(1);
  });

  it('runs nothing that is disabled or not due', async () => {
    rows = [schedule({ enabled: false }), schedule({ id: 'later', nextRunAt: new Date('2026-10-21T09:00:00Z') })];

    expect(await tick()).toEqual([]);
    expect(functions.call).not.toHaveBeenCalled();
  });
});
