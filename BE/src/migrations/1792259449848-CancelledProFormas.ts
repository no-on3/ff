import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-74: a pending pro-forma can be cancelled, by its owner or an operator.
 * TypeORM's, as the drift check printed it: the status 'cancelled', and when
 * and by whom. A pending one is never marked cancelled; a cancelled one that a
 * transfer pays anyway keeps when it was cancelled.
 * Down: refused while a payment was cancelled, as the old status check
 * refuses its status, and setting it back would lose the cancellation.
 */
export class CancelledProFormas1792259449848 implements MigrationInterface {
  name = 'CancelledProFormas1792259449848';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "CHK_4253d8531237d41f38f34915fb"`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "cancelled_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "cancelled_by" text`);
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "CHK_67b14a70c30673f7e1ef7250fb" CHECK (("cancelled_at" IS NULL) = ("cancelled_by" IS NULL) AND ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL) AND ("status" <> 'pending' OR "cancelled_at" IS NULL))`,
    );
    await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "CHK_22829cf86937a7c3f29767a73d" CHECK ("status" IN ('pending', 'paid', 'cancelled'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS "n" FROM "payments" WHERE "cancelled_at" IS NOT NULL`)) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} pro-forma(s) were cancelled: reverting would lose that`);
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "CHK_22829cf86937a7c3f29767a73d"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "CHK_67b14a70c30673f7e1ef7250fb"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "cancelled_by"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "cancelled_at"`);
    await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "CHK_4253d8531237d41f38f34915fb" CHECK ("status" IN ('pending', 'paid'))`);
  }
}
