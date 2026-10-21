import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' URLs, as AWS Lambda's: one per function, its random ID the host's
 * first label, unique; and what brought each invocation, the API by default,
 * which every invocation so far was (a default PostgreSQL stores without
 * rewriting the table). The SQL is TypeORM's, as the drift check printed it.
 */
export class FunctionUrls1792559781729 implements MigrationInterface {
  name = 'FunctionUrls1792559781729';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."function_urls_auth_type_enum" AS ENUM('NONE', 'AWS_IAM')`);
    await queryRunner.query(`CREATE TYPE "public"."function_urls_invoke_mode_enum" AS ENUM('BUFFERED')`);
    await queryRunner.query(
      `CREATE TABLE "function_urls" ("function_id" uuid NOT NULL, "account_id" character(12) NOT NULL, "url_id" character(32) NOT NULL, "auth_type" "public"."function_urls_auth_type_enum" NOT NULL, "cors" jsonb, "invoke_mode" "public"."function_urls_invoke_mode_enum" NOT NULL DEFAULT 'BUFFERED', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e8d799fc6b7ba4766654ed07122" PRIMARY KEY ("function_id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8919fa7b9efdf7951dd8f10044" ON "function_urls" ("url_id") `);
    await queryRunner.query(`CREATE TYPE "public"."function_invocations_source_enum" AS ENUM('api', 'url', 'schedule')`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "source" "public"."function_invocations_source_enum" NOT NULL DEFAULT 'api'`);
    await queryRunner.query(
      `ALTER TABLE "function_urls" ADD CONSTRAINT "FK_e8d799fc6b7ba4766654ed07122" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_urls" DROP CONSTRAINT "FK_e8d799fc6b7ba4766654ed07122"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "source"`);
    await queryRunner.query(`DROP TYPE "public"."function_invocations_source_enum"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8919fa7b9efdf7951dd8f10044"`);
    await queryRunner.query(`DROP TABLE "function_urls"`);
    await queryRunner.query(`DROP TYPE "public"."function_urls_invoke_mode_enum"`);
    await queryRunner.query(`DROP TYPE "public"."function_urls_auth_type_enum"`);
  }
}
