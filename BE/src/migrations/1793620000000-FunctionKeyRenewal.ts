import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' keys that end (ADR 0014, 5): a function's key renewed is marked
 * replaced rather than revoked, and works on until no pod holds it, so that a
 * function has one current key, which the index keeps, and may have others,
 * replaced, beside it. Down revokes those, which the old index would refuse
 * beside the current one.
 */
export class FunctionKeyRenewal1793620000000 implements MigrationInterface {
  name = 'FunctionKeyRenewal1793620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "replaced_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`DROP INDEX "public"."UQ_storage_keys_function"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_storage_keys_function" ON "storage_keys" ("function_id") WHERE "function_id" IS NOT NULL AND "revoked_at" IS NULL AND "replaced_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "storage_keys" SET "revoked_at" = now() WHERE "replaced_at" IS NOT NULL AND "revoked_at" IS NULL`);
    await queryRunner.query(`DROP INDEX "public"."UQ_storage_keys_function"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_storage_keys_function" ON "storage_keys" ("function_id") WHERE "function_id" IS NOT NULL AND "revoked_at" IS NULL`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "replaced_at"`);
  }
}
