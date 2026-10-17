/**
 * Price books, as the admin routes give them (P-73, D8): AWS Lambda's SKUs in
 * TND. contract.test.ts checks the SKUs against the backend's
 * priceDocumentSchema.
 */
export type BookStatus = 'past' | 'active' | 'scheduled';

export interface PriceTier {
  upToGbSeconds: number | null;
  price: string;
}

/** AWS's US$ prices, as a book from them records them. */
export interface UsdPrices {
  requestsPerMillion: string;
  gbSecond: PriceTier[];
  provisionedGbSecond: string;
  provisionedDurationGbSecond: string;
}

export interface PriceDocument {
  currency: string;
  source: { kind: string; readOn?: string; usdRate?: string; usdRateDate?: string; usdPrices?: UsdPrices; [more: string]: unknown };
  freeTier: { requests: number; gbSeconds: number };
  prices: UsdPrices & { minimumBilledMs: number; idleInstanceGbSecond: string; monthlyPlanFee: string };
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

export interface PriceBookPreview {
  month: string;
  currency: string;
  accounts: Array<{ accountId: string; name: string; current: string | null; draft: string }>;
  totals: { current: string; draft: string };
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
}

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
  };
}

/**
 * The book a form describes, on the base book's tiers and currency, or what
 * is wrong with it, each named. In "aws" mode, each TND price is the US$
 * price times the rate, exactly.
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
  if (form.mode === 'aws') {
    const rate = decimal('Rate', form.rate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.rateDate)) problems.push('Rate of: must be a day, such as 2026-10-14');
    const usd: UsdPrices = {
      requestsPerMillion: decimal('Requests (US$)', form.usd.requestsPerMillion),
      gbSecond: base.prices.gbSecond.map((tier, index) => ({ upToGbSeconds: tier.upToGbSeconds, price: decimal(`Duration tier ${index + 1} (US$)`, form.usd.tiers[index] ?? '') })),
      provisionedGbSecond: decimal('Provisioned concurrency (US$)', form.usd.provisionedGbSecond),
      provisionedDurationGbSecond: decimal('Duration on provisioned concurrency (US$)', form.usd.provisionedDurationGbSecond),
    };
    if (problems.length) return { problems };
    const times = (usdPrice: string) => multiplyDecimals(usdPrice, rate);
    prices = {
      requestsPerMillion: times(usd.requestsPerMillion),
      gbSecond: usd.gbSecond.map((tier) => ({ ...tier, price: times(tier.price) })),
      provisionedGbSecond: times(usd.provisionedGbSecond),
      provisionedDurationGbSecond: times(usd.provisionedDurationGbSecond),
    };
    source = { ...base.source, kind: 'aws-lambda', readOn: today.toISOString().slice(0, 10), usdPrices: usd, usdRate: rate, usdRateDate: form.rateDate };
  } else {
    prices = {
      requestsPerMillion: decimal('Requests', form.tnd.requestsPerMillion),
      gbSecond: base.prices.gbSecond.map((tier, index) => ({ upToGbSeconds: tier.upToGbSeconds, price: decimal(`Duration tier ${index + 1}`, form.tnd.tiers[index] ?? '') })),
      provisionedGbSecond: decimal('Provisioned concurrency', form.tnd.provisionedGbSecond),
      provisionedDurationGbSecond: decimal('Duration on provisioned concurrency', form.tnd.provisionedDurationGbSecond),
    };
    source = { kind: 'manual' };
  }
  const freeTier = { requests: whole('Free requests', form.freeRequests), gbSeconds: whole('Free GB-s', form.freeGbSeconds) };
  const knobs = {
    minimumBilledMs: whole('Minimum billed duration', form.minimumBilledMs),
    idleInstanceGbSecond: decimal('Idle instance time', form.idleInstanceGbSecond),
    monthlyPlanFee: decimal('Monthly fee', form.monthlyPlanFee),
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

/** Where a book's prices come from, to read. */
export function sourceLabel(document: PriceDocument): string {
  const { source } = document;
  if (source.kind === 'aws-lambda' && source.usdRate) {
    return `AWS Lambda's US$ prices × ${source.usdRate} ${document.currency} per US$${source.usdRateDate ? ` (rate of ${source.usdRateDate})` : ''}`;
  }
  return source.kind === 'manual' ? 'Prices set by an operator' : source.kind;
}
