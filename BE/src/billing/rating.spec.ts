/**
 * L1: pricing a month (client-readiness plan, P-30, D8). AWS's own examples,
 * from its Lambda pricing page, rated by FF with the first price book, equal
 * the same months computed by hand with AWS's formula, in US$, times the
 * book's rate. Then each of D8's knobs above zero, the duration tiers, and a
 * book that starts in the middle of a month. The minimum billed duration
 * applies to each call, in the aggregation's SQL: pricing.db.spec.ts. Then
 * customers' databases and buckets, with the book of their SKUs, likewise
 * against AWS's RDS and S3 prices by hand; their queues, against SQS's; and
 * their caches, against ElastiCache's.
 */
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { STORAGE_FREE_TIER, STORAGE_USD_PRICES, withStoragePrices } from '../migrations/1792727200566-DatabaseBilling';
import { QUEUE_FREE_TIER, QUEUE_USD_PRICES, withQueuePrices } from '../migrations/1792816013937-QueueBilling';
import { CACHE_USD_PRICES, withCachePrices } from '../migrations/1793333328301-CacheMeasures';
import { Decimal } from './decimal';
import { BookPrices, PriceDocument, awsPriceProblems, bookPrices, priceDocumentSchema } from './price-book';
import { FunctionUsage, ResourceUsage, hoursIn, rateMonth } from './rating';

const d = (text: string) => Decimal.parse(text);
const RATE = d('3.0080');
const book = (prices: Partial<PriceDocument['prices']> = {}, rest: Partial<PriceDocument> = {}): BookPrices =>
  bookPrices({ id: 'book', validFrom: new Date('2026-10-01T00:00:00Z'), prices: { ...FIRST_PRICE_BOOK, ...rest, prices: { ...FIRST_PRICE_BOOK.prices, ...prices } } });
const FIRST = book();
/** n calls of `ms` each, at `mb`: their MB-ms. */
const mbMs = (n: number, ms: number, mb: number) => BigInt(n) * BigInt(ms) * BigInt(mb);
const usage = (functionId: string, parts: Partial<Omit<FunctionUsage, 'functionId'>>): FunctionUsage => ({
  functionId,
  onDemand: { requests: 0n, mbMs: 0n },
  provisioned: { requests: 0n, mbMs: 0n },
  provisionedMbMs: 0n,
  reservedMbMs: 0n,
  ...parts,
});
/** The book with databases' and buckets' SKUs, as its migration makes it from the book before. */
const WITH_STORAGE = bookPrices({ id: 'with-storage', validFrom: new Date('2026-11-01T00:00:00Z'), prices: withStoragePrices(FIRST_PRICE_BOOK) });
const GIB = 1_073_741_824n;
/** A database or bucket of `gb` GB through `hours` hours, sampled each hour. */
const stored = (resourceId: string, gb: number, hours: number, kind: ResourceUsage['kind'] = 'database', requests: { tier1?: bigint; tier2?: bigint } = {}): ResourceUsage => ({
  resourceId,
  kind,
  byteHours: BigInt(gb) * GIB * BigInt(hours),
  hours: BigInt(hours),
  tier1Requests: requests.tier1 ?? 0n,
  tier2Requests: requests.tier2 ?? 0n,
  requests: 0n,
});
const STORAGE_DOCUMENT = priceDocumentSchema.parse(withStoragePrices(FIRST_PRICE_BOOK));
/** The book with SQS's SKU too, as its migration makes it from the book before. */
const QUEUE_DOCUMENT = priceDocumentSchema.parse(withQueuePrices(withStoragePrices(FIRST_PRICE_BOOK)));
const WITH_QUEUES = bookPrices({ id: 'with-queues', validFrom: new Date('2026-11-01T00:00:00Z'), prices: QUEUE_DOCUMENT });
/** A queue asked `requests` requests, as SQS bills them. */
const queued = (resourceId: string, requests: bigint): ResourceUsage => ({ resourceId, kind: 'queue', byteHours: 0n, hours: 0n, tier1Requests: 0n, tier2Requests: 0n, requests });
/** The book with ElastiCache's SKU too, as its migration makes it from the book before. */
const CACHE_DOCUMENT = priceDocumentSchema.parse(withCachePrices(QUEUE_DOCUMENT));
const WITH_CACHES = bookPrices({ id: 'with-caches', validFrom: new Date('2026-11-01T00:00:00Z'), prices: CACHE_DOCUMENT });
/** A cache of `mb` MB through `hours` hours, sampled each hour: its memory, the plan's, whatever its keys use. */
const cached = (resourceId: string, mb: number, hours: number): ResourceUsage => ({
  resourceId,
  kind: 'cache',
  byteHours: BigInt(mb) * 1_048_576n * BigInt(hours),
  hours: BigInt(hours),
  tier1Requests: 0n,
  tier2Requests: 0n,
  requests: 0n,
});
const OCTOBER = hoursIn('2026-10');
const NOVEMBER = hoursIn('2026-11');

