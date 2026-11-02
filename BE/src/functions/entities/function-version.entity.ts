import { Column, CreateDateColumn, Entity, Generated, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AwsEndpoint } from '../../common/aws-endpoint';
import type { Sealed } from '../../encryption/envelope';
import { EventFormat, Function, PackageType, Runtime } from './function.entity';

/**
 * A version of a function, as AWS Lambda's PublishVersion makes one: 1, 2, 3…,
 * never given twice, and frozen: the package its pods run, its runtime,
 * handler, memory, timeout, event format and endpoints, and its environment as
 * it was, sealed as the function's is. The function itself is $LATEST, which
 * changes. Deleting the function deletes its versions.
 */
@Entity('function_versions')
export class FunctionVersion {
  @PrimaryColumn('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @PrimaryColumn({ type: 'integer' })
  version: number;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** What its publisher said of it, as Lambda's Description: up to 256 characters. */
  @Column({ type: 'varchar', length: 256, default: '' })
  description: string;

  @Column({ type: 'enum', enum: Runtime })
  runtime: Runtime;

  @Column({ type: 'varchar', length: 128 })
  handler: string;

  @Column({ type: 'enum', enum: PackageType })
  packageType: PackageType;

  /** Inline code's text, of which its one-file package is made again should object storage lose it; empty for a package. */
  @Column('text')
  code: string;

  /** As the function's when it was published: the package's SHA-256, or inline code's, in base64. */
  @Column({ type: 'varchar', length: 44 })
  codeSha256: string;

  @Column({ type: 'integer' })
  codeSize: number;

  /** The package its pods run, which the purge of unused packages keeps while the version is there. The backend's to know. */
  @Column({ type: 'varchar', length: 44, select: false })
  packageSha256?: string;

  @Column({ type: 'integer' })
  memory: number;

  @Column({ type: 'integer' })
  timeout: number;

  @Column({ type: 'enum', enum: EventFormat })
  eventFormat: EventFormat;

  @Column({ type: 'enum', enum: AwsEndpoint, array: true })
  awsEndpoints: AwsEndpoint[];

  /** Its variables and secrets as they were, sealed for this version alone; none when the function had none. Never in an answer. */
  @Column({ type: 'jsonb', nullable: true, select: false })
  environment?: Sealed | null;

  /** Lambda's RevisionId of a version: given at its publish, and never changed, as a version never changes. */
  @Column({ type: 'uuid' })
  @Generated('uuid')
  revisionId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
