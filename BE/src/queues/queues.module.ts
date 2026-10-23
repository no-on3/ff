import { Module } from '@nestjs/common';
import { QueueStore } from './queue-store';

/** The queue in FF's database (ADR 0010): its store, which functions' asynchronous calls use. */
@Module({
  providers: [QueueStore],
  exports: [QueueStore],
})
export class QueuesModule {}
