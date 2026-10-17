import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
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
// The history lists a function's invocations newest first; deleting a function finds them too.
@Index(['functionId', 'createdAt'])
export class FunctionInvocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  functionId: string;

  // Invocation history belongs to the function; deleting the function deletes it
  // (as the original migration already declared).
  @ManyToOne(() => Function, func => func.invocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
