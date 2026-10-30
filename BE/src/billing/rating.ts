import { Decimal } from './decimal';
import { BookPrices } from './price-book';

/** MB-ms per GB-second: 1,024 MB × 1,000 ms (D7). */
const MB_MS_PER_GB_SECOND = 1_024_000n;
/** Bytes in a GB, as AWS bills storage: 2^30. */
export const BYTES_PER_GB = 1_073_741_824n;
/**
 * GB-months are byte-hours over a GB and the month's hours, which have no
 * finite decimal form (744 = 2³ × 3 × 31): so the quantity is rounded, to a
 * millionth of a millionth of a GB-month, and the amounts priced from it are
 * exact, and rounded once, as the others are.
 */
const GB_MONTH_PLACES = 12;

/** Byte-hours in GB-months, over a month's hours, as the rater counts them. */
export const gbMonths = (byteHours: bigint, hoursInMonth: number): Decimal => Decimal.quotient(byteHours, BYTES_PER_GB * BigInt(hoursInMonth), GB_MONTH_PLACES);

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

/**
 * One customer's database's, bucket's, queue's or cache's usage in the part of
 * a month that one book prices (ADR 0008, ADR 0009, ADR 0010, ADR 0013): a
 * database's or a bucket's size summed over the hours sampled, which over the
 * month's hours make its GB-months, as AWS bills storage; a bucket's requests
 * by S3's two classes; a queue's requests, as SQS bills them; a cache's memory
 * summed over the hours sampled, its GB-hours, as ElastiCache bills a node.
 * And the mail one of its domains or addresses sent (ADR 0012): its messages'
 * recipients, and their attachments, each recipient's copy, as SES bills them.
 */
export interface ResourceUsage {
  resourceId: string;
  kind: 'database' | 'bucket' | 'queue' | 'cache' | 'email';
  /** Bytes held, summed over the hours sampled: a cache's memory, its plan's, whatever its keys use. */
  byteHours: bigint;
  /** The hours it was sampled in: a database's monthly fee is prorated by them. */
  hours: bigint;
  tier1Requests: bigint;
  tier2Requests: bigint;
  /** A queue's requests, each 64 KB of a request's messages one; mail's recipients, each message's; 0 for the others. */
  requests: bigint;
  /** Mail's attachments sent, each recipient's copy; 0 for the others. */
  bytes: bigint;
}

