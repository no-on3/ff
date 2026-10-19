import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';

/**
 * The secret an account's webhooks are signed with, made at its first need.
 * Kept as it is, since FF signs with it. After a rotation the previous one
 * signs too, until previousExpiresAt, so that receivers can change over.
 */
@Entity('webhook_secrets')
export class WebhookSecret {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  @OneToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({ type: 'text' })
  secret: string;

  @Column({ type: 'text', nullable: true })
  previousSecret: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  previousExpiresAt: Date | null;

  /** When the current secret was made: at the first need, or at its rotation. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
