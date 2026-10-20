import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-33 (D9): the balance check and the low-balance e-mails. TypeORM's part, as
 * the drift check printed it: the owners' shares for the e-mails on accounts,
 * and low_balance_notices, the e-mails sent. The rest is not TypeORM's:
 * - ff_notify_ledger(): after a wallet's entry, NOTIFY ff_ledger with the
 *   account's ID. PostgreSQL delivers it when the transaction commits, and
 *   never if it rolls back, to every backend that LISTENs: each refreshes its
 *   cached balance, whoever wrote, the services or SQL by hand;
 * - P-17's ff_refuse_change() on low_balance_notices, written once.
 * Down: the e-mails sent and the owners' shares go.
 */
export class CreditControls1792244277487 implements MigrationInterface {
  name = 'CreditControls1792244277487';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "low_balance_notices" ("account_id" character(12) NOT NULL, "credit_transaction_id" uuid NOT NULL, "percent" smallint NOT NULL, "balance_minor" bigint NOT NULL, "notified_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_73c8976380fabc6cae223c341d2" PRIMARY KEY ("account_id", "credit_transaction_id", "percent"))`,
    );
    await queryRunner.query(`ALTER TABLE "accounts" ADD "low_balance_percents" integer array`);
    await queryRunner.query(
      `ALTER TABLE "low_balance_notices" ADD CONSTRAINT "FK_1599ff734a0ba6a15b2fbcfab8f" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "low_balance_notices" ADD CONSTRAINT "FK_536a187eb4e94f14b90a4a93ca4" FOREIGN KEY ("credit_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`CREATE TRIGGER "low_balance_notices_append_only" BEFORE UPDATE OR DELETE ON "low_balance_notices" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "low_balance_notices_no_truncate" BEFORE TRUNCATE ON "low_balance_notices" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(
      `CREATE FUNCTION "ff_notify_ledger"() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE
         account char(12);
       BEGIN
         SELECT "account_id" INTO account FROM "ledger_accounts" WHERE "id" = NEW."ledger_account_id";
         IF account IS NOT NULL THEN
           PERFORM pg_notify('ff_ledger', account);
         END IF;
         RETURN NULL;
       END $$`,
    );
    await queryRunner.query(`CREATE TRIGGER "ledger_entries_notify" AFTER INSERT ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION "ff_notify_ledger"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "ledger_entries_notify" ON "ledger_entries"`);
    await queryRunner.query(`DROP FUNCTION "ff_notify_ledger"()`);
    await queryRunner.query(`DROP TABLE "low_balance_notices"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "low_balance_percents"`);
  }
}
