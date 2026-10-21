import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' packages: a zip uploaded once, named by its SHA-256, its bytes in
 * object storage, and a row with its sizes and its files, which an account has
 * once whatever the uploads. The SQL is TypeORM's, as the drift check printed
 * it. Down: the table goes; the zips stay in object storage, under packages/,
 * for an operator to remove.
 */
export class Packages1792584171843 implements MigrationInterface {
  name = 'Packages1792584171843';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "packages" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "code_sha256" character varying(44) NOT NULL, "code_size" integer NOT NULL, "unpacked_size" integer NOT NULL, "file_count" integer NOT NULL, "files" text array NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_020801f620e21f943ead9311c98" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7bf519a25715e59fa7dfb27ea5" ON "packages" ("account_id", "code_sha256") `);
    await queryRunner.query(
      `ALTER TABLE "packages" ADD CONSTRAINT "FK_0a00edad8e2d33b5a35756aa565" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "packages"`);
  }
}
