import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { NotificationRule } from './bucket-notifications';

/** Where a bucket is in its life. */
export enum BucketStatus {
  ACTIVE = 'active',
  /** Being emptied and deleted: no request reaches it. */
  DELETING = 'deleting',
}

/**
 * A customer's bucket (ADR 0009), behind FF's S3 front door: its name, AWS's
 * rules, unique across FF as on AWS, and free again once it is deleted, its row
 * with it; in the store, a name of FF's (`storeName`), which says nothing of
 * whose it is.
 */
@Entity('buckets')
@Index(['name'], { unique: true })
@Index(['storeName'], { unique: true })
@Index(['accountId'])
@Check(`"status" IN ('active', 'deleting')`)
export class Bucket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'varchar', length: 63 })
  name: string;

  /** ff- and 24 hexadecimal characters. */
  @Column({ type: 'varchar', length: 27 })
  storeName: string;

  @Column({ type: 'text', default: BucketStatus.ACTIVE })
  status: BucketStatus;

  /**
   * Its notification configurations, as S3 keeps them: the functions and
   * queues its objects' events go to, checked when they are set; null for
   * none.
   */
  @Column({ type: 'jsonb', nullable: true })
  notifications: NotificationRule[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
