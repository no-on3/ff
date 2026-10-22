import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';

/**
 * A function's package: a zip as AWS Lambda takes one, its handler's file and
 * its libraries inside, uploaded once and named by its SHA-256, which a
 * function gives in place of inline code. Its bytes are in object storage
 * (packageKey), and the row keeps what a function naming it needs: its sizes,
 * and its files, where a handler is looked for. An account has each package
 * once, however many times it is uploaded.
 */
@Entity('packages')
@Index(['accountId', 'codeSha256'], { unique: true })
export class Package {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** The zip's SHA-256 in base64, as AWS Lambda's CodeSha256: the package's name. */
  @Column({ type: 'varchar', length: 44 })
  codeSha256: string;

  /** The zip's size in bytes, as AWS Lambda's CodeSize. */
  @Column({ type: 'integer' })
  codeSize: number;

  /** Its files' sizes together, unpacked. */
  @Column({ type: 'integer' })
  unpackedSize: number;

  /** How many files it has. */
  @Column({ type: 'integer' })
  fileCount: number;

  /** Its files' paths from its root, sorted: up to 20,000, so read only when asked for. */
  @Column({ type: 'text', array: true, select: false })
  files: string[];

  /** Made by the backend of a function's inline code, rather than uploaded: not in the account's list, nor its limit of unused ones. */
  @Column({ type: 'boolean', default: false })
  inline: boolean;

  /** Its code image's manifest digest, once made (ADR 0003): sha256:<hex>. */
  @Column({ type: 'varchar', length: 71, nullable: true })
  imageDigest: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * Its upload, or the last time a function named it: the retention job deletes
   * a package that no function names an hour after this, so that one named for
   * a rollout under way is kept until its function's record names it.
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  usedAt: Date;
}

/** Where object storage keeps a package's zip: under its account, named by its SHA-256 in hex. */
export function packageKey(accountId: string, codeSha256: string): string {
  return `packages/${accountId}/${Buffer.from(codeSha256, 'base64').toString('hex')}.zip`;
}
