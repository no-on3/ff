import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { bigintColumn } from '../../database/bigint-column';
import { LedgerAccount } from './ledger-account.entity';
import { LedgerTransaction } from './ledger-transaction.entity';

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
