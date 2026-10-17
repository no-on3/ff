import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-16: invitations to join an account. The up queries are TypeORM's, as the
 * drift check printed them (npm run migration:check), so that the names match
 * the entity's.
 */
export class Invitations1792220311930 implements MigrationInterface {
  name = 'Invitations1792220311930';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "email" text NOT NULL, "role" text NOT NULL, "invited_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_by" uuid, CONSTRAINT "CHK_492d54defb10093f7d1ddca301" CHECK ("role" IN ('owner', 'developer', 'viewer')), CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0d94d794d6803e86d725df1f8f" ON "invitations" ("account_id", "email") WHERE "accepted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_97ab59cb592c7cec109741b592" ON "invitations" ("email") `);
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_84433480afca16f777aed2c445c" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_29b1cef6891d9b9d4e35f793b81" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_fdcaac54a139fa30a51ce246f98" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "invitations"`); // with its indexes and constraints
  }
}
