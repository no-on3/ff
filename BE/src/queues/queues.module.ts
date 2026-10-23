import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../plans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { CustomerQueues } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueMessage } from './queue-message.entity';
import { QueueStore } from './queue-store';
import { Queue } from './queue.entity';
import { SqsFrontDoor } from './sqs-front-door';

/**
 * The queue in FF's database (ADR 0010): its store, which functions'
 * asynchronous calls use, customers' queues, and the SQS endpoint that
 * answers AWS's SDKs and CLI on a port of its own, with the keys that reach
 * the account's buckets.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Queue, QueueMessage]), StorageModule, PlansModule, BillingModule],
  providers: [QueueStore, QueueEvents, CustomerQueues, SqsFrontDoor],
  exports: [QueueStore, QueueEvents, CustomerQueues, SqsFrontDoor],
})
export class QueuesModule {}
