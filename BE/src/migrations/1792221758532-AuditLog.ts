import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P-17: the audit log, append-only. The table and index are TypeORM's, as the
 * drift check printed them. The trigger is not TypeORM's: ff_refuse_change()
 * refuses UPDATE, DELETE and TRUNCATE, and P-20's usage_records reuses it.
 */
export class AuditLog1792221758532 implements MigrationInterface {
  name = 'AuditLog1792221758532';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_log" ("id" BIGSERIAL NOT NULL, "account_id" character(12), "actor" text NOT NULL, "actor_label" text NOT NULL, "action" text NOT NULL, "resource" text, "ip" text, "request_id" text, "details" jsonb, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_07fefa57f7f5ab8fc3f52b3ed0b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_a56795aabab87570d6f08ba3a0" ON "audit_log" ("account_id", "id") `);
    await queryRunner.query(
      `CREATE FUNCTION "ff_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "ff_refuse_change"()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "ff_refuse_change"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_log"`); // with its index and triggers
    await queryRunner.query(`DROP FUNCTION "ff_refuse_change"()`);
  }
}
