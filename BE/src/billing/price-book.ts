import { z } from 'zod';
import { Decimal } from './decimal';

/** A price or an amount: a decimal number written as a string, never a float (§4). */
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal number written as a string, such as "0.0000166667"');
const count = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a day, such as 2026-10-14');
/**
 * A price in tiers by the account's use in the month, each tier to where it ends (`end`, in the SKU's unit): they go
 * up, and the last has no end. Lambda's duration, S3 Standard's storage and SQS's requests are priced so, and of what
 * the estimate at AWS's prices adds, data out, Lambda's logs and CloudFront's data out.
 */
function tiers<End extends string>(end: End) {
  const tier = z.strictObject({ [end]: z.number().int().positive().nullable(), price: decimal } as Record<End, z.ZodNullable<z.ZodNumber>> & { price: typeof decimal });
  return z
    .array(tier)
    .min(1)
    .refine(
      (list) => {
        const ends = list.map((item) => (item as unknown as Record<End, number | null>)[end]);
        return ends.every((upTo, index) => {
          const before = index === 0 ? null : ends[index - 1];
          return index === ends.length - 1 ? upTo === null : upTo !== null && (before === null || upTo > before);
        });
      },
      { message: `must go up, tier by tier, and the last tier has no end (${end} null)` },
    );
}

/**
 * A price book's document (P-30, D8): AWS Lambda's SKUs, in the book's
 * currency, required; the duration tiers go up, and the last has no end. Three
 * prices are D8's knobs, at zero to price as AWS does. Customers' databases'
 * and buckets' SKUs (ADR 0008, ADR 0009), their queues' (ADR 0010), their
 * caches' (ADR 0013), their mail's (ADR 0012), and their free tier, came
 * later: optional, so that every book from before still reads, pricing them
 * at 0.
 */
export const priceDocumentSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a currency code, such as TND'),
  /** Where the prices come from: for AWS's, the list read, its US$ prices, and the rate used. */
  source: z.looseObject({
    kind: z.string().min(1),
    readOn: day.optional(),
    usdRate: decimal.optional(),
    usdRateDate: day.optional(),
  }),
  /** Per account and month: functions without provisioned concurrency (D8); databases' and buckets' GB-months, S3's requests, SQS's. */
  freeTier: z.strictObject({
    requests: count,
    gbSeconds: count,
    databaseStorageGbMonths: count.optional(),
    bucketStorageGbMonths: count.optional(),
    requestsTier1: count.optional(),
    requestsTier2: count.optional(),
    queueRequests: count.optional(),
  }),
  prices: z.strictObject({
    requestsPerMillion: decimal,
    /** On-demand duration, by the account's GB-seconds so far in the month. */
    gbSecond: tiers('upToGbSeconds'),
    /** Per GB-s of minInstances held, from the minute samples (P-21). */
    provisionedGbSecond: decimal,
    /** Per GB-s of calls that ran with minInstances above zero. */
    provisionedDurationGbSecond: decimal,
    /** D8's knob: no call is billed less than this, in ms. */
    minimumBilledMs: count,
    /** D8's knob: per GB-s of ready instances, above minInstances, that no call used. */
    idleInstanceGbSecond: decimal,
    /** D8's knob: each account, each month. */
    monthlyPlanFee: decimal,
    /** A database's storage per GB-month, as RDS for PostgreSQL's gp3 storage, Single-AZ. */
    databaseStorageGbMonth: decimal.optional(),
    /** Each database, each month, prorated by the hours it existed: 0 while its storage pays for it. */
    databaseMonthlyFee: decimal.optional(),
    /** Buckets' storage per GB-month, as S3 Standard's, in tiers by the account's GB-months in the month. */
    bucketStorageGbMonth: tiers('upToGbMonths').optional(),
    /** S3's requests, per 1,000: its first class (PUT, COPY, POST, LIST) and its second (GET and the others). */
    requestsTier1PerThousand: decimal.optional(),
    requestsTier2PerThousand: decimal.optional(),
    /** SQS's standard queues' requests, per million, each 64 KB of a request's messages one, in tiers by the account's requests in the month. */
    queueRequestsPerMillion: tiers('upToRequests').optional(),
    /** A cache's memory, per GB-hour of it, as ElastiCache for Valkey's smallest node prices its memory by the hour. */
    cacheGbHour: decimal.optional(),
    /** SES's outbound mail, per 1,000 recipients of a message, and per GB of its attachments, each recipient's copy. */
    emailRecipientsPerThousand: decimal.optional(),
    emailAttachmentsGb: decimal.optional(),
  }),
});

