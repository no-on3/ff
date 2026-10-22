import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';

/**
 * A function's schedule, as SAM's Schedule event declares one and EventBridge
 * runs it: a name of its own within the function, an expression, an input or
 * EventBridge's Scheduled Event, enabled or not. The scheduler takes the due
 * ones by their next run. Deleting the function deletes them.
 */
@Entity('schedules')
@Index(['functionId', 'name'], { unique: true })
// What the scheduler asks every few seconds: the enabled schedules due first.
@Index('IDX_schedules_due', ['nextRunAt'], { where: '"enabled"' })
export class Schedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /** As an EventBridge rule's: letters, digits, ".", "-" and "_", 64 at most. */
  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description: string | null;

  /** rate(…) or cron(…), as written. */
  @Column({ type: 'varchar', length: 256 })
  expression: string;

  /** The function's event, as given; null: EventBridge's Scheduled Event. */
  @Column({ type: 'jsonb', nullable: true })
  input: unknown;

  @Column({ default: true })
  enabled: boolean;

  /** When it runs next; null while disabled, or when a cron has no run left. */
  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  /** A rate's runs are every interval from here: when it was made, enabled or changed. */
  @Column({ type: 'timestamptz', nullable: true })
  anchorAt: Date | null;

  /** Its last run: when it was due, the invocation's ID, and how it went or why it was skipped. */
  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lastRequestId: string | null;

  @Column({ type: 'text', nullable: true })
  lastOutcome: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
