import { Check, Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * An e-mail to FF's operator about a month's invoices (P-36, D9): that they
 * are ready to issue, then, after the platform's invoiceReminderDay, that some
 * still aren't. Once each per month, whichever backend writes the row first
 * sends it. Written once, never changed.
 */
@Entity('invoice_notices')
@Check(`"kind" IN ('ready', 'reminder')`)
export class InvoiceNotice {
  @PrimaryColumn({ type: 'char', length: 7 })
  month: string;

  @PrimaryColumn({ type: 'text' })
  kind: 'ready' | 'reminder';

  /** The invoices waiting then. */
  @Column({ type: 'int' })
  waiting: number;

  @CreateDateColumn({ type: 'timestamptz' })
  sentAt: Date;
}
