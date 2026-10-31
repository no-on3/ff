import { MigrationInterface, QueryRunner } from 'typeorm';
import { times } from './1792727200566-DatabaseBilling';

/**
 * AWS's US$ list prices for SES's outbound mail, in US East (N. Virginia), as AWS's price list gave them, read on
 * 2026-10-30: 0.0001 for each recipient of a message (its usage type Recipients), which makes 0.10 per 1,000, and 0.12
 * per GB of attachments (AttachmentsSize-Bytes).
 */
export const EMAIL_USD_PRICES = { emailRecipientsPerThousand: '0.10', emailAttachmentsGb: '0.12' };
/** Where they come from: AWS's price list, when it was published, and the usage types they are read from. */
export const EMAIL_PRICE_LIST = {
  priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSES/current/us-east-1/index.json',
  priceListPublished: '2026-10-27T23:08:24Z',
  readOn: '2026-10-30',
  usageTypes: ['Recipients', 'AttachmentsSize-Bytes'],
};

type Book = { source: Record<string, unknown>; freeTier: Record<string, unknown>; prices: Record<string, unknown> };

/** A book with SES's SKUs, at AWS's US$ prices times its own US$ rate: the rate of the book it copies. No free tier: SES's lasts a new AWS account's first year alone. */
export function withEmailPrices(book: Book): Book {
  const rate = typeof book.source.usdRate === 'string' ? book.source.usdRate : '3.0080';
  const usdPrices = typeof book.source.usdPrices === 'object' && book.source.usdPrices !== null ? book.source.usdPrices : {};
  return {
    ...book,
    source: { ...book.source, usdRate: rate, usdPrices: { ...usdPrices, ...EMAIL_USD_PRICES }, emailPriceList: EMAIL_PRICE_LIST },
    prices: {
      ...book.prices,
      emailRecipientsPerThousand: times(EMAIL_USD_PRICES.emailRecipientsPerThousand, rate),
      emailAttachmentsGb: times(EMAIL_USD_PRICES.emailAttachmentsGb, rate),
    },
  };
}

/** A book's prices without what this migration adds. */
const WITHOUT_EMAIL_PRICES = (prices: string) =>
  `${prices} #- '{prices,emailRecipientsPerThousand}' #- '{prices,emailAttachmentsGb}' #- '{source,usdPrices,emailRecipientsPerThousand}' #- '{source,usdPrices,emailAttachmentsGb}' #- '{source,emailPriceList}'`;

/** The metrics a mail alarm watches, which the code before this migration doesn't know. */
const EMAIL_METRICS = ['Send', 'Delivery', 'Bounce', 'Complaint', 'Reputation.BounceRate', 'Reputation.ComplaintRate'];

/**
 * Customers' mail billed (ADR 0012): each message's billing record, the mail
 * a domain or an address sent in an hour rated beside databases', buckets',
 * queues' and caches', its recipients and its attachments' GB as SES bills
 * them. The columns, keys, indexes and checks are TypeORM's, as the drift
 * check printed them; the rest is not TypeORM's:
 * - email_sends is partitioned by month on when a message was sent, and
 *   append-only through ff_refuse_change(), as usage records are: mail is
 *   billed from it. This month's partition and the next are made here; the
 *   backend makes the next ones ahead.
 * - The book of their prices: every book that hasn't started yet gains SES's
 *   SKUs where it lacks them; and, unless a book starts at the start of next
 *   month (UTC), the book valid then is copied with them from that month's
 *   first hour, so that a month is priced by one set of SKUs from its start.
 *   Until then, books price mail at 0.
 * Down: refused once an hour of mail is rated, as those are billed records;
 * else mail's alarms and the table go, books that haven't started lose SES's
 * SKUs, and the one made here goes.
 */
