import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's settings for its asynchronous calls, as AWS Lambda's
 * EventInvokeConfig: its retries, how long a call is kept, and its
 * destinations. Deleting the function deletes them.
 */
export class EventInvokeConfigs1792777408931 implements MigrationInterface {
  name = 'EventInvokeConfigs1792777408931';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "function_event_invoke_configs" ("function_id" uuid NOT NULL, "maximum_retry_attempts" smallint, "maximum_event_age_in_seconds" integer, "on_success" text, "on_failure" text, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_d1f5aa99534aaad52706cd1abc" CHECK ("maximum_event_age_in_seconds" BETWEEN 60 AND 21600), CONSTRAINT "CHK_5998c5bf68fb5df3bb30fac071" CHECK ("maximum_retry_attempts" BETWEEN 0 AND 2), CONSTRAINT "PK_5d4dcbb17d33b1c2f28abc91d62" PRIMARY KEY ("function_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_event_invoke_configs" ADD CONSTRAINT "FK_5d4dcbb17d33b1c2f28abc91d62" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "function_event_invoke_configs"`);
  }
}
