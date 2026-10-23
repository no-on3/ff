import { MigrationInterface, QueryRunner } from 'typeorm';

/** AWS's US$ list prices for customers' databases and buckets, in US East (N. Virginia), as AWS's price lists gave them, read on 2026-10-23. */
export const STORAGE_USD_PRICES = {
  // RDS for PostgreSQL, gp3 storage, Single-AZ ("RDS:GP3-Storage"), per GB-month.
  databaseStorageGbMonth: '0.115',
  // S3 Standard ("TimedStorage-ByteHrs"), per GB-month, by the account's GB-months: first 50 TB, next 450 TB, over 500 TB.
  bucketStorageGbMonth: [
    { upToGbMonths: 51_200, price: '0.023' },
    { upToGbMonths: 512_000, price: '0.022' },
    { upToGbMonths: null, price: '0.021' },
  ],
  // S3's requests, per 1,000: PUT, COPY, POST and LIST ("Requests-Tier1"); GET and all the others ("Requests-Tier2").
  requestsTier1PerThousand: '0.005',
  requestsTier2PerThousand: '0.0004',
};
/** Where they come from: AWS's price lists, and when each was published. */
export const STORAGE_PRICE_LISTS = {
  rds: {
    priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json',
    priceListPublished: '2026-10-20T00:32:32Z',
    readOn: '2026-10-23',
  },
  s3: {
    priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json',
    priceListPublished: '2026-10-15T17:35:40Z',
    readOn: '2026-10-23',
  },
};
/**
 * The free tier of each month, per account, as you confirmed on 2026-10-22: 1 GB-month of
 * databases; 5 GB-months of buckets, 20,000 GET and 2,000 PUT requests, as AWS's first year, here every month.
 */
export const STORAGE_FREE_TIER = { databaseStorageGbMonths: 1, bucketStorageGbMonths: 5, requestsTier1: 2_000, requestsTier2: 20_000 };

