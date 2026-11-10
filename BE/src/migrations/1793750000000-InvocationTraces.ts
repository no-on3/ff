import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each call's trace, in AWS X-Ray's format, which a call's entry starts or
 * takes from its caller, and what brought it beyond its source (a schedule's
 * name, a queue's and its message's, a bucket's, the call whose record it
 * was), so that one request's calls are found together, in time order. A
 * trace is found by its ID, then kept to the reader's account through the
 * call's function: a trace's calls are few, and its ID is the caller's to
 * choose, so two accounts may share one. Calls made before have neither. Down:
 * both go.
 */
export class InvocationTraces1793750000000 implements MigrationInterface {
  name = 'InvocationTraces1793750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "trace_id" character varying(35)`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "trigger" jsonb`);
    await queryRunner.query(`CREATE INDEX "IDX_9a9e201793779d3ee602309e51" ON "function_invocations" ("trace_id", "created_at") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_9a9e201793779d3ee602309e51"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "trigger"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "trace_id"`);
  }
}
