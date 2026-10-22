import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inline code on the packages' path (ADR 0003): each function names the
 * package its pods run, its own for a package function, and for inline code the
 * one-file package the backend makes of it; the hourly purge keeps what a
 * function names. A package the backend made of inline code is no upload: the
 * account's list of packages, and its limit of unused ones, leave it out.
 * Package functions name theirs at once; inline ones at their next rollout,
 * their pods reading their code ConfigMap until then. The SQL is TypeORM's, as
 * the drift check printed it. Down: the columns go, and the next rollout of an
 * inline function makes a ConfigMap again with a backend from before.
 */
export class InlineCodePackages1792596918071 implements MigrationInterface {
  name = 'InlineCodePackages1792596918071';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "package_sha256" character varying(44)`);
    await queryRunner.query(`UPDATE "functions" SET "package_sha256" = "code_sha256" WHERE "package_type" = 'zip'`);
    await queryRunner.query(`ALTER TABLE "packages" ADD "inline" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "packages" DROP COLUMN "inline"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "package_sha256"`);
  }
}
