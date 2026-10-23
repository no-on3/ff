import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' databases operated (ADR 0008): an alarm may watch a database,
 * and goes with it; FF's operator may turn an account's databases and
 * buckets off, with a reason, its functions going on. The SQL is TypeORM's,
 * as the drift check printed it.
 * Down: the alarms on a database go, as they can't be without it; then the
 * columns.
 */
export class DatabaseOperations1792731046155 implements MigrationInterface {
  name = 'DatabaseOperations1792731046155';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" ADD "storage_disabled_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD "storage_disabled_reason" text`);
    await queryRunner.query(`ALTER TABLE "alarms" ADD "database_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_ecd2efd50a0af5c9656bd3ac9c" ON "alarms" ("database_id") `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "CHK_8db4addf372d9b408d2cd5ff5d" CHECK (("storage_disabled_at" IS NULL) = ("storage_disabled_reason" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "alarms" ADD CONSTRAINT "FK_ecd2efd50a0af5c9656bd3ac9c5" FOREIGN KEY ("database_id") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "alarms" WHERE "database_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_ecd2efd50a0af5c9656bd3ac9c5"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_8db4addf372d9b408d2cd5ff5d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ecd2efd50a0af5c9656bd3ac9c"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "database_id"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "storage_disabled_reason"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "storage_disabled_at"`);
  }
}
