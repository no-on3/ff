import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
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
 * A function's public address, as AWS Lambda's function URLs: one per
 * function, at https://<urlId>.<the function domain>/, the ID random and fixed
 * for the URL's life. Deleting the function deletes it.
 */
@Entity('function_urls')
export class FunctionUrl {
  @PrimaryColumn('uuid')
  functionId: string;

  @OneToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** 32 random lowercase letters and digits, as AWS Lambda's: the host's first label. */
  @Index({ unique: true })
  @Column({ type: 'char', length: 32 })
  urlId: string;

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
