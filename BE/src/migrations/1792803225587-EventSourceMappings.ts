import { MigrationInterface, QueryRunner } from 'typeorm';

const SOURCES_BEFORE = `'api', 'url', 'schedule', 'async'`;

/**
 * Functions reading queues, as AWS Lambda's event source mappings for SQS
 * (ADR 0010):
 * - `event_source_mappings`, a function and a queue of its account, each pair
 *   once, with Lambda's batch size (1 to 10,000, over 10 with a batching
 *   window), batching window (0 to 300 s), partial batch responses and
 *   maximum concurrency (2 to 1,000), enabled or not; going with the function
 *   or the queue;
 * - the history's source `sqs`, added to the type as `async` was, which
 *   leaves the history's rows as they are.
 * Down: the mappings go; the queues' calls in the history become `async`
 * calls, the calls FF made without anyone waiting.
 */
export class EventSourceMappings1792803225587 implements MigrationInterface {
  name = 'EventSourceMappings1792803225587';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "event_source_mappings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "queue_id" uuid NOT NULL, "batch_size" integer NOT NULL DEFAULT '10', "maximum_batching_window_in_seconds" integer NOT NULL DEFAULT '0', "report_batch_item_failures" boolean NOT NULL DEFAULT false, "maximum_concurrency" integer, "enabled" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_d199a8a5f40a15d3f38b97355b" CHECK ("maximum_concurrency" BETWEEN 2 AND 1000), CONSTRAINT "CHK_3318f8cdf0bf2ec6b8a15dfea9" CHECK ("batch_size" <= 10 OR "maximum_batching_window_in_seconds" > 0), CONSTRAINT "CHK_8cbba7932032e0d19b7dc529e5" CHECK ("maximum_batching_window_in_seconds" BETWEEN 0 AND 300), CONSTRAINT "CHK_2d5d2a40e41c6d5b4ab5374820" CHECK ("batch_size" BETWEEN 1 AND 10000), CONSTRAINT "PK_49b7a2b7b2582244c074fab29a2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_a3237ea1538dfbe18ffcdd6d10" ON "event_source_mappings" ("queue_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_b668476248d2438ac00d132aa1" ON "event_source_mappings" ("account_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d44c48ec8b4f525a8ac1a10b5b" ON "event_source_mappings" ("function_id", "queue_id") `);
    await queryRunner.query(
      `ALTER TABLE "event_source_mappings" ADD CONSTRAINT "FK_8afd3f59b631d475b49fd392dd0" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_source_mappings" ADD CONSTRAINT "FK_a3237ea1538dfbe18ffcdd6d10b" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_source_enum" ADD VALUE 'sqs'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "function_invocations" SET "source" = 'async' WHERE "source" = 'sqs'`);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_source_enum" RENAME TO "function_invocations_source_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."function_invocations_source_enum" AS ENUM(${SOURCES_BEFORE})`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ALTER COLUMN "source" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "function_invocations" ALTER COLUMN "source" TYPE "public"."function_invocations_source_enum" USING "source"::"text"::"public"."function_invocations_source_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "function_invocations" ALTER COLUMN "source" SET DEFAULT 'api'`);
    await queryRunner.query(`DROP TYPE "public"."function_invocations_source_enum_old"`);
    await queryRunner.query(`DROP TABLE "event_source_mappings"`);
  }
}
