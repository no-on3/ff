import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' caches (ADR 0013), and the plans' limits on them: a cache is the
 * account's once by its name, and once on the server by its opaque name and
 * by its port. Every plan gets the beta plan's limits, one cache of 64 MB,
 * which operators change from the admin dashboard. The table's SQL is
 * TypeORM's, as the drift check printed it.
 */
export class Caches1793331976259 implements MigrationInterface {
  name = 'Caches1793331976259';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "caches" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "name" character varying(40) NOT NULL, "server" text NOT NULL DEFAULT 'default', "server_name" character varying(27) NOT NULL, "port" integer NOT NULL, "memory_mb" integer NOT NULL, "status" text NOT NULL DEFAULT 'creating', "password_sha256" character(64) NOT NULL, "password_set_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_e70ea20ac27eb70628abc746d1" CHECK ("status" IN ('creating', 'active', 'suspended', 'deleting')), CONSTRAINT "PK_db23e5f1f4a3e6e405eecaf08aa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c925988735baf593992e6047a5" ON "caches" ("server_name") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2c90694e903bacb881cb40b15e" ON "caches" ("port") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_20771abb877138a556eb21438a" ON "caches" ("account_id", "name") `);
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"caches": 1, "cacheMb": 64}'::jsonb WHERE NOT ("limits" ? 'caches')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'caches' - 'cacheMb'`);
    await queryRunner.query(`DROP INDEX "public"."IDX_20771abb877138a556eb21438a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2c90694e903bacb881cb40b15e"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c925988735baf593992e6047a5"`);
    await queryRunner.query(`DROP TABLE "caches"`);
  }
}
