import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../../database/bigint-column';
import { Payment } from '../payments/payment.entity';
import { Invoice } from './invoice.entity';

/**
 * A line of an invoice or credit note (P-36), written with it, never changed.
 * An invoice's line is a payment's credit, before tax, with its VAT: each
 * payment is invoiced once. A credit note's lines name no payment.
 */
@Entity('invoice_lines')
@Check(`"line_no" > 0`)
@Check(`"amount_minor" > 0 AND "vat_minor" >= 0`)
@Check(`"vat_percent" BETWEEN 0 AND 100`)
export class InvoiceLine {
  @PrimaryColumn({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => Invoice)
  @JoinColumn({ name: 'invoice_id' })
  invoice?: Invoice;

  @PrimaryColumn({ type: 'smallint' })
  lineNo: number;

  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  @ManyToOne(() => Payment)
  @JoinColumn({ name: 'payment_id' })
  payment?: Payment;

  @Column({ type: 'text' })
  description: string;

  /** Before tax. */
  @Column({ type: 'bigint', transformer: bigintColumn })
  amountMinor: bigint;

  @Column({ type: 'smallint' })
  vatPercent: number;

  @Column({ type: 'bigint', transformer: bigintColumn })
  vatMinor: bigint;
}
