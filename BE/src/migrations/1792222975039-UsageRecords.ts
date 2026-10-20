import { MigrationInterface, QueryRunner } from 'typeorm';

const STATUSES_BEFORE = `'SUCCESS', 'ERROR', 'TIMEOUT', 'RUNNING', 'COMPLETED', 'THROTTLED'`;

/**
 * P-20 (D6): usage records, written once per invocation. The columns, check,
 * primary key and indexes are TypeORM's, as the drift check printed them; the
 * rest is not TypeORM's:
 * - the table is partitioned by month on started_at, the primary key's second
 *   column, as PostgreSQL requires. ff_ensure_usage_partition(month) creates a
 *   month's partition, in UTC; this migration creates this month's and the
 *   next, and the backend creates the next ones ahead of time;
 * - P-17's ff_refuse_change() refuses UPDATE, DELETE and TRUNCATE. Row
 *   triggers reach the partitions, but the table's TRUNCATE trigger doesn't
 *   reach a partition emptied on its own, so each partition gets its own.
 *   Dropping or detaching a partition stays possible: that is how a month is
 *   archived once its retention has passed (D6);
 * - an invocation can be LOST: the backend restarted during the call.
 * Down: LOST invocations become ERROR, and the table goes, with its partitions.
 */
export class UsageRecords1792222975039 implements MigrationInterface {
  name = 'UsageRecords1792222975039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "usage_records" ("request_id" uuid NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "function_name" text NOT NULL, "runtime" text NOT NULL, "memory_mb" integer NOT NULL, "duration_ms" numeric(12,3) NOT NULL, "billed_ms" integer NOT NULL, "init_ms" integer, "status" text NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_4ed02389f5d441df92a39a1f33" CHECK ("status" IN ('success', 'error', 'timeout', 'throttled', 'platform_error', 'lost')), CONSTRAINT "PK_7cc7e54a336bd23157346278fed" PRIMARY KEY ("request_id", "started_at")) PARTITION BY RANGE ("started_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_705294705fc4da96e37f89c1d8" ON "usage_records" ("function_id", "started_at") `);
    await queryRunner.query(`CREATE INDEX "IDX_d6fc4cf37a4e5a856ca694539a" ON "usage_records" ("account_id", "started_at") `);
    await queryRunner.query(
      `CREATE TRIGGER "usage_records_append_only" BEFORE UPDATE OR DELETE ON "usage_records" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "usage_records_no_truncate" BEFORE TRUNCATE ON "usage_records" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`,
    );
    await queryRunner.query(
      `CREATE FUNCTION "ff_ensure_usage_partition"("month" date) RETURNS text LANGUAGE plpgsql AS $$
       DECLARE
         first_day timestamptz := date_trunc('month', "month"::timestamp) AT TIME ZONE 'UTC'; -- whatever the session's time zone
         partition text := 'usage_records_' || to_char("month", 'YYYY_MM');
       BEGIN
         IF to_regclass(quote_ident(partition)) IS NULL THEN
           EXECUTE format('CREATE TABLE %I PARTITION OF "usage_records" FOR VALUES FROM (%L) TO (%L)',
             partition, first_day, first_day + interval '1 month');
           EXECUTE format('CREATE TRIGGER "usage_records_no_truncate" BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()',
             partition);
         END IF;
         RETURN partition;
       END $$`,
    );
    await queryRunner.query(`SELECT "ff_ensure_usage_partition"((now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_usage_partition"(((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_status_enum" ADD VALUE 'LOST'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "function_invocations" SET "status" = 'ERROR' WHERE "status" = 'LOST'`);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_status_enum" RENAME TO "function_invocations_status_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."function_invocations_status_enum" AS ENUM(${STATUSES_BEFORE})`);
    await queryRunner.query(
      `ALTER TABLE "function_invocations" ALTER COLUMN "status" TYPE "public"."function_invocations_status_enum" USING "status"::"text"::"public"."function_invocations_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."function_invocations_status_enum_old"`);
    await queryRunner.query(`DROP TABLE "usage_records"`); // with its partitions, indexes and triggers
    await queryRunner.query(`DROP FUNCTION "ff_ensure_usage_partition"(date)`);
  }
}
