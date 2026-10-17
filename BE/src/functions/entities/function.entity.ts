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

  @Column({ default: 100 })
  cpu: number;

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

  @Column({ nullable: true })
  error?: string;

  @Column({ default: 0 })
  minInstances: number;

  @Column({ default: 1 })
  maxInstances: number;

  @Column({ default: 100 })
  targetConcurrency: number;

  @Column({ default: true })
  scaleToZero: boolean;

  @OneToMany(() => FunctionInvocation, invocation => invocation.function)
  invocations: FunctionInvocation[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
