import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tags on an account's resources, as AWS's (ADR 0014): a function's for now,
 * each key its function's once, going with its function; the row's own ID, so
 * that queues' and buckets' can join the table with their resource's column.
 * The SQL is TypeORM's, as the drift check printed it. Down: the tags go.
 */
export class ResourceTags1793640000000 implements MigrationInterface {
  name = 'ResourceTags1793640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "resource_tags" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "key" character varying(128) NOT NULL, "value" character varying(256) NOT NULL, CONSTRAINT "PK_f074d6112c7b5755be1d827c88b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_79764c0eb7d74d32b583272254" ON "resource_tags" ("function_id", "key") `);
    await queryRunner.query(
      `ALTER TABLE "resource_tags" ADD CONSTRAINT "FK_f3bd5eefcc2d700b35362cf1a8f" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "FK_f3bd5eefcc2d700b35362cf1a8f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_79764c0eb7d74d32b583272254"`);
    await queryRunner.query(`DROP TABLE "resource_tags"`);
  }
}
