import { FunctionLoadError, FunctionRuntimeError, FunctionThrottledError, FunctionTimeoutError } from '../orchestrator/orchestrator.errors';
import { UsageRecord, UsageStatus } from './usage-record.entity';

/** What a usage record copies of the function, as it is when invoked (D6). */
export interface Invoked {
  id: string;
  accountId: string;
  name: string;
  runtime: string;
  /** MB */
  memory: number;
  /** Seconds */
  timeout: number;
  /** Above zero, the call runs on provisioned concurrency, priced apart (D8, P-30). */
  minInstances: number;
}

/**
 * D7: the milliseconds an invocation is billed. A success or an error, the
 * runtime's duration rounded up to the millisecond; a timeout, the function's
 * timeout; a throttled call, a platform failure or a lost call, nothing.
 */
export function billedMs(status: UsageStatus, durationMs: number, timeoutSeconds: number): number {
  switch (status) {
    case UsageStatus.SUCCESS:
    case UsageStatus.ERROR:
      return Math.ceil(durationMs);
    case UsageStatus.TIMEOUT:
      return timeoutSeconds * 1000;
    default:
      return 0;
  }
}

/** D7: how a failed call ends, for billing. */
export function failureStatus(error: unknown): UsageStatus {
  if (error instanceof FunctionTimeoutError) return UsageStatus.TIMEOUT;
  if (error instanceof FunctionLoadError) return UsageStatus.PLATFORM_ERROR; // the cold start failed
  if (error instanceof FunctionRuntimeError) return UsageStatus.ERROR; // it threw, ran out of memory or crashed
  if (error instanceof FunctionThrottledError) return UsageStatus.THROTTLED;
  return UsageStatus.PLATFORM_ERROR;
}

/** The usage record of an invocation that ended. */
export function usageRecord(
  fn: Invoked,
  call: { requestId: string; startedAt: Date; endedAt: Date; status: UsageStatus; durationMs: number; initMs?: number },
): UsageRecord {
  return {
    requestId: call.requestId,
    startedAt: call.startedAt,
    accountId: fn.accountId,
    functionId: fn.id,
    functionName: fn.name,
    runtime: fn.runtime,
    memoryMb: fn.memory,
    minInstances: fn.minInstances,
    durationMs: call.durationMs.toFixed(3),
    billedMs: billedMs(call.status, call.durationMs, fn.timeout),
    initMs: call.initMs === undefined ? null : Math.round(call.initMs),
    status: call.status,
    endedAt: call.endedAt,
  };
}
