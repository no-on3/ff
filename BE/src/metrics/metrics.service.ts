import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Function } from '../functions/entities/function.entity';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { FunctionMetrics } from './entities/function-metrics.entity';

interface MetricsWindow {
  requestCount: number;
  errorCount: number;
  responseTimes: number[];
  cpuUsage: number[];
  memoryUsage: number[];
}

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private metricsWindows: Map<string, MetricsWindow> = new Map();
  private readonly windowSize = 60 * 1000; // 1 minute window
  private aggregationTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(FunctionMetrics)
    private metricsRepository: Repository<FunctionMetrics>,
    @InjectRepository(Function)
    private functionRepository: Repository<Function>,
    @Inject(ORCHESTRATOR) private orchestrator: Orchestrator,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    this.startMetricsAggregation();
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
  }

  private startMetricsAggregation() {
    this.aggregationTimer = setInterval(async () => {
      try {
        const timestamp = new Date();
        const promises: Promise<void>[] = [];

        for (const [functionId, window] of this.metricsWindows.entries()) {
          if (window.requestCount === 0) continue;

          const function_ = await this.functionRepository.findOne({ where: { id: functionId } });
          if (!function_) continue; // deleted since the window opened

          // Sort response times for percentile calculations
          window.responseTimes.sort((a, b) => a - b);
          const len = window.responseTimes.length;

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

          promises.push(this.metricsRepository.save(metrics).then());

          // Check scaling conditions
          await this.checkScalingConditions(function_, metrics);
        }

        // Clear the windows after saving
        this.metricsWindows.clear();

        await Promise.all(promises);
      } catch (error) {
        this.logger.error('Error in metrics aggregation:', error);
      }
    }, this.windowSize);
  }

  private async checkScalingConditions(function_: Function, metrics: FunctionMetrics) {
    const functionId = function_.id;
    try {
      const maxRequestsPerInstance = this.configService.get('MAX_REQUESTS_PER_INSTANCE', 2);
      const maxCpuUtilization = this.configService.get('MAX_CPU_UTILIZATION', 80);
      const minCpuUtilization = this.configService.get('MIN_CPU_UTILIZATION', 40);

      const requestsPerInstance = metrics.requestCount / metrics.activeInstances;
      const shouldScaleUp =
        requestsPerInstance > maxRequestsPerInstance ||
        metrics.cpuUsage > maxCpuUtilization ||
        metrics.responseTimeP95 > 1000; // 1 second response time threshold

      const shouldScaleDown =
        metrics.activeInstances > 1 && // Never scale down to 0
        requestsPerInstance < (maxRequestsPerInstance * 0.6) && // Less than 60% capacity
        metrics.cpuUsage < minCpuUtilization;

      if (shouldScaleUp) {
        await this.orchestrator.scale(function_, metrics.activeInstances + 1);
        this.logger.log(`Scaling up function ${functionId} to ${metrics.activeInstances + 1} instances`);
      } else if (shouldScaleDown) {
        await this.orchestrator.scale(function_, metrics.activeInstances - 1);
        this.logger.log(`Scaling down function ${functionId} to ${metrics.activeInstances - 1} instances`);
      }
    } catch (error) {
      this.logger.error(`Error checking scaling conditions for function ${functionId}:`, error);
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
