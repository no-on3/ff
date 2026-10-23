/**
 * Price books, as the admin routes give them (P-73, D8): AWS Lambda's SKUs in
 * TND, and those of customers' databases and buckets, as AWS RDS and S3 price
 * them, in the books that have them. contract.test.ts checks the SKUs against
 * the backend's priceDocumentSchema.
 */
export type BookStatus = 'past' | 'active' | 'scheduled';

export interface PriceTier {
  upToGbSeconds: number | null;
  price: string;
}

/** S3 Standard's storage tiers, by the account's GB-months in the month. */
export interface StorageTier {
  upToGbMonths: number | null;
  price: string;
}

/** The SKUs of customers' databases and buckets: RDS's gp3 storage, S3 Standard's storage and its two classes of request. */
export interface StoragePrices {
  databaseStorageGbMonth?: string;
  bucketStorageGbMonth?: StorageTier[];
  requestsTier1PerThousand?: string;
  requestsTier2PerThousand?: string;
}

/** AWS's US$ prices, as a book from them records them. */
export interface UsdPrices extends StoragePrices {
  requestsPerMillion: string;
  gbSecond: PriceTier[];
  provisionedGbSecond: string;
  provisionedDurationGbSecond: string;
}

export interface PriceDocument {
  currency: string;
  source: { kind: string; readOn?: string; usdRate?: string; usdRateDate?: string; usdPrices?: UsdPrices; [more: string]: unknown };
  freeTier: { requests: number; gbSeconds: number; databaseStorageGbMonths?: number; bucketStorageGbMonths?: number; requestsTier1?: number; requestsTier2?: number };
  prices: UsdPrices & { minimumBilledMs: number; idleInstanceGbSecond: string; monthlyPlanFee: string; databaseMonthlyFee?: string };
}

export interface PriceBook {
  id: string;
  currency: string;
  validFrom: string;
  status: BookStatus;
  createdBy: string;
  createdAt: string;
  document: PriceDocument;
}

/** Last month at a draft (P-73), next to the books valid then and what the hourly rating charged (P-32): null before it rated the month. */
export interface PriceBookPreview {
  month: string;
  currency: string;
  accounts: Array<{ accountId: string; name: string; current: string | null; charged: string | null; draft: string }>;
  totals: { current: string; charged: string | null; draft: string };
}

/** The SKUs of a book's prices, in the order a page shows them. The knobs are D8's, FF's own. */
export const SKUS = [
  'requestsPerMillion',
  'gbSecond',
  'provisionedGbSecond',
  'provisionedDurationGbSecond',
  'minimumBilledMs',
  'idleInstanceGbSecond',
  'monthlyPlanFee',
  'databaseStorageGbMonth',
  'databaseMonthlyFee',
  'bucketStorageGbMonth',
  'requestsTier1PerThousand',
  'requestsTier2PerThousand',
] as const;

export const STATUS_LABELS: Record<BookStatus, string> = { past: 'Past', active: 'Active', scheduled: 'Scheduled' };

const DECIMAL = /^\d+(\.\d+)?$/;
export const isDecimal = (text: string): boolean => DECIMAL.test(text);

