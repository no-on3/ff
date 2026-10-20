import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A closed account's functions, their invocation history and logs are deleted
 * once its notice period has passed, on a date kept on the account. TypeORM's
 * SQL, as the drift check printed it, with one step between: an account closed
 * before this migration was never told a date, so it gets the whole default
 * notice, 30 days, from now.
 * Down: the dates go. When each account's data was deleted stays in its audit
 * log (account.data_delete); nothing else is lost, so the rollback isn't refused.
 */
export class ClosedAccountDeletion1792325241958 implements MigrationInterface {
  name = 'ClosedAccountDeletion1792325241958';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" ADD "data_deletion_due_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD "data_deleted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`UPDATE "accounts" SET "data_deletion_due_at" = now() + interval '30 days' WHERE "status" = 'closed'`);
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "CHK_8d71862d970ff958b11edf4768" CHECK ("data_deleted_at" IS NULL OR "data_deletion_due_at" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "CHK_04f2629546eaf1061421cd27de" CHECK (("status" = 'closed') = ("data_deletion_due_at" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_04f2629546eaf1061421cd27de"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_8d71862d970ff958b11edf4768"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "data_deleted_at"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "data_deletion_due_at"`);
  }
}
