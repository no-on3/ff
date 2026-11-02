import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A capacity sample of each of a function's Deployments: $LATEST's, and each
 * version's, which runs in pods of its own at its own memory. The version
 * joins the primary key, 0 for $LATEST's rows, those before included, as a
 * key's column can't be null and no version is numbered 0. A column added to
 * the append-only table is no change of a sample. Down is refused once a
 * version's instances were sampled: one row a function and minute can't hold
 * them without counting them at $LATEST's memory, as before.
 */
export class CapacityVersions1793570000000 implements MigrationInterface {
  name = 'CapacityVersions1793570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "capacity_samples" ADD "version" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "capacity_samples" DROP CONSTRAINT "PK_f6df556caa34bb2152255864393"`);
    await queryRunner.query(`ALTER TABLE "capacity_samples" ADD CONSTRAINT "PK_ed3be01ba04c8fe4354fec646a6" PRIMARY KEY ("function_id", "version", "minute")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS "n" FROM "capacity_samples" WHERE "version" <> 0`)) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} capacity sample(s) of versions were taken: reverting would lose them, or count them at $LATEST's memory`);
    await queryRunner.query(`ALTER TABLE "capacity_samples" DROP CONSTRAINT "PK_ed3be01ba04c8fe4354fec646a6"`);
    await queryRunner.query(`ALTER TABLE "capacity_samples" DROP COLUMN "version"`);
    await queryRunner.query(`ALTER TABLE "capacity_samples" ADD CONSTRAINT "PK_f6df556caa34bb2152255864393" PRIMARY KEY ("function_id", "minute")`);
  }
}
