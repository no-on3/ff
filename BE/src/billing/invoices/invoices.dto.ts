import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AdminChange } from '../../admin/admin.dto';
import { MONTH } from '../tunisia';
import { InvoiceKind } from './invoice.entity';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const ACCOUNT_ID = /^\d{12}$/;
export const MAX_INVOICES_PAGE = 100;
/** A page's `next`: the last document's issue instant, to the microsecond, UTC, and its ID. */
export const INVOICES_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_([0-9a-f-]{36})$/;

/** An issued invoice or credit note (P-36), money as strings with every decimal of the currency. */
export class InvoiceView {
  @ApiProperty() id: string;
  @ApiProperty({ enum: InvoiceKind }) kind: InvoiceKind;
  @ApiProperty({ example: 'FAC-2026-000001' }) number: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-10', description: "An invoice's month" }) month: string | null;
  @ApiProperty({ example: '2026-11-02', description: 'The issue date, in Tunisia' }) issuedOn: string;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '50.000', description: 'Before tax' }) subtotal: string;
  @ApiProperty({ example: '9.500' }) vat: string;
  @ApiProperty({ example: '1.000', description: 'Taken from the credit when the invoice was issued; none on a credit note' }) stampDuty: string;
  @ApiProperty({ example: '60.500' }) total: string;
  @ApiProperty({ nullable: true, type: String, example: 'FAC-2026-000001', description: "A credit note's invoice" }) corrects: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Why a credit note was issued' }) reason: string | null;
}

export class InvoicesPage {
  @ApiProperty({ type: [InvoiceView], description: 'Newest first, the last 100' }) invoices: InvoiceView[];
}

/** An issued document, as operators see it (P-36, P-74). */
export class AdminInvoiceView extends InvoiceView {
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty({ description: 'The buyer, as the account was on the issue date' }) buyerName: string;
  @ApiProperty({ nullable: true, type: String }) buyerTaxId: string | null;
  @ApiProperty({ example: 'operator:kc-op-1' }) issuedBy: string;
  @ApiProperty({ example: '0.892', description: 'What the buyer withheld at source on the payments: the invoice shows the gross' }) withheld: string;
}

export class AdminInvoicesPage {
  @ApiProperty({ type: [AdminInvoiceView] }) invoices: AdminInvoiceView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last' }) next: string | null;
}

export class DraftLineView {
  @ApiProperty() paymentId: string;
  @ApiProperty({ example: 'FF-7KQ2-9MXA' }) reference: string;
  @ApiProperty({ example: '2026-10-20' }) receivedOn: string;
  @ApiProperty({ description: "The line's text on the invoice, in French" }) description: string;
  @ApiProperty({ example: '50.000' }) amount: string;
  @ApiProperty({ example: 19 }) vatPercent: number;
  @ApiProperty({ example: '9.500' }) vat: string;
}

/** A month's invoice not issued yet (D9): worked out from the account's payments not invoiced yet. */
export class DraftView {
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty() buyerName: string;
  @ApiProperty({ nullable: true, type: String }) buyerTaxId: string | null;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ type: [DraftLineView] }) lines: DraftLineView[];
  @ApiProperty({ example: '50.000' }) subtotal: string;
  @ApiProperty({ example: '9.500' }) vat: string;
  @ApiProperty({ example: '1.000', description: 'The stamp duty in force today' }) stampDuty: string;
  @ApiProperty({ example: '60.500' }) total: string;
  @ApiProperty({ example: '0.892' }) withheld: string;
}

export class DraftsPage {
  @ApiProperty({ example: '2026-10' }) month: string;
  @ApiProperty({ description: 'Whether the month is over, so its invoices can be issued' }) issuable: boolean;
  @ApiProperty({ type: [DraftView] }) drafts: DraftView[];
}

export class DraftsQuery {
  @ApiPropertyOptional({ example: '2026-10', description: 'The month; last month in Tunisia when left out' })
  @IsOptional()
  @Matches(MONTH, { message: 'month must be a month, such as 2026-10' })
  month?: string;
}

/** POST /admin/invoices/issue: a month's invoices, every draft's or the accounts named. */
export class IssueInvoicesDto extends AdminChange {
  @ApiProperty({ example: '2026-10' })
  @Matches(MONTH, { message: 'month must be a month, such as 2026-10' })
  month: string;

  @ApiPropertyOptional({ type: [String], example: ['000000000001'], description: "Only these accounts' drafts; every draft of the month when left out" })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Matches(ACCOUNT_ID, { each: true, message: 'each of accountIds must be an account ID: 12 digits' })
  accountIds?: string[];
}

export class IssueFailure {
  @ApiProperty() accountId: string;
  @ApiProperty() problem: string;
}

export class IssueResult {
  @ApiProperty({ type: [AdminInvoiceView] }) issued: AdminInvoiceView[];
  @ApiProperty({ type: [IssueFailure] }) failed: IssueFailure[];
}

export class AdminInvoicesQuery {
  @ApiPropertyOptional({ example: '000000000001' })
  @IsOptional()
  @Matches(ACCOUNT_ID, { message: 'accountId must be an account ID: 12 digits' })
  accountId?: string;

  @ApiPropertyOptional({ enum: InvoiceKind })
  @IsOptional()
  @IsIn(Object.values(InvoiceKind), { message: `kind must be one of: ${Object.values(InvoiceKind).join(', ')}` })
  kind?: InvoiceKind;

  @ApiPropertyOptional({ example: '2026-10', description: "Invoices of a month; a credit note has none" })
  @IsOptional()
  @Matches(MONTH, { message: 'month must be a month, such as 2026-10' })
  month?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_INVOICES_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INVOICES_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: documents issued before it" })
  @IsOptional()
  @Matches(INVOICES_CURSOR, { message: "before must be the previous page's next" })
  before?: string;
}

export class CreditNoteLineDto {
  @ApiProperty({ example: 'Remboursement du crédit non consommé' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  description: string;

  @ApiProperty({ example: '20.000', description: 'Before tax' })
  @Matches(AMOUNT, { message: 'amount must be an amount, such as 20.000' })
  amount: string;

  @ApiPropertyOptional({ example: 19, description: "One of the invoice's VAT rates; its only rate when left out" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  vatPercent?: number;
}

/** POST /admin/invoices/:id/credit-notes: what the credit note gives back, before tax, line by line. */
export class CreditNoteDto extends AdminChange {
  @ApiProperty({ type: [CreditNoteLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lines: CreditNoteLineDto[];
}
