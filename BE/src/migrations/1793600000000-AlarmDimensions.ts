import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's alarm may watch some of its calls, as CloudWatch's alarms on
 * Lambda's metrics take the Resource and ExecutedVersion dimensions: those
 * that named an alias or a version, and those a version ran. Null, as for
 * those before, watches all of them. Down is refused once an alarm names
 * some: reverting would have it watch every call instead.
 */
export class AlarmDimensions1793600000000 implements MigrationInterface {
  name = 'AlarmDimensions1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarms" ADD "resource" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "alarms" ADD "executed_version" character varying(10)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS "n" FROM "alarms" WHERE "resource" IS NOT NULL OR "executed_version" IS NOT NULL`)) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} alarm(s) watch some of a function's calls: reverting would have them watch every call instead`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "executed_version"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "resource"`);
  }
}
