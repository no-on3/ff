import { describe, expect, it } from 'vitest';
import { PriceDocument, bookRows, draftDocument, earliestStart, formFrom, multiplyDecimals, pricesCaches, pricesQueues, pricesStorage, queueTierLabel, sourceLabel, storageTierLabel, tierLabel } from './prices';

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

/** The book after that, as the backend's queues migration makes it: SQS's request tiers too, at the same rate, and its free million. */
const QUEUE_TIERS = [
  { upToRequests: 100_000_000_000, price: '0.40' },
  { upToRequests: 200_000_000_000, price: '0.30' },
  { upToRequests: null, price: '0.24' },
];
const WITH_QUEUES: PriceDocument = {
  ...WITH_STORAGE,
  source: { ...WITH_STORAGE.source, usdPrices: { ...WITH_STORAGE.source.usdPrices!, queueRequestsPerMillion: QUEUE_TIERS } },
  freeTier: { ...WITH_STORAGE.freeTier, queueRequests: 1_000_000 },
  prices: {
    ...WITH_STORAGE.prices,
    queueRequestsPerMillion: [
      { upToRequests: 100_000_000_000, price: '1.2032' },
      { upToRequests: 200_000_000_000, price: '0.9024' },
      { upToRequests: null, price: '0.72192' },
    ],
  },
};

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

describe("a new price book from one with customers' queues' prices", () => {
  it('gives them back unchanged, their free million with them', () => {
    expect(draftDocument(formFrom(WITH_QUEUES, NOW), WITH_QUEUES, NOW)).toEqual({
      validFrom: '2026-10-17T11:00:00Z',
      document: { ...WITH_QUEUES, source: { ...WITH_QUEUES.source, readOn: '2026-10-17' } },
    });
  });

  it("prices each tier at a new rate too, AWS's US$ price times it, and takes the free requests as set", () => {
    const form = formFrom(WITH_QUEUES, NOW);

    expect(draftDocument({ ...form, rate: '3.1', storage: { ...form.storage, freeQueueRequests: '2000000' } }, WITH_QUEUES, NOW)).toMatchObject({
      document: {
        prices: {
          queueRequestsPerMillion: [
            { upToRequests: 100_000_000_000, price: '1.24' },
            { upToRequests: 200_000_000_000, price: '0.93' },
            { upToRequests: null, price: '0.744' },
          ],
        },
        freeTier: { queueRequests: 2_000_000, requestsTier1: 2_000 },
        source: { usdPrices: { queueRequestsPerMillion: QUEUE_TIERS } },
      },
    });
  });

  it('takes TND tiers as given in manual mode', () => {
    const form = formFrom(WITH_QUEUES, NOW);
    const manual = { ...form, mode: 'manual' as const, storage: { ...form.storage, tnd: { ...form.storage.tnd, queueTiers: ['1.5', '1', '0.5'] } } };

    const draft = draftDocument(manual, WITH_QUEUES, NOW);
    expect('document' in draft && draft.document.prices.queueRequestsPerMillion).toEqual([
      { upToRequests: 100_000_000_000, price: '1.5' },
      { upToRequests: 200_000_000_000, price: '1' },
      { upToRequests: null, price: '0.5' },
    ]);
  });

  it('names a tier left empty, and adds none to a book from one without them', () => {
    const form = formFrom(WITH_QUEUES, NOW);

    expect(draftDocument({ ...form, storage: { ...form.storage, usd: { ...form.storage.usd, queueTiers: ['0.40', '', '0.24'] } } }, WITH_QUEUES, NOW)).toEqual({
      problems: ['Queue requests tier 2 (US$): must be a decimal number, such as 0.0000166667'],
    });
    const draft = draftDocument(formFrom(WITH_STORAGE, NOW), WITH_STORAGE, NOW);
    expect([pricesQueues(WITH_STORAGE), pricesQueues(WITH_QUEUES), 'document' in draft && pricesQueues(draft.document)]).toEqual([false, true, false]);
  });

  it("lists SQS's tiers in TND and in US$, and its free million, after the storage's, in a book that has them alone", () => {
    expect(bookRows(WITH_QUEUES).slice(-4)).toEqual([
      ['Queue requests, first 100,000,000,000 requests, per million', '1.2032', '0.40'],
      ['Queue requests, up to 200,000,000,000 requests, per million', '0.9024', '0.30'],
      ['Queue requests, past 200,000,000,000 requests, per million', '0.72192', '0.24'],
      ['Free tier of queues, a month', '1,000,000 requests', ''],
    ]);
    expect(bookRows(WITH_STORAGE).filter(([label]) => label.includes('queue') || label.includes('Queue'))).toEqual([]);
    expect(bookRows(FIRST)).toHaveLength(10);
  });

  it("names SQS's request tiers by where they end", () => {
    expect(QUEUE_TIERS.map((_tier, index) => queueTierLabel(QUEUE_TIERS, index))).toEqual([
      'first 100,000,000,000 requests',
      'up to 200,000,000,000 requests',
      'past 200,000,000,000 requests',
    ]);
  });
});