export type PriceDocument = z.infer<typeof priceDocumentSchema>;

/** A tier of a price, to where it ends in the SKU's unit (null: no end), at a price per unit. */
export interface PriceTier {
  upTo: Decimal | null;
  price: Decimal;
}

/** A book's prices, read once into exact decimals for rating. */
export interface BookPrices {
  id: string;
  validFrom: Date;
  freeRequests: Decimal;
  freeGbSeconds: Decimal;
  perRequest: Decimal;
  gbSecondTiers: PriceTier[];
  provisionedGbSecond: Decimal;
  provisionedDurationGbSecond: Decimal;
  minimumBilledMs: number;
  idleInstanceGbSecond: Decimal;
  monthlyPlanFee: Decimal;
  /** Customers' databases, buckets and queues (ADR 0008, ADR 0009, ADR 0010): 0, and no free tier, in a book without them. */
  databaseStorageGbMonth: Decimal;
  databaseMonthlyFee: Decimal;
  bucketStorageTiers: PriceTier[];
  perTier1Request: Decimal;
  perTier2Request: Decimal;
  freeDatabaseGbMonths: Decimal;
  freeBucketGbMonths: Decimal;
  freeTier1Requests: Decimal;
  freeTier2Requests: Decimal;
  /** SQS's requests, each tier's price per request. */
  queueRequestTiers: PriceTier[];
  freeQueueRequests: Decimal;
  /** A cache's memory, per GB-hour (ADR 0013): 0 in a book without it. */
  cacheGbHour: Decimal;
  /** Mail (ADR 0012), each recipient of a message, and each GB of its attachments sent: 0 in a book without them. */
  perEmailRecipient: Decimal;
  emailAttachmentsGb: Decimal;
}

/** A book as the rater uses it. A document that doesn't fit stops the rating, naming the book and the problems. */
export function bookPrices(book: { id: string; validFrom: Date; prices: unknown }): BookPrices {
  const parsed = priceDocumentSchema.safeParse(book.prices);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`The price book ${book.id} is invalid: ${problems}`);
  }
  return readPrices(book, parsed.data.prices, parsed.data.freeTier);
}

/**
 * A book's AWS prices as the rater takes them, for the estimate at AWS's prices: AWS's US$ prices with the free
 * tier AWS gives every account every month, and none of FF's knobs; null for a book that records no AWS prices with
 * that free tier. Caches are left at nothing: AWS bills a node for each, which the estimate adds, not their memory.
 */
export function awsBookPrices(book: { id: string; validFrom: Date; prices: unknown }): BookPrices | null {
  const parsed = priceDocumentSchema.safeParse(book.prices);
  const source = parsed.success ? awsSource(parsed.data) : null;
  if (!source?.awsFreeTier) return null;
  const { usdPrices: usd, awsFreeTier: free } = source;
  const prices: PriceDocument['prices'] = {
    requestsPerMillion: usd.requestsPerMillion,
    gbSecond: usd.gbSecond,
    provisionedGbSecond: usd.provisionedGbSecond,
    provisionedDurationGbSecond: usd.provisionedDurationGbSecond,
    minimumBilledMs: 0,
    idleInstanceGbSecond: '0',
    monthlyPlanFee: '0',
    databaseStorageGbMonth: usd.databaseStorageGbMonth,
    bucketStorageGbMonth: usd.bucketStorageGbMonth,
    requestsTier1PerThousand: usd.requestsTier1PerThousand,
    requestsTier2PerThousand: usd.requestsTier2PerThousand,
    queueRequestsPerMillion: usd.queueRequestsPerMillion,
    emailRecipientsPerThousand: usd.emailRecipientsPerThousand,
    emailAttachmentsGb: usd.emailAttachmentsGb,
  };
  return readPrices(book, prices, { requests: free.requests, gbSeconds: free.gbSeconds, queueRequests: free.queueRequests });
}

