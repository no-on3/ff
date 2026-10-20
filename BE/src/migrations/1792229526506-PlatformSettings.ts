import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-70 (D12): the platform's settings, which operators change from the admin
 * dashboard. TypeORM's own SQL, as the drift check printed it. A setting
 * without a row has its default (src/admin/platform-settings.ts), so the table
 * starts empty.
 */
export class PlatformSettings1792229526506 implements MigrationInterface {
  name = 'PlatformSettings1792229526506';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "platform_settings" ("key" text NOT NULL, "value" jsonb NOT NULL, CONSTRAINT "PK_5d9031e30fac3ec3ec8b9602e17" PRIMARY KEY ("key"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "platform_settings"`);
  }
}
