import { Decimal } from '../decimal';
import { toMinor } from '../money';
import { BookPrices } from '../price-book';
import { FunctionUsage, rateMonth } from '../rating';

/** MB-ms per GB-second (D7). */
const MB_MS_PER_GB_SECOND = 1_024_000n;

/** One function's month, as P-36's statement lists it. */
export interface StatementFunction {
  functionId: string;
  name: string;
  /** Billed calls, with and without provisioned concurrency. */
  requests: bigint;
  /** Their GB-seconds, to six decimals at most: "0.000125". */
  gbSeconds: string;
  /** Before the free tier, at the books' prices, rounded to the minor unit for display. */
  amountMinor: bigint;
}

/**
 * An account's month of usage, as rated (P-36, D9): what each function used
 * and cost before the free tier, the free tier and the other lines, the
 * month's total rounded once, and what the hourly rating charged for it,
 * which equals the total once the month is rated to its end. The usage
 * itself is in the invoice's VAT already: the credit that pays it was
 * invoiced when it was bought.
 */
export interface Statement {
  month: string;
  currency: string;
  exponent: number;
  functions: StatementFunction[];
  usageMinor: bigint;
  freeTierMinor: bigint;
  volumeTiersMinor: bigint;
  monthlyFeeMinor: bigint;
  totalMinor: bigint;
  /** The month's hourly charges that were debited (P-32). */
  debitedMinor: bigint;
  /** Those of shadow mode: rated and shown, not debited (D9). */
  shadowMinor: bigint;
  /** The end of the last hour rated in the month; null before the first. */
  ratedUntil: Date | null;
  /** Whether the month is rated to its end. */
  complete: boolean;
}

export interface StatementInput {
  month: string;
  currency: string;
  exponent: number;
  /** The books that priced the month, in time order. */
  books: BookPrices[];
  /** The month's usage_hourly, summed per function and book. */
  rows: Array<FunctionUsage & { priceBookId: string }>;
  /** Each function's name, as last invoked. */
  names: Map<string, string>;
  charges: { debitedMinor: bigint; shadowMinor: bigint; ratedUntil: Date | null };
  /** The month's end, to say whether it is rated to it. */
  monthEnd: Date;
}

/** The statement of a month, from its hourly sums, priced as the hourly rating prices them (rateMonth()). */
export function buildStatement(input: StatementInput): Statement {
  const { books, rows, exponent } = input;
  const estimate = rateMonth(
    books.map((book) => ({ book, functions: rows.filter((row) => row.priceBookId === book.id) })),
    books[0] ?? null,
  );
  const sums = new Map<string, { requests: bigint; mbMs: bigint }>();
  for (const row of rows) {
    const sum = sums.get(row.functionId) ?? { requests: 0n, mbMs: 0n };
    sums.set(row.functionId, { requests: sum.requests + row.onDemand.requests + row.provisioned.requests, mbMs: sum.mbMs + row.onDemand.mbMs + row.provisioned.mbMs });
  }
  const functions = [...estimate.functions.entries()]
    .map(([functionId, cost]) => {
      const sum = sums.get(functionId) ?? { requests: 0n, mbMs: 0n };
      return {
        functionId,
        name: input.names.get(functionId) ?? functionId,
        requests: sum.requests,
        gbSeconds: Decimal.ratio(sum.mbMs, MB_MS_PER_GB_SECOND).round(6).toString(),
        amountMinor: toMinor(cost.total, exponent),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.functionId.localeCompare(b.functionId));
  const { ratedUntil } = input.charges;
  return {
    month: input.month,
    currency: input.currency,
    exponent,
    functions,
    usageMinor: toMinor(estimate.usage, exponent),
    freeTierMinor: toMinor(estimate.freeTier, exponent),
    volumeTiersMinor: toMinor(estimate.volumeTiers, exponent),
    monthlyFeeMinor: toMinor(estimate.monthlyFee, exponent),
    totalMinor: toMinor(estimate.total, exponent),
    debitedMinor: input.charges.debitedMinor,
    shadowMinor: input.charges.shadowMinor,
    ratedUntil,
    complete: ratedUntil !== null && ratedUntil >= input.monthEnd,
  };
}
