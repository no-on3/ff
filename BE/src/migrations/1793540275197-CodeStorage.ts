import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The plans' code storage, as Lambda's: what the packages an account's
 * functions and versions name may hold together, each package once. Every
 * plan gets the beta plan's, 5 GB; operators change it from the admin
 * dashboard.
 */
export class CodeStorage1793540275197 implements MigrationInterface {
  name = 'CodeStorage1793540275197';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"codeStorageMb": 5120}'::jsonb WHERE NOT ("limits" ? 'codeStorageMb')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'codeStorageMb'`);
  }
}
