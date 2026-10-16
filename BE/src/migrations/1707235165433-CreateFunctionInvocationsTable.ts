import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateFunctionInvocationsTable1707235165433 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the status enum type if it doesn't exist
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'function_invocations_status_enum') THEN
          CREATE TYPE function_invocations_status_enum AS ENUM ('SUCCESS', 'ERROR', 'TIMEOUT');
        END IF;
      END$$;
    `);

    await queryRunner.createTable(
      new Table({
        name: 'function_invocations',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'functionId',
            type: 'uuid',
          },
          {
            name: 'input',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'output',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'function_invocations_status_enum',
          },
          {
            name: 'duration',
            type: 'float',
          },
          {
            name: 'memoryUsed',
            type: 'float',
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
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'function_invocations',
      new TableForeignKey({
        name: 'FK_function_invocations_function',
        columnNames: ['functionId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'functions',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('function_invocations');
    if (table) {
      const foreignKey = table.foreignKeys.find(
        fk => fk.columnNames.indexOf('functionId') !== -1,
      );
      if (foreignKey) {
        await queryRunner.dropForeignKey('function_invocations', foreignKey);
      }
      await queryRunner.dropTable('function_invocations');
    }
    await queryRunner.query('DROP TYPE IF EXISTS function_invocations_status_enum');
  }
}
