import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the account's keys use of its buckets, queues and mail, a row per
 * holder, service, resource and operation, with its first and last day, which
 * the front doors note from now on, so that an export months from now makes
 * each function's role of what it used. The SQL is TypeORM's, as the drift
 * check printed it. Down: the table goes, and what it noted with it.
 */
export class KeyUses1793472304822 implements MigrationInterface {
  name = 'KeyUses1793472304822';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."key_uses_service_enum" AS ENUM('s3', 'sqs', 'sesv2')`);
    await queryRunner.query(
      `CREATE TABLE "key_uses" ("holder" character varying(36) NOT NULL, "service" "public"."key_uses_service_enum" NOT NULL, "resource" character varying(320) NOT NULL, "operation" character varying(64) NOT NULL, "account_id" character(12) NOT NULL, "first_day" date NOT NULL, "last_day" date NOT NULL, CONSTRAINT "PK_3c319ec03a2537c13827c92e03c" PRIMARY KEY ("holder", "service", "resource", "operation"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_3c7cd3445738c25f642ad75fee" ON "key_uses" ("account_id", "last_day") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_3c7cd3445738c25f642ad75fee"`);
    await queryRunner.query(`DROP TABLE "key_uses"`);
    await queryRunner.query(`DROP TYPE "public"."key_uses_service_enum"`);
  }
}
