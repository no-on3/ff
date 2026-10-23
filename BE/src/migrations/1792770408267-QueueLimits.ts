import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The plans' limits on queues (ADR 0010): every plan gets the beta plan's, ten
 * queues, five read by each function, 100 requests a second, and 100 MB of
 * messages waiting together, a function's asynchronous calls among them.
 * Operators change them from the admin dashboard.
 */
export class QueueLimits1792770408267 implements MigrationInterface {
  name = 'QueueLimits1792770408267';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "plans" SET "limits" = "limits" || '{"queues": 10, "eventSourceMappingsPerFunction": 5, "queueRequestsPerSecond": 100, "queueStorageMb": 100}'::jsonb WHERE NOT ("limits" ? 'queues')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "plans" SET "limits" = "limits" - 'queues' - 'eventSourceMappingsPerFunction' - 'queueRequestsPerSecond' - 'queueStorageMb'`);
  }
}
