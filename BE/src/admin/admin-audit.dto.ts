import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNumberString, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const MAX_ADMIN_AUDIT_PAGE = 100;
/** How many entries a CSV export holds at most: the newest. */
export const ADMIN_AUDIT_EXPORT_CAP = 10_000;

/** GET /admin/audit-log's query (P-76): filters, and a page. */
export class AdminAuditQuery {
  @ApiPropertyOptional({ description: "Part of the operator's e-mail, in any case", example: 'operator@' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  operator?: string;

  @ApiPropertyOptional({ description: 'The account the action was on', example: '000000000001' })
  @IsOptional()
  @Matches(/^\d{12}$/, { message: 'accountId must be an account ID: 12 digits' })
  accountId?: string;

  @ApiPropertyOptional({ example: 'settings.update' })
  @IsOptional()
  @Matches(/^[a-z_]+\.[a-z_]+$/, { message: 'action must be an action, such as settings.update' })
  action?: string;

  @ApiPropertyOptional({ description: 'From this instant, included (ISO 8601)', example: '2026-10-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'Until this instant, excluded (ISO 8601)', example: '2026-11-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_ADMIN_AUDIT_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ADMIN_AUDIT_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: entries older than it" })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  before?: string;
}

export class OperatorView {
  @ApiProperty({ description: "Keycloak's user ID" }) id: string;
  @ApiProperty({ example: 'operator@ff.test', description: 'Their e-mail when they acted' }) email: string;
}

/** One operator action. */
export class OperatorActionView {
  @ApiProperty({ example: '42' }) id: string;
  @ApiProperty() at: Date;
  @ApiProperty({ type: OperatorView }) operator: OperatorView;
  @ApiProperty({ example: 'settings.update' }) action: string;
  @ApiProperty({ nullable: true, type: String, description: 'The account it was on; null for the platform' }) accountId: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'settings' }) resource: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Why, as the operator gave it' }) reason: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) details: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) ip: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId: string | null;
}

export class OperatorActionPageView {
  @ApiProperty({ type: [OperatorActionView] }) entries: OperatorActionView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last one' })
  next: string | null;
}
