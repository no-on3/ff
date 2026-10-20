import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API keys (client-readiness plan, P-13, D3): only the SHA-256 of a key's
 * secret is stored. A key goes with its account; its creator stays.
 */
export class ApiKeys1792214380231 implements MigrationInterface {
  name = 'ApiKeys1792214380231';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "api_keys" ("id" text NOT NULL, "account_id" character(12) NOT NULL, "created_by" uuid NOT NULL, "name" text NOT NULL, "secret_sha256" bytea NOT NULL, "scopes" text array NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "last_used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5c8a79801b44bd27b79228e1dad" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_decaf331589778e33441b2a8d9" ON "api_keys" ("account_id") `);
    await queryRunner.query(`ALTER TABLE "api_keys" ADD CONSTRAINT "FK_decaf331589778e33441b2a8d9e" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "api_keys" ADD CONSTRAINT "FK_983d7eb19ca94bb8e343293068e" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "api_keys" DROP CONSTRAINT "FK_983d7eb19ca94bb8e343293068e"`);
    await queryRunner.query(`ALTER TABLE "api_keys" DROP CONSTRAINT "FK_decaf331589778e33441b2a8d9e"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_decaf331589778e33441b2a8d9"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}
