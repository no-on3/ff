import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Plan } from './plan.entity';

export enum AccountStatus {
  /** Created, waiting for your approval during the beta (P-71): can't deploy or invoke. */
  PENDING = 'pending',
  ACTIVE = 'active',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
  CLOSED = 'closed',
}

/** The tenant (D1): functions, members, keys and bills belong to an account. */
@Entity('accounts')
@Check(`"status" IN ('pending', 'active', 'rejected', 'suspended', 'closed')`)
export class Account {
  /** 12 random digits, the AWS-shaped format of ADR 0004. */
  @PrimaryColumn({ type: 'char', length: 12 })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: AccountStatus.PENDING })
  status: AccountStatus;

  @Column({ type: 'text' })
  planId: string;

  @ManyToOne(() => Plan)
  @JoinColumn({ name: 'plan_id' })
  plan?: Plan;

  @Column({ type: 'char', length: 2, default: 'TN' })
  country: string;

  /** The tax ID (matricule fiscal), for B2B invoices. */
  @Column({ type: 'text', nullable: true })
  taxId: string | null;

  /** D5: off until an operator turns it on (P-62, P-71). */
  @Column({ default: false })
  internetEgress: boolean;

  /** What the customer plans to build, for your review of the account (P-71). */
  @Column({ type: 'text', nullable: true })
  useCase: string | null;

  /**
   * P-33: the low-balance e-mails, at these shares of the last credit, as the
   * owners set them, largest first; null for the platform's (lowBalancePercents).
   */
  @Column({ type: 'int', array: true, nullable: true })
  lowBalancePercents: number[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
