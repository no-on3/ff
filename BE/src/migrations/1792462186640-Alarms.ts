import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alarms on a function's or the account's metrics, and on its money, with
 * their state and why. TypeORM's SQL, as the drift check printed it. Down:
 * the table goes, and with it every alarm.
 */
export class Alarms1792462186640 implements MigrationInterface {
  name = 'Alarms1792462186640';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "alarms" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "function_id" uuid, "name" text NOT NULL, "metric" text NOT NULL, "statistic" text NOT NULL, "period" integer NOT NULL, "comparison" text NOT NULL, "threshold" double precision NOT NULL, "evaluation_periods" integer NOT NULL, "datapoints_to_alarm" integer NOT NULL, "treat_missing_data" text NOT NULL DEFAULT 'missing', "actions" jsonb NOT NULL, "state" text NOT NULL DEFAULT 'INSUFFICIENT_DATA', "state_reason" text, "state_reason_data" jsonb, "state_changed_at" TIMESTAMP WITH TIME ZONE, "evaluated_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_589db1777950d57ba7196be6a7" CHECK ("datapoints_to_alarm" BETWEEN 1 AND "evaluation_periods" AND "evaluation_periods" <= 60), CONSTRAINT "CHK_f5086e0420f5a8fecd880007e2" CHECK ("period" IN (60, 300, 3600)), CONSTRAINT "CHK_f21290f8284967567502e6e60d" CHECK ("treat_missing_data" IN ('missing', 'notBreaching', 'breaching', 'ignore')), CONSTRAINT "CHK_1d1d9166b8149340e8d6c5c2cb" CHECK ("state" IN ('OK', 'ALARM', 'INSUFFICIENT_DATA')), CONSTRAINT "PK_b776da486fb19d38b4f7777a6da" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_48a9ec837e92f17bd06db2a364" ON "alarms" ("account_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_71eafc00df40d6709fe6ad56a9" ON "alarms" ("function_id") `);
    await queryRunner.query(
      `ALTER TABLE "alarms" ADD CONSTRAINT "FK_48a9ec837e92f17bd06db2a3645" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "alarms" ADD CONSTRAINT "FK_71eafc00df40d6709fe6ad56a9e" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_71eafc00df40d6709fe6ad56a9e"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP CONSTRAINT "FK_48a9ec837e92f17bd06db2a3645"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_71eafc00df40d6709fe6ad56a9"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_48a9ec837e92f17bd06db2a364"`);
    await queryRunner.query(`DROP TABLE "alarms"`);
  }
}
