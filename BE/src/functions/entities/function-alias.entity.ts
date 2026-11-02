import { Check, Column, CreateDateColumn, Entity, Generated, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Function } from './function.entity';

/**
 * An alias of a function, as AWS Lambda's: a name its calls can come through,
 * pointing at a version or at $LATEST, the function as it is, and at most one
 * more version with a share of its calls. Its name is its function's once.
 * The versions it names are checked under the function's lock, as a version is
 * deleted under it too. Deleting the function deletes its aliases.
 */
@Entity('function_aliases')
@Check(`("additional_version" IS NULL) = ("additional_weight" IS NULL)`)
@Check(`"additional_weight" BETWEEN 0 AND 1`)
@Check(`"additional_version" IS NULL OR "version" IS NOT NULL`)
export class FunctionAlias {
  @PrimaryColumn('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The version its calls go to; null for $LATEST. */
  @Column({ type: 'integer', nullable: true })
  version: number | null;

  /** Another version, which gets `additionalWeight` of its calls, from 0 to 1, as Lambda's AdditionalVersionWeights; never with $LATEST. */
  @Column({ type: 'integer', nullable: true })
  additionalVersion: number | null;

  @Column({ type: 'double precision', nullable: true })
  additionalWeight: number | null;

  /** What it is for, as Lambda's Description: up to 256 characters. */
  @Column({ type: 'varchar', length: 256, default: '' })
  description: string;

  /** Lambda's RevisionId of an alias: new with each change, so that a change given the one its caller read is refused once another came between. */
  @Column({ type: 'uuid' })
  @Generated('uuid')
  revisionId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
