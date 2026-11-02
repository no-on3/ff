import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What ran each call, as Lambda's ExecutedVersion and Resource say it: the
 * version, null for $LATEST, and the alias the call named, null for none; on
 * the history's invocations and on the usage records, which the metrics are
 * read from. Calls made before have neither: they ran $LATEST. A usage record
 * is never changed, but a column added to its table is no change of a record.
 */
export class InvocationVersions1793560000000 implements MigrationInterface {
  name = 'InvocationVersions1793560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['function_invocations', 'usage_records']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD "version" integer`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD "alias" character varying(128)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['usage_records', 'function_invocations']) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "alias"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "version"`);
    }
  }
}
