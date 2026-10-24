import { Check, Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Function } from './function.entity';

/**
 * A function's settings for its asynchronous calls, as AWS Lambda's
 * EventInvokeConfig: how many times a call its function failed is retried (0
 * to 2), how long a call is kept (60 seconds to 6 hours), and where a call's
 * record goes when it succeeds, or fails for good. Without one, Lambda's
 * defaults: two retries, six hours, no destination. Deleting the function
 * deletes it.
 */
@Entity('function_event_invoke_configs')
@Check(`"maximum_retry_attempts" BETWEEN 0 AND 2`)
@Check(`"maximum_event_age_in_seconds" BETWEEN 60 AND 21600`)
export class FunctionEventInvokeConfig {
  @PrimaryColumn('uuid')
  functionId: string;

  @OneToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /** Null: Lambda's default, 2. */
  @Column({ type: 'smallint', nullable: true })
  maximumRetryAttempts: number | null;

  /** Null: Lambda's default, 21,600 (6 hours). */
  @Column({ type: 'integer', nullable: true })
  maximumEventAgeInSeconds: number | null;

  /** Where a call's record goes once it succeeded: a function of the account, by its ARN, as Lambda's; null: nowhere. */
  @Column({ type: 'text', nullable: true })
  onSuccess: string | null;

  /** Where a call's record goes once its retries are used up or it is too old. */
  @Column({ type: 'text', nullable: true })
  onFailure: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
