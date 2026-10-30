import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' mail (ADR 0012): the domains and addresses an account may send
 * from, each its account's once, a domain's DKIM private key sealed; the
 * account's suppression list; and every plan's three limits, the sandbox's on
 * beta: 2 domains, 200 messages a day, 1 a second. The columns, keys, indexes
 * and checks are TypeORM's, as the drift check printed them.
 */
export class EmailIdentities1793336364006 implements MigrationInterface {
  name = 'EmailIdentities1793336364006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_identities" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "identity" character varying(320) NOT NULL, "type" text NOT NULL, "status" text NOT NULL DEFAULT 'PENDING', "dkim_selector" character varying(63), "dkim_public_key" text, "dkim_private_key" jsonb, "mail_from_verified" boolean NOT NULL DEFAULT false, "verification_token_sha256" character(64), "verified_at" TIMESTAMP WITH TIME ZONE, "checked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_117c128180a982a644c4f370b5" CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE')), CONSTRAINT "CHK_6f0f4ffac274da9de4c7fc44be" CHECK ("type" IN ('DOMAIN', 'EMAIL_ADDRESS')), CONSTRAINT "PK_a16003750885a9760d6cc742aa3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0ea5bfa5bc1941404979a786dd" ON "email_identities" ("account_id", "identity") `);
    await queryRunner.query(
      `CREATE TABLE "email_suppressions" ("account_id" character(12) NOT NULL, "address" character varying(320) NOT NULL, "reason" text NOT NULL, "message_id" text, "feedback" text, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_6d3a88bd0e5436882e28d5fda0" CHECK ("reason" IN ('BOUNCE', 'COMPLAINT')), CONSTRAINT "PK_7ab1d43519cb06ea6bf1bb1c98d" PRIMARY KEY ("account_id", "address"))`,
    );
    await queryRunner.query(
      `UPDATE "plans" SET "limits" = "limits" || '{"emailIdentities": 2, "emailsPerDay": 200, "emailsPerSecond": 1}'::jsonb WHERE NOT ("limits" ? 'emailIdentities')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'emailIdentities' - 'emailsPerDay' - 'emailsPerSecond'`);
    await queryRunner.query(`DROP TABLE "email_suppressions"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0ea5bfa5bc1941404979a786dd"`);
    await queryRunner.query(`DROP TABLE "email_identities"`);
  }
}
