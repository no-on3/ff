import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** D7's outcomes: what an invocation ends as, for billing. */
export enum UsageStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  TIMEOUT = 'timeout',
  THROTTLED = 'throttled',
  PLATFORM_ERROR = 'platform_error',
  LOST = 'lost',
}

/**
 * One invocation, as billing sees it (client-readiness plan, P-20, D6): written
 * once, when the invocation ends, in the transaction that records its final
 * state, and never changed (a trigger refuses UPDATE and DELETE). It copies
 * what the price depends on, so deleting or changing the function changes
 * nothing here: no foreign key. Partitioned by month on started_at.
 */
@Entity('usage_records')
@Check(`"status" IN ('success', 'error', 'timeout', 'throttled', 'platform_error', 'lost')`)
@Index(['accountId', 'startedAt'])
@Index(['functionId', 'startedAt'])
export class UsageRecord {
  /** The invocation's ID, which the runtime got as X-FF-Request-Id. */
  @PrimaryColumn({ type: 'uuid' })
  requestId: string;

  /**
   * When the backend took the call: the invocation's createdAt, to the
   * millisecond, as JavaScript reads it (PostgreSQL keeps microseconds). The
   * partition key, so part of the primary key: every writer takes it from the
   * invocation the same way, so a record is written once.
   */
  @PrimaryColumn({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'uuid' })
  functionId: string;

  @Column({ type: 'text' })
  functionName: string;

  @Column({ type: 'text' })
  runtime: string;

  /** The version that ran the call: null for $LATEST, as for every call before versions. */
  @Column({ type: 'integer', nullable: true })
  version: number | null;

  /** The alias the call named: null for none. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  alias: string | null;

  /** The memory of what ran, the function's or its version's, when it was invoked. */
  @Column({ type: 'int' })
  memoryMb: number;

  /**
   * The function's minInstances when it was invoked (P-30): above zero, the
   * call ran on provisioned concurrency, priced apart and without the free
   * tier (D8). Records from before P-30 have 0.
   */
  @Column({ type: 'int', default: 0 })
  minInstances: number;

  /** The runtime's measure; numeric(12,3), which the driver reads as a string. */
  @Column({ type: 'numeric', precision: 12, scale: 3 })
  durationMs: string;

  /** D7: what is billed, in whole milliseconds. */
  @Column({ type: 'int' })
  billedMs: number;

  /** The cold start, when the call had to scale from zero: recorded, not billed (D7). */
  @Column({ type: 'int', nullable: true })
  initMs: number | null;

  @Column({ type: 'text' })
  status: UsageStatus;

  /** When the call ended: the invocation's updatedAt, to the millisecond. */
  @Column({ type: 'timestamptz' })
  endedAt: Date;
}
