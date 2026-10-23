import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' own keys to their account's buckets (ADR 0009): a function has
 * one that works at most, made at its first deploy, even when two deploys of
 * it make one at once; a revoked key keeps its row.
 */
export class FunctionKeys1792743758847 implements MigrationInterface {
  name = 'FunctionKeys1792743758847';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_storage_keys_function" ON "storage_keys" ("function_id") WHERE "function_id" IS NOT NULL AND "revoked_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_storage_keys_function"`);
  }
}
