import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An access key may name the queues it reaches (ADR 0010), as it names
 * buckets: null for none named. A key that names neither reaches all the
 * account's buckets and queues; one that names some reaches those alone.
 */
export class KeyQueues1792792790340 implements MigrationInterface {
  name = 'KeyQueues1792792790340';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "queues" text array`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A key that named queues alone reached no bucket; without the column it would name none, and reach every bucket.
    await queryRunner.query(`UPDATE "storage_keys" SET "revoked_at" = coalesce("revoked_at", now()) WHERE "queues" IS NOT NULL AND "buckets" IS NULL`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "queues"`);
  }
}
