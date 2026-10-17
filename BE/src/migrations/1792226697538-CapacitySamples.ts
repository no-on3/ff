import { MigrationInterface, QueryRunner } from 'typeorm';

/** P-20's function, which this migration replaces, as it was: for down(). */
const USAGE_PARTITION_FUNCTION = `CREATE FUNCTION "ff_ensure_usage_partition"("month" date) RETURNS text LANGUAGE plpgsql AS $$
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
       END $$`;

/**
 * P-21 (D6, D8): capacity samples, one row per function with a ready instance
 * and minute. The columns, primary key and index are TypeORM's, as the drift
 * check printed them; the rest is not TypeORM's:
 * - the table is partitioned by month on minute, the primary key's second
 *   column, and append-only through P-17's ff_refuse_change(), as P-20's
 *   usage_records is: D8 bills provisioned time from these samples;
 * - ff_ensure_month_partition(parent, month) creates a month's partition of
 *   either table, in UTC, with its own TRUNCATE trigger. It replaces P-20's
 *   ff_ensure_usage_partition(month), which did the same for usage_records
 *   only. This migration creates this month's and the next; the backend
 *   creates the next ones ahead of time.
 * Down: the table goes, with its partitions, and P-20's function comes back.
 */
export class CapacitySamples1792226697538 implements MigrationInterface {
  name = 'CapacitySamples1792226697538';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE FUNCTION "ff_ensure_month_partition"("parent" text, "month" date) RETURNS text LANGUAGE plpgsql AS $$
       DECLARE
         first_day timestamptz := date_trunc('month', "month"::timestamp) AT TIME ZONE 'UTC'; -- whatever the session's time zone
         partition text := "parent" || '_' || to_char("month", 'YYYY_MM');
       BEGIN
         IF to_regclass(quote_ident(partition)) IS NULL THEN
           EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
             partition, "parent", first_day, first_day + interval '1 month');
           -- The table's TRUNCATE trigger doesn't reach a partition emptied on its own.
           EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()',
             "parent" || '_no_truncate', partition);
         END IF;
         RETURN partition;
       END $$`,
    );
    await queryRunner.query(`DROP FUNCTION "ff_ensure_usage_partition"(date)`);
    await queryRunner.query(
      `CREATE TABLE "capacity_samples" ("function_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "instances" integer NOT NULL, "min_instances" integer NOT NULL, "memory_mb" integer NOT NULL, CONSTRAINT "PK_f6df556caa34bb2152255864393" PRIMARY KEY ("function_id", "minute")) PARTITION BY RANGE ("minute")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_289b2cf5cad0f7652ff00fe166" ON "capacity_samples" ("account_id", "minute") `);
    await queryRunner.query(
      `CREATE TRIGGER "capacity_samples_append_only" BEFORE UPDATE OR DELETE ON "capacity_samples" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "capacity_samples_no_truncate" BEFORE TRUNCATE ON "capacity_samples" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`,
    );
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('capacity_samples', (now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`SELECT "ff_ensure_month_partition"('capacity_samples', ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "capacity_samples"`); // with its partitions, index and triggers
    await queryRunner.query(USAGE_PARTITION_FUNCTION);
    await queryRunner.query(`DROP FUNCTION "ff_ensure_month_partition"(text, date)`);
  }
}
