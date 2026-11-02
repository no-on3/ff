import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { describeError } from '../common/describe-error';
import { ORCHESTRATOR, Orchestrator, WorkloadInstances } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { ConcurrencyTracker } from './concurrency';
import { FunctionMetrics } from './entities/function-metrics.entity';
import { WorkloadRef, burstTarget, decideReplicas, instancesOf, shouldScaleToZero, workloadKey } from './scaling';

interface MetricsWindow {
  requestCount: number;
  errorCount: number;
  responseTimes: number[];
  memoryUsage: number[];
}

/** What runs some of a function's calls, as the call path gives it: the function, and the version it runs, if one. */
type Running = Function & { version?: number };

/** Accounts whose functions stay at zero instances, and whose versions hold nothing. */
const STOPPED = [AccountStatus.SUSPENDED, AccountStatus.CLOSED];

/**
 * Scales functions on concurrency and keeps per-minute metrics for that. A
 * function's $LATEST and each of its versions that is called run in
 * Deployments of their own (ADR 0015), each scaled on its own calls, its
 * instances counted with the others' against the function's maxInstances. As
 * soon as a call finds every instance busy, what runs it gets one instance per
 * call in flight, up to what the others leave it. Once a minute, those with
 * calls, and those scaled up earlier, step back down by one instance. An idle
 * $LATEST is scaled to zero after its plan's idle window, and an idle
 * version's objects are removed; the next call cold-starts either. A
 * suspended or closed account's functions stay at zero, and its versions hold
 * nothing. Runs in the API process and assumes a single backend replica;
 * several replicas need leader election and a shared count of calls in flight.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private metricsWindows: Map<string, MetricsWindow> = new Map();
  private readonly windowSize = 60 * 1000; // 1 minute window
  private aggregationTimer?: NodeJS.Timeout;
  /** Epoch ms of each workload's last call seen by this process, by workloadKey. */
  private readonly lastInvokedAt = new Map<string, number>();
  private readonly startedAt = Date.now();
  /** Calls in flight, by function ID for the function's minute, and by workloadKey for what runs them. */
  private readonly concurrency = new ConcurrencyTracker();
  /** The highest replica count a burst asked for, per workload, since the last tick. */
  private readonly burstTargets = new Map<string, number>();
  /** The workloads called since the last tick, by workloadKey. */
  private called = new Map<string, WorkloadRef>();
  /** Workloads this process scaled above one instance (or minInstances), by workloadKey: each tick may step them down. */
  private readonly scaledUp = new Map<string, WorkloadRef>();

  constructor(
    @InjectRepository(FunctionMetrics)
    private metricsRepository: Repository<FunctionMetrics>,
    @InjectRepository(Function)
    private functionRepository: Repository<Function>,
    @Inject(ORCHESTRATOR) private orchestrator: Orchestrator,
    private plans: PlansService,
  ) {}

  onModuleInit() {
    this.aggregationTimer = setInterval(() => void this.tick(), this.windowSize);
  }

  onModuleDestroy() {
    if (this.aggregationTimer) clearInterval(this.aggregationTimer);
  }

  /** A call is about to be sent to the function's $LATEST, or to its version: counted, and that scaled up at once if every instance is busy. */
  invocationStarted(running: Running): void {
    const workload: WorkloadRef = { id: running.id, version: running.version };
    const key = workloadKey(workload);
    this.concurrency.begin(running.id);
    const inFlight = this.concurrency.begin(key);
    this.lastInvokedAt.set(key, Date.now());
    this.called.set(key, workload);
    if (inFlight > 1) void this.scaleForBurst(running, key, inFlight);
  }

  /** The call ended, whatever the outcome. */
  invocationFinished(running: Running): void {
    this.concurrency.end(running.id);
    this.concurrency.end(workloadKey(running));
  }

  /** How many calls the function has in flight now, its versions' and its $LATEST's. */
  inFlight(functionId: string): number {
    return this.concurrency.current(functionId);
  }

  private async scaleForBurst(running: Running, key: string, inFlight: number): Promise<void> {
    const most = burstTarget(inFlight, running.maxInstances);
    // One check per new high: later calls of the same burst only scale up past it.
    if (most <= (this.burstTargets.get(key) ?? 1)) return;
    this.burstTargets.set(key, most);
    try {
      const { own, others } = instancesOf(await this.orchestrator.workloads(running), running.version);
      // A version's first call makes its Deployment, with one instance: the calls after it scale that.
      if (own === undefined) return;
      const target = burstTarget(inFlight, running.maxInstances - others);
      if (target <= own) return;
      await this.orchestrator.scale(running, target);
      this.scaledUp.set(key, { id: running.id, version: running.version });
      this.logger.log(`Scaled ${describeWorkload(running)} from ${own} to ${target} instances: ${inFlight} calls in flight`);
    } catch (error) {
      this.burstTargets.delete(key); // the next call tries again
      this.logger.error(`Error scaling ${describeWorkload(running)} for ${inFlight} calls in flight: ${describeError(error)}`);
    }
  }

  recordMetric(functionId: string, responseTime: number, memoryUsage: number, isError: boolean): void {
    let window = this.metricsWindows.get(functionId);
    if (!window) {
      window = { requestCount: 0, errorCount: 0, responseTimes: [], memoryUsage: [] };
      this.metricsWindows.set(functionId, window);
    }

    window.requestCount++;
    if (isError) window.errorCount++;
    window.responseTimes.push(responseTime);
    window.memoryUsage.push(memoryUsage);
  }

  /** One window: persist metrics and adjust replicas, then scale idle functions to zero, remove idle versions' objects, and hold those of stopped accounts at zero. */
  async tick(): Promise<void> {
    try {
      await this.aggregate();
    } catch (error) {
      this.logger.error(`Error in metrics aggregation: ${describeError(error)}`);
    }
    try {
      await this.sweepIdleFunctions();
    } catch (error) {
      this.logger.error(`Error in idle sweep: ${describeError(error)}`);
    }
    try {
      await this.sweepIdleVersions();
    } catch (error) {
      this.logger.error(`Error in the idle sweep of versions: ${describeError(error)}`);
    }
    try {
      await this.holdStoppedAccounts();
    } catch (error) {
      this.logger.error(`Error holding stopped accounts' functions at zero: ${describeError(error)}`);
    }
  }

  async aggregate(): Promise<void> {
    const timestamp = new Date();
    // Swap first, so invocations recorded while this runs land in the next window.
    const windows = this.metricsWindows;
    this.metricsWindows = new Map();
    const called = this.called;
    this.called = new Map();

    // Workloads with calls in the window, and those scaled up earlier that may now step down, by function.
    const workloads = new Map<string, Array<[string, WorkloadRef]>>();
    for (const [key, workload] of new Map([...called, ...this.scaledUp])) workloads.set(workload.id, [...(workloads.get(workload.id) ?? []), [key, workload]]);
    for (const functionId of new Set([...windows.keys(), ...workloads.keys()])) {
      const window = windows.get(functionId);
      const peakConcurrency = this.concurrency.takePeak(functionId);
      // Each one's peak, and the next burst compares with its Deployment again.
      const peaks = (workloads.get(functionId) ?? []).map(([key, workload]) => {
        this.burstTargets.delete(key);
        return { key, workload, peak: this.concurrency.takePeak(key) };
      });
      try {
        const function_ = await this.functionRepository.findOne({ where: { id: functionId }, relations: { account: true } });
        if (!function_) {
          for (const { key } of peaks) this.scaledUp.delete(key); // deleted since
          continue;
        }
        const deployments = await this.orchestrator.workloads(function_);

        if (window && window.requestCount > 0) {
          window.responseTimes.sort((a, b) => a - b);
          const metrics = new FunctionMetrics();
          metrics.functionId = functionId;
          metrics.timestamp = timestamp;
          metrics.requestCount = window.requestCount;
          metrics.errorCount = window.errorCount;
          metrics.responseTimeP50 = this.getPercentile(window.responseTimes, 50);
          metrics.responseTimeP95 = this.getPercentile(window.responseTimes, 95);
          metrics.responseTimeP99 = this.getPercentile(window.responseTimes, 99);
          metrics.memoryUsage = this.average(window.memoryUsage);
          metrics.activeInstances = deployments.reduce((sum, deployment) => sum + deployment.ready, 0);
          metrics.maxConcurrency = peakConcurrency;
          await this.metricsRepository.save(metrics);
        }

        for (const { key, workload, peak } of peaks) {
          // A suspended or closed account's functions stay at zero (holdStoppedAccounts): no step to minInstances.
          if (function_.account?.status === AccountStatus.ACTIVE) await this.applyScalingDecision(function_, workload, key, peak, deployments);
          else this.scaledUp.delete(key);
        }
      } catch (error) {
        this.logger.error(`Error aggregating metrics for function ${functionId}: ${describeError(error)}`);
      }
    }
  }

  /** Steps one of the function's workloads to what its last minute needed, within what of maxInstances its others leave it. */
  private async applyScalingDecision(function_: Function, workload: WorkloadRef, key: string, peakConcurrency: number, deployments: WorkloadInstances[]): Promise<void> {
    const { own, others } = instancesOf(deployments, workload.version);
    if (own === undefined) {
      this.scaledUp.delete(key); // a version's objects removed since, or a $LATEST not deployed yet
      return;
    }
    // A version's instances are never warm: warm instances stay $LATEST's.
    const running: Running = workload.version === undefined ? function_ : { ...function_, version: workload.version, minInstances: 0 };
    const target = decideReplicas({ desiredInstances: own, peakConcurrency, minInstances: running.minInstances, maxInstances: function_.maxInstances - others });
    const base = Math.max(1, running.minInstances);
    if (target === null) {
      if (own <= base) this.scaledUp.delete(key);
      return;
    }
    await this.orchestrator.scale(running, target);
    // The function's next workload this minute counts this one's new instances.
    for (const deployment of deployments) if (deployment.version === workload.version) deployment.desired = target;
    if (target > base) this.scaledUp.set(key, workload);
    else this.scaledUp.delete(key);
    this.logger.log(`Scaled ${describeWorkload(running)} from ${own} to ${target} instances (at most ${peakConcurrency} calls at once in the last minute)`);
  }

  /** Scales eligible functions' $LATEST (scaleToZero, minInstances 0) to zero after their account's plan's idle window. */
  async sweepIdleFunctions(nowMs = Date.now()): Promise<void> {
    const candidates = await this.functionRepository.find({
      where: { status: FunctionStatus.ACTIVE, scaleToZero: true, minInstances: 0 },
    });
    if (candidates.length === 0) return;
    const plans = await this.plans.forAccounts(candidates.map((function_) => function_.accountId));

    for (const function_ of candidates) {
      const idleSeconds = plans.get(function_.accountId)?.limits.idleSeconds;
      if (idleSeconds === undefined) continue; // no account (it can't happen: a foreign key): leave it running
      const key = workloadKey(function_);
      if (this.concurrency.current(key) > 0) continue; // a call is running
      // Without a recorded invocation (e.g. after a restart), count from boot or the last change.
      const lastActivityMs = Math.max(this.lastInvokedAt.get(key) ?? 0, this.startedAt, function_.updatedAt?.getTime() ?? 0);
      if (nowMs - lastActivityMs < idleSeconds * 1000) continue; // not idle: skip the API call
      try {
        const readyInstances = await this.orchestrator.readyInstances(function_);
        const eligible = shouldScaleToZero({
          scaleToZero: function_.scaleToZero,
          minInstances: function_.minInstances,
          readyInstances,
          lastActivityMs,
          nowMs,
          idleSeconds,
        });
        if (!eligible) continue;
        await this.orchestrator.scale(function_, 0);
        this.scaledUp.delete(key);
        this.logger.log(`Scaled idle function ${function_.id} to zero (no invocations for ${idleSeconds} s)`);
      } catch (error) {
        this.logger.error(`Error scaling idle function ${function_.id} to zero: ${describeError(error)}`);
      }
    }
  }

  /**
   * Removes what each version idle for its account's plan's idle window runs
   * on, its Deployment, Service and Secret, and at once a version's of a
   * suspended or closed account: its next call makes them again, a cold start
   * as from zero. Where $LATEST's Deployment is scaled to zero, a version's
   * goes, so that a function's versions hold nothing while not called, however
   * many. One list of every function's Deployments a minute; a version whose
   * function is gone is its function's removal's to delete.
   */
  async sweepIdleVersions(nowMs = Date.now()): Promise<void> {
    const versions = (await this.orchestrator.workloads()).filter((deployment) => deployment.version !== undefined);
    if (versions.length === 0) return;
    const ids = [...new Set(versions.map((deployment) => deployment.functionId))];
    const functions = new Map((await this.functionRepository.find({ where: { id: In(ids) }, relations: { account: true } })).map((found) => [found.id, found]));
    const plans = await this.plans.forAccounts([...new Set([...functions.values()].map((found) => found.accountId))]);

    for (const { functionId, version } of versions) {
      const function_ = functions.get(functionId);
      if (!function_ || version === undefined) continue;
      const key = workloadKey({ id: functionId, version });
      if (this.concurrency.current(key) > 0) continue; // a call is running
      const stopped = function_.account !== undefined && STOPPED.includes(function_.account.status);
      const idleSeconds = plans.get(function_.accountId)?.limits.idleSeconds;
      // Without a recorded call (e.g. after a restart), count from boot.
      const lastActivityMs = Math.max(this.lastInvokedAt.get(key) ?? 0, this.startedAt);
      if (!stopped && (idleSeconds === undefined || nowMs - lastActivityMs < idleSeconds * 1000)) continue;
      try {
        await this.orchestrator.removeVersion({ id: functionId, accountId: function_.accountId, version });
        this.scaledUp.delete(key);
        this.lastInvokedAt.delete(key);
        const why = stopped ? 'its account is suspended or closed' : `no invocations for ${idleSeconds} s`;
        this.logger.log(`Removed the pods of version ${version} of function ${functionId} (${why}): its next call makes them again`);
      } catch (error) {
        this.logger.error(`Error removing the pods of idle version ${version} of function ${functionId}: ${describeError(error)}`);
      }
    }
  }

  /**
   * Functions of a suspended or closed account stay at zero instances. The
   * operator's change scales them down at once; this catches a call that was
   * already past the guard and started an instance, and a scale-down that
   * failed. One read of each such function a minute, until the account's
   * closing deletes its functions. Their versions' objects go in the idle
   * sweep of versions.
   */
  async holdStoppedAccounts(): Promise<void> {
    const held = await this.functionRepository.find({
      where: { status: FunctionStatus.ACTIVE, account: { status: In(STOPPED) } },
    });
    for (const function_ of held) {
      this.scaledUp.delete(workloadKey(function_));
      try {
        if ((await this.orchestrator.desiredInstances(function_)) === 0) continue;
        await this.orchestrator.scale(function_, 0);
        this.logger.log(`Scaled function ${function_.id} to zero: its account is suspended or closed`);
      } catch (error) {
        this.logger.error(`Error scaling function ${function_.id} of a stopped account to zero: ${describeError(error)}`);
      }
    }
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[index];
  }

  private average(array: number[]): number {
    if (array.length === 0) return 0;
    return array.reduce((a, b) => a + b, 0) / array.length;
  }

}

/** A function's $LATEST, or one of its versions, as the log names it. */
function describeWorkload(workload: WorkloadRef): string {
  return workload.version === undefined ? `function ${workload.id}` : `version ${workload.version} of function ${workload.id}`;
}
