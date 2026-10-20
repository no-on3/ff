import { EntityManager } from 'typeorm';

/** The currency an account's money is in, and its minor unit's digits. */
export interface BillingCurrency {
  currency: string;
  exponent: number;
}

/** The currency of the prices (P-32): the book valid at `now`, or, before the first starts, the first to come. */
export async function billingCurrency(manager: EntityManager, now: Date): Promise<BillingCurrency> {
  const [prices] = await manager.query<BillingCurrency[]>(
    `SELECT b."currency", c."exponent" FROM "price_books" b JOIN "currencies" c ON c."code" = b."currency"
      -- the started books first, the latest of them; else the earliest to come
      ORDER BY b."valid_from" <= $1 DESC, CASE WHEN b."valid_from" <= $1 THEN b."valid_from" END DESC, b."valid_from" LIMIT 1`,
    [now],
  );
  if (!prices) throw new Error('No price book: the PriceBooks migration loads the first');
  return prices;
}
