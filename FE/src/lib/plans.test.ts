import { describe, expect, it } from 'vitest';
import { BETA_PLAN } from '../test-fixtures';
import { formatMegabytes, formatSeconds, planLimitRows } from './plans';

describe('planLimitRows', () => {
  it("shows every limit of the beta plan, as the account page lists them", () => {
    expect(planLimitRows(BETA_PLAN)).toEqual([
      ['Functions', '25'],
      ['Memory per function', 'up to 1024 MB'],
      ['Timeout per function', 'up to 300 s'],
      ['Instances per function', 'up to 10'],
      ['Code of the functions', "5 GB together, their versions' included"],
      ['All functions together', '20 instances, 8 CPU, 8Gi of memory'],
      ['Changes', '60 per minute'],
      ['Invocations', '100 per second'],
      ['Scale to zero after', '15 minutes without a call'],
      ['Invocation history kept', '30 days'],
      ['Logs kept', '14 days'],
      ['Internet access for functions', 'No, unless turned on for the account'],
      ["Your own domains for functions' URLs", '5'],
      ['Schedules', '20'],
      ['Databases', '1'],
      ['Storage per database', '1 GB, then its new sessions are read-only'],
      ['Sessions per database', 'up to 10 at once'],
      ['Buckets', '5'],
      ['Storage of the buckets', '5 GB together'],
      ['Requests to the buckets', '100 per second'],
      ['Largest file in one upload', '5 GB; more in parts'],
      ['What your sites send out', '10 GB a month together'],
      ['Queues', '10'],
      ['Queues one function reads', '5'],
      ['Requests to the queues', '100 per second'],
      ['Messages waiting', '100 MB together, asynchronous calls included'],
      ['Caches', '1'],
      ['Memory of a cache', '64 MB; past it, the least recently used keys go'],
      ['Domains to send mail from', '2'],
      ['E-mails', '200 a day, 1 a second; each recipient one'],
    ]);
  });

  it("says a plan's internet access is where an account starts, which FF changes for each account", () => {
    const open = { ...BETA_PLAN, limits: { ...BETA_PLAN.limits, internetEgress: true } };

    expect(planLimitRows(open).find(([label]) => label === 'Internet access for functions')).toEqual(['Internet access for functions', 'Yes, unless turned off for the account']);
  });
});

describe('formatMegabytes', () => {
  it('says GB from 1,024 MB on, a decimal only when the size needs one', () => {
    expect(formatMegabytes(512)).toBe('512 MB');
    expect(formatMegabytes(1024)).toBe('1 GB');
    expect(formatMegabytes(1536)).toBe('1.5 GB');
    expect(formatMegabytes(5120)).toBe('5 GB');
  });
});

describe('formatSeconds', () => {
  it('says minutes when the time is whole minutes, else seconds', () => {
    expect(formatSeconds(900)).toBe('15 minutes');
    expect(formatSeconds(60)).toBe('1 minute');
    expect(formatSeconds(90)).toBe('90 s');
  });
});
