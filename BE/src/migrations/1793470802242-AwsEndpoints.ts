import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The services whose endpoint FF gives a function, with its key: every one for
 * every function, as before, until its owner sends one to AWS's own, a service
 * at a time. The SQL is TypeORM's, as the drift check printed it. Down: the
 * column goes, and every function gets every endpoint again at its next
 * rollout.
 */
export class AwsEndpoints1793470802242 implements MigrationInterface {
  name = 'AwsEndpoints1793470802242';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."functions_aws_endpoints_enum" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "aws_endpoints" "public"."functions_aws_endpoints_enum" array NOT NULL DEFAULT '{s3,sqs,sesv2}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "aws_endpoints"`);
    await queryRunner.query(`DROP TYPE "public"."functions_aws_endpoints_enum"`);
  }
}
