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
 * What the function's handler gets as its event: the payload itself, as on AWS
 * Lambda, the default; or FF's original wrapper around it, { body, headers,
 * method, query, path }, which every function made before has.
 */
export enum EventFormat {
  LAMBDA = 'lambda',
  WRAPPED = 'wrapped',
}

/**
 * A service whose endpoint FF gives a function, with its key to its account's
 * buckets, queues and mail (FunctionKeys): named as AWS's configuration names
 * a service's endpoint, its variable being AWS_ENDPOINT_URL_S3, _SQS or _SESV2,
 * which AWS's SDKs read.
 */
export enum AwsEndpoint {
  S3 = 's3',
  SQS = 'sqs',
  SESV2 = 'sesv2',
}

/** Every service FF gives a function the endpoint of, in this order: what a function has unless its owner says otherwise. */
export const AWS_ENDPOINTS: readonly AwsEndpoint[] = Object.values(AwsEndpoint);

/** The services named, in AWS_ENDPOINTS' order, as a function keeps them; every one when none are named. */
export function awsEndpointsOf(named?: readonly AwsEndpoint[]): AwsEndpoint[] {
  return AWS_ENDPOINTS.filter((service) => named === undefined || named.includes(service));
}

/**
 * How the function's code comes, as AWS Lambda's PackageType says it: inline,
 * the one file of `code`, which FF writes as function.ts or function.py; or
 * zip, a package uploaded, its libraries inside.
 */
export enum PackageType {
  INLINE = 'inline',
  ZIP = 'zip',
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

  @Column({ type: 'enum', enum: PackageType, default: PackageType.INLINE })
  packageType: PackageType;

  /** What its runtime calls, as AWS Lambda's Handler: `<file>.<export>` or `<module>.<function>` (code-package.ts). Its pods are told with FF_HANDLER. */
  @Column({ type: 'varchar', length: 128, default: 'function.handler' })
  handler: string;

  /** The SHA-256 of its code, in base64, as AWS Lambda's CodeSha256: of the package, or of inline code's UTF-8. */
  @Column({ type: 'varchar', length: 44 })
  codeSha256: string;

  /** Its code's size in bytes, as AWS Lambda's CodeSize: the package's, or inline code's UTF-8. */
  @Column({ type: 'integer' })
  codeSize: number;

  /**
   * The package its pods run (ADR 0003): its own for a package function; for
   * inline code, the one-file package the backend makes of it, which the purge
   * of unused packages must keep, and the restore of lost code images reads.
   * The backend's to know: no answer gives it. None for inline code not rolled
   * out since packages came.
   */
  @Column({ type: 'varchar', length: 44, nullable: true, select: false })
  packageSha256?: string | null;

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

  /** What its handler gets: AWS Lambda's event, or FF's original wrapper (EventFormat). Its pods are told with FF_EVENT_FORMAT. */
  @Column({ type: 'enum', enum: EventFormat, default: EventFormat.LAMBDA })
  eventFormat: EventFormat;

  /**
   * The services whose endpoint its pods get from FF (AwsEndpoint): every one,
   * unless its owner sends one to AWS's own, as a move to AWS goes, a service
   * at a time; the code then gives that service's client an AWS key of its own,
   * kept as a secret, and AWS's region. FF's key and region are still given,
   * for the services FF serves.
   */
  @Column({ type: 'enum', enum: AwsEndpoint, array: true, default: awsEndpointsOf() })
  awsEndpoints: AwsEndpoint[];

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
