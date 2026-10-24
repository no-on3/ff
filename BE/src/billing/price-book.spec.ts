/**
 * L1: a price book that says it is AWS's US$ prices times a rate must be
 * exactly that (client-readiness plan, P-73, D8); the book's other problems
 * come first, named.
 */
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { withStoragePrices } from '../migrations/1792727200566-DatabaseBilling';
import { withQueuePrices } from '../migrations/1792816013937-QueueBilling';
import { PriceDocument, priceDocumentProblems, priceDocumentSchema, storageKeysMissing } from './price-book';

const withPrices = (prices: Partial<PriceDocument['prices']>, source: Record<string, unknown> = FIRST_PRICE_BOOK.source) => ({
  ...FIRST_PRICE_BOOK,
  source,
  prices: { ...FIRST_PRICE_BOOK.prices, ...prices },
});

describe("a price book's problems (L1, P-73)", () => {
  it("has none for the first book: AWS's prices times the BCT's rate, exactly", () => {
    expect(priceDocumentProblems(FIRST_PRICE_BOOK)).toEqual([]);
  });

  it('names an AWS price that is not the US$ price times the rate, and what it must be', () => {
    expect(priceDocumentProblems(withPrices({ requestsPerMillion: '0.60', provisionedGbSecond: '0.0000125' }))).toEqual([
      'prices.requestsPerMillion: must be 0.20 × 3.0080 = 0.6016',
      'prices.provisionedGbSecond: must be 0.0000041667 × 3.0080 = 0.0000125334336',
    ]);
  });

  it("follows a new rate: AWS's prices times it, and nothing else", () => {
    const rate = { ...FIRST_PRICE_BOOK.source, usdRate: '3.1' };

    expect(priceDocumentProblems(withPrices({}, rate))[0]).toBe('prices.requestsPerMillion: must be 0.20 × 3.1 = 0.62');
  });

  it("needs the US$ prices and the rate of a book from AWS's, and the same tiers", () => {
    const noUsd: Record<string, unknown> = { ...FIRST_PRICE_BOOK.source };
    delete noUsd.usdPrices;
    const oneTier = withPrices({ gbSecond: [{ upToGbSeconds: null, price: '0.0000501334336' }] });

    expect(priceDocumentProblems(withPrices({}, noUsd))).toEqual(['source: an aws-lambda book records usdPrices and usdRate']);
    expect(priceDocumentProblems(oneTier)).toEqual(['prices.gbSecond: must have the tiers of source.usdPrices.gbSecond']);
  });

  it('leaves the prices of a book of another kind to the operator, and D8\'s knobs to FF in any book', () => {
    expect(priceDocumentProblems(withPrices({ requestsPerMillion: '0.5' }, { kind: 'manual' }))).toEqual([]);
    expect(priceDocumentProblems(withPrices({ minimumBilledMs: 100, monthlyPlanFee: '5.000' }))).toEqual([]);
  });

  it("has none for the book of databases' and buckets' SKUs, and names bucket tiers that don't go up or whose last has an end", () => {
    const priced = withStoragePrices(FIRST_PRICE_BOOK);
    const tiers = (bucketStorageGbMonth: unknown) => priceDocumentProblems({ ...priced, prices: { ...priced.prices, bucketStorageGbMonth } });
    const problem = 'prices.bucketStorageGbMonth: must go up, tier by tier, and the last tier has no end (upToGbMonths null)';

    expect(priceDocumentProblems(priced)).toEqual([]);
    expect(tiers([{ upToGbMonths: 10, price: '1' }])).toEqual([problem]);
    expect(tiers([{ upToGbMonths: 10, price: '1' }, { upToGbMonths: 5, price: '1' }, { upToGbMonths: null, price: '1' }])).toEqual([problem]);
  });

  it("names the storage prices and free tier a book lacks that the book before it has, and nothing between books without them", () => {
    const priced = priceDocumentSchema.parse(withStoragePrices(FIRST_PRICE_BOOK));
    const first = priceDocumentSchema.parse(FIRST_PRICE_BOOK);
    const noFee = { ...priced, prices: { ...priced.prices, databaseMonthlyFee: undefined }, freeTier: { ...priced.freeTier, requestsTier2: undefined } };

    expect([storageKeysMissing(priced, priced), storageKeysMissing(first, first), storageKeysMissing(first, priced)]).toEqual([[], [], []]);
    expect(storageKeysMissing(priced, noFee)).toEqual(['prices.databaseMonthlyFee', 'freeTier.requestsTier2']);
    expect(storageKeysMissing(priced, first)).toHaveLength(9);
  });

  it("names SQS's price and its free million when a book lacks them that the book before it has", () => {
    const queued = priceDocumentSchema.parse(withQueuePrices(withStoragePrices(FIRST_PRICE_BOOK)));
    const priced = priceDocumentSchema.parse(withStoragePrices(FIRST_PRICE_BOOK));

    expect([storageKeysMissing(priced, queued), storageKeysMissing(queued, queued)]).toEqual([[], []]);
    expect(storageKeysMissing(queued, priced)).toEqual(['prices.queueRequestsPerMillion', 'freeTier.queueRequests']);
    expect(priceDocumentProblems(queued)).toEqual([]);
  });

  it("names the schema's problems before any of AWS's", () => {
    expect(priceDocumentProblems(withPrices({ requestsPerMillion: 0.6016 as unknown as string }))).toEqual([
      'prices.requestsPerMillion: Invalid input: expected string, received number',
    ]);
    expect(priceDocumentProblems('cheap')).toEqual(['document: Invalid input: expected object, received string']);
  });
});
