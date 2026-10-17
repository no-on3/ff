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
