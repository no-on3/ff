import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';

/**
 * A bucket's requests in one minute and one of AWS's classes (ADR 0009, §7),
 * as one front door counted them: never a row per request. Written once, when
 * the minute is over or the front door stops, never changed (a trigger refuses
 * UPDATE and DELETE), partitioned by month on the minute, as usage records
 * are: buckets' requests are billed from these. Each writer is a front door's
 * process, so that two backends counting the same minute write two rows. No
 * foreign key: a count outlives its bucket, its name with it.
 */
@Entity('storage_request_counts')
@Index(['accountId', 'minute'])
@Check(`"class" IN ('tier1', 'tier2', 'free', 'website')`)
export class StorageRequestCount {
  @PrimaryColumn({ type: 'uuid' })
  bucketId: string;

  /** The minute's start: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  /** tier1: PUT, COPY, POST and LIST; tier2: GET, HEAD and the rest; free: DELETE, an upload aborted; website: a site's, billed as tier2. */
  @PrimaryColumn({ type: 'text' })
  class: 'tier1' | 'tier2' | 'free' | 'website';

  /** The process that counted them. */
  @PrimaryColumn({ type: 'uuid' })
  writer: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The bucket's name then, which the bill shows once it is deleted too. */
  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'int' })
  requests: number;

  /** Of them, the HTTP GETs and PUTs, as CloudWatch's GetRequests and PutRequests count them. */
  @Column({ type: 'int' })
  gets: number;

  @Column({ type: 'int' })
  puts: number;

  /** Of them, those answered 4xx and 5xx. */
  @Column({ type: 'int' })
  errors4xx: number;

  @Column({ type: 'int' })
  errors5xx: number;

  /** The bodies' bytes, uploaded and downloaded. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  bytesIn: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  bytesOut: bigint;
}
