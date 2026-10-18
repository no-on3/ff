import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { HOUR_MS, RetentionService } from './retention.service';

/** The purge's jobs and batches, against a database stand-in: its SQL is tested in retention.db.spec.ts (L2). */
describe('RetentionService (P-45)', () => {
  let plans: Array<{ id: string; limits: unknown }>;
  let query: jest.Mock;
  let service: RetentionService;
  let errors: jest.SpyInstance;
  let logs: jest.SpyInstance;
  /** The DELETE statements run, as [plan, retention in seconds, batch]. */
  const deletes = () => query.mock.calls.map(([, [plan, , seconds, batch]]: [string, unknown[]]) => [plan, seconds, batch]);

  beforeEach(() => {
    jest.useRealTimers();
    plans = [{ id: 'beta', limits: BETA_LIMITS }];
    query = jest.fn(async () => [[], 0]);
    const dataSource = { query, getRepository: () => ({ find: async () => plans }) } as unknown as DataSource;
    service = new RetentionService(dataSource);
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("deletes a batch at a time until one comes back short, for each plan with its own retention, in days of 24 hours, and says how many", async () => {
    plans = [
      { id: 'beta', limits: BETA_LIMITS },
      { id: 'short', limits: { ...BETA_LIMITS, historyRetentionDays: 7 } },
    ];
    for (const count of [2, 2, 1, 0]) query.mockResolvedValueOnce([[], count]);

    await expect(service.purgeHistory(undefined, 2)).resolves.toBe(5);

    expect(deletes()).toEqual([
      ['beta', 30 * 86_400, 2],
      ['beta', 30 * 86_400, 2],
      ['beta', 30 * 86_400, 2],
      ['short', 7 * 86_400, 2],
    ]);
    expect(logs).toHaveBeenCalledWith("Deleted 5 invocation(s) past their plan's history retention");
  });

  it('says nothing when nothing was past its retention', async () => {
    await expect(service.purgeHistory()).resolves.toBe(0);

    expect(deletes()).toEqual([['beta', 30 * 86_400, 1_000]]);
    expect(logs).not.toHaveBeenCalled();
  });

  it("keeps the history of a plan whose limits can't be read, says so, and purges the others", async () => {
    plans = [
      { id: 'broken', limits: { ...BETA_LIMITS, historyRetentionDays: 'thirty' } },
      { id: 'beta', limits: BETA_LIMITS },
    ];

    await service.purgeHistory();

    expect(deletes()).toEqual([['beta', 30 * 86_400, 1_000]]);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^The history of plan broken's accounts is kept: its retention can't be read: .*historyRetentionDays/));
  });

  it('purges at start and every hour, until the module stops', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(query).toHaveBeenCalledTimes(4);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5 * HOUR_MS);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('logs a purge that fails, and purges again the next hour', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
    query.mockRejectedValueOnce(new Error('connection terminated'));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledWith('Could not purge the invocation history: connection terminated');

    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('starts no purge while the last one is still under way, and the next hour after it ended does', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
    let finish!: (result: [unknown[], number]) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(query).toHaveBeenCalledTimes(1);

    finish([[], 0]);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
