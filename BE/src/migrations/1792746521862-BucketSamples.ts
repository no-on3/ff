import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' buckets measured every hour (ADR 0009, §8): bucket_samples, a
 * row per bucket and hour, what its listing held then; and the share of its
 * plan's storage that an account's buckets reached together, which its owners
 * were told of, uploads waiting for room at 100%. The columns, keys, indexes
 * and check are TypeORM's, as the drift check printed them; the rest is not
 * TypeORM's: bucket_samples is partitioned by month on its hour and
 * append-only through ff_refuse_change(), as databases' samples are, the bill
 * being priced from them. This month's partition and the next are made here;
 * the backend makes the next ones ahead.
 * Down: the table and the column go.
 */
export class BucketSamples1792746521862 implements MigrationInterface {
  name = 'BucketSamples1792746521862';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bucket_samples" ("bucket_id" uuid NOT NULL, "hour" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "name" text NOT NULL, "size_bytes" bigint NOT NULL, "objects" bigint NOT NULL, CONSTRAINT "PK_0a9a907c4242a855da8bd2e2e6b" PRIMARY KEY ("bucket_id", "hour")) PARTITION BY RANGE ("hour")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_513ea006813608f3cda7523cd1" ON "bucket_samples" ("account_id", "hour") `);
    await queryRunner.query(`ALTER TABLE "accounts" ADD "bucket_storage_notice" smallint`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD CONSTRAINT "CHK_32ede1c87423a5360bd6fc120b" CHECK ("bucket_storage_notice" IN (80, 100))`);
    await queryRunner.query(`CREATE TRIGGER "bucket_samples_append_only" BEFORE UPDATE OR DELETE ON "bucket_samples" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "bucket_samples_no_truncate" BEFORE TRUNCATE ON "bucket_samples" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('bucket_samples', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('bucket_samples', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_32ede1c87423a5360bd6fc120b"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "bucket_storage_notice"`);
    await queryRunner.query(`DROP TABLE "bucket_samples"`); // with its partitions, index and triggers
  }
}
