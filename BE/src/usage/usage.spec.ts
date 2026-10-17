import {
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  OrchestratorError,
} from '../orchestrator/orchestrator.errors';
import { UsageStatus } from './usage-record.entity';
import { billedMs, failureStatus, usageRecord } from './usage';

describe('usage records (P-20)', () => {
  describe("D7: what each outcome bills, for a function with a 10 s timeout", () => {
    // One case per row of D7's table.
    it.each([
      ["a success: the runtime's duration, rounded up to 1 ms", UsageStatus.SUCCESS, 12.01, 13],
      ['an error (it threw, crashed or ran out of memory): the same', UsageStatus.ERROR, 250.5, 251],
      ["a timeout: the function's timeout, whatever the runtime measured", UsageStatus.TIMEOUT, 10_004.2, 10_000],
      ['throttled: nothing', UsageStatus.THROTTLED, 3.5, 0],
      ['a platform failure, such as a cold start that failed: nothing', UsageStatus.PLATFORM_ERROR, 90_000, 0],
      ['lost, as the backend stopped during the call: nothing', UsageStatus.LOST, 0, 0],
    ])('%s', (_row, status, durationMs, billed) => {
      expect(billedMs(status, durationMs, 10)).toBe(billed);
    });

    it('bills a whole number of milliseconds as it is', () => {
      expect(billedMs(UsageStatus.SUCCESS, 12, 10)).toBe(12);
      expect(billedMs(UsageStatus.ERROR, 0, 10)).toBe(0);
    });
  });

  describe('how a failed call ends', () => {
    it.each([
      ['a timeout, in the runtime or waiting for its answer', new FunctionTimeoutError('Task timed out after 10.00 seconds'), 'timeout'],
      ['the function threw, crashed or ran out of memory', new FunctionRuntimeError('Runtime.OutOfMemory', 'heap'), 'error'],
      ["the runtime's queue was full", new FunctionThrottledError('Rate exceeded'), 'throttled'],
      ["a cold start that failed to load: a cold start isn't billed", new FunctionLoadError('Runtime.ImportModuleError', 'x'), 'platform_error'],
      ['the pod was unreachable', new OrchestratorError('no endpoints available for service'), 'platform_error'],
      ['anything else', new Error('ECONNRESET'), 'platform_error'],
    ])('%s', (_case, error, status) => {
      expect(failureStatus(error)).toBe(status);
    });
  });

  describe('the record of a call', () => {
    const fn = { id: 'fn-1', accountId: '123456789012', name: 'hello', runtime: 'nodejs', memory: 512, timeout: 10 };
    const call = { requestId: 'inv-1', startedAt: new Date('2026-10-17T10:00:00Z'), endedAt: new Date('2026-10-17T10:00:01Z') };

    it('copies what the price depends on, as the function was when invoked, and keeps the cold start apart', () => {
      expect(usageRecord(fn, { ...call, status: UsageStatus.SUCCESS, durationMs: 41.25, initMs: 7412.6 })).toEqual({
        requestId: 'inv-1',
        startedAt: new Date('2026-10-17T10:00:00Z'),
        endedAt: new Date('2026-10-17T10:00:01Z'),
        accountId: '123456789012',
        functionId: 'fn-1',
        functionName: 'hello',
        runtime: 'nodejs',
        memoryMb: 512,
        durationMs: '41.250',
        billedMs: 42,
        initMs: 7413,
        status: 'success',
      });
    });

    it('has no cold start when the call found an instance ready', () => {
      expect(usageRecord(fn, { ...call, status: UsageStatus.TIMEOUT, durationMs: 10_003.1 })).toMatchObject({
        durationMs: '10003.100',
        billedMs: 10_000,
        initMs: null,
      });
    });
  });
});
