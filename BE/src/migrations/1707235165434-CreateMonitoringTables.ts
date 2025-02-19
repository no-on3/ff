import { MigrationInterface, QueryRunner, Table } from 'typeorm';

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
      }),
      true,
    );

    // Add foreign keys
    await queryRunner.query(`
      ALTER TABLE function_metrics
      ADD CONSTRAINT fk_function_metrics_function
      FOREIGN KEY ("functionId")
      REFERENCES functions(id)
      ON DELETE CASCADE;
    `);

    await queryRunner.query(`
      ALTER TABLE function_metrics
      ADD CONSTRAINT fk_function_metrics_invocation
      FOREIGN KEY ("invocationId")
      REFERENCES function_invocations(id)
      ON DELETE SET NULL;
    `);

    // Create indexes for better query performance
    await queryRunner.query(`
      CREATE INDEX idx_metrics_name ON metrics(name);
      CREATE INDEX idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX idx_function_metrics_function_id ON function_metrics("functionId");
      CREATE INDEX idx_function_metrics_timestamp ON function_metrics(timestamp);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_function_metrics_timestamp;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_function_metrics_function_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_metrics_timestamp;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_metrics_name;`);
    
    await queryRunner.dropTable('function_metrics');
    await queryRunner.dropTable('metrics');
  }
}
