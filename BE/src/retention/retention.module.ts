import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FunctionsModule } from '../functions/functions.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { RetentionService } from './retention.service';

/** What FF keeps only for a while, and the job that deletes it. */
@Module({
  imports: [AuditModule, FunctionsModule, OrchestratorModule],
  providers: [RetentionService],
})
export class RetentionModule {}
