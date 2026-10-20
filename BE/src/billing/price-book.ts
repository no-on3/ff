import { z } from 'zod';
import { Decimal } from './decimal';

/** A price or an amount: a decimal number written as a string, never a float (§4). */
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal number written as a string, such as "0.0000166667"');
const count = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a day, such as 2026-10-14');

/**
 * A price book's document (P-30, D8): AWS Lambda's SKUs, in the book's
 * currency. Every SKU is required; the duration tiers go up, and the last has
 * no end. The last three prices are D8's knobs, at zero to price as AWS does.
 */
export const priceDocumentSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a currency code, such as TND'),
  /** Where the prices come from: for AWS's, the list read, its US$ prices, and the rate used. */
  source: z.looseObject({
    kind: z.string().min(1),
    readOn: day.optional(),
    usdRate: decimal.optional(),
    usdRateDate: day.optional(),
  }),
  /** Per account and month, for functions without provisioned concurrency (D8). */
  freeTier: z.strictObject({ requests: count, gbSeconds: count }),
  prices: z.strictObject({
    requestsPerMillion: decimal,
    /** On-demand duration, by the account's GB-seconds so far in the month. */
    gbSecond: z
      .array(z.strictObject({ upToGbSeconds: z.number().int().positive().nullable(), price: decimal }))
      .min(1)
      .refine(
        (tiers) =>
          tiers.every((tier, index) =>
            index === tiers.length - 1 ? tier.upToGbSeconds === null : tier.upToGbSeconds !== null && (index === 0 || tier.upToGbSeconds > (tiers[index - 1].upToGbSeconds as number)),
          ),
        { message: 'must go up, tier by tier, and the last tier has no end (upToGbSeconds null)' },
      ),
    /** Per GB-s of minInstances held, from the minute samples (P-21). */
    provisionedGbSecond: decimal,
    /** Per GB-s of calls that ran with minInstances above zero. */
    provisionedDurationGbSecond: decimal,
    /** D8's knob: no call is billed less than this, in ms. */
    minimumBilledMs: count,
    /** D8's knob: per GB-s of ready instances, above minInstances, that no call used. */
    idleInstanceGbSecond: decimal,
    /** D8's knob: each account, each month. */
    monthlyPlanFee: decimal,
  }),
});

export type PriceDocument = z.infer<typeof priceDocumentSchema>;

/** A book's prices, read once into exact decimals for rating. */
export interface BookPrices {
  id: string;
  validFrom: Date;
  freeRequests: Decimal;
  freeGbSeconds: Decimal;
  perRequest: Decimal;
  gbSecondTiers: Array<{ upTo: Decimal | null; price: Decimal }>;
  provisionedGbSecond: Decimal;
  provisionedDurationGbSecond: Decimal;
  minimumBilledMs: number;
  idleInstanceGbSecond: Decimal;
  monthlyPlanFee: Decimal;
}

/** A book as the rater uses it. A document that doesn't fit stops the rating, naming the book and the problems. */
export function bookPrices(book: { id: string; validFrom: Date; prices: unknown }): BookPrices {
  const parsed = priceDocumentSchema.safeParse(book.prices);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`The price book ${book.id} is invalid: ${problems}`);
  }
  const { freeTier, prices } = parsed.data;
  return {
    id: book.id,
    validFrom: book.validFrom,
    freeRequests: Decimal.of(freeTier.requests),
    freeGbSeconds: Decimal.of(freeTier.gbSeconds),
    perRequest: Decimal.parse(prices.requestsPerMillion).times(Decimal.ratio(1n, 1_000_000n)),
    gbSecondTiers: prices.gbSecond.map((tier) => ({ upTo: tier.upToGbSeconds === null ? null : Decimal.of(tier.upToGbSeconds), price: Decimal.parse(tier.price) })),
    provisionedGbSecond: Decimal.parse(prices.provisionedGbSecond),
    provisionedDurationGbSecond: Decimal.parse(prices.provisionedDurationGbSecond),
    minimumBilledMs: prices.minimumBilledMs,
    idleInstanceGbSecond: Decimal.parse(prices.idleInstanceGbSecond),
    monthlyPlanFee: Decimal.parse(prices.monthlyPlanFee),
  };
}

/** AWS's US$ prices, as a book that says it comes from them records them (P-30, P-73). */
const usdPricesSchema = z.strictObject({
  requestsPerMillion: decimal,
  gbSecond: z.array(z.strictObject({ upToGbSeconds: z.number().int().positive().nullable(), price: decimal })).min(1),
  provisionedGbSecond: decimal,
  provisionedDurationGbSecond: decimal,
});

/**
 * Why a book that says its prices are AWS's US$ prices times a rate
 * (source.kind "aws-lambda") isn't exactly that, SKU by SKU; none for a book
 * that says nothing of the kind. D8's knobs and the free tier are FF's own.
 */
export function awsPriceProblems(document: PriceDocument): string[] {
  if (document.source.kind !== 'aws-lambda') return [];
  const usd = usdPricesSchema.safeParse(document.source.usdPrices);
  if (!usd.success || document.source.usdRate === undefined) return ['source: an aws-lambda book records usdPrices and usdRate'];
  const rate = Decimal.parse(document.source.usdRate);
  const problems: string[] = [];
  const expect = (sku: string, price: string, usdPrice: string) => {
    const expected = Decimal.parse(usdPrice).times(rate);
    if (Decimal.parse(price).compare(expected) !== 0) problems.push(`prices.${sku}: must be ${usdPrice} × ${document.source.usdRate} = ${expected.toString()}`);
  };
  const { prices } = document;
  expect('requestsPerMillion', prices.requestsPerMillion, usd.data.requestsPerMillion);
  if (usd.data.gbSecond.length !== prices.gbSecond.length || usd.data.gbSecond.some((tier, index) => tier.upToGbSeconds !== prices.gbSecond[index].upToGbSeconds)) {
    problems.push('prices.gbSecond: must have the tiers of source.usdPrices.gbSecond');
  } else {
    usd.data.gbSecond.forEach((tier, index) => expect(`gbSecond.${index}.price`, prices.gbSecond[index].price, tier.price));
  }
  expect('provisionedGbSecond', prices.provisionedGbSecond, usd.data.provisionedGbSecond);
  expect('provisionedDurationGbSecond', prices.provisionedDurationGbSecond, usd.data.provisionedDurationGbSecond);
  return problems;
}

/** A book's problems, each "path: why": the schema's, then AWS's prices. Empty when it fits. */
export function priceDocumentProblems(value: unknown): string[] {
  const parsed = priceDocumentSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`);
  return awsPriceProblems(parsed.data);
}
