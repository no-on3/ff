import { describe, expect, it } from 'vitest';
import type { AwsEstimate, AwsEstimateLine, UsageEstimate } from '../services/api';
import { awsEstimateTable, awsPricesNote, costText, estimateLines, formatBilledDuration, formatExact, formatMoney, monthLabel, notBilled, pricedFromNote, toggleLine, usageCsvName, usageMonths } from './usage';

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

describe('formatExact', () => {
  it.each([
    ['0', '0'],
    ['0.752', '0.752'],
    ['0.0008818359375', '0.000882'],
    ['0.000000125', '< 0.000001'],
    ['12345.678', '12,345.678'],
  ])('%s GB-s or GB-months reads %s, never 0 when something was used', (exact, text) => {
    expect(formatExact(exact)).toBe(text);
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

describe('the estimated cost', () => {
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

  it('gives a cost with its currency, or a dash when no price applies to the month', () => {
    expect([costText('1.250', estimate), costText(null, estimate), costText('1.250', null)]).toEqual(['1.250 TND', '–', '–']);
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

describe('the estimate at AWS prices', () => {
  const line = (name: string, label: string, usd: string, assumption: string | null = null): AwsEstimateLine => ({
    line: name,
    label,
    usd,
    amount: '0.000',
    extra: assumption !== null,
    leftOut: name === 'natGateway',
    assumption,
  });
  const estimate: AwsEstimate = {
    currency: 'TND',
    usdRate: '3.0080',
    usdRateDate: '2026-10-14',
    region: 'us-east-1',
    pricesReadOn: ['2026-10-17', '2026-10-31'],
    priceBook: 'book-1',
    months: [
      {
        month: '2026-10',
        until: null,
        requests: 50,
        lines: [
          line('functions', 'AWS Lambda: requests and duration', '0.83'),
          line('cacheNodes', 'ElastiCache for Valkey: a cache.t4g.micro for each cache', '0.00', "The smallest node, for each cache's hours"),
          line('natGateway', 'A NAT gateway', '37.20', 'One, for each hour the account had a database or a cache'),
        ],
        totalUsd: '0.83',
        total: '2.497',
        ffTotal: '4.901',
      },
      {
        month: '2026-11',
        until: '2026-11-01T10:00:00.000Z',
        requests: 0,
        lines: [
          line('functions', 'AWS Lambda: requests and duration', '1234.50'),
          line('cacheNodes', 'ElastiCache for Valkey: a cache.t4g.micro for each cache', '1.28', "The smallest node, for each cache's hours"),
          line('natGateway', 'A NAT gateway', '5.00', 'One, for each hour the account had a database or a cache'),
        ],
        totalUsd: '1235.78',
        total: '3717.226',
        ffTotal: null,
      },
    ],
  };

  it('has a column a month, this one so far, each line in US$, then the totals and the months at FF prices', () => {
    const { months, rows } = awsEstimateTable(estimate);

    expect(months).toEqual(['October 2026', 'November 2026, so far']);
    expect(rows.map(({ label, extra, leftOut, total, cells }) => [label, extra, leftOut, total, cells])).toEqual([
      ['AWS Lambda: requests and duration', null, false, false, ['0.83', '1,234.50']],
      ['ElastiCache for Valkey: a cache.t4g.micro for each cache', 'cacheNodes', false, false, ['0.00', '1.28']],
      ['A NAT gateway', 'natGateway', true, false, ['37.20', '5.00']],
      ['Total, in US$', null, false, true, ['0.83', '1,235.78']],
      ['Total, in TND', null, false, true, ['2.497', '3,717.226']],
      ["At FF's prices, in TND", null, false, true, ['4.901', '–']],
    ]);
  });

  it('says where its prices come from, when FF read them, at which rate, and that it is an estimate', () => {
    expect(awsPricesNote(estimate)).toBe(
      "At AWS's US$ list prices in us-east-1, as FF read them from 2026-10-17 to 2026-10-31, with the free tier AWS gives every account every month; " +
        'in TND at 3.0080 TND a US$, the rate of 2026-10-14. An estimate, not a quote: AWS bills what it measures.',
    );
    expect(awsPricesNote({ ...estimate, pricesReadOn: ['2026-10-31', '2026-10-31'], usdRateDate: null })).toContain(
      'as FF read them on 2026-10-31, with the free tier AWS gives every account every month; in TND at 3.0080 TND a US$. An estimate',
    );
  });

  it("leaves a line out or counts it again, in the API's order whatever the order of the clicks", () => {
    expect(toggleLine([], 'natGateway')).toEqual(['natGateway']);
    expect(toggleLine(['natGateway'], 'coldStarts')).toEqual(['coldStarts', 'natGateway']);
    expect(toggleLine(['coldStarts', 'natGateway'], 'natGateway')).toEqual(['coldStarts']);
  });
});