export class EmailBilling1793345460517 implements MigrationInterface {
  name = 'EmailBilling1793345460517';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_9b5c989c73e24127636088d741"`);
    await queryRunner.query(
      `CREATE TABLE "email_sends" ("message_id" uuid NOT NULL, "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "identity" character varying(320) NOT NULL, "recipients" integer NOT NULL, "attachment_bytes" integer NOT NULL, CONSTRAINT "PK_791920d5f27a7364a6b69083e2b" PRIMARY KEY ("message_id", "sent_at")) PARTITION BY RANGE ("sent_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_b09ab4ae7f0a244a2729181b28" ON "email_sends" ("account_id", "sent_at") `);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD "bytes" bigint NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_9bcd4c64a9be263f74c4b82073" CHECK ("kind" IN ('database', 'bucket', 'queue', 'cache', 'email'))`);
    await queryRunner.query(`CREATE TRIGGER "email_sends_append_only" BEFORE UPDATE OR DELETE ON "email_sends" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "email_sends_no_truncate" BEFORE TRUNCATE ON "email_sends" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('email_sends', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('email_sends', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);

    // Every book that hasn't started yet: SES's SKUs where it lacks them.
    const future = (await queryRunner.query(
      `SELECT "id", "prices" FROM "price_books" WHERE "valid_from" > now() AND NOT ("prices" -> 'prices' ? 'emailRecipientsPerThousand')`,
    )) as Array<{ id: string; prices: Book }>;
    for (const book of future) await queryRunner.query(`UPDATE "price_books" SET "prices" = $2 WHERE "id" = $1`, [book.id, JSON.stringify(withEmailPrices(book.prices))]);
    // Then the book of its own, from next month's first hour, unless one starts then already, which the update above gave the SKUs.
    const [{ next }] = (await queryRunner.query(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "next"`)) as Array<{ next: Date }>;
    const [current] = (await queryRunner.query(
      `SELECT "currency", "prices", "valid_from" = $1 AS "starts_then" FROM "price_books" WHERE "valid_from" <= $1 ORDER BY "valid_from" DESC LIMIT 1`,
      [next],
    )) as Array<{ currency: string; prices: Book; starts_then: boolean }>;
    if (current && !current.starts_then) {
      await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ($1, $2, $3, 'system')`, [
        current.currency,
        next,
        JSON.stringify(withEmailPrices(current.prices)),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ rated }] = (await queryRunner.query(`SELECT count(*)::int AS "rated" FROM "resource_usage_hourly" WHERE "kind" = 'email'`)) as Array<{ rated: number }>;
    if (rated > 0) throw new Error(`${rated} hour(s) of mail were rated: they are billed records, and reverting would drop them`);
    await queryRunner.query(`DELETE FROM "alarms" WHERE "metric" = ANY($1)`, [EMAIL_METRICS]);
    // The book made here: a copy of the one before it, SES's SKUs added. A book that has started can't go (its trigger refuses it).
    await queryRunner.query(
      `DELETE FROM "price_books" b
        WHERE b."valid_from" > now() AND b."created_by" = 'system' AND b."prices" -> 'source' ? 'emailPriceList'
          AND ${WITHOUT_EMAIL_PRICES('b."prices"')} = (SELECT ${WITHOUT_EMAIL_PRICES('p."prices"')} FROM "price_books" p WHERE p."valid_from" < b."valid_from" ORDER BY p."valid_from" DESC LIMIT 1)`,
    );
    await queryRunner.query(`UPDATE "price_books" SET "prices" = ${WITHOUT_EMAIL_PRICES('"prices"')} WHERE "valid_from" > now() AND "prices" -> 'source' ? 'emailPriceList'`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP CONSTRAINT "CHK_9bcd4c64a9be263f74c4b82073"`);
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" DROP COLUMN "bytes"`);
    await queryRunner.query(`DROP TABLE "email_sends"`); // with its partitions, index and triggers
    await queryRunner.query(`ALTER TABLE "resource_usage_hourly" ADD CONSTRAINT "CHK_9b5c989c73e24127636088d741" CHECK ("kind" IN ('database', 'bucket', 'queue', 'cache'))`);
  }
}
