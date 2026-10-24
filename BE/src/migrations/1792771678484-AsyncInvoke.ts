import { MigrationInterface, QueryRunner } from 'typeorm';

const SOURCES_BEFORE = `'api', 'url', 'schedule'`;

/**
 * The queue in FF's database (ADR 0010), and asynchronous calls:
 * - `queues`, a customer's or a function's own, and `queue_messages`, every
 *   queue's messages in one table, in pgmq's shape, claimed with leases;
 * - each queue's `size_bytes`, what its messages hold together, kept by a
 *   trigger with each message written and deleted, so that the plan's limit
 *   on them reads the account's few queues rather than its messages;
 * - the history's `request_id`, every attempt of an asynchronous call keeping
 *   the first's, as Lambda's retries do; a call before is its own request, so
 *   its ID is copied, and so is a new row's that names none, by a trigger;
 *   and `attempt`, and the source `async`.
 * Down: the tables go with their messages; asynchronous calls in the history
 * become the API's, which they came through.
 */
export class AsyncInvoke1792771678484 implements MigrationInterface {
  name = 'AsyncInvoke1792771678484';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "queues" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "name" text NOT NULL, "kind" text NOT NULL, "function_id" uuid, "size_bytes" bigint NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_6da227b60b6d1e114665517db5" CHECK (("kind" = 'function') = ("function_id" IS NOT NULL)), CONSTRAINT "CHK_d421f330200e6ab733ea6751f8" CHECK ("kind" IN ('customer', 'function')), CONSTRAINT "PK_d966f9eb39a9396658387071bb3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_98b87d072bdaab429c66b6ecac" ON "queues" ("account_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b14cf7f63c496fd2545049c718" ON "queues" ("function_id") WHERE "kind" = 'function'`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_be81be978d218d9befc3161b60" ON "queues" ("account_id", "name") WHERE "kind" = 'customer'`);
    await queryRunner.query(
      `ALTER TABLE "queues" ADD CONSTRAINT "FK_dfd47ff4311f7966d19ae342ffb" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE TABLE "queue_messages" ("id" BIGSERIAL NOT NULL, "queue_id" uuid NOT NULL, "function_id" uuid, "message_id" uuid NOT NULL, "body" text NOT NULL, "attributes" jsonb, "size_bytes" integer NOT NULL, "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "visible_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "receive_count" integer NOT NULL DEFAULT '0', "first_received_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a03df786f4a362bac2b807f4f95" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_c4b9b2c4d6af8ca3ccecc58c36" ON "queue_messages" ("visible_at") WHERE "function_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_e7f15d314be9d905ab691c7357" ON "queue_messages" ("expires_at") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_abb14de39c0a3b05b607e4bbd4" ON "queue_messages" ("queue_id", "message_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_68fac5b27b78abf0c21f053a37" ON "queue_messages" ("queue_id", "visible_at", "id") `);
    await queryRunner.query(
      `ALTER TABLE "queue_messages" ADD CONSTRAINT "FK_b14aa83824841b32babedaa22ea" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // A queue deleted takes its messages along, whose deletes find it gone: nothing to keep then.
    await queryRunner.query(
      `CREATE FUNCTION "ff_queue_size"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           UPDATE "queues" SET "size_bytes" = "size_bytes" + NEW."size_bytes" WHERE "id" = NEW."queue_id";
         ELSE
           UPDATE "queues" SET "size_bytes" = "size_bytes" - OLD."size_bytes" WHERE "id" = OLD."queue_id";
         END IF;
         RETURN NULL;
       END $$`,
    );
    await queryRunner.query(`CREATE TRIGGER "queue_messages_size" AFTER INSERT OR DELETE ON "queue_messages" FOR EACH ROW EXECUTE FUNCTION "ff_queue_size"()`);

    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "request_id" uuid`);
    await queryRunner.query(`UPDATE "function_invocations" SET "request_id" = "id"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ALTER COLUMN "request_id" SET NOT NULL`);
    await queryRunner.query(
      `CREATE FUNCTION "ff_own_request"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         NEW."request_id" := coalesce(NEW."request_id", NEW."id");
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(`CREATE TRIGGER "function_invocations_own_request" BEFORE INSERT ON "function_invocations" FOR EACH ROW EXECUTE FUNCTION "ff_own_request"()`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ADD "attempt" smallint NOT NULL DEFAULT '1'`);
    await queryRunner.query(`CREATE INDEX "IDX_388d7dc0cf79d47754035d3637" ON "function_invocations" ("request_id") `);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_source_enum" ADD VALUE 'async'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "function_invocations" SET "source" = 'api' WHERE "source" = 'async'`);
    await queryRunner.query(`ALTER TYPE "public"."function_invocations_source_enum" RENAME TO "function_invocations_source_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."function_invocations_source_enum" AS ENUM(${SOURCES_BEFORE})`);
    await queryRunner.query(`ALTER TABLE "function_invocations" ALTER COLUMN "source" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "function_invocations" ALTER COLUMN "source" TYPE "public"."function_invocations_source_enum" USING "source"::"text"::"public"."function_invocations_source_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "function_invocations" ALTER COLUMN "source" SET DEFAULT 'api'`);
    await queryRunner.query(`DROP TYPE "public"."function_invocations_source_enum_old"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_388d7dc0cf79d47754035d3637"`);
    await queryRunner.query(`DROP TRIGGER "function_invocations_own_request" ON "function_invocations"`);
    await queryRunner.query(`DROP FUNCTION "ff_own_request"()`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "attempt"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP COLUMN "request_id"`);

    await queryRunner.query(`DROP TABLE "queue_messages"`);
    await queryRunner.query(`DROP FUNCTION "ff_queue_size"()`);
    await queryRunner.query(`DROP TABLE "queues"`);
  }
}
