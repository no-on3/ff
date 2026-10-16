import { ScalingInput, decideReplicas, shouldScaleToZero } from './scaling';

const input = (overrides: Partial<ScalingInput>): ScalingInput => ({
  activeInstances: 1,
  requestCount: 1,
  responseTimeP95: 50,
  minInstances: 0,
  maxInstances: 5,
  maxRequestsPerInstance: 2,
  ...overrides,
});

describe('decideReplicas', () => {
  it.each<[string, Partial<ScalingInput>, number | null]>([
    ['steady load stays put', { activeInstances: 1, requestCount: 2 }, null],
    ['overloaded instances get one more', { activeInstances: 2, requestCount: 10 }, 3],
    ['slow p95 gets one more', { activeInstances: 1, requestCount: 1, responseTimeP95: 1500 }, 2],
    ['never above maxInstances', { activeInstances: 5, requestCount: 100 }, null],
    ['clamps an over-scaled function back to maxInstances', { activeInstances: 8, requestCount: 100 }, 5],
    ['under-used instances lose one', { activeInstances: 3, requestCount: 1 }, 2],
    ['keeps one instance while there is traffic', { activeInstances: 1, requestCount: 1, maxRequestsPerInstance: 10 }, null],
    ['never below minInstances', { activeInstances: 3, requestCount: 1, minInstances: 3 }, null],
    ['raises to minInstances', { activeInstances: 1, requestCount: 1, minInstances: 2 }, 2],
    // The old logic divided by zero here (requests / 0 instances = Infinity).
    ['zero instances with traffic: one instance, no division by zero', { activeInstances: 0, requestCount: 4 }, 1],
  ])('%s', (_label, overrides, expected) => {
    expect(decideReplicas(input(overrides))).toBe(expected);
  });

  it('only moves one instance per window', () => {
    expect(decideReplicas(input({ activeInstances: 1, requestCount: 1000, maxInstances: 100 }))).toBe(2);
  });
});

describe('shouldScaleToZero', () => {
  const base = { scaleToZero: true, minInstances: 0, readyInstances: 1, lastActivityMs: 0, nowMs: 900_000, idleSeconds: 900 };

  it('scales an eligible function after the idle period', () => {
    expect(shouldScaleToZero(base)).toBe(true);
  });

  it.each([
    ['still within the idle period', { nowMs: 899_999 }],
    ['scaleToZero is off', { scaleToZero: false }],
    ['minInstances is above zero', { minInstances: 1 }],
    ['already at zero', { readyInstances: 0 }],
  ])('does not scale when %s', (_label, overrides) => {
    expect(shouldScaleToZero({ ...base, ...overrides })).toBe(false);
  });
});
