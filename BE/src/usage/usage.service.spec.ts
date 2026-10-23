import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { coldStartSeconds, invocationSeconds, invocations } from '../monitoring/operator-metrics';
import { valueOf } from '../monitoring/test-fixtures';
import { UsageRecord, UsageStatus } from './usage-record.entity';
import { UsageService } from './usage.service';

/** The service's jobs, against a database stand-in: the SQL itself is tested in usage.db.spec.ts (L2). */
describe('UsageService (P-20)', () => {
  let query: jest.Mock;
  let service: UsageService;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    jest.useRealTimers();
    query = jest.fn(async (sql: string, [table, month]: [string, string]) =>
      sql.includes('ff_ensure_month_partition') ? [{ partition: `${table}_${month.slice(0, 7).replace('-', '_')}` }] : [],
    );
    const dataSource = { query, transaction: jest.fn() } as unknown as DataSource;
    const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
    service = new UsageService({} as Repository<UsageRecord>, dataSource, config);
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // Both are January by the UTC calendar: the first is still December west of UTC, the second already February east of it.
  it.each(['2026-12-31T23:30:00-05:00', '2027-01-31T23:30:00Z'])(
    "creates the partitions of this month and the next two, by the UTC calendar, wherever the backend runs, for usage, capacity and databases' samples (%s)",
    async (now) => {
      await expect(service.ensurePartitions(new Date(now))).resolves.toEqual([
        'usage_records_2027_01',
        'usage_records_2027_02',
        'usage_records_2027_03',
        'capacity_samples_2027_01',
        'capacity_samples_2027_02',
        'capacity_samples_2027_03',
        'database_samples_2027_01',
        'database_samples_2027_02',
        'database_samples_2027_03',
      ]);
      expect(query.mock.calls.map(([, [, month]]) => month)).toEqual(Array(3).fill(['2027-01-01', '2027-02-01', '2027-03-01']).flat());
    },
  );

  it('has the partitions before it starts taking calls, and reaps lost calls in the background', async () => {
    let reaping = false;
    query.mockImplementation(async (sql: string, [table]: [string]) => {
      if (sql.includes('ff_ensure_month_partition')) return [{ partition: table }];
      reaping = true;
      return new Promise(() => undefined); // a reaper that takes its time doesn't hold up the start
    });

    await service.onModuleInit();

    expect(query.mock.calls.slice(0, 9).every(([sql]) => String(sql).includes('ff_ensure_month_partition'))).toBe(true);
    expect(reaping).toBe(true);
  });

  it("starts even when the partitions can't be created, and says so", async () => {
    query.mockRejectedValue(new Error('function ff_ensure_month_partition(text, date) does not exist'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged).toHaveBeenCalledWith('Could not create the monthly partitions: function ff_ensure_month_partition(text, date) does not exist');
    expect(logged).toHaveBeenCalledWith('Could not reap lost invocations: function ff_ensure_month_partition(text, date) does not exist');
  });

  it('reaps every minute and creates partitions every day, until the module stops', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:00Z') });
    await service.onModuleInit();
    const reaps = () => query.mock.calls.filter(([sql]) => String(sql).includes('RUNNING')).length;
    const partitionRuns = () => query.mock.calls.filter(([sql]) => String(sql).includes('ff_ensure_month_partition')).length / 9;
    expect([reaps(), partitionRuns()]).toEqual([1, 1]); // at startup

    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(reaps()).toBe(4);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(partitionRuns()).toBe(2);

    service.onModuleDestroy();
    const before = query.mock.calls.length;
    await jest.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000);
    expect(query.mock.calls.length).toBe(before);
  });

  describe("each call's record, counted for the operator's metrics", () => {
    /** A transaction's manager that takes the insert, or fails it. */
    const manager = (fails = false) =>
      ({
        createQueryBuilder: () => ({
          insert: () => ({ into: () => ({ values: () => ({ orIgnore: () => ({ execute: async () => (fails ? Promise.reject(new Error('deadlock detected')) : {}) }) }) }) }),
        }),
      }) as never;
    const record = (status: UsageStatus, durationMs: number, initMs?: number) => ({ status, durationMs: String(durationMs), initMs: initMs ?? null }) as unknown as UsageRecord;
    const now = async () => ({
      success: await valueOf(invocations, { outcome: 'success' }),
      timeout: await valueOf(invocations, { outcome: 'timeout' }),
      throttled: await valueOf(invocations, { outcome: 'throttled' }),
      lost: await valueOf(invocations, { outcome: 'lost' }),
      ran: await valueOf(invocationSeconds, {}, 'count'),
      ranSeconds: await valueOf(invocationSeconds, {}, 'sum'),
      coldStarts: await valueOf(coldStartSeconds, {}, 'count'),
      coldStartSeconds: await valueOf(coldStartSeconds, {}, 'sum'),
    });

    it('counts its outcome; how long it ran, if it ran; and its cold start, if it had one', async () => {
      const before = await now();

      await service.record(record(UsageStatus.SUCCESS, 250, 1200), manager());
      await service.record(record(UsageStatus.TIMEOUT, 3000), manager());
      await service.record(record(UsageStatus.THROTTLED, 0), manager());
      await service.record(record(UsageStatus.LOST, 0), manager());

      const after = await now();
      expect({
        success: after.success - before.success,
        timeout: after.timeout - before.timeout,
        throttled: after.throttled - before.throttled,
        lost: after.lost - before.lost,
        ran: after.ran - before.ran,
        ranSeconds: Number((after.ranSeconds - before.ranSeconds).toFixed(3)),
        coldStarts: after.coldStarts - before.coldStarts,
        coldStartSeconds: Number((after.coldStartSeconds - before.coldStartSeconds).toFixed(3)),
      }).toEqual({ success: 1, timeout: 1, throttled: 1, lost: 1, ran: 2, ranSeconds: 3.25, coldStarts: 1, coldStartSeconds: 1.2 });
    });

    it('counts nothing of a record that could not be written', async () => {
      const before = await now();

      await expect(service.record(record(UsageStatus.SUCCESS, 250, 1200), manager(true))).rejects.toThrow('deadlock detected');

      expect(await now()).toEqual(before);
    });
  });
});
