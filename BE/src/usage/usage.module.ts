import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '../billing/billing.module';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { AwsEstimateService } from './aws-estimate.service';
import { CapacitySample } from './capacity-sample.entity';
import { CapacityService } from './capacity.service';
import { UsageRecord } from './usage-record.entity';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Metering: each call's usage record, the functions' capacity a minute, and GET /usage, the month at FF's prices; and the estimate at AWS's prices. */
@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord, CapacitySample, PriceBook, Currency]), OrchestratorModule, BillingModule, PlansModule],
  controllers: [UsageController],
  providers: [UsageService, CapacityService, AwsEstimateService],
  exports: [UsageService],
})
export class UsageModule {}
