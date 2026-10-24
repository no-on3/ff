import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';
import { PriceBook } from './price-book.entity';

/**
 * An hour of one customer's database, bucket or queue, as the rater takes it
 * (ADR 0008, ADR 0009, ADR 0010), beside usage_hourly's functions: its size
 * sampled in the hour, in byte-hours, a bucket's requests by S3's two
 * classes, a queue's as SQS bills them; with its name then, which the
 * statement shows. Written once, never changed; it outlives its database,
 * bucket or queue.
 */
@Entity('resource_usage_hourly')
@Index(['hour'])
@Check(`"kind" IN ('database', 'bucket', 'queue')`)
export class ResourceUsageHourly {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  /** The hour's start, UTC. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @PrimaryColumn({ type: 'uuid' })
  resourceId: string;

  @Column({ type: 'text' })
  kind: 'database' | 'bucket' | 'queue';

  /** Its name in the account when it was sampled. */
  @Column({ type: 'text' })
  name: string;

  /** The book valid during the hour, which prices it. */
  @Column({ type: 'uuid' })
  priceBookId: string;

  @ManyToOne(() => PriceBook)
  @JoinColumn({ name: 'price_book_id' })
  priceBook?: PriceBook;

  /** Its size sampled in the hour, times one hour; 0 when it wasn't sampled. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  byteHours: bigint;

  /** 1 when it was sampled in the hour, else 0: a database's monthly fee counts these. */
  @Column({ type: 'smallint' })
  hours: number;

  /** S3's first class of request (PUT, COPY, POST, LIST) and its second (GET and the others); 0 for a database or a queue. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  tier1Requests: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  tier2Requests: bigint;

  /** A queue's requests, each 64 KB of a request's messages one; 0 for a database or a bucket. */
  @Column({ type: 'bigint', transformer: bigintColumn, default: 0 })
  requests: bigint;
}
