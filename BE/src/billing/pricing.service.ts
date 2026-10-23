import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { Currency } from './currency.entity';
import { PriceBook } from './price-book.entity';
import { BookPrices, bookPrices } from './price-book';
import { BookSegment, FunctionUsage, MonthEstimate, ResourceUsage, hoursIn, rateMonth } from './rating';
import { BILLED_CALL, SAMPLE_SUMS, callSums } from './usage-sql';

/** A month by the UTC calendar: its first instant and the next month's. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [year, number] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(year, number - 1, 1)), to: new Date(Date.UTC(year, number, 1)) };
}

/** An account's month, priced, with what priced it. */
export interface AccountEstimate extends MonthEstimate {
  currency: string;
  /** The digits of the currency's minor unit, to which each amount is rounded where shown. */
  exponent: number;
  /** The first instant priced: the month's start, or the first book's, if it starts later. */
  pricedFrom: Date;
  /** The books that priced it, in time order. */
  books: Array<{ id: string; validFrom: Date }>;
}

interface UsageRow {
  functionId: string;
  onDemandRequests: string;
  onDemandMbMs: string;
  provisionedRequests: string;
  provisionedMbMs: string;
}

interface CapacityRow {
  functionId: string;
  provisionedTimeMbMs: string;
  reservedMbMs: string;
}

interface SampleRow {
  resourceId: string;
  byteHours: string;
  hours: string;
  tier1: string;
  tier2: string;
}

/**
 * Prices usage with FF's price books (P-30, D8): each part of a month with the
 * book valid then, from the usage records (P-20), the capacity samples (P-21)
 * and customers' databases' hourly samples. The amounts are estimates until
 * rating debits them (P-32).
 */
