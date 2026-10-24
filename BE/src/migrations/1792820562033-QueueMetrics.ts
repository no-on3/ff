import { MigrationInterface, QueryRunner } from 'typeorm';

/** The metrics this migration gives alarms, which the code before it doesn't know. */
const NEW_METRICS = [
  'AsyncEventsReceived',
  'AsyncEventAge',
  'AsyncEventsDropped',
  'DestinationDeliveryFailures',
  'ApproximateNumberOfMessagesVisible',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
  'ApproximateAgeOfOldestMessage',
  'NumberOfMessagesSent',
  'NumberOfMessagesReceived',
  'NumberOfMessagesDeleted',
  'NumberOfEmptyReceives',
  'SentMessageSize',
];

/**
 * Queues' and asynchronous calls' metrics, as CloudWatch has SQS's and
 * Lambda's (ADR 0010): each customer's queue holding a message sampled every
 * minute; each function's asynchronous calls counted a minute at a time; and
 * an alarm that names a queue, going with it. The columns, keys, indexes and
 * foreign key are TypeORM's, as the drift check printed them; the rest is
 * not TypeORM's: both tables are partitioned by month on their minute, and
 * append-only through ff_refuse_change(), as capacity samples and request
 * counts are. This month's partitions and the next are made here; the
 * backend makes the next ones ahead.
 * Down: the alarms on the metrics this adds go first, then the tables and the
 * column.
 */
export class QueueMetrics1792820562033 implements MigrationInterface {
  name = 'QueueMetrics1792820562033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "queue_samples" ("queue_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "visible" integer NOT NULL, "not_visible" integer NOT NULL, "delayed" integer NOT NULL, "oldest_age_seconds" integer NOT NULL, CONSTRAINT "PK_7e01babb695a194305220838d45" PRIMARY KEY ("queue_id", "minute")) PARTITION BY RANGE ("minute")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ad1aeac1f093639c0a33361f8a" ON "queue_samples" ("account_id", "minute") `);
    await queryRunner.query(
      `CREATE TABLE "async_event_counts" ("function_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "writer" uuid NOT NULL, "account_id" character(12) NOT NULL, "received" integer NOT NULL, "dropped" integer NOT NULL, "destination_failures" integer NOT NULL, "attempts" integer NOT NULL, "age_ms_sum" bigint NOT NULL, "age_ms_max" integer NOT NULL, CONSTRAINT "PK_04580302c9e1f7447d2517540f9" PRIMARY KEY ("function_id", "minute", "writer")) PARTITION BY RANGE ("minute")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_84363d8ba05f1c3343fbfb307a" ON "async_event_counts" ("account_id", "minute") `);
    await queryRunner.query(`ALTER TABLE "alarms" ADD "queue_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_7e7a4f61452826dc175157f0ef" ON "alarms" ("queue_id") `);
    await queryRunner.query(`ALTER TABLE "alarms" ADD CONSTRAINT "FK_7e7a4f61452826dc175157f0efa" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    for (const table of ['queue_samples', 'async_event_counts']) {
      await queryRunner.query(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`);
      await queryRunner.query(`SELECT "ff_ensure_month_partition"($1, (now() AT TIME ZONE 'UTC')::date)`, [table]);
      await queryRunner.query(`SELECT "ff_ensure_month_partition"($1, ((now() AT TIME ZONE 'UTC') + interval '1 month')::date)`, [table]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "alarms" WHERE "queue_id" IS NOT NULL OR "metric" = ANY($1)`, [NEW_METRICS]);
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_7e7a4f61452826dc175157f0efa"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7e7a4f61452826dc175157f0ef"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "queue_id"`);
    await queryRunner.query(`DROP TABLE "async_event_counts"`); // with its partitions, index and triggers
    await queryRunner.query(`DROP TABLE "queue_samples"`);
  }
}
