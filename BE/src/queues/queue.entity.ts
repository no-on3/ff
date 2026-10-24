import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';

/** What a queue holds: a customer's messages, as SQS's queues do, or a function's own asynchronous calls waiting to run. */
export enum QueueKind {
  CUSTOMER = 'customer',
  FUNCTION = 'function',
}

/** SQS's redrive policy: after `maxReceiveCount` receives, a message goes to the dead-letter queue its ARN names. */
export interface RedrivePolicy {
  deadLetterTargetArn: string;
  maxReceiveCount: number;
}

/**
 * A queue (ADR 0010). A customer's, of the kind `customer`, is a standard
 * queue of Amazon SQS's, with SQS's attributes and their defaults. A
 * function's own, of the kind `function`, keeps its asynchronous calls until
 * they run: made at its first, it goes with the function, and no customer
 * lists it. Its messages are in queue_messages.
 */
@Entity('queues')
@Index(['accountId', 'name'], { unique: true, where: `"kind" = 'customer'` })
@Index(['functionId'], { unique: true, where: `"kind" = 'function'` })
@Index(['accountId'])
@Check(`"kind" IN ('customer', 'function')`)
@Check(`("kind" = 'function') = ("function_id" IS NOT NULL)`)
@Check(`"visibility_timeout" BETWEEN 0 AND 43200`)
@Check(`"message_retention_seconds" BETWEEN 60 AND 1209600`)
@Check(`"delay_seconds" BETWEEN 0 AND 900`)
@Check(`"maximum_message_size" BETWEEN 1024 AND 1048576`)
@Check(`"receive_wait_seconds" BETWEEN 0 AND 20`)
export class Queue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** A customer's name for it; a function's own is named after the function's ID. */
  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  kind: QueueKind;

  @Column({ type: 'uuid', nullable: true })
  functionId: string | null;

  @ManyToOne(() => Function, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /**
   * What its messages hold together, in bytes, as the plan's limit counts
   * them: a trigger keeps it with each message written and deleted, so that
   * the account's total is a sum over its queues rather than its messages.
   */
  @Column({ type: 'bigint', default: 0 })
  sizeBytes: string;

  /** SQS's VisibilityTimeout, in seconds: how long a message received is hidden from other consumers. */
  @Column({ type: 'integer', default: 30 })
  visibilityTimeout: number;

  /** SQS's MessageRetentionPeriod, in seconds: how long a message is kept, handled or not. */
  @Column({ type: 'integer', default: 345_600 })
  messageRetentionSeconds: number;

  /** SQS's DelaySeconds: how long a new message waits before it can be received. */
  @Column({ type: 'integer', default: 0 })
  delaySeconds: number;

  /** SQS's MaximumMessageSize, in bytes: a message's body and attributes together. */
  @Column({ type: 'integer', default: 1_048_576 })
  maximumMessageSize: number;

  /** SQS's ReceiveMessageWaitTimeSeconds: how long a receive that names none waits for a message. */
  @Column({ type: 'integer', default: 0 })
  receiveWaitSeconds: number;

  /** SQS's RedrivePolicy; null: a message is received as often as it comes back. */
  @Column({ type: 'jsonb', nullable: true })
  redrivePolicy: RedrivePolicy | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
