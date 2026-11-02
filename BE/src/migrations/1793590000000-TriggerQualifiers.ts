import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A schedule and a function's reading of a queue may name a version or an
 * alias of their function, as an EventBridge rule's target and Lambda's event
 * source mapping take a qualified ARN: null, as for those before, runs
 * $LATEST. Down is refused once one names a version or an alias: reverting
 * would have it run $LATEST instead.
 */
export class TriggerQualifiers1793590000000 implements MigrationInterface {
  name = 'TriggerQualifiers1793590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "schedules" ADD "qualifier" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "event_source_mappings" ADD "qualifier" character varying(128)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(
      `SELECT ((SELECT count(*) FROM "schedules" WHERE "qualifier" IS NOT NULL) + (SELECT count(*) FROM "event_source_mappings" WHERE "qualifier" IS NOT NULL))::int AS "n"`,
    )) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} schedule(s) and mapping(s) name a version or an alias: reverting would have them run $LATEST instead`);
    await queryRunner.query(`ALTER TABLE "event_source_mappings" DROP COLUMN "qualifier"`);
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "qualifier"`);
  }
}
