import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateMonitoringTables1707235165434 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create metrics table
    await queryRunner.createTable(
      new Table({
        name: 'metrics',
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
            name: 'type',
            type: 'varchar',
          },
          {
            name: 'value',
            type: 'float',
          },
          {
            name: 'labels',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'timestamp',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Create function_metrics table for detailed function metrics
    await queryRunner.createTable(
      new Table({
        name: 'function_metrics',
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
            name: 'invocationId',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'metricName',
            type: 'varchar',
          },
          {
            name: 'value',
            type: 'float',
          },
          {
            name: 'timestamp',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
        foreignKeys: [
          {
            name: 'fk_function_metrics_function',
            columnNames: ['functionId'],
            referencedTableName: 'functions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'fk_function_metrics_invocation',
            columnNames: ['invocationId'],
            referencedTableName: 'function_invocations',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
      true,
    );

    // Create indexes for better query performance
    await queryRunner.query(`
      CREATE INDEX idx_metrics_name ON metrics(name);
      CREATE INDEX idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX idx_function_metrics_functionid ON function_metrics("functionId");
      CREATE INDEX idx_function_metrics_timestamp ON function_metrics(timestamp);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_metrics_name;
      DROP INDEX IF EXISTS idx_metrics_timestamp;
      DROP INDEX IF EXISTS idx_function_metrics_functionid;
      DROP INDEX IF EXISTS idx_function_metrics_timestamp;
    `);

    // Drop tables (foreign keys will be dropped automatically)
    await queryRunner.dropTable('function_metrics');
    await queryRunner.dropTable('metrics');
  }
}
