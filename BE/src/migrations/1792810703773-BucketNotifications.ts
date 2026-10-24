import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buckets' notifications, as S3's (ADR 0010): each bucket's configurations,
 * the functions and queues its objects' events go to, in a column of its own,
 * which the S3 front door reads with the bucket. None for every bucket there
 * is. Down: the configurations go; no event is sent any more.
 */
export class BucketNotifications1792810703773 implements MigrationInterface {
  name = 'BucketNotifications1792810703773';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" ADD "notifications" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buckets" DROP COLUMN "notifications"`);
  }
}
