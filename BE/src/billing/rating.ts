import { Decimal } from './decimal';
import { BookPrices } from './price-book';

/** MB-ms per GB-second: 1,024 MB × 1,000 ms (D7). */
const MB_MS_PER_GB_SECOND = 1_024_000n;

/** One function's usage in the part of a month that one book prices. */
export interface FunctionUsage {
  functionId: string;
  /**
   * Billed calls (success, error, timeout: D7) that ran without provisioned
   * concurrency: how many, and their MB-ms, billed ms × MB, the book's
   * minimum billed duration applied to each call.
   */
  onDemand: { requests: bigint; mbMs: bigint };
  /** The same, for calls that ran with minInstances above zero (D8). */
  provisioned: { requests: bigint; mbMs: bigint };
  /** MB-ms of minInstances held: each minute sample's minInstances × MB × 60,000 ms (P-21). */
  provisionedMbMs: bigint;
  /** MB-ms of ready instances above minInstances, from the same samples: what on-demand calls used, or left idle. */
  reservedMbMs: bigint;
}

/** The part of a month that one book prices, in time order. */
export interface BookSegment {
  book: BookPrices;
  functions: FunctionUsage[];
}

export interface FunctionCost {
  requests: Decimal;
  /** On-demand calls at the first tier's price, and calls on provisioned concurrency at theirs. */
  duration: Decimal;
  /** minInstances held. */
  provisioned: Decimal;
  /** D8's knob: instance time above minInstances that no call used. */
  idle: Decimal;
  total: Decimal;
}

/** A month, priced (P-30): exact amounts, which are rounded once, to the currency's minor unit, where shown. */
export interface MonthEstimate {
  /** Each function's cost, at the first duration tier's price, before the free tier. */
  functions: Map<string, FunctionCost>;
  /** All the functions together. */
  usage: Decimal;
  /** What the free tier takes off, zero or less: requests and GB-s of calls without provisioned concurrency. */
  freeTier: Decimal;
  /** What the duration tiers above the first take off, zero or less. */
  volumeTiers: Decimal;
  /** D8's knob: the monthly fee, from the book valid when the month starts, else the month's first. */
  monthlyFee: Decimal;
  total: Decimal;
}

const gbSeconds = (mbMs: bigint) => Decimal.ratio(mbMs, MB_MS_PER_GB_SECOND);

/** How much of [start, end) falls in [low, high), high null for no end. */
function overlap(start: Decimal, end: Decimal, low: Decimal, high: Decimal | null): Decimal {
  const from = start.max(low);
  const to = high === null ? end : end.min(high);
  return to.compare(from) > 0 ? to.minus(from) : Decimal.ZERO;
}

/**
 * An account's month, priced as AWS prices Lambda (D8): requests, on-demand
 * duration in tiers, provisioned concurrency and its duration, and D8's
 * knobs. The free tier and the tiers count the account's on-demand usage
 * from the month's start, through every book's part of the month: a book
 * that starts mid-month prices what follows with the counts reached so far.
 */
export function rateMonth(segments: BookSegment[], feeBook: BookPrices | null): MonthEstimate {
  const functions = new Map<string, FunctionCost>();
  let freeTier = Decimal.ZERO;
  let volumeTiers = Decimal.ZERO;
  let requestsSoFar = Decimal.ZERO;
  let gbSecondsSoFar = Decimal.ZERO;

  for (const { book, functions: usage } of segments) {
    const firstTier = book.gbSecondTiers[0].price;
    let requests = 0n;
    let mbMs = 0n;
    for (const fn of usage) {
      const idleMbMs = fn.reservedMbMs > fn.onDemand.mbMs ? fn.reservedMbMs - fn.onDemand.mbMs : 0n;
      const cost = {
        requests: Decimal.of(fn.onDemand.requests + fn.provisioned.requests).times(book.perRequest),
        duration: gbSeconds(fn.onDemand.mbMs).times(firstTier).plus(gbSeconds(fn.provisioned.mbMs).times(book.provisionedDurationGbSecond)),
        provisioned: gbSeconds(fn.provisionedMbMs).times(book.provisionedGbSecond),
        idle: gbSeconds(idleMbMs).times(book.idleInstanceGbSecond),
      };
      const before = functions.get(fn.functionId);
      const sum = (part: keyof typeof cost) => (before ? before[part].plus(cost[part]) : cost[part]);
      const next = { requests: sum('requests'), duration: sum('duration'), provisioned: sum('provisioned'), idle: sum('idle') };
      functions.set(fn.functionId, { ...next, total: next.requests.plus(next.duration).plus(next.provisioned).plus(next.idle) });
      requests += fn.onDemand.requests;
      mbMs += fn.onDemand.mbMs;
    }

    // The free tier: the month's first requests and GB-s, at this book's prices where they fall.
    const requestsEnd = requestsSoFar.plus(Decimal.of(requests));
    freeTier = freeTier.minus(overlap(requestsSoFar, requestsEnd, Decimal.ZERO, book.freeRequests).times(book.perRequest));
    const gbSecondsEnd = gbSecondsSoFar.plus(gbSeconds(mbMs));
    freeTier = freeTier.minus(overlap(gbSecondsSoFar, gbSecondsEnd, Decimal.ZERO, book.freeGbSeconds).times(firstTier));
    // The tiers: what is billed in each tier above the first costs that tier's price, not the first's.
    let low = Decimal.ZERO;
    for (const tier of book.gbSecondTiers) {
      const inTier = overlap(gbSecondsSoFar, gbSecondsEnd, low, tier.upTo);
      const freeInTier = overlap(gbSecondsSoFar, gbSecondsEnd, low, tier.upTo === null ? book.freeGbSeconds : tier.upTo.min(book.freeGbSeconds));
      volumeTiers = volumeTiers.plus(inTier.minus(freeInTier).times(tier.price.minus(firstTier)));
      if (tier.upTo !== null) low = tier.upTo;
    }
    requestsSoFar = requestsEnd;
    gbSecondsSoFar = gbSecondsEnd;
  }

  const usage = [...functions.values()].reduce((sum, cost) => sum.plus(cost.total), Decimal.ZERO);
  const monthlyFee = feeBook?.monthlyPlanFee ?? Decimal.ZERO;
  return { functions, usage, freeTier, volumeTiers, monthlyFee, total: usage.plus(freeTier).plus(volumeTiers).plus(monthlyFee) };
}
