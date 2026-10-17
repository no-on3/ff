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

  @ApiProperty({
    nullable: true,
    type: String,
    example: '0.752',
    description: "Its estimated cost in the estimate's currency, before the free tier, rounded to the minor unit (P-30); null without a price book",
  })
  cost: string | null;
}

/** The month's estimated cost at FF's prices (P-30, D8). Each amount is rounded once, from the exact ones. */
export class UsageEstimateView {
  @ApiProperty({ example: 'TND' })
  currency: string;

  @ApiProperty({ example: '28.877', description: 'Every function together, before the free tier' })
  usage: string;

  @ApiProperty({
    example: '-20.655',
    description: 'What the free tier takes off: 1 million requests and 400,000 GB-s a month, of calls without minInstances (D8)',
  })
  freeTier: string;

  @ApiProperty({ example: '0.000', description: 'What the duration tiers past 6 billion GB-s a month take off' })
  volumeTiers: string;

  @ApiProperty({ example: '0.000', description: 'A monthly fee, if the price book has one (D8)' })
  monthlyFee: string;

  @ApiProperty({ example: '8.222', description: 'The exact sum, rounded once: the lines above may differ from it by a minor unit' })
  total: string;

  @ApiProperty({ description: "The first instant priced: the month's start, unless the first price book starts later" })
  pricedFrom: Date;

  @ApiProperty({ type: [String], description: 'The price books that priced the month, by ID, in time order' })
  priceBooks: string[];
}

export class MonthlyUsageView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({
    type: [FunctionUsageView],
    description: 'Each function with calls in the month, the most GB-seconds first, then any that cost something without a call',
  })
  functions: FunctionUsageView[];

  @ApiProperty({ type: UsageAmountsView, description: "The account's month, from the same records" })
  totals: UsageAmountsView;

  @ApiProperty({ type: () => UsageEstimateView, nullable: true, description: 'The estimated cost (P-30), or null without a price book for the month' })
  estimate: UsageEstimateView | null;
}

/** The month as UsageService reads it from the records, before it is priced. */
export type UsageMonth = Omit<MonthlyUsageView, 'functions' | 'estimate'> & { functions: Array<Omit<FunctionUsageView, 'cost'>> };
