import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Currency } from './currency.entity';
import { LedgerTransaction } from './ledger/ledger-transaction.entity';
import { bigintColumn } from '../database/bigint-column';

/**
 * What an account was charged for an hour of usage (P-32, D9): its month so
 * far, rated and rounded once, less what the month's earlier hours were
 * charged. In shadow mode it is recorded and not debited; otherwise its
 * ledger transaction debits it. Written once, never changed.
 */
@Entity('usage_charges')
export class UsageCharge {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** The hour's start, UTC. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  /** The hour's charge in minor units: 0 when the free tier covers it. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  amountMinor: bigint;

  /** The month up to the hour's end, rated and rounded once: the sum of its hours' charges. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  monthToDateMinor: bigint;

  /** Rated in shadow mode (D9): recorded, not debited. */
  @Column({ type: 'boolean' })
  shadow: boolean;

  /** The debit; null in shadow mode, or for a charge of 0. */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'ledger_transaction_id' })
  ledgerTransaction?: LedgerTransaction;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
