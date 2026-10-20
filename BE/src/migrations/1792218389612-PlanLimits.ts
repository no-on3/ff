import { MigrationInterface, QueryRunner } from 'typeorm';

/** The beta plan's limits: today's, as the client-readiness plan lists them (P-15). */
const BETA = {
  functions: 25,
  memoryMb: 1024,
  timeoutSeconds: 300,
  instancesPerFunction: 10,
  quota: { pods: 20, cpu: '8', memory: '8Gi' },
  writesPerMinute: 60,
  invokesPerSecond: 100,
  logRetentionDays: 14,
  historyRetentionDays: 30,
  idleSeconds: 900,
  internetEgress: false,
};

const STATUSES_BEFORE = `'SUCCESS', 'ERROR', 'TIMEOUT', 'RUNNING', 'COMPLETED'`;

/**
 * Written by hand (P-15, D5):
 * - the beta plan gets its limits, which were empty since P-12;
 * - an invocation can be THROTTLED: no instance could take it (the runtime's
 *   429), which D7 doesn't bill.
 * Down: THROTTLED invocations become ERROR, and the beta plan's limits are
 * emptied again.
 */
export class PlanLimits1792218389612 implements MigrationInterface {
  name = 'PlanLimits1792218389612';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = $1 WHERE "id" = 'beta'`, [JSON.stringify(BETA)]);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_status_enum" ADD VALUE 'THROTTLED'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "function_invocations" SET "status" = 'ERROR' WHERE "status" = 'THROTTLED'`);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_status_enum" RENAME TO "function_invocations_status_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."function_invocations_status_enum" AS ENUM(${STATUSES_BEFORE})`);
    await queryRunner.query(
      `ALTER TABLE "function_invocations" ALTER COLUMN "status" TYPE "public"."function_invocations_status_enum" USING "status"::"text"::"public"."function_invocations_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."function_invocations_status_enum_old"`);
    await queryRunner.query(`UPDATE "plans" SET "limits" = '{}' WHERE "id" = 'beta'`);
  }
}
