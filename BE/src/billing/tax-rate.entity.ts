import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { bigintColumn } from '../database/bigint-column';
import { Currency } from './currency.entity';

export enum TaxKind {
  /** Value added tax, a percent of the pre-tax amount. */
  VAT = 'vat',
  /** Stamp duty, an amount per invoice. */
  STAMP_DUTY = 'stamp_duty',
}

/**
 * A tax rate, from the day it applies until the next one of its kind (P-36;
 * parent §8.6: tax rules are dated data, not code). VAT is a percent; stamp
 * duty an amount in a currency. A rate changes by a new row from a later
 * day: rows are written once, never changed.
 */
@Entity('tax_rates')
@Check(`"kind" IN ('vat', 'stamp_duty')`)
@Check(`("kind" = 'vat') = ("percent" IS NOT NULL AND "amount_minor" IS NULL AND "currency" IS NULL)`)
@Check(`("kind" = 'stamp_duty') = ("percent" IS NULL AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL)`)
@Check(`"percent" IS NULL OR "percent" BETWEEN 0 AND 100`)
@Check(`"amount_minor" IS NULL OR "amount_minor" >= 0`)
export class TaxRate {
  @PrimaryColumn({ type: 'text' })
  kind: TaxKind;

  /** The first day it applies, in Tunisia. */
  @PrimaryColumn({ type: 'date' })
  validFrom: string;

  @Column({ type: 'smallint', nullable: true })
  percent: number | null;

  @Column({ type: 'bigint', transformer: bigintColumn, nullable: true })
  amountMinor: bigint | null;

  @Column({ type: 'char', length: 3, nullable: true })
  currency: string | null;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  /** Where it comes from: the law that sets it. */
  @Column({ type: 'text' })
  source: string;
}
