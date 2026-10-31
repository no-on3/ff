import { MigrationInterface, QueryRunner } from 'typeorm';
import { times } from './1792727200566-DatabaseBilling';

/**
 * AWS's US$ list price for ElastiCache for Valkey, in US East (N. Virginia), as AWS's price list gave it, read on
 * 2026-10-30: its smallest node, cache.t4g.micro, 0.0128 an hour for 0.5 GiB of memory, which makes 0.0256 per GB-hour
 * of a cache's memory.
 */
export const CACHE_USD_PRICES = { cacheGbHour: '0.0256' };
/** Where it comes from: AWS's price list, when it was published, and the node it is read from. */
export const CACHE_PRICE_LIST = {
  priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/us-east-1/index.json',
  priceListPublished: '2026-10-28T19:24:50Z',
  readOn: '2026-10-30',
  node: 'cache.t4g.micro',
};

type Book = { source: Record<string, unknown>; freeTier: Record<string, unknown>; prices: Record<string, unknown> };

/** A book with ElastiCache's SKU, at AWS's US$ price times its own US$ rate: the rate of the book it copies. No free tier: ElastiCache has none every month. */
export function withCachePrices(book: Book): Book {
  const rate = typeof book.source.usdRate === 'string' ? book.source.usdRate : '3.0080';
  const usdPrices = typeof book.source.usdPrices === 'object' && book.source.usdPrices !== null ? book.source.usdPrices : {};
  return {
    ...book,
    source: { ...book.source, usdRate: rate, usdPrices: { ...usdPrices, ...CACHE_USD_PRICES }, cachePriceList: CACHE_PRICE_LIST },
    prices: { ...book.prices, cacheGbHour: times(CACHE_USD_PRICES.cacheGbHour, rate) },
  };
}

/** A book's prices without what this migration adds. */
const WITHOUT_CACHE_PRICES = (prices: string) => `${prices} #- '{prices,cacheGbHour}' #- '{source,usdPrices,cacheGbHour}' #- '{source,cachePriceList}'`;

/** The metrics a cache's alarm watches, which the code before this migration doesn't know. */
const CACHE_METRICS = ['BytesUsedForCache', 'CurrConnections', 'CacheHits', 'CacheMisses', 'Evictions'];

/**
 * Customers' caches measured and billed (ADR 0013): their hourly samples, a
 * cache's hour rated beside databases', buckets' and queues', its memory by
 * the GB-hour as ElastiCache bills a node, and alarms on its metrics, which go
 * with it. The columns, keys, indexes and checks are TypeORM's, as the drift
 * check printed them; the rest is not TypeORM's:
 * - cache_samples is partitioned by month on its hour, and append-only
 *   through ff_refuse_change(), as databases' samples are: caches are billed
 *   from it. This month's partition and the next are made here; the backend
 *   makes the next ones ahead.
 * - The book of their price: every book that hasn't started yet gains
 *   ElastiCache's SKU where it lacks it; and, unless a book starts at the
 *   start of next month (UTC), the book valid then is copied with it from that
 *   month's first hour, so that a month is priced by one set of SKUs from its
 *   start. Until then, books price caches at 0.
 * Down: refused once a cache's hour is rated, as those are billed records;
 * else caches' alarms and the table go, books that haven't started lose
 * ElastiCache's SKU, and the one made here goes.
 */
