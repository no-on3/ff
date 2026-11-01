import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' versions, as AWS Lambda's: each one frozen, its environment sealed
 * for it alone, going with its function; a function's revision, new with each
 * change, as Lambda's RevisionId, and the number of its last version, so that
 * none is given twice. A function there already gets a revision of its own and
 * no version. The SQL is TypeORM's, as the drift check printed it. Down: the
 * versions go, and their numbers with them.
 */
export class FunctionVersions1793535703682 implements MigrationInterface {
  name = 'FunctionVersions1793535703682';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "revision_id" uuid NOT NULL DEFAULT gen_random_uuid()`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "last_version" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_runtime_enum" AS ENUM('nodejs', 'python')`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_package_type_enum" AS ENUM('inline', 'zip')`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_event_format_enum" AS ENUM('lambda', 'wrapped')`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_aws_endpoints_enum" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(
      `CREATE TABLE "function_versions" ("function_id" uuid NOT NULL, "version" integer NOT NULL, "account_id" character(12) NOT NULL, "description" character varying(256) NOT NULL DEFAULT '', "runtime" "public"."function_versions_runtime_enum" NOT NULL, "handler" character varying(128) NOT NULL, "package_type" "public"."function_versions_package_type_enum" NOT NULL, "code" text NOT NULL, "code_sha256" character varying(44) NOT NULL, "code_size" integer NOT NULL, "package_sha256" character varying(44) NOT NULL, "memory" integer NOT NULL, "timeout" integer NOT NULL, "event_format" "public"."function_versions_event_format_enum" NOT NULL, "aws_endpoints" "public"."function_versions_aws_endpoints_enum" array NOT NULL, "environment" jsonb, "revision_id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_4bbb975f81f059327a3b92c433c" PRIMARY KEY ("function_id", "version"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_versions" ADD CONSTRAINT "FK_09eabee96a14e99dcf9775f327b" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_versions" DROP CONSTRAINT "FK_09eabee96a14e99dcf9775f327b"`);
    await queryRunner.query(`DROP TABLE "function_versions"`);
    await queryRunner.query(`DROP TYPE "public"."function_versions_aws_endpoints_enum"`);
    await queryRunner.query(`DROP TYPE "public"."function_versions_event_format_enum"`);
    await queryRunner.query(`DROP TYPE "public"."function_versions_package_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."function_versions_runtime_enum"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "last_version"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "revision_id"`);
  }
}
