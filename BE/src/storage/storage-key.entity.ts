import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { Sealed } from '../encryption/envelope';

/** What an access key may do with the functions it names, as IAM groups Lambda's actions. */
export const FUNCTION_ACCESS = ['read', 'invoke', 'write'] as const;
export type FunctionAccess = (typeof FUNCTION_ACCESS)[number];

/** A key's functions: every one of the account's, as IAM's "*" names every resource. */
export const ALL_FUNCTIONS = '*';

/**
 * An access key to an account's buckets (ADR 0009), queues (ADR 0010), mail
 * (ADR 0012) and functions (ADR 0014), as an IAM user's is: its ID, AKFF and
 * 16 characters, its name, and its secret, which the front doors need to
 * check signatures, so it is sealed rather than hashed, for this key alone.
 * Naming nothing, it reaches all the account's buckets, queues and mail and
 * no function; naming some buckets, queues or functions, those alone,
 * read-write or read-only, and its functions at their level. A function's own
 * key names its function, which has one current key at most, for 12 hours: a
 * key renewed is replaced, and works on until no pod holds it. A deploy's own
 * key reaches one bucket for an hour. A revoked or expired key keeps its row,
 * so that its ID is never another's.
 */
@Entity('storage_keys')
@Index(['accountId'])
@Index('UQ_storage_keys_function', ['functionId'], { unique: true, where: '"function_id" IS NOT NULL AND "revoked_at" IS NULL AND "replaced_at" IS NULL' })
@Index('UQ_storage_keys_name', ['accountId', 'name'], { unique: true, where: '"name" IS NOT NULL AND "revoked_at" IS NULL' })
@Check(`"function_access" IN ('read', 'invoke', 'write')`)
@Check(`("functions" IS NULL) = ("function_access" IS NULL)`)
export class StorageKey {
  /** The access key ID. */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** Its name, as an IAM user's, its account's working keys' once; null for a function's or a deploy's key. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  name: string | null;

  /** The function whose key it is; null for the account's own. */
  @Column({ type: 'uuid', nullable: true })
  functionId: string | null;

  /** The secret access key, sealed for this key's ID. */
  @Column({ type: 'jsonb' })
  secret: Sealed;

  /** The buckets it reaches, by name, as an IAM policy names them; null for none named (keyReach says what it reaches). */
  @Column({ type: 'text', array: true, nullable: true })
  buckets: string[] | null;

  /** The queues it reaches, by name; null for none named. */
  @Column({ type: 'text', array: true, nullable: true })
  queues: string[] | null;

  /** The functions it reaches, by name, or ALL_FUNCTIONS; null for none, as a key made before it could name them. */
  @Column({ type: 'text', array: true, nullable: true })
  functions: string[] | null;

  /** What it may do with its functions; null while it names none. */
  @Column({ type: 'varchar', length: 6, nullable: true })
  functionAccess: FunctionAccess | null;

  @Column({ type: 'boolean', default: false })
  readOnly: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** When a request last came signed with it, to the minute. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** When a deploy's or a function's key stops working; null for a key that works until revoked. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** When a function's key was renewed: it works on, until its end or until no pod holds it; null for a current key. */
  @Column({ type: 'timestamptz', nullable: true })
  replacedAt: Date | null;
}
