import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Calls refused by their account's rate limit, before they reached their
 * function: those have no usage record, so their number, per function and
 * minute, is kept here for the Throttles metric, as Lambda counts a call it
 * throttles. No foreign key: like the usage records, they outlive a function.
 */
@Entity('rate_limited_invocations')
@Index(['accountId', 'minute'])
export class RateLimitedInvocations {
  @PrimaryColumn({ type: 'uuid' })
  functionId: string;

  /** The minute's start, in UTC. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'int' })
  count: number;
}
