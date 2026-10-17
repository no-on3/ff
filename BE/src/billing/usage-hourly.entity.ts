import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';
import { PriceBook } from './price-book.entity';

/**
 * An hour of one function's usage, as the rater takes it (P-32, D9): the
 * hour's billed calls and minute samples, summed once the hour has settled,
 * with the minimum billed duration of the hour's price book applied to each
 * call. Written once, never changed; like the usage records, it outlives the
 * function.
 */
@Entity('usage_hourly')
@Index(['hour'])
export class UsageHourly {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  /** The hour's start, UTC. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @PrimaryColumn({ type: 'uuid' })
  functionId: string;

  /** The book valid during the hour, which prices it. */
  @Column({ type: 'uuid' })
  priceBookId: string;

  @ManyToOne(() => PriceBook)
  @JoinColumn({ name: 'price_book_id' })
  priceBook?: PriceBook;

  /** Billed calls without provisioned concurrency (D7), and their MB-ms. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  onDemandRequests: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  onDemandMbMs: bigint;

  /** Billed calls with minInstances above zero (D8), and their MB-ms. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  provisionedRequests: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  provisionedMbMs: bigint;

  /** MB-ms of minInstances held, from the minute samples (P-21). */
  @Column({ type: 'bigint', transformer: bigintColumn })
  provisionedTimeMbMs: bigint;

  /** MB-ms of ready instances above minInstances, from the same samples. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  reservedMbMs: bigint;
}
