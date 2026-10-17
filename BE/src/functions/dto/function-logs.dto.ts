import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The most lines one request gives, as the logs API will (P-43). */
export const MAX_LOG_LINES = 1000;
/** The lines given when the request names no number, as `ff logs` asks (the CLI plan's C-05). */
export const DEFAULT_LOG_LINES = 200;
/** The longest window back, in seconds: 30 days, the default history retention. */
export const MAX_SINCE_SECONDS = 2_592_000;

/** GET /functions/:id/logs (P-40). */
export class FunctionLogsQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LOG_LINES, default: DEFAULT_LOG_LINES, description: 'The newest lines to give, across the instances' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_LINES)
  tail?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_SINCE_SECONDS, description: 'Only the lines written in the last this many seconds' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SINCE_SECONDS)
  sinceSeconds?: number;
}

/** One line of a function's log. */
export class FunctionLogLineView {
  @ApiProperty({ example: '2026-10-17T10:00:00.123456789Z', description: 'When it was written: RFC 3339, UTC, with nine decimals' }) time: string;
  @ApiProperty({ example: 'fn-3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f-7d9f8b6c5-x2x9q', description: 'The instance that wrote it' }) instance: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f',
    description: "The call it belongs to, from its START line to its REPORT, as the invocation's requestId; null outside a call",
  })
  requestId: string | null;
  @ApiProperty({ example: 'Hello from the handler', description: `The line; one longer than 16,384 characters is cut, and ends with "…[truncated]"` }) message: string;
}

/** GET /functions/:id/logs: the lines, oldest first. */
export class FunctionLogsView {
  @ApiProperty({ type: [FunctionLogLineView], description: 'Oldest first' }) lines: FunctionLogLineView[];
  @ApiProperty({ nullable: true, type: String, description: 'For the next page, once the log store keeps the lines (P-43); null while they come from the running instances' })
  next: string | null;
}
