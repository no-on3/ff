import { Decimal } from './decimal';
import { BookPrices, PriceDocument, PriceTier, awsSource, readTiers } from './price-book';
import { BYTES_PER_GB, FunctionUsage, ResourceUsage, gbMonths, overlap, rateMonth } from './rating';

/**
 * What AWS bills that FF doesn't, from a book's US$ prices, read once into exact decimals for the estimate at
 * AWS's prices, with AWS's free tier of each month where it has one.
 */
export interface AwsExtraPrices {
  databaseInstanceHour: Decimal;
  cacheNodeHour: Decimal;
  dataOut: PriceTier[];
  freeDataOutGb: Decimal;
  logsIngested: PriceTier[];
  logsStorageGbMonth: Decimal;
  cloudFrontDataOut: PriceTier[];
  freeCloudFrontDataOutGb: Decimal;
  perCloudFrontRequest: Decimal;
  freeCloudFrontRequests: Decimal;
  perCloudFrontFunction: Decimal;
  freeCloudFrontFunctions: Decimal;
  natGatewayHour: Decimal;
  natGatewayGb: Decimal;
  publicIpv4Hour: Decimal;
}

/** A book's prices of what AWS bills that FF doesn't: null for a book without them, which has none of them, as it is checked when made. */
export function awsExtraPrices(document: PriceDocument): AwsExtraPrices | null {
  const source = awsSource(document);
  const free = source?.awsFreeTier;
  const usd = source?.usdPrices;
  if (
    !free ||
    !usd?.databaseInstanceHour ||
    !usd.cacheNodeHour ||
    !usd.dataOutGb ||
    !usd.logsIngestedGb ||
    !usd.logsStorageGbMonth ||
    !usd.cloudFrontDataOutGb ||
    !usd.cloudFrontRequestsPerTenThousand ||
    !usd.cloudFrontFunctionsPerMillion ||
    !usd.natGatewayHour ||
    !usd.natGatewayGb ||
    !usd.publicIpv4Hour
  ) {
    return null;
  }
  const gbTiers = (tiers: Array<{ upToGb: number | null; price: string }>) => readTiers(tiers.map((tier) => ({ upTo: tier.upToGb, price: tier.price })));
  return {
    databaseInstanceHour: Decimal.parse(usd.databaseInstanceHour),
    cacheNodeHour: Decimal.parse(usd.cacheNodeHour),
    dataOut: gbTiers(usd.dataOutGb),
    freeDataOutGb: Decimal.of(free.dataOutGb),
    logsIngested: gbTiers(usd.logsIngestedGb),
    logsStorageGbMonth: Decimal.parse(usd.logsStorageGbMonth),
    cloudFrontDataOut: gbTiers(usd.cloudFrontDataOutGb),
    freeCloudFrontDataOutGb: Decimal.of(free.cloudFrontDataOutGb),
    perCloudFrontRequest: Decimal.parse(usd.cloudFrontRequestsPerTenThousand).times(Decimal.ratio(1n, 10_000n)),
    freeCloudFrontRequests: Decimal.of(free.cloudFrontRequests),
    perCloudFrontFunction: Decimal.parse(usd.cloudFrontFunctionsPerMillion).times(Decimal.ratio(1n, 1_000_000n)),
    freeCloudFrontFunctions: Decimal.of(free.cloudFrontFunctions),
    natGatewayHour: Decimal.parse(usd.natGatewayHour),
    natGatewayGb: Decimal.parse(usd.natGatewayGb),
    publicIpv4Hour: Decimal.parse(usd.publicIpv4Hour),
  };
}

/** A month's use of what AWS bills that FF doesn't, as the estimate draws it from what FF counts. */
export interface ExtraUsage {
  /** Each database's hours in the month, together: an RDS instance each. */
  databaseHours: number;
  /** Each cache's hours, together: an ElastiCache node each. */
  cacheHours: number;
  /** Sent out to the internet, every service together. */
  dataOutGb: Decimal;
  /** Lambda's logs, written and kept. */
  logsIngestedGb: Decimal;
  logsStoredGbMonths: Decimal;
  /** What the sites serve through CloudFront: each request runs the function that answers a folder's path. */
  siteDataOutGb: Decimal;
  siteRequests: bigint;
  /** A NAT gateway's hours, and the GB its functions send through it. */
  natGatewayHours: number;
  natGatewayGb: Decimal;
}

