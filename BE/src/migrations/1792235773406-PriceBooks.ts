import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The first price book (D8): AWS Lambda's prices in US East (N. Virginia),
 * x86, on demand, from AWS's price list published 2026-10-16 and read on
 * 2026-10-17, at the BCT's average interbank rate of 2026-10-14, the latest
 * it had published: 1 US$ = 3.0080 TND. Each TND price is the US$ price
 * times that rate, exactly; none is rounded (§4). It applies from the start
 * of the month in which FF began recording usage (P-20).
 */
export const FIRST_PRICE_BOOK = {
  currency: 'TND',
  source: {
    kind: 'aws-lambda',
    region: 'us-east-1',
    architecture: 'x86_64',
    readOn: '2026-10-17',
    priceList: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json',
    priceListPublished: '2026-10-16T18:23:59Z',
    usdPrices: {
      requestsPerMillion: '0.20',
      gbSecond: [
        { upToGbSeconds: 6_000_000_000, price: '0.0000166667' },
        { upToGbSeconds: 15_000_000_000, price: '0.0000150000' },
        { upToGbSeconds: null, price: '0.0000133334' },
      ],
      provisionedGbSecond: '0.0000041667',
      provisionedDurationGbSecond: '0.0000097222',
    },
    usdRate: '3.0080',
    usdRateDate: '2026-10-14',
    usdRateSource: "BCT: cours moyens des devises cotées en dinar tunisien sur le marché des changes interbancaire (www.bct.gov.tn)",
  },
  freeTier: { requests: 1_000_000, gbSeconds: 400_000 },
  prices: {
    requestsPerMillion: '0.6016',
    gbSecond: [
      { upToGbSeconds: 6_000_000_000, price: '0.0000501334336' },
      { upToGbSeconds: 15_000_000_000, price: '0.00004512' },
      { upToGbSeconds: null, price: '0.0000401068672' },
    ],
    provisionedGbSecond: '0.0000125334336',
    provisionedDurationGbSecond: '0.0000292443776',
    minimumBilledMs: 0,
    idleInstanceGbSecond: '0',
    monthlyPlanFee: '0',
  },
};
export const FIRST_PRICE_BOOK_FROM = '2026-10-01T00:00:00Z';

/**
 * P-30 (D8): currencies and price books, as data. The tables, index and
 * foreign key are TypeORM's, as the drift check printed them; the rest is not
 * TypeORM's:
 * - TND, whose minor unit, the millime, is a thousandth;
 * - a book starts in the future, and once started it is never changed or
 *   deleted: past usage keeps the prices it had (D8). A trigger refuses the
 *   rest, and TRUNCATE;
 * - the first book (FIRST_PRICE_BOOK), inserted before that trigger exists;
 * - usage_records.min_instances: whether a call ran on provisioned
 *   concurrency, which D8 prices apart. Records written before have 0.
 * Down: the column and both tables go, books included.
 */
export class PriceBooks1792235773406 implements MigrationInterface {
  name = 'PriceBooks1792235773406';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "currencies" ("code" character(3) NOT NULL, "exponent" smallint NOT NULL, CONSTRAINT "CHK_abd55d5b1e50929c38de8e6ddc" CHECK ("exponent" BETWEEN 0 AND 4), CONSTRAINT "PK_9f8d0972aeeb5a2277e40332d29" PRIMARY KEY ("code"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "price_books" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "currency" character(3) NOT NULL, "valid_from" TIMESTAMP WITH TIME ZONE NOT NULL, "prices" jsonb NOT NULL, "created_by" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e9999c434e93f27e9e3ee547d2d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_65a62fd9f2e2b908f9814f7bf6" ON "price_books" ("valid_from") `);
    await queryRunner.query(`ALTER TABLE "usage_records" ADD "min_instances" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(
      `ALTER TABLE "price_books" ADD CONSTRAINT "FK_260b0b93834a8ff611069628f7e" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`INSERT INTO "currencies" ("code", "exponent") VALUES ('TND', 3)`);
    await queryRunner.query(`INSERT INTO "price_books" ("currency", "valid_from", "prices", "created_by") VALUES ('TND', $1, $2, 'system')`, [
      FIRST_PRICE_BOOK_FROM,
      JSON.stringify(FIRST_PRICE_BOOK),
    ]);

    await queryRunner.query(
      `CREATE FUNCTION "ff_guard_price_book"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP <> 'INSERT' AND OLD."valid_from" <= now() THEN
           RAISE EXCEPTION 'The price book % started on %: it is never changed or deleted, as past usage keeps its prices', OLD."id", OLD."valid_from";
         END IF;
         IF TG_OP <> 'DELETE' AND NEW."valid_from" <= now() THEN
           RAISE EXCEPTION 'A price book starts in the future, not on %: past usage keeps its prices', NEW."valid_from";
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "price_books_guard" BEFORE INSERT OR UPDATE OR DELETE ON "price_books" FOR EACH ROW EXECUTE FUNCTION "ff_guard_price_book"()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "price_books_no_truncate" BEFORE TRUNCATE ON "price_books" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usage_records" DROP COLUMN "min_instances"`);
    await queryRunner.query(`DROP TABLE "price_books"`);
    await queryRunner.query(`DROP FUNCTION "ff_guard_price_book"()`);
    await queryRunner.query(`DROP TABLE "currencies"`);
  }
}
