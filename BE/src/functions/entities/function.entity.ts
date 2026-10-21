import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { FunctionInvocation } from './function-invocation.entity';

export enum FunctionStatus {
  CREATING = 'CREATING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
  DELETED = 'DELETED',
}

export enum Runtime {
  NODEJS = 'nodejs',
  PYTHON = 'python',
}

/**
 * A name belongs to one function of its account, as on AWS Lambda, compared
 * exactly: "Hello" and "hello" are two names. The index also serves every
 * query by account, which all start with its column.
 */
@Entity('functions')
@Index(['accountId', 'name'], { unique: true })
export class Function {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** The account that owns the function (D1). Every query includes it (D4). */
  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({
    type: 'enum',
    enum: Runtime,
    default: Runtime.NODEJS,
  })
  runtime: Runtime;

  @Column('text')
  code: string;

  @Column()
  memory: number;

  @Column()
  timeout: number;

  @Column({
    type: 'enum',
    enum: FunctionStatus,
    default: FunctionStatus.CREATING,
  })
  status: FunctionStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  /** Why the function is in ERROR: the last failed deploy or update. Cleared once a rollout succeeds. */
  @Column({ type: 'varchar', nullable: true })
  error?: string | null;

  /** Instances kept even when idle (provisioned concurrency on Lambda, billed as such: D8). */
  @Column({ default: 0 })
  minInstances: number;

  /** The most instances autoscaling may run: each serves one call at a time (D14). */
  @Column({ default: 3 })
  maxInstances: number;

  /** Not settable: a function scales to zero exactly when its minInstances is 0. */
  @Column({ default: true })
  scaleToZero: boolean;

  @OneToMany(() => FunctionInvocation, invocation => invocation.function)
  invocations: FunctionInvocation[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
