import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AwsMonthUsage, COUNTED_LINES, EXTRA_LINES, EstimateLine, awsExtraPrices, awsMonth, lineText, logsOf } from '../billing/aws-estimate';
import { Currency } from '../billing/currency.entity';
import { Decimal } from '../billing/decimal';
import { PriceBook } from '../billing/price-book.entity';
import { awsBookPrices, awsSource, priceDocumentSchema } from '../billing/price-book';
import { monthBounds, PricingService } from '../billing/pricing.service';
import { BYTES_PER_GB, hoursIn } from '../billing/rating';
import { PlansService } from '../plans/plans.service';
import { AwsEstimateMonthView, AwsEstimateView } from './usage.dto';
import { monthOf } from './usage.service';

/** A month before `month` (YYYY-MM), `back` months back. */
const monthsBack = (month: string, back: number): string => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 - back, 1)).toISOString().slice(0, 7);
};

/**
 * The estimate at AWS's prices: each of the last months' usage, as FF counted
 * it, priced at the AWS US$ prices of the newest price book that records what
 * AWS bills that FF doesn't, started or not, which are AWS's prices as FF last
 * read them; with AWS's free tier of every month; then that, line by line, each
 * with what it assumes. In US$, and in the book's currency at its rate, beside
 * what FF's own prices make of the month.
 */
@Injectable()
export class AwsEstimateService {
  constructor(
    @InjectRepository(PriceBook) private readonly books: Repository<PriceBook>,
    @InjectRepository(Currency) private readonly currencies: Repository<Currency>,
    private readonly pricing: PricingService,
    private readonly plans: PlansService,
  ) {}

  /** `months` months, this one so far last, its lines in `leftOut` left out of the totals. */
  async estimate(accountId: string, months: number, leftOut: string[], now = new Date()): Promise<AwsEstimateView> {
    const book = (await this.books.find({ order: { validFrom: 'DESC' } })).find((candidate) => {
      const parsed = priceDocumentSchema.safeParse(candidate.prices);
      return parsed.success && awsExtraPrices(parsed.data) !== null;
    });
    if (!book) throw new NotFoundException("No price book records AWS's prices of what FF doesn't bill, to estimate with");
    const document = priceDocumentSchema.parse(book.prices);
    const source = awsSource(document);
    const prices = awsBookPrices(book);
    const extra = awsExtraPrices(document);
    if (!source || !prices || !extra) throw new Error(`The price book ${book.id} records AWS's prices that don't fit`);
    const currency = await this.currencies.findOneByOrFail({ code: book.currency });
    const rate = Decimal.parse(source.usdRate);
    const logDays = (await this.plans.forAccount(accountId)).limits.logRetentionDays;
    const current = monthOf(now);
    const views: AwsEstimateMonthView[] = [];
    for (let back = months - 1; back >= 0; back--) {
      const month = monthsBack(current, back);
      const bounds = monthBounds(month);
      const until = bounds.to > now ? now : null;
      const to = until ?? bounds.to;
      const functions = await this.pricing.functionUsage(accountId, bounds.from, to, prices);
      const sites = await this.sites(accountId, bounds.from, to);
      // A site's requests reach CloudFront on AWS, not S3, as GETs do on FF: its line has them, the bucket's doesn't.
      const resources = (await this.pricing.resourceUsage(accountId, bounds.from, to)).map((resource) =>
        resource.kind === 'bucket' ? { ...resource, tier2Requests: resource.tier2Requests - (sites.requestsByBucket.get(resource.resourceId) ?? 0n) } : resource,
      );
      const usage: AwsMonthUsage = {
        functions,
        initMbMs: await this.pricing.startUpUsage(accountId, bounds.from, to),
        resources,
        traffic: await this.traffic(accountId, bounds.from, to, { functions, sites, logDays, daysInMonth: hoursIn(month) / 24 }),
      };
      const costs = awsMonth(prices, extra, usage, hoursIn(month));
      const lines = [...COUNTED_LINES, ...EXTRA_LINES].map((line: EstimateLine) => ({
        line,
        ...lineText(line, logDays),
        usd: costs[line].toFixed(2),
        amount: costs[line].times(rate).toFixed(currency.exponent),
        extra: (EXTRA_LINES as readonly string[]).includes(line),
        leftOut: leftOut.includes(line),
      }));
      const total = lines.reduce((sum, line) => (line.leftOut ? sum : sum.plus(costs[line.line])), Decimal.ZERO);
      const ff = await this.pricing.estimate(accountId, month, undefined, until ?? undefined);
      views.push({
        month,
        until,
        requests: Number(functions.reduce((sum, fn) => sum + fn.onDemand.requests + fn.provisioned.requests, 0n)),
        lines,
        totalUsd: total.toFixed(2),
        total: total.times(rate).toFixed(currency.exponent),
        ffTotal: ff ? ff.total.toFixed(ff.exponent) : null,
      });
    }
    const readOn = readOnDays(source).sort();
    return {
      currency: currency.code,
      usdRate: source.usdRate,
      usdRateDate: typeof source.usdRateDate === 'string' ? source.usdRateDate : null,
      region: typeof source.region === 'string' ? source.region : 'us-east-1',
      pricesReadOn: [readOn[0], readOn[readOn.length - 1]],
      priceBook: book.id,
      months: views,
    };
  }

