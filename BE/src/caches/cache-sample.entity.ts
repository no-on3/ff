import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A customer's cache in one hour (ADR 0013): its memory, the plan's, which
 * the hour is billed for; what its keys used, its connections, and its hits,
 * misses and evictions since its process started, as its server counts them;
 * and its name then. Written once an hour for each cache of an account that
 * isn't closed, never changed (a trigger refuses UPDATE and DELETE),
 * partitioned by month on the hour, as databases' samples are: the bill
 * prices its memory from these, and its metrics read them. No foreign key: a
 * sample outlives its cache.
 */
@Entity('cache_samples')
@Index(['accountId', 'hour'])
export class CacheSample {
  @PrimaryColumn({ type: 'uuid' })
  cacheId: string;

  /** The hour sampled, its start, by the database's clock: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Its name in the account then, which the bill shows once it is deleted too. */
  @Column({ type: 'text' })
  name: string;

  /** Its memory then, its maxmemory: what an hour of it is billed for, whatever its keys use. */
  @Column({ type: 'integer' })
  memoryMb: number;

  /** What its keys and their overhead used then: INFO's used_memory, ElastiCache's BytesUsedForCache. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  bytesUsed: bigint;

  /** Its connections then, FF's own left out: ElastiCache's CurrConnections. */
  @Column({ type: 'integer' })
  connections: number;

  /** INFO's keyspace_hits, keyspace_misses and evicted_keys, since its process started: an hour's are the next hour's sample's less this one's, unless it started again between them. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  hits: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  misses: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  evictions: bigint;

  /** When its process started, as its uptime said then: the next sample's, later, says it started again between them, its counts from zero. */
  @Column({ type: 'timestamptz' })
  processStartedAt: Date;
}
