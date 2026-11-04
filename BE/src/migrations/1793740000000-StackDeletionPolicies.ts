import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each stack resource's DeletionPolicy, as CloudFormation keeps it from the
 * template that made the resource: Retain leaves what it made in the account
 * once the template, or the stack, has it no more. Delete for every resource
 * there is, as before. Down: the column goes.
 */
export class StackDeletionPolicies1793740000000 implements MigrationInterface {
  name = 'StackDeletionPolicies1793740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stack_resources" ADD "deletion_policy" character varying(6) NOT NULL DEFAULT 'Delete'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stack_resources" DROP COLUMN "deletion_policy"`);
  }
}
