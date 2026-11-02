import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function URL for each of a function's aliases, as Lambda's, beside
 * $LATEST's: a URL names its alias, null for $LATEST's, and is its function's
 * and alias's once, $LATEST's once too; deleting the alias deletes its URL.
 * The URL's ID becomes its key, as the function's no longer is, and a custom
 * domain names the URL it serves by that ID, the function's beside it, so that
 * a domain may serve an alias's URL; those before serve their function's
 * $LATEST URL, its only one. Down is refused once an alias has a URL: one URL
 * a function can't hold them.
 */
export class UrlAliases1793580000000 implements MigrationInterface {
  name = 'UrlAliases1793580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "FK_002f32810a5fead1a88b32c97a8"`);
    await queryRunner.query(`ALTER TABLE "function_urls" ADD "alias" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "function_urls" DROP CONSTRAINT "PK_e8d799fc6b7ba4766654ed07122"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8919fa7b9efdf7951dd8f10044"`);
    await queryRunner.query(`ALTER TABLE "function_urls" ADD CONSTRAINT "PK_8919fa7b9efdf7951dd8f100443" PRIMARY KEY ("url_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3a0a42af563af926a60d8a0e53" ON "function_urls" ("function_id", "alias") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_function_urls_latest" ON "function_urls" ("function_id") WHERE "alias" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "function_urls" ADD CONSTRAINT "FK_3a0a42af563af926a60d8a0e539" FOREIGN KEY ("function_id", "alias") REFERENCES "function_aliases"("function_id","name") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`ALTER TABLE "custom_domains" ADD "url_id" character(32)`);
    await queryRunner.query(`UPDATE "custom_domains" d SET "url_id" = u."url_id" FROM "function_urls" u WHERE u."function_id" = d."function_id"`);
    await queryRunner.query(`CREATE INDEX "IDX_6c565f31f2f625247534197648" ON "custom_domains" ("url_id") `);
    await queryRunner.query(`ALTER TABLE "custom_domains" ADD CONSTRAINT "CHK_2aa89487d96415936ad845980a" CHECK (("function_id" IS NULL) = ("url_id" IS NULL))`);
    await queryRunner.query(
      `ALTER TABLE "custom_domains" ADD CONSTRAINT "FK_6c565f31f2f6252475341976485" FOREIGN KEY ("url_id") REFERENCES "function_urls"("url_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS "n" FROM "function_urls" WHERE "alias" IS NOT NULL`)) as Array<{ n: number }>;
    if (n > 0) throw new Error(`${n} alias(es) have a URL: reverting would delete them, as a function has one URL at most before`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "FK_6c565f31f2f6252475341976485"`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "CHK_2aa89487d96415936ad845980a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6c565f31f2f625247534197648"`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP COLUMN "url_id"`);
    await queryRunner.query(`ALTER TABLE "function_urls" DROP CONSTRAINT "FK_3a0a42af563af926a60d8a0e539"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_function_urls_latest"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3a0a42af563af926a60d8a0e53"`);
    await queryRunner.query(`ALTER TABLE "function_urls" DROP CONSTRAINT "PK_8919fa7b9efdf7951dd8f100443"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8919fa7b9efdf7951dd8f10044" ON "function_urls" ("url_id") `);
    await queryRunner.query(`ALTER TABLE "function_urls" ADD CONSTRAINT "PK_e8d799fc6b7ba4766654ed07122" PRIMARY KEY ("function_id")`);
    await queryRunner.query(`ALTER TABLE "function_urls" DROP COLUMN "alias"`);
    await queryRunner.query(
      `ALTER TABLE "custom_domains" ADD CONSTRAINT "FK_002f32810a5fead1a88b32c97a8" FOREIGN KEY ("function_id") REFERENCES "function_urls"("function_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
