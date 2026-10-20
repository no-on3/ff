import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Calls an account's rate limit refused have no usage record: their number,
 * per function and minute, is kept for the Throttles metric. TypeORM's SQL, as
 * the drift check printed it. Down: the table goes, and the metric counts only
 * the calls no instance could take in time, as before.
 */
export class RateLimitedInvocations1792419122035 implements MigrationInterface {
  name = 'RateLimitedInvocations1792419122035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "rate_limited_invocations" ("function_id" uuid NOT NULL, "minute" TIMESTAMP WITH TIME ZONE NOT NULL, "account_id" character(12) NOT NULL, "count" integer NOT NULL, CONSTRAINT "PK_0b622e968976877983ff78fab32" PRIMARY KEY ("function_id", "minute"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_6874955e8a0e93dd186a3915c3" ON "rate_limited_invocations" ("account_id", "minute") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_6874955e8a0e93dd186a3915c3"`);
    await queryRunner.query(`DROP TABLE "rate_limited_invocations"`);
  }
}
