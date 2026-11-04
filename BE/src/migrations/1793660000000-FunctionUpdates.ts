import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How a function's last change went, as Lambda's LastUpdateStatus (ADR 0014):
 * its status, why it failed, and when the change under way started, which
 * holds every other change off. A function being created holds it since its
 * creation, one in ERROR failed for its error's reason, every other succeeded.
 * The schema's SQL is TypeORM's, as the drift check printed it. Down: they go.
 */
export class FunctionUpdates1793660000000 implements MigrationInterface {
  name = 'FunctionUpdates1793660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."functions_update_status_enum" AS ENUM('InProgress', 'Successful', 'Failed')`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "update_status" "public"."functions_update_status_enum" NOT NULL DEFAULT 'Successful'`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "update_reason" character varying`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "update_started_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`UPDATE "functions" SET "update_status" = 'InProgress', "update_started_at" = "created_at" WHERE "status" = 'CREATING'`);
    await queryRunner.query(`UPDATE "functions" SET "update_status" = 'Failed', "update_reason" = "error" WHERE "status" = 'ERROR'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "update_started_at"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "update_reason"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "update_status"`);
    await queryRunner.query(`DROP TYPE "public"."functions_update_status_enum"`);
  }
}
