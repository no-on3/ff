/**
 * L1: the estimate at AWS's prices, from the book as its migration gives
 * it AWS's US$ prices and free tier. AWS's own examples, from its pricing
 * pages, priced by FF equal the same months worked by hand; where a page's
 * example and AWS's price list disagree, the price list's tiers and prices,
 * as AWS bills them.
 */
import { FIRST_PRICE_BOOK } from '../migrations/1792235773406-PriceBooks';
import { withStoragePrices } from '../migrations/1792727200566-DatabaseBilling';
import { withQueuePrices } from '../migrations/1792816013937-QueueBilling';
import { withCachePrices } from '../migrations/1793333328301-CacheMeasures';
import { withEmailPrices } from '../migrations/1793345460517-EmailBilling';
import { withEstimatePrices } from '../migrations/1793486079752-AwsEstimatePrices';
import { AwsExtraPrices, ExtraCosts, ExtraUsage, awsExtraPrices, extraCosts, tiered } from './aws-estimate';
import { Decimal } from './decimal';
import { BookPrices, awsBookPrices, priceDocumentSchema, readTiers } from './price-book';
import { ResourceUsage, rateMonth } from './rating';

const d = (text: string) => Decimal.parse(text);
/** The latest book, as the migrations make it: every SKU, and what AWS bills that FF doesn't. */
const LATEST = priceDocumentSchema.parse(withEstimatePrices(withEmailPrices(withCachePrices(withQueuePrices(withStoragePrices(FIRST_PRICE_BOOK))))));
const AT_AWS = awsBookPrices({ id: 'latest', validFrom: new Date('2026-11-01T00:00:00Z'), prices: LATEST }) as BookPrices;
const PRICES = awsExtraPrices(LATEST) as AwsExtraPrices;
const NONE: ExtraUsage = {
  databaseHours: 0,
  cacheHours: 0,
  dataOutGb: Decimal.ZERO,
  logsIngestedGb: Decimal.ZERO,
  logsStoredGbMonths: Decimal.ZERO,
  siteDataOutGb: Decimal.ZERO,
  siteRequests: 0n,
  natGatewayHours: 0,
  natGatewayGb: Decimal.ZERO,
};
/** Each line's cost, as text, for a month of `usage`, at `prices`. */
const costs = (usage: Partial<ExtraUsage>, prices = PRICES): Record<keyof ExtraCosts, string> => {
  const lines = extraCosts(prices, { ...NONE, ...usage });
  return Object.fromEntries(Object.entries(lines).map(([line, cost]) => [line, cost.toString()])) as Record<keyof ExtraCosts, string>;
};
const GIB = 1_073_741_824n;

