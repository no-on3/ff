import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-45: the invocation history keeps at most 64 KiB of each input, output and
 * error, and says when it kept only the start (history.ts). TypeORM's, as the
 * drift check printed it. Rows already kept are left as they are: none is
 * marked, and the plan's history retention clears them in time.
 * Down: the flags go. A value kept truncated then reads as a string, the start
 * of its JSON text, until the retention clears it; nothing else is lost, so
 * the rollback isn't refused.
 */
export class InvocationHistory1792282243364 implements MigrationInterface {
  name = 'InvocationHistory1792282243364';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "input_truncated" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "output_truncated" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "error_truncated" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "error_truncated"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "output_truncated"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "input_truncated"`);
  }
}
