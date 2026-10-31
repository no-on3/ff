import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' own domains for buckets' sites, beside those for function URLs:
 * a domain serves a function's URL or a bucket's site, never both, and goes
 * with its bucket. Down: the sites' domains go, their certificates no longer
 * given.
 */
export class SiteDomains1793324361034 implements MigrationInterface {
  name = 'SiteDomains1793324361034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "custom_domains" ALTER COLUMN "function_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "custom_domains" ADD "bucket_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_c21a339dc4635bbccfd8cd1067" ON "custom_domains" ("bucket_id") `);
    await queryRunner.query(`ALTER TABLE "custom_domains" ADD CONSTRAINT "CHK_44046e77f5307399fcd8939c15" CHECK (("function_id" IS NULL) <> ("bucket_id" IS NULL))`);
    await queryRunner.query(
      `ALTER TABLE "custom_domains" ADD CONSTRAINT "FK_c21a339dc4635bbccfd8cd1067a" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "custom_domains" WHERE "bucket_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "FK_c21a339dc4635bbccfd8cd1067a"`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "CHK_44046e77f5307399fcd8939c15"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c21a339dc4635bbccfd8cd1067"`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP COLUMN "bucket_id"`);
    await queryRunner.query(`ALTER TABLE "custom_domains" ALTER COLUMN "function_id" SET NOT NULL`);
  }
}
