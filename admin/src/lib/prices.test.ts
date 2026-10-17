import { describe, expect, it } from 'vitest';
import { PriceDocument, draftDocument, earliestStart, formFrom, multiplyDecimals, sourceLabel, tierLabel } from './prices';

/** The first price book, as the backend's migration loads it (P-30). */
const FIRST: PriceDocument = {
  currency: 'TND',
  source: {
    kind: 'aws-lambda',
    region: 'us-east-1',
    readOn: '2026-10-17',
    usdPrices: {
      requestsPerMillion: '0.20',
      gbSecond: [
        { upToGbSeconds: 6_000_000_000, price: '0.0000166667' },
        { upToGbSeconds: 15_000_000_000, price: '0.0000150000' },
        { upToGbSeconds: null, price: '0.0000133334' },
      ],
      provisionedGbSecond: '0.0000041667',
      provisionedDurationGbSecond: '0.0000097222',
    },
    usdRate: '3.0080',
    usdRateDate: '2026-10-14',
  },
  freeTier: { requests: 1_000_000, gbSeconds: 400_000 },
  prices: {
    requestsPerMillion: '0.6016',
    gbSecond: [
      { upToGbSeconds: 6_000_000_000, price: '0.0000501334336' },
      { upToGbSeconds: 15_000_000_000, price: '0.00004512' },
      { upToGbSeconds: null, price: '0.0000401068672' },
    ],
    provisionedGbSecond: '0.0000125334336',
    provisionedDurationGbSecond: '0.0000292443776',
    minimumBilledMs: 0,
    idleInstanceGbSecond: '0',
    monthlyPlanFee: '0',
  },
};
const NOW = new Date('2026-10-17T10:15:00Z');

describe('prices, multiplied exactly (P-73)', () => {
  it("gives AWS's US$ prices times the rate as the backend checks them: no float, no rounding", () => {
    expect([
      multiplyDecimals('0.20', '3.0080'),
      multiplyDecimals('0.0000166667', '3.0080'),
      multiplyDecimals('0.0000150000', '3.0080'),
      multiplyDecimals('3', '2'),
      multiplyDecimals('0.1', '0.2'),
    ]).toEqual(['0.6016', '0.0000501334336', '0.00004512', '6', '0.02']);
    expect(() => multiplyDecimals('1e-5', '3')).toThrow('"1e-5" is not a decimal number');
  });

  it('starts a book on the next whole hour, UTC, at the earliest', () => {
    expect([earliestStart(NOW), earliestStart(new Date('2026-10-17T10:00:00Z'))].map((date) => date.toISOString())).toEqual([
      '2026-10-17T11:00:00.000Z',
      '2026-10-17T11:00:00.000Z',
    ]);
  });
});

describe('a new price book, from the active one (P-73)', () => {
  it('starts from its US$ prices and rate, at the next hour', () => {
    expect(formFrom(FIRST, NOW)).toMatchObject({ day: '2026-10-17', hour: '11', mode: 'aws', rate: '3.0080', rateDate: '2026-10-14' });
  });

  it('gives the same prices back, unchanged, read today', () => {
    const draft = draftDocument(formFrom(FIRST, NOW), FIRST, NOW);

    expect(draft).toEqual({ validFrom: '2026-10-17T11:00:00Z', document: { ...FIRST, source: { ...FIRST.source, readOn: '2026-10-17' } } });
  });

  it("prices every SKU at a new rate: AWS's US$ price times it, and keeps FF's knobs and free tier as set", () => {
    const form = { ...formFrom(FIRST, NOW), rate: '3.1', rateDate: '2026-11-02', monthlyPlanFee: '5.000' };

    const draft = draftDocument(form, FIRST, NOW);

    expect(draft).toMatchObject({
      document: {
        source: { kind: 'aws-lambda', usdRate: '3.1', usdRateDate: '2026-11-02' },
        prices: {
          requestsPerMillion: '0.62',
          gbSecond: [
            { upToGbSeconds: 6_000_000_000, price: '0.00005166677' },
            { upToGbSeconds: 15_000_000_000, price: '0.0000465' },
            { upToGbSeconds: null, price: '0.00004133354' },
          ],
          provisionedGbSecond: '0.00001291677',
          monthlyPlanFee: '5.000',
        },
        freeTier: FIRST.freeTier,
      },
    });
  });

  it('takes TND prices as given in manual mode, and says so in the source', () => {
    const form = formFrom(FIRST, NOW);
    const draft = draftDocument({ ...form, mode: 'manual', tnd: { ...form.tnd, requestsPerMillion: '0.5' } }, FIRST, NOW);

    expect(draft).toMatchObject({ document: { source: { kind: 'manual' }, prices: { requestsPerMillion: '0.5', gbSecond: FIRST.prices.gbSecond } } });
  });

  it('names what is wrong, and builds nothing', () => {
    const form = formFrom(FIRST, NOW);

    expect(draftDocument({ ...form, rate: 'three', hour: '24', freeRequests: '1e6' }, FIRST, NOW)).toEqual({
      problems: ['Start: choose a day and an hour', 'Rate: must be a decimal number, such as 0.0000166667'],
    });
    expect(draftDocument({ ...form, freeRequests: '1e6' }, FIRST, NOW)).toEqual({ problems: ['Free requests: must be a whole number'] });
  });
});

describe('a price book, to read (P-73)', () => {
  it('names each duration tier by where it ends', () => {
    expect(FIRST.prices.gbSecond.map((_tier, index) => tierLabel(FIRST.prices.gbSecond, index))).toEqual([
      'first 6,000,000,000 GB-s',
      'up to 15,000,000,000 GB-s',
      'past 15,000,000,000 GB-s',
    ]);
  });

  it('says where its prices come from', () => {
    expect([sourceLabel(FIRST), sourceLabel({ ...FIRST, source: { kind: 'manual' } })]).toEqual([
      "AWS Lambda's US$ prices × 3.0080 TND per US$ (rate of 2026-10-14)",
      'Prices set by an operator',
    ]);
  });
});
