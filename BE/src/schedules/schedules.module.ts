import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { FunctionsModule } from '../functions/functions.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PlansModule } from '../plans/plans.module';
import { QueuesModule } from '../queues/queues.module';
import { Schedule } from './schedule.entity';
import { SchedulerService } from './scheduler.service';
import { ScheduleRunsController, SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

/** Functions' schedules: their routes, and the scheduler that runs them. */
@Module({
  imports: [TypeOrmModule.forFeature([Schedule, Account]), FunctionsModule, AuditModule, BillingModule, MetricsModule, PlansModule, QueuesModule],
  controllers: [SchedulesController, ScheduleRunsController],
  providers: [SchedulesService, SchedulerService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