describe('rating a month (L1, P-30)', () => {
  it("prices AWS's first example as AWS's formula does, at the book's rate: 3 million calls of 120 ms at 1,536 MB", () => {
    const month = rateMonth([{ book: FIRST, functions: [usage('backend', { onDemand: { requests: 3_000_000n, mbMs: mbMs(3_000_000, 120, 1536) } })] }], FIRST);

    // AWS: (540,000 GB-s − 400,000 free) × $0.0000166667 + (3M − 1M free) × $0.20 per million = $2.733338.
    const byHand = d('140000').times(d('0.0000166667')).plus(d('2').times(d('0.20')));
    expect(byHand.toString()).toBe('2.733338');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.total.toFixed(3)).toBe('8.222');
    expect([month.usage.toString(), month.freeTier.toString(), month.volumeTiers.toString()]).toEqual(['28.876854144', '-20.65497344', '0']);
  });

  it("prices AWS's provisioned concurrency example the same way: 100 instances for 8 hours, then 2.5 million calls without", () => {
    const launch = usage('launch', {
      provisioned: { requests: 500_000n, mbMs: mbMs(500_000, 100, 1536) },
      provisionedMbMs: 480n * 100n * 1536n * 60_000n, // 480 minute samples of 100 instances
      onDemand: { requests: 2_500_000n, mbMs: mbMs(2_500_000, 120, 1536) },
    });

    const month = rateMonth([{ book: FIRST, functions: [launch] }], FIRST);

    // AWS: 4.32M GB-s × $0.0000041667 + 2M requests × $0.20/M + 75,000 GB-s × $0.0000097222 + (450,000 − 400,000) GB-s × $0.0000166667.
    const byHand = d('4320000')
      .times(d('0.0000041667'))
      .plus(d('2').times(d('0.20')))
      .plus(d('75000').times(d('0.0000097222')))
      .plus(d('50000').times(d('0.0000166667')));
    expect(byHand.toString()).toBe('19.962644');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.total.toFixed(3)).toBe('60.048');
  });

  it('gives no free tier to calls on provisioned concurrency', () => {
    const month = rateMonth([{ book: FIRST, functions: [usage('warm', { provisioned: { requests: 1_000n, mbMs: mbMs(1_000, 10, 128) } })] }], FIRST);

    expect(month.freeTier.isZero()).toBe(true);
    expect(month.total.toString()).toBe(month.usage.toString());
  });

  it("prices each function before the free tier, and takes the free tier off the account's total", () => {
    const month = rateMonth(
      [
        {
          book: FIRST,
          functions: [usage('a', { onDemand: { requests: 10n, mbMs: mbMs(10, 100, 1024) } }), usage('b', { onDemand: { requests: 20n, mbMs: mbMs(20, 50, 128) } })],
        },
      ],
      FIRST,
    );

    expect(month.functions.get('a')?.total.toString()).toBe(d('10').times(FIRST.perRequest).plus(d('1').times(d('0.0000501334336'))).toString());
    expect(month.usage.toString()).toBe(month.functions.get('a')!.total.plus(month.functions.get('b')!.total).toString());
    expect(month.freeTier.toString()).toBe(month.usage.negated().toString());
    expect(month.total.isZero()).toBe(true);
  });

  it('prices the GB-s past 6 billion in the month at the second tier, and past 15 billion at the third', () => {
    // 16 billion GB-s: 6 billion at tier 1, of which 400,000 free; 9 billion at tier 2; 1 billion at tier 3.
    const month = rateMonth([{ book: FIRST, functions: [usage('big', { onDemand: { requests: 0n, mbMs: 16_000_000_000n * 1_024_000n } })] }], FIRST);

    const expected = d('6000000000').minus(d('400000')).times(d('0.0000501334336')).plus(d('9000000000').times(d('0.00004512'))).plus(d('1000000000').times(d('0.0000401068672')));
    expect(month.total.toString()).toBe(expected.toString());
    expect(month.volumeTiers.toString()).toBe(
      d('9000000000').times(d('0.00004512').minus(d('0.0000501334336'))).plus(d('1000000000').times(d('0.0000401068672').minus(d('0.0000501334336')))).toString(),
    );
  });

  it("counts the free tier and the tiers from the month's start through a book that starts mid-month", () => {
    const later = book({ gbSecond: [{ upToGbSeconds: null, price: '0.0001' }], requestsPerMillion: '1' });
    const half = usage('fn', { onDemand: { requests: 600_000n, mbMs: 300_000n * 1_024_000n } }); // 300,000 GB-s

    const month = rateMonth([{ book: FIRST, functions: [half] }, { book: later, functions: [half] }], FIRST);

    // Free: 1M requests (600,000 from the first book's part, 400,000 from the second's) and 400,000 GB-s (300,000 + 100,000).
    // Billed: 200,000 requests and 200,000 GB-s, all in the second book's part, at its prices.
    expect(month.total.toString()).toBe(d('200000').times(d('0.000001')).plus(d('200000').times(d('0.0001'))).toString());
  });

  it("adds D8's knobs above zero: idle instance time, and a monthly fee once", () => {
    const knobs = book({ idleInstanceGbSecond: '0.00001', monthlyPlanFee: '5.000' });
    // 120 GB-s of instances above minInstances, of which calls used 20: 100 GB-s idle.
    const fn = usage('fn', { onDemand: { requests: 1n, mbMs: 20n * 1_024_000n }, reservedMbMs: 120n * 1_024_000n });

    const month = rateMonth([{ book: knobs, functions: [fn] }, { book: knobs, functions: [] }], knobs);

    expect(month.functions.get('fn')?.idle.toString()).toBe('0.001');
    expect(month.monthlyFee.toString()).toBe('5');
    expect(month.total.toString()).toBe('5.001');
  });

  it("leaves instance time that calls used, and minInstances' own, out of idle time", () => {
    const fn = usage('fn', { onDemand: { requests: 1n, mbMs: 200n * 1_024_000n }, reservedMbMs: 120n * 1_024_000n, provisionedMbMs: 1_000n * 1_024_000n });

    expect(rateMonth([{ book: book({ idleInstanceGbSecond: '1' }), functions: [fn] }], null).functions.get('fn')?.idle.isZero()).toBe(true);
  });
});

