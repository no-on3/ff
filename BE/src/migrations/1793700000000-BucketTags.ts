import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tags on buckets, as S3's, in the table functions' tags are in: each row a
 * function's or a bucket's, by its column, and going with it. Names as TypeORM
 * gives them. Down: buckets' tags go, and a row is a function's again.
 */
export class BucketTags1793700000000 implements MigrationInterface {
  name = 'BucketTags1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_tags" ADD "bucket_id" uuid`);
    await queryRunner.query(`ALTER TABLE "resource_tags" ALTER COLUMN "function_id" DROP NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e17ee95ca275adde65bd53cf70" ON "resource_tags" ("bucket_id", "key") `);
    await queryRunner.query(`ALTER TABLE "resource_tags" ADD CONSTRAINT "CHK_ad11c9ea380ab9702e00a3709f" CHECK (num_nonnulls("function_id", "bucket_id") = 1)`);
    await queryRunner.query(
      `ALTER TABLE "resource_tags" ADD CONSTRAINT "FK_4ccf28c01c5bc3f39b526756417" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "resource_tags" WHERE "bucket_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "FK_4ccf28c01c5bc3f39b526756417"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "CHK_ad11c9ea380ab9702e00a3709f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_e17ee95ca275adde65bd53cf70"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" ALTER COLUMN "function_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP COLUMN "bucket_id"`);
  }
}
