import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's name is unique within its account, which a unique index on
 * (account_id, name) makes sure of; it also serves every query by account, so
 * the index on account_id alone goes. Names weren't unique before: of an
 * account's functions with one name, the oldest keeps it, and each later one
 * gets the first 8 characters of its ID, "hello-3f9c2a1e", which the account's
 * audit log records as FF's change. The index's SQL is TypeORM's, as the drift
 * check printed it. Down: the index on account_id comes back; the renamed
 * functions keep their new names.
 */
export class UniqueFunctionNames1792545248288 implements MigrationInterface {
  name = 'UniqueFunctionNames1792545248288';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const renamed = (await queryRunner.query(
      `WITH "ranked" AS (
         SELECT "id", row_number() OVER (PARTITION BY "account_id", "name" ORDER BY "created_at", "id") AS "rank" FROM "functions"
       ), "renamed" AS (
         UPDATE "functions" SET "name" = "functions"."name" || '-' || left("functions"."id"::text, 8)
           FROM "ranked" WHERE "ranked"."id" = "functions"."id" AND "ranked"."rank" > 1
         RETURNING "functions"."id", "functions"."account_id", "functions"."name"
       )
       INSERT INTO "audit_log" ("account_id", "actor", "actor_label", "action", "resource", "details")
       SELECT "account_id", 'system', 'FF', 'function.update', 'function:' || "id",
              jsonb_build_object('changed', jsonb_build_array('name'), 'name', "name",
                                 'outcome', 'renamed by FF: another of the account''s functions had the same name, and names are now unique')
         FROM "renamed"
       RETURNING "account_id", "resource", "details"->>'name' AS "name"`,
    )) as Array<{ account_id: string; resource: string; name: string }>;
    for (const row of renamed) {
      console.log(`Renamed ${row.resource} of account ${row.account_id} to "${row.name}": another of its functions had the same name`);
    }
    await queryRunner.query(`DROP INDEX "public"."IDX_68c5f88970ab2f4637953891b6"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8308eff561027871b789ffec36" ON "functions" ("account_id", "name") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_8308eff561027871b789ffec36"`);
    await queryRunner.query(`CREATE INDEX "IDX_68c5f88970ab2f4637953891b6" ON "functions" ("account_id") `);
  }
}
