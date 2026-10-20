import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Accounts and users (client-readiness plan, P-12, D1).
 *
 * - New tables: plans (with the "beta" plan), accounts, users, memberships.
 * - functions.user_id becomes account_id char(12), a foreign key to accounts.
 *   Each existing tenant becomes an active account, so existing functions keep
 *   working. A tenant that isn't a 12-digit account ID (from before P-02's
 *   FF_DEV_ACCOUNT_ID) can't become an account: the migration stops and says so.
 *
 * Written by hand on TypeORM's generated SQL, which keeps the constraint names
 * the entities produce: the generator dropped the column and added a new one,
 * which fails on any table with rows.
 */
export class AccountsAndUsers1792212624716 implements MigrationInterface {
  name = 'AccountsAndUsers1792212624716';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "plans" ("id" text NOT NULL, "name" text NOT NULL, "limits" jsonb NOT NULL, CONSTRAINT "PK_3720521a81c7c24fe9b7202ba61" PRIMARY KEY ("id"))`,
    );
    // P-15 sets its limits.
    await queryRunner.query(`INSERT INTO "plans" ("id", "name", "limits") VALUES ('beta', 'Beta', '{}')`);
    await queryRunner.query(
      `CREATE TABLE "accounts" ("id" character(12) NOT NULL, "name" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "plan_id" text NOT NULL, "country" character(2) NOT NULL DEFAULT 'TN', "tax_id" text, "internet_egress" boolean NOT NULL DEFAULT false, "use_case" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_eda60f5956ba295a2bc16f3425" CHECK ("status" IN ('pending', 'active', 'rejected', 'suspended', 'closed')), CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "oidc_sub" text NOT NULL, "email" text NOT NULL, "name" text, "locale" text NOT NULL DEFAULT 'fr-TN', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_6d0575edfe251efc25e3d65a22f" UNIQUE ("oidc_sub"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "memberships" ("account_id" character(12) NOT NULL, "user_id" uuid NOT NULL, "role" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_9d39540a20b48ee8ecc0906642" CHECK ("role" IN ('owner', 'developer', 'viewer')), CONSTRAINT "PK_b69b4ca2d093740d0f6efb7693f" PRIMARY KEY ("account_id", "user_id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_7c1e2fdfed4f6838e0c05ae505" ON "memberships" ("user_id") `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "FK_ec3913403cfe3d432d10a6b86fb" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_cc6ac2e484c2f6e53d13ce1a97c" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_7c1e2fdfed4f6838e0c05ae5051" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Existing tenants become accounts, or the migration stops before changing anything else.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "functions" WHERE "user_id" !~ '^[0-9]{12}$') THEN
          RAISE EXCEPTION 'functions.user_id holds tenants that are not 12-digit account IDs (from before 2026-10-17): reset the development database (docs/getting-started.md, step 7) and run the migrations again';
        END IF;
      END $$`);
    await queryRunner.query(
      `INSERT INTO "accounts" ("id", "name", "status", "plan_id") SELECT DISTINCT "user_id", 'Account ' || "user_id", 'active', 'beta' FROM "functions"`,
    );
    await queryRunner.query(`ALTER TABLE "functions" RENAME COLUMN "user_id" TO "account_id"`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "account_id" TYPE character(12)`);
    await queryRunner.query(`CREATE INDEX "IDX_68c5f88970ab2f4637953891b6" ON "functions" ("account_id") `);
    await queryRunner.query(
      `ALTER TABLE "functions" ADD CONSTRAINT "FK_68c5f88970ab2f4637953891b63" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Functions keep their tenant, as user_id again; accounts, users and memberships go.
    await queryRunner.query(`ALTER TABLE "functions" DROP CONSTRAINT "FK_68c5f88970ab2f4637953891b63"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_68c5f88970ab2f4637953891b6"`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "account_id" TYPE character varying`);
    await queryRunner.query(`ALTER TABLE "functions" RENAME COLUMN "account_id" TO "user_id"`);
    await queryRunner.query(`ALTER TABLE "memberships" DROP CONSTRAINT "FK_7c1e2fdfed4f6838e0c05ae5051"`);
    await queryRunner.query(`ALTER TABLE "memberships" DROP CONSTRAINT "FK_cc6ac2e484c2f6e53d13ce1a97c"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "FK_ec3913403cfe3d432d10a6b86fb"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7c1e2fdfed4f6838e0c05ae505"`);
    await queryRunner.query(`DROP TABLE "memberships"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TABLE "plans"`);
  }
}
