import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';
import { Bucket } from '../storage/bucket.entity';

/**
 * A tag on one of an account's resources, as AWS's: a key, the resource's
 * once, and its value. Each row is one resource's, by that resource's column:
 * a function's or a bucket's, which go with it.
 */
@Entity('resource_tags')
@Index(['functionId', 'key'], { unique: true })
@Index(['bucketId', 'key'], { unique: true })
@Check(`num_nonnulls("function_id", "bucket_id") = 1`)
export class ResourceTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'uuid', nullable: true })
  functionId: string | null;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @Column({ type: 'uuid', nullable: true })
  bucketId: string | null;

  @ManyToOne(() => Bucket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bucket_id' })
  bucket?: Bucket;

  /** Up to 128 characters, as AWS's. */
  @Column({ type: 'varchar', length: 128 })
  key: string;

  /** Up to 256 characters, empty allowed, as AWS's. */
  @Column({ type: 'varchar', length: 256 })
  value: string;
}
