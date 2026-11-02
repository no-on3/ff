import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** The version of a sample of $LATEST's Deployment: a key's column can't be null, and no version is numbered 0. */
export const LATEST_SAMPLED = 0;

/**
 * The ready instances of one of a function's Deployments in one minute,
 * $LATEST's or a version's: the capacity it held, which the cost model weighs
 * against what is billed, and the minInstances it kept warm, billed as
 * provisioned time. Written once a minute for each Deployment with a ready
 * instance, never changed (a trigger refuses UPDATE and DELETE), and
 * partitioned by month on minute, as usage records are. No foreign key: a
 * sample outlives its function.
 */
@Entity('capacity_samples')
@Index(['accountId', 'minute'])
export class CapacitySample {
  @PrimaryColumn({ type: 'uuid' })
  functionId: string;

  /** The version whose pods these are, LATEST_SAMPLED for $LATEST's. */
  @PrimaryColumn({ type: 'integer', default: LATEST_SAMPLED })
  version: number;

  /** The minute sampled, by the database's clock: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Instances ready to serve. */
  @Column({ type: 'int' })
  instances: number;

  /** The function's minInstances then, billed as provisioned time; 0 for a version, whose instances are never warm. */
  @Column({ type: 'int' })
  minInstances: number;

  /** Its memory then: the function's, or the version's as published. */
  @Column({ type: 'int' })
  memoryMb: number;
}
