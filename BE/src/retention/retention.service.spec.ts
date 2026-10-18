import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditService } from '../audit/audit.service';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { RetentionService } from './retention.service';

const HOUR_MS = 3_600_000;

/**
 * The job's steps, batches and timer, against stand-ins for the database, the
 * functions, the cluster and the audit log: its SQL and its effects on real
 * rows are tested in retention.db.spec.ts.
 */
describe('RetentionService', () => {
  let plans: Array<{ id: string; limits: unknown }>;
  let dueAccounts: Array<{ id: string }>;
  let functionsOf: Record<string, Array<{ id: string }>>;
  let query: jest.Mock;
  let findAccounts: jest.Mock;
  let marked: number;
  let update: jest.Mock;
  let steps: string[];
  let functions: { remove: jest.Mock };
  let orchestrator: { removeTenant: jest.Mock; deleteLogs: jest.Mock };
  let audit: { record: jest.Mock };
  let service: RetentionService;
  let errors: jest.SpyInstance;
  let logs: jest.SpyInstance;
  /** The DELETE statements run, as [plan, retention in seconds, batch]. */
  const deletes = () => query.mock.calls.map(([, [plan, , seconds, batch]]: [string, unknown[]]) => [plan, seconds, batch]);

  beforeEach(() => {
    jest.useRealTimers();
    plans = [{ id: 'beta', limits: BETA_LIMITS }];
    dueAccounts = [];
    functionsOf = {};
    marked = 1;
    steps = [];
    query = jest.fn(async () => [[], 0]);
    findAccounts = jest.fn(async () => dueAccounts);
    const repositories = new Map<unknown, { find: jest.Mock }>([
      [Plan, { find: jest.fn(async () => plans) }],
      [Account, { find: findAccounts }],
      [Function, { find: jest.fn(async ({ where }: { where: { accountId: string } }) => functionsOf[where.accountId] ?? []) }],
    ]);
    update = jest.fn(async (_entity: unknown, criteria: { id: string }) => {
      steps.push(`mark ${criteria.id}`);
      return { affected: marked };
    });
    const manager = { update };
    const dataSource = {
      query,
      getRepository: (entity: unknown) => repositories.get(entity),
      transaction: async (work: (m: typeof manager) => Promise<unknown>) => work(manager),
    } as unknown as DataSource;
    functions = { remove: jest.fn(async (accountId: string, id: string) => void steps.push(`function ${accountId}/${id}`)) };
    orchestrator = {
      removeTenant: jest.fn(async (accountId: string) => void steps.push(`namespace ${accountId}`)),
      deleteLogs: jest.fn(async (accountId: string) => void steps.push(`logs ${accountId}`)),
    };
    audit = { record: jest.fn(async (event: { action: string; accountId: string }) => void steps.push(`audit ${event.action} ${event.accountId}`)) };
    const config = { get: (key: string, fallback?: unknown) => (key === 'retention.intervalSeconds' ? 3600 : fallback) } as unknown as ConfigService;
    service = new RetentionService(
      dataSource,
      functions as unknown as FunctionsService,
      orchestrator as unknown as Orchestrator,
      audit as unknown as AuditService,
      config,
    );
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("the invocation history's purge", () => {
    it('deletes a batch at a time until one comes back short, for each plan with its own retention, in days of 24 hours, and says how many', async () => {
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
  });

  describe("closed accounts' data", () => {
    it('deletes each function, then the namespace, then the logs, then marks the account and records it once', async () => {
      dueAccounts = [{ id: '300000000001' }];
      functionsOf = { '300000000001': [{ id: 'f-1' }, { id: 'f-2' }] };

      await expect(service.deleteClosedAccounts()).resolves.toBe(1);

      expect(steps).toEqual([
        'function 300000000001/f-1',
        'function 300000000001/f-2',
        'namespace 300000000001',
        'logs 300000000001',
        'mark 300000000001',
        'audit account.data_delete 300000000001',
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        { accountId: '300000000001', action: 'account.data_delete', resource: 'account:300000000001', details: { functions: 2 } },
        expect.anything(),
      );
      // Marked only while not marked yet: of two runs at once, one records it.
      expect(update).toHaveBeenCalledWith(Account, { id: '300000000001', dataDeletedAt: expect.objectContaining({ _type: 'isNull' }) }, { dataDeletedAt: expect.any(Date) });
    });

    it('leaves an account whose step fails for the next run, saying why, and goes on with the next one', async () => {
      dueAccounts = [{ id: '300000000001' }, { id: '300000000002' }];
      orchestrator.deleteLogs.mockRejectedValueOnce(new Error('The log store answered 503'));

      await expect(service.deleteClosedAccounts()).resolves.toBe(1);

      expect(orchestrator.deleteLogs).toHaveBeenCalledWith('300000000001');
      expect(steps).toEqual([
        'namespace 300000000001',
        'namespace 300000000002',
        'logs 300000000002',
        'mark 300000000002',
        'audit account.data_delete 300000000002',
      ]);
      expect(errors).toHaveBeenCalledWith('Could not delete the data of closed account 300000000001; the next run tries again: The log store answered 503');
    });

    it('records nothing for an account another run marked meanwhile', async () => {
      dueAccounts = [{ id: '300000000001' }];
      marked = 0;

      await service.deleteClosedAccounts();

      expect(steps).toEqual(['namespace 300000000001', 'logs 300000000001', 'mark 300000000001']);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('asks only for closed accounts not deleted yet whose date has passed, the earliest first', async () => {
      const now = new Date('2026-11-17T10:32:00Z');

      await service.deleteClosedAccounts(now);

      const [{ where, order }] = findAccounts.mock.calls[0] as [{ where: Record<string, { _type?: string; _value?: unknown } | string>; order: unknown }];
      expect(where.status).toBe('closed');
      expect(where.dataDeletedAt).toMatchObject({ _type: 'isNull' });
      expect(where.dataDeletionDueAt).toMatchObject({ _type: 'lessThanOrEqual', _value: now });
      expect(order).toEqual({ dataDeletionDueAt: 'ASC' });
    });
  });

  describe('the timer', () => {
    it('runs the purge and then the closed accounts at start and every interval, until the module stops', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect([query.mock.calls.length, findAccounts.mock.calls.length]).toEqual([1, 1]);

      await jest.advanceTimersByTimeAsync(3 * HOUR_MS);
      expect([query.mock.calls.length, findAccounts.mock.calls.length]).toEqual([4, 4]);

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5 * HOUR_MS);
      expect([query.mock.calls.length, findAccounts.mock.calls.length]).toEqual([4, 4]);
    });

    it('logs a purge that fails, still looks for closed accounts, and runs again at the next interval', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
      query.mockRejectedValueOnce(new Error('connection terminated'));

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(errors).toHaveBeenCalledWith('Could not purge the invocation history: connection terminated');
      expect(findAccounts).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(HOUR_MS);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('logs a failure to look for closed accounts, and runs again at the next interval', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
      findAccounts.mockRejectedValueOnce(new Error('relation "accounts" does not exist'));

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(errors).toHaveBeenCalledWith('Could not look for closed accounts to delete: relation "accounts" does not exist');

      await jest.advanceTimersByTimeAsync(HOUR_MS);
      expect(findAccounts).toHaveBeenCalledTimes(2);
    });

    it('starts no run while the last one is still under way, and the next interval after it ended does', async () => {
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

    it('takes its interval from the configuration', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
      const config = { get: (key: string, fallback?: unknown) => (key === 'retention.intervalSeconds' ? 5 : fallback) } as unknown as ConfigService;
      const fast = new RetentionService(
        { query, getRepository: (entity: unknown) => ({ find: async () => (entity === Plan ? plans : []) }) } as unknown as DataSource,
        functions as unknown as FunctionsService,
        orchestrator as unknown as Orchestrator,
        audit as unknown as AuditService,
        config,
      );
      try {
        fast.onModuleInit();
        await jest.advanceTimersByTimeAsync(15_000);
        expect(query).toHaveBeenCalledTimes(4); // at start, then at 5, 10 and 15 s
      } finally {
        fast.onModuleDestroy();
      }
    });
  });
});
