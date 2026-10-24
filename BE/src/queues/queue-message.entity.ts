import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Queue } from './queue.entity';

/**
 * A message of a queue (ADR 0010), in pgmq's shape: kept until a consumer
 * deletes it or it expires. A consumer claims it FOR UPDATE SKIP LOCKED, which
 * hides it until `visibleAt` and counts the receive: a consumer that stops
 * leaves it to come back then. Every queue's messages are in this one table.
 */
@Entity('queue_messages')
@Index(['queueId', 'visibleAt', 'id'])
@Index(['queueId', 'messageId'], { unique: true })
@Index(['expiresAt'])
// The asynchronous calls due, of every function, without reading customers' queues.
@Index(['visibleAt'], { where: `"function_id" IS NOT NULL` })
export class QueueMessage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  queueId: string;

  @ManyToOne(() => Queue, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'queue_id' })
  queue?: Queue;

  /** An asynchronous call's function, its queue's: null in a customer's queue. */
  @Column({ type: 'uuid', nullable: true })
  functionId: string | null;

  /** SQS's MessageId; an asynchronous call's request ID. */
  @Column({ type: 'uuid' })
  messageId: string;

  @Column({ type: 'text' })
  body: string;

  /** What a queue's kind keeps beside the body: an asynchronous call's failures, throttles and settled attempts. */
  @Column({ type: 'jsonb', nullable: true })
  attributes: Record<string, unknown> | null;

  /** What it counts against the account's messages, as the plan limits them, in bytes: an asynchronous call's event. */
  @Column({ type: 'integer' })
  sizeBytes: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;

  /** When it is next visible: now, later for a delay or a retry, past a consumer's lease while claimed. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  visibleAt: Date;

  /** When it goes unhandled: the queue's retention; for an asynchronous call, the longest a function may keep one. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'integer', default: 0 })
  receiveCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  firstReceivedAt: Date | null;
}
