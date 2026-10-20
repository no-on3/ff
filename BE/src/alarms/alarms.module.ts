import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { MetricsModule } from '../metrics/metrics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Alarm } from './alarm.entity';
import { AlarmEvaluator } from './alarm-evaluator.service';
import { AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';

@Module({
  imports: [TypeOrmModule.forFeature([Alarm]), AuditModule, BillingModule, MetricsModule, NotificationsModule],
  controllers: [AlarmsController],
  providers: [AlarmsService, AlarmEvaluator],
})
export class AlarmsModule {}
