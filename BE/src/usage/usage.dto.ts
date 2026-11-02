import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { COUNTED_LINES, EXTRA_LINES, EstimateLine } from '../billing/aws-estimate';

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

export class QueueUsageView {
  @ApiProperty({ example: '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b' })
  queueId: string;

  @ApiProperty({ example: 'orders', description: 'Its name in the month' })
  name: string;

  @ApiProperty({ description: 'The queue was deleted since: its usage stays' })
  deleted: boolean;

  @ApiProperty({
    example: 18_420,
    description:
      "Its requests as SQS bills them: each 64 KB of a request's messages a request, through the SQS endpoint or FF's API; each batch a function read counts as the request that would have received it, the reads that find nothing and the deletes after a call as none",
  })
  requests: number;

  @ApiProperty({ example: 6_140, description: "The messages kept in it, as CloudWatch's NumberOfMessagesSent counts them" })
  messagesSent: number;

  @ApiProperty({ example: 6_152, description: "The messages received from it, by a consumer or a function's batch (NumberOfMessagesReceived): a message received twice counts twice" })
  messagesReceived: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '0.000',
    description: "Its estimated cost in the estimate's currency, before the free tier, rounded to the minor unit; null without a price book",
  })
  cost: string | null;
}

export class EmailUsageView {
  @ApiProperty({ example: '5d41402a-bc4b-2a76-b971-9d911017c592', description: "Its line in the bill: made of the account and the domain or address" })
  resourceId: string;

  @ApiProperty({ example: 'shop.example.tn', description: 'The domain or address the mail went from' })
  identity: string;

  @ApiProperty({ description: 'The domain or address was deleted since: its usage stays' })
  deleted: boolean;

  @ApiProperty({ example: 1250, description: "Its messages' recipients, each one, a suppressed one too, as SES bills them" })
  recipients: number;

  @ApiProperty({ example: 52_428_800, description: "What its messages' attachments weighed as sent, each recipient's copy, in bytes: SES bills them by the GB" })
  attachmentBytes: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '0.376',
    description: "Its estimated cost in the estimate's currency, rounded to the minor unit; null without a price book",
  })
  cost: string | null;
}

export class CacheUsageView {
  @ApiProperty({ example: '9b2e4c1a-7d3f-4a6b-8c5e-0f1a2b3c4d5e' })
  cacheId: string;

  @ApiProperty({ example: 'sessions', description: 'Its name in the month' })
  name: string;

  @ApiProperty({ description: 'The cache was deleted since: its usage stays' })
  deleted: boolean;

  @ApiProperty({ example: 312, description: 'The hours it was measured in, each billed as ElastiCache bills a node-hour' })
  hours: number;

  @ApiProperty({ example: 64, description: 'Its memory at its latest measure, in MB: the plan\'s when it was made' })
  memoryMb: number;

  @ApiProperty({ example: '19.5', description: 'Its memory times its hours, in GB-hours, as it is billed, whatever its keys used' })
  gbHours: string;

  @ApiProperty({ example: '0.026210', description: 'The same in GB-months, over the month\'s hours, as the CSV gives storage' })
  gbMonths: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.502',
    description: "Its estimated cost in the estimate's currency, rounded to the minor unit; null without a price book",
  })
  cost: string | null;
}

/** The month's estimated cost at FF's prices (P-30, D8). Each amount is rounded once, from the exact ones. */
export class UsageEstimateView {
  @ApiProperty({ example: 'TND' })
  currency: string;

  @ApiProperty({ example: '28.877', description: 'Every function, database, bucket, queue and cache together, before the free tier' })
  usage: string;

  @ApiProperty({
    example: '-20.655',
    description:
      "What the free tier takes off: 1 million requests and 400,000 GB-s a month, of calls without minInstances (D8); and, in the books that price them, 1 GB-month of databases, 5 GB-months of buckets with 2,000 PUT and 20,000 GET requests, and 1 million requests to queues",
  })
  freeTier: string;

  @ApiProperty({ example: '0.000', description: "What the duration tiers past 6 billion GB-s a month take off, and those of buckets' storage past 50 TB and of queues' requests past 100 billion" })
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

  @ApiProperty({ type: [QueueUsageView], description: "Each of the account's queues asked anything in the month (ADR 0010), the most requests first" })
  queues: QueueUsageView[];

  @ApiProperty({ type: [CacheUsageView], description: "Each of the account's caches measured in the month (ADR 0013), the most GB-hours first" })
  caches: CacheUsageView[];

  @ApiProperty({ type: [EmailUsageView], description: "Each domain or address the account's mail went from in the month (ADR 0012), the most recipients first" })
  email: EmailUsageView[];

  @ApiProperty({ type: UsageAmountsView, description: "The account's calls in the month, from the same records as its functions'" })
  totals: UsageAmountsView;

  @ApiProperty({ type: () => UsageEstimateView, nullable: true, description: 'The estimated cost (P-30), or null without a price book for the month' })
  estimate: UsageEstimateView | null;
}

/** The month as UsageService reads it from the records, before it is priced. */
export type UsageMonth = Omit<MonthlyUsageView, 'functions' | 'databases' | 'buckets' | 'queues' | 'caches' | 'email' | 'estimate'> & { functions: Array<Omit<FunctionUsageView, 'cost'>> };

