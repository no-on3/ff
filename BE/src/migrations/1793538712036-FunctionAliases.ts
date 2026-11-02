import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functions' aliases, as AWS Lambda's: a name, its function's once, pointing at
 * a version or at $LATEST (null), and at most one more version with its share
 * of the calls, from 0 to 1, never beside $LATEST; a revision of their own;
 * going with their function. The SQL is TypeORM's, its constraints' names as
 * its naming strategy makes them. Down: the aliases go; the versions they named
 * stay.
 */
export class FunctionAliases1793538712036 implements MigrationInterface {
  name = 'FunctionAliases1793538712036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "function_aliases" ("function_id" uuid NOT NULL, "name" character varying(128) NOT NULL, "account_id" character(12) NOT NULL, "version" integer, "additional_version" integer, "additional_weight" double precision, "description" character varying(256) NOT NULL DEFAULT '', "revision_id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_5823537b8a1ceee0b23de49596" CHECK ("additional_version" IS NULL OR "version" IS NOT NULL), CONSTRAINT "CHK_9f21a124e42a46cbb8a066cdee" CHECK ("additional_weight" BETWEEN 0 AND 1), CONSTRAINT "CHK_b3334be0d1983fff7e3fd1d32c" CHECK (("additional_version" IS NULL) = ("additional_weight" IS NULL)), CONSTRAINT "PK_5bef7aa2397321887abfe67b1a2" PRIMARY KEY ("function_id", "name"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "function_aliases" ADD CONSTRAINT "FK_c264bb4949d99f07ff66efd2ee7" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_aliases" DROP CONSTRAINT "FK_c264bb4949d99f07ff66efd2ee7"`);
    await queryRunner.query(`DROP TABLE "function_aliases"`);
  }
}
