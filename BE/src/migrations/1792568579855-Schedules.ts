import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' schedules, and the plans' limit on them. A schedule's name is its
 * function's once; the scheduler finds the enabled ones due by their next run.
 * Every plan gets the beta plan's limit, 20, which operators change from the
 * admin dashboard. The table's SQL is TypeORM's, as the drift check printed it.
 */
export class Schedules1792568579855 implements MigrationInterface {
  name = 'Schedules1792568579855';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "schedules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "function_id" uuid NOT NULL, "name" character varying(64) NOT NULL, "description" character varying(512), "expression" character varying(256) NOT NULL, "input" jsonb, "enabled" boolean NOT NULL DEFAULT true, "next_run_at" TIMESTAMP WITH TIME ZONE, "anchor_at" TIMESTAMP WITH TIME ZONE, "last_run_at" TIMESTAMP WITH TIME ZONE, "last_request_id" uuid, "last_outcome" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7e33fc2ea755a5765e3564e66dd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_schedules_due" ON "schedules" ("next_run_at") WHERE "enabled"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3b2e0f7aeb40fb81eaaf03f282" ON "schedules" ("function_id", "name") `);
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD CONSTRAINT "FK_388d0a66ea61a7a025c16e75644" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" || '{"schedules": 20}'::jsonb WHERE NOT ("limits" ? 'schedules')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'schedules'`);
    await queryRunner.query(`ALTER TABLE "schedules" DROP CONSTRAINT "FK_388d0a66ea61a7a025c16e75644"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3b2e0f7aeb40fb81eaaf03f282"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_schedules_due"`);
    await queryRunner.query(`DROP TABLE "schedules"`);
  }
}
