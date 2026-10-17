import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** A month by the UTC calendar, as YYYY-MM. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** GET /usage's query. */
export class UsageQuery {
  @ApiPropertyOptional({ example: '2026-10', description: 'A month by the UTC calendar, as YYYY-MM; this month without it' })
  @IsOptional()
  @Matches(MONTH, { message: 'month must be a month as YYYY-MM, such as 2026-10' })
  month?: string;
}

/** What a function, or the whole account, used in the month, as D7 bills it. */
export class UsageAmountsView {
  @ApiProperty({ example: 1200, description: 'Requests billed: successes, errors and timeouts (D7)' })
  requests: number;

  @ApiProperty({ example: 25_150, description: 'Billed duration, in milliseconds' })
  billedMs: number;

  @ApiProperty({
    example: '3.14375',
    description: 'Billed duration × memory, in GB-seconds, counting 1,024 MB as 1 GB: an exact decimal, as a string',
  })
  gbSeconds: string;

  @ApiProperty({ example: 0, description: 'Calls throttled: no instance was free in time. Not billed' })
  throttled: number;

  @ApiProperty({ example: 0, description: 'Calls the platform failed, such as a cold start that failed. Not billed' })
  platformErrors: number;

  @ApiProperty({ example: 0, description: 'Calls lost when the backend stopped during them. Not billed' })
  lost: number;
}

export class FunctionUsageView extends UsageAmountsView {
  @ApiProperty({ example: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' })
  functionId: string;

  @ApiProperty({ example: 'hello', description: "The function's name in its latest call of the month" })
  functionName: string;

  @ApiProperty({ description: 'The function was deleted since: its usage stays' })
  deleted: boolean;
}

export class MonthlyUsageView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ type: [FunctionUsageView], description: 'Each function with calls in the month, the most GB-seconds first' })
  functions: FunctionUsageView[];

  @ApiProperty({ type: UsageAmountsView, description: "The account's month, from the same records" })
  totals: UsageAmountsView;
}
