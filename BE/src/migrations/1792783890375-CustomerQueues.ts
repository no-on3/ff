import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' queues, as Amazon SQS's standard queues (ADR 0010):
 * - each queue's SQS attributes, with SQS's defaults and ranges;
 * - a message moved to another queue, as a dead-letter queue takes one, moves
 *   its size with it, which the size trigger now follows;
 * - each message written, or moved, tells its queue's consumers at once, on
 *   the channel ff_queue with the queue's ID, as the ledger's writes are told:
 *   a long poll ends when a message comes.
 */
export class CustomerQueues1792783890375 implements MigrationInterface {
  name = 'CustomerQueues1792783890375';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "queues" ADD "visibility_timeout" integer NOT NULL DEFAULT '30'`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "message_retention_seconds" integer NOT NULL DEFAULT '345600'`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "delay_seconds" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "maximum_message_size" integer NOT NULL DEFAULT '1048576'`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "receive_wait_seconds" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "redrive_policy" jsonb`);
    await queryRunner.query(`ALTER TABLE "queues" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "queues" ADD CONSTRAINT "CHK_5bdc96dd16c65f10060dad66a8" CHECK ("receive_wait_seconds" BETWEEN 0 AND 20)`);
    await queryRunner.query(`ALTER TABLE "queues" ADD CONSTRAINT "CHK_c2f69f20a50fb84d0e190da2eb" CHECK ("maximum_message_size" BETWEEN 1024 AND 1048576)`);
    await queryRunner.query(`ALTER TABLE "queues" ADD CONSTRAINT "CHK_0d6a1298e81340343cb28e2c70" CHECK ("delay_seconds" BETWEEN 0 AND 900)`);
    await queryRunner.query(`ALTER TABLE "queues" ADD CONSTRAINT "CHK_61d4cc4f24cb257927b1d07cef" CHECK ("message_retention_seconds" BETWEEN 60 AND 1209600)`);
    await queryRunner.query(`ALTER TABLE "queues" ADD CONSTRAINT "CHK_102362c70abcc831f42aba193c" CHECK ("visibility_timeout" BETWEEN 0 AND 43200)`);
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "ff_queue_size"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP IN ('DELETE', 'UPDATE') THEN
           UPDATE "queues" SET "size_bytes" = "size_bytes" - OLD."size_bytes" WHERE "id" = OLD."queue_id";
         END IF;
         IF TG_OP IN ('INSERT', 'UPDATE') THEN
           UPDATE "queues" SET "size_bytes" = "size_bytes" + NEW."size_bytes" WHERE "id" = NEW."queue_id";
         END IF;
         RETURN NULL;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "queue_messages_moved" AFTER UPDATE OF "queue_id" ON "queue_messages"
       FOR EACH ROW WHEN (OLD."queue_id" IS DISTINCT FROM NEW."queue_id") EXECUTE FUNCTION "ff_queue_size"()`,
    );
    await queryRunner.query(
      `CREATE FUNCTION "ff_queue_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_notify('ff_queue', NEW."queue_id"::text);
         RETURN NULL;
       END $$`,
    );
    await queryRunner.query(`CREATE TRIGGER "queue_messages_notify" AFTER INSERT OR UPDATE OF "queue_id" ON "queue_messages" FOR EACH ROW EXECUTE FUNCTION "ff_queue_notify"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "queue_messages_notify" ON "queue_messages"`);
    await queryRunner.query(`DROP FUNCTION "ff_queue_notify"()`);
    await queryRunner.query(`DROP TRIGGER "queue_messages_moved" ON "queue_messages"`);
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "ff_queue_size"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           UPDATE "queues" SET "size_bytes" = "size_bytes" + NEW."size_bytes" WHERE "id" = NEW."queue_id";
         ELSE
           UPDATE "queues" SET "size_bytes" = "size_bytes" - OLD."size_bytes" WHERE "id" = OLD."queue_id";
         END IF;
         RETURN NULL;
       END $$`,
    );
    await queryRunner.query(`ALTER TABLE "queues" DROP CONSTRAINT "CHK_102362c70abcc831f42aba193c"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP CONSTRAINT "CHK_61d4cc4f24cb257927b1d07cef"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP CONSTRAINT "CHK_0d6a1298e81340343cb28e2c70"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP CONSTRAINT "CHK_c2f69f20a50fb84d0e190da2eb"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP CONSTRAINT "CHK_5bdc96dd16c65f10060dad66a8"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "updated_at"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "redrive_policy"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "receive_wait_seconds"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "maximum_message_size"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "delay_seconds"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "message_retention_seconds"`);
    await queryRunner.query(`ALTER TABLE "queues" DROP COLUMN "visibility_timeout"`);
  }
}
