import { z } from 'zod';
import { Decimal } from './decimal';

/** A price or an amount: a decimal number written as a string, never a float (§4). */
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal number written as a string, such as "0.0000166667"');
const count = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a day, such as 2026-10-14');
/** S3 Standard's storage tiers, by the account's GB-months in the month: they go up, and the last has no end. */
const gbMonthTiers = z
  .array(z.strictObject({ upToGbMonths: z.number().int().positive().nullable(), price: decimal }))
  .min(1)
  .refine(
    (list) =>
      list.every((tier, index) =>
        index === list.length - 1 ? tier.upToGbMonths === null : tier.upToGbMonths !== null && (index === 0 || tier.upToGbMonths > (list[index - 1].upToGbMonths as number)),
      ),
    { message: 'must go up, tier by tier, and the last tier has no end (upToGbMonths null)' },
  );

/** SQS's requests, per million, in tiers by the account's requests in the month: they go up, and the last has no end. */
const requestTiers = z
  .array(z.strictObject({ upToRequests: z.number().int().positive().nullable(), price: decimal }))
  .min(1)
  .refine(
    (list) =>
      list.every((tier, index) =>
        index === list.length - 1 ? tier.upToRequests === null : tier.upToRequests !== null && (index === 0 || tier.upToRequests > (list[index - 1].upToRequests as number)),
      ),
    { message: 'must go up, tier by tier, and the last tier has no end (upToRequests null)' },
  );

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
    gbSecond: z
      .array(z.strictObject({ upToGbSeconds: z.number().int().positive().nullable(), price: decimal }))
      .min(1)
      .refine(
        (tiers) =>
          tiers.every((tier, index) =>
            index === tiers.length - 1 ? tier.upToGbSeconds === null : tier.upToGbSeconds !== null && (index === 0 || tier.upToGbSeconds > (tiers[index - 1].upToGbSeconds as number)),
          ),
        { message: 'must go up, tier by tier, and the last tier has no end (upToGbSeconds null)' },
      ),
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
    bucketStorageGbMonth: gbMonthTiers.optional(),
    /** S3's requests, per 1,000: its first class (PUT, COPY, POST, LIST) and its second (GET and the others). */
    requestsTier1PerThousand: decimal.optional(),
    requestsTier2PerThousand: decimal.optional(),
    /** SQS's standard queues' requests, per million, each 64 KB of a request's messages one, in tiers by the account's requests in the month. */
    queueRequestsPerMillion: requestTiers.optional(),
    /** A cache's memory, per GB-hour of it, as ElastiCache for Valkey's smallest node prices its memory by the hour. */
    cacheGbHour: decimal.optional(),
    /** SES's outbound mail, per 1,000 recipients of a message, and per GB of its attachments, each recipient's copy. */
    emailRecipientsPerThousand: decimal.optional(),
    emailAttachmentsGb: decimal.optional(),
  }),
});

export type PriceDocument = z.infer<typeof priceDocumentSchema>;

