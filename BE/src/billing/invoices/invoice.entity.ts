import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { bigintColumn } from '../../database/bigint-column';
import { Currency } from '../currency.entity';
import { LedgerTransaction } from '../ledger/ledger-transaction.entity';

export enum InvoiceKind {
  /** The month's invoice: the credit bought, one line per payment (D9). */
  INVOICE = 'invoice',
  /** A credit note (facture d'avoir): an issued invoice corrected, never edited. */
  CREDIT_NOTE = 'credit_note',
}

/** Each kind's own numbers, gapless per fiscal year: FAC-2026-000001, AV-2026-000001. */
export const INVOICE_SERIES: Record<InvoiceKind, string> = { [InvoiceKind.INVOICE]: 'FAC', [InvoiceKind.CREDIT_NOTE]: 'AV' };

/**
 * An issued invoice or credit note (P-36, D9; parent §8.6), written once,
 * complete, in the transaction that numbers it, and never changed: a
 * correction is a credit note. Its PDF is in object storage under pdf_key.
 * A month's invoice that isn't issued yet is no row: the drafts are worked out
 * from the payments not invoiced yet.
 */
@Entity('invoices')
@Index(['accountId', 'month'], { unique: true, where: `"kind" = 'invoice'` })
@Index(['kind', 'fiscalYear', 'sequence'], { unique: true })
@Index(['accountId', 'issuedAt'])
@Check(`"kind" IN ('invoice', 'credit_note')`)
@Check(`"sequence" > 0`)
@Check(`"subtotal_minor" >= 0 AND "vat_minor" >= 0 AND "stamp_duty_minor" >= 0 AND "withheld_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor" + "stamp_duty_minor"`)
@Check(`("kind" = 'invoice') = ("month" IS NOT NULL AND "corrects_id" IS NULL AND "reason" IS NULL)`)
@Check(`("kind" = 'credit_note') = ("corrects_id" IS NOT NULL AND "reason" IS NOT NULL AND "stamp_duty_minor" = 0 AND "withheld_minor" = 0)`)
@Check(`("stamp_duty_minor" > 0) = ("stamp_transaction_id" IS NOT NULL)`)
export class Invoice {
  /** Chosen by the backend, before the PDF is written. */
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  @Column({ type: 'text' })
  kind: InvoiceKind;

  /** FAC-2026-000001: the series, the fiscal year and the sequence. */
  @Column({ type: 'text', unique: true })
  number: string;

  /** The year of the issue date. */
  @Column({ type: 'smallint' })
  fiscalYear: number;

  @Column({ type: 'int' })
  sequence: number;

  /** An invoice's month, YYYY-MM: the payments received up to its end and not invoiced before. */
  @Column({ type: 'char', length: 7, nullable: true })
  month: string | null;

  /** The issue date, in Tunisia. */
  @Column({ type: 'date' })
  issuedOn: string;

  @CreateDateColumn({ type: 'timestamptz' })
  issuedAt: Date;

  /** operator:<id>, as the audit log names them. */
  @Column({ type: 'text' })
  issuedBy: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  /** Before tax: the lines added up. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  subtotalMinor: bigint;

  @Column({ type: 'bigint', transformer: bigintColumn })
  vatMinor: bigint;

  /** The stamp duty in force on the issue date; none on a credit note. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  stampDutyMinor: bigint;

  /** Subtotal, VAT and stamp duty. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  totalMinor: bigint;

  /** What the buyer withheld at source on the invoice's payments: the invoice shows the gross. */
  @Column({ type: 'bigint', transformer: bigintColumn, default: 0 })
  withheldMinor: bigint;

  /** The buyer, as the account was on the issue date. */
  @Column({ type: 'text' })
  buyerName: string;

  @Column({ type: 'text', nullable: true })
  buyerTaxId: string | null;

  /** A credit note's invoice. */
  @Column({ type: 'uuid', nullable: true })
  correctsId: string | null;

  @ManyToOne(() => Invoice)
  @JoinColumn({ name: 'corrects_id' })
  corrects?: Invoice;

  /** Why a credit note was issued. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** Where the PDF is kept: invoices/<number>.pdf. */
  @Column({ type: 'text' })
  pdfKey: string;

  /** The stamp duty's posting: wallet −, stamp duty +. */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  stampTransactionId: string | null;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'stamp_transaction_id' })
  stampTransaction?: LedgerTransaction;
}
