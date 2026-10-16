import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { FunctionMetrics } from './entities/function-metrics.entity';
import { decideReplicas, shouldScaleToZero } from './scaling';

interface MetricsWindow {
  requestCount: number;
  errorCount: number;
  responseTimes: number[];
  cpuUsage: number[];
  memoryUsage: number[];
}

/**
 * Aggregates invocation metrics per one-minute window, adjusts replicas from
 * them (decideReplicas), and scales idle functions to zero; their next
 * invocation cold-starts them. Runs in the API process and assumes a single
 * backend replica; multi-replica deployments need leader election (parent
 * plan R-06).
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

  constructor(
    @InjectRepository(FunctionMetrics)
    private metricsRepository: Repository<FunctionMetrics>,
    @InjectRepository(Function)
    private functionRepository: Repository<Function>,
    @Inject(ORCHESTRATOR) private orchestrator: Orchestrator,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    this.aggregationTimer = setInterval(() => void this.tick(), this.windowSize);
  }

  onModuleDestroy() {
    if (this.aggregationTimer) clearInterval(this.aggregationTimer);
  }

  async recordMetric(
    functionId: string,
    responseTime: number,
    cpuUsage: number,
    memoryUsage: number,
    isError: boolean,
  ) {
    let window = this.metricsWindows.get(functionId);
    if (!window) {
      window = {
        requestCount: 0,
        errorCount: 0,
        responseTimes: [],
        cpuUsage: [],
        memoryUsage: [],
      };
      this.metricsWindows.set(functionId, window);
    }

    window.requestCount++;
    if (isError) window.errorCount++;
    window.responseTimes.push(responseTime);
    window.cpuUsage.push(cpuUsage);
    window.memoryUsage.push(memoryUsage);
    this.lastInvokedAt.set(functionId, Date.now());
  }

  /** One window: persist metrics and adjust replicas, then scale idle functions to zero. */
  async tick(): Promise<void> {
    try {
      await this.aggregate();
    } catch (error) {
      this.logger.error('Error in metrics aggregation:', error);
    }
    try {
      await this.sweepIdleFunctions();
    } catch (error) {
      this.logger.error('Error in idle sweep:', error);
    }
  }

  async aggregate(): Promise<void> {
    const timestamp = new Date();
    // Swap first, so invocations recorded while this runs land in the next window.
    const windows = this.metricsWindows;
    this.metricsWindows = new Map();

    for (const [functionId, window] of windows) {
      if (window.requestCount === 0) continue;
      try {
        const function_ = await this.functionRepository.findOne({ where: { id: functionId } });
        if (!function_) continue; // deleted since the window opened

        window.responseTimes.sort((a, b) => a - b);
        const metrics = new FunctionMetrics();
        metrics.functionId = functionId;
        metrics.timestamp = timestamp;
        metrics.requestCount = window.requestCount;
        metrics.errorCount = window.errorCount;
        metrics.responseTimeP50 = this.getPercentile(window.responseTimes, 50);
        metrics.responseTimeP95 = this.getPercentile(window.responseTimes, 95);
        metrics.responseTimeP99 = this.getPercentile(window.responseTimes, 99);
        metrics.cpuUsage = this.average(window.cpuUsage);
        metrics.memoryUsage = this.average(window.memoryUsage);
        metrics.activeInstances = await this.orchestrator.readyInstances(function_);

        await this.metricsRepository.save(metrics);
        await this.applyScalingDecision(function_, metrics);
      } catch (error) {
        this.logger.error(`Error aggregating metrics for function ${functionId}:`, error);
      }
    }
  }

  private async applyScalingDecision(function_: Function, metrics: FunctionMetrics): Promise<void> {
    const target = decideReplicas({
      activeInstances: metrics.activeInstances,
      requestCount: metrics.requestCount,
      responseTimeP95: metrics.responseTimeP95,
      minInstances: function_.minInstances,
      maxInstances: function_.maxInstances,
      maxRequestsPerInstance: this.configService.get<number>('scaling.maxRequestsPerInstance', 2),
    });
    if (target === null) return;
    await this.orchestrator.scale(function_, target);
    this.logger.log(`Scaled function ${function_.id} from ${metrics.activeInstances} to ${target} instances`);
  }

  /** Scales eligible functions (scaleToZero, minInstances 0) to zero after the idle period. */
  async sweepIdleFunctions(nowMs = Date.now()): Promise<void> {
    const idleSeconds = this.configService.get<number>('scaling.scaleToZeroIdleSeconds', 900);
    const candidates = await this.functionRepository.find({
      where: { status: FunctionStatus.ACTIVE, scaleToZero: true, minInstances: 0 },
    });

    for (const function_ of candidates) {
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
        this.logger.log(`Scaled idle function ${function_.id} to zero (no invocations for ${idleSeconds} s)`);
      } catch (error) {
        this.logger.error(`Error scaling idle function ${function_.id} to zero:`, error);
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

  async getMetrics(functionId: string, timeRange: { start: Date; end: Date }) {
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
