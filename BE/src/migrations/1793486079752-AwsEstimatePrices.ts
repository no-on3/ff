import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What AWS bills that FF doesn't, at AWS's US$ list prices in US East (N. Virginia), as AWS's price lists gave them,
 * read on 2026-10-31: for the estimate of an account's usage at AWS's prices, which FF bills none of.
 */
export const ESTIMATE_USD_PRICES = {
  // RDS for PostgreSQL's db.t4g.micro, Single-AZ ("InstanceUsage:db.t4g.micro"), an hour or part of one.
  databaseInstanceHour: '0.016',
  // ElastiCache for Valkey's cache.t4g.micro ("NodeUsage:cache.t4g.micro"), an hour or part of one.
  cacheNodeHour: '0.0128',
  // Data out to the internet ("DataTransfer-Out-Bytes"), per GB, by the account's GB in the month: the first 10 TB, the next 40, the next 100, past 150.
  dataOutGb: [
    { upToGb: 10_240, price: '0.09' },
    { upToGb: 51_200, price: '0.085' },
    { upToGb: 153_600, price: '0.07' },
    { upToGb: null, price: '0.05' },
  ],
  // Lambda's logs, CloudWatch Logs' vended logs in the Standard class ("USE1-VendedLog-Bytes"), per GB, by the month's: the first 10 TB, the next 20, the next 20, past 50.
  logsIngestedGb: [
    { upToGb: 10_240, price: '0.50' },
    { upToGb: 30_720, price: '0.25' },
    { upToGb: 51_200, price: '0.10' },
    { upToGb: null, price: '0.05' },
  ],
  // Logs kept ("TimedStorage-ByteHrs"), per GB-month.
  logsStorageGbMonth: '0.03',
  // CloudFront, its viewers in Europe: data out ("EU-DataTransfer-Out-Bytes") per GB, by the month's, from the first 10 TB to past 5 PB.
  cloudFrontDataOutGb: [
    { upToGb: 10_240, price: '0.085' },
    { upToGb: 51_200, price: '0.080' },
    { upToGb: 153_600, price: '0.060' },
    { upToGb: 512_000, price: '0.040' },
    { upToGb: 1_048_576, price: '0.030' },
    { upToGb: 5_242_880, price: '0.025' },
    { upToGb: null, price: '0.020' },
  ],
  // HTTPS requests ("EU-Requests-Tier2-HTTPS"), per 10,000; CloudFront Functions ("Executions-CloudFrontFunctions"), per million.
  cloudFrontRequestsPerTenThousand: '0.0120',
  cloudFrontFunctionsPerMillion: '0.10',
  // A NAT gateway ("NatGateway-Hours", "NatGateway-Bytes"), an hour and per GB through it; its public IPv4 address ("USE1-PublicIPv4:InUseAddress"), an hour.
  natGatewayHour: '0.045',
  natGatewayGb: '0.045',
  publicIpv4Hour: '0.005',
};

/**
 * The free tier AWS gives every account every month, from AWS's pages on 2026-10-31: Lambda's million requests and
 * 400,000 GB-seconds, its start-up time billed among them; SQS's million requests; 100 GB of data out, every service
 * together; CloudFront's 1 TB out, 10 million requests and 2 million functions. An account made since 15 July 2025 has
 * credits instead of the first year's free tiers of S3, RDS, ElastiCache and SES, which the estimate counts as none.
 */
export const AWS_FREE_TIER = {
  requests: 1_000_000,
  gbSeconds: 400_000,
  queueRequests: 1_000_000,
  dataOutGb: 100,
  cloudFrontDataOutGb: 1_024,
  cloudFrontRequests: 10_000_000,
  cloudFrontFunctions: 2_000_000,
};

