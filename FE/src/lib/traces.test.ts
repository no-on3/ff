import { describe, expect, it } from 'vitest';
import type { Trace, TraceCall } from '../services/api';
import { elapsedText, qualifiedName, timeline, traceSummary } from './traces';

function call(functionName: string, createdAt: string, duration: number, extra: Partial<TraceCall> = {}): TraceCall {
  return {
    id: `${functionName}-${createdAt}`,
    requestId: `req-${functionName}`,
    attempt: 1,
    functionId: `id-${functionName}`,
    functionName,
    source: 'api',
    trigger: null,
    version: null,
    alias: null,
    status: 'COMPLETED',
    duration,
    createdAt,
    ...extra,
  };
}

const trace = (calls: TraceCall[]): Trace => ({ traceId: '1-6730a1f2-0123456789abcdef01234567', calls, truncated: false });

describe("a trace's timeline", () => {
  it("places each call at its start after the first's, its bar as long as it ran, the trace's span from the first's start to the last end", () => {
    const { rows, spanMs } = timeline(
      trace([
        call('api', '2026-11-10T09:15:03.000Z', 100),
        call('worker', '2026-11-10T09:15:03.300Z', 900),
        call('worker', '2026-11-10T09:15:04.100Z', 100, { attempt: 2, source: 'async' }),
      ]),
    );

    expect(spanMs).toBe(1200);
    expect(rows.map(({ offsetMs, left, width }) => [offsetMs, Math.round(left * 100) / 100, Math.round(width * 100) / 100])).toEqual([
      [0, 0, 8.33],
      [300, 25, 75],
      [1100, 91.67, 8.33],
    ]);
  });

  it('gives a call that took no time a bar of 1 %, kept on the timeline, and a lone call the whole of it', () => {
    const { rows } = timeline(trace([call('api', '2026-11-10T09:15:03.000Z', 1000), call('worker', '2026-11-10T09:15:04.000Z', 0)]));
    expect(rows.map(({ left, width }) => [left, width])).toEqual([
      [0, 100],
      [99, 1],
    ]);
    expect(timeline(trace([call('api', '2026-11-10T09:15:03.000Z', 40)])).rows.map(({ left, width }) => [left, width])).toEqual([[0, 100]]);
  });
});

describe('what the trace page says', () => {
  it('says a time since the start in its unit, as ff trace does', () => {
    expect([0, 12.4, 1310, 125_000, 3_840_000].map(elapsedText)).toEqual(['0 ms', '12 ms', '1.31 s', '2 min 5 s', '1 h 4 min']);
  });

  it('names the function with the alias the call named, else its version', () => {
    expect([
      qualifiedName({ functionName: 'orders', alias: 'live', version: 3 }),
      qualifiedName({ functionName: 'orders', alias: null, version: 3 }),
      qualifiedName({ functionName: 'orders', alias: null, version: null }),
    ]).toEqual(['orders:live', 'orders:3', 'orders']);
  });

  it('sums the trace up: its calls, its functions and how long it lasted', () => {
    const calls = [call('api', '2026-11-10T09:15:03.000Z', 100), call('worker', '2026-11-10T09:15:03.300Z', 900)];
    expect(traceSummary(trace(calls), 1200)).toBe('2 calls of 2 functions, over 1.20 s');
    expect(traceSummary(trace(calls.slice(0, 1)), 100)).toBe('1 call of 1 function, over 100 ms');
  });
});
