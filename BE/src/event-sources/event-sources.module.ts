import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { FunctionsModule } from '../functions/functions.module';
import { PlansModule } from '../plans/plans.module';
import { QueuesModule } from '../queues/queues.module';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EventSourcePoller } from './event-source-poller';
import { EventSourcesController } from './event-sources.controller';
import { EventSourcesService } from './event-sources.service';

/** Functions reading queues of their account, as AWS Lambda's event source mappings for SQS (ADR 0010). */
@Module({
  imports: [TypeOrmModule.forFeature([EventSourceMapping, Account]), FunctionsModule, QueuesModule, PlansModule, AuditModule, BillingModule],
  controllers: [EventSourcesController],
  providers: [EventSourcesService, EventSourcePoller],
})
export class EventSourcesModule {}