@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(PriceBook) private readonly books: Repository<PriceBook>,
    @InjectRepository(Currency) private readonly currencies: Repository<Currency>,
  ) {}

  /** The books valid at some point in [from, to): the one valid at `from`, and those that start before `to`. In time order. */
  async booksFor(from: Date, to: Date): Promise<PriceBook[]> {
    const starting = await this.books.find({ where: { validFrom: LessThan(to) }, order: { validFrom: 'ASC' } });
    const valid = starting.filter((book) => book.validFrom > from);
    const atStart = starting.filter((book) => book.validFrom <= from).at(-1);
    return atStart ? [atStart, ...valid] : valid;
  }

  /** The book valid at an instant: the latest to start at or before it; null before the first. */
  bookAt(instant: Date): Promise<PriceBook | null> {
    return this.books.findOne({ where: { validFrom: LessThanOrEqual(instant) }, order: { validFrom: 'DESC' } });
  }

  /**
   * An account's month (YYYY-MM, UTC), priced; null when no book covers any
   * of it. `books` prices it instead of the stored books, in time order: a
   * draft, for a preview (P-73). `until` ends it early: the month so far, as
   * the hourly rating has rated it (P-32).
   */
  async estimate(
    accountId: string,
    month: string,
    books?: Array<Pick<PriceBook, 'id' | 'currency' | 'validFrom' | 'prices'>>,
    until?: Date,
  ): Promise<AccountEstimate | null> {
    const bounds = monthBounds(month);
    const from = bounds.from;
    const to = until && until < bounds.to ? until : bounds.to;
    books ??= await this.booksFor(from, to);
    if (books.length === 0) return null;
    const currencies = new Set(books.map((book) => book.currency));
    if (currencies.size > 1) throw new Error(`The price books of ${month} are in several currencies: ${[...currencies].join(', ')}`);
    const currency = await this.currencies.findOneByOrFail({ code: books[0].currency });

    const prices = books.map(bookPrices);
    const segments: BookSegment[] = [];
    for (const [index, book] of prices.entries()) {
      const start = book.validFrom > from ? book.validFrom : from;
      const end = prices[index + 1]?.validFrom ?? to;
      segments.push({ book, functions: await this.usage(accountId, start, end, book), resources: await this.resourceUsage(accountId, start, end) });
    }
    const pricedFrom = prices[0].validFrom > from ? prices[0].validFrom : from;
    return {
      ...rateMonth(segments, prices[0], hoursIn(month)),
      currency: currency.code,
      exponent: currency.exponent,
      pricedFrom,
      books: books.map(({ id, validFrom }) => ({ id, validFrom })),
    };
  }

  /** The accounts that used something in the month: a call, an instance sampled, a database or a bucket, or a request to one that S3 bills. */
  async accountsWithUsage(month: string): Promise<string[]> {
    const { from, to } = monthBounds(month);
    const rows = await this.books.manager.query<Array<{ account_id: string }>>(
      `SELECT "account_id" FROM "usage_records" WHERE "started_at" >= $1 AND "started_at" < $2
       UNION SELECT "account_id" FROM "capacity_samples" WHERE "minute" >= $1 AND "minute" < $2
       UNION SELECT "account_id" FROM "database_samples" WHERE "hour" >= $1 AND "hour" < $2
       UNION SELECT "account_id" FROM "bucket_samples" WHERE "hour" >= $1 AND "hour" < $2
       UNION SELECT "account_id" FROM "storage_request_counts" WHERE "minute" >= $1 AND "minute" < $2 AND "class" <> 'free'
       ORDER BY 1`,
      [from, to],
    );
    return rows.map((row) => row.account_id);
  }

  /**
   * The account's usage in [start, end), per function, as the rater takes it:
   * billed calls with the book's minimum billed duration applied to each,
   * apart by whether they ran on provisioned concurrency; and from the
   * minute samples, the minInstances that were ready, and the instances above.
   */
  private async usage(accountId: string, start: Date, end: Date, book: BookPrices): Promise<FunctionUsage[]> {
    const calls = await this.books.manager.query<UsageRow[]>(
      `SELECT "function_id" AS "functionId", ${callSums('$4')}
         FROM "usage_records"
        WHERE "account_id" = $1 AND "started_at" >= $2 AND "started_at" < $3 AND ${BILLED_CALL}
        GROUP BY "function_id"`,
      [accountId, start, end, book.minimumBilledMs],
    );
    const samples = await this.books.manager.query<CapacityRow[]>(
      `SELECT "function_id" AS "functionId", ${SAMPLE_SUMS}
         FROM "capacity_samples"
        WHERE "account_id" = $1 AND "minute" >= $2 AND "minute" < $3
        GROUP BY "function_id"`,
      [accountId, start, end],
    );
    const usage = new Map<string, FunctionUsage>();
    const of = (functionId: string): FunctionUsage => {
      const found = usage.get(functionId);
      if (found) return found;
      const fresh: FunctionUsage = { functionId, onDemand: { requests: 0n, mbMs: 0n }, provisioned: { requests: 0n, mbMs: 0n }, provisionedMbMs: 0n, reservedMbMs: 0n };
      usage.set(functionId, fresh);
      return fresh;
    };
    for (const row of calls) {
      Object.assign(of(row.functionId), {
        onDemand: { requests: BigInt(row.onDemandRequests), mbMs: BigInt(row.onDemandMbMs) },
        provisioned: { requests: BigInt(row.provisionedRequests), mbMs: BigInt(row.provisionedMbMs) },
      });
    }
    for (const row of samples) Object.assign(of(row.functionId), { provisionedMbMs: BigInt(row.provisionedTimeMbMs), reservedMbMs: BigInt(row.reservedMbMs) });
    return [...usage.values()];
  }

  /**
   * The account's databases and buckets in [start, end), as the rater takes
   * them: from their hourly samples, each one's byte-hours and the hours it
   * was sampled in; and a bucket's requests by S3's two classes, from the
   * front door's counts.
   */
  private async resourceUsage(accountId: string, start: Date, end: Date): Promise<ResourceUsage[]> {
    const databases = await this.books.manager.query<SampleRow[]>(
      `SELECT "database_id" AS "resourceId", sum("size_bytes")::text AS "byteHours", count(*)::text AS "hours", '0' AS "tier1", '0' AS "tier2"
         FROM "database_samples"
        WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3
        GROUP BY "database_id"`,
      [accountId, start, end],
    );
    const buckets = await this.books.manager.query<SampleRow[]>(
      `SELECT coalesce(s."bucket_id", r."bucket_id") AS "resourceId", coalesce(s."byteHours", '0') AS "byteHours", coalesce(s."hours", '0') AS "hours",
              coalesce(r."tier1", '0') AS "tier1", coalesce(r."tier2", '0') AS "tier2"
         FROM (SELECT "bucket_id", sum("size_bytes")::text AS "byteHours", count(*)::text AS "hours" FROM "bucket_samples"
                WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3 GROUP BY "bucket_id") s
         FULL JOIN (SELECT "bucket_id", coalesce(sum("requests") FILTER (WHERE "class" = 'tier1'), 0)::text AS "tier1",
                           coalesce(sum("requests") FILTER (WHERE "class" = 'tier2'), 0)::text AS "tier2"
                      FROM "storage_request_counts" WHERE "account_id" = $1 AND "minute" >= $2 AND "minute" < $3 AND "class" <> 'free'
                     GROUP BY "bucket_id") r
           ON r."bucket_id" = s."bucket_id"`,
      [accountId, start, end],
    );
    const usage = (kind: 'database' | 'bucket') => (row: SampleRow): ResourceUsage => ({
      resourceId: row.resourceId,
      kind,
      byteHours: BigInt(row.byteHours),
      hours: BigInt(row.hours),
      tier1Requests: BigInt(row.tier1),
      tier2Requests: BigInt(row.tier2),
    });
    return [...databases.map(usage('database')), ...buckets.map(usage('bucket'))];
  }
}
