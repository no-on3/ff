import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's dead-letter queue, as Lambda's DeadLetterConfig (ADR 0014): a
 * queue of the account, by its ARN, which gets the event of an asynchronous
 * call that failed for good. None for every function there is. The schema's
 * SQL is TypeORM's, as the drift check printed it. Down: it goes.
 */
export class FunctionDeadLetterQueues1793670000000 implements MigrationInterface {
  name = 'FunctionDeadLetterQueues1793670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" ADD "dead_letter_target_arn" character varying(256)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "dead_letter_target_arn"`);
  }
}
