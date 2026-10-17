import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Role } from '../../auth/principal';
import { Account } from './account.entity';
import { User } from './user.entity';

/** A user's role in an account (D4). A user can belong to several accounts. */
@Entity('memberships')
@Check(`"role" IN ('owner', 'developer', 'viewer')`)
@Index(['userId'])
export class Membership {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @Column({ type: 'text' })
  role: Role;

  @ManyToOne(() => Account, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
