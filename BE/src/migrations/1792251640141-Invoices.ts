import { MigrationInterface, QueryRunner } from 'typeorm';

/** Written once, never changed: P-17's ff_refuse_change() refuses UPDATE, DELETE and TRUNCATE. */
const APPEND_ONLY = ['tax_rates', 'invoices', 'invoice_lines', 'invoice_notices'];

/**
 * P-36 (D9; parent §8.6, Appendix E): monthly invoices. TypeORM's, as the
 * drift check printed it:
 * - tax_rates: VAT and stamp duty, each from the day it applies;
 * - invoices and invoice_lines: an issued invoice or credit note, with its
 *   lines, a payment invoiced once;
 * - invoice_counters: the last number of each series and fiscal year;
 * - invoice_notices: the operator's e-mails about a month's invoices.
 * The rest is not TypeORM's: the rates in force today, as the parent plan
 * gives them, and ff_refuse_change() on every table but the counters.
 * Down: refused while an invoice exists, as issued invoices are legal records.
 */
export class Invoices1792251640141 implements MigrationInterface {
  name = 'Invoices1792251640141';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tax_rates" ("kind" text NOT NULL, "valid_from" date NOT NULL, "percent" smallint, "amount_minor" bigint, "currency" character(3), "source" text NOT NULL, CONSTRAINT "CHK_6b946ca9d7c8227ab8bfa772ff" CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0), CONSTRAINT "CHK_47ff68ca1edc3f77955f975ed4" CHECK ("percent" IS NULL OR "percent" BETWEEN 0 AND 100), CONSTRAINT "CHK_b73d1e325159bd9dc5e9bd2d40" CHECK (("kind" = 'stamp_duty') = ("percent" IS NULL AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL)), CONSTRAINT "CHK_b3dd53c4d51b83b7271d90219d" CHECK (("kind" = 'vat') = ("percent" IS NOT NULL AND "amount_minor" IS NULL AND "currency" IS NULL)), CONSTRAINT "CHK_199dba9e3483aceec56ce167e6" CHECK ("kind" IN ('vat', 'stamp_duty')), CONSTRAINT "PK_6082f18ebc188752441fb3f9d36" PRIMARY KEY ("kind", "valid_from"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "invoices" ("id" uuid NOT NULL, "account_id" character(12) NOT NULL, "kind" text NOT NULL, "number" text NOT NULL, "fiscal_year" smallint NOT NULL, "sequence" integer NOT NULL, "month" character(7), "issued_on" date NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "issued_by" text NOT NULL, "currency" character(3) NOT NULL, "subtotal_minor" bigint NOT NULL, "vat_minor" bigint NOT NULL, "stamp_duty_minor" bigint NOT NULL, "total_minor" bigint NOT NULL, "withheld_minor" bigint NOT NULL DEFAULT '0', "buyer_name" text NOT NULL, "buyer_tax_id" text, "corrects_id" uuid, "reason" text, "pdf_key" text NOT NULL, "stamp_transaction_id" uuid, CONSTRAINT "UQ_6b20aa66f2a835a4f2fbde48724" UNIQUE ("number"), CONSTRAINT "CHK_6420233f2ed7c3ea48c88cf072" CHECK (("stamp_duty_minor" > 0) = ("stamp_transaction_id" IS NOT NULL)), CONSTRAINT "CHK_9d29a00e6a34eebb9f192eabc6" CHECK (("kind" = 'credit_note') = ("corrects_id" IS NOT NULL AND "reason" IS NOT NULL AND "stamp_duty_minor" = 0 AND "withheld_minor" = 0)), CONSTRAINT "CHK_7de3c0e718538b88794b57cd74" CHECK (("kind" = 'invoice') = ("month" IS NOT NULL AND "corrects_id" IS NULL AND "reason" IS NULL)), CONSTRAINT "CHK_80f880d55795d38758aebc5652" CHECK ("subtotal_minor" >= 0 AND "vat_minor" >= 0 AND "stamp_duty_minor" >= 0 AND "withheld_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor" + "stamp_duty_minor"), CONSTRAINT "CHK_e609ea3156ee08dce60a557393" CHECK ("sequence" > 0), CONSTRAINT "CHK_033a95f4fefa247de445e3c4a9" CHECK ("kind" IN ('invoice', 'credit_note')), CONSTRAINT "PK_668cef7c22a427fd822cc1be3ce" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8a539d900e5e77f66a90e666e9" ON "invoices" ("stamp_transaction_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_d119010e7f392cdabb85860ed7" ON "invoices" ("account_id", "issued_at") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0f01bb497db67046cd12eb8e3a" ON "invoices" ("kind", "fiscal_year", "sequence") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_150d8adf5922ccc7dcd4d6ea58" ON "invoices" ("account_id", "month") WHERE "kind" = 'invoice'`);
    await queryRunner.query(
      `CREATE TABLE "invoice_lines" ("invoice_id" uuid NOT NULL, "line_no" smallint NOT NULL, "payment_id" uuid, "description" text NOT NULL, "amount_minor" bigint NOT NULL, "vat_percent" smallint NOT NULL, "vat_minor" bigint NOT NULL, CONSTRAINT "CHK_9221f7e53eb27fb229ef54b23e" CHECK ("vat_percent" BETWEEN 0 AND 100), CONSTRAINT "CHK_3f0ee1648e85eee3d25e0af390" CHECK ("amount_minor" > 0 AND "vat_minor" >= 0), CONSTRAINT "CHK_83720ce4ff15c20bce7940b25b" CHECK ("line_no" > 0), CONSTRAINT "PK_36f4f515e9e249c9a7146a4276e" PRIMARY KEY ("invoice_id", "line_no"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0ea8b6e034ee120455739c9dd7" ON "invoice_lines" ("payment_id") `);
    await queryRunner.query(
      `CREATE TABLE "invoice_counters" ("series" text NOT NULL, "fiscal_year" smallint NOT NULL, "last_number" integer NOT NULL, CONSTRAINT "CHK_f8d1ce7c53ac0da4f82fce594d" CHECK ("last_number" >= 0), CONSTRAINT "CHK_5df7308b8785a9a02c06906f57" CHECK ("series" IN ('FAC', 'AV')), CONSTRAINT "PK_b2fa6b5578cf165c3ddc3caf9f6" PRIMARY KEY ("series", "fiscal_year"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "invoice_notices" ("month" character(7) NOT NULL, "kind" text NOT NULL, "waiting" integer NOT NULL, "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_7ff997d2a13cb8fa84d06c089b" CHECK ("kind" IN ('ready', 'reminder')), CONSTRAINT "PK_c43c564d1008f152e8eed0db55c" PRIMARY KEY ("month", "kind"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_rates" ADD CONSTRAINT "FK_3cea6fc55d2d9df50cd618e418f" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_0be7d62c458b5f7c226f3df2cad" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_1408cf23004051a4c9153ef07d7" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_1720c6df12f222840eb1c36459c" FOREIGN KEY ("corrects_id") REFERENCES "invoices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_8a539d900e5e77f66a90e666e98" FOREIGN KEY ("stamp_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_lines" ADD CONSTRAINT "FK_2da95dc86a54a00ff20ce46d0fe" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_lines" ADD CONSTRAINT "FK_0ea8b6e034ee120455739c9dd75" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // The rates in force when FF starts invoicing, as the parent plan gives them (§8.6); the accountant confirms them (§9).
    await queryRunner.query(
      `INSERT INTO "tax_rates" ("kind", "valid_from", "percent", "amount_minor", "currency", "source") VALUES
         ('vat', '2018-01-01', 19, NULL, NULL, 'The standard VAT rate since the Finance Law 2018; IT and cloud services are on no reduced list (parent plan §8.6)'),
         ('stamp_duty', '2023-01-01', NULL, 1000, 'TND', '1 TND per invoice since 1 January 2023 (parent plan §8.6)')`,
    );
    for (const table of APPEND_ONLY) {
      await queryRunner.query(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS "n" FROM "invoices"`)) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} invoice(s) or credit note(s) were issued: they are legal records, and reverting would drop them`);
    await queryRunner.query(`DROP TABLE "invoice_notices"`);
    await queryRunner.query(`DROP TABLE "invoice_lines"`);
    await queryRunner.query(`DROP TABLE "invoices"`);
    await queryRunner.query(`DROP TABLE "invoice_counters"`);
    await queryRunner.query(`DROP TABLE "tax_rates"`);
  }
}
