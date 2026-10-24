import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../common/describe-error';
import { NotificationRule } from './bucket-notifications';

/** What a bucket's notifications send: S3's event, a record, to a rule's destination; or S3's test event to a queue a configuration names. */
export type BucketEvent =
  | { kind: 'record'; accountId: string; bucket: string; rule: NotificationRule; record: Record<string, unknown> }
  | { kind: 'test'; accountId: string; bucket: string; queueArn: string; body: Record<string, string> };

/**
 * The events of customers' buckets, as the S3 front door sees them happen:
 * published here once the store answered, and delivered by whoever listens,
 * the queues' side of the backend, which writes a function's asynchronous
 * calls and a queue's messages. A listener's failure is logged, and its
 * event is lost, as an event is when a backend stops before it is written.
 */
@Injectable()
export class BucketEvents {
  private readonly logger = new Logger(BucketEvents.name);
  private readonly listeners = new Set<(event: BucketEvent) => Promise<void>>();

  /** Hears every event published from now; the function returned stops it. */
  listen(listener: (event: BucketEvent) => Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hands the event to each listener in turn, waiting for each. */
  async publish(event: BucketEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event).catch((error: unknown) =>
        this.logger.error(`An event of bucket ${event.bucket} was not delivered: ${describeError(error)}`),
      );
    }
  }
}
