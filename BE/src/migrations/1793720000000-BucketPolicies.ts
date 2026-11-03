import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A bucket's policy and its public access block, as S3 keeps them, without
 * effect: kept for the move to AWS, where a site's bucket needs both. None
 * for every bucket there is. Down: both go.
 */
export class BucketPolicies1793720000000 implements MigrationInterface {
  name = 'BucketPolicies1793720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" ADD "policy" text`);
    await queryRunner.query(`ALTER TABLE "buckets" ADD "public_access_block" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" DROP COLUMN "public_access_block"`);
    await queryRunner.query(`ALTER TABLE "buckets" DROP COLUMN "policy"`);
  }
}
