import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScalingConfigFields1708361565000 implements MigrationInterface {
  name = 'AddScalingConfigFields1708361565000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "minInstances" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "maxInstances" integer NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "targetConcurrency" integer NOT NULL DEFAULT 100`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "scaleToZero" boolean NOT NULL DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "scaleToZero"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "targetConcurrency"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "maxInstances"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "minInstances"`);
  }
}
