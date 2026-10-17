import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { CapacitySample } from './capacity-sample.entity';
import { CapacityService } from './capacity.service';
import { UsageRecord } from './usage-record.entity';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Metering: usage records (P-20, D6), capacity samples (P-21), and GET /usage (P-22). */
@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord, CapacitySample]), OrchestratorModule],
  controllers: [UsageController],
  providers: [UsageService, CapacityService],
  exports: [UsageService],
})
export class UsageModule {}
