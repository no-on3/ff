import { NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { plan } from '../plans/test-fixtures';
import { MetricsService } from './metrics.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('MetricsService', () => {
  const now = Date.now();
  const fn = (overrides: Partial<Function> = {}): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      accountId: '123456789012',
      runtime: Runtime.NODEJS,
      code: 'x',
      memory: 128,
      timeout: 5,
      minInstances: 0,
      maxInstances: 3,
      scaleToZero: true,
      status: FunctionStatus.ACTIVE,
      updatedAt: new Date(now - 3_600_000),
      account: { id: '123456789012', status: AccountStatus.ACTIVE } as Account,
      ...overrides,
    }) as Function;
  /** The function of an account that is suspended or closed (P-71). */
  const stopped = (status: AccountStatus, overrides: Partial<Function> = {}) => fn({ account: { id: '123456789012', status } as Account, ...overrides });

  let orchestrator: jest.Mocked<Orchestrator>;
  let functionRepository: { findOne: jest.Mock; find: jest.Mock; exists: jest.Mock };
  let metricsRepository: { save: jest.Mock; find: jest.Mock };
  let service: MetricsService;
  /** The Deployment's replicas, as the fake orchestrator keeps them. */
  let replicas: number;
  /** Each account's plan; an account not listed has the beta plan. */
  let plans: Map<string, PlanView>;
  let forAccounts: jest.Mock;

  const create = () => {
    plans = new Map();
    replicas = 1;
    orchestrator = {
      deploy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      waitUntilReady: jest.fn(),
      invoke: jest.fn(),
      scale: jest.fn(async (_fn, count: number) => {
        replicas = count;
      }),
      readyInstances: jest.fn(async () => replicas),
      desiredInstances: jest.fn(async () => replicas),
    } as any;
    functionRepository = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), exists: jest.fn() };
    metricsRepository = { save: jest.fn(), find: jest.fn() };
    forAccounts = jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, plans.get(id) ?? plan()])));
    service = new MetricsService(metricsRepository as any, functionRepository as any, orchestrator, { forAccounts } as unknown as PlansService);
  };
  /** Lets the scale-up that invocationStarted launches in the background finish. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => create());

  describe('a burst of calls', () => {
    it('scales up at once when a call finds every instance busy: one instance per call in flight', async () => {
      const f = fn({ maxInstances: 5 });

      service.invocationStarted(f);
      await settle();
      expect(orchestrator.scale).not.toHaveBeenCalled(); // one call, one instance

      service.invocationStarted(f);
      await settle();
      service.invocationStarted(f);
      await settle();

      expect(orchestrator.scale.mock.calls.map(([, count]) => count)).toEqual([2, 3]);
      expect(service.inFlight('fn-1')).toBe(3);
    });

    it('never asks for more than maxInstances', async () => {
      const f = fn({ maxInstances: 2 });
      for (let i = 0; i < 6; i++) service.invocationStarted(f);
      await settle();

      expect(orchestrator.scale.mock.calls.map(([, count]) => count)).toEqual([2]);
    });

    it('reads the Deployment once per new high, not once per call', async () => {
      const f = fn({ maxInstances: 2 });
      for (let i = 0; i < 6; i++) service.invocationStarted(f);
      await settle();

      expect(orchestrator.desiredInstances).toHaveBeenCalledTimes(1);
    });

    it('leaves a function alone that already has instances enough', async () => {
      replicas = 3;
      const f = fn({ maxInstances: 5 });
      service.invocationStarted(f);
      service.invocationStarted(f);
      await settle();

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('tries again with the next call when a scale-up fails', async () => {
      const f = fn({ maxInstances: 5 });
      orchestrator.scale.mockRejectedValueOnce(new Error('api down'));
      service.invocationStarted(f);
      service.invocationStarted(f);
      await settle();
      service.invocationFinished(f);
      service.invocationStarted(f);
      await settle();

      expect(orchestrator.scale.mock.calls.map(([, count]) => count)).toEqual([2, 2]);
      expect(replicas).toBe(2);
    });

    it('counts a call as finished whatever its outcome', () => {
      const f = fn();
      service.invocationStarted(f);
      service.invocationStarted(f);
      service.invocationFinished(f);

      expect(service.inFlight('fn-1')).toBe(1);
    });
  });

  describe('aggregate (each minute)', () => {
    it('persists the window metrics, with the most calls in flight at once', async () => {
      functionRepository.findOne.mockResolvedValue(fn());
      const f = fn();
      service.invocationStarted(f);
      service.invocationStarted(f);
      await settle();
      service.invocationFinished(f);
      service.invocationFinished(f);
      for (let i = 0; i < 4; i++) service.recordMetric('fn-1', 100, 30, i === 0);

      await service.aggregate();

      expect(metricsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ functionId: 'fn-1', requestCount: 4, errorCount: 1, maxConcurrency: 2, activeInstances: 2 }),
      );
    });

    it('steps a scaled-up function down by one instance per minute once its calls are over', async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 5 }));
      const f = fn({ maxInstances: 5 });
      for (let i = 0; i < 3; i++) service.invocationStarted(f);
      await settle();
      for (let i = 0; i < 3; i++) service.invocationFinished(f);
      expect(replicas).toBe(3);

      await service.aggregate(); // the peak of that minute was 3: no change
      await service.aggregate(); // a quiet minute
      await service.aggregate();
      await service.aggregate(); // already at one: stays

      expect(orchestrator.scale.mock.calls.map(([, count]) => count)).toEqual([2, 3, 2, 1]);
      expect(replicas).toBe(1);
    });

    it('scales up again in a new burst after stepping down', async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 5 }));
      const f = fn({ maxInstances: 5 });
      service.invocationStarted(f);
      service.invocationStarted(f);
      await settle();
      service.invocationFinished(f);
      service.invocationFinished(f);
      await service.aggregate();
      await service.aggregate(); // back to one

      service.invocationStarted(f);
      service.invocationStarted(f);
      await settle();

      expect(replicas).toBe(2);
    });

    it("leaves a suspended account's function at zero: no step back to minInstances, and no longer stepped down (P-71)", async () => {
      const f = fn({ minInstances: 2, maxInstances: 5 });
      for (let i = 0; i < 4; i++) service.invocationStarted(f);
      await settle();
      for (let i = 0; i < 4; i++) service.invocationFinished(f);
      orchestrator.scale.mockClear();
      replicas = 0; // the suspension scaled it down
      functionRepository.findOne.mockResolvedValue(stopped(AccountStatus.SUSPENDED, { minInstances: 2, maxInstances: 5 }));

      await service.aggregate();
      functionRepository.findOne.mockResolvedValue(fn({ minInstances: 2, maxInstances: 5 })); // reactivated
      await service.aggregate();

      expect(orchestrator.scale).not.toHaveBeenCalled();
      expect(functionRepository.findOne).toHaveBeenCalledWith({ where: { id: 'fn-1' }, relations: { account: true } });
    });

    it('skips functions deleted since the window opened', async () => {
      functionRepository.findOne.mockResolvedValue(null);
      service.recordMetric('gone', 100, 30, false);

      await service.aggregate();

      expect(metricsRepository.save).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('starts a fresh window, so a second aggregate has nothing to report', async () => {
      functionRepository.findOne.mockResolvedValue(fn());
      service.recordMetric('fn-1', 100, 30, false);

      await service.aggregate();
      await service.aggregate();

      expect(metricsRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweepIdleFunctions', () => {
    it('only considers ACTIVE functions with scaleToZero and minInstances 0', async () => {
      await service.sweepIdleFunctions(now + 3_600_000);

      expect(functionRepository.find).toHaveBeenCalledWith({
        where: { status: FunctionStatus.ACTIVE, scaleToZero: true, minInstances: 0 },
      });
    });

    it('scales a function idle for longer than the idle period to zero', async () => {
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(now + 901_000);

      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });

    it('leaves recently invoked functions alone, without calling the scheduler', async () => {
      functionRepository.find.mockResolvedValue([fn()]);
      service.recordMetric('fn-1', 100, 30, false);

      await service.sweepIdleFunctions(Date.now() + 60_000);

      expect(orchestrator.readyInstances).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('never scales a function to zero while one of its calls runs', async () => {
      functionRepository.find.mockResolvedValue([fn()]);
      service.invocationStarted(fn());

      await service.sweepIdleFunctions(Date.now() + 3_600_000);

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('counts from process start for functions it has never seen invoked', async () => {
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(Date.now() + 1_000); // the backend just started

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it("uses each account's plan: idle for 61 s scales a function on a 60 s plan to zero, not one on the beta plan's 900 s (P-15)", async () => {
      plans.set('000000000060', plan({ idleSeconds: 60 }, 'quick', 'Quick'));
      functionRepository.find.mockResolvedValue([
        fn({ id: 'quick', accountId: '000000000060' }),
        fn({ id: 'beta', accountId: '000000000900' }),
      ]);

      await service.sweepIdleFunctions(Date.now() + 61_000); // the backend started just now: its last sight of either

      expect(orchestrator.scale.mock.calls.map(([f, n]) => `${f.id}→${n}`)).toEqual(['quick→0']);
      expect(forAccounts).toHaveBeenCalledTimes(1); // one query for every candidate's plan
      expect(forAccounts).toHaveBeenCalledWith(['000000000060', '000000000900']);
    });

    it('asks for no plan when no function is a candidate', async () => {
      await service.sweepIdleFunctions(now + 3_600_000);

      expect(forAccounts).not.toHaveBeenCalled();
    });

    it('keeps sweeping other functions when one scale call fails', async () => {
      functionRepository.find.mockResolvedValue([fn({ id: 'a' }), fn({ id: 'b' })]);
      orchestrator.scale.mockRejectedValueOnce(new Error('api down'));

      await service.sweepIdleFunctions(now + 3_600_000);

      expect(orchestrator.scale).toHaveBeenCalledTimes(2);
    });
  });

  describe('holdStoppedAccounts (P-71)', () => {
    it('scales the working functions of suspended and closed accounts to zero, and only those with instances', async () => {
      functionRepository.find.mockResolvedValue([
        stopped(AccountStatus.SUSPENDED, { id: 'started-after' }),
        stopped(AccountStatus.CLOSED, { id: 'at-zero' }),
      ]);
      orchestrator.desiredInstances.mockImplementation(async (workload) => (workload.id === 'started-after' ? 2 : 0));

      await service.holdStoppedAccounts();

      expect(functionRepository.find).toHaveBeenCalledWith({
        where: { status: FunctionStatus.ACTIVE, account: { status: In([AccountStatus.SUSPENDED, AccountStatus.CLOSED]) } },
      });
      expect(orchestrator.scale.mock.calls.map(([workload, count]) => [workload.id, count])).toEqual([['started-after', 0]]);
    });

    it('keeps holding the others when one scale call fails', async () => {
      functionRepository.find.mockResolvedValue([stopped(AccountStatus.SUSPENDED, { id: 'a' }), stopped(AccountStatus.SUSPENDED, { id: 'b' })]);
      orchestrator.scale.mockRejectedValueOnce(new Error('api down'));

      await service.holdStoppedAccounts();

      expect(orchestrator.scale.mock.calls.map(([workload]) => workload.id)).toEqual(['a', 'b']);
    });

    it('runs each minute, after the idle sweep, even when aggregation failed', async () => {
      functionRepository.findOne.mockRejectedValue(new Error('database down'));
      service.recordMetric('fn-1', 100, 30, false);
      functionRepository.find.mockImplementation(async (options: { where: { account?: unknown } }) =>
        options.where.account ? [stopped(AccountStatus.CLOSED)] : [],
      );

      await service.tick();

      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });
  });

  describe("a function's metrics (P-10)", () => {
    const period = { start: new Date('2026-10-17T00:00:00Z'), end: new Date('2026-10-17T01:00:00Z') };

    it('are read for the account that owns the function', async () => {
      functionRepository.exists.mockResolvedValue(true);
      metricsRepository.find.mockResolvedValue([{ functionId: 'fn-1', invocations: 3 }]);

      await expect(service.getMetrics('000000000001', 'fn-1', period)).resolves.toEqual([{ functionId: 'fn-1', invocations: 3 }]);
      expect(functionRepository.exists).toHaveBeenCalledWith({ where: { id: 'fn-1', accountId: '000000000001' } });
    });

    it("answer another account with 404, without reading them", async () => {
      functionRepository.exists.mockResolvedValue(false);

      await expect(service.getMetrics('000000000002', 'fn-1', period)).rejects.toBeInstanceOf(NotFoundException);
      expect(metricsRepository.find).not.toHaveBeenCalled();
    });
  });
});