/** A book's SKUs and free tier in exact decimals: those it lacks at 0, with no free tier. */
function readPrices(book: { id: string; validFrom: Date }, prices: PriceDocument['prices'], freeTier: PriceDocument['freeTier']): BookPrices {
  return {
    id: book.id,
    validFrom: book.validFrom,
    freeRequests: Decimal.of(freeTier.requests),
    freeGbSeconds: Decimal.of(freeTier.gbSeconds),
    perRequest: Decimal.parse(prices.requestsPerMillion).times(PER_MILLION),
    gbSecondTiers: readTiers(prices.gbSecond.map((tier) => ({ upTo: tier.upToGbSeconds, price: tier.price }))),
    provisionedGbSecond: Decimal.parse(prices.provisionedGbSecond),
    provisionedDurationGbSecond: Decimal.parse(prices.provisionedDurationGbSecond),
    minimumBilledMs: prices.minimumBilledMs,
    idleInstanceGbSecond: Decimal.parse(prices.idleInstanceGbSecond),
    monthlyPlanFee: Decimal.parse(prices.monthlyPlanFee),
    databaseStorageGbMonth: Decimal.parse(prices.databaseStorageGbMonth ?? '0'),
    databaseMonthlyFee: Decimal.parse(prices.databaseMonthlyFee ?? '0'),
    bucketStorageTiers: readTiers((prices.bucketStorageGbMonth ?? [{ upToGbMonths: null, price: '0' }]).map((tier) => ({ upTo: tier.upToGbMonths, price: tier.price }))),
    perTier1Request: Decimal.parse(prices.requestsTier1PerThousand ?? '0').times(PER_THOUSAND),
    perTier2Request: Decimal.parse(prices.requestsTier2PerThousand ?? '0').times(PER_THOUSAND),
    freeDatabaseGbMonths: Decimal.of(freeTier.databaseStorageGbMonths ?? 0),
    freeBucketGbMonths: Decimal.of(freeTier.bucketStorageGbMonths ?? 0),
    freeTier1Requests: Decimal.of(freeTier.requestsTier1 ?? 0),
    freeTier2Requests: Decimal.of(freeTier.requestsTier2 ?? 0),
    queueRequestTiers: readTiers((prices.queueRequestsPerMillion ?? [{ upToRequests: null, price: '0' }]).map((tier) => ({ upTo: tier.upToRequests, price: tier.price })), PER_MILLION),
    freeQueueRequests: Decimal.of(freeTier.queueRequests ?? 0),
    cacheGbHour: Decimal.parse(prices.cacheGbHour ?? '0'),
    perEmailRecipient: Decimal.parse(prices.emailRecipientsPerThousand ?? '0').times(PER_THOUSAND),
    emailAttachmentsGb: Decimal.parse(prices.emailAttachmentsGb ?? '0'),
  };
}

/** A document's tiers in exact decimals, each price times `per` where the SKU is priced per thousand or per million of its unit. */
export function readTiers(tiers: Array<{ upTo: number | null; price: string }>, per?: Decimal): PriceTier[] {
  return tiers.map((tier) => ({ upTo: tier.upTo === null ? null : Decimal.of(tier.upTo), price: per ? Decimal.parse(tier.price).times(per) : Decimal.parse(tier.price) }));
}

const PER_THOUSAND = Decimal.ratio(1n, 1000n);
const PER_MILLION = Decimal.ratio(1n, 1_000_000n);