describe("the estimate at AWS's prices (L1)", () => {
  it("prices Lambda's own example at AWS's US$ prices with AWS's free tier: the mobile backend, $2.73", () => {
    // AWS's Lambda pricing page: 3 million requests of 120 ms at 1,536 MB: (540,000 GB-s − 400,000 free) × $0.0000166667
    // = $2.33, and (3M − 1M free) × $0.20 per million = $0.40: $2.73.
    const calls = { functionId: 'backend', onDemand: { requests: 3_000_000n, mbMs: 3_000_000n * 120n * 1536n }, provisioned: { requests: 0n, mbMs: 0n }, provisionedMbMs: 0n, reservedMbMs: 0n };
    const month = rateMonth([{ book: AT_AWS, functions: [calls] }], AT_AWS);

    expect([month.total.toString(), month.total.toFixed(2)]).toEqual(['2.733338', '2.73']);
  });

  it("prices a database's storage and a month's mail as AWS does, without FF's free tier, FF's knobs or a cache's memory, which AWS bills as a node", () => {
    const resource = (resourceId: string, kind: ResourceUsage['kind'], parts: Partial<ResourceUsage>): ResourceUsage => ({
      resourceId,
      kind,
      byteHours: 0n,
      hours: 0n,
      tier1Requests: 0n,
      tier2Requests: 0n,
      requests: 0n,
      bytes: 0n,
      ...parts,
    });
    // A month of 720 hours: a database of 1 GB through it, a cache of 512 MB, and 2,000 recipients of mail.
    const month = rateMonth(
      [
        {
          book: AT_AWS,
          functions: [],
          resources: [
            resource('orders', 'database', { byteHours: GIB * 720n, hours: 720n }),
            resource('sessions', 'cache', { byteHours: (GIB / 2n) * 720n, hours: 720n }),
            resource('shop.example.tn', 'email', { requests: 2_000n }),
          ],
        },
      ],
      AT_AWS,
      720,
    );

    // RDS's gp3 storage, 1 GB-month × $0.115, which FF's free GB-month leaves free; SES's 2,000 recipients × $0.10 per 1,000.
    expect(month.total.toString()).toBe('0.315');
    expect([AT_AWS.minimumBilledMs, AT_AWS.monthlyPlanFee.toString(), AT_AWS.databaseMonthlyFee.toString(), AT_AWS.cacheGbHour.toString()]).toEqual([0, '0', '0', '0']);
  });

  it("has no AWS prices for a book that records neither what AWS bills that FF doesn't nor AWS's free tier", () => {
    const first = priceDocumentSchema.parse(FIRST_PRICE_BOOK);

    expect([awsBookPrices({ id: 'first', validFrom: new Date('2026-10-01T00:00:00Z'), prices: first }), awsExtraPrices(first)]).toEqual([null, null]);
  });

  it("prices an RDS instance and an ElastiCache node by the hour, as ElastiCache's own example prices a cluster's nodes", () => {
    // A month of 730 hours, as AWS's calculator counts one: $0.016 and $0.0128 an hour.
    expect(costs({ databaseHours: 730, cacheHours: 730 })).toMatchObject({ databaseInstances: '11.68', cacheNodes: '9.344' });
    // ElastiCache's pricing page, its second example: twelve cache.r7g.xlarge nodes at $0.3496, an hour: $4.1952.
    expect(costs({ cacheHours: 12 }, { ...PRICES, cacheNodeHour: d('0.3496') }).cacheNodes).toBe('4.1952');
  });

  it('prices data out past the free 100 GB, in tiers by the month\'s GB', () => {
    expect([costs({ dataOutGb: d('100') }).dataOut, costs({ dataOutGb: d('150') }).dataOut]).toEqual(['0', '4.5']);
    // 61,540 GB: 10,140 GB past the free 100 at $0.09, the next 40,960 at $0.085, and 10,340 at $0.07: $912.60 + $3,481.60 + $723.80.
    expect(costs({ dataOutGb: d('61540') }).dataOut).toBe('5118');
  });

  it("prices Lambda's logs as CloudWatch's own example prices vended logs: 72 TB delivered and 30 TB kept, $14,336", () => {
    // CloudWatch's pricing page, its third example: 10 TB at $0.50, 20 TB at $0.25, 20 TB at $0.10 and 22 TB at $0.05, a TB
    // being 1,024 GB: $13,414.40; and 30 TB kept at $0.03 per GB-month: $921.60. No free tier: the example takes none off.
    expect(costs({ logsIngestedGb: d('73728'), logsStoredGbMonths: d('30720') }).logs).toBe('14336');
  });

  it("prices a site through CloudFront in Europe: within the free tier, as CloudFront's own static site, and past it", () => {
    // CloudFront's pricing page, its first example: 100 GB out and a million HTTPS requests, within the free 1 TB and 10
    // million; a function for each request, within the free 2 million. (The page's own runs two a request; the export's
    // site runs one, which answers a folder's path.)
    expect(costs({ siteDataOutGb: d('100'), siteRequests: 1_000_000n }).cloudFront).toBe('0');
    // Its third example's traffic, 20,000 GB out and 200 million HTTPS requests, from Europe's edges: 9,216 GB past the free
    // 1,024 at $0.085 and 9,760 at $0.080, $1,564.16; 190 million requests at $0.0120 per 10,000, $228; 198 million
    // functions at $0.10 per million, $19.80. (The page prices its US traffic as 19,000 GB at $0.085, a TB taken as 1,000
    // GB and its own 10 TB tier left out.)
    expect(costs({ siteDataOutGb: d('20000'), siteRequests: 200_000_000n }).cloudFront).toBe('1811.96');
  });

  it("prices a NAT gateway as the VPC page's own examples do, with its public IPv4 address, which the page prices apart", () => {
    // The VPC pricing page, its first example: a NAT gateway for an hour, and 1 GB through it: $0.045 and $0.045; its
    // address, $0.005 an hour.
    expect(costs({ natGatewayHours: 1, natGatewayGb: d('1') }).natGateway).toBe('0.095');
    // Its second: a NAT gateway in three zones for an hour, 1 GB through it and out to the internet, past the free 100 GB:
    // $0.135 + $0.045 + $0.09 = $0.27, and the zones' three addresses, $0.015.
    const regional = costs({ natGatewayHours: 3, natGatewayGb: d('1'), dataOutGb: d('101') });
    expect([regional.natGateway, regional.dataOut]).toEqual(['0.195', '0.09']);
  });

  it('takes the free part off first, then prices each tier to where it ends', () => {
    const tiers = readTiers([
      { upTo: 10, price: '1' },
      { upTo: 30, price: '0.5' },
      { upTo: null, price: '0.25' },
    ]);

    expect([d('4'), d('10'), d('25'), d('50')].map((quantity) => tiered(quantity, tiers, d('5')).toString())).toEqual(['0', '5', '12.5', '20']);
    expect(tiered(d('50'), tiers).toString()).toBe('25');
  });
});
