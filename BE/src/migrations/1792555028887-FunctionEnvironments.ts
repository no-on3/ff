import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's environment variables and secrets, sealed with a data key of
 * the function's own (the platform's keys are FF_ENCRYPTION_KEYS_FILE), in a
 * table apart from functions, so that nothing that lists functions loads them.
 * Deleting a function deletes its row. The SQL is TypeORM's, as the drift
 * check printed it.
 */
export class FunctionEnvironments1792555028887 implements MigrationInterface {
  name = 'FunctionEnvironments1792555028887';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "function_environments" ("function_id" uuid NOT NULL, "account_id" character(12) NOT NULL, "revision" text NOT NULL, "document" jsonb NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_39698821e90acd536b0ae0bd8f0" PRIMARY KEY ("function_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_environments" ADD CONSTRAINT "FK_39698821e90acd536b0ae0bd8f0" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_environments" DROP CONSTRAINT "FK_39698821e90acd536b0ae0bd8f0"`);
    await queryRunner.query(`DROP TABLE "function_environments"`);
  }
}
