import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' own domains for their functions' URLs, and the plans' limit on
 * them. A domain is in an account once at most, and verified in one account at
 * most; it goes with its URL. Every plan gets the beta plan's limit, 5, which
 * operators change from the admin dashboard. The table's SQL is TypeORM's, as
 * the drift check printed it.
 */
export class CustomDomains1792564226078 implements MigrationInterface {
  name = 'CustomDomains1792564226078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."custom_domains_status_enum" AS ENUM('pending', 'verified')`);
    await queryRunner.query(
      `CREATE TABLE "custom_domains" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "domain" character varying(253) NOT NULL, "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "token" character(32) NOT NULL, "status" "public"."custom_domains_status_enum" NOT NULL DEFAULT 'pending', "checked_at" TIMESTAMP WITH TIME ZONE, "check_error" text, "verified_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_53c30715082abb90e5063a2a397" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_002f32810a5fead1a88b32c97a" ON "custom_domains" ("function_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_custom_domains_verified_domain" ON "custom_domains" ("domain") WHERE "status" = 'verified'`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6ff02945590e5db1008d5491c7" ON "custom_domains" ("account_id", "domain") `);
    await queryRunner.query(
      `ALTER TABLE "custom_domains" ADD CONSTRAINT "FK_002f32810a5fead1a88b32c97a8" FOREIGN KEY ("function_id") REFERENCES "function_urls"("function_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"customDomains": 5}'::jsonb WHERE NOT ("limits" ? 'customDomains')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'customDomains'`);
    await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT "FK_002f32810a5fead1a88b32c97a8"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6ff02945590e5db1008d5491c7"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_custom_domains_verified_domain"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_002f32810a5fead1a88b32c97a"`);
    await queryRunner.query(`DROP TABLE "custom_domains"`);
    await queryRunner.query(`DROP TYPE "public"."custom_domains_status_enum"`);
  }
}
