import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An alarm may watch a customer's bucket (ADR 0009): what it holds and its
 * requests, as CloudWatch's alarms on S3's metrics name a BucketName. The
 * alarm goes with the bucket. As the drift check printed it.
 */
export class BucketAlarms1792748816752 implements MigrationInterface {
  name = 'BucketAlarms1792748816752';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarms" ADD "bucket_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_99e188b60d5d24519fb5877e8d" ON "alarms" ("bucket_id") `);
    await queryRunner.query(
      `ALTER TABLE "alarms" ADD CONSTRAINT "FK_99e188b60d5d24519fb5877e8db" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_99e188b60d5d24519fb5877e8db"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_99e188b60d5d24519fb5877e8d"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "bucket_id"`);
  }
}
