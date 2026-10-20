import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenUtc } from './time';

describe('whenUtc', () => {
  // A zone other than UTC, wherever the tests run, so that a local time would show: Tunis is UTC+1 all year.
  beforeEach(() => vi.stubEnv('TZ', 'Africa/Tunis'));
  afterEach(() => vi.unstubAllEnvs());

  it('gives the time in UTC, as the filters and the CSV do, whatever offset it came with', () => {
    expect(new Date('2026-10-17T10:13:11Z').getHours()).toBe(11); // the zone applies
    expect([whenUtc('2026-10-17T10:13:11.986Z'), whenUtc('2026-10-18T00:30:00+01:00')]).toEqual([
      '2026-10-17 10:13:11 UTC',
      '2026-10-17 23:30:00 UTC',
    ]);
  });
});
