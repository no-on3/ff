import { ScalingInput, burstTarget, decideReplicas, instancesOf, shouldScaleToZero, workloadKey } from './scaling';

const input = (overrides: Partial<ScalingInput>): ScalingInput => ({
  desiredInstances: 1,
  peakConcurrency: 1,
  minInstances: 0,
  maxInstances: 5,
  ...overrides,
});

describe('decideReplicas', () => {
  it.each<[string, Partial<ScalingInput>, number | null]>([
    ['one call at a time on one instance: no change', { desiredInstances: 1, peakConcurrency: 1 }, null],
    ['raises to what the peak needed, at once', { desiredInstances: 1, peakConcurrency: 4 }, 4],
    ['never above maxInstances', { desiredInstances: 1, peakConcurrency: 9, maxInstances: 3 }, 3],
    ['already at maxInstances under a big peak: no change', { desiredInstances: 3, peakConcurrency: 9, maxInstances: 3 }, null],
    ['lowers by one instance per window', { desiredInstances: 4, peakConcurrency: 1 }, 3],
    ['lowers a function above a reduced maxInstances, one at a time', { desiredInstances: 5, peakConcurrency: 1, maxInstances: 2 }, 4],
    ['keeps one instance when quiet: zero is the idle sweep\'s job', { desiredInstances: 1, peakConcurrency: 0 }, null],
    ['steps a quiet scaled-up function down towards one', { desiredInstances: 2, peakConcurrency: 0 }, 1],
    ['never below minInstances', { desiredInstances: 3, peakConcurrency: 0, minInstances: 3 }, null],
    ['raises to minInstances', { desiredInstances: 1, peakConcurrency: 1, minInstances: 2 }, 2],
    ['raises a function at zero to minInstances', { desiredInstances: 0, peakConcurrency: 0, minInstances: 1 }, 1],
    ['leaves a quiet function at zero alone', { desiredInstances: 0, peakConcurrency: 0 }, null],
    ['gives a function at zero with calls one instance per call', { desiredInstances: 0, peakConcurrency: 2 }, 2],
  ])('%s', (_label, overrides, expected) => {
    expect(decideReplicas(input(overrides))).toBe(expected);
  });
});

describe('burstTarget', () => {
  it.each([
    [2, 5, 2],
    [7, 5, 5],
    [1, 5, 1],
    [3, 1, 1],
  ])('%i calls in flight, at most %i instances: %i', (inFlight, maxInstances, expected) => {
    expect(burstTarget(inFlight, maxInstances)).toBe(expected);
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

describe('workloadKey', () => {
  it("keys a function's $LATEST and each of its versions apart, and apart from the function's own count", () => {
    expect([workloadKey({ id: 'fn-1' }), workloadKey({ id: 'fn-1', version: 2 }), workloadKey({ id: 'fn-1', version: undefined })]).toEqual(['fn-1:$LATEST', 'fn-1:2', 'fn-1:$LATEST']);
  });
});

describe('instancesOf', () => {
  const deployments = [{ desired: 3 }, { version: 2, desired: 1 }, { version: 5, desired: 2 }];

  it("gives a workload's instances asked for, and its function's others' together", () => {
    expect(instancesOf(deployments, undefined)).toEqual({ own: 3, others: 3 });
    expect(instancesOf(deployments, 2)).toEqual({ own: 1, others: 5 });
  });

  it('gives none of its own to a workload without a Deployment: a version never called, or removed while idle', () => {
    expect(instancesOf(deployments, 9)).toEqual({ own: undefined, others: 6 });
    expect(instancesOf([], undefined)).toEqual({ own: undefined, others: 0 });
  });
});
