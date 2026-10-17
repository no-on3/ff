/**
 * L1: pricing a month (client-readiness plan, P-30, D8). AWS's own examples,
 * from its Lambda pricing page, rated by FF with the first price book, equal
 * the same months computed by hand with AWS's formula, in US$, times the
 * book's rate. Then each of D8's knobs above zero, the duration tiers, and a
 * book that starts in the middle of a month. The minimum billed duration
 * applies to each call, in the aggregation's SQL: pricing.db.spec.ts.
 */
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { Decimal } from './decimal';
import { BookPrices, PriceDocument, bookPrices } from './price-book';
import { FunctionUsage, rateMonth } from './rating';

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
