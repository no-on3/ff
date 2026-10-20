import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The last number given in a series and fiscal year (P-36; parent Appendix E).
 * Its row is locked while an invoice is numbered, and the number is given in
 * the transaction that writes the invoice: a failure takes it back, so the
 * numbers have no gap.
 */
@Entity('invoice_counters')
@Check(`"series" IN ('FAC', 'AV')`)
@Check(`"last_number" >= 0`)
export class InvoiceCounter {
  @PrimaryColumn({ type: 'text' })
  series: string;

  @PrimaryColumn({ type: 'smallint' })
  fiscalYear: number;

  @Column({ type: 'int' })
  lastNumber: number;
}
