import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications: each delivery of one, an e-mail or a webhook, with how its
 * attempts went, and the secret each account's webhooks are signed with.
 * TypeORM's SQL, as the drift check printed it. Down: both tables go.
 */
export class Notifications1792424270622 implements MigrationInterface {
  name = 'Notifications1792424270622';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_deliveries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "notification_id" uuid NOT NULL, "kind" text NOT NULL, "channel" text NOT NULL, "target" text NOT NULL, "payload" jsonb NOT NULL, "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_error" text, "response_status" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "delivered_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_b6671c8b3704366a9cae8eb6ab" CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL)), CONSTRAINT "CHK_7c6db567347af0fd2ee2ba9da9" CHECK ("status" IN ('pending', 'delivered', 'failed')), CONSTRAINT "CHK_d53f58eadcffc56849df3bf722" CHECK ("channel" IN ('email', 'webhook')), CONSTRAINT "PK_81daeff81f237bd384f7cfc4a4c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_notification_deliveries_due" ON "notification_deliveries" ("next_attempt_at") WHERE "status" = 'pending'`);
    await queryRunner.query(`CREATE INDEX "IDX_2f07c48343678985994f0849fa" ON "notification_deliveries" ("account_id", "created_at") `);
    await queryRunner.query(
      `CREATE TABLE "webhook_secrets" ("account_id" character(12) NOT NULL, "secret" text NOT NULL, "previous_secret" text, "previous_expires_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_11ba09ab202dbfbf236d62e690a" PRIMARY KEY ("account_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_deliveries" ADD CONSTRAINT "FK_7272b514265eecb63956673dca1" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_secrets" ADD CONSTRAINT "FK_11ba09ab202dbfbf236d62e690a" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "webhook_secrets" DROP CONSTRAINT "FK_11ba09ab202dbfbf236d62e690a"`);
    await queryRunner.query(`ALTER TABLE "notification_deliveries" DROP CONSTRAINT "FK_7272b514265eecb63956673dca1"`);
    await queryRunner.query(`DROP TABLE "webhook_secrets"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2f07c48343678985994f0849fa"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_notification_deliveries_due"`);
    await queryRunner.query(`DROP TABLE "notification_deliveries"`);
  }
}
