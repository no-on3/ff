import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lambda's permissions, kept as sent, without effect (ADR 0014): a statement
 * of the function's policy, a version's or an alias's, each ID once in its
 * policy, going with what it is in. Names as TypeORM gives them. Down: the
 * statements go.
 */
export class FunctionPolicies1793690000000 implements MigrationInterface {
  name = 'FunctionPolicies1793690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "function_policies" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "version" integer, "alias" character varying(128), "statement_id" character varying(100) NOT NULL, "statement" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_9edb1d8a9f112bdf43ba68e0a1" CHECK ("version" IS NULL OR "alias" IS NULL), CONSTRAINT "PK_8b01034cceb75269991bc4c43f1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8412729d0216a02f5057a86733" ON "function_policies" ("function_id", "version", "statement_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3036aa84ce46a36aa0a9c45d05" ON "function_policies" ("function_id", "alias", "statement_id") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_function_policies_function" ON "function_policies" ("function_id", "statement_id") WHERE "version" IS NULL AND "alias" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_policies" ADD CONSTRAINT "FK_4fd6dc4aaaac1d3c65591ecfdb0" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_policies" ADD CONSTRAINT "FK_e6aa513051cfa2ce60ca179c489" FOREIGN KEY ("function_id", "version") REFERENCES "function_versions"("function_id","version") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_policies" ADD CONSTRAINT "FK_2b03bb27ddcba0078f000c836d6" FOREIGN KEY ("function_id", "alias") REFERENCES "function_aliases"("function_id","name") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_policies" DROP CONSTRAINT "FK_2b03bb27ddcba0078f000c836d6"`);
    await queryRunner.query(`ALTER TABLE "function_policies" DROP CONSTRAINT "FK_e6aa513051cfa2ce60ca179c489"`);
    await queryRunner.query(`ALTER TABLE "function_policies" DROP CONSTRAINT "FK_4fd6dc4aaaac1d3c65591ecfdb0"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_function_policies_function"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3036aa84ce46a36aa0a9c45d05"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8412729d0216a02f5057a86733"`);
    await queryRunner.query(`DROP TABLE "function_policies"`);
  }
}
