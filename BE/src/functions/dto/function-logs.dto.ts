import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

/** The most lines one request gives. */
export const MAX_LOG_LINES = 1000;
/** The lines given when the request names no number, as `ff logs` asks (the CLI plan's C-05). */
export const DEFAULT_LOG_LINES = 200;
/** The longest window back, in seconds: 30 days, the longest plan's log retention. */
export const MAX_SINCE_SECONDS = 2_592_000;
/** The longest phrase searched for. */
export const MAX_LOG_SEARCH = 500;
/** RFC 3339: a date, a time, and its zone. */
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

/** GET /functions/:id/logs (P-40, P-43). */
export class FunctionLogsQuery {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LOG_LINES,
    default: DEFAULT_LOG_LINES,
    description: 'The most lines to give: the newest of the window, or of what comes before the cursor',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_LINES)
  limit?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LOG_LINES, description: "limit's older name, which `ff logs` sends (P-40); not with limit" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_LINES)
  tail?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_SINCE_SECONDS, description: 'The window starts this many seconds ago; not with start' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SINCE_SECONDS)
  sinceSeconds?: number;

  @ApiPropertyOptional({
    example: '2026-10-17T10:00:00Z',
    description: "The window's start, RFC 3339, included. The window never starts before the plan's log retention (14 days on beta)",
  })
  @IsOptional()
  @Matches(RFC3339, { message: 'start must be an RFC 3339 time, such as 2026-10-17T10:00:00Z' })
  start?: string;

  @ApiPropertyOptional({ example: '2026-10-17T11:00:00Z', description: "The window's end, RFC 3339, excluded; now by default" })
  @IsOptional()
  @Matches(RFC3339, { message: 'end must be an RFC 3339 time, such as 2026-10-17T11:00:00Z' })
  end?: string;

  @ApiPropertyOptional({
    maxLength: MAX_LOG_SEARCH,
    example: 'time out',
    description: 'Only the lines with this phrase, as whole words and with this case: "time out" finds "a time out here", not "timeout"',
  })
  @IsOptional()
  @IsString()
  @Length(1, MAX_LOG_SEARCH)
  @Matches(/\S/, { message: 'q must have a character other than a space' })
  q?: string;

  @ApiPropertyOptional({ format: 'uuid', description: "Only the lines of this call: an invocation's id, which is its request ID" })
  @IsOptional()
  @IsUUID()
  requestId?: string;

  @ApiPropertyOptional({ description: "The page before's next: this page has the lines older than it. The other parameters must stay the same" })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/, { message: 'cursor must be the next value of the page before' })
  cursor?: string;
}

/** One line of a function's log. */
export class FunctionLogLineView {
  @ApiProperty({ example: '2026-10-17T10:00:00.123456000Z', description: 'When it was written: RFC 3339, UTC, with nine decimals' }) time: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'fn-3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f-7d9f8b6c5-x2x9q',
    description: 'The instance that wrote it; null for the log store\'s notice of dropped lines',
  })
  instance: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f',
    description: "The call it belongs to, from its START line to its REPORT, as the invocation's requestId; null outside a call",
  })
  requestId: string | null;
  @ApiProperty({
    nullable: true,
    enum: ['stdout', 'stderr', 'ff'],
    example: 'stdout',
    description: 'Where it was written; ff for the line saying how many lines the account\'s limit dropped in a second',
  })
  stream: 'stdout' | 'stderr' | 'ff' | null;
  @ApiProperty({
    example: 'Hello from the handler',
    description: 'The line; one longer than 16,384 bytes is cut at the start of a character, and ends with " …[truncated]"',
  })
  message: string;
}

/** GET /functions/:id/logs: a page of lines, oldest first. */
export class FunctionLogsView {
  @ApiProperty({ type: [FunctionLogLineView], description: 'Oldest first' }) lines: FunctionLogLineView[];
  @ApiProperty({ nullable: true, type: String, description: "The cursor for the older lines: pass it as cursor, with the same parameters; null when there are none" })
  next: string | null;
}