describe("rating a month of customers' databases and buckets (L1, ADR 0008, ADR 0009)", () => {
  it("prices a database's storage by the GB-month, as RDS does: 10 GB all month, less the free GB-month", () => {
    const month = rateMonth([{ book: WITH_STORAGE, functions: [], resources: [stored('orders', 10, OCTOBER)] }], WITH_STORAGE, OCTOBER);

    // RDS for PostgreSQL, gp3, Single-AZ: (10 − 1 free) GB-months × $0.115 = $1.035.
    const byHand = d('9').times(d(STORAGE_USD_PRICES.databaseStorageGbMonth));
    expect(byHand.toString()).toBe('1.035');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.total.toFixed(3)).toBe('3.113');
    expect(month.resources.get('orders')).toMatchObject({ kind: 'database' });
    expect([month.resources.get('orders')?.gbMonths.toString(), month.usage.toString(), month.freeTier.toString()]).toEqual(['10', '3.4592', '-0.34592']);
  });

  it("rates a month of functions and databases together: each priced as alone, the free tiers each their own", () => {
    const calls = usage('backend', { onDemand: { requests: 3_000_000n, mbMs: mbMs(3_000_000, 120, 1536) } });

    const month = rateMonth([{ book: WITH_STORAGE, functions: [calls], resources: [stored('orders', 10, OCTOBER)] }], WITH_STORAGE, OCTOBER);

    // AWS's first Lambda example, 8.221880704 TND, and the database's 9 GB-months, 3.11328 TND.
    expect(month.total.toString()).toBe('11.335160704');
    expect(month.functions.get('backend')?.total.toString()).toBe('28.876854144');
    expect(month.resources.get('orders')?.total.toString()).toBe('3.4592');
  });

  it("measures a database's part of the month by its hours sampled, and shares the account's free GB-month among its databases", () => {
    // 1 GB for 432 of November's 720 hours, 0.6 GB-month; another for 504 hours, 0.7: 0.3 past the free one.
    const month = rateMonth([{ book: WITH_STORAGE, functions: [], resources: [stored('a', 1, 432), stored('b', 1, 504)] }], WITH_STORAGE, NOVEMBER);

    expect([month.resources.get('a')?.gbMonths.toString(), month.resources.get('b')?.gbMonths.toString()]).toEqual(['0.6', '0.7']);
    expect(month.total.toString()).toBe(d('0.3').times(WITH_STORAGE.databaseStorageGbMonth).toString());
  });

  it("rounds GB-months to twelve decimals, a month's hours being no power of ten's divisor, and prices that exactly", () => {
    // 2 GB for 100 of October's 744 hours: 200 / 744 = 0.268817204301075…
    const month = rateMonth([{ book: WITH_STORAGE, functions: [], resources: [stored('new', 2, 100)] }], WITH_STORAGE, OCTOBER);

    expect(month.resources.get('new')?.gbMonths.toString()).toBe('0.268817204301');
    expect(month.resources.get('new')?.storage.toString()).toBe(d('0.268817204301').times(d('0.34592')).toString());
    expect(month.total.isZero()).toBe(true); // all of it in the free GB-month
  });

  it("prices databases at nothing, with no free tier, in a book from before their SKUs", () => {
    const month = rateMonth([{ book: FIRST, functions: [], resources: [stored('orders', 10, OCTOBER)] }], FIRST, OCTOBER);

    expect([month.total.toString(), month.resources.get('orders')?.gbMonths.toString()]).toEqual(['0', '10']);
  });

  it("counts the free GB-month from the month's start through a book that starts mid-month", () => {
    // The first half at the book before, free; the second half at the new book, the free GB-month taken by the first.
    const half = stored('orders', 2, OCTOBER / 2);

    const month = rateMonth([{ book: FIRST, functions: [], resources: [half] }, { book: WITH_STORAGE, functions: [], resources: [half] }], FIRST, OCTOBER);

    expect(month.resources.get('orders')?.gbMonths.toString()).toBe('2');
    expect(month.total.toString()).toBe(WITH_STORAGE.databaseStorageGbMonth.toString());
  });

  it("charges a book's monthly fee per database by the hours it existed", () => {
    const fee = bookPrices({ id: 'fee', validFrom: new Date('2026-11-01T00:00:00Z'), prices: { ...withStoragePrices(FIRST_PRICE_BOOK), prices: { ...STORAGE_DOCUMENT.prices, databaseMonthlyFee: '0.500' } } });

    const month = rateMonth([{ book: fee, functions: [], resources: [stored('half', 0, OCTOBER / 2)] }], fee, OCTOBER);

    expect([month.resources.get('half')?.fee.toString(), month.total.toString()]).toEqual(['0.25', '0.25']);
  });

  it("prices buckets as S3 Standard: storage in tiers by the account's GB-months, and requests by class, each past its free tier", () => {
    // 60 TB for all of October: 51,200 GB-months at the first tier (5 of them free), 10,240 at the second; 12,000 PUT and 120,000 GET.
    const month = rateMonth(
      [{ book: WITH_STORAGE, functions: [], resources: [stored('photos', 61_440, OCTOBER, 'bucket', { tier1: 12_000n, tier2: 120_000n })] }],
      WITH_STORAGE,
      OCTOBER,
    );

    // S3: (51,200 − 5) × $0.023 + 10,240 × $0.022 + (12,000 − 2,000) / 1,000 × $0.005 + (120,000 − 20,000) / 1,000 × $0.0004 = $1,402.855.
    const byHand = d('51195').times(d('0.023')).plus(d('10240').times(d('0.022'))).plus(d('10').times(d('0.005'))).plus(d('100').times(d('0.0004')));
    expect(byHand.toString()).toBe('1402.855');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.volumeTiers.toString()).toBe(d('10240').times(d('-0.003008')).toString());
    expect(month.resources.get('photos')?.requests.toString()).toBe(d('12000').times(d('0.00001504')).plus(d('120000').times(d('0.0000012032'))).toString());
  });

  it("needs the month's hours to price storage", () => {
    expect(() => rateMonth([{ book: WITH_STORAGE, functions: [], resources: [stored('orders', 1, 1)] }], WITH_STORAGE)).toThrow("A month's hours are needed to price storage by the GB-month");
    expect(rateMonth([{ book: WITH_STORAGE, functions: [] }], WITH_STORAGE).total.isZero()).toBe(true);
  });

  it('counts the hours of each month by the UTC calendar', () => {
    expect(['2026-10', '2026-11', '2027-02', '2028-02'].map(hoursIn)).toEqual([744, 720, 672, 696]);
  });
});