/** The part of a month that one book prices, in time order. */
export interface BookSegment {
  book: BookPrices;
  functions: FunctionUsage[];
  /** Customers' databases, buckets and queues, if the account has any. */
  resources?: ResourceUsage[];
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

/**
 * A database's, a bucket's, a queue's or a cache's cost, before the free tier: storage and SQS's requests at their
 * first tier's price, S3's requests, a database's fee; a cache's memory by the GB-hour, as its storage. Mail's
 * recipients, as its requests, and its attachments by the GB, as its storage.
 */
export interface ResourceCost {
  kind: 'database' | 'bucket' | 'queue' | 'cache' | 'email';
  /** Its GB-months: byte-hours over the month's hours. */
  gbMonths: Decimal;
  storage: Decimal;
  requests: Decimal;
  fee: Decimal;
  total: Decimal;
}

/** A month, priced (P-30): exact amounts, which are rounded once, to the currency's minor unit, where shown. */
export interface MonthEstimate {
  /** Each function's cost, at the first duration tier's price, before the free tier. */
  functions: Map<string, FunctionCost>;
  /** Each database's, bucket's and queue's cost, before the free tier. */
  resources: Map<string, ResourceCost>;
  /** All the functions, databases, buckets and queues together. */
  usage: Decimal;
  /** What the free tier takes off, zero or less: requests and GB-s of calls without provisioned concurrency, databases' and buckets' GB-months, S3's requests, SQS's. */
  freeTier: Decimal;
  /** What the duration tiers above the first take off, and those of S3 Standard's storage and SQS's requests above their first, zero or less. */
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

/** What lies in [low, high) of `tiers` between `from` and `to` of the month's quantity, priced above the first tier, the free part left out. */
function aboveFirstTier(from: Decimal, to: Decimal, tiers: Array<{ upTo: Decimal | null; price: Decimal }>, free: Decimal): Decimal {
  let extra = Decimal.ZERO;
  let low = Decimal.ZERO;
  const first = tiers[0].price;
  for (const tier of tiers) {
    const inTier = overlap(from, to, low, tier.upTo);
    const freeInTier = overlap(from, to, low, tier.upTo === null ? free : tier.upTo.min(free));
    extra = extra.plus(inTier.minus(freeInTier).times(tier.price.minus(first)));
    if (tier.upTo !== null) low = tier.upTo;
  }
  return extra;
}

/**
 * An account's month, priced as AWS prices Lambda (D8): requests, on-demand
 * duration in tiers, provisioned concurrency and its duration, and D8's
 * knobs; and, as RDS, S3, SQS and ElastiCache price them, its databases'
 * and buckets' storage by the GB-month, over `hoursInMonth`, S3's requests by
 * its two classes, a database's monthly fee by the hours it existed, its
 * queues' requests by the million, in tiers, and its caches' memory by the
 * GB-hour; as SES prices it, its mail by the recipient, and its attachments
 * by the GB, without a free tier. The free tier and the tiers count the
 * account's usage from the month's start, through every book's part of the
 * month: a book that starts mid-month prices what follows with the counts
 * reached so far.
 */
export function rateMonth(segments: BookSegment[], feeBook: BookPrices | null, hoursInMonth = 0): MonthEstimate {
  const functions = new Map<string, FunctionCost>();
  const resources = new Map<string, ResourceCost>();
  let freeTier = Decimal.ZERO;
  let volumeTiers = Decimal.ZERO;
  let requestsSoFar = Decimal.ZERO;
  let gbSecondsSoFar = Decimal.ZERO;
  let databaseGbMonthsSoFar = Decimal.ZERO;
  let bucketGbMonthsSoFar = Decimal.ZERO;
  let tier1SoFar = Decimal.ZERO;
  let tier2SoFar = Decimal.ZERO;
  let queueRequestsSoFar = Decimal.ZERO;

  for (const { book, functions: usage, resources: held = [] } of segments) {
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
    volumeTiers = volumeTiers.plus(aboveFirstTier(gbSecondsSoFar, gbSecondsEnd, book.gbSecondTiers, book.freeGbSeconds));
    requestsSoFar = requestsEnd;
    gbSecondsSoFar = gbSecondsEnd;

    // Databases and buckets: storage by the GB-month, at the first tier's price; S3's requests; a database's fee by its hours.
    // Queues: SQS's requests, at the first tier's price. Caches: their memory by the GB-hour, without a free tier. Mail:
    // its recipients and its attachments' GB, without one either.
    if (held.length > 0 && hoursInMonth <= 0) throw new Error("A month's hours are needed to price storage by the GB-month");
    let databaseGbMonths = Decimal.ZERO;
    let bucketGbMonths = Decimal.ZERO;
    let tier1 = 0n;
    let tier2 = 0n;
    let queueRequests = 0n;
    for (const resource of held) {
      const stored = gbMonths(resource.byteHours, hoursInMonth);
      const database = resource.kind === 'database';
      const mail = resource.kind === 'email';
      // A cache's memory, by the hour, as ElastiCache bills a node: its GB-hours at the book's price. Mail's attachments by the GB.
      const memory = resource.kind === 'cache' ? Decimal.quotient(resource.byteHours, BYTES_PER_GB, GB_MONTH_PLACES).times(book.cacheGbHour) : null;
      const attachments = mail ? Decimal.quotient(resource.bytes, BYTES_PER_GB, GB_MONTH_PLACES).times(book.emailAttachmentsGb) : null;
      const cost = {
        gbMonths: stored,
        storage: attachments ?? memory ?? stored.times(database ? book.databaseStorageGbMonth : book.bucketStorageTiers[0].price),
        requests: mail
          ? Decimal.of(resource.requests).times(book.perEmailRecipient)
          : Decimal.of(resource.tier1Requests)
              .times(book.perTier1Request)
              .plus(Decimal.of(resource.tier2Requests).times(book.perTier2Request))
              .plus(Decimal.of(resource.requests).times(book.queueRequestTiers[0].price)),
        fee: database ? Decimal.quotient(resource.hours, BigInt(hoursInMonth), GB_MONTH_PLACES).times(book.databaseMonthlyFee) : Decimal.ZERO,
      };
      const before = resources.get(resource.resourceId);
      const sum = (part: keyof typeof cost) => (before ? before[part].plus(cost[part]) : cost[part]);
      const next = { gbMonths: sum('gbMonths'), storage: sum('storage'), requests: sum('requests'), fee: sum('fee') };
      resources.set(resource.resourceId, { kind: resource.kind, ...next, total: next.storage.plus(next.requests).plus(next.fee) });
      if (database) databaseGbMonths = databaseGbMonths.plus(stored);
      else if (resource.kind === 'bucket') bucketGbMonths = bucketGbMonths.plus(stored);
      tier1 += resource.tier1Requests;
      tier2 += resource.tier2Requests;
      if (!mail) queueRequests += resource.requests;
    }
    const databaseEnd = databaseGbMonthsSoFar.plus(databaseGbMonths);
    freeTier = freeTier.minus(overlap(databaseGbMonthsSoFar, databaseEnd, Decimal.ZERO, book.freeDatabaseGbMonths).times(book.databaseStorageGbMonth));
    const bucketEnd = bucketGbMonthsSoFar.plus(bucketGbMonths);
    freeTier = freeTier.minus(overlap(bucketGbMonthsSoFar, bucketEnd, Decimal.ZERO, book.freeBucketGbMonths).times(book.bucketStorageTiers[0].price));
    volumeTiers = volumeTiers.plus(aboveFirstTier(bucketGbMonthsSoFar, bucketEnd, book.bucketStorageTiers, book.freeBucketGbMonths));
    const tier1End = tier1SoFar.plus(Decimal.of(tier1));
    freeTier = freeTier.minus(overlap(tier1SoFar, tier1End, Decimal.ZERO, book.freeTier1Requests).times(book.perTier1Request));
    const tier2End = tier2SoFar.plus(Decimal.of(tier2));
    freeTier = freeTier.minus(overlap(tier2SoFar, tier2End, Decimal.ZERO, book.freeTier2Requests).times(book.perTier2Request));
    const queueEnd = queueRequestsSoFar.plus(Decimal.of(queueRequests));
    freeTier = freeTier.minus(overlap(queueRequestsSoFar, queueEnd, Decimal.ZERO, book.freeQueueRequests).times(book.queueRequestTiers[0].price));
    volumeTiers = volumeTiers.plus(aboveFirstTier(queueRequestsSoFar, queueEnd, book.queueRequestTiers, book.freeQueueRequests));
    databaseGbMonthsSoFar = databaseEnd;
    bucketGbMonthsSoFar = bucketEnd;
    tier1SoFar = tier1End;
    tier2SoFar = tier2End;
    queueRequestsSoFar = queueEnd;
  }

  const usage = [...functions.values(), ...resources.values()].reduce((sum, cost) => sum.plus(cost.total), Decimal.ZERO);
  const monthlyFee = feeBook?.monthlyPlanFee ?? Decimal.ZERO;
  return { functions, resources, usage, freeTier, volumeTiers, monthlyFee, total: usage.plus(freeTier).plus(volumeTiers).plus(monthlyFee) };
}

/** The hours of a month by the UTC calendar (YYYY-MM): 672 to 744, by which GB-months divide byte-hours. */
export function hoursIn(month: string): number {
  const [year, number] = month.split('-').map(Number);
  return (Date.UTC(year, number, 1) - Date.UTC(year, number - 1, 1)) / 3_600_000;
}
