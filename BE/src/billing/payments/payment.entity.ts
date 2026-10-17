import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { bigintColumn } from '../../database/bigint-column';
import { Currency } from '../currency.entity';
import { LedgerTransaction } from '../ledger/ledger-transaction.entity';

/** How the customer pays: by bank transfer for now (P-35); a card gateway later. */
export enum PaymentMethod {
  BANK_TRANSFER = 'bank_transfer',
}

export enum PaymentStatus {
  /** A pro-forma waits for its transfer. */
  PENDING = 'pending',
  /** The transfer was recorded and credited: all of it, or all but the share withheld at source. */
  PAID = 'paid',
  /**
   * Its owner or an operator cancelled it before any transfer (P-74). A
   * transfer that still comes is recorded against it, and makes it paid:
   * the money is never left without a pro-forma.
   */
  CANCELLED = 'cancelled',
}

/**
 * A payment for prepaid credit (P-35, D9; parent Appendix E): a pro-forma the
 * owner asked for, with the credit, the VAT on top and a payment reference;
 * then the transfer an operator recorded against that reference, with any
 * share withheld at source; then, for that share, the withholding
 * certificate. Each step credits the wallet through the ledger. A pending
 * one may be cancelled (P-74); a transfer that comes anyway still pays it.
 */
@Entity('payments')
@Check(`"method" IN ('bank_transfer')`)
@Check(`"status" IN ('pending', 'paid', 'cancelled')`)
@Check(`"credit_minor" > 0 AND "vat_minor" >= 0 AND "total_minor" = "credit_minor" + "vat_minor"`)
@Check(`("status" = 'paid') = ("received_minor" IS NOT NULL AND "withheld_minor" IS NOT NULL AND "received_minor" + "withheld_minor" = "total_minor")`)
@Check(`("certificate_key" IS NULL) = ("certificate_transaction_id" IS NULL) AND ("certificate_key" IS NULL OR "withheld_minor" > 0)`)
@Check(`("cancelled_at" IS NULL) = ("cancelled_by" IS NULL) AND ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL) AND ("status" <> 'pending' OR "cancelled_at" IS NULL)`)
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({ type: 'text' })
  method: PaymentMethod;

  /** What the buyer writes in the transfer's label: FF-XXXX-XXXX. */
  @Index({ unique: true })
  @Column({ type: 'text' })
  reference: string;

  @Column({ type: 'text', default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  /** The credit bought, before tax, in minor units. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  creditMinor: bigint;

  /** D9: VAT on top of the credit, at this rate. */
  @Column({ type: 'smallint' })
  vatPercent: number;

  @Column({ type: 'bigint', transformer: bigintColumn })
  vatMinor: bigint;

  /** What the buyer pays: the credit and the VAT. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  totalMinor: bigint;

  /** The buyer, as the pro-forma names them: the account's name and tax ID when it was asked for. */
  @Column({ type: 'text' })
  buyerName: string;

  @Column({ type: 'text', nullable: true })
  buyerTaxId: string | null;

  /** Who asked for the pro-forma: user:<id>, or dev. */
  @Column({ type: 'text' })
  requestedBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** The transfer: what reached FF's account, and what the buyer withheld at source (parent §8.5). */
  @Column({ type: 'bigint', transformer: bigintColumn, nullable: true })
  receivedMinor: bigint | null;

  @Column({ type: 'bigint', transformer: bigintColumn, nullable: true })
  withheldMinor: bigint | null;

  /** The transfer's date on the bank statement. */
  @Column({ type: 'date', nullable: true })
  receivedOn: string | null;

  /** The bank's reference for the transfer, as the statement gives it. */
  @Column({ type: 'text', nullable: true })
  bankReference: string | null;

  /** The operator who recorded the transfer: operator:<id>. */
  @Column({ type: 'text', nullable: true })
  recordedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  recordedAt: Date | null;

  /** The credit of the transfer: wallet, VAT payable, the bank's clearing. */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'ledger_transaction_id' })
  ledgerTransaction?: LedgerTransaction;

  /** The withholding certificate, in object storage, and its type. */
  @Column({ type: 'text', nullable: true })
  certificateKey: string | null;

  @Column({ type: 'text', nullable: true })
  certificateType: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  certificateAt: Date | null;

  /** The credit of the withheld share, with the certificate. */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  certificateTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'certificate_transaction_id' })
  certificateTransaction?: LedgerTransaction;

  /** When it was cancelled (P-74). It stays when a transfer comes anyway, and pays it. */
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  /** Who cancelled it: user:<id> for an owner, operator:<id> for FF. */
  @Column({ type: 'text', nullable: true })
  cancelledBy: string | null;
}