/** The book after those, as the backend's migration adds it: ElastiCache's price of a cache's memory, at the same rate, without a free tier. */
const WITH_CACHES: PriceDocument = {
  ...WITH_QUEUES,
  source: { ...WITH_QUEUES.source, usdPrices: { ...WITH_QUEUES.source.usdPrices!, cacheGbHour: '0.0256' } },
  prices: { ...WITH_QUEUES.prices, cacheGbHour: '0.0770048' },
};

describe("a new price book from one with customers' caches' price", () => {
  it('gives it back unchanged', () => {
    expect(draftDocument(formFrom(WITH_CACHES, NOW), WITH_CACHES, NOW)).toEqual({
      validFrom: '2026-10-17T11:00:00Z',
      document: { ...WITH_CACHES, source: { ...WITH_CACHES.source, readOn: '2026-10-17' } },
    });
  });

  it("prices it at a new rate too, AWS's US$ price times it, and takes a TND price as given in manual mode", () => {
    const form = formFrom(WITH_CACHES, NOW);
    const manual = { ...form, mode: 'manual' as const, storage: { ...form.storage, tnd: { ...form.storage.tnd, cacheGbHour: '0.08' } } };

    expect(draftDocument({ ...form, rate: '3.1' }, WITH_CACHES, NOW)).toMatchObject({ document: { prices: { cacheGbHour: '0.07936' }, source: { usdPrices: { cacheGbHour: '0.0256' } } } });
    const draft = draftDocument(manual, WITH_CACHES, NOW);
    expect('document' in draft && draft.document.prices.cacheGbHour).toBe('0.08');
  });

  it('names it left empty, and adds it to no book drafted from one without it', () => {
    const form = formFrom(WITH_CACHES, NOW);

    expect(draftDocument({ ...form, storage: { ...form.storage, usd: { ...form.storage.usd, cacheGbHour: '' } } }, WITH_CACHES, NOW)).toEqual({
      problems: ['Cache memory, per GB-hour (US$): must be a decimal number, such as 0.0000166667'],
    });
    const draft = draftDocument(formFrom(WITH_QUEUES, NOW), WITH_QUEUES, NOW);
    expect([pricesCaches(WITH_QUEUES), pricesCaches(WITH_CACHES), 'document' in draft && pricesCaches(draft.document)]).toEqual([false, true, false]);
  });

  it('lists it in TND and in US$, last, in a book that has it', () => {
    const rows = bookRows(WITH_CACHES);
    expect(rows[rows.length - 1]).toEqual(['Cache memory, per GB-hour', '0.0770048', '0.0256']);
    expect(bookRows(WITH_QUEUES).filter(([label]) => label.includes('Cache'))).toEqual([]);
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
