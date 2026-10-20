import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema baseline (client-readiness plan, P-01): generated from the
 * entities on 2026-10-17 and laid out for reading. It replaces the five
 * earlier migrations, which no longer matched the entities.
 *
 * - snake_case columns (SnakeNamingStrategy); the API's JSON keeps camelCase;
 * - UUIDs from gen_random_uuid(), built into PostgreSQL 13 and newer;
 * - every timestamp WITH TIME ZONE;
 * - invocations and metrics are deleted with their function, as before.
 *   P-20 moves usage into an append-only table that a delete can't reach.
 */
export class Baseline1792196726061 implements MigrationInterface {
  name = 'Baseline1792196726061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."functions_runtime_enum" AS ENUM('nodejs', 'python')`);
    await queryRunner.query(
      `CREATE TYPE "public"."functions_status_enum" AS ENUM('CREATING', 'ACTIVE', 'ERROR', 'DELETED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "functions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "user_id" character varying NOT NULL,
        "runtime" "public"."functions_runtime_enum" NOT NULL DEFAULT 'nodejs',
        "code" text NOT NULL,
        "memory" integer NOT NULL,
        "cpu" integer NOT NULL DEFAULT '100',
        "timeout" integer NOT NULL,
        "status" "public"."functions_status_enum" NOT NULL DEFAULT 'CREATING',
        "metadata" jsonb,
        "error" character varying,
        "min_instances" integer NOT NULL DEFAULT '0',
        "max_instances" integer NOT NULL DEFAULT '1',
        "target_concurrency" integer NOT NULL DEFAULT '100',
        "scale_to_zero" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_203889d2ae5a98ffc137739301e" PRIMARY KEY ("id")
      )`);

    await queryRunner.query(
      `CREATE TYPE "public"."function_invocations_status_enum" AS ENUM('SUCCESS', 'ERROR', 'TIMEOUT', 'RUNNING', 'COMPLETED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "function_invocations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "function_id" uuid NOT NULL,
        "input" jsonb,
        "output" jsonb,
        "status" "public"."function_invocations_status_enum" NOT NULL,
        "duration" double precision NOT NULL DEFAULT '0',
        "memory_used" double precision,
        "cpu_used" double precision,
        "error" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_a8ac0ae4cd6dad7a3452afd4c8d" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_2ae483d6cd660c8f6772931ae9" ON "function_invocations" ("function_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "function_metrics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "function_id" uuid NOT NULL,
        "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cpu_usage" double precision NOT NULL,
        "memory_usage" double precision NOT NULL,
        "request_count" integer NOT NULL,
        "response_time_p50" double precision NOT NULL,
        "response_time_p95" double precision NOT NULL,
        "response_time_p99" double precision NOT NULL,
        "error_count" integer NOT NULL,
        "active_instances" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_1d4003f6fce182703c26f35b16b" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_e495506dc8494fca8c5d417e8a" ON "function_metrics" ("timestamp")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_d7611d266999f7b143d828082d" ON "function_metrics" ("function_id", "timestamp")`,
    );

    await queryRunner.query(`
      ALTER TABLE "function_invocations" ADD CONSTRAINT "FK_448389a46b113a0336dc5240c72"
        FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`
      ALTER TABLE "function_metrics" ADD CONSTRAINT "FK_11f3eb1b4f3e10f376995bfbff9"
        FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "function_metrics" DROP CONSTRAINT "FK_11f3eb1b4f3e10f376995bfbff9"`);
    await queryRunner.query(`ALTER TABLE "function_invocations" DROP CONSTRAINT "FK_448389a46b113a0336dc5240c72"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d7611d266999f7b143d828082d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_e495506dc8494fca8c5d417e8a"`);
    await queryRunner.query(`DROP TABLE "function_metrics"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2ae483d6cd660c8f6772931ae9"`);
    await queryRunner.query(`DROP TABLE "function_invocations"`);
    await queryRunner.query(`DROP TYPE "public"."function_invocations_status_enum"`);
    await queryRunner.query(`DROP TABLE "functions"`);
    await queryRunner.query(`DROP TYPE "public"."functions_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."functions_runtime_enum"`);
  }
}