/** The exact product of two decimals written as strings, without trailing zeros: no float ever prices anything. */
export function times(a: string, b: string): string {
  const scale = (text: string) => {
    const [whole, fraction = ''] = text.split('.');
    return { value: BigInt(whole + fraction), places: fraction.length };
  };
  const x = scale(a);
  const y = scale(b);
  const places = x.places + y.places;
  const digits = (x.value * y.value).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

type Book = { source: Record<string, unknown>; freeTier: Record<string, unknown>; prices: Record<string, unknown> };

/** A book with databases' and buckets' SKUs, at AWS's US$ prices times its own US$ rate: the rate of the book it copies. */
export function withStoragePrices(book: Book): Book {
  const rate = typeof book.source.usdRate === 'string' ? book.source.usdRate : '3.0080';
  const usdPrices = typeof book.source.usdPrices === 'object' && book.source.usdPrices !== null ? book.source.usdPrices : {};
  return {
    ...book,
    source: { ...book.source, usdRate: rate, usdPrices: { ...usdPrices, ...STORAGE_USD_PRICES }, storagePriceLists: STORAGE_PRICE_LISTS },
    freeTier: { ...book.freeTier, ...STORAGE_FREE_TIER },
    prices: {
      ...book.prices,
      databaseStorageGbMonth: times(STORAGE_USD_PRICES.databaseStorageGbMonth, rate),
      databaseMonthlyFee: '0',
      bucketStorageGbMonth: STORAGE_USD_PRICES.bucketStorageGbMonth.map((tier) => ({ ...tier, price: times(tier.price, rate) })),
      requestsTier1PerThousand: times(STORAGE_USD_PRICES.requestsTier1PerThousand, rate),
      requestsTier2PerThousand: times(STORAGE_USD_PRICES.requestsTier2PerThousand, rate),
    },
  };
}

/**
 * Customers' databases billed (ADR 0008): their hourly
 * samples, the rated hours of databases and buckets beside usage_hourly's
 * functions, and the notice a database's owners were last sent of its
 * storage. The columns, keys, indexes and foreign key are TypeORM's, as the
 * drift check printed them; the rest is not TypeORM's:
 * - database_samples is partitioned by month on its hour, and both tables are
 *   append-only through ff_refuse_change(), as capacity samples and
 *   usage_hourly are: the bill is priced from them. This month's partition
 *   and the next are made here; the backend makes the next ones ahead.
 * - The book of their prices: the book valid at the start of next month (UTC),
 *   copied with databases' and buckets' SKUs at AWS's list prices times its own US$ rate, and
 *   the free tier you confirmed, from that month's first hour, so that a month
 *   is priced by one set of SKUs from its start; and every book that hasn't
 *   started yet gains the same SKUs where it lacks them. Until then, books
 *   price databases and buckets at 0.
 * Down: both tables and the column go; the book, if it hasn't started, goes too.
 */
export class DatabaseBilling1792727200566 implements MigrationInterface {
  name = 'DatabaseBilling1792727200566';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "database_samples" ("database_id" uuid NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "name" text NOT NULL, "size_bytes" bigint NOT NULL, "connections" integer NOT NULL, CONSTRAINT "PK_89ab1e518f3e365db65d996d1b3" PRIMARY KEY ("database_id", "hour")) PARTITION BY RANGE ("hour")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_c529494b71a46680bbef4d04f8" ON "database_samples" ("account_id", "hour") `);
    await queryRunner.query(
      `CREATE TABLE "resource_usage_hourly" ("account_id" character(12) NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "resource_id" uuid NOT NULL, "kind" text NOT NULL, "name" text NOT NULL, "price_book_id" uuid NOT NULL, "byte_hours" bigint NOT NULL, "hours" smallint NOT NULL, "tier1_requests" bigint NOT NULL, "tier2_requests" bigint NOT NULL, CONSTRAINT "CHK_9e23550b83153b21a3066569de" CHECK ("kind" IN ('database', 'bucket')), CONSTRAINT "PK_ab531edb63c6347f609f41c7b34" PRIMARY KEY ("account_id", "hour", "resource_id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_45e7fb1d64fc5c7b0923a95b20" ON "resource_usage_hourly" ("hour") `);
    await queryRunner.query(`ALTER TABLE "databases" ADD "storage_notice" smallint`);
    await queryRunner.query(`ALTER TABLE "databases" ADD CONSTRAINT "CHK_3dc62e5e32ac666eae970f642a" CHECK ("storage_notice" IN (80, 100))`);
    await queryRunner.query(
      `ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "FK_361b313e4dfb02e8d8fe6ff6679" FOREIGN KEY ("price_book_id") REFERENCES "price_books"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    for (const table of ['database_samples', 'resource_usage_hourly']) {
      await queryRunner.query(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    }
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('database_samples', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('database_samples', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);

    // Every book that hasn't started yet: databases' and buckets' SKUs where it lacks them.
    const future = (await queryRunner.query(`SELECT "id", "prices" FROM "price_books" WHERE "valid_from" > now() AND NOT ("prices" -> 'prices' ? 'databaseStorageGbMonth')`)) as Array<{
      id: string;
      prices: Book;
    }>;
    for (const book of future) await queryRunner.query(`UPDATE "price_books" SET "prices" = $2 WHERE "id" = $1`, [book.id, JSON.stringify(withStoragePrices(book.prices))]);
    // Then the book of their own, from next month's first hour, unless one starts then already, which the update above gave the SKUs.
    const [{ next }] = (await queryRunner.query(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "next"`)) as Array<{ next: Date }>;
    const [current] = (await queryRunner.query(
      `SELECT "currency", "prices", "valid_from" = $1 AS "starts_then" FROM "price_books" WHERE "valid_from" <= $1 ORDER BY "valid_from" DESC LIMIT 1`,
      [next],
    )) as Array<{ currency: string; prices: Book; starts_then: boolean }>;
    if (current && !current.starts_then) {
      await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ($1, $2, $3, 'system')`, [
        current.currency,
        next,
        JSON.stringify(withStoragePrices(current.prices)),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A book that has started can't go (its trigger refuses it): the usage it priced keeps it.
    await queryRunner.query(`DELETE FROM "price_books" WHERE "valid_from" > now() AND "created_by" = 'system' AND "prices" -> 'source' ? 'storagePriceLists'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "FK_361b313e4dfb02e8d8fe6ff6679"`);
    await queryRunner.query(`ALTER TABLE "databases" DROP CONSTRAINT "CHK_3dc62e5e32ac666eae970f642a"`);
    await queryRunner.query(`ALTER TABLE "databases" DROP COLUMN "storage_notice"`);
    await queryRunner.query(`DROP TABLE "resource_usage_hourly"`);
    await queryRunner.query(`DROP TABLE "database_samples"`); // with its partitions, index and triggers
  }
}
