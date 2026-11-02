import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lambda's endpoint among the services whose endpoint FF gives a function
 * (ADR 0014): the type of a function's list, of a version's and of a key's
 * use. A function or a version that took every endpoint there was takes
 * Lambda's too, as one made now does, so that its key's revision is the key's
 * ID alone, as before, and none of its pods is replaced for it: each gets
 * AWS_ENDPOINT_URL_LAMBDA at its next rollout, at the latest its key's renewal.
 * One that sent a service to AWS's own keeps its list as it was. The types'
 * SQL is TypeORM's, as the drift check printed it. Down: Lambda's leaves every
 * list, and the keys' uses of it go.
 */
export class LambdaEndpoint1793630000000 implements MigrationInterface {
  name = 'LambdaEndpoint1793630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."functions_aws_endpoints_enum" RENAME TO "functions_aws_endpoints_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."functions_aws_endpoints_enum" AS ENUM('s3', 'sqs', 'sesv2', 'lambda')`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" TYPE "public"."functions_aws_endpoints_enum"[] USING "aws_endpoints"::"text"::"public"."functions_aws_endpoints_enum"[]`,
    );
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" SET DEFAULT '{s3,sqs,sesv2,lambda}'`);
    await queryRunner.query(`DROP TYPE "public"."functions_aws_endpoints_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."function_versions_aws_endpoints_enum" RENAME TO "function_versions_aws_endpoints_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_aws_endpoints_enum" AS ENUM('s3', 'sqs', 'sesv2', 'lambda')`);
    await queryRunner.query(
      `ALTER TABLE "function_versions" ALTER COLUMN "aws_endpoints" TYPE "public"."function_versions_aws_endpoints_enum"[] USING "aws_endpoints"::"text"::"public"."function_versions_aws_endpoints_enum"[]`,
    );
    await queryRunner.query(`DROP TYPE "public"."function_versions_aws_endpoints_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."key_uses_service_enum" RENAME TO "key_uses_service_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."key_uses_service_enum" AS ENUM('s3', 'sqs', 'sesv2', 'lambda')`);
    await queryRunner.query(`ALTER TABLE "key_uses" ALTER COLUMN "service" TYPE "public"."key_uses_service_enum" USING "service"::"text"::"public"."key_uses_service_enum"`);
    await queryRunner.query(`DROP TYPE "public"."key_uses_service_enum_old"`);
    // Every endpoint there was, in their order, is every one there is now.
    for (const table of ['functions', 'function_versions']) {
      await queryRunner.query(`UPDATE "${table}" SET "aws_endpoints" = array_append("aws_endpoints", 'lambda') WHERE "aws_endpoints" @> '{s3,sqs,sesv2}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['functions', 'function_versions']) {
      await queryRunner.query(`UPDATE "${table}" SET "aws_endpoints" = array_remove("aws_endpoints", 'lambda') WHERE 'lambda' = ANY("aws_endpoints")`);
    }
    await queryRunner.query(`DELETE FROM "key_uses" WHERE "service" = 'lambda'`);
    await queryRunner.query(`CREATE TYPE "public"."key_uses_service_enum_old" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(
      `ALTER TABLE "key_uses" ALTER COLUMN "service" TYPE "public"."key_uses_service_enum_old" USING "service"::"text"::"public"."key_uses_service_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."key_uses_service_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."key_uses_service_enum_old" RENAME TO "key_uses_service_enum"`);
    await queryRunner.query(`CREATE TYPE "public"."function_versions_aws_endpoints_enum_old" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(
      `ALTER TABLE "function_versions" ALTER COLUMN "aws_endpoints" TYPE "public"."function_versions_aws_endpoints_enum_old"[] USING "aws_endpoints"::"text"::"public"."function_versions_aws_endpoints_enum_old"[]`,
    );
    await queryRunner.query(`DROP TYPE "public"."function_versions_aws_endpoints_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."function_versions_aws_endpoints_enum_old" RENAME TO "function_versions_aws_endpoints_enum"`);
    await queryRunner.query(`CREATE TYPE "public"."functions_aws_endpoints_enum_old" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" TYPE "public"."functions_aws_endpoints_enum_old"[] USING "aws_endpoints"::"text"::"public"."functions_aws_endpoints_enum_old"[]`,
    );
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "aws_endpoints" SET DEFAULT '{s3,sqs,sesv2}'`);
    await queryRunner.query(`DROP TYPE "public"."functions_aws_endpoints_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."functions_aws_endpoints_enum_old" RENAME TO "functions_aws_endpoints_enum"`);
  }
}
