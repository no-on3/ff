import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deploys' own keys to a bucket: an hour each, then refused as a revoked key
 * is. Every key there is lasts until revoked. Down: the deploys' keys go, as
 * the column that tells them apart does.
 */
export class DeployKeys1793326500000 implements MigrationInterface {
  name = 'DeployKeys1793326500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_keys" ADD "expires_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "storage_keys" WHERE "expires_at" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "storage_keys" DROP COLUMN "expires_at"`);
  }
}
