import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FunctionsModule } from '../functions/functions.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PackagesModule } from '../packages/packages.module';
import { RetentionService } from './retention.service';

/** What FF keeps only for a while, and the job that deletes it. */
@Module({
  imports: [AuditModule, FunctionsModule, OrchestratorModule, PackagesModule],
  providers: [RetentionService],
})
export class RetentionModule {}
