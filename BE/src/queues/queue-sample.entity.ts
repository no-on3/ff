import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A customer's queue in one minute, as CloudWatch's approximate metrics of
 * SQS's have it: its messages that can be received
 * (ApproximateNumberOfMessagesVisible), those received and hidden
 * (ApproximateNumberOfMessagesNotVisible), those waiting for their delay
 * (ApproximateNumberOfMessagesDelayed), and its oldest message's age
 * (ApproximateAgeOfOldestMessage). Written once a minute for every queue
 * holding a message, never changed (a trigger refuses UPDATE and DELETE), and
 * partitioned by month on the minute. No foreign key: a sample outlives its
 * queue.
 */
@Entity('queue_samples')
@Index(['accountId', 'minute'])
export class QueueSample {
  @PrimaryColumn({ type: 'uuid' })
  queueId: string;

  /** The minute sampled, by the database's clock: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'int' })
  visible: number;

  @Column({ type: 'int' })
  notVisible: number;

  @Column({ type: 'int' })
  delayed: number;

  /** Seconds since its oldest message was sent. */
  @Column({ type: 'int' })
  oldestAgeSeconds: number;
}
