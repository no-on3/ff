import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A customer's bucket in one hour (ADR 0009, §8): what its listing holds then,
 * its objects' sizes summed and counted, and its name then. Written once an
 * hour for each active bucket of an account that isn't closed, never changed
 * (a trigger refuses UPDATE and DELETE), partitioned by month on the hour, as
 * databases' samples are: the bill prices buckets' storage from these. No
 * foreign key: a sample outlives its bucket.
 */
@Entity('bucket_samples')
@Index(['accountId', 'hour'])
export class BucketSample {
  @PrimaryColumn({ type: 'uuid' })
  bucketId: string;

  /** The hour sampled, its start: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Its name then, which the bill shows once it is deleted too. */
  @Column({ type: 'text' })
  name: string;

  /** Its objects' sizes, as its listing gives them, summed: what S3 bills as storage. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  sizeBytes: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  objects: bigint;
}
