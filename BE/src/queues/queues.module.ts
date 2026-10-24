import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../plans/plans.module';
import { Function } from '../functions/entities/function.entity';
import { StorageModule } from '../storage/storage.module';
import { BucketEventDelivery } from './bucket-event-delivery';
import { CustomerQueues } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueMessage } from './queue-message.entity';
import { QueueStore } from './queue-store';
import { Queue } from './queue.entity';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';
import { SqsFrontDoor } from './sqs-front-door';
import { SqsOperations } from './sqs-operations';

/**
 * The queue in FF's database (ADR 0010): its store, which functions'
 * asynchronous calls use, customers' queues, and their two ways in, the SQS
 * endpoint that answers AWS's SDKs and CLI on a port of its own, with the keys
 * that reach the account's buckets, and FF's API, both running SQS's
 * operations; and the delivery of buckets' events to functions and queues.
 */
@Module({
  // Buckets' events go to the account's functions and queues: a function by its row.
  imports: [TypeOrmModule.forFeature([Queue, QueueMessage, Function]), StorageModule, PlansModule, BillingModule, AuditModule],
  controllers: [QueuesController],
  providers: [
    QueueStore,
    QueueEvents,
    CustomerQueues,
    {
      provide: SqsOperations,
      inject: [CustomerQueues, QueueStore, QueueEvents, AuditService, ConfigService],
      useFactory: (queues: CustomerQueues, store: QueueStore, events: QueueEvents, audit: AuditService, config: ConfigService) => {
        const sqs = config.getOrThrow<{ base: string; region: string }>('sqs');
        return new SqsOperations(queues, store, events, audit, sqs.base, sqs.region);
      },
    },
    SqsFrontDoor,
    QueuesService,
    BucketEventDelivery,
  ],
  exports: [QueueStore, QueueEvents, CustomerQueues, SqsFrontDoor],
})
export class QueuesModule {}
