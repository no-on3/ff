import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { Sealed } from '../../encryption/envelope';
import { Function } from './function.entity';

/**
 * A function's environment: its variables and its secrets, sealed together
 * with a data key of the function's own, bound to its ID. Apart from
 * `functions`, so that listing or serializing functions never loads it. A
 * function without any has no row.
 */
@Entity('function_environments')
export class FunctionEnvironment {
  @PrimaryColumn('uuid')
  functionId: string;

  @OneToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Random, new with every change: the Deployment names it, so a new one rolls out. Says nothing about the values. */
  @Column('text')
  revision: string;

  /** The variables and secrets, sealed: { variables, secrets } as JSON. */
  @Column({ type: 'jsonb' })
  document: Sealed;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
