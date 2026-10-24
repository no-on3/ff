import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';
import { Queue } from '../queues/queue.entity';

/**
 * A function reading a queue of its account, as AWS Lambda's event source
 * mapping for SQS: FF receives the queue's messages in batches of up to
 * `batchSize`, waiting up to `maximumBatchingWindowInSeconds` to fill one,
 * and calls the function with SQS's event, deleting each message the call
 * handled. Over 10 messages a batch needs a window, as on Lambda. A function
 * reads a queue once. Deleting the function or the queue deletes it.
 */
@Entity('event_source_mappings')
@Index(['functionId', 'queueId'], { unique: true })
@Index(['accountId'])
@Index(['queueId'])
@Check(`"batch_size" BETWEEN 1 AND 10000`)
@Check(`"maximum_batching_window_in_seconds" BETWEEN 0 AND 300`)
@Check(`"batch_size" <= 10 OR "maximum_batching_window_in_seconds" > 0`)
@Check(`"maximum_concurrency" BETWEEN 2 AND 1000`)
export class EventSourceMapping {
  /** Lambda's UUID of the mapping. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'uuid' })
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @Column({ type: 'uuid' })
  queueId: string;

  @ManyToOne(() => Queue, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'queue_id' })
  queue?: Queue;

  /** The most messages in one call. */
  @Column({ type: 'integer', default: 10 })
  batchSize: number;

  /** How long FF waits to fill a batch, in seconds; 0: a call with what one receive gives. */
  @Column({ type: 'integer', default: 0 })
  maximumBatchingWindowInSeconds: number;

  /** Lambda's ReportBatchItemFailures: the call's answer names the messages that failed, and the others are deleted. */
  @Column({ default: false })
  reportBatchItemFailures: boolean;

  /** Lambda's ScalingConfig: the most batches in calls at once; null, as many as the function's instances. */
  @Column({ type: 'integer', nullable: true })
  maximumConcurrency: number | null;

  /** Lambda's state Enabled, or Disabled: then nothing is read, and the messages wait. */
  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Lambda's LastModified. */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
