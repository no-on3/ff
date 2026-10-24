import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each message written, or moved, tells its consumers on the channel of its
 * kind: a customer's queue's on ff_queue, as before, which long polls wait
 * for; a function's asynchronous call on ff_async, which the worker waits for,
 * so that it starts a call as soon as it is kept rather than at its next look.
 * Both name the queue.
 */
export class AsyncNotify1792790149607 implements MigrationInterface {
  name = 'AsyncNotify1792790149607';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "ff_queue_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_notify(CASE WHEN NEW."function_id" IS NULL THEN 'ff_queue' ELSE 'ff_async' END, NEW."queue_id"::text);
         RETURN NULL;
       END $$`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "ff_queue_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_notify('ff_queue', NEW."queue_id"::text);
         RETURN NULL;
       END $$`,
    );
  }
}
