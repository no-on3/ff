import { MigrationInterface, QueryRunner } from 'typeorm';
import { times } from './1792727200566-DatabaseBilling';

/**
 * AWS's US$ list prices for SQS's standard queues, in US East (N. Virginia), as AWS's price list gave them, read on
 * 2026-10-24: per million requests, by the account's requests in the month: the first 100 billion, the next 100
 * billion, past 200 billion.
 */
export const QUEUE_USD_PRICES = {
  queueRequestsPerMillion: [
    { upToRequests: 100_000_000_000, price: '0.40' },
    { upToRequests: 200_000_000_000, price: '0.30' },
    { upToRequests: null, price: '0.24' },
  ],
};
/** Where they come from: AWS's price list, and when it was published. */
export const QUEUE_PRICE_LIST = {
  priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.json',
  priceListPublished: '2026-09-11T12:46:07Z',
  readOn: '2026-10-24',
};
/** SQS's free tier, as AWS gives it every month: the first million requests. */
export const QUEUE_FREE_TIER = { queueRequests: 1_000_000 };

type Book = { source: Record<string, unknown>; freeTier: Record<string, unknown>; prices: Record<string, unknown> };

/** A book with SQS's SKU, at AWS's US$ prices times its own US$ rate: the rate of the book it copies. */
export function withQueuePrices(book: Book): Book {
  const rate = typeof book.source.usdRate === 'string' ? book.source.usdRate : '3.0080';
  const usdPrices = typeof book.source.usdPrices === 'object' && book.source.usdPrices !== null ? book.source.usdPrices : {};
  return {
    ...book,
    source: { ...book.source, usdRate: rate, usdPrices: { ...usdPrices, ...QUEUE_USD_PRICES }, queuePriceList: QUEUE_PRICE_LIST },
    freeTier: { ...book.freeTier, ...QUEUE_FREE_TIER },
    prices: { ...book.prices, queueRequestsPerMillion: QUEUE_USD_PRICES.queueRequestsPerMillion.map((tier) => ({ ...tier, price: times(tier.price, rate) })) },
  };
}

/** A book's prices without what this migration adds. */
const WITHOUT_QUEUE_PRICES = (prices: string) => `${prices} #- '{prices,queueRequestsPerMillion}' #- '{freeTier,queueRequests}' #- '{source,usdPrices,queueRequestsPerMillion}' #- '{source,queuePriceList}'`;

/**
 * Customers' queues billed (ADR 0010): their requests, counted a minute at a
 * time, a row per queue, minute and writer; a queue's hour rated beside
 * databases' and buckets', its requests as SQS bills them. The columns, keys,
 * indexes and checks are TypeORM's, as the drift check printed them; the rest
 * is not TypeORM's:
 * - queue_request_counts is partitioned by month on its minute, and
 *   append-only through ff_refuse_change(), as buckets' request counts are:
 *   queues' requests are billed from it. This month's partition and the next
 *   are made here; the backend makes the next ones ahead.
 * - The book of their prices: every book that hasn't started yet gains SQS's
 *   SKU and its free tier where it lacks them; and, unless a book starts at
 *   the start of next month (UTC), the book valid then is copied with them
 *   from that month's first hour, so that a month is priced by one set of
 *   SKUs from its start. Until then, books price queues at 0.
 * Down: refused once a queue's hour is rated, as those are billed records;
 * else the table and the column go, books that haven't started lose SQS's
 * SKU, and the one made here goes.
 */
export class QueueBilling1792816013937 implements MigrationInterface {
  name = 'QueueBilling1792816013937';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_9e23550b83153b21a3066569de"`);
    await queryRunner.query(
      `CREATE TABLE "queue_request_counts" ("queue_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "writer" uuid NOT NULL, "account_id" character(12) NOT NULL, "name" text NOT NULL, "requests" integer NOT NULL, "sent" integer NOT NULL, "received" integer NOT NULL, "deleted" integer NOT NULL, "empty_receives" integer NOT NULL, "sent_bytes" bigint NOT NULL, "sent_max_bytes" integer NOT NULL, CONSTRAINT "PK_4faff973b44a48f156813091d00" PRIMARY KEY ("queue_id", "minute", "writer")) PARTITION BY RANGE ("minute")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_7fd0d14bdaf67f70a6cf286fd7" ON "queue_request_counts" ("account_id", "minute") `);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD "requests" bigint NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_6e4ae204cc0c7d5480f10ccf58" CHECK ("kind" IN ('database', 'bucket', 'queue'))`);
    await queryRunner.query(`CREATE TRIGGER "queue_request_counts_append_only" BEFORE UPDATE OR DELETE ON "queue_request_counts" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "queue_request_counts_no_truncate" BEFORE TRUNCATE ON "queue_request_counts" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('queue_request_counts', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('queue_request_counts', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);

    // Every book that hasn't started yet: SQS's SKU where it lacks it.
    const future = (await queryRunner.query(`SELECT "id", "prices" FROM "price_books" WHERE "valid_from" > now() AND NOT ("prices" -> 'prices' ? 'queueRequestsPerMillion')`)) as Array<{
      id: string;
      prices: Book;
    }>;
    for (const book of future) await queryRunner.query(`UPDATE "price_books" SET "prices" = $2 WHERE "id" = $1`, [book.id, JSON.stringify(withQueuePrices(book.prices))]);
    // Then the book of their own, from next month's first hour, unless one starts then already, which the update above gave the SKU.
    const [{ next }] = (await queryRunner.query(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "next"`)) as Array<{ next: Date }>;
    const [current] = (await queryRunner.query(
      `SELECT "currency", "prices", "valid_from" = $1 AS "starts_then" FROM "price_books" WHERE "valid_from" <= $1 ORDER BY "valid_from" DESC LIMIT 1`,
      [next],
    )) as Array<{ currency: string; prices: Book; starts_then: boolean }>;
    if (current && !current.starts_then) {
      await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ($1, $2, $3, 'system')`, [
        current.currency,
        next,
        JSON.stringify(withQueuePrices(current.prices)),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ rated }] = (await queryRunner.query(`SELECT count(*)::int AS "rated" FROM "resource_usage_hourly" WHERE "kind" = 'queue'`)) as Array<{ rated: number }>;
    if (rated > 0) throw new Error(`${rated} hour(s) of queues were rated: they are billed records, and reverting would drop them`);
    // The book made here: a copy of the one before it, SQS's SKU added. A book that has started can't go (its trigger refuses it).
    await queryRunner.query(
      `DELETE FROM "price_books" b
        WHERE b."valid_from" > now() AND b."created_by" = 'system' AND b."prices" -> 'source' ? 'queuePriceList'
          AND ${WITHOUT_QUEUE_PRICES('b."prices"')} = (SELECT ${WITHOUT_QUEUE_PRICES('p."prices"')} FROM "price_books" p WHERE p."valid_from" < b."valid_from" ORDER BY p."valid_from" DESC LIMIT 1)`,
    );
    await queryRunner.query(`UPDATE "price_books" SET "prices" = ${WITHOUT_QUEUE_PRICES('"prices"')} WHERE "valid_from" > now() AND "prices" -> 'source' ? 'queuePriceList'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_6e4ae204cc0c7d5480f10ccf58"`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP COLUMN "requests"`);
    await queryRunner.query(`DROP TABLE "queue_request_counts"`); // with its partitions, index and triggers
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_9e23550b83153b21a3066569de" CHECK ((kind = ANY (ARRAY['database'::text, 'bucket'::text])))`);
  }
}