describe("the book of customers' databases' and buckets' SKUs (ADR 0008, ADR 0009)", () => {
  it("is AWS's US$ prices for RDS and S3 times the book's own rate, exactly, and its checks find nothing", () => {
    const { source, prices } = STORAGE_DOCUMENT;
    expect(source.usdRate).toBe(FIRST_PRICE_BOOK.source.usdRate);
    const times = (usd: string) => Decimal.parse(usd).times(Decimal.parse(FIRST_PRICE_BOOK.source.usdRate)).toString();

    expect(prices.databaseStorageGbMonth).toBe(times(STORAGE_USD_PRICES.databaseStorageGbMonth));
    expect(prices.bucketStorageGbMonth?.map((tier) => [tier.upToGbMonths, tier.price])).toEqual(STORAGE_USD_PRICES.bucketStorageGbMonth.map((tier) => [tier.upToGbMonths, times(tier.price)]));
    expect([prices.requestsTier1PerThousand, prices.requestsTier2PerThousand]).toEqual([times('0.005'), times('0.0004')]);
    expect(prices.databaseMonthlyFee).toBe('0');
    expect(awsPriceProblems(STORAGE_DOCUMENT)).toEqual([]);
  });

  it('keeps the functions\' SKUs and free tier of the book it copies, and adds the free tier you confirmed', () => {
    expect(STORAGE_DOCUMENT.prices.gbSecond).toEqual(FIRST_PRICE_BOOK.prices.gbSecond);
    expect(STORAGE_DOCUMENT.freeTier).toEqual({ ...FIRST_PRICE_BOOK.freeTier, ...STORAGE_FREE_TIER });
    expect(STORAGE_FREE_TIER).toEqual({ databaseStorageGbMonths: 1, bucketStorageGbMonths: 5, requestsTier1: 2_000, requestsTier2: 20_000 });
  });

  it("finds a price that isn't AWS's times the rate, a SKU in one place only, and bucket tiers that differ", () => {
    const changed = (prices: Partial<PriceDocument['prices']>, usd: Record<string, unknown> = {}): PriceDocument => ({
      ...STORAGE_DOCUMENT,
      source: { ...STORAGE_DOCUMENT.source, usdPrices: { ...(STORAGE_DOCUMENT.source.usdPrices as object), ...usd } },
      prices: { ...STORAGE_DOCUMENT.prices, ...prices },
    });

    expect(awsPriceProblems(changed({ databaseStorageGbMonth: '0.35' }))).toEqual([expect.stringMatching(/^prices\.databaseStorageGbMonth: /)]);
    expect(awsPriceProblems(changed({}, { requestsTier1PerThousand: undefined }))).toEqual(['prices.requestsTier1PerThousand: must be in both prices and source.usdPrices, or in neither']);
    expect(awsPriceProblems(changed({ bucketStorageGbMonth: [{ upToGbMonths: null, price: '0.069184' }] }))).toEqual([
      'prices.bucketStorageGbMonth: must have the tiers of source.usdPrices.bucketStorageGbMonth',
    ]);
  });

  it('reads every book from before, without the new SKUs, as pricing them at nothing', () => {
    expect(priceDocumentSchema.safeParse(FIRST_PRICE_BOOK).success).toBe(true);
    expect([FIRST.databaseStorageGbMonth, FIRST.perTier1Request, FIRST.freeDatabaseGbMonths, FIRST.bucketStorageTiers[0].price].map(String)).toEqual(['0', '0', '0', '0']);
    expect([FIRST.queueRequestTiers[0].price, FIRST.freeQueueRequests].map(String)).toEqual(['0', '0']);
  });
});

