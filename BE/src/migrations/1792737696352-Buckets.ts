import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' buckets behind the S3 front door (ADR 0009): the buckets, their
 * names AWS's and unique across FF, each with a name of its own in the store;
 * the access keys that reach them, their secrets sealed; and the requests the
 * front door counts, a row per bucket, minute, class and writer. The columns,
 * keys and indexes are TypeORM's, as the drift check printed them; the rest is
 * not TypeORM's: storage_request_counts is partitioned by month on its minute,
 * and append-only through ff_refuse_change(), as usage records are: buckets'
 * requests are billed from it. This month's partition and the next are made
 * here; the backend makes the next ones ahead.
 * Down: the three tables go, with their rows.
 */
export class Buckets1792737696352 implements MigrationInterface {
  name = 'Buckets1792737696352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "buckets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "name" character varying(63) NOT NULL, "store_name" character varying(27) NOT NULL, "status" text NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_fdd7cd027ae1e9c5ba381e9fa4" CHECK ("status" IN ('active', 'deleting')), CONSTRAINT "PK_6274370d823fcc89d22efd86580" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_8055dd93a71b8192e2a8d83b8c" ON "buckets" ("account_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c3a4e0a22c38d628f7ee59a633" ON "buckets" ("store_name") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8f92b106edc67c4f4af8d24079" ON "buckets" ("name") `);
    await queryRunner.query(
      `CREATE TABLE "storage_keys" ("id" character varying(20) NOT NULL, "account_id" character(12) NOT NULL, "function_id" uuid, "secret" jsonb NOT NULL, "buckets" text array, "read_only" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_19898f5e20f195baff24ee4ef5a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_d11cb5e3b9180d4ef27d6b7b91" ON "storage_keys" ("account_id") `);
    await queryRunner.query(
      `CREATE TABLE "storage_request_counts" ("bucket_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "class" text NOT NULL, "writer" uuid NOT NULL, "account_id" character(12) NOT NULL, "name" text NOT NULL, "requests" integer NOT NULL, "gets" integer NOT NULL, "puts" integer NOT NULL, "errors4xx" integer NOT NULL, "errors5xx" integer NOT NULL, "bytes_in" bigint NOT NULL, "bytes_out" bigint NOT NULL, CONSTRAINT "CHK_9d279feb676d585c657a8f2204" CHECK ("class" IN ('tier1', 'tier2', 'free')), CONSTRAINT "PK_04fe93e415e958f32b06d5e4da2" PRIMARY KEY ("bucket_id", "minute", "class", "writer")) PARTITION BY RANGE ("minute")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_719dc73524d6786cb173fff158" ON "storage_request_counts" ("account_id", "minute") `);
    await queryRunner.query(`CREATE TRIGGER "storage_request_counts_append_only" BEFORE UPDATE OR DELETE ON "storage_request_counts" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`CREATE TRIGGER "storage_request_counts_no_truncate" BEFORE TRUNCATE ON "storage_request_counts" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('storage_request_counts', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('storage_request_counts', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "storage_request_counts"`); // with its partitions, index and triggers
    await queryRunner.query(`DROP INDEX "public"."IDX_d11cb5e3b9180d4ef27d6b7b91"`);
    await queryRunner.query(`DROP TABLE "storage_keys"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8f92b106edc67c4f4af8d24079"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c3a4e0a22c38d628f7ee59a633"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8055dd93a71b8192e2a8d83b8c"`);
    await queryRunner.query(`DROP TABLE "buckets"`);
  }
}
