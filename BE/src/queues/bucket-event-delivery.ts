import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { parseFunctionArn } from '../functions/arns';
import { EXPIRY_GRACE_SECONDS, LAMBDA_RETRY_POLICY, MAX_ASYNC_INPUT_BYTES } from '../functions/async-invoke';
import { Function } from '../functions/entities/function.entity';
import { PlansService } from '../plans/plans.service';
import { BucketEvent, BucketEvents } from '../storage/bucket-events';
import { CustomerQueues } from './customer-queues';
import { QueueStore } from './queue-store';
import { parseQueueArn } from './sqs-attributes';

/** A megabyte, as the plans count what messages hold. */
const MB = 1024 * 1024;

/**
 * Delivers buckets' events (ADR 0010), as S3 does: to a function, S3's event
 * as an asynchronous call, which its worker runs with the function's own
 * retries and destinations, as S3 calls Lambda; to a queue, a message, S3's
 * event its body, from the bucket. An event that can't go (its destination
 * gone, past the plan's room for messages, past what the destination takes)
 * is said in the log and dropped, as S3 drops what it can't deliver.
 */
@Injectable()
export class BucketEventDelivery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BucketEventDelivery.name);
  private stopListening?: () => void;

  constructor(
    private readonly events: BucketEvents,
    private readonly queues: CustomerQueues,
    private readonly store: QueueStore,
    private readonly plans: PlansService,
    @InjectRepository(Function) private readonly functions: Repository<Function>,
  ) {}

  onModuleInit(): void {
    this.stopListening = this.events.listen((event) => this.deliver(event));
  }

  onModuleDestroy(): void {
    this.stopListening?.();
  }

  async deliver(event: BucketEvent): Promise<void> {
    const arn = event.kind === 'record' ? event.rule.arn : event.queueArn;
    const body = JSON.stringify(event.kind === 'record' ? { Records: [event.record] } : event.body);
    const size = Buffer.byteLength(body);
    const dropped = (why: string) => this.logger.warn(`An event of bucket ${event.bucket} was not delivered to ${arn}: ${why}`);
    const plan = await this.plans.forAccount(event.accountId);
    if ((await this.store.accountBytes(event.accountId)) + size > plan.limits.queueStorageMb * MB) {
      return dropped(`the account's messages hold ${plan.limits.queueStorageMb} MB together, the ${plan.name} plan's limit`);
    }
    if (event.kind === 'test' || event.rule.target === 'queue') {
      const named = parseQueueArn(arn);
      const queue = named && named.accountId === event.accountId ? await this.queues.find(event.accountId, named.name) : null;
      if (!queue) return dropped('it is no queue of the account any more');
      if (size > queue.maximumMessageSize) return dropped(`the event is ${size} bytes, over the queue's maximum message size of ${queue.maximumMessageSize}`);
      const message = { messageId: randomUUID(), body, meta: { senderId: `arn:aws:s3:::${event.bucket}` }, sizeBytes: size, delaySeconds: queue.delaySeconds };
      return this.queues.send(queue, [message], new Date());
    }
    const named = parseFunctionArn(arn);
    const fn = named && named.accountId === event.accountId ? await this.functions.findOne({ where: { accountId: event.accountId, name: named.name }, select: { id: true, accountId: true } }) : null;
    if (!fn) return dropped('it is no function of the account any more');
    if (size > MAX_ASYNC_INPUT_BYTES) return dropped(`the event is ${size} bytes, over an asynchronous call's ${MAX_ASYNC_INPUT_BYTES}`);
    const expiresAt = new Date(Date.now() + (LAMBDA_RETRY_POLICY.maximumEventAgeSeconds + EXPIRY_GRACE_SECONDS) * 1000);
    await this.store.sendEvent(fn, randomUUID(), body, expiresAt);
  }
}