/** What a book without databases', buckets', queues', caches' and mail's SKUs prices them at: nothing, and no free tier. */
export const NO_RESOURCE_PRICES: Pick<
  BookPrices,
  | 'databaseStorageGbMonth'
  | 'databaseMonthlyFee'
  | 'bucketStorageTiers'
  | 'perTier1Request'
  | 'perTier2Request'
  | 'freeDatabaseGbMonths'
  | 'freeBucketGbMonths'
  | 'freeTier1Requests'
  | 'freeTier2Requests'
  | 'queueRequestTiers'
  | 'freeQueueRequests'
  | 'cacheGbHour'
  | 'perEmailRecipient'
  | 'emailAttachmentsGb'
> = {
  databaseStorageGbMonth: Decimal.ZERO,
  databaseMonthlyFee: Decimal.ZERO,
  bucketStorageTiers: [{ upTo: null, price: Decimal.ZERO }],
  perTier1Request: Decimal.ZERO,
  perTier2Request: Decimal.ZERO,
  freeDatabaseGbMonths: Decimal.ZERO,
  freeBucketGbMonths: Decimal.ZERO,
  freeTier1Requests: Decimal.ZERO,
  freeTier2Requests: Decimal.ZERO,
  queueRequestTiers: [{ upTo: null, price: Decimal.ZERO }],
  freeQueueRequests: Decimal.ZERO,
  cacheGbHour: Decimal.ZERO,
  perEmailRecipient: Decimal.ZERO,
  emailAttachmentsGb: Decimal.ZERO,
};

/**
 * AWS's US$ prices, as a book that says it comes from them records them (P-30, P-73): RDS's, S3's, SQS's,
 * ElastiCache's and SES's too, in a book that prices databases, buckets, queues, caches and mail; and what AWS bills
 * that FF doesn't, for the estimate at AWS's prices alone, as FF bills none of it. Lambda's start-up time is one
 * of those, billed as its duration is, at gbSecond's prices.
 */
const usdPricesSchema = z.strictObject({
  requestsPerMillion: decimal,
  gbSecond: tiers('upToGbSeconds'),
  provisionedGbSecond: decimal,
  provisionedDurationGbSecond: decimal,
  databaseStorageGbMonth: decimal.optional(),
  bucketStorageGbMonth: tiers('upToGbMonths').optional(),
  requestsTier1PerThousand: decimal.optional(),
  requestsTier2PerThousand: decimal.optional(),
  queueRequestsPerMillion: tiers('upToRequests').optional(),
  cacheGbHour: decimal.optional(),
  emailRecipientsPerThousand: decimal.optional(),
  emailAttachmentsGb: decimal.optional(),
  /** RDS for PostgreSQL's smallest instance, db.t4g.micro, in one zone, an hour or part of one: one for each database. */
  databaseInstanceHour: decimal.optional(),
  /** ElastiCache for Valkey's smallest node, cache.t4g.micro, an hour or part of one: one for each cache. */
  cacheNodeHour: decimal.optional(),
  /** Data sent out to the internet, per GB, in tiers by the account's GB in the month. */
  dataOutGb: tiers('upToGb').optional(),
  /** Lambda's logs into CloudWatch Logs, as vended logs, per GB, in tiers by the account's GB in the month; and kept, per GB-month. */
  logsIngestedGb: tiers('upToGb').optional(),
  logsStorageGbMonth: decimal.optional(),
  /** CloudFront in front of a site, its viewers in Europe: data out per GB, in tiers by the month's; HTTPS requests per 10,000; the function each request runs, per million. */
  cloudFrontDataOutGb: tiers('upToGb').optional(),
  cloudFrontRequestsPerTenThousand: decimal.optional(),
  cloudFrontFunctionsPerMillion: decimal.optional(),
  /** A NAT gateway, for functions in a VPC that reach the internet: an hour, each GB through it, and its public IPv4 address, an hour. */
  natGatewayHour: decimal.optional(),
  natGatewayGb: decimal.optional(),
  publicIpv4Hour: decimal.optional(),
});

/** What AWS bills that FF doesn't, which a book of AWS's prices records all of, or none of. */
const ESTIMATE_PRICES = [
  'databaseInstanceHour',
  'cacheNodeHour',
  'dataOutGb',
  'logsIngestedGb',
  'logsStorageGbMonth',
  'cloudFrontDataOutGb',
  'cloudFrontRequestsPerTenThousand',
  'cloudFrontFunctionsPerMillion',
  'natGatewayHour',
  'natGatewayGb',
  'publicIpv4Hour',
] as const;