describe("rating a month of customers' queues (L1, ADR 0010)", () => {
  it("prices a queue's requests as SQS does: 3 million in the month, less the free million, at $0.40 a million times the book's rate", () => {
    const month = rateMonth([{ book: WITH_QUEUES, functions: [], resources: [queued('orders', 3_000_000n)] }], WITH_QUEUES, OCTOBER);

    // SQS: (3,000,000 − 1,000,000 free) / 1,000,000 × $0.40 = $0.80.
    const byHand = d('2').times(d('0.40'));
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.total.toString()).toBe('2.4064');
    const cost = month.resources.get('orders');
    expect([cost?.kind, cost?.gbMonths, cost?.storage, cost?.requests, cost?.fee, cost?.total].map(String)).toEqual(['queue', '0', '0', '3.6096', '0', '3.6096']);
    expect(month.freeTier.toString()).toBe('-1.2032');
  });

  it("shares the account's free million among its queues", () => {
    const month = rateMonth([{ book: WITH_QUEUES, functions: [], resources: [queued('orders', 600_000n), queued('receipts', 600_000n)] }], WITH_QUEUES, OCTOBER);

    expect([month.resources.get('orders')?.total.toString(), month.resources.get('receipts')?.total.toString()]).toEqual(['0.72192', '0.72192']);
    expect(month.total.toString()).toBe(d('0.2').times(d('1.2032')).toString());
  });

  it('prices the requests past 100 billion in the month at the second tier, and past 200 billion at the third', () => {
    const month = rateMonth([{ book: WITH_QUEUES, functions: [], resources: [queued('firehose', 250_000_000_000n)] }], WITH_QUEUES, OCTOBER);

    // SQS: (100,000 − 1 free) million × $0.40 + 100,000 million × $0.30 + 50,000 million × $0.24 = $81,999.60.
    const byHand = d('99999').times(d('0.40')).plus(d('100000').times(d('0.30'))).plus(d('50000').times(d('0.24')));
    expect(byHand.toString()).toBe('81999.6');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    expect(month.volumeTiers.toString()).toBe(d('-18000').times(RATE).toString());
  });

  it("counts the free million from the month's start through a book that starts mid-month", () => {
    // 800,000 at the book before, which prices queues at nothing; then 800,000 more, of which 200,000 are still free.
    const half = queued('orders', 800_000n);

    const month = rateMonth([{ book: FIRST, functions: [], resources: [half] }, { book: WITH_QUEUES, functions: [], resources: [half] }], FIRST, OCTOBER);

    expect(month.total.toString()).toBe(d('0.6').times(d('1.2032')).toString());
  });

  it('prices queues at nothing, with no free tier, in a book from before their SKU', () => {
    const month = rateMonth([{ book: WITH_STORAGE, functions: [], resources: [queued('orders', 5_000_000n)] }], WITH_STORAGE, OCTOBER);

    expect([month.total.toString(), month.freeTier.toString()]).toEqual(['0', '0']);
  });
});