/** Each line of what AWS bills that FF doesn't, in US$. */
export interface ExtraCosts {
  databaseInstances: Decimal;
  cacheNodes: Decimal;
  dataOut: Decimal;
  logs: Decimal;
  cloudFront: Decimal;
  natGateway: Decimal;
}

/**
 * A month of what AWS bills that FF doesn't, line by line: an instance or a
 * node by the hour, a part of an hour billed as a whole one; data out, logs
 * and CloudFront's data out in tiers by the month's GB, AWS's free part first
 * where it gives one (none for Lambda's logs, as CloudWatch's own example of
 * vended logs bills them from the first GB); CloudFront's requests and
 * functions past their free millions; a NAT gateway by the hour with its
 * public IPv4 address, and by the GB through it.
 */
export function extraCosts(prices: AwsExtraPrices, usage: ExtraUsage): ExtraCosts {
  const past = (count: bigint, free: Decimal) => Decimal.of(count).minus(free).max(Decimal.ZERO);
  return {
    databaseInstances: Decimal.of(usage.databaseHours).times(prices.databaseInstanceHour),
    cacheNodes: Decimal.of(usage.cacheHours).times(prices.cacheNodeHour),
    dataOut: tiered(usage.dataOutGb, prices.dataOut, prices.freeDataOutGb),
    logs: tiered(usage.logsIngestedGb, prices.logsIngested).plus(usage.logsStoredGbMonths.times(prices.logsStorageGbMonth)),
    cloudFront: tiered(usage.siteDataOutGb, prices.cloudFrontDataOut, prices.freeCloudFrontDataOutGb)
      .plus(past(usage.siteRequests, prices.freeCloudFrontRequests).times(prices.perCloudFrontRequest))
      .plus(past(usage.siteRequests, prices.freeCloudFrontFunctions).times(prices.perCloudFrontFunction)),
    natGateway: Decimal.of(usage.natGatewayHours)
      .times(prices.natGatewayHour.plus(prices.publicIpv4Hour))
      .plus(usage.natGatewayGb.times(prices.natGatewayGb)),
  };
}

/** What a month's quantity costs in tiers by the month's total, its first `free` units free. */
export function tiered(quantity: Decimal, tiers: PriceTier[], free = Decimal.ZERO): Decimal {
  let cost = Decimal.ZERO;
  let low = Decimal.ZERO;
  for (const tier of tiers) {
    cost = cost.plus(overlap(free, quantity, low, tier.upTo).times(tier.price));
    if (tier.upTo === null) break;
    low = tier.upTo;
  }
  return cost;
}

/** What FF counts, priced at AWS's: Lambda's requests and duration, RDS's storage, S3's, SQS's and SES's. */
export const COUNTED_LINES = ['functions', 'databaseStorage', 'buckets', 'queues', 'mail'] as const;
/** What AWS bills that FF doesn't, each a line the customer can leave out. */
export const EXTRA_LINES = ['coldStarts', 'databaseInstances', 'cacheNodes', 'dataOut', 'logs', 'cloudFront', 'natGateway'] as const;
export type EstimateLine = (typeof COUNTED_LINES)[number] | (typeof EXTRA_LINES)[number];

/** RDS's least storage for an instance, in GB of gp3: AWS bills it whatever the database holds. */
export const RDS_LEAST_STORAGE_GB = 20n;

/** A month of what FF counted, as the estimate at AWS's prices takes it. */
export interface AwsMonthUsage {
  functions: FunctionUsage[];
  /** Each function's start-up time in its calls without provisioned concurrency, in MB-ms: AWS bills it as their duration. */
  initMbMs: Map<string, bigint>;
  resources: ResourceUsage[];
  /** What else the lines that FF doesn't bill draw on: data out, logs, the sites' traffic, a NAT gateway's hours. */
  traffic: Omit<ExtraUsage, 'databaseHours' | 'cacheHours'>;
}

/**
 * A month at AWS's prices, line by line, in exact US$: what FF counts, each
 * service rated alone with AWS's free tier, as AWS's are independent of each
 * other; then what AWS bills that FF doesn't. Cold starts are the duration the
 * calls' start-up time adds, its free tier shared with theirs. A database's
 * instance comes with the storage RDS bills it at least, past what it held.
 */
