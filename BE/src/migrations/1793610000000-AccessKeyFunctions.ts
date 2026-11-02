import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access keys that reach functions (ADR 0014): each key gets a name, as an
 * IAM user has one, unique among the account's working keys, its ID for a key
 * made before; the functions it names, or "*" for all, at one of three
 * levels, read, invoke or write; none for a key made before, so that no key
 * gains a right it didn't have. The plans' accessKeys, 10 on beta, where an
 * account had two. Down revokes a key that named functions alone, which
 * would reach every bucket, queue and the account's mail without them.
 */
export class AccessKeyFunctions1793610000000 implements MigrationInterface {
  name = 'AccessKeyFunctions1793610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "name" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "functions" text array`);
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "function_access" character varying(6)`);
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD CONSTRAINT "CHK_3320c658dd3326f3afe165e6bc" CHECK ("function_access" IN ('read', 'invoke', 'write'))`);
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD CONSTRAINT "CHK_d5db98dd815a8b99ef1d173877" CHECK (("functions" IS NULL) = ("function_access" IS NULL))`);
    await queryRunner.query(`UPDATE "storage_keys" SET "name" = "id" WHERE "function_id" IS NULL AND "expires_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_storage_keys_name" ON "storage_keys" ("account_id", "name") WHERE "name" IS NOT NULL AND "revoked_at" IS NULL`);
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"accessKeys": 10}'::jsonb WHERE NOT ("limits" ? 'accessKeys')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'accessKeys'`);
    await queryRunner.query(
      `UPDATE "storage_keys" SET "revoked_at" = coalesce("revoked_at", now()) WHERE "functions" IS NOT NULL AND "buckets" IS NULL AND "queues" IS NULL`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_storage_keys_name"`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP CONSTRAINT "CHK_d5db98dd815a8b99ef1d173877"`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP CONSTRAINT "CHK_3320c658dd3326f3afe165e6bc"`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "function_access"`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "functions"`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "name"`);
  }
}
