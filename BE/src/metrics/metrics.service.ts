import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { describeError } from '../common/describe-error';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { ConcurrencyTracker } from './concurrency';
import { FunctionMetrics } from './entities/function-metrics.entity';
import { burstTarget, decideReplicas, shouldScaleToZero } from './scaling';

interface MetricsWindow {
  requestCount: number;
  errorCount: number;
  responseTimes: number[];
  memoryUsage: number[];
}

/**
 * Scales functions on concurrency (client-readiness plan, D14) and keeps
 * per-minute metrics for that. As soon as a call finds every instance busy,
 * the function gets one instance per call in flight, up to maxInstances. Once
 * a minute, functions with traffic, and those scaled up earlier, step back
 * down by one instance. Idle functions are scaled to zero after the idle
 * window; their next invocation cold-starts them. Runs in the API process and
 * assumes a single backend replica; several replicas need leader election and
 * a shared count of calls in flight (parent plan R-06).
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private metricsWindows: Map<string, MetricsWindow> = new Map();
  private readonly windowSize = 60 * 1000; // 1 minute window
  private aggregationTimer?: NodeJS.Timeout;
  /** Epoch ms of each function's last invocation seen by this process. */
  private readonly lastInvokedAt = new Map<string, number>();
  private readonly startedAt = Date.now();
  private readonly concurrency = new ConcurrencyTracker();
  /** The highest replica count a burst asked for, per function, since the last tick. */
  private readonly burstTargets = new Map<string, number>();
  /** Functions this process scaled above one instance (or minInstances): each tick may step them down. */
  private readonly scaledUp = new Set<string>();

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

  /** A call is about to be sent to the function: counted, and the function scaled up at once if every instance is busy. */
  invocationStarted(function_: Function): void {
    const inFlight = this.concurrency.begin(function_.id);
    this.lastInvokedAt.set(function_.id, Date.now());
    if (inFlight > 1) void this.scaleForBurst(function_, inFlight);
  }

  /** The call ended, whatever the outcome. */
  invocationFinished(function_: Function): void {
    this.concurrency.end(function_.id);
  }

  /** How many calls the function has in flight now. */
  inFlight(functionId: string): number {
    return this.concurrency.current(functionId);
  }

  private async scaleForBurst(function_: Function, inFlight: number): Promise<void> {
    const target = burstTarget(inFlight, function_.maxInstances);
    // One check per new high: later calls of the same burst only scale up past it.
    if (target <= (this.burstTargets.get(function_.id) ?? 1)) return;
    this.burstTargets.set(function_.id, target);
    try {
      const desired = await this.orchestrator.desiredInstances(function_);
      if (target <= desired) return;
      await this.orchestrator.scale(function_, target);
      this.scaledUp.add(function_.id);
      this.logger.log(`Scaled function ${function_.id} from ${desired} to ${target} instances: ${inFlight} calls in flight`);
    } catch (error) {
      this.burstTargets.delete(function_.id); // the next call tries again
      this.logger.error(`Error scaling function ${function_.id} for ${inFlight} calls in flight: ${describeError(error)}`);
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
    this.lastInvokedAt.set(functionId, Date.now());
  }

  /** One window: persist metrics and adjust replicas, then scale idle functions to zero. */
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
  }

  async aggregate(): Promise<void> {
    const timestamp = new Date();
    // Swap first, so invocations recorded while this runs land in the next window.
    const windows = this.metricsWindows;
    this.metricsWindows = new Map();

    // Functions with calls in the window, and functions scaled up earlier that may now step down.
    for (const functionId of new Set([...windows.keys(), ...this.scaledUp])) {
      const window = windows.get(functionId);
      const peakConcurrency = this.concurrency.takePeak(functionId);
      this.burstTargets.delete(functionId); // the next burst compares with the Deployment again
      try {
        const function_ = await this.functionRepository.findOne({ where: { id: functionId } });
        if (!function_) {
          this.scaledUp.delete(functionId); // deleted since
          continue;
        }

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
          metrics.activeInstances = await this.orchestrator.readyInstances(function_);
          metrics.maxConcurrency = peakConcurrency;
          await this.metricsRepository.save(metrics);
        }

        await this.applyScalingDecision(function_, peakConcurrency);
      } catch (error) {
        this.logger.error(`Error aggregating metrics for function ${functionId}: ${describeError(error)}`);
      }
    }
  }

  private async applyScalingDecision(function_: Function, peakConcurrency: number): Promise<void> {
    const desired = await this.orchestrator.desiredInstances(function_);
    const target = decideReplicas({
      desiredInstances: desired,
      peakConcurrency,
      minInstances: function_.minInstances,
      maxInstances: function_.maxInstances,
    });
    const base = Math.max(1, function_.minInstances);
    if (target === null) {
      if (desired <= base) this.scaledUp.delete(function_.id);
      return;
    }
    await this.orchestrator.scale(function_, target);
    if (target > base) this.scaledUp.add(function_.id);
    else this.scaledUp.delete(function_.id);
    this.logger.log(
      `Scaled function ${function_.id} from ${desired} to ${target} instances (at most ${peakConcurrency} calls at once in the last minute)`,
    );
  }

  /** Scales eligible functions (scaleToZero, minInstances 0) to zero after their account's plan's idle window (D5). */
  async sweepIdleFunctions(nowMs = Date.now()): Promise<void> {
    const candidates = await this.functionRepository.find({
      where: { status: FunctionStatus.ACTIVE, scaleToZero: true, minInstances: 0 },
    });
    if (candidates.length === 0) return;
    const plans = await this.plans.forAccounts(candidates.map((function_) => function_.accountId));

    for (const function_ of candidates) {
      const idleSeconds = plans.get(function_.accountId)?.limits.idleSeconds;
      if (idleSeconds === undefined) continue; // no account (it can't happen: a foreign key): leave it running
      if (this.concurrency.current(function_.id) > 0) continue; // a call is running
      // Without a recorded invocation (e.g. after a restart), count from boot or the last change.
      const lastActivityMs = Math.max(
        this.lastInvokedAt.get(function_.id) ?? 0,
        this.startedAt,
        function_.updatedAt?.getTime() ?? 0,
      );
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
        this.scaledUp.delete(function_.id);
        this.logger.log(`Scaled idle function ${function_.id} to zero (no invocations for ${idleSeconds} s)`);
      } catch (error) {
        this.logger.error(`Error scaling idle function ${function_.id} to zero: ${describeError(error)}`);
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

  /** A function's metrics, for its own account only: another account's function is not found (D4). */
  async getMetrics(accountId: string, functionId: string, timeRange: { start: Date; end: Date }) {
    if (!(await this.functionRepository.exists({ where: { id: functionId, accountId } }))) {
      throw new NotFoundException(`Function with ID ${functionId} not found`);
    }
    return this.metricsRepository.find({
      where: {
        functionId,
        timestamp: Between(timeRange.start, timeRange.end),
      },
      order: {
        timestamp: 'ASC',
      },
    });
  }
}