describe("rating a month of customers' caches (L1, ADR 0013)", () => {
  it("prices a cache's memory by the GB-hour, as ElastiCache bills a node: 64 MB through October's 744 hours, at $0.0256 a GB-hour times the book's rate", () => {
    const month = rateMonth([{ book: WITH_CACHES, functions: [], resources: [cached('sessions', 64, 744)] }], WITH_CACHES, OCTOBER);

    // ElastiCache: 64 MB is 0.0625 GB; through 744 hours, 46.5 GB-hours × $0.0256 = $1.1904, with no free tier.
    const byHand = d('46.5').times(d('0.0256'));
    expect(byHand.toString()).toBe('1.1904');
    expect(month.total.toString()).toBe(byHand.times(RATE).toString());
    const cost = month.resources.get('sessions');
    expect([cost?.kind, cost?.storage, cost?.requests, cost?.fee, cost?.total].map(String)).toEqual(['cache', '3.5807232', '0', '0', '3.5807232']);
    expect([month.freeTier.toString(), cost?.gbMonths.toString()]).toEqual(['0', '0.0625']);
  });

  it("takes nothing from the databases' and buckets' free GB-months, nor they from it", () => {
    // The bucket's 1 GB-month is within S3's free 5; the cache's 0.0625 GB-months are a cache's, not storage.
    const month = rateMonth([{ book: WITH_CACHES, functions: [], resources: [cached('sessions', 64, 744), stored('photos', 1, 744, 'bucket')] }], WITH_CACHES, OCTOBER);

    expect(month.total.toString()).toBe('3.5807232');
  });

  it('bills the hours sampled only, at the price of the book each hour was rated with', () => {
    // 100 hours at the book before, which prices caches at nothing; then 200 at ElastiCache's price.
    const month = rateMonth([{ book: WITH_QUEUES, functions: [], resources: [cached('sessions', 64, 100)] }, { book: WITH_CACHES, functions: [], resources: [cached('sessions', 64, 200)] }], WITH_QUEUES, OCTOBER);

    expect(month.total.toString()).toBe(d('12.5').times(d('0.0256')).times(RATE).toString());
  });
});

