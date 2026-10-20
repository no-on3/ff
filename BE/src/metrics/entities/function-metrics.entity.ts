import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Function } from '../../functions/entities/function.entity';

@Entity('function_metrics')
@Index(['functionId', 'timestamp']) // Index for time-series queries
export class FunctionMetrics {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function: Function;

  @Column({ type: 'timestamptz' })
  @Index() // Index for time-based queries
  timestamp: Date;

  @Column('float')
  memoryUsage: number;

  @Column('integer')
  requestCount: number;

  @Column('float')
  responseTimeP50: number;

  @Column('float')
  responseTimeP95: number;

  @Column('float')
  responseTimeP99: number;

  @Column('integer')
  errorCount: number;

  @Column('integer')
  activeInstances: number;

  /** The most calls in flight at once during the minute: the scaling signal (D14). */
  @Column('integer', { default: 0 })
  maxConcurrency: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
