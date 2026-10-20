import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { MonitoringService } from './monitoring.service';
import { ReadinessController } from './readiness.controller';

/** What FF's operator watches the backend by: /readyz, and the metrics on their own port. */
@Module({
  imports: [BillingModule, OrchestratorModule],
  controllers: [ReadinessController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
