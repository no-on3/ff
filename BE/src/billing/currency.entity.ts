import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/** A currency FF prices and bills in (P-30): TND to start. */
@Entity('currencies')
@Check(`"exponent" BETWEEN 0 AND 4`)
export class Currency {
  /** ISO 4217: "TND". */
  @PrimaryColumn({ type: 'char', length: 3 })
  code: string;

  /** The digits of its minor unit, to which money is rounded: 3 for TND, whose millimes are thousandths. */
  @Column({ type: 'smallint' })
  exponent: number;
}