/** A database's month as UsageService reads it from its samples, before it is priced. */
export type DatabaseMonth = Omit<DatabaseUsageView, 'cost'>;

/** A bucket's month as UsageService reads it from its samples and its request counts, before it is priced. */
export type BucketMonth = Omit<BucketUsageView, 'cost'>;

/** A queue's month as UsageService reads it from its request counts, before it is priced. */
export type QueueMonth = Omit<QueueUsageView, 'cost'>;

/** A cache's month as UsageService reads it from its samples, before it is priced. */
export type CacheMonth = Omit<CacheUsageView, 'cost'>;

/** A domain's or an address's mail in a month as UsageService reads it from its billing records, before it is priced. */
export type EmailMonth = Omit<EmailUsageView, 'cost'>;

/** The most months GET /usage/aws-estimate takes. */
export const MAX_ESTIMATE_MONTHS = 12;

/** GET /usage/aws-estimate's query. */
export class AwsEstimateQuery {
  @ApiPropertyOptional({ example: 3, minimum: 1, maximum: MAX_ESTIMATE_MONTHS, description: 'How many months: this one so far, and those before it; 3 without it' })
  @IsOptional()
  @Type(() => Number)
  @IsIn(
    Array.from({ length: MAX_ESTIMATE_MONTHS }, (_unused, index) => index + 1),
    { message: `months must be a whole number from 1 to ${MAX_ESTIMATE_MONTHS}` },
  )
  months?: number;

  @ApiPropertyOptional({
    type: String,
    example: 'natGateway,logs',
    description: `What AWS bills that FF doesn't, left out of the totals, comma-separated: ${EXTRA_LINES.join(', ')}`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((line) => line.trim()).filter(Boolean) : value))
  @IsIn([...EXTRA_LINES], { each: true, message: `without names lines of ${EXTRA_LINES.join(', ')}, comma-separated` })
  without?: string[];
}

/** A line of the estimate at AWS's prices: what FF counts, or what AWS bills that FF doesn't. */
export class AwsEstimateLineView {
  @ApiProperty({ enum: [...COUNTED_LINES, ...EXTRA_LINES], example: 'functions' })
  line: EstimateLine;

  @ApiProperty({ example: 'AWS Lambda: requests and duration', description: 'What it is, as AWS bills it' })
  label: string;

  @ApiProperty({ example: '2.73', description: 'In US$, rounded to the cent' })
  usd: string;

  @ApiProperty({ example: '8.222', description: "In the price book's currency, at its US$ rate, rounded to its minor unit" })
  amount: string;

  @ApiProperty({ description: "Of what AWS bills that FF doesn't: an estimate of its own, which the query's without leaves out" })
  extra: boolean;

  @ApiProperty({ description: "Left out of the month's totals, as the query's without asked" })
  leftOut: boolean;

  @ApiProperty({ nullable: true, type: String, description: "What a line of what AWS bills that FF doesn't assumes; null for FF's own counts" })
  assumption: string | null;
}

/** A month at AWS's prices, from what FF counted. */
export class AwsEstimateMonthView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ nullable: true, type: Date, description: 'This month: up to now; null for a month that is over' })
  until: Date | null;

  @ApiProperty({ example: 3_000_000, description: 'The calls billed, as AWS Lambda bills them' })
  requests: number;

  @ApiProperty({ type: [AwsEstimateLineView], description: "FF's counts at AWS's prices, then what AWS bills that FF doesn't" })
  lines: AwsEstimateLineView[];

  @ApiProperty({ example: '13.97', description: 'Every line not left out, in US$: the exact sum, rounded once' })
  totalUsd: string;

  @ApiProperty({ example: '42.022', description: "The same in the price book's currency, at its US$ rate" })
  total: string;

  @ApiProperty({ nullable: true, type: String, example: '8.222', description: "The same month at FF's prices, as GET /usage estimates it; null without a price book for the month" })
  ffTotal: string | null;
}

/** GET /usage/aws-estimate: the last months at AWS's prices, an estimate, with the prices' dates. */
export class AwsEstimateView {
  @ApiProperty({ example: 'TND', description: 'The currency of each amount but the US$ ones' })
  currency: string;

  @ApiProperty({ example: '3.0080', description: "The price book's US$ rate: the currency's units per US$" })
  usdRate: string;

  @ApiProperty({ nullable: true, type: String, example: '2026-10-14', description: 'The day of that rate' })
  usdRateDate: string | null;

  @ApiProperty({ example: 'us-east-1', description: "AWS's region whose prices these are" })
  region: string;

  @ApiProperty({ type: [String], example: ['2026-10-17', '2026-10-31'], description: "The first and the last day FF read AWS's prices on" })
  pricesReadOn: string[];

  @ApiProperty({ description: "The price book whose AWS prices these are: the newest that records what AWS bills that FF doesn't" })
  priceBook: string;

  @ApiProperty({ type: [AwsEstimateMonthView], description: 'Oldest first; this month, so far, last' })
  months: AwsEstimateMonthView[];
}