export class CacheMeasures1793333328301 implements MigrationInterface {
  name = 'CacheMeasures1793333328301';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_6e4ae204cc0c7d5480f10ccf58"`);
    await queryRunner.query(
      `CREATE TABLE "cache_samples" ("cache_id" uuid NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "name" text NOT NULL, "memory_mb" integer NOT NULL, "bytes_used" bigint NOT NULL, "connections" integer NOT NULL, "hits" bigint NOT NULL, "misses" bigint NOT NULL, "evictions" bigint NOT NULL, "process_started_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_eb4986a5564794d23259a2d3c81" PRIMARY KEY ("cache_id", "hour")) PARTITION BY RANGE ("hour")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_20dbf054bef78b642c75efe336" ON "cache_samples" ("account_id", "hour") `);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_9b5c989c73e24127636088d741" CHECK ("kind" IN ('database', 'bucket', 'queue', 'cache'))`);
    await queryRunner.query(`CREATE TRIGGER "cache_samples_append_only" BEFORE UPDATE OR DELETE ON "cache_samples" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "cache_samples_no_truncate" BEFORE TRUNCATE ON "cache_samples" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('cache_samples', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('cache_samples', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);
    await queryRunner.query(`ALTER TABLE "alarms" ADD "cache_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_4ce17059654d86eb7516daf3b6" ON "alarms" ("cache_id") `);
    await queryRunner.query(`ALTER TABLE "alarms" ADD CONSTRAINT "FK_4ce17059654d86eb7516daf3b6a" FOREIGN KEY ("cache_id") REFERENCES "caches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // Every book that hasn't started yet: ElastiCache's SKU where it lacks it.
    const future = (await queryRunner.query(`SELECT "id", "prices" FROM "price_books" WHERE "valid_from" > now() AND NOT ("prices" -> 'prices' ? 'cacheGbHour')`)) as Array<{
      id: string;
      prices: Book;
    }>;
    for (const book of future) await queryRunner.query(`UPDATE "price_books" SET "prices" = $2 WHERE "id" = $1`, [book.id, JSON.stringify(withCachePrices(book.prices))]);
    // Then the book of its own, from next month's first hour, unless one starts then already, which the update above gave the SKU.
    const [{ next }] = (await queryRunner.query(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "next"`)) as Array<{ next: Date }>;
    const [current] = (await queryRunner.query(
      `SELECT "currency", "prices", "valid_from" = $1 AS "starts_then" FROM "price_books" WHERE "valid_from" <= $1 ORDER BY "valid_from" DESC LIMIT 1`,
      [next],
    )) as Array<{ currency: string; prices: Book; starts_then: boolean }>;
    if (current && !current.starts_then) {
      await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ($1, $2, $3, 'system')`, [
        current.currency,
        next,
        JSON.stringify(withCachePrices(current.prices)),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ rated }] = (await queryRunner.query(`SELECT count(*)::int AS "rated" FROM "resource_usage_hourly" WHERE "kind" = 'cache'`)) as Array<{ rated: number }>;
    if (rated > 0) throw new Error(`${rated} hour(s) of caches were rated: they are billed records, and reverting would drop them`);
    await queryRunner.query(`DELETE FROM "alarms" WHERE "cache_id" IS NOT NULL OR "metric" = ANY($1)`, [CACHE_METRICS]);
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_4ce17059654d86eb7516daf3b6a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_4ce17059654d86eb7516daf3b6"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "cache_id"`);
    // The book made here: a copy of the one before it, ElastiCache's SKU added. A book that has started can't go (its trigger refuses it).
    await queryRunner.query(
      `DELETE FROM "price_books" b
        WHERE b."valid_from" > now() AND b."created_by" = 'system' AND b."prices" -> 'source' ? 'cachePriceList'
          AND ${WITHOUT_CACHE_PRICES('b."prices"')} = (SELECT ${WITHOUT_CACHE_PRICES('p."prices"')} FROM "price_books" p WHERE p."valid_from" < b."valid_from" ORDER BY p."valid_from" DESC LIMIT 1)`,
    );
    await queryRunner.query(`UPDATE "price_books" SET "prices" = ${WITHOUT_CACHE_PRICES('"prices"')} WHERE "valid_from" > now() AND "prices" -> 'source' ? 'cachePriceList'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_9b5c989c73e24127636088d741"`);
    await queryRunner.query(`DROP TABLE "cache_samples"`); // with its partitions, index and triggers
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_6e4ae204cc0c7d5480f10ccf58" CHECK ("kind" IN ('database', 'bucket', 'queue'))`);
  }
}
