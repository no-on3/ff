import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Currency } from './currency.entity';
import type { PriceDocument } from './price-book';

/**
 * A version of FF's prices (P-30, D8), valid from its start until the next
 * book's. Usage is always rated with the book valid when it happened, so a
 * book that has started is never changed or deleted: a trigger refuses it.
 */
@Entity('price_books')
export class PriceBook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency' })
  currencyRow?: Currency;

  /** From this instant until the next book's. */
  @Index({ unique: true })
  @Column({ type: 'timestamptz' })
  validFrom: Date;

  /** The whole book: its source, free tier and prices (src/billing/price-book.ts). */
  @Column({ type: 'jsonb' })
  prices: PriceDocument;

  /** Who made it: "system" for the first, an operator for the next ones (P-73). */
  @Column({ type: 'text' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
