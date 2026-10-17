import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { LedgerTransactionKind } from './ledger/ledger-transaction.entity';

export const MAX_TRANSACTIONS_PAGE = 100;
/** A page's `next`: the last transaction's creation, to the microsecond, UTC, and its ID. */
export const TRANSACTIONS_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_([0-9a-f-]{36})$/;

/** GET /billing/balance (P-32): money is a string with every decimal of its currency, never a JSON number. */
export class BalanceView {
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '50.000', description: "The credit left, with the currency's decimals; below zero, usage the credit didn't cover" }) balance: string;
  @ApiProperty({ description: 'D9: usage is rated each hour and shown, but not debited yet' }) shadowMode: boolean;
  @ApiProperty({ example: '2026-10', description: 'This month, by the UTC calendar' }) month: string;
  @ApiProperty({ example: '1.234', description: "This month's hourly charges added up: debited, or in shadow mode only rated" }) charged: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-17T10:00:00.000Z', description: 'The end of the last hour rated: later usage is not charged yet' })
  ratedUntil: Date | null;
}

export class BillingTransactionView {
  @ApiProperty() id: string;
  @ApiProperty({ enum: LedgerTransactionKind, example: 'usage' }) kind: LedgerTransactionKind;
  @ApiProperty({ description: "When what it records happened: a usage debit's hour" }) occurredAt: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ example: '-0.012', description: "What it moved the balance by, with the currency's decimals: a debit is below zero" }) amount: string;
  @ApiProperty({ example: 'TND' }) currency: string;
}

/** GET /billing/transactions: what moved the account's balance, newest first. */
export class BillingTransactionsPage {
  @ApiProperty({ type: [BillingTransactionView] }) transactions: BillingTransactionView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last' }) next: string | null;
}

export class BillingTransactionsQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_TRANSACTIONS_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TRANSACTIONS_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: transactions written before it" })
  @IsOptional()
  @Matches(TRANSACTIONS_CURSOR, { message: "before must be the previous page's next" })
  before?: string;
}