  /** The sites' requests in [start, end), each bucket's, and the bytes they sent, as FF counts them. */
  private async sites(accountId: string, start: Date, end: Date): Promise<{ requestsByBucket: Map<string, bigint>; requests: bigint; bytes: bigint }> {
    const rows = await this.books.manager.query<Array<{ bucketId: string; requests: string; bytes: string }>>(
      `SELECT "bucket_id" AS "bucketId", sum("requests")::text AS "requests", sum("bytes_out")::text AS "bytes"
         FROM "storage_request_counts" WHERE "account_id" = $1 AND "minute" >= $2 AND "minute" < $3 AND "class" = 'website'
        GROUP BY "bucket_id"`,
      [accountId, start, end],
    );
    const requestsByBucket = new Map(rows.map((row) => [row.bucketId, BigInt(row.requests)]));
    return { requestsByBucket, requests: [...requestsByBucket.values()].reduce((sum, count) => sum + count, 0n), bytes: rows.reduce((sum, row) => sum + BigInt(row.bytes), 0n) };
  }

  /**
   * What the lines that FF doesn't bill draw on, in [start, end): the bytes
   * the buckets sent out but the sites'; the sites' traffic; the logs of the
   * month's calls; and the hours the account had a database or a cache.
   */
  private async traffic(
    accountId: string,
    start: Date,
    end: Date,
    month: { functions: AwsMonthUsage['functions']; sites: { requests: bigint; bytes: bigint }; logDays: number; daysInMonth: number },
  ): Promise<AwsMonthUsage['traffic']> {
    const [sent] = await this.books.manager.query<Array<{ bytes: string }>>(
      `SELECT coalesce(sum("bytes_out"), 0)::text AS "bytes" FROM "storage_request_counts"
        WHERE "account_id" = $1 AND "minute" >= $2 AND "minute" < $3 AND "class" <> 'website'`,
      [accountId, start, end],
    );
    const [vpc] = await this.books.manager.query<Array<{ hours: number }>>(
      `SELECT count(*)::int AS "hours" FROM (SELECT "hour" FROM "database_samples" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3
                                              UNION SELECT "hour" FROM "cache_samples" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3) h`,
      [accountId, start, end],
    );
    const calls = month.functions.reduce((sum, fn) => sum + fn.onDemand.requests + fn.provisioned.requests, 0n);
    const logs = logsOf(calls, month.logDays, month.daysInMonth);
    return {
      dataOutGb: Decimal.ratio(BigInt(sent.bytes), BYTES_PER_GB),
      logsIngestedGb: logs.ingestedGb,
      logsStoredGbMonths: logs.storedGbMonths,
      siteDataOutGb: Decimal.ratio(month.sites.bytes, BYTES_PER_GB),
      siteRequests: month.sites.requests,
      natGatewayHours: vpc.hours,
      natGatewayGb: Decimal.ZERO,
    };
  }
}

/** Every day a book's source says AWS's prices were read on: its own, and each of its price lists'. */
function readOnDays(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(readOnDays);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => (key === 'readOn' && typeof item === 'string' ? [item] : readOnDays(item)));
}