describe("the book of customers' caches' SKU (ADR 0013)", () => {
  it("is AWS's US$ price for ElastiCache for Valkey's cache.t4g.micro, by the GB-hour of its memory, times the book's own rate, exactly, with no free tier, and its checks find nothing", () => {
    expect(CACHE_USD_PRICES).toEqual({ cacheGbHour: '0.0256' });
    expect(CACHE_DOCUMENT.prices.cacheGbHour).toBe(Decimal.parse('0.0256').times(RATE).toString());
    expect(CACHE_DOCUMENT.prices.cacheGbHour).toBe('0.0770048');
    expect(CACHE_DOCUMENT.freeTier).toEqual(QUEUE_DOCUMENT.freeTier);
    // The SKUs of the book it copies stay.
    expect(CACHE_DOCUMENT.prices.queueRequestsPerMillion).toEqual(QUEUE_DOCUMENT.prices.queueRequestsPerMillion);
    expect(awsPriceProblems(CACHE_DOCUMENT)).toEqual([]);
  });

  it("finds a price that isn't AWS's times the rate, and the SKU in one place only", () => {
    const changed = (price: string | undefined, usd: string | undefined): PriceDocument => ({
      ...CACHE_DOCUMENT,
      source: { ...CACHE_DOCUMENT.source, usdPrices: { ...(CACHE_DOCUMENT.source.usdPrices as object), cacheGbHour: usd } },
      prices: { ...CACHE_DOCUMENT.prices, cacheGbHour: price },
    });

    expect(awsPriceProblems(changed('0.08', '0.0256'))).toEqual(['prices.cacheGbHour: must be 0.0256 × 3.0080 = 0.0770048']);
    expect(awsPriceProblems(changed('0.0770048', undefined))).toEqual(['prices.cacheGbHour: must be in both prices and source.usdPrices, or in neither']);
  });
});

describe("the book of customers' queues' SKU (ADR 0010)", () => {
  it("is AWS's US$ prices for SQS's standard queues, in their tiers, times the book's own rate, exactly, with SQS's free million, and its checks find nothing", () => {
    const times = (usd: string) => Decimal.parse(usd).times(Decimal.parse(FIRST_PRICE_BOOK.source.usdRate)).toString();

    expect(QUEUE_DOCUMENT.prices.queueRequestsPerMillion?.map((tier) => [tier.upToRequests, tier.price])).toEqual(
      QUEUE_USD_PRICES.queueRequestsPerMillion.map((tier) => [tier.upToRequests, times(tier.price)]),
    );
    expect(QUEUE_DOCUMENT.prices.queueRequestsPerMillion?.map((tier) => tier.price)).toEqual(['1.2032', '0.9024', '0.72192']);
    expect(QUEUE_DOCUMENT.freeTier).toEqual({ ...FIRST_PRICE_BOOK.freeTier, ...STORAGE_FREE_TIER, ...QUEUE_FREE_TIER });
    expect(QUEUE_FREE_TIER).toEqual({ queueRequests: 1_000_000 });
    // The storage SKUs of the book it copies stay.
    expect(QUEUE_DOCUMENT.prices.bucketStorageGbMonth).toEqual(STORAGE_DOCUMENT.prices.bucketStorageGbMonth);
    expect(awsPriceProblems(QUEUE_DOCUMENT)).toEqual([]);
  });

  it("finds queue tiers that differ from AWS's, a price that isn't AWS's times the rate, and the SKU in one place only", () => {
    const changed = (tiers: unknown, usd?: unknown): PriceDocument => ({
      ...QUEUE_DOCUMENT,
      source: { ...QUEUE_DOCUMENT.source, usdPrices: { ...(QUEUE_DOCUMENT.source.usdPrices as object), queueRequestsPerMillion: usd } },
      prices: { ...QUEUE_DOCUMENT.prices, queueRequestsPerMillion: tiers as PriceDocument['prices']['queueRequestsPerMillion'] },
    });

    expect(awsPriceProblems(changed([{ upToRequests: null, price: '1.2032' }], QUEUE_USD_PRICES.queueRequestsPerMillion))).toEqual([
      'prices.queueRequestsPerMillion: must have the tiers of source.usdPrices.queueRequestsPerMillion',
    ]);
    const tiers = QUEUE_DOCUMENT.prices.queueRequestsPerMillion ?? [];
    expect(awsPriceProblems(changed([{ ...tiers[0], price: '1.5' }, tiers[1], tiers[2]], QUEUE_USD_PRICES.queueRequestsPerMillion))).toEqual([
      'prices.queueRequestsPerMillion.0.price: must be 0.40 × 3.0080 = 1.2032',
    ]);
    expect(awsPriceProblems(changed(tiers, undefined))).toEqual(['prices.queueRequestsPerMillion: must be in both prices and source.usdPrices, or in neither']);
  });

  it('refuses tiers that go down, or whose last has an end', () => {
    const problems = (tiers: unknown) => priceDocumentSchema.safeParse({ ...QUEUE_DOCUMENT, prices: { ...QUEUE_DOCUMENT.prices, queueRequestsPerMillion: tiers } }).error?.issues.map((issue) => issue.message);

    expect(problems([{ upToRequests: 10, price: '1' }])).toEqual(['must go up, tier by tier, and the last tier has no end (upToRequests null)']);
    expect(problems([{ upToRequests: 10, price: '1' }, { upToRequests: 5, price: '1' }, { upToRequests: null, price: '1' }])).toEqual([
      'must go up, tier by tier, and the last tier has no end (upToRequests null)',
    ]);
  });
});

