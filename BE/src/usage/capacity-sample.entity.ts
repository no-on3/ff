import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A function's ready instances in one minute (client-readiness plan, P-21, D6):
 * the capacity it held, which D8's cost model weighs against what is billed,
 * and its minInstances, which D8 bills as provisioned time. Written once a
 * minute for every function with a ready instance, never changed (a trigger
 * refuses UPDATE and DELETE), and partitioned by month on minute, as usage
 * records are. No foreign key: a sample outlives its function.
 */
@Entity('capacity_samples')
@Index(['accountId', 'minute'])
export class CapacitySample {
  @PrimaryColumn({ type: 'uuid' })
  functionId: string;

  /** The minute sampled, by the database's clock: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  minute: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Instances ready to serve. */
  @Column({ type: 'int' })
  instances: number;

  /** The function's minInstances then: D8's provisioned time. */
  @Column({ type: 'int' })
  minInstances: number;

  /** The function's memory then. */
  @Column({ type: 'int' })
  memoryMb: number;
}
