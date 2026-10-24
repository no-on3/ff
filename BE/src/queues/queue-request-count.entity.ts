import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A customer's queue's requests in one minute, as one backend counted them:
 * never a row per request (ADR 0010). Written once, when the minute is over or
 * the backend stops, never changed (a trigger refuses UPDATE and DELETE),
 * partitioned by month on the minute, as buckets' request counts are: queues'
 * requests are billed from these, and their metrics read them. Each writer is
 * a backend's process, so that two backends counting the same minute write two
 * rows. No foreign key: a count outlives its queue, its name with it.
 */
@Entity('queue_request_counts')
@Index(['accountId', 'minute'])
export class QueueRequestCount {
  @PrimaryColumn({ type: 'uuid' })
  queueId: string;

  /** The minute's start: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  /** The process that counted them. */
  @PrimaryColumn({ type: 'uuid' })
  writer: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The queue's name then, which the bill shows once it is deleted too. */
  @Column({ type: 'text' })
  name: string;

  /** Its requests as SQS bills them: each 64 KB of a request's messages one, one at least. */
  @Column({ type: 'int' })
  requests: number;

  /** Messages kept, received and deleted, as CloudWatch's NumberOfMessagesSent, NumberOfMessagesReceived and NumberOfMessagesDeleted count them. */
  @Column({ type: 'int' })
  sent: number;

  @Column({ type: 'int' })
  received: number;

  @Column({ type: 'int' })
  deleted: number;

  /** Receives that answered no message (NumberOfEmptyReceives). */
  @Column({ type: 'int' })
  emptyReceives: number;

  /** What the messages kept hold, body and attributes (SentMessageSize's sum), and the largest of them (its maximum). */
  @Column({ type: 'bigint', transformer: bigintColumn })
  sentBytes: bigint;

  @Column({ type: 'int' })
  sentMaxBytes: number;
}
