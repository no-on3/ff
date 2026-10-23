import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customers' databases (ADR 0008), and the plans' limits on them: a database
 * is the account's once by its name, and once on the server by its opaque
 * name. Every plan gets the beta plan's limits, one database of 1 GB with 10
 * sessions at once, which operators change from the admin dashboard. The
 * table's SQL is TypeORM's, as the drift check printed it.
 */
export class Databases1792724178089 implements MigrationInterface {
  name = 'Databases1792724178089';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "databases" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "name" character varying(63) NOT NULL, "server" text NOT NULL DEFAULT 'default', "db_name" character varying(27) NOT NULL, "status" text NOT NULL DEFAULT 'creating', "password_set_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_27b61477312a3610b744dedd07" CHECK ("status" IN ('creating', 'active', 'read_only', 'suspended', 'deleting')), CONSTRAINT "PK_238a190c9ace4bea3dc1896f988" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e701dbe586192ef3979f3bfc1b" ON "databases" ("db_name") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6c9f4c5cd357ca7a7f4922407f" ON "databases" ("account_id", "name") `);
    await queryRunner.query(
      `UPDATE "plans" SET "limits" = "limits" || '{"databases": 1, "databaseStorageMb": 1024, "databaseConnections": 10}'::jsonb WHERE NOT ("limits" ? 'databases')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'databases' - 'databaseStorageMb' - 'databaseConnections'`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6c9f4c5cd357ca7a7f4922407f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_e701dbe586192ef3979f3bfc1b"`);
    await queryRunner.query(`DROP TABLE "databases"`);
  }
}
