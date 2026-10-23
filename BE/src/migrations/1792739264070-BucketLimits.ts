import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The plans' limits on buckets (ADR 0009): every plan gets the beta plan's,
 * five buckets holding 5 GB together, S3's free tier; 100 requests a second;
 * objects of 5 GB in one PutObject, as S3 allows. Operators change them from
 * the admin dashboard.
 */
export class BucketLimits1792739264070 implements MigrationInterface {
  name = 'BucketLimits1792739264070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "plans" SET "limits" = "limits" || '{"buckets": 5, "bucketStorageMb": 5120, "storageRequestsPerSecond": 100, "maxObjectMb": 5120}'::jsonb WHERE NOT ("limits" ? 'buckets')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'buckets' - 'bucketStorageMb' - 'storageRequestsPerSecond' - 'maxObjectMb'`);
  }
}
