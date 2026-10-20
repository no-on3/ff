import { MigrationInterface, QueryRunner } from 'typeorm';

const RATING_TABLES = ['usage_hourly', 'usage_charges', 'rating_runs'];

/**
 * P-32 (D9): the hourly rating. The tables, the index and the foreign keys
 * are TypeORM's, as the drift check printed them:
 * - usage_hourly: each function's hour of usage, as the rater takes it;
 * - usage_charges: each account's charge for an hour, debited or, in shadow
 *   mode, only recorded;
 * - rating_runs: the hours rated.
 * Price books start at a whole hour, UTC, so the rating prices each hour with
 * one book: a book that doesn't is named, and the migration stops.
 * The rest is not TypeORM's: P-17's ff_refuse_change() on the three tables,
 * which are written once.
 * Down: the tables go, with what they hold, and books may start within an hour again.
 */
export class Rating1792241835410 implements MigrationInterface {
  name = 'Rating1792241835410';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const offHour = (await queryRunner.query(
      `SELECT "id", "valid_from" FROM "price_books" WHERE extract(epoch FROM "valid_from") % 3600 <> 0 ORDER BY "valid_from"`,
    )) as Array<{ id: string; valid_from: Date }>;
    if (offHour.length > 0) {
      const books = offHour.map((book) => `${book.id} (${book.valid_from.toISOString()})`).join(', ');
      throw new Error(`Price books must start at a whole hour, UTC, for the hourly rating (P-32), and these don't: ${books}. Remove a book that hasn't started, or ask how to replace one that has.`);
    }
    await queryRunner.query(
      `CREATE TABLE "rating_runs" ("hour" TIMESTAMP WITH TIME ZONE NOT NULL, "accounts" integer NOT NULL, "shadow" boolean NOT NULL, "rated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d5af000343f9f944a3984927234" PRIMARY KEY ("hour"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "usage_charges" ("account_id" character(12) NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "currency" character(3) NOT NULL, "amount_minor" bigint NOT NULL, "month_to_date_minor" bigint NOT NULL, "shadow" boolean NOT NULL, "ledger_transaction_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8ffa0bcd5e1b6575395378af519" PRIMARY KEY ("account_id", "hour"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_008176676f34bfa825a3ea5b28" ON "usage_charges" ("ledger_transaction_id") `);
    await queryRunner.query(
      `CREATE TABLE "usage_hourly" ("account_id" character(12) NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "function_id" uuid NOT NULL, "price_book_id" uuid NOT NULL, "on_demand_requests" bigint NOT NULL, "on_demand_mb_ms" bigint NOT NULL, "provisioned_requests" bigint NOT NULL, "provisioned_mb_ms" bigint NOT NULL, "provisioned_time_mb_ms" bigint NOT NULL, "reserved_mb_ms" bigint NOT NULL, CONSTRAINT "PK_73b04f681a3c9ebdb3def5d34d8" PRIMARY KEY ("account_id", "hour", "function_id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_cb1b77d72b68d29c8d38dc2f30" ON "usage_hourly" ("hour") `);
    await queryRunner.query(`ALTER TABLE "price_books" ADD CONSTRAINT "CHK_5a13cd731572683e9fd9da6cad" CHECK (extract(epoch FROM "valid_from") % 3600 = 0)`);
    await queryRunner.query(
      `ALTER TABLE "usage_charges" ADD CONSTRAINT "FK_12b3b772558653c3d7b81cbaede" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "usage_charges" ADD CONSTRAINT "FK_887e37cd346183a962b8ed47843" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "usage_charges" ADD CONSTRAINT "FK_008176676f34bfa825a3ea5b28e" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "usage_hourly" ADD CONSTRAINT "FK_7a14160c5c0255f248aa208b9db" FOREIGN KEY ("price_book_id") REFERENCES "price_books"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    for (const table of RATING_TABLES) {
      await queryRunner.query(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "usage_hourly"`);
    await queryRunner.query(`DROP TABLE "usage_charges"`);
    await queryRunner.query(`DROP TABLE "rating_runs"`);
    await queryRunner.query(`ALTER TABLE "price_books" DROP CONSTRAINT "CHK_5a13cd731572683e9fd9da6cad"`);
  }
}
