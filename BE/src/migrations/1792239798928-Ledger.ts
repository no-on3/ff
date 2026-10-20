import { MigrationInterface, QueryRunner } from 'typeorm';

const LEDGER_TABLES = ['ledger_accounts', 'ledger_transactions', 'ledger_entries'];

/**
 * P-31 (D9, parent §8.3): the double-entry ledger. The tables, checks,
 * indexes and foreign keys are TypeORM's, as the drift check printed them;
 * the rest is not TypeORM's:
 * - ff_check_ledger_transaction(), as a constraint trigger deferred to the
 *   commit, on both entries and transactions: a transaction has two entries
 *   at least, and they sum to zero in each currency. A transaction written
 *   without them fails when it commits, with nothing written;
 * - P-17's ff_refuse_change() on the three tables: nothing in the ledger is
 *   updated, deleted or emptied. A correction is another transaction.
 * Down: the tables and the function go, entries included.
 */
export class Ledger1792239798928 implements MigrationInterface {
  name = 'Ledger1792239798928';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ledger_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12), "type" text NOT NULL, "currency" character(3) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_25ae85b34ccb14e5800275a383" CHECK (("type" = 'wallet') = ("account_id" IS NOT NULL)), CONSTRAINT "CHK_a8fd4d6fdf98ca7c3517408e3a" CHECK ("type" IN ('wallet', 'revenue', 'vat_payable', 'stamp_duty', 'provider_clearing', 'promotional_credit')), CONSTRAINT "PK_62b34396dda564757cf123fff0e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_409fa3ff0a4f21c75210a34535" ON "ledger_accounts" ("type", "currency") WHERE "account_id" IS NULL`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_66e2dda294e71e1b2f79f8507e" ON "ledger_accounts" ("account_id", "type", "currency") WHERE "account_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "ledger_transactions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "kind" text NOT NULL, "idempotency_key" text NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "metadata" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_660df08008e40037f6404b2416" CHECK ("kind" IN ('topup', 'usage', 'invoice', 'payment', 'refund', 'promo', 'adjustment', 'withholding')), CONSTRAINT "PK_633d103c9e415d615aacf9b1929" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_01ff7d3a76be6b7ca5fd33761d" ON "ledger_transactions" ("idempotency_key") `);
    await queryRunner.query(
      `CREATE TABLE "ledger_entries" ("id" BIGSERIAL NOT NULL, "transaction_id" uuid NOT NULL, "ledger_account_id" uuid NOT NULL, "amount_minor" bigint NOT NULL, CONSTRAINT "CHK_ea1d94a5b8e97541332cb6f3ef" CHECK ("amount_minor" <> 0), CONSTRAINT "PK_6efcb84411d3f08b08450ae75d5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_b26c5ef5853fd6e0a8680427f6" ON "ledger_entries" ("transaction_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_827f3a9861711976024144e27c" ON "ledger_entries" ("ledger_account_id") `);
    await queryRunner.query(
      `ALTER TABLE "ledger_accounts" ADD CONSTRAINT "FK_ec97af2f458879c28f9868bc012" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_accounts" ADD CONSTRAINT "FK_9d1c4cbf0bfa2059204df523078" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "FK_b26c5ef5853fd6e0a8680427f60" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "FK_827f3a9861711976024144e27c7" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE FUNCTION "ff_check_ledger_transaction"() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE
         tx uuid;
         unbalanced record;
       BEGIN
         -- Each assignment is parsed only when it runs: NEW has no transaction_id on ledger_transactions.
         IF TG_TABLE_NAME = 'ledger_entries' THEN
           tx := NEW."transaction_id";
         ELSE
           tx := NEW."id";
         END IF;
         IF (SELECT count(*) FROM "ledger_entries" WHERE "transaction_id" = tx) < 2 THEN
           RAISE EXCEPTION 'Ledger transaction % has fewer than two entries', tx USING ERRCODE = 'check_violation';
         END IF;
         SELECT a."currency", sum(e."amount_minor") AS "total" INTO unbalanced
           FROM "ledger_entries" e JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
          WHERE e."transaction_id" = tx
          GROUP BY a."currency" HAVING sum(e."amount_minor") <> 0
          ORDER BY a."currency"
          LIMIT 1;
         IF FOUND THEN
           RAISE EXCEPTION 'Ledger transaction % does not sum to zero: % minor units of % left over', tx, unbalanced."total", unbalanced."currency"
             USING ERRCODE = 'check_violation';
         END IF;
         RETURN NULL;
       END $$`,
    );
    for (const table of ['ledger_entries', 'ledger_transactions']) {
      await queryRunner.query(
        `CREATE CONSTRAINT TRIGGER "${table}_balanced" AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ff_check_ledger_transaction"()`,
      );
    }
    for (const table of LEDGER_TABLES) {
      await queryRunner.query(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP TABLE "ledger_transactions"`);
    await queryRunner.query(`DROP TABLE "ledger_accounts"`);
    await queryRunner.query(`DROP FUNCTION "ff_check_ledger_transaction"()`);
  }
}
