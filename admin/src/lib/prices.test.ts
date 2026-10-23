import { describe, expect, it } from 'vitest';
import { PriceDocument, draftDocument, earliestStart, formFrom, multiplyDecimals, pricesStorage, sourceLabel, storageTierLabel, tierLabel } from './prices';

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
/** The book after it, as the backend's migration adds it: RDS's and S3's prices too, at the same rate, and their free tier. */
const STORAGE_TIERS = [
  { upToGbMonths: 51_200, price: '0.023' },
  { upToGbMonths: 512_000, price: '0.022' },
  { upToGbMonths: null, price: '0.021' },
];
const WITH_STORAGE: PriceDocument = {
  ...FIRST,
  source: {
    ...FIRST.source,
    usdPrices: { ...FIRST.source.usdPrices!, databaseStorageGbMonth: '0.115', bucketStorageGbMonth: STORAGE_TIERS, requestsTier1PerThousand: '0.005', requestsTier2PerThousand: '0.0004' },
  },
  freeTier: { ...FIRST.freeTier, databaseStorageGbMonths: 1, bucketStorageGbMonths: 5, requestsTier1: 2_000, requestsTier2: 20_000 },
  prices: {
    ...FIRST.prices,
    databaseStorageGbMonth: '0.34592',
    databaseMonthlyFee: '0',
    bucketStorageGbMonth: [
      { upToGbMonths: 51_200, price: '0.069184' },
      { upToGbMonths: 512_000, price: '0.066176' },
      { upToGbMonths: null, price: '0.063168' },
    ],
    requestsTier1PerThousand: '0.01504',
    requestsTier2PerThousand: '0.0012032',
  },
};

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

describe("a new price book from one with customers' databases' and buckets' prices", () => {
  it('gives them back unchanged, their free tier and the fee per database with them', () => {
    expect(draftDocument(formFrom(WITH_STORAGE, NOW), WITH_STORAGE, NOW)).toEqual({
      validFrom: '2026-10-17T11:00:00Z',
      document: { ...WITH_STORAGE, source: { ...WITH_STORAGE.source, readOn: '2026-10-17' } },
    });
  });

  it("prices them at a new rate too, AWS's US$ price times it, and takes a fee per database and a free tier as set", () => {
    const form = formFrom(WITH_STORAGE, NOW);
    const changed = { ...form, rate: '3.1', storage: { ...form.storage, databaseMonthlyFee: '1.500', freeDatabaseGbMonths: '2' } };

    expect(draftDocument(changed, WITH_STORAGE, NOW)).toMatchObject({
      document: {
        prices: {
          databaseStorageGbMonth: '0.3565',
          databaseMonthlyFee: '1.500',
          bucketStorageGbMonth: [
            { upToGbMonths: 51_200, price: '0.0713' },
            { upToGbMonths: 512_000, price: '0.0682' },
            { upToGbMonths: null, price: '0.0651' },
          ],
          requestsTier1PerThousand: '0.0155',
          requestsTier2PerThousand: '0.00124',
        },
        freeTier: { databaseStorageGbMonths: 2, bucketStorageGbMonths: 5, requestsTier1: 2_000, requestsTier2: 20_000 },
        source: { usdPrices: { databaseStorageGbMonth: '0.115', bucketStorageGbMonth: STORAGE_TIERS } },
      },
    });
  });

  it('names one left empty, and adds none to a book from one without them', () => {
    const form = formFrom(WITH_STORAGE, NOW);

    expect(draftDocument({ ...form, storage: { ...form.storage, usd: { ...form.storage.usd, requestsTier2PerThousand: '' } } }, WITH_STORAGE, NOW)).toEqual({
      problems: ['GET and other requests, per 1,000 (US$): must be a decimal number, such as 0.0000166667'],
    });
    const draft = draftDocument(formFrom(FIRST, NOW), FIRST, NOW);
    expect([pricesStorage(FIRST), pricesStorage(WITH_STORAGE), 'document' in draft && pricesStorage(draft.document)]).toEqual([false, true, false]);
  });

  it("names S3's storage tiers by where they end", () => {
    expect(STORAGE_TIERS.map((_tier, index) => storageTierLabel(STORAGE_TIERS, index))).toEqual(['first 51,200 GB-months', 'up to 512,000 GB-months', 'past 512,000 GB-months']);
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
