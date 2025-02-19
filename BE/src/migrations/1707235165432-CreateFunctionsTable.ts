import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateFunctionsTable1707235165432 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'functions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'name',
            type: 'varchar',
          },
          {
            name: 'userId',
            type: 'varchar',
          },
          {
            name: 'runtime',
            type: 'enum',
            enum: ['nodejs', 'python'],
            default: "'nodejs'",
          },
          {
            name: 'code',
            type: 'text',
          },
          {
            name: 'memory',
            type: 'integer',
          },
          {
            name: 'timeout',
            type: 'integer',
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['CREATING', 'ACTIVE', 'ERROR', 'DELETED'],
            default: "'CREATING'",
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'error',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.query(`
      CREATE TRIGGER update_functions_updated_at
        BEFORE UPDATE ON functions
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('functions');
  }
}
