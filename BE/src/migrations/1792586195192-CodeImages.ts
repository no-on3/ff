import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' code images (ADR 0003): each package's image digest, once the
 * backend has made and pushed it; and when a package was last used, its
 * upload or a function naming it, which the retention job counts its hour from.
 * A package there already counts from now. The SQL is TypeORM's, as the drift
 * check printed it. Down: the columns go; the images stay in the registry, and
 * a backend that has the columns again makes them again when a function needs
 * one it can't find.
 */
export class CodeImages1792586195192 implements MigrationInterface {
  name = 'CodeImages1792586195192';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "packages" ADD "image_digest" character varying(71)`);
    await queryRunner.query(`ALTER TABLE "packages" ADD "used_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "packages" DROP COLUMN "used_at"`);
    await queryRunner.query(`ALTER TABLE "packages" DROP COLUMN "image_digest"`);
  }
}
