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
  /** The function of an account that is suspended or closed. */
  const stopped = (status: AccountStatus, overrides: Partial<Function> = {}) => fn({ account: { id: '123456789012', status } as Account, ...overrides });

  let orchestrator: jest.Mocked<Orchestrator>;
  let functionRepository: { findOne: jest.Mock; find: jest.Mock; exists: jest.Mock };
  let metricsRepository: { save: jest.Mock; find: jest.Mock };
  let service: MetricsService;
  /** $LATEST's Deployment's replicas, as the fake orchestrator keeps them. */
  let replicas: number;
  /** Each version's Deployment made, by its number, with its replicas. */
  let versions: Map<number, number>;
  /** fn-1's version, as the call path gives it to run. */
  const version = (number: number, overrides: Partial<Function> = {}) => ({ ...fn(overrides), version: number, minInstances: 0 });
  /** Each account's plan; an account not listed has the beta plan. */
  let plans: Map<string, PlanView>;
  let forAccounts: jest.Mock;

  const create = () => {
    plans = new Map();
    replicas = 1;
    versions = new Map();
    orchestrator = {
      deploy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      waitUntilReady: jest.fn(),
      invoke: jest.fn(),
      scale: jest.fn(async (workload: { version?: number }, count: number) => {
        if (workload.version === undefined) replicas = count;
        else versions.set(workload.version, count);
      }),
      readyInstances: jest.fn(async () => replicas),
      desiredInstances: jest.fn(async () => replicas),
      // fn-1's Deployments, every one ready: its $LATEST's, and its versions' made.
      workloads: jest.fn(async (ref?: { id: string }) => [
        { functionId: ref?.id ?? 'fn-1', version: undefined, desired: replicas, ready: replicas },
        ...[...versions].map(([number, desired]) => ({ functionId: ref?.id ?? 'fn-1', version: number, desired, ready: desired })),
      ]),
      removeVersion: jest.fn(async (removed: { version: number }) => {
        versions.delete(removed.version);
      }),
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

    it("reads the function's Deployments once per new high, not once per call", async () => {
      const f = fn({ maxInstances: 2 });
      for (let i = 0; i < 6; i++) service.invocationStarted(f);
      await settle();

      expect(orchestrator.workloads).toHaveBeenCalledTimes(1);
      expect(orchestrator.workloads).toHaveBeenCalledWith(f);
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

    it("scales a version's own Deployment on its own calls, not $LATEST's", async () => {
      versions.set(2, 1);
      for (let i = 0; i < 3; i++) service.invocationStarted(version(2, { maxInstances: 5 }));
      await settle();

      expect(orchestrator.scale.mock.calls.map(([workload, count]) => [workload.version, count])).toEqual([
        [2, 2],
        [2, 3],
      ]);
      expect([replicas, versions.get(2), service.inFlight('fn-1')]).toEqual([1, 3, 3]);
    });

    it("counts a function's instances together: a burst takes only what of maxInstances its other Deployments leave it", async () => {
      replicas = 3;
      versions.set(2, 1);
      for (let i = 0; i < 4; i++) service.invocationStarted(version(2, { maxInstances: 4 }));
      await settle();
      expect(orchestrator.scale).not.toHaveBeenCalled(); // $LATEST holds three of the four

      create();
      replicas = 2;
      versions.set(2, 1);
      for (let i = 0; i < 4; i++) {
        service.invocationStarted(version(2, { maxInstances: 4 }));
        await settle();
      }
      expect(orchestrator.scale.mock.calls.map(([workload, count]) => [workload.version, count])).toEqual([[2, 2]]);
    });

    it("leaves a version's first calls to its first call's Deployment, which starts with one instance", async () => {
      for (let i = 0; i < 3; i++) service.invocationStarted(version(4));
      await settle();

      expect(orchestrator.workloads).toHaveBeenCalledTimes(2); // once per new high, two and three
      expect(orchestrator.scale).not.toHaveBeenCalled();
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

    it("steps a version down on its own calls, apart from $LATEST, and gives the function's minute its instances together", async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 5 }));
      versions.set(2, 1);
      for (let i = 0; i < 3; i++) service.invocationStarted(version(2, { maxInstances: 5 }));
      await settle();
      for (let i = 0; i < 3; i++) service.invocationFinished(version(2, { maxInstances: 5 }));
      service.recordMetric('fn-1', 100, 30, false);

      await service.aggregate(); // the peak of that minute was 3: no change
      await service.aggregate();
      await service.aggregate();
      await service.aggregate(); // already at one: stays

      expect(orchestrator.scale.mock.calls.map(([workload, count]) => [workload.version, count])).toEqual([
        [2, 2],
        [2, 3],
        [2, 2],
        [2, 1],
      ]);
      expect([replicas, versions.get(2)]).toEqual([1, 1]);
      // One read of the function's Deployments a minute: $LATEST's instance and the version's three.
      expect(metricsRepository.save).toHaveBeenCalledWith(expect.objectContaining({ functionId: 'fn-1', activeInstances: 4, maxConcurrency: 3 }));
    });

    it("keeps $LATEST within what of maxInstances its versions leave it, a minute's peak or not", async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 4 }));
      versions.set(2, 2);
      for (let i = 0; i < 3; i++) {
        service.invocationStarted(fn({ maxInstances: 4 }));
        await settle();
      }

      await service.aggregate(); // three calls at once, two instances left by the version's two

      expect(orchestrator.scale.mock.calls.map(([workload, count]) => [workload.version, count])).toEqual([[undefined, 2]]);
      expect(replicas).toBe(2);
    });

    it("leaves a version alone whose objects are gone since, removed while idle", async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 5 }));
      versions.set(2, 1);
      for (let i = 0; i < 2; i++) service.invocationStarted(version(2, { maxInstances: 5 }));
      await settle();
      versions.delete(2);
      orchestrator.scale.mockClear();

      await service.aggregate();
      await service.aggregate();

      expect(orchestrator.scale).not.toHaveBeenCalled();
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
      service.invocationStarted(fn());
      service.invocationFinished(fn());

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

    it("scales $LATEST to zero on its own calls: a version's keep only the version's pods", async () => {
      functionRepository.find.mockResolvedValue([fn()]);
      service.invocationStarted(version(2));
      service.invocationFinished(version(2));

      await service.sweepIdleFunctions(now + 901_000);

      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });

    it('counts from process start for functions it has never seen invoked', async () => {
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(Date.now() + 1_000); // the backend just started

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it("uses each account's plan: idle for 61 s scales a function on a 60 s plan to zero, not one on the beta plan's 900 s", async () => {
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

  describe('sweepIdleVersions', () => {
    const removed = () => orchestrator.removeVersion.mock.calls.map(([gone]) => `${gone.id}:${gone.version}`);

    it("removes a version's objects idle for its plan's idle window, from one list of every Deployment, and leaves $LATEST's", async () => {
      versions.set(2, 1);
      versions.set(3, 2);
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleVersions(Date.now() + 901_000);

      expect(removed()).toEqual(['fn-1:2', 'fn-1:3']);
      expect(orchestrator.removeVersion).toHaveBeenCalledWith({ id: 'fn-1', accountId: '123456789012', version: 2 });
      expect(orchestrator.workloads).toHaveBeenCalledWith();
      expect(functionRepository.find).toHaveBeenCalledWith({ where: { id: In(['fn-1']) }, relations: { account: true } });
      expect(forAccounts).toHaveBeenCalledWith(['123456789012']);
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('keeps a version called within the window, one with a call in flight, and every one before the window since the backend started', async () => {
      versions.set(2, 1);
      versions.set(3, 1);
      functionRepository.find.mockResolvedValue([fn()]);
      service.invocationStarted(version(3)); // still running

      await service.sweepIdleVersions(Date.now() + 60_000);
      expect(removed()).toEqual([]);

      service.invocationStarted(version(2));
      service.invocationFinished(version(2));
      await service.sweepIdleVersions(Date.now() + 899_000);
      expect(removed()).toEqual([]);
    });

    it("uses each account's plan: idle for 61 s removes a version on a 60 s plan", async () => {
      plans.set('123456789012', plan({ idleSeconds: 60 }, 'quick', 'Quick'));
      versions.set(2, 1);
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleVersions(Date.now() + 61_000);

      expect(removed()).toEqual(['fn-1:2']);
    });

    it("removes a suspended or closed account's versions' objects at once, called or not", async () => {
      versions.set(2, 1);
      functionRepository.find.mockResolvedValue([stopped(AccountStatus.SUSPENDED)]);
      service.invocationStarted(version(2));
      service.invocationFinished(version(2));

      await service.sweepIdleVersions(Date.now() + 1_000);

      expect(removed()).toEqual(['fn-1:2']);
    });

    it("leaves a version whose function is gone to its function's removal, and reads nothing when no version runs", async () => {
      versions.set(2, 1);
      functionRepository.find.mockResolvedValue([]);
      await service.sweepIdleVersions(Date.now() + 3_600_000);
      expect(removed()).toEqual([]);

      versions.clear();
      functionRepository.find.mockClear();
      forAccounts.mockClear();
      await service.sweepIdleVersions(Date.now() + 3_600_000);
      expect([functionRepository.find.mock.calls.length, forAccounts.mock.calls.length]).toEqual([0, 0]);
    });

    it('keeps sweeping the others when one removal fails, and tries it again the next minute', async () => {
      versions.set(2, 1);
      versions.set(3, 1);
      functionRepository.find.mockResolvedValue([fn()]);
      orchestrator.removeVersion.mockRejectedValueOnce(new Error('api down'));

      await service.sweepIdleVersions(Date.now() + 901_000);
      await service.sweepIdleVersions(Date.now() + 961_000);

      expect(removed()).toEqual(['fn-1:2', 'fn-1:3', 'fn-1:2']);
      expect(versions.size).toBe(0);
    });
  });

  describe('holdStoppedAccounts', () => {
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
});
