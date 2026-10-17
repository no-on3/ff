import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AdminChange } from '../../admin/admin.dto';
import { PaymentStatus } from './payment.entity';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
export const MAX_PAYMENTS_PAGE = 100;
/** A page's `next`: the last payment's creation, to the microsecond, UTC, and its ID. */
export const PAYMENTS_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_([0-9a-f-]{36})$/;

/** POST /billing/pro-formas: the credit to buy, before tax. */
export class RequestProFormaDto {
  @ApiProperty({ example: '50.000', description: 'Credit before tax, with up to the currency\'s decimals; VAT comes on top' })
  @Matches(AMOUNT, { message: 'credit must be an amount, such as 50.000' })
  credit: string;
}

export class PartyView {
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String, description: 'Tax ID (matricule fiscal)' }) taxId: string | null;
}

export class SellerView extends PartyView {
  @ApiProperty() address: string;
}

export class BankView {
  @ApiProperty() name: string;
  @ApiProperty({ example: 'TN59 1000 6035 1835 9847 8831' }) iban: string;
  @ApiProperty({ nullable: true, type: String }) bic: string | null;
}

export class TransferView {
  @ApiProperty({ example: '58.608', description: "What reached FF's account" }) received: string;
  @ApiProperty({ example: '0.892', description: 'What the buyer withheld at source (parent §8.5)' }) withheld: string;
  @ApiProperty({ example: '2026-10-20', description: "The transfer's date on the bank statement" }) receivedOn: string;
  @ApiProperty() recordedAt: Date;
  @ApiProperty({ example: '49.108', description: 'The credit added with the transfer: the credit less the share withheld' }) credited: string;
  @ApiProperty({ nullable: true, type: String, description: 'When the withholding certificate came, and the withheld share was credited' })
  withheldCreditedAt: Date | null;
}

/** A pro-forma, and the transfer recorded against it (P-35): money as strings with every decimal of the currency. */
export class ProFormaView {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'FF-7KQ2-9MXA', description: "What the buyer writes in the transfer's label" }) reference: string;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '50.000' }) credit: string;
  @ApiProperty({ example: 19 }) vatPercent: number;
  @ApiProperty({ example: '9.500' }) vat: string;
  @ApiProperty({ example: '59.500' }) total: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: PartyView, description: 'The account, as it was when the pro-forma was asked for' }) buyer: PartyView;
  @ApiProperty({ type: SellerView }) seller: SellerView;
  @ApiProperty({ type: BankView, description: 'Where to pay' }) bank: BankView;
  @ApiProperty({ nullable: true, type: TransferView, description: 'Null until FF records the transfer' }) transfer: TransferView | null;
}

export class ProFormasPage {
  @ApiProperty({ type: [ProFormaView], description: 'Newest first, the last 100' }) proFormas: ProFormaView[];
  @ApiProperty({ example: 19, description: "The VAT rate a pro-forma asked for now gets, in percent: today's, in Tunisia" }) vatPercent: number;
}

/** A payment, as operators see it (P-35, P-74): who asked, who recorded, the certificate. */
export class AdminPaymentView extends ProFormaView {
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty({ example: 'user:3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' }) requestedBy: string;
  @ApiProperty({ nullable: true, type: String }) bankReference: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'operator:kc-op-1' }) recordedBy: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'application/pdf', description: "The withholding certificate's type, once added" }) certificateType: string | null;
}

export class AdminPaymentsPage {
  @ApiProperty({ type: [AdminPaymentView] }) payments: AdminPaymentView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last' }) next: string | null;
}

export class AdminPaymentsQuery {
  @ApiPropertyOptional({ enum: PaymentStatus, description: 'pending: pro-formas waiting for their transfer' })
  @IsOptional()
  @IsIn(Object.values(PaymentStatus), { message: `status must be one of: ${Object.values(PaymentStatus).join(', ')}` })
  status?: PaymentStatus;

  @ApiPropertyOptional({ example: '000000000001' })
  @IsOptional()
  @Matches(/^\d{12}$/, { message: 'accountId must be an account ID: 12 digits' })
  accountId?: string;

  @ApiPropertyOptional({ example: 'FF-7KQ2-9MXA', description: "A payment reference as a bank statement shows it, in any case, with or without dashes" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reference?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAYMENTS_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAYMENTS_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: payments asked for before it" })
  @IsOptional()
  @Matches(PAYMENTS_CURSOR, { message: "before must be the previous page's next" })
  before?: string;
}

/** POST /admin/bank-transfers: a transfer as the bank statement shows it, against its pro-forma's reference (P-35). */
export class RecordTransferDto extends AdminChange {
  @ApiProperty({ example: 'FF-7KQ2-9MXA', description: "The reference in the transfer's label, in any case, with or without dashes" })
  @IsString()
  @MaxLength(40)
  reference: string;

  @ApiProperty({ example: '58.608', description: "What reached FF's account" })
  @Matches(AMOUNT, { message: 'received must be an amount, such as 59.500' })
  received: string;

  @ApiProperty({ example: '0.892', description: 'What the buyer withheld at source; 0 for none' })
  @Matches(AMOUNT, { message: 'withheld must be an amount, such as 0.892, or 0' })
  withheld: string;

  @ApiProperty({ example: '2026-10-20', description: "The transfer's date on the bank statement" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'receivedOn must be a date, such as 2026-10-20' })
  receivedOn: string;

  @ApiPropertyOptional({ example: 'VIR-2026-10-20-0042', description: "The bank's reference for the transfer" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankReference?: string;
}
