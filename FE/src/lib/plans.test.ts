import { describe, expect, it } from 'vitest';
import { BETA_PLAN } from '../test-fixtures';
import { formatSeconds, planLimitRows } from './plans';

describe('planLimitRows', () => {
  it("shows every limit of the beta plan, as the account page lists them", () => {
    expect(planLimitRows(BETA_PLAN)).toEqual([
      ['Functions', '25'],
      ['Memory per function', 'up to 1024 MB'],
      ['Timeout per function', 'up to 300 s'],
      ['Instances per function', 'up to 10'],
      ['All functions together', '20 instances, 8 CPU, 8Gi of memory'],
      ['Changes', '60 per minute'],
      ['Invocations', '100 per second'],
      ['Scale to zero after', '15 minutes without a call'],
      ['Invocation history kept', '30 days'],
      ['Logs kept', '14 days'],
      ['Internet access for functions', 'No, unless turned on for the account'],
      ["Your own domains for functions' URLs", '5'],
    ]);
  });

  it("says a plan's internet access is where an account starts, which FF changes for each account", () => {
    const open = { ...BETA_PLAN, limits: { ...BETA_PLAN.limits, internetEgress: true } };

    expect(planLimitRows(open).find(([label]) => label === 'Internet access for functions')).toEqual(['Internet access for functions', 'Yes, unless turned off for the account']);
  });
});

describe('formatSeconds', () => {
  it('says minutes when the time is whole minutes, else seconds', () => {
    expect(formatSeconds(900)).toBe('15 minutes');
    expect(formatSeconds(60)).toBe('1 minute');
    expect(formatSeconds(90)).toBe('90 s');
  });
});
