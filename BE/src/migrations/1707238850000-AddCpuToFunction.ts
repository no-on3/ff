import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCpuToFunction1707238850000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "functions" ADD COLUMN "cpu" integer DEFAULT 100`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "functions" DROP COLUMN "cpu"`);
    }
}
