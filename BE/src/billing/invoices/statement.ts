import { Decimal } from '../decimal';
import { toMinor } from '../money';
import { BookPrices } from '../price-book';
import { BYTES_PER_GB, FunctionUsage, ResourceUsage, hoursIn, rateMonth } from '../rating';

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

/** One customer's database's, bucket's, queue's or cache's month, as the statement lists it. */
export interface StatementResource {
  resourceId: string;
  kind: 'database' | 'bucket' | 'queue' | 'cache';
  /** Its name when it was last sampled or asked something in the month. */
  name: string;
  /** Its storage, in GB-months, to six decimals at most: "0.007118"; 0 for a queue; a cache's memory held. */
  gbMonths: string;
  /** The hours it was sampled in; a cache's, as ElastiCache counts a node's hours. */
  hours: bigint;
  /** A cache's memory, in GB-hours, to six decimals at most, as it is billed: "46.5"; for the others, their size the same way. */
  gbHours: string;
  /** A bucket's requests by S3's two classes; 0 for a database or a queue. */
  tier1Requests: bigint;
  tier2Requests: bigint;
  /** A queue's requests, as SQS bills them; 0 for a database or a bucket. */
  requests: bigint;
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
  /** Its buckets, its caches, its databases and its queues, each by name. */
  resources: StatementResource[];
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
  /** The month's resource_usage_hourly, summed per database, bucket, queue or cache and book, with its name when last sampled. */
  resources: Array<ResourceUsage & { priceBookId: string; name: string }>;
  charges: { debitedMinor: bigint; shadowMinor: bigint; ratedUntil: Date | null };
  /** The month's end, to say whether it is rated to it. */
  monthEnd: Date;
}

/** The statement of a month, from its hourly sums, priced as the hourly rating prices them (rateMonth()). */
export function buildStatement(input: StatementInput): Statement {
  const { books, rows, exponent } = input;
  const estimate = rateMonth(
    books.map((book) => ({ book, functions: rows.filter((row) => row.priceBookId === book.id), resources: input.resources.filter((row) => row.priceBookId === book.id) })),
    books[0] ?? null,
    hoursIn(input.month),
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
  const usage = new Map<string, { name: string; tier1: bigint; tier2: bigint; requests: bigint; hours: bigint; byteHours: bigint }>();
  for (const row of input.resources) {
    const sum = usage.get(row.resourceId) ?? { name: row.name, tier1: 0n, tier2: 0n, requests: 0n, hours: 0n, byteHours: 0n };
    usage.set(row.resourceId, {
      name: sum.name,
      tier1: sum.tier1 + row.tier1Requests,
      tier2: sum.tier2 + row.tier2Requests,
      requests: sum.requests + row.requests,
      hours: sum.hours + row.hours,
      byteHours: sum.byteHours + row.byteHours,
    });
  }
  const resources = [...estimate.resources.entries()]
    .map(([resourceId, cost]) => {
      const sum = usage.get(resourceId) ?? { name: resourceId, tier1: 0n, tier2: 0n, requests: 0n, hours: 0n, byteHours: 0n };
      return {
        resourceId,
        kind: cost.kind,
        name: sum.name,
        gbMonths: cost.gbMonths.round(6).toString(),
        hours: sum.hours,
        gbHours: Decimal.ratio(sum.byteHours, BYTES_PER_GB).round(6).toString(),
        tier1Requests: sum.tier1,
        tier2Requests: sum.tier2,
        requests: sum.requests,
        amountMinor: toMinor(cost.total, exponent),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.resourceId.localeCompare(b.resourceId));
  const { ratedUntil } = input.charges;
  return {
    month: input.month,
    currency: input.currency,
    exponent,
    functions,
    resources,
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
