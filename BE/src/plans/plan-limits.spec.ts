import { PLATFORM_LIMITS, parsePlanLimits } from './plan-limits';
import { BETA_LIMITS } from './test-fixtures';

describe('parsePlanLimits (P-15, D5)', () => {
  const refusal = (limits: unknown) => {
    try {
      parsePlanLimits('pro', limits);
      return 'accepted';
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("accepts the beta plan's limits as they are", () => {
    expect(parsePlanLimits('beta', BETA_LIMITS)).toEqual(BETA_LIMITS);
  });

  it('refuses a plan that lacks a limit, naming the plan and the limit: a request must not run without it', () => {
    const withoutOne: Record<string, unknown> = { ...BETA_LIMITS };
    delete withoutOne.invokesPerSecond;

    expect(refusal(withoutOne)).toBe('The plan "pro" has invalid limits: invokesPerSecond: Invalid input: expected number, received undefined');
  });

  it("refuses limits it doesn't know, so a misspelt one isn't silently ignored", () => {
    expect(refusal({ ...BETA_LIMITS, memoryMB: 2048 })).toMatch(/^The plan "pro" has invalid limits: limits: Unrecognized key: "memoryMB"/);
  });

  it("refuses more than the platform can run", () => {
    expect(refusal({ ...BETA_LIMITS, memoryMb: PLATFORM_LIMITS.memoryMb + 1 })).toMatch(/memoryMb: Too big: expected number to be <=10240/);
    expect(refusal({ ...BETA_LIMITS, timeoutSeconds: 901 })).toMatch(/timeoutSeconds: Too big/);
    expect(refusal({ ...BETA_LIMITS, instancesPerFunction: 101 })).toMatch(/instancesPerFunction: Too big/);
  });

  it('refuses zero, fractions and a quota Kubernetes would refuse', () => {
    expect(refusal({ ...BETA_LIMITS, functions: 0 })).toMatch(/functions: Too small/);
    expect(refusal({ ...BETA_LIMITS, writesPerMinute: 1.5 })).toMatch(/writesPerMinute: Invalid input: expected int/);
    expect(refusal({ ...BETA_LIMITS, quota: { ...BETA_LIMITS.quota, memory: '8 GB' } })).toBe(
      'The plan "pro" has invalid limits: quota.memory: must be a Kubernetes quantity, such as 8, 500m or 8Gi',
    );
  });

  it('refuses an empty plan, as the beta plan was before P-15', () => {
    expect(refusal({})).toMatch(/^The plan "pro" has invalid limits: functions: .*; memoryMb: /);
  });
});
