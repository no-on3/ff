import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

@Injectable()
export class MonitoringService implements OnModuleInit {
  private registry: Registry;
  private functionInvocations: Counter;
  private functionDuration: Histogram;
  private functionMemoryUsage: Histogram;
  private functionErrors: Counter;

  constructor() {
    this.registry = new Registry();
  }

  onModuleInit() {
    // Function invocations counter
    this.functionInvocations = new Counter({
      name: 'function_invocations_total',
      help: 'Total number of function invocations',
      labelNames: ['function_id', 'status'],
      registers: [this.registry],
    });

    // Function duration histogram
    this.functionDuration = new Histogram({
      name: 'function_duration_seconds',
      help: 'Function execution duration in seconds',
      labelNames: ['function_id'],
      buckets: [0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    // Function memory usage histogram
    this.functionMemoryUsage = new Histogram({
      name: 'function_memory_usage_mb',
      help: 'Function memory usage in MB',
      labelNames: ['function_id'],
      buckets: [32, 64, 128, 256, 512],
      registers: [this.registry],
    });

    // Function errors counter
    this.functionErrors = new Counter({
      name: 'function_errors_total',
      help: 'Total number of function errors',
      labelNames: ['function_id', 'error_type'],
      registers: [this.registry],
    });
  }

  recordInvocation(functionId: string, status: string): void {
    this.functionInvocations.labels(functionId, status).inc();
  }

  recordDuration(functionId: string, duration: number): void {
    this.functionDuration.labels(functionId).observe(duration);
  }

  recordMemoryUsage(functionId: string, memoryMb: number): void {
    this.functionMemoryUsage.labels(functionId).observe(memoryMb);
  }

  recordError(functionId: string, errorType: string): void {
    this.functionErrors.labels(functionId, errorType).inc();
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
