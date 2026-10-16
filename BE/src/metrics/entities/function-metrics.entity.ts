import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
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

  @ManyToOne(() => Function)
  function: Function;

  @Column({ type: 'timestamptz' })
  @Index() // Index for time-based queries
  timestamp: Date;

  @Column('float')
  cpuUsage: number;

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

  @CreateDateColumn()
  createdAt: Date;
}
