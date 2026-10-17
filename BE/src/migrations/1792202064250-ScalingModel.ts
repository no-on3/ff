import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The beta's scaling model (client-readiness plan, P-06 and D14).
 *
 * - Functions scale on concurrency, one call per instance, so the unused
 *   columns go: functions.cpu (CPU follows memory), functions.target_concurrency,
 *   function_invocations.cpu_used (always NULL) and function_metrics.cpu_usage
 *   (always 0).
 * - function_metrics.max_concurrency keeps each minute's most calls in flight
 *   at once, the scaling signal.
 * - New functions may run up to 3 instances instead of 1, so autoscaling can
 *   add any. Existing functions keep their value.
 *
 * Written by hand: TypeORM's generator guessed that cpu_usage was renamed.
 */
export class ScalingModel1792202064250 implements MigrationInterface {
  name = 'ScalingModel1792202064250';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "cpu"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "target_concurrency"`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "max_instances" SET DEFAULT '3'`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "cpu_used"`);
    await queryRunner.query(`ALTER TABLE "function_metrics" DROP COLUMN "cpu_usage"`);
    await queryRunner.query(`ALTER TABLE "function_metrics" ADD "max_concurrency" integer NOT NULL DEFAULT '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The dropped columns come back with their defaults: nothing ever read their values.
    await queryRunner.query(`ALTER TABLE "function_metrics" DROP COLUMN "max_concurrency"`);
    await queryRunner.query(`ALTER TABLE "function_metrics" ADD "cpu_usage" double precision NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "function_metrics" ALTER COLUMN "cpu_usage" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "cpu_used" double precision`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "max_instances" SET DEFAULT '1'`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "target_concurrency" integer NOT NULL DEFAULT '100'`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "cpu" integer NOT NULL DEFAULT '100'`);
  }
}
