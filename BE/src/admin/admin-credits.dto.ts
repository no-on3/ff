import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { AdminAccountView } from './admin-accounts.dto';
import { AdminChange } from './admin.dto';
import { GRANT_KINDS, GrantKind } from './credit-grants';

/** An amount as an operator types it, a string: digits, then a point and decimals; a minus sign first for a correction that takes credit away. */
const AMOUNT = /^-?\d{1,16}(\.\d{1,6})?$/;

/** POST /admin/accounts/:id/credits (P-74): credit FF gives, with its reason. */
export class AdminGrantDto extends AdminChange {
  @ApiProperty({ enum: GRANT_KINDS, description: 'promo: promotional credit, above 0; adjustment: a correction, either way' })
  @IsIn(GRANT_KINDS, { message: `kind must be one of: ${GRANT_KINDS.join(', ')}` })
  kind: GrantKind;

  @ApiProperty({ example: '25.000', description: "With the currency's decimals at most; below 0, a correction that takes credit away" })
  @Matches(AMOUNT, { message: 'amount must be an amount such as 25.000, or -5.000 for a correction that takes credit away' })
  amount: string;

  @ApiPropertyOptional({ example: '250.000', description: "The amount typed again: needed above the large-credit threshold, either way (D12); when sent, it must be the amount" })
  @IsOptional()
  @Matches(AMOUNT, { message: 'confirmAmount must be the amount typed again, such as 250.000' })
  confirmAmount?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'For a correction that takes credit away: it may leave the balance below 0, a debt. Without it, it takes the credit left at most',
  })
  @IsOptional()
  @IsBoolean()
  allowDebt?: boolean;

  @ApiProperty({ format: 'uuid', description: 'Made once per grant by the client: a retry with the same key grants once' })
  @IsUUID('all', { message: 'idempotencyKey must be a UUID, made once per grant' })
  idempotencyKey: string;
}

/** A grant, as written in the ledger. */
export class AdminGrantView {
  @ApiProperty({ description: 'The ledger transaction' }) id: string;
  @ApiProperty({ enum: GRANT_KINDS }) kind: GrantKind;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '25.000', description: 'What it moved the balance by: below 0, credit taken away' }) amount: string;
  @ApiProperty({ example: '45.000', description: 'The balance once granted; for a replay, as it is now' }) balance: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ description: 'True when the key was granted before: nothing was written again, no e-mail went' }) replayed: boolean;
}

/** The answer to a grant: the grant, and the account page. */
export class AdminGrantResultView {
  @ApiProperty({ type: AdminGrantView }) grant: AdminGrantView;
  @ApiProperty({ type: AdminAccountView }) account: AdminAccountView;
}