/** a × b, exactly, for decimal strings, as the API checks a book from AWS's prices: "0.20" × "3.0080" = "0.6016". */
export function multiplyDecimals(a: string, b: string): string {
  for (const text of [a, b]) if (!isDecimal(text)) throw new Error(`"${text}" is not a decimal number`);
  const [aWhole, aFraction = ''] = a.split('.');
  const [bWhole, bFraction = ''] = b.split('.');
  const scale = aFraction.length + bFraction.length;
  const digits = (BigInt(aWhole + aFraction) * BigInt(bWhole + bFraction)).toString().padStart(scale + 1, '0');
  const whole = BigInt(digits.slice(0, digits.length - scale)).toString();
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The first whole hour, UTC, a new book may start at: the next one (P-73). */
export function earliestStart(now: Date): Date {
  const hour = 3_600_000;
  return new Date((Math.floor(now.getTime() / hour) + 1) * hour);
}

/** What the form for a new book holds, as text. */
export interface DraftForm {
  /** The start: a UTC day, and an hour of it. */
  day: string;
  hour: string;
  /** "aws": AWS's US$ prices times a rate; "manual": TND prices as given. */
  mode: 'aws' | 'manual';
  usd: { requestsPerMillion: string; tiers: string[]; provisionedGbSecond: string; provisionedDurationGbSecond: string };
  rate: string;
  rateDate: string;
  tnd: { requestsPerMillion: string; tiers: string[]; provisionedGbSecond: string; provisionedDurationGbSecond: string };
  freeRequests: string;
  freeGbSeconds: string;
  minimumBilledMs: string;
  idleInstanceGbSecond: string;
  monthlyPlanFee: string;
  /** Customers' databases' and buckets' prices and free tier, as text; only those the book drafted from has are used. */
  storage: StorageForm;
}

export interface StorageForm {
  usd: { databaseStorageGbMonth: string; bucketTiers: string[]; requestsTier1PerThousand: string; requestsTier2PerThousand: string };
  tnd: { databaseStorageGbMonth: string; bucketTiers: string[]; requestsTier1PerThousand: string; requestsTier2PerThousand: string };
  databaseMonthlyFee: string;
  freeDatabaseGbMonths: string;
  freeBucketGbMonths: string;
  freeRequestsTier1: string;
  freeRequestsTier2: string;
}

/** Whether a book prices customers' databases and buckets: the page shows those SKUs, and a book drafted from it has them too. */
export const pricesStorage = (book: PriceDocument): boolean => book.prices.databaseStorageGbMonth !== undefined;

/** A form that starts from a book, the active one: its prices, its rate, and the next hour. */
export function formFrom(book: PriceDocument, now: Date): DraftForm {
  const start = earliestStart(now).toISOString();
  const usd = book.source.usdPrices;
  const prices = book.prices;
  return {
    day: start.slice(0, 10),
    hour: String(Number(start.slice(11, 13))),
    mode: usd ? 'aws' : 'manual',
    usd: {
      requestsPerMillion: usd?.requestsPerMillion ?? '',
      tiers: (usd?.gbSecond ?? prices.gbSecond).map((tier) => (usd ? tier.price : '')),
      provisionedGbSecond: usd?.provisionedGbSecond ?? '',
      provisionedDurationGbSecond: usd?.provisionedDurationGbSecond ?? '',
    },
    rate: book.source.usdRate ?? '',
    rateDate: book.source.usdRateDate ?? '',
    tnd: {
      requestsPerMillion: prices.requestsPerMillion,
      tiers: prices.gbSecond.map((tier) => tier.price),
      provisionedGbSecond: prices.provisionedGbSecond,
      provisionedDurationGbSecond: prices.provisionedDurationGbSecond,
    },
    freeRequests: String(book.freeTier.requests),
    freeGbSeconds: String(book.freeTier.gbSeconds),
    minimumBilledMs: String(prices.minimumBilledMs),
    idleInstanceGbSecond: prices.idleInstanceGbSecond,
    monthlyPlanFee: prices.monthlyPlanFee,
    storage: {
      usd: {
        databaseStorageGbMonth: usd?.databaseStorageGbMonth ?? '',
        bucketTiers: (prices.bucketStorageGbMonth ?? []).map((_tier, index) => usd?.bucketStorageGbMonth?.[index]?.price ?? ''),
        requestsTier1PerThousand: usd?.requestsTier1PerThousand ?? '',
        requestsTier2PerThousand: usd?.requestsTier2PerThousand ?? '',
      },
      tnd: {
        databaseStorageGbMonth: prices.databaseStorageGbMonth ?? '',
        bucketTiers: (prices.bucketStorageGbMonth ?? []).map((tier) => tier.price),
        requestsTier1PerThousand: prices.requestsTier1PerThousand ?? '',
        requestsTier2PerThousand: prices.requestsTier2PerThousand ?? '',
      },
      databaseMonthlyFee: prices.databaseMonthlyFee ?? '',
      freeDatabaseGbMonths: String(book.freeTier.databaseStorageGbMonths ?? ''),
      freeBucketGbMonths: String(book.freeTier.bucketStorageGbMonths ?? ''),
      freeRequestsTier1: String(book.freeTier.requestsTier1 ?? ''),
      freeRequestsTier2: String(book.freeTier.requestsTier2 ?? ''),
    },
  };
}

/**
 * The book a form describes, on the base book's tiers and currency, or what
 * is wrong with it, each named. In "aws" mode, each TND price is the US$
 * price times the rate, exactly. Customers' databases' and buckets' SKUs and
 * free tier are those the base book has, each as the form sets it: a book
 * without them would price them at nothing, which the API refuses after a
 * book that has them.
 */
export function draftDocument(form: DraftForm, base: PriceDocument, today: Date): { document: PriceDocument; validFrom: string } | { problems: string[] } {
  const problems: string[] = [];
  const decimal = (label: string, text: string) => {
    if (!isDecimal(text.trim())) problems.push(`${label}: must be a decimal number, such as 0.0000166667`);
    return text.trim();
  };
  const whole = (label: string, text: string) => {
    if (!/^\d+$/.test(text.trim())) problems.push(`${label}: must be a whole number`);
    return Number(text.trim());
  };
  const hour = Number(form.hour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.day) || !Number.isInteger(hour) || hour < 0 || hour > 23) problems.push('Start: choose a day and an hour');
  const validFrom = `${form.day}T${String(hour).padStart(2, '0')}:00:00Z`;

  let source: PriceDocument['source'];
  let prices: UsdPrices;
  const storage = (given: StorageForm['usd'], unit: string): StoragePrices => {
    const basePrices = base.prices;
    return {
      ...(basePrices.databaseStorageGbMonth !== undefined && { databaseStorageGbMonth: decimal(`Database storage, per GB-month${unit}`, given.databaseStorageGbMonth) }),
      ...(basePrices.bucketStorageGbMonth && {
        bucketStorageGbMonth: basePrices.bucketStorageGbMonth.map((tier, index) => ({
          upToGbMonths: tier.upToGbMonths,
          price: decimal(`Bucket storage tier ${index + 1}${unit}`, given.bucketTiers[index] ?? ''),
        })),
      }),
      ...(basePrices.requestsTier1PerThousand !== undefined && { requestsTier1PerThousand: decimal(`PUT, COPY, POST and LIST requests, per 1,000${unit}`, given.requestsTier1PerThousand) }),
      ...(basePrices.requestsTier2PerThousand !== undefined && { requestsTier2PerThousand: decimal(`GET and other requests, per 1,000${unit}`, given.requestsTier2PerThousand) }),
    };
  };
  if (form.mode === 'aws') {
    const rate = decimal('Rate', form.rate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.rateDate)) problems.push('Rate of: must be a day, such as 2026-10-14');
    const usd: UsdPrices = {
      requestsPerMillion: decimal('Requests (US$)', form.usd.requestsPerMillion),
      gbSecond: base.prices.gbSecond.map((tier, index) => ({ upToGbSeconds: tier.upToGbSeconds, price: decimal(`Duration tier ${index + 1} (US$)`, form.usd.tiers[index] ?? '') })),
      provisionedGbSecond: decimal('Provisioned concurrency (US$)', form.usd.provisionedGbSecond),
      provisionedDurationGbSecond: decimal('Duration on provisioned concurrency (US$)', form.usd.provisionedDurationGbSecond),
      ...storage(form.storage.usd, ' (US$)'),
    };
    if (problems.length) return { problems };
    const times = (usdPrice: string) => multiplyDecimals(usdPrice, rate);
    prices = {
      requestsPerMillion: times(usd.requestsPerMillion),
      gbSecond: usd.gbSecond.map((tier) => ({ ...tier, price: times(tier.price) })),
      provisionedGbSecond: times(usd.provisionedGbSecond),
      provisionedDurationGbSecond: times(usd.provisionedDurationGbSecond),
      ...(usd.databaseStorageGbMonth !== undefined && { databaseStorageGbMonth: times(usd.databaseStorageGbMonth) }),
      ...(usd.bucketStorageGbMonth && { bucketStorageGbMonth: usd.bucketStorageGbMonth.map((tier) => ({ ...tier, price: times(tier.price) })) }),
      ...(usd.requestsTier1PerThousand !== undefined && { requestsTier1PerThousand: times(usd.requestsTier1PerThousand) }),
      ...(usd.requestsTier2PerThousand !== undefined && { requestsTier2PerThousand: times(usd.requestsTier2PerThousand) }),
    };
    source = { ...base.source, kind: 'aws-lambda', readOn: today.toISOString().slice(0, 10), usdPrices: usd, usdRate: rate, usdRateDate: form.rateDate };
  } else {
    prices = {
      requestsPerMillion: decimal('Requests', form.tnd.requestsPerMillion),
      gbSecond: base.prices.gbSecond.map((tier, index) => ({ upToGbSeconds: tier.upToGbSeconds, price: decimal(`Duration tier ${index + 1}`, form.tnd.tiers[index] ?? '') })),
      provisionedGbSecond: decimal('Provisioned concurrency', form.tnd.provisionedGbSecond),
      provisionedDurationGbSecond: decimal('Duration on provisioned concurrency', form.tnd.provisionedDurationGbSecond),
      ...storage(form.storage.tnd, ''),
    };
    source = { kind: 'manual' };
  }
  const baseFree = base.freeTier;
  const freeTier = {
    requests: whole('Free requests', form.freeRequests),
    gbSeconds: whole('Free GB-s', form.freeGbSeconds),
    ...(baseFree.databaseStorageGbMonths !== undefined && { databaseStorageGbMonths: whole('Free database GB-months', form.storage.freeDatabaseGbMonths) }),
    ...(baseFree.bucketStorageGbMonths !== undefined && { bucketStorageGbMonths: whole('Free bucket GB-months', form.storage.freeBucketGbMonths) }),
    ...(baseFree.requestsTier1 !== undefined && { requestsTier1: whole('Free PUT, COPY, POST and LIST requests', form.storage.freeRequestsTier1) }),
    ...(baseFree.requestsTier2 !== undefined && { requestsTier2: whole('Free GET and other requests', form.storage.freeRequestsTier2) }),
  };
  const knobs = {
    minimumBilledMs: whole('Minimum billed duration', form.minimumBilledMs),
    idleInstanceGbSecond: decimal('Idle instance time', form.idleInstanceGbSecond),
    monthlyPlanFee: decimal('Monthly fee', form.monthlyPlanFee),
    ...(base.prices.databaseMonthlyFee !== undefined && { databaseMonthlyFee: decimal('Monthly fee per database', form.storage.databaseMonthlyFee) }),
  };
  if (problems.length) return { problems };
  return { validFrom, document: { currency: base.currency, source, freeTier, prices: { ...prices, ...knobs } } };
}

