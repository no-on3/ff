import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's calls stopped, as Lambda's reserved concurrency of 0 (ADR
 * 0014): every call refused as throttled. No function's is. The schema's SQL
 * is TypeORM's, as the drift check printed it. Down: it goes.
 */
export class FunctionCallsStopped1793680000000 implements MigrationInterface {
  name = 'FunctionCallsStopped1793680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "calls_stopped" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "calls_stopped"`);
  }
}
