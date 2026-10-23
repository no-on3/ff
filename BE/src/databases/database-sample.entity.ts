import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A customer's database in one hour (ADR 0008): its size and its sessions
 * then, as the server counts them, and its name then. Written once an hour for
 * each database of an account that isn't closed, never changed (a trigger
 * refuses UPDATE and DELETE), partitioned by month on the hour, as capacity
 * samples are: the bill prices storage from these. No foreign key: a sample
 * outlives its database.
 */
@Entity('database_samples')
@Index(['accountId', 'hour'])
export class DatabaseSample {
  @PrimaryColumn({ type: 'uuid' })
  databaseId: string;

  /** The hour sampled, its start, by the database's clock: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Its name in the account then, which the bill shows once it is deleted too. */
  @Column({ type: 'text' })
  name: string;

  /** pg_database_size then. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  sizeBytes: bigint;

  /** Its sessions then: pg_stat_database's numbackends. */
  @Column({ type: 'int' })
  connections: number;
}