/** A tier's name, from where it ends: "first 6,000,000,000 GB-s", "past 15,000,000,000 GB-s". */
export function tierLabel(tiers: PriceTier[], index: number): string {
  const end = tiers[index].upToGbSeconds;
  if (end !== null) return index === 0 ? `first ${end.toLocaleString('en-US')} GB-s` : `up to ${end.toLocaleString('en-US')} GB-s`;
  return `past ${(tiers[index - 1]?.upToGbSeconds ?? 0).toLocaleString('en-US')} GB-s`;
}

/** An S3 storage tier's name, from where it ends: "first 51,200 GB-months", "past 512,000 GB-months". */
export function storageTierLabel(tiers: StorageTier[], index: number): string {
  const end = tiers[index].upToGbMonths;
  if (end !== null) return index === 0 ? `first ${end.toLocaleString('en-US')} GB-months` : `up to ${end.toLocaleString('en-US')} GB-months`;
  return `past ${(tiers[index - 1]?.upToGbMonths ?? 0).toLocaleString('en-US')} GB-months`;
}

/** Where a book's prices come from, to read. */
export function sourceLabel(document: PriceDocument): string {
  const { source } = document;
  if (source.kind === 'aws-lambda' && source.usdRate) {
    return `AWS Lambda's US$ prices × ${source.usdRate} ${document.currency} per US$${source.usdRateDate ? ` (rate of ${source.usdRateDate})` : ''}`;
  }
  return source.kind === 'manual' ? 'Prices set by an operator' : source.kind;
}