/** A book's prices, read once into exact decimals for rating. */
export interface BookPrices {
  id: string;
  validFrom: Date;
  freeRequests: Decimal;
  freeGbSeconds: Decimal;
  perRequest: Decimal;
  gbSecondTiers: Array<{ upTo: Decimal | null; price: Decimal }>;
  provisionedGbSecond: Decimal;
  provisionedDurationGbSecond: Decimal;
  minimumBilledMs: number;
  idleInstanceGbSecond: Decimal;
  monthlyPlanFee: Decimal;
  /** Customers' databases, buckets and queues (ADR 0008, ADR 0009, ADR 0010): 0, and no free tier, in a book without them. */
  databaseStorageGbMonth: Decimal;
  databaseMonthlyFee: Decimal;
  bucketStorageTiers: Array<{ upTo: Decimal | null; price: Decimal }>;
  perTier1Request: Decimal;
  perTier2Request: Decimal;
  freeDatabaseGbMonths: Decimal;
  freeBucketGbMonths: Decimal;
  freeTier1Requests: Decimal;
  freeTier2Requests: Decimal;
  /** SQS's requests, each tier's price per request. */
  queueRequestTiers: Array<{ upTo: Decimal | null; price: Decimal }>;
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
  const { freeTier, prices } = parsed.data;
  return {
    id: book.id,
    validFrom: book.validFrom,
    freeRequests: Decimal.of(freeTier.requests),
    freeGbSeconds: Decimal.of(freeTier.gbSeconds),
    perRequest: Decimal.parse(prices.requestsPerMillion).times(Decimal.ratio(1n, 1_000_000n)),
    gbSecondTiers: prices.gbSecond.map((tier) => ({ upTo: tier.upToGbSeconds === null ? null : Decimal.of(tier.upToGbSeconds), price: Decimal.parse(tier.price) })),
    provisionedGbSecond: Decimal.parse(prices.provisionedGbSecond),
    provisionedDurationGbSecond: Decimal.parse(prices.provisionedDurationGbSecond),
    minimumBilledMs: prices.minimumBilledMs,
    idleInstanceGbSecond: Decimal.parse(prices.idleInstanceGbSecond),
    monthlyPlanFee: Decimal.parse(prices.monthlyPlanFee),
    databaseStorageGbMonth: Decimal.parse(prices.databaseStorageGbMonth ?? '0'),
    databaseMonthlyFee: Decimal.parse(prices.databaseMonthlyFee ?? '0'),
    bucketStorageTiers: (prices.bucketStorageGbMonth ?? [{ upToGbMonths: null, price: '0' }]).map((tier) => ({
      upTo: tier.upToGbMonths === null ? null : Decimal.of(tier.upToGbMonths),
      price: Decimal.parse(tier.price),
    })),
    perTier1Request: Decimal.parse(prices.requestsTier1PerThousand ?? '0').times(PER_THOUSAND),
    perTier2Request: Decimal.parse(prices.requestsTier2PerThousand ?? '0').times(PER_THOUSAND),
    freeDatabaseGbMonths: Decimal.of(freeTier.databaseStorageGbMonths ?? 0),
    freeBucketGbMonths: Decimal.of(freeTier.bucketStorageGbMonths ?? 0),
    freeTier1Requests: Decimal.of(freeTier.requestsTier1 ?? 0),
    freeTier2Requests: Decimal.of(freeTier.requestsTier2 ?? 0),
    queueRequestTiers: (prices.queueRequestsPerMillion ?? [{ upToRequests: null, price: '0' }]).map((tier) => ({
      upTo: tier.upToRequests === null ? null : Decimal.of(tier.upToRequests),
      price: Decimal.parse(tier.price).times(PER_MILLION),
    })),
    freeQueueRequests: Decimal.of(freeTier.queueRequests ?? 0),
    cacheGbHour: Decimal.parse(prices.cacheGbHour ?? '0'),
    perEmailRecipient: Decimal.parse(prices.emailRecipientsPerThousand ?? '0').times(PER_THOUSAND),
    emailAttachmentsGb: Decimal.parse(prices.emailAttachmentsGb ?? '0'),
  };
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

/** AWS's US$ prices, as a book that says it comes from them records them (P-30, P-73): RDS's, S3's, SQS's, ElastiCache's and SES's too, in a book that prices databases, buckets, queues, caches and mail. */
const usdPricesSchema = z.strictObject({
  requestsPerMillion: decimal,
  gbSecond: z.array(z.strictObject({ upToGbSeconds: z.number().int().positive().nullable(), price: decimal })).min(1),
  provisionedGbSecond: decimal,
  provisionedDurationGbSecond: decimal,
  databaseStorageGbMonth: decimal.optional(),
  bucketStorageGbMonth: z.array(z.strictObject({ upToGbMonths: z.number().int().positive().nullable(), price: decimal })).min(1).optional(),
  requestsTier1PerThousand: decimal.optional(),
  requestsTier2PerThousand: decimal.optional(),
  queueRequestsPerMillion: z.array(z.strictObject({ upToRequests: z.number().int().positive().nullable(), price: decimal })).min(1).optional(),
  cacheGbHour: decimal.optional(),
  emailRecipientsPerThousand: decimal.optional(),
  emailAttachmentsGb: decimal.optional(),
});

/**
 * Why a book that says its prices are AWS's US$ prices times a rate
 * (source.kind "aws-lambda") isn't exactly that, SKU by SKU; none for a book
 * that says nothing of the kind. D8's knobs and the free tier are FF's own.
 */
export function awsPriceProblems(document: PriceDocument): string[] {
  if (document.source.kind !== 'aws-lambda') return [];
  const usd = usdPricesSchema.safeParse(document.source.usdPrices);
  if (!usd.success || document.source.usdRate === undefined) return ['source: an aws-lambda book records usdPrices and usdRate'];
  const rate = Decimal.parse(document.source.usdRate);
  const problems: string[] = [];
  const expect = (sku: string, price: string, usdPrice: string) => {
    const expected = Decimal.parse(usdPrice).times(rate);
    if (Decimal.parse(price).compare(expected) !== 0) problems.push(`prices.${sku}: must be ${usdPrice} × ${document.source.usdRate} = ${expected.toString()}`);
  };
  const { prices } = document;
  expect('requestsPerMillion', prices.requestsPerMillion, usd.data.requestsPerMillion);
  if (usd.data.gbSecond.length !== prices.gbSecond.length || usd.data.gbSecond.some((tier, index) => tier.upToGbSeconds !== prices.gbSecond[index].upToGbSeconds)) {
    problems.push('prices.gbSecond: must have the tiers of source.usdPrices.gbSecond');
  } else {
    usd.data.gbSecond.forEach((tier, index) => expect(`gbSecond.${index}.price`, prices.gbSecond[index].price, tier.price));
  }
  expect('provisionedGbSecond', prices.provisionedGbSecond, usd.data.provisionedGbSecond);
  expect('provisionedDurationGbSecond', prices.provisionedDurationGbSecond, usd.data.provisionedDurationGbSecond);
  // RDS's, S3's, ElastiCache's and SES's, when the book records AWS's: each its US$ price times the rate, and none without the other.
  for (const sku of ['databaseStorageGbMonth', 'requestsTier1PerThousand', 'requestsTier2PerThousand', 'cacheGbHour', 'emailRecipientsPerThousand', 'emailAttachmentsGb'] as const) {
    const price = prices[sku];
    const usdPrice = usd.data[sku];
    if (price !== undefined && usdPrice !== undefined) expect(sku, price, usdPrice);
    else if (price !== undefined || usdPrice !== undefined) problems.push(`prices.${sku}: must be in both prices and source.usdPrices, or in neither`);
  }
  const bucket = prices.bucketStorageGbMonth;
  const usdBucket = usd.data.bucketStorageGbMonth;
  if (bucket && usdBucket) {
    if (usdBucket.length !== bucket.length || usdBucket.some((tier, index) => tier.upToGbMonths !== bucket[index].upToGbMonths)) {
      problems.push('prices.bucketStorageGbMonth: must have the tiers of source.usdPrices.bucketStorageGbMonth');
    } else {
      usdBucket.forEach((tier, index) => expect(`bucketStorageGbMonth.${index}.price`, bucket[index].price, tier.price));
    }
  } else if (bucket || usdBucket) {
    problems.push('prices.bucketStorageGbMonth: must be in both prices and source.usdPrices, or in neither');
  }
  const queue = prices.queueRequestsPerMillion;
  const usdQueue = usd.data.queueRequestsPerMillion;
  if (queue && usdQueue) {
    if (usdQueue.length !== queue.length || usdQueue.some((tier, index) => tier.upToRequests !== queue[index].upToRequests)) {
      problems.push('prices.queueRequestsPerMillion: must have the tiers of source.usdPrices.queueRequestsPerMillion');
    } else {
      usdQueue.forEach((tier, index) => expect(`queueRequestsPerMillion.${index}.price`, queue[index].price, tier.price));
    }
  } else if (queue || usdQueue) {
    problems.push('prices.queueRequestsPerMillion: must be in both prices and source.usdPrices, or in neither');
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
 * Those of the book before that a new one lacks, by their paths: a book that
 * follows one with them must have them too, its free tier included, or
 * customers' databases, buckets, queues, caches and mail would be priced at nothing from it
 * on, which no operator means by leaving a field out.
 */
export function storageKeysMissing(before: PriceDocument, after: PriceDocument): string[] {
  return [
    ...STORAGE_PRICES.filter((key) => before.prices[key] !== undefined && after.prices[key] === undefined).map((key) => `prices.${key}`),
    ...STORAGE_FREE_TIER.filter((key) => before.freeTier[key] !== undefined && after.freeTier[key] === undefined).map((key) => `freeTier.${key}`),
  ];
}
