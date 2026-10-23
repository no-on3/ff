import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabasesModule } from '../databases/databases.module';
import { FunctionsModule } from '../functions/functions.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PackagesModule } from '../packages/packages.module';
import { QueuesModule } from '../queues/queues.module';
import { StorageModule } from '../storage/storage.module';
import { RetentionService } from './retention.service';

/** What FF keeps only for a while, and the job that deletes it. */
@Module({
  imports: [AuditModule, DatabasesModule, FunctionsModule, OrchestratorModule, PackagesModule, QueuesModule, StorageModule],
  providers: [RetentionService],
})
export class RetentionModule {}
