import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Function } from '../functions/entities/function.entity';

/**
 * A tag on one of an account's resources, as AWS's: a key, the resource's
 * once, and its value. A function's go with it. The row has an ID of its own,
 * so that queues' and buckets' tags can join the same table, each with its
 * resource's column.
 */
@Entity('resource_tags')
@Index(['functionId', 'key'], { unique: true })
export class ResourceTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /** Up to 128 characters, as AWS's. */
  @Column({ type: 'varchar', length: 128 })
  key: string;

  /** Up to 256 characters, empty allowed, as AWS's. */
  @Column({ type: 'varchar', length: 256 })
  value: string;
}
