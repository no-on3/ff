import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { User } from '../../accounts/entities/user.entity';

/**
 * An API key (D3): `ffk_<id>_<secret>`. Only the secret's SHA-256 is kept; the
 * key acts for its account, with its scopes, and never with more than its
 * creator's current role there.
 */
@Entity('api_keys')
@Index(['accountId'])
export class ApiKey {
  /** 12 lowercase hex characters: the <key ID> of the key, safe to show and to log. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({ type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by' })
  creator?: User;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'bytea' })
  secretSha256: Buffer;

  @Column({ type: 'text', array: true })
  scopes: string[];

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
