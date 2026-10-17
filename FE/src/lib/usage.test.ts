import { describe, expect, it } from 'vitest';
import type { UsageEstimate } from '../services/api';
import { estimateLines, formatBilledDuration, formatGbSeconds, formatMoney, monthLabel, notBilled, pricedFromNote, usageCsvName, usageMonths } from './usage';

describe('usageMonths', () => {
  it('names this month and last month by the UTC calendar, as the API counts them', () => {
    expect(usageMonths(new Date('2026-10-17T12:00:00Z'))).toEqual({ thisMonth: '2026-10', lastMonth: '2026-09' });
    // New Year's Eve in New York is already January in UTC.
    expect(usageMonths(new Date('2026-12-31T23:30:00-05:00'))).toEqual({ thisMonth: '2027-01', lastMonth: '2026-12' });
    expect(usageMonths(new Date('2027-01-01T00:00:00Z'))).toEqual({ thisMonth: '2027-01', lastMonth: '2026-12' });
  });
});

describe('monthLabel', () => {
  it('spells the month out, whatever the browser\'s time zone', () => {
    expect([monthLabel('2026-10'), monthLabel('2027-01'), monthLabel('2026-12')]).toEqual(['October 2026', 'January 2027', 'December 2026']);
  });
});

describe('formatBilledDuration', () => {
  it.each([
    [0, '0 ms'],
    [16, '16 ms'],
    [999, '999 ms'],
    [3_016, '3.02 s'],
    [59_999, '60 s'],
    [270_000, '4.5 min'],
    [7_560_000, '2.1 h'],
    [36_000_000_000, '10,000 h'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatBilledDuration(ms)).toBe(text);
  });
});

describe('formatGbSeconds', () => {
  it.each([
    ['0', '0'],
    ['0.752', '0.752'],
    ['0.0008818359375', '0.000882'],
    ['0.000000125', '< 0.000001'],
    ['12345.678', '12,345.678'],
  ])('%s GB-s reads %s, never 0 when something was used', (exact, text) => {
    expect(formatGbSeconds(exact)).toBe(text);
  });
});

describe('notBilled', () => {
  const none = { requests: 3, billedMs: 10, gbSeconds: '0.00125', throttled: 0, platformErrors: 0, lost: 0 };

  it('says why calls were not billed, only the reasons that happened', () => {
    expect(notBilled(none)).toEqual([]);
    expect(notBilled({ ...none, throttled: 1_200, lost: 1 })).toEqual(['1,200 throttled', '1 lost']);
    expect(notBilled({ ...none, platformErrors: 2 })).toEqual(['2 failed on the platform']);
  });
});

describe('usageCsvName', () => {
  it("names the download as the API's Content-Disposition does", () => {
    expect(usageCsvName('000000000001', '2026-10')).toBe('ff-usage-000000000001-2026-10.csv');
  });
});

describe('the estimated cost (P-30)', () => {
  const estimate: UsageEstimate = {
    currency: 'TND',
    usage: '28.877',
    freeTier: '-20.655',
    volumeTiers: '0.000',
    monthlyFee: '0.000',
    total: '8.222',
    pricedFrom: '2026-10-01T00:00:00.000Z',
    priceBooks: ['book-1'],
  };

  it('writes an amount as the API rounded it, with its currency, thousands apart, a deduction negative', () => {
    expect([formatMoney('8.222', 'TND'), formatMoney('1234567.500', 'TND'), formatMoney('-20.655', 'TND'), formatMoney('0.000', 'TND')]).toEqual([
      '8.222 TND',
      '1,234,567.500 TND',
      '-20.655 TND',
      '0.000 TND',
    ]);
  });

  it('lists the usage, the deductions and fees there are, and the total', () => {
    expect(estimateLines(estimate)).toEqual([
      ['Usage, before the free tier', '28.877 TND'],
      ['Free tier', '-20.655 TND'],
      ['Estimated total', '8.222 TND'],
    ]);
    expect(estimateLines({ ...estimate, freeTier: '0.000', volumeTiers: '-1.000', monthlyFee: '5.000' }).map(([label]) => label)).toEqual([
      'Usage, before the free tier',
      'Volume tiers',
      'Monthly fee',
      'Estimated total',
    ]);
  });

  it('says from when the month is priced, only when that is after its start', () => {
    expect([pricedFromNote('2026-10', estimate), pricedFromNote('2026-10', { ...estimate, pricedFrom: '2026-10-16T00:00:00.000Z' })]).toEqual([
      null,
      'Priced from 2026-10-16 (UTC): no price applies before.',
    ]);
  });
});
