import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What moved money (parent Appendix E). */
export enum LedgerTransactionKind {
  TOPUP = 'topup',
  USAGE = 'usage',
  INVOICE = 'invoice',
  PAYMENT = 'payment',
  REFUND = 'refund',
  PROMO = 'promo',
  ADJUSTMENT = 'adjustment',
  WITHHOLDING = 'withholding',
}

/**
 * One movement of money (P-31): its entries sum to zero, checked when the
 * database transaction commits. Written once; a correction is another one.
 * Its idempotency key makes a retry a no-op: usage:<account>:<hour>,
 * konnect:<payment>, and so on.
 */
@Entity('ledger_transactions')
@Check(`"kind" IN ('topup', 'usage', 'invoice', 'payment', 'refund', 'promo', 'adjustment', 'withholding')`)
export class LedgerTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  kind: LedgerTransactionKind;

  @Index({ unique: true })
  @Column({ type: 'text' })
  idempotencyKey: string;

  /** When what it records happened, such as the hour of usage; createdAt is when it was written. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
