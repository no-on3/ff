import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Currency } from '../currency.entity';

/** The ledger's accounts (P-31, parent §8.3): a customer's wallet, and FF's own. */
export enum LedgerAccountType {
  /** A customer account's prepaid credit: what FF owes it in usage. */
  WALLET = 'wallet',
  /** Usage debited from wallets. */
  REVENUE = 'revenue',
  /** VAT collected on top-ups, owed to the state (D9). */
  VAT_PAYABLE = 'vat_payable',
  /** The 1 TND stamp duty of each invoice (D9). */
  STAMP_DUTY = 'stamp_duty',
  /** Money a payment provider has collected for FF and not yet settled. */
  PROVIDER_CLEARING = 'provider_clearing',
  /** What the credit FF gives away costs it: promotions and corrections in a customer's favour. */
  PROMOTIONAL_CREDIT = 'promotional_credit',
}

/**
 * One account of the ledger, in one currency: a customer account's wallet, or
 * one of FF's own (no customer account). One of each kind per currency, and
 * one wallet per customer account and currency.
 */
@Entity('ledger_accounts')
@Check(`"type" IN ('wallet', 'revenue', 'vat_payable', 'stamp_duty', 'provider_clearing', 'promotional_credit')`)
@Check(`("type" = 'wallet') = ("account_id" IS NOT NULL)`)
@Index(['accountId', 'type', 'currency'], { unique: true, where: '"account_id" IS NOT NULL' })
@Index(['type', 'currency'], { unique: true, where: '"account_id" IS NULL' })
export class LedgerAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The customer account, for a wallet; null for FF's own. */
  @Column({ type: 'char', length: 12, nullable: true })
  accountId: string | null;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({ type: 'text' })
  type: LedgerAccountType;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
