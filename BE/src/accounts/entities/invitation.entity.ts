import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from '../../auth/principal';
import { Account } from './account.entity';
import { User } from './user.entity';

/**
 * An owner's invitation to join an account with a role (P-16). Whoever next
 * calls the API with a token for that e-mail address joins: Keycloak verified
 * the address. Kept once accepted, for the record; an account has one open
 * invitation per address at most.
 */
@Entity('invitations')
@Check(`"role" IN ('owner', 'developer', 'viewer')`)
@Index(['email'])
@Index(['accountId', 'email'], { unique: true, where: '"accepted_at" IS NULL' })
export class Invitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** Lowercase, as compared with the token's address. */
  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text' })
  role: Role;

  @Column({ type: 'uuid' })
  invitedBy: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invited_by' })
  inviter?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Seven days after it was sent, or sent again. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'accepted_by' })
  accepter?: User;
}