const list = (service: string, priceListPublished: string, usageTypes: string[], region = 'us-east-1/') => ({
  priceList: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}index.json`,
  priceListPublished,
  readOn: '2026-10-31',
  usageTypes,
});
/** Where they come from: AWS's price lists, when each was published, and the usage types read. CloudFront's is global. */
export const ESTIMATE_PRICE_LISTS = [
  list('AmazonRDS', '2026-10-29T07:06:35Z', ['InstanceUsage:db.t4g.micro']),
  list('AmazonElastiCache', '2026-10-28T19:24:50Z', ['NodeUsage:cache.t4g.micro']),
  list('AWSDataTransfer', '2026-09-16T13:22:08Z', ['DataTransfer-Out-Bytes']),
  list('AmazonCloudWatch', '2026-10-07T11:55:40Z', ['USE1-VendedLog-Bytes', 'TimedStorage-ByteHrs']),
  list('AmazonCloudFront', '2026-10-19T15:05:00Z', ['EU-DataTransfer-Out-Bytes', 'EU-Requests-Tier2-HTTPS', 'Executions-CloudFrontFunctions'], ''),
  list('AmazonEC2', '2026-10-29T17:56:34Z', ['NatGateway-Hours', 'NatGateway-Bytes']),
  list('AmazonVPC', '2026-10-16T22:43:21Z', ['USE1-PublicIPv4:InUseAddress']),
];

type Book = { source: Record<string, unknown>; freeTier: Record<string, unknown>; prices: Record<string, unknown> };

/** A book of AWS's prices with what AWS bills that FF doesn't, AWS's free tier and their price lists; a book of other prices as it is. */
export function withEstimatePrices(book: Book): Book {
  if (book.source.kind !== 'aws-lambda') return book;
  const usdPrices = typeof book.source.usdPrices === 'object' && book.source.usdPrices !== null ? book.source.usdPrices : {};
  return {
    ...book,
    source: { ...book.source, usdPrices: { ...usdPrices, ...ESTIMATE_USD_PRICES }, awsFreeTier: AWS_FREE_TIER, estimatePriceLists: ESTIMATE_PRICE_LISTS },
  };
}

/** A book's prices without what this migration adds. */
const WITHOUT_ESTIMATE_PRICES = (prices: string) =>
  [`${prices} #- '{source,awsFreeTier}' #- '{source,estimatePriceLists}'`, ...Object.keys(ESTIMATE_USD_PRICES).map((key) => `#- '{source,usdPrices,${key}}'`)].join(' ');

/**
 * What AWS bills that FF doesn't, in the books, for the estimate at AWS's
 * prices: every book of AWS's prices that hasn't started yet gains it
 * where it lacks it, with AWS's free tier and the price lists; and, unless a
 * book starts at the start of next month (UTC), the book valid then is copied
 * with it from that month's first hour, as the other prices came, since a
 * started book never changes. FF bills none of it: no book's TND prices change.
 * Down: books that haven't started lose it, and the one made here goes.
 */
export class AwsEstimatePrices1793486079752 implements MigrationInterface {
  name = 'AwsEstimatePrices1793486079752';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const future = (await queryRunner.query(
      `SELECT "id", "prices" FROM "price_books" WHERE "valid_from" > now() AND "prices" -> 'source' ->> 'kind' = 'aws-lambda' AND NOT ("prices" -> 'source' ? 'estimatePriceLists')`,
    )) as Array<{ id: string; prices: Book }>;
    for (const book of future) await queryRunner.query(`UPDATE "price_books" SET "prices" = $2 WHERE "id" = $1`, [book.id, JSON.stringify(withEstimatePrices(book.prices))]);
    // Then the book of its own, from next month's first hour, unless one starts then already, or the one valid then has it already.
    const [{ next }] = (await queryRunner.query(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "next"`)) as Array<{ next: Date }>;
    const [current] = (await queryRunner.query(
      `SELECT "currency", "prices", "valid_from" = $1 AS "starts_then" FROM "price_books" WHERE "valid_from" <= $1 ORDER BY "valid_from" DESC LIMIT 1`,
      [next],
    )) as Array<{ currency: string; prices: Book; starts_then: boolean }>;
    if (current && !current.starts_then && current.prices.source.kind === 'aws-lambda' && current.prices.source.estimatePriceLists === undefined) {
      await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ($1, $2, $3, 'system')`, [
        current.currency,
        next,
        JSON.stringify(withEstimatePrices(current.prices)),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The book made here: a copy of the one before it, with what this migration adds. A book that has started can't go (its trigger refuses it).
    await queryRunner.query(
      `DELETE FROM "price_books" b
        WHERE b."valid_from" > now() AND b."created_by" = 'system' AND b."prices" -> 'source' ? 'estimatePriceLists'
          AND ${WITHOUT_ESTIMATE_PRICES('b."prices"')} = (SELECT ${WITHOUT_ESTIMATE_PRICES('p."prices"')} FROM "price_books" p WHERE p."valid_from" < b."valid_from" ORDER BY p."valid_from" DESC LIMIT 1)`,
    );
    await queryRunner.query(`UPDATE "price_books" SET "prices" = ${WITHOUT_ESTIMATE_PRICES('"prices"')} WHERE "valid_from" > now() AND "prices" -> 'source' ? 'estimatePriceLists'`);
  }
}
