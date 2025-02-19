import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateFunctionInvocationsTable1707235165433 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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
            type: 'enum',
            enum: ['SUCCESS', 'ERROR', 'TIMEOUT'],
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
        columnNames: ['functionId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'functions',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('function_invocations');
    if (!table) {
      return; // Table doesn't exist, nothing to drop
    }
    const foreignKey = table.foreignKeys.find(
      fk => fk.columnNames.indexOf('functionId') !== -1,
    );
    if (foreignKey) {
      await queryRunner.dropForeignKey('function_invocations', foreignKey);
    }
    await queryRunner.dropTable('function_invocations');
  }
}
