import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { CapacitySample } from './capacity-sample.entity';
import { CapacityService } from './capacity.service';
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';

/** Metering: usage records (P-20, D6) and capacity samples (P-21). */
@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord, CapacitySample]), OrchestratorModule],
  providers: [UsageService, CapacityService],
  exports: [UsageService],
})
export class UsageModule {}
