import { CapacityDay, formatCapacityReport, parseReportArgs, reportWindow } from './capacity-report';

describe('the capacity report (P-21)', () => {
  const day = (overrides: Partial<CapacityDay>): CapacityDay => ({
    day: '2026-10-16',
    accountId: '000000000001',
    reservedGbS: 0,
    provisionedGbS: 0,
    billedGbS: 0,
    requests: 0,
    ...overrides,
  });

  it('shows each account and day, a total, and how many times the billed capacity was reserved', () => {
    const table = formatCapacityReport([
      // One warm 128 MB instance all day, for one 1 ms call: D8's gap at its widest.
      day({ reservedGbS: 10_800, billedGbS: 0.125, requests: 1 }),
      day({ accountId: '000000000002', reservedGbS: 3, provisionedGbS: 1.5, billedGbS: 2, requests: 1_200 }),
      day({ day: '2026-10-17', reservedGbS: 7.5 }),
      day({ day: '2026-10-17', accountId: '000000000003', billedGbS: 0.25, requests: 2 }), // no sample: its instances came and went within the minute
    ]);

    expect(table.split('\n')).toEqual([
      'Day (UTC)   Account       Reserved GB-s  Provisioned GB-s  Billed GB-s  Requests  Reserved ÷ billed',
      '2026-10-16  000000000001     10,800.000             0.000        0.125         1            86,400×',
      '2026-10-16  000000000002          3.000             1.500        2.000     1,200               1.5×',
      '2026-10-17  000000000001          7.500             0.000        0.000         0     nothing billed',
      '2026-10-17  000000000003          0.000             0.000        0.250         2                 0×',
      'Total                        10,810.500             1.500        2.375     1,203             4,552×',
    ]);
  });

  it('says so when there is nothing to show', () => {
    expect(formatCapacityReport([])).toBe('No capacity samples or usage records in these days.');
  });

  it('covers the last N days by the UTC calendar, today included', () => {
    expect(reportWindow(new Date('2026-10-17T23:30:00-05:00'), 7)).toEqual({
      from: new Date('2026-10-12T00:00:00Z'),
      to: new Date('2026-10-19T00:00:00Z'), // 23:30 in New York is already the 18th in UTC
    });
    expect(reportWindow(new Date('2026-10-17T12:00:00Z'), 1)).toEqual({
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-18T00:00:00Z'),
    });
  });

  it('reads --days, 7 without it, and refuses anything else', () => {
    expect(parseReportArgs([])).toEqual({ days: 7 });
    expect(parseReportArgs(['--days', '30'])).toEqual({ days: 30 });
    for (const argv of [['--days', '0'], ['--days', '367'], ['--days', '2.5'], ['--days'], ['--weeks', '2'], ['--days', '3', '--json']]) {
      expect(() => parseReportArgs(argv)).toThrow(`Usage: npm run capacity:report -- [--days N], N from 1 to 366; got "${argv.join(' ')}"`);
    }
  });
});
