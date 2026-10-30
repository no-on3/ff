import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { Sealed } from '../encryption/envelope';

/**
 * An access key to an account's buckets (ADR 0009) and queues (ADR 0010), as
 * an IAM user's is: its ID, AKFF and 16 characters, and its secret, which the
 * S3 front door and the SQS endpoint need to check signatures, so it is
 * sealed rather than hashed, for this key alone. It reaches all the account's
 * buckets and queues, or, naming some, those alone, read-write or read-only.
 * A function's own key names its function, which has one that works at most.
 * A deploy's own key reaches one bucket for an hour. A revoked or expired key
 * keeps its row, so that its ID is never another's.
 */
@Entity('storage_keys')
@Index(['accountId'])
@Index('UQ_storage_keys_function', ['functionId'], { unique: true, where: '"function_id" IS NOT NULL AND "revoked_at" IS NULL' })
export class StorageKey {
  /** The access key ID. */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

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

  @Column({ type: 'boolean', default: false })
  readOnly: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** When a request last came signed with it, to the minute. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** When a deploy's key stops working; null for a key that works until revoked. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;
}
