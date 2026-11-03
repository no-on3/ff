import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tags on queues, as SQS's, beside functions' and buckets': each row one
 * resource's, by its column, and going with it. Names as TypeORM gives them.
 * Down: queues' tags go, and a row is a function's or a bucket's again.
 */
export class QueueTags1793710000000 implements MigrationInterface {
  name = 'QueueTags1793710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "CHK_ad11c9ea380ab9702e00a3709f"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" ADD "queue_id" uuid`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e2716b4a6c92b150813f1f215d" ON "resource_tags" ("queue_id", "key") `);
    await queryRunner.query(`ALTER TABLE "resource_tags" ADD CONSTRAINT "CHK_ea1b4c2701395ed73d3e0cb7df" CHECK (num_nonnulls("function_id", "bucket_id", "queue_id") = 1)`);
    await queryRunner.query(
      `ALTER TABLE "resource_tags" ADD CONSTRAINT "FK_18aa95d6a72d9667828db2b00a0" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "resource_tags" WHERE "queue_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "FK_18aa95d6a72d9667828db2b00a0"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP CONSTRAINT "CHK_ea1b4c2701395ed73d3e0cb7df"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_e2716b4a6c92b150813f1f215d"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" DROP COLUMN "queue_id"`);
    await queryRunner.query(`ALTER TABLE "resource_tags" ADD CONSTRAINT "CHK_ad11c9ea380ab9702e00a3709f" CHECK (num_nonnulls("function_id", "bucket_id") = 1)`);
  }
}
