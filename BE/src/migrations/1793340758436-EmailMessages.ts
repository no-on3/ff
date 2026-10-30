import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' messages (ADR 0012): each one an account sent through the SES
 * endpoint, queued until the server of customers' mail takes it, then what
 * became of each recipient; and each account's sending, out of the sandbox,
 * paused, or reviewed past its rates, a new account having no row. The columns,
 * keys, indexes and checks are TypeORM's, as the drift check printed them.
 */
export class EmailMessages1793340758436 implements MigrationInterface {
  name = 'EmailMessages1793340758436';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_messages" ("id" uuid NOT NULL, "account_id" character(12) NOT NULL, "identity" character varying(320) NOT NULL, "from_address" character varying(320) NOT NULL, "return_path" character varying(400) NOT NULL, "recipients" jsonb NOT NULL, "recipient_count" integer NOT NULL, "size_bytes" integer NOT NULL, "raw" bytea, "status" text NOT NULL DEFAULT 'QUEUED', "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "sent_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_25b22a93f5845aaaaf4edab657" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED')), CONSTRAINT "PK_922cad79d5a315f5d1d06b077da" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_32f6d30a07b13641a292dcb95f" ON "email_messages" ("status", "next_attempt_at") `);
    await queryRunner.query(`CREATE INDEX "IDX_0caf9777d6bd619e5390bca82a" ON "email_messages" ("account_id", "created_at") `);
    await queryRunner.query(
      `CREATE TABLE "email_sending" ("account_id" character(12) NOT NULL, "production_access" boolean NOT NULL DEFAULT false, "sending_enabled" boolean NOT NULL DEFAULT true, "enforcement_status" text NOT NULL DEFAULT 'HEALTHY', "reason" text, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_b19e5a841fa99b739bb74a23a5" CHECK ("enforcement_status" IN ('HEALTHY', 'PROBATION', 'SHUTDOWN')), CONSTRAINT "PK_32b102c0a7d2f396da2cda6449c" PRIMARY KEY ("account_id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_sending"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0caf9777d6bd619e5390bca82a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_32f6d30a07b13641a292dcb95f"`);
    await queryRunner.query(`DROP TABLE "email_messages"`);
  }
}
