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

/** A customer's database in the month (ADR 0008), as its hourly samples measured it. */
export class DatabaseUsageView {
  @ApiProperty({ example: '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f' })
  databaseId: string;

  @ApiProperty({ example: 'orders', description: 'Its name at its latest sample of the month' })
  name: string;

  @ApiProperty({ description: 'The database was deleted since: its usage stays' })
  deleted: boolean;

  @ApiProperty({ example: 312, description: 'The hours it was measured in: its size each hour counts for the whole hour' })
  hours: number;

  @ApiProperty({
    example: '0.003182',
    description: "Its storage in GB-months, as AWS RDS bills it: its size each hour, over the month's hours, 1 GB being 2^30 bytes; to six decimals, as a string",
  })
  gbMonths: string;

  @ApiProperty({ example: 7_634_423, description: 'Its size at its latest sample of the month, in bytes' })
  sizeBytes: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '0.001',
    description: "Its estimated cost in the estimate's currency, before the free tier, rounded to the minor unit; null without a price book",
  })
  cost: string | null;
}

export class BucketUsageView {
  @ApiProperty({ example: '0b6f3a1c-2d4e-4f5a-8b9c-1d2e3f4a5b6c' })
  bucketId: string;

  @ApiProperty({ example: 'photos', description: 'Its name in the month' })
  name: string;

  @ApiProperty({ description: 'The bucket was deleted since: its usage stays' })
  deleted: boolean;

  @ApiProperty({ example: 312, description: 'The hours it was measured in: what it held each hour counts for the whole hour' })
  hours: number;

  @ApiProperty({
    example: '0.215231',
    description: "Its storage in GB-months, as AWS S3 bills it: what it held each hour, over the month's hours, 1 GB being 2^30 bytes; to six decimals, as a string",
  })
  gbMonths: string;

  @ApiProperty({ example: 161_480_253, description: 'What it held at its latest measure of the month, in bytes' })
  sizeBytes: number;

  @ApiProperty({ example: 1_204, description: 'Its objects then' })
  objects: number;

  @ApiProperty({ example: 2_310, description: "Its requests of S3's first class: PUT, COPY, POST and LIST" })
  tier1Requests: number;

  @ApiProperty({ example: 48_920, description: "Its requests of S3's second class: GET, HEAD and the others; deletes are free, as on S3" })
  tier2Requests: number;

  @ApiProperty({
    example: 2_831_155_200,
    description: "The bytes its requests sent out, as the front door counted them (CloudWatch's BytesDownloaded): counted, not billed",
  })
  bytesDownloaded: number;

  @ApiProperty({ example: 734_003_200, description: "The bytes its requests brought in (CloudWatch's BytesUploaded): free, as on S3" })
  bytesUploaded: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '0.024',
    description: "Its estimated cost in the estimate's currency, before the free tier, rounded to the minor unit; null without a price book",
  })
  cost: string | null;
}

/** The month's estimated cost at FF's prices (P-30, D8). Each amount is rounded once, from the exact ones. */
export class UsageEstimateView {
  @ApiProperty({ example: 'TND' })
  currency: string;

  @ApiProperty({ example: '28.877', description: 'Every function and database together, before the free tier' })
  usage: string;

  @ApiProperty({
    example: '-20.655',
    description: 'What the free tier takes off: 1 million requests and 400,000 GB-s a month, of calls without minInstances (D8); and, in the books that price databases, 1 GB-month of them',
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

  @ApiProperty({ type: [DatabaseUsageView], description: "Each of the account's databases measured in the month (ADR 0008), the most GB-months first" })
  databases: DatabaseUsageView[];

  @ApiProperty({ type: [BucketUsageView], description: "Each of the account's buckets measured or asked anything in the month (ADR 0009), the most GB-months first" })
  buckets: BucketUsageView[];

  @ApiProperty({ type: UsageAmountsView, description: "The account's calls in the month, from the same records as its functions'" })
  totals: UsageAmountsView;

  @ApiProperty({ type: () => UsageEstimateView, nullable: true, description: 'The estimated cost (P-30), or null without a price book for the month' })
  estimate: UsageEstimateView | null;
}

/** The month as UsageService reads it from the records, before it is priced. */
export type UsageMonth = Omit<MonthlyUsageView, 'functions' | 'databases' | 'buckets' | 'estimate'> & { functions: Array<Omit<FunctionUsageView, 'cost'>> };

/** A database's month as UsageService reads it from its samples, before it is priced. */
export type DatabaseMonth = Omit<DatabaseUsageView, 'cost'>;

/** A bucket's month as UsageService reads it from its samples and its request counts, before it is priced. */
export type BucketMonth = Omit<BucketUsageView, 'cost'>;