export function awsMonth(prices: BookPrices, extra: AwsExtraPrices, usage: AwsMonthUsage, hoursInMonth: number): Record<EstimateLine, Decimal> {
  const rate = (functions: FunctionUsage[], resources: ResourceUsage[] = []) => rateMonth([{ book: prices, functions, resources }], prices, hoursInMonth).total;
  const ofKind = (kind: ResourceUsage['kind']) => usage.resources.filter((resource) => resource.kind === kind);
  const hours = (resources: ResourceUsage[]) => Number(resources.reduce((sum, resource) => sum + resource.hours, 0n));
  const databases = ofKind('database');
  const leastStorage = databases.reduce((sum, database) => {
    const short = RDS_LEAST_STORAGE_GB * BYTES_PER_GB * database.hours - database.byteHours;
    return short > 0n ? sum.plus(gbMonths(short, hoursInMonth)) : sum;
  }, Decimal.ZERO);
  const withStartUp = usage.functions.map((fn) => ({ ...fn, onDemand: { ...fn.onDemand, mbMs: fn.onDemand.mbMs + (usage.initMbMs.get(fn.functionId) ?? 0n) } }));
  const functions = rate(usage.functions);
  const lines = extraCosts(extra, { ...usage.traffic, databaseHours: hours(databases), cacheHours: hours(ofKind('cache')) });
  return {
    functions,
    databaseStorage: rate([], databases),
    buckets: rate([], ofKind('bucket')),
    queues: rate([], ofKind('queue')),
    mail: rate([], ofKind('email')),
    coldStarts: rate(withStartUp).minus(functions),
    databaseInstances: lines.databaseInstances.plus(leastStorage.times(prices.databaseStorageGbMonth)),
    cacheNodes: lines.cacheNodes,
    dataOut: lines.dataOut,
    logs: lines.logs,
    cloudFront: lines.cloudFront,
    natGateway: lines.natGateway,
  };
}

/** Each line's name, as AWS bills it, and, for what AWS bills that FF doesn't, what the estimate assumes: logs are kept `logDays`. */
export function lineText(line: EstimateLine, logDays: number): { label: string; assumption: string | null } {
  const texts: Record<EstimateLine, [string, string | null]> = {
    functions: ['AWS Lambda: requests and duration', null],
    databaseStorage: ["RDS for PostgreSQL: the databases' gp3 storage", null],
    buckets: ['S3 Standard: storage and requests', null],
    queues: ['SQS: requests', null],
    mail: ['SES: recipients and attachments', null],
    coldStarts: [
      "AWS Lambda: the calls' start-up time",
      "AWS bills a cold start's INIT phase as duration since August 2025, at the duration's prices; FF counts each one and bills none of it",
    ],
    databaseInstances: [
      'RDS for PostgreSQL: a db.t4g.micro for each database',
      "The smallest instance, in one zone, for each database's hours, with the 20 GB of gp3 storage RDS bills at least",
    ],
    cacheNodes: ['ElastiCache for Valkey: a cache.t4g.micro for each cache', "The smallest node, for each cache's hours: AWS bills nodes, not the memory a cache holds"],
    dataOut: ['Data out to the internet', "What the buckets sent out, as FF counts it, past AWS's free 100 GB a month; FF doesn't count what functions answer"],
    logs: [
      "CloudWatch Logs: Lambda's logs",
      `About 1 KB a call, Lambda's own lines and a few of the function's, kept ${logDays} days as the plan keeps them; FF doesn't count logs' bytes, and CloudWatch keeps them for ever unless their log group's retention says otherwise`,
    ],
    cloudFront: [
      'CloudFront: the sites',
      "A distribution in front of each site, its viewers in Europe: the sites' bytes and requests as FF counts them, each request running the function that answers a folder's path",
    ],
    natGateway: [
      'A NAT gateway',
      "One, with its public IPv4 address, for each hour the account had a database or a cache: its functions then run in a VPC, which reaches the internet and AWS's other services through it; FF doesn't count the GB through it",
    ],
  };
  const [label, assumption] = texts[line];
  return { label, assumption };
}

/** What the estimate assumes of logs, as FF counts none of their bytes: 1 KB a call. */
export const LOG_BYTES_PER_CALL = 1_024n;

/** A month's logs of `calls` calls, kept `keptDays` of the month's `daysInMonth`: the GB written, and the GB-months kept. */
export function logsOf(calls: bigint, keptDays: number, daysInMonth: number): { ingestedGb: Decimal; storedGbMonths: Decimal } {
  const bytes = calls * LOG_BYTES_PER_CALL;
  return {
    ingestedGb: Decimal.ratio(bytes, BYTES_PER_GB),
    storedGbMonths: Decimal.quotient(bytes * BigInt(Math.min(keptDays, daysInMonth)), BYTES_PER_GB * BigInt(daysInMonth), 12),
  };
}
