import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A function's code as AWS Lambda describes it: how it comes (inline, the one
 * file every function has had so far, or a zip package), what its runtime calls
 * (its handler, function.handler until it names another), and its CodeSha256
 * and CodeSize. The SQL is TypeORM's, as the drift check printed it, with the
 * hash and size filled in before they are required. Inline code's follow its
 * code, whatever writes the row, as the backend computes them: from its UTF-8,
 * the hash in base64; a package's are the backend's to give.
 * Down: the columns go, and the code stays. A function that named another
 * handler is told function.handler again at its next rollout, which fails
 * unless its code exports that too.
 */
export class FunctionPackages1792581123640 implements MigrationInterface {
  name = 'FunctionPackages1792581123640';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."functions_package_type_enum" AS ENUM('inline', 'zip')`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "package_type" "public"."functions_package_type_enum" NOT NULL DEFAULT 'inline'`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "handler" character varying(128) NOT NULL DEFAULT 'function.handler'`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "code_sha256" character varying(44)`);
    await queryRunner.query(`ALTER TABLE "functions" ADD "code_size" integer`);
    await queryRunner.query(
      `CREATE FUNCTION "ff_inline_code_facts"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."package_type" = 'inline' THEN
           NEW."code_sha256" := encode(sha256(convert_to(NEW."code", 'UTF8')), 'base64');
           NEW."code_size" := octet_length(convert_to(NEW."code", 'UTF8'));
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "functions_inline_code_facts" BEFORE INSERT OR UPDATE OF "code", "package_type", "code_sha256", "code_size" ON "functions" ` +
        `FOR EACH ROW EXECUTE FUNCTION "ff_inline_code_facts"()`,
    );
    // Every function so far is inline: the trigger gives each its hash and size.
    await queryRunner.query(`UPDATE "functions" SET "code_sha256" = NULL`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "code_sha256" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "functions" ALTER COLUMN "code_size" SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "functions_inline_code_facts" ON "functions"`);
    await queryRunner.query(`DROP FUNCTION "ff_inline_code_facts"()`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "code_size"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "code_sha256"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "handler"`);
    await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "package_type"`);
    await queryRunner.query(`DROP TYPE "public"."functions_package_type_enum"`);
  }
}
