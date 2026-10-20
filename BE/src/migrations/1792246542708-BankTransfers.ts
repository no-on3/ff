import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-35 (D9; parent §8.5): bank transfers. TypeORM's, as the drift check
 * printed it:
 * - payments: a pro-forma with its reference, the transfer recorded against
 *   it, and the withholding certificate; their consistency checked;
 * - the ledger's account types gain the withholding-tax receivable, the tax a
 *   customer withheld at source, FF's to claim with the certificate.
 * Down: the payments go, and the type check is P-31's again, which refuses a
 * withholding receivable that still exists.
 */
export class BankTransfers1792246542708 implements MigrationInterface {
  name = 'BankTransfers1792246542708';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ledger_accounts" DROP CONSTRAINT "CHK_a8fd4d6fdf98ca7c3517408e3a"`);
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "method" text NOT NULL, "reference" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "currency" character(3) NOT NULL, "credit_minor" bigint NOT NULL, "vat_percent" smallint NOT NULL, "vat_minor" bigint NOT NULL, "total_minor" bigint NOT NULL, "buyer_name" text NOT NULL, "buyer_tax_id" text, "requested_by" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "received_minor" bigint, "withheld_minor" bigint, "received_on" date, "bank_reference" text, "recorded_by" text, "recorded_at" TIMESTAMP WITH TIME ZONE, "ledger_transaction_id" uuid, "certificate_key" text, "certificate_type" text, "certificate_at" TIMESTAMP WITH TIME ZONE, "certificate_transaction_id" uuid, CONSTRAINT "CHK_05b4a20837adeee3f488c4ffbc" CHECK (("certificate_key" IS NULL) = ("certificate_transaction_id" IS NULL) AND ("certificate_key" IS NULL OR "withheld_minor" > 0)), CONSTRAINT "CHK_396c4bef2f56a01d3ce79a2090" CHECK (("status" = 'paid') = ("received_minor" IS NOT NULL AND "withheld_minor" IS NOT NULL AND "received_minor" + "withheld_minor" = "total_minor")), CONSTRAINT "CHK_65d223229805be3c8ec0d5006f" CHECK ("credit_minor" > 0 AND "vat_minor" >= 0 AND "total_minor" = "credit_minor" + "vat_minor"), CONSTRAINT "CHK_4253d8531237d41f38f34915fb" CHECK ("status" IN ('pending', 'paid')), CONSTRAINT "CHK_0c30f962916d52a54e41c8d55d" CHECK ("method" IN ('bank_transfer')), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_d1d6bb7488342d051d20e48ae1" ON "payments" ("account_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_866ddee0e17d9385b4e3b86851" ON "payments" ("reference") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8ed7197dedd290bf679604a90b" ON "payments" ("ledger_transaction_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_32e208e05bf9d1b785a3ac7260" ON "payments" ("certificate_transaction_id") `);
    await queryRunner.query(
      `ALTER TABLE "ledger_accounts" ADD CONSTRAINT "CHK_7c5807b36e14d2ff1fe43de2a0" CHECK ("type" IN ('wallet', 'revenue', 'vat_payable', 'stamp_duty', 'provider_clearing', 'promotional_credit', 'withholding_receivable'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_d1d6bb7488342d051d20e48ae1f" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_eb4f745ec0ac3b18b42eff773fa" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_8ed7197dedd290bf679604a90b5" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_32e208e05bf9d1b785a3ac7260b" FOREIGN KEY ("certificate_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`ALTER TABLE "ledger_accounts" DROP CONSTRAINT "CHK_7c5807b36e14d2ff1fe43de2a0"`);
    await queryRunner.query(
      `ALTER TABLE "ledger_accounts" ADD CONSTRAINT "CHK_a8fd4d6fdf98ca7c3517408e3a" CHECK ("type" IN ('wallet', 'revenue', 'vat_payable', 'stamp_duty', 'provider_clearing', 'promotional_credit'))`,
    );
  }
}
