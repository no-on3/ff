import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sites' requests, counted in buckets' minutes in a class of their own,
 * "website", billed as S3's second class but read apart for the sites' own
 * measures and the plan's monthly limit on what they send out; and that limit
 * in every plan, the beta plan's 10 GB a month, which operators change from
 * the admin dashboard. Down: the limit goes; the sites' minutes go too, as
 * the counts' table can't keep a class it no longer knows.
 */
export class SiteTransfer1793323792268 implements MigrationInterface {
  name = 'SiteTransfer1793323792268';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_request_counts" DROP CONSTRAINT "CHK_9d279feb676d585c657a8f2204"`);
    await queryRunner.query(`ALTER TABLE "storage_request_counts" ADD CONSTRAINT "CHK_6e924cbd909b580f26c108a124" CHECK ("class" IN ('tier1', 'tier2', 'free', 'website'))`);
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"siteTransferGbPerMonth": 10}'::jsonb WHERE NOT ("limits" ? 'siteTransferGbPerMonth')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'siteTransferGbPerMonth'`);
    // The counts are append-only: their trigger is set aside for this one change, as nothing else may delete them.
    await queryRunner.query(`ALTER TABLE "storage_request_counts" DISABLE TRIGGER "storage_request_counts_append_only"`);
    await queryRunner.query(`DELETE FROM "storage_request_counts" WHERE "class" = 'website'`);
    await queryRunner.query(`ALTER TABLE "storage_request_counts" ENABLE TRIGGER "storage_request_counts_append_only"`);
    await queryRunner.query(`ALTER TABLE "storage_request_counts" DROP CONSTRAINT "CHK_6e924cbd909b580f26c108a124"`);
    await queryRunner.query(`ALTER TABLE "storage_request_counts" ADD CONSTRAINT "CHK_9d279feb676d585c657a8f2204" CHECK ("class" IN ('tier1', 'tier2', 'free'))`);
  }
}
