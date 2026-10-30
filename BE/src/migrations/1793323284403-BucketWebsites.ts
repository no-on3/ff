import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buckets' website configurations, as S3's: each bucket's, in a column of its
 * own, which makes it a site, public to read at its website address. None for
 * every bucket there is. Down: every site goes, its files kept, private again.
 */
export class BucketWebsites1793323284403 implements MigrationInterface {
  name = 'BucketWebsites1793323284403';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" ADD "website" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" DROP COLUMN "website"`);
  }
}
