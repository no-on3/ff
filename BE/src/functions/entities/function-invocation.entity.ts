import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Function } from './function.entity';

export enum InvocationStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
  TIMEOUT = 'TIMEOUT',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
}

@Entity('function_invocations')
export class FunctionInvocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  functionId: string;

  @ManyToOne(() => Function, func => func.invocations)
  @JoinColumn({ name: 'functionId' })
  function: Function;

  @Column({ type: 'jsonb', nullable: true })
  input: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  output: Record<string, any>;

  @Column({
    type: 'enum',
    enum: InvocationStatus,
  })
  status: InvocationStatus;

  @Column('float', { default: 0.0 })
  duration: number;

  @Column('float',{ nullable: true })
  memoryUsed?: number;
  @Column('float',{ nullable: true })
  cpuUsed?: number;

  @Column({ nullable: true })
  error?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
