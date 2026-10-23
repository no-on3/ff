import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';

/** What a queue holds: a customer's messages, as SQS's queues do, or a function's own asynchronous calls waiting to run. */
export enum QueueKind {
  CUSTOMER = 'customer',
  FUNCTION = 'function',
}

/**
 * A queue (ADR 0010). A function's own, of the kind `function`, keeps its
 * asynchronous calls until they run: made at its first, it goes with the
 * function, and no customer lists it. Its messages are in queue_messages.
 */
@Entity('queues')
@Index(['accountId', 'name'], { unique: true, where: `"kind" = 'customer'` })
@Index(['functionId'], { unique: true, where: `"kind" = 'function'` })
@Index(['accountId'])
@Check(`"kind" IN ('customer', 'function')`)
@Check(`("kind" = 'function') = ("function_id" IS NOT NULL)`)
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
