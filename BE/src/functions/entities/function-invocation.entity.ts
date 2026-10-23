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
  /** No instance could take the call in time: the runtime answered 429 (P-15). Not billed (D7). */
  THROTTLED = 'THROTTLED',
  /** The backend restarted during the call: its answer was lost, and it isn't billed (P-20, D6). */
  LOST = 'LOST',
}

/** What brought an invocation: the API's invoke, a request to the function's URL, one of its schedules, or an asynchronous call's attempt. */
export enum InvocationSource {
  API = 'api',
  URL = 'url',
  SCHEDULE = 'schedule',
  /** The API's invoke with the invocation type Event, run from the function's queue, as AWS Lambda runs it (ADR 0010). */
  ASYNC = 'async',
}

@Entity('function_invocations')
// The history lists a function's invocations newest first; deleting a function finds them too.
@Index(['functionId', 'createdAt'])
@Index(['requestId'])
export class FunctionInvocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The request's ID, as the function's runtime, its logs and its usage record
   * name it: the invocation's own ID, but for an asynchronous call's later
   * attempts, which keep the first's, as AWS Lambda's retries keep theirs.
   */
  @Column({ type: 'uuid' })
  requestId: string;

  /** Which attempt of its request it was: an asynchronous call's are counted from 1, as its queue received it; any other call is its first. */
  @Column({ type: 'smallint', default: 1 })
  attempt: number;

  @Column()
  functionId: string;

  // Invocation history belongs to the function; deleting the function deletes it
  // (as the original migration already declared).
  @ManyToOne(() => Function, func => func.invocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function: Function;

  /** The caller's input, a JSON object; in the history, the start of its JSON text when inputTruncated (P-45). */
  @Column({ type: 'jsonb', nullable: true })
  input: unknown;

  /** Whatever the handler returned: any JSON value; in the history, the start of its JSON text when outputTruncated (P-45). */
  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({
    type: 'enum',
    enum: InvocationStatus,
  })
  status: InvocationStatus;

  /** What brought it: the API, the function's URL, a schedule, or an asynchronous call. */
  @Column({ type: 'enum', enum: InvocationSource, default: InvocationSource.API })
  source: InvocationSource;

  @Column('float', { default: 0.0 })
  duration: number;

  @Column('float',{ nullable: true })
  memoryUsed?: number;

  @Column({ nullable: true })
  error?: string;

  /**
   * P-45: the history kept only the first 64 KiB of the input's compact JSON
   * text, as a string (history.ts). The invoke's own answer has it whole.
   */
  @Column({ default: false })
  inputTruncated: boolean;

  /** P-45: the same, for the output. */
  @Column({ default: false })
  outputTruncated: boolean;

  /** P-45: the history kept only the first 64 KiB of the error. */
  @Column({ default: false })
  errorTruncated: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
