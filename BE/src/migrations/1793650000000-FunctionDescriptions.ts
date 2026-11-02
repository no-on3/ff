import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's description and role, as Lambda's CreateFunction gives them
 * (ADR 0014): the description up to 256 characters, empty for each function
 * there is; the role's ARN kept as given, none for a function made through
 * FF's API. The SQL is TypeORM's, as the drift check printed it. Down: both go.
 */
export class FunctionDescriptions1793650000000 implements MigrationInterface {
  name = 'FunctionDescriptions1793650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "description" character varying(256) NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "role" character varying(2048)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "role"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "description"`);
  }
}
