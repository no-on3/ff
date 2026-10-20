import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Function } from '../functions/entities/function.entity';
import type { AlarmState, Comparison, Evaluation, Metric, MissingData, Statistic } from './alarm-rules';

/** Who an alarm tells when its state changes: the owners' e-mail, each in their language, and signed webhooks. */
export interface AlarmActions {
  email: boolean;
  webhookUrls: string[];
}

/**
 * An alarm on a metric, as CloudWatch's: a function's, or the account's
 * when it names none; evaluated every minute, telling its actions when it
 * goes into ALARM and when it leaves it. It goes with its function.
 */
@Entity('alarms')
@Check(`"state" IN ('OK', 'ALARM', 'INSUFFICIENT_DATA')`)
@Check(`"treat_missing_data" IN ('missing', 'notBreaching', 'breaching', 'ignore')`)
@Check(`"period" IN (60, 300, 3600)`)
@Check(`"datapoints_to_alarm" BETWEEN 1 AND "evaluation_periods" AND "evaluation_periods" <= 60`)
export class Alarm {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** null: the account's, all its functions together, or its money. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  functionId: string | null;

  @ManyToOne(() => Function, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  metric: Metric;

  @Column({ type: 'text' })
  statistic: Statistic;

  /** Seconds per datapoint. */
  @Column({ type: 'int' })
  period: number;

  @Column({ type: 'text' })
  comparison: Comparison;

  @Column({ type: 'double precision' })
  threshold: number;

  /** N: the periods judged. */
  @Column({ type: 'int' })
  evaluationPeriods: number;

  /** M: how many of them must breach. */
  @Column({ type: 'int' })
  datapointsToAlarm: number;

  @Column({ type: 'text', default: 'missing' })
  treatMissingData: MissingData;

  @Column({ type: 'jsonb' })
  actions: AlarmActions;

  @Column({ type: 'text', default: 'INSUFFICIENT_DATA' })
  state: AlarmState;

  /** Why, in English, as CloudWatch's StateReason. */
  @Column({ type: 'text', nullable: true })
  stateReason: string | null;

  /** The evaluation's parts, which each language's e-mail is written from. */
  @Column({ type: 'jsonb', nullable: true })
  stateReasonData: Evaluation | null;

  @Column({ type: 'timestamptz', nullable: true })
  stateChangedAt: Date | null;

  /** The last evaluation; a backend takes the alarm again a minute after. */
  @Column({ type: 'timestamptz', nullable: true })
  evaluatedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
