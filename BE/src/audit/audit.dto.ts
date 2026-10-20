import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumberString, IsOptional, Max, Min } from 'class-validator';

export const MAX_AUDIT_PAGE = 100;

/** GET /audit-log's query. */
export class AuditQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_AUDIT_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: entries older than it" })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  before?: string;
}

export class AuditEntryView {
  @ApiProperty({ example: '42' }) id: string;
  @ApiProperty() at: Date;
  @ApiProperty({ example: 'user:3f9c2a1e-…', description: 'user:<id>, key:<id>, dev, system, or operator: FF acting on the account' }) actor: string;
  @ApiProperty({ example: 'amira@ff.test', description: "The user's e-mail, or the key's name, at the time; FF for an operator" }) actorLabel: string;
  @ApiProperty({ example: 'function.create' }) action: string;
  @ApiProperty({ nullable: true, type: String, example: 'function:3f9c2a1e-…' }) resource: string | null;
  @ApiProperty({ nullable: true, type: String }) ip: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) details: Record<string, unknown> | null;
}

export class AuditPageView {
  @ApiProperty({ type: [AuditEntryView] }) entries: AuditEntryView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last one' })
  next: string | null;
}
