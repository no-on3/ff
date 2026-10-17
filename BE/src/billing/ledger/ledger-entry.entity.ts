import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { LedgerAccount } from './ledger-account.entity';
import { LedgerTransaction } from './ledger-transaction.entity';

/** PostgreSQL's bigint, which the driver reads as a string, as a JavaScript bigint: never a number. */
export const bigintColumn: ValueTransformer = {
  to: (value: bigint | null | undefined) => (value === null || value === undefined ? value : value.toString()),
  from: (value: string | null) => (value === null ? null : BigInt(value)),
};

/**
 * One line of a ledger transaction (P-31): an amount in the currency's minor
 * units, signed, added to its account's balance. A wallet's balance is the
 * sum of its entries.
 */
@Entity('ledger_entries')
@Check(`"amount_minor" <> 0`)
@Index(['ledgerAccountId'])
@Index(['transactionId'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  transactionId: string;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'transaction_id' })
  transaction?: LedgerTransaction;

  @Column({ type: 'uuid' })
  ledgerAccountId: string;

  @ManyToOne(() => LedgerAccount)
  @JoinColumn({ name: 'ledger_account_id' })
  ledgerAccount?: LedgerAccount;

  @Column({ type: 'bigint', transformer: bigintColumn })
  amountMinor: bigint;
}
