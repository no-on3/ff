import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stacks (ADR 0016): what `ff deploy` made of a SAM template, its parameters'
 * values and its template's SHA-256, and each resource's logical ID, type and
 * the FF resource it made, one of a type in one of an account's stacks at
 * most. Names as TypeORM gives them. Down: the stacks go, what they made
 * stays.
 */
export class Stacks1793730000000 implements MigrationInterface {
  name = 'Stacks1793730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "stacks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_id" character(12) NOT NULL, "name" character varying(128) NOT NULL, "template_sha256" character(64) NOT NULL, "parameters" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_04890620d6f2e3102d6756b1db0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_39c1acf3b3299db4d90ba0e741" ON "stacks" ("account_id", "name") `);
    await queryRunner.query(
      `CREATE TABLE "stack_resources" ("stack_id" uuid NOT NULL, "logical_id" character varying(255) NOT NULL, "account_id" character(12) NOT NULL, "type" character varying(256) NOT NULL, "physical_id" character varying(1024), CONSTRAINT "PK_b03877f3cf238a09191e4eddfed" PRIMARY KEY ("stack_id", "logical_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_a244f51b29d131ae20fa4e7b4c" ON "stack_resources" ("account_id", "type", "physical_id") WHERE "physical_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "stack_resources" ADD CONSTRAINT "FK_10a18692ca3a7d185866480a454" FOREIGN KEY ("stack_id") REFERENCES "stacks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stack_resources" DROP CONSTRAINT "FK_10a18692ca3a7d185866480a454"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a244f51b29d131ae20fa4e7b4c"`);
    await queryRunner.query(`DROP TABLE "stack_resources"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_39c1acf3b3299db4d90ba0e741"`);
    await queryRunner.query(`DROP TABLE "stacks"`);
  }
}
