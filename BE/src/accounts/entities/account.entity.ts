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
// A closed account, and only a closed one, has a date for deleting its data; one whose data was deleted had that date.
@Check(`("status" = 'closed') = ("data_deletion_due_at" IS NOT NULL)`)
@Check(`"data_deleted_at" IS NULL OR "data_deletion_due_at" IS NOT NULL`)
// Storage turned off has its reason, and only then.
@Check(`("storage_disabled_at" IS NULL) = ("storage_disabled_reason" IS NULL)`)
@Check(`"bucket_storage_notice" IN (80, 100)`)
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

  /**
   * When a closed account's functions, their invocation history and logs are
   * deleted: its closure plus the notice period of that moment (a platform
   * setting), which the owners' e-mail gives them. Null unless closed.
   */
  @Column({ type: 'timestamptz', nullable: true })
  dataDeletionDueAt: Date | null;

  /** When they were deleted; null until then. */
  @Column({ type: 'timestamptz', nullable: true })
  dataDeletedAt: Date | null;

  /**
   * When FF's operator turned the account's databases and buckets off, its
   * functions going on: its databases' users can't log in. Null while they are on.
   */
  @Column({ type: 'timestamptz', nullable: true })
  storageDisabledAt: Date | null;

  /** The operator's reason, which the account's members read too. */
  @Column({ type: 'text', nullable: true })
  storageDisabledReason: string | null;

  /**
   * The share of its plan's storage that its buckets reached together at their
   * last measure, which its owners were told of: 80, or 100, when uploads wait
   * for room; null under 80% (ADR 0009).
   */
  @Column({ type: 'smallint', nullable: true })
  bucketStorageNotice: 80 | 100 | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
