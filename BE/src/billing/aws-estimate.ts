import { Decimal } from './decimal';
import { PriceDocument, PriceTier, awsSource, readTiers } from './price-book';
import { overlap } from './rating';

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
