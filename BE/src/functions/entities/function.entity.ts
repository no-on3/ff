import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
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

@Entity('functions')
export class Function {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  userId: string;

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
  metadata: Record<string, any>;

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
