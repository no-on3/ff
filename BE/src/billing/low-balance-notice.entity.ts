import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { bigintColumn } from '../database/bigint-column';
import { LedgerTransaction } from './ledger/ledger-transaction.entity';

/**
 * A low-balance e-mail (P-33): the balance fell to a share of the last credit,
 * and the owners were told. Once per share and credit: the next credit
 * starts again. Written once, never changed.
 */
@Entity('low_balance_notices')
export class LowBalanceNotice {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** The last credit when the balance fell: its share is counted from it. */
  @PrimaryColumn({ type: 'uuid' })
  creditTransactionId: string;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'credit_transaction_id' })
  creditTransaction?: LedgerTransaction;

  /** The share of the credit, in percent, that the balance fell to or below. */
  @PrimaryColumn({ type: 'smallint' })
  percent: number;

  /** The balance then, in minor units. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  balanceMinor: bigint;

  @CreateDateColumn({ type: 'timestamptz' })
  notifiedAt: Date;
}
