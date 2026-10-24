import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A function's asynchronous calls in one minute, as one backend counted them,
 * for Lambda's metrics of them: the events kept for it (AsyncEventsReceived),
 * those that ended without its success (AsyncEventsDropped), the records its
 * destinations didn't take (DestinationDeliveryFailures), and each attempt's
 * age, from the event's keeping to the attempt (AsyncEventAge). Written once,
 * when the minute is over or the backend stops, never changed (a trigger
 * refuses UPDATE and DELETE), partitioned by month on the minute. No foreign
 * key: a count outlives its function.
 */
@Entity('async_event_counts')
@Index(['accountId', 'minute'])
export class AsyncEventCount {
  @PrimaryColumn({ type: 'uuid' })
  functionId: string;

  /** The minute's start: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  /** The process that counted them. */
  @PrimaryColumn({ type: 'uuid' })
  writer: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'int' })
  received: number;

  @Column({ type: 'int' })
  dropped: number;

  @Column({ type: 'int' })
  destinationFailures: number;

  /** The attempts made, their ages added up, and the oldest, in milliseconds. */
  @Column({ type: 'int' })
  attempts: number;

  @Column({ type: 'bigint', transformer: bigintColumn })
  ageMsSum: bigint;

  @Column({ type: 'int' })
  ageMsMax: number;
}
