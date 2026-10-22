import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a function's handler gets as its event: the payload itself, as on AWS
 * Lambda, for every function made from now on; FF's original wrapper, { body,
 * headers, method, query, path }, for every function that exists, whose code
 * reads event.body. Its owner switches it with an update. The SQL is TypeORM's,
 * as the drift check printed it. Down: the column goes, and with it the switch.
 */
export class EventFormat1792558201826 implements MigrationInterface {
  name = 'EventFormat1792558201826';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."functions_event_format_enum" AS ENUM('lambda', 'wrapped')`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "event_format" "public"."functions_event_format_enum" NOT NULL DEFAULT 'lambda'`);
    const [, wrapped] = (await queryRunner.query(`UPDATE "functions" SET "event_format" = 'wrapped'`)) as [unknown, number];
    if (wrapped > 0) console.log(`${wrapped} function(s) keep the event they had, FF's original wrapper: each moves to AWS Lambda's with an update`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "event_format"`);
    await queryRunner.query(`DROP TYPE "public"."functions_event_format_enum"`);
  }
}
