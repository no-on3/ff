import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { FunctionAlias } from './function-alias.entity';
import { Function } from './function.entity';

/** Who may call a function's URL, as AWS Lambda names it: anyone, or a caller with the account's credentials. */
export enum UrlAuthType {
  NONE = 'NONE',
  /** On FF, an API key of the function's account with functions:invoke, until AWS's request signing comes. */
  AWS_IAM = 'AWS_IAM',
}

/** How the answer is sent, as AWS Lambda names it: whole, once the function returns. Lambda's RESPONSE_STREAM isn't offered. */
export enum UrlInvokeMode {
  BUFFERED = 'BUFFERED',
}

/** A function URL's CORS, as AWS Lambda's Cors, its fields in camelCase. */
export interface UrlCors {
  allowCredentials?: boolean;
  allowHeaders?: string[];
  allowMethods?: string[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
}

/**
 * A function's public address, as AWS Lambda's function URLs: one for
 * $LATEST, and one for each of its aliases, at https://<urlId>.<the function
 * domain>/, the ID random and fixed for the URL's life. Deleting the function
 * deletes them, and deleting an alias its own.
 */
@Entity('function_urls')
@Index(['functionId', 'alias'], { unique: true })
// An alias's URL is its own once by the index above, which a null alias, $LATEST's, never repeats: this one does.
@Index('UQ_function_urls_latest', ['functionId'], { unique: true, where: `"alias" IS NULL` })
export class FunctionUrl {
  /** 32 random lowercase letters and digits, as AWS Lambda's: the host's first label. */
  @PrimaryColumn({ type: 'char', length: 32 })
  urlId: string;

  @Column('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /** The alias whose calls it makes, as Lambda's Qualifier: null for $LATEST's URL. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  alias: string | null;

  @ManyToOne(() => FunctionAlias, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'function_id', referencedColumnName: 'functionId' },
    { name: 'alias', referencedColumnName: 'name' },
  ])
  aliasOf?: FunctionAlias;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column({ type: 'enum', enum: UrlAuthType })
  authType: UrlAuthType;

  /** None: no CORS headers, and a browser's preflight goes to the function like any request. */
  @Column({ type: 'jsonb', nullable: true })
  cors: UrlCors | null;

  @Column({ type: 'enum', enum: UrlInvokeMode, default: UrlInvokeMode.BUFFERED })
  invokeMode: UrlInvokeMode;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