/**
 * The source of a book of AWS's prices: its US$ prices and the rate used, and, beside the estimate's prices, the free
 * tier AWS gives every account every month and the price lists they were read from, each with the day it was read.
 */
const awsSourceSchema = z.looseObject({
  usdPrices: usdPricesSchema,
  usdRate: decimal,
  /** Lambda's requests and GB-seconds, SQS's requests, data out, and CloudFront's data out, requests and functions. */
  awsFreeTier: z
    .strictObject({ requests: count, gbSeconds: count, queueRequests: count, dataOutGb: count, cloudFrontDataOutGb: count, cloudFrontRequests: count, cloudFrontFunctions: count })
    .optional(),
  estimatePriceLists: z
    .array(z.strictObject({ priceList: z.url(), priceListPublished: z.iso.datetime(), readOn: day, usageTypes: z.array(z.string().min(1)).min(1) }))
    .min(1)
    .optional(),
});

export type AwsSource = z.infer<typeof awsSourceSchema>;

/** A book's AWS prices, as its source records them: null for a book that doesn't say it is AWS's, or whose AWS prices don't fit. */
export function awsSource(document: PriceDocument): AwsSource | null {
  if (document.source.kind !== 'aws-lambda') return null;
  const parsed = awsSourceSchema.safeParse(document.source);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a book that says its prices are AWS's US$ prices times a rate
 * (source.kind "aws-lambda") isn't exactly that, SKU by SKU; none for a book
 * that says nothing of the kind. D8's knobs and the free tier are FF's own.
 * What AWS bills that FF doesn't has no price of FF's: a book has all of it or
 * none, and with it AWS's free tier and the price lists it was read from.
 */
export function awsPriceProblems(document: PriceDocument): string[] {
  if (document.source.kind !== 'aws-lambda') return [];
  if (document.source.usdPrices === undefined || document.source.usdRate === undefined) return ['source: an aws-lambda book records usdPrices and usdRate'];
  const parsed = awsSourceSchema.safeParse(document.source);
  if (!parsed.success) return parsed.error.issues.map((issue) => `source.${issue.path.join('.')}: ${issue.message}`);
  const { usdPrices: usd, awsFreeTier, estimatePriceLists } = parsed.data;
  const rate = Decimal.parse(parsed.data.usdRate);
  const problems: string[] = [];
  const expect = (sku: string, price: string, usdPrice: string) => {
    const expected = Decimal.parse(usdPrice).times(rate);
    if (Decimal.parse(price).compare(expected) !== 0) problems.push(`prices.${sku}: must be ${usdPrice} × ${parsed.data.usdRate} = ${expected.toString()}`);
  };
  /** Tiers priced at AWS's: the same tiers, each at its US$ price times the rate; or neither, for an optional SKU. */
  const expectTiers = <T extends { price: string }>(sku: string, given: T[] | undefined, usdTiers: T[] | undefined, end: (tier: T) => number | null) => {
    if (given && usdTiers) {
      if (usdTiers.length !== given.length || usdTiers.some((tier, index) => end(tier) !== end(given[index]))) problems.push(`prices.${sku}: must have the tiers of source.usdPrices.${sku}`);
      else usdTiers.forEach((tier, index) => expect(`${sku}.${index}.price`, given[index].price, tier.price));
    } else if (given || usdTiers) {
      problems.push(`prices.${sku}: must be in both prices and source.usdPrices, or in neither`);
    }
  };
  const { prices } = document;
  expect('requestsPerMillion', prices.requestsPerMillion, usd.requestsPerMillion);
  expectTiers('gbSecond', prices.gbSecond, usd.gbSecond, (tier) => tier.upToGbSeconds);
  expect('provisionedGbSecond', prices.provisionedGbSecond, usd.provisionedGbSecond);
  expect('provisionedDurationGbSecond', prices.provisionedDurationGbSecond, usd.provisionedDurationGbSecond);
  // RDS's, S3's, SQS's, ElastiCache's and SES's, when the book records AWS's: each its US$ price times the rate, and none without the other.
  for (const sku of ['databaseStorageGbMonth', 'requestsTier1PerThousand', 'requestsTier2PerThousand', 'cacheGbHour', 'emailRecipientsPerThousand', 'emailAttachmentsGb'] as const) {
    const price = prices[sku];
    const usdPrice = usd[sku];
    if (price !== undefined && usdPrice !== undefined) expect(sku, price, usdPrice);
    else if (price !== undefined || usdPrice !== undefined) problems.push(`prices.${sku}: must be in both prices and source.usdPrices, or in neither`);
  }
  expectTiers('bucketStorageGbMonth', prices.bucketStorageGbMonth, usd.bucketStorageGbMonth, (tier) => tier.upToGbMonths);
  expectTiers('queueRequestsPerMillion', prices.queueRequestsPerMillion, usd.queueRequestsPerMillion, (tier) => tier.upToRequests);
  // What AWS bills that FF doesn't, for the estimate: all of it or none, read from price lists, with AWS's free tier.
  if (ESTIMATE_PRICES.some((sku) => usd[sku] !== undefined)) {
    for (const sku of ESTIMATE_PRICES.filter((key) => usd[key] === undefined)) problems.push(`source.usdPrices.${sku}: what AWS bills that FF doesn't is all in a book, or none of it`);
    if (!awsFreeTier) problems.push("source.awsFreeTier: a book with what AWS bills that FF doesn't records the free tier AWS gives every month");
    if (!estimatePriceLists) problems.push("source.estimatePriceLists: a book with what AWS bills that FF doesn't records the price lists it was read from");
  }
  return problems;
}

/** A book's problems, each "path: why": the schema's, then AWS's prices. Empty when it fits. */
export function priceDocumentProblems(value: unknown): string[] {
  const parsed = priceDocumentSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`);
  return awsPriceProblems(parsed.data);
}

/** Customers' databases', buckets', queues', caches' and mail's SKUs and free tiers, which a book may lack, pricing them at nothing. */
const STORAGE_PRICES = [
  'databaseStorageGbMonth',
  'databaseMonthlyFee',
  'bucketStorageGbMonth',
  'requestsTier1PerThousand',
  'requestsTier2PerThousand',
  'queueRequestsPerMillion',
  'cacheGbHour',
  'emailRecipientsPerThousand',
  'emailAttachmentsGb',
] as const;
const STORAGE_FREE_TIER = ['databaseStorageGbMonths', 'bucketStorageGbMonths', 'requestsTier1', 'requestsTier2', 'queueRequests'] as const;

/**
 * Those of the book before that a new one leaves out, by their paths: a book
 * that follows one with them must have them too, its free tier included, or
 * customers' databases, buckets, queues, caches and mail would be priced at
 * nothing from it on, and the estimate at AWS's prices would lose what AWS
 * bills that FF doesn't, which no operator means by leaving a field out. A
 * book of the operator's own prices records no AWS prices to keep.
 */
export function keysLeftOut(before: PriceDocument, after: PriceDocument): string[] {
  const usd = (document: PriceDocument): Record<string, unknown> => {
    const prices = document.source.usdPrices;
    return typeof prices === 'object' && prices !== null ? (prices as Record<string, unknown>) : {};
  };
  return [
    ...STORAGE_PRICES.filter((key) => before.prices[key] !== undefined && after.prices[key] === undefined).map((key) => `prices.${key}`),
    ...STORAGE_FREE_TIER.filter((key) => before.freeTier[key] !== undefined && after.freeTier[key] === undefined).map((key) => `freeTier.${key}`),
    ...(after.source.kind === 'aws-lambda' ? ESTIMATE_PRICES.filter((key) => usd(before)[key] !== undefined && usd(after)[key] === undefined).map((key) => `source.usdPrices.${key}`) : []),
  ];
}