describe('the first price book (P-30, D8)', () => {
  it("is AWS's US$ prices times the BCT's rate, exactly, unrounded", () => {
    const { source, prices } = FIRST_PRICE_BOOK;
    const times = (usd: string) => Decimal.parse(usd).times(Decimal.parse(source.usdRate)).toString();

    expect(source.usdRate).toBe('3.0080');
    expect(prices.requestsPerMillion).toBe(times(source.usdPrices.requestsPerMillion));
    expect(prices.gbSecond.map((tier) => tier.price)).toEqual(source.usdPrices.gbSecond.map((tier) => times(tier.price)));
    expect(prices.gbSecond.map((tier) => tier.upToGbSeconds)).toEqual(source.usdPrices.gbSecond.map((tier) => tier.upToGbSeconds));
    expect([prices.provisionedGbSecond, prices.provisionedDurationGbSecond]).toEqual([
      times(source.usdPrices.provisionedGbSecond),
      times(source.usdPrices.provisionedDurationGbSecond),
    ]);
  });

  it("has AWS's free tier, and D8's knobs at zero", () => {
    expect(FIRST_PRICE_BOOK.freeTier).toEqual({ requests: 1_000_000, gbSeconds: 400_000 });
    expect(FIRST.minimumBilledMs + Number(FIRST.idleInstanceGbSecond.toString()) + Number(FIRST.monthlyPlanFee.toString())).toBe(0);
  });
});

describe('a price book that does not fit (P-30)', () => {
  it.each([
    [{ requestsPerMillion: 0.6016 }, 'prices.requestsPerMillion: Invalid input: expected string, received number'],
    [{ requestsPerMillion: '6e-1' }, 'prices.requestsPerMillion: must be a decimal number written as a string, such as "0.0000166667"'],
    [{ gbSecond: [{ upToGbSeconds: 10, price: '1' }, { upToGbSeconds: 5, price: '1' }, { upToGbSeconds: null, price: '1' }] }, 'prices.gbSecond: must go up, tier by tier'],
    [{ gbSecond: [{ upToGbSeconds: 10, price: '1' }] }, 'prices.gbSecond: must go up, tier by tier, and the last tier has no end (upToGbSeconds null)'],
  ])('stops the rating, naming the book and the problem: %j', (prices, problem) => {
    expect(() => book(prices as Partial<PriceDocument['prices']>)).toThrow(`The price book book is invalid: ${problem}`);
  });

  it('needs every SKU', () => {
    const missing: Partial<typeof FIRST_PRICE_BOOK.prices> = { ...FIRST_PRICE_BOOK.prices };
    delete missing.monthlyPlanFee;
    expect(() => bookPrices({ id: 'old', validFrom: new Date(), prices: { ...FIRST_PRICE_BOOK, prices: missing } })).toThrow(
      'The price book old is invalid: prices.monthlyPlanFee: Invalid input: expected string, received undefined',
    );
  });
});
