import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { describeError } from '../common/describe-error';
import { LedgerAccountType } from './ledger/ledger-account.entity';
import { LedgerTransactionKind } from './ledger/ledger-transaction.entity';
import { LedgerService } from './ledger/ledger.service';
import { formatMinor, toMinor } from './money';
import { bookPrices } from './price-book';
import { PriceBook } from './price-book.entity';
import { PricingService, monthBounds } from './pricing.service';
import { HOUR_MS, dueHours, settleMs, usageKey } from './rating-hours';
import { FunctionUsage, hoursIn, rateMonth } from './rating';
import { RatingRun } from './rating-run.entity';
import { UsageCharge } from './usage-charge.entity';
import { BILLED_CALL, RESOURCE_SUMS, ResourceRow, SAMPLE_SUMS, callSums, resourceUsage } from './usage-sql';

const MINUTE_MS = 60_000;
/** One backend rates at a time: the others skip their turn (parent §4.3). */
const RATING_LOCK = `hashtext('ff_hourly_rating')`;

interface HourlyRow {
  functionId: string;
  priceBookId: string;
  onDemandRequests: string;
  onDemandMbMs: string;
  provisionedRequests: string;
  provisionedMbMs: string;
  provisionedTimeMbMs: string;
  reservedMbMs: string;
}

/**
 * The hourly rating (P-32, D9). Once an hour has settled, its usage is summed
 * into usage_hourly, its databases' samples into resource_usage_hourly, and
 * each account that used something in it is charged:
 * its month so far, rated with the books of P-30 and rounded once, less what
 * the month's earlier hours were charged. The free tier and the duration
 * tiers count from the month's start, and the month's charges add up to its
 * total, rounded once. In shadow mode (D9, the platform setting) a charge is
 * recorded and not debited; otherwise one ledger transaction per account and
 * hour debits it, with the key usage:<account>:<hour>.
 */
@Injectable()
export class HourlyRatingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HourlyRatingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // The hours missed while the backend was stopped first, then each hour as it settles.
    const turn = () => void this.rateDueHours().catch((error: unknown) => this.logger.error(`The hourly rating failed: ${describeError(error)}`));
    turn();
    this.timer = setInterval(turn, MINUTE_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** How long after an hour ends it is rated: its last records and samples are in by then. */
  settleMs(): number {
    return settleMs(this.config.get<number>('kubernetes.readyTimeoutSeconds', 90));
  }

  /**
   * Rates every hour that has settled by `now` and isn't rated yet, in order,
   * and answers how many. A turn that comes while another runs, here or in
   * another backend, does nothing: one holds PostgreSQL's advisory lock.
   */
  async rateDueHours(now = new Date()): Promise<number> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(`SELECT pg_try_advisory_lock(${RATING_LOCK}) AS "locked"`)) as Array<{ locked: boolean }>;
      if (!locked) return 0;
      try {
        const hours = await this.dueHours(now);
        for (const hour of hours) await this.rateHour(hour);
        return hours.length;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${RATING_LOCK})`);
      }
    } finally {
      await runner.release();
    }
  }

  /** The hours that have settled by `now` and aren't rated: after the latest rated, or from the first book's start. */
  async dueHours(now: Date): Promise<Date[]> {
    const [{ latest }] = await this.dataSource.query<Array<{ latest: Date | null }>>(`SELECT max("hour") AS "latest" FROM "rating_runs"`);
    if (latest) return dueHours(new Date(latest.getTime() + HOUR_MS), now, this.settleMs());
    const [first] = await this.dataSource.getRepository(PriceBook).find({ order: { validFrom: 'ASC' }, take: 1 });
    return first ? dueHours(first.validFrom, now, this.settleMs()) : [];
  }

  /**
   * Rates an hour: sums its usage into usage_hourly, then charges each
   * account that used something in it, then records the hour as rated. Again
   * it writes nothing: the hour's sums are written once, and an account
   * charged for the hour is not charged twice.
   */
  async rateHour(hour: Date): Promise<void> {
    const runs = this.dataSource.getRepository(RatingRun);
    if (await runs.existsBy({ hour })) return;
    // In order: an hour's month so far counts the hours before it, so they must be summed first.
    const previous = new Date(hour.getTime() - HOUR_MS);
    const [first] = await this.dataSource.getRepository(PriceBook).find({ order: { validFrom: 'ASC' }, take: 1 });
    if (first && hour > first.validFrom && !(await runs.existsBy({ hour: previous }))) {
      throw new Error(`Rate ${previous.toISOString()} before ${hour.toISOString()}: hours are rated in order`);
    }
    const book = await this.pricing.bookAt(hour);
    const { billingShadowMode: shadow } = await this.settings.get();
    let accounts: string[] = [];
    if (book) {
      await this.sumHour(hour, book);
      const rows = await this.dataSource.query<Array<{ account_id: string }>>(
        `SELECT "account_id" FROM "usage_hourly" WHERE "hour" = $1 UNION SELECT "account_id" FROM "resource_usage_hourly" WHERE "hour" = $1 ORDER BY 1`,
        [hour],
      );
      accounts = rows.map((row) => row.account_id);
      for (const accountId of accounts) await this.dataSource.transaction((manager) => this.chargeHour(manager, accountId, hour, shadow));
    }
    await this.dataSource.query(`INSERT INTO "rating_runs" ("hour", "accounts", "shadow") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [hour, accounts.length, shadow]);
  }

  /** The hour's billed calls and minute samples, per account and function, as the rater takes them, with the hour's book. */
  private async sumHour(hour: Date, book: PriceBook): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "usage_hourly" ("account_id", "hour", "function_id", "price_book_id", "on_demand_requests", "on_demand_mb_ms",
                                   "provisioned_requests", "provisioned_mb_ms", "provisioned_time_mb_ms", "reserved_mb_ms")
       SELECT coalesce(c."account_id", s."account_id"), $1, coalesce(c."function_id", s."function_id"), $3,
              coalesce(c."onDemandRequests", 0), coalesce(c."onDemandMbMs", 0), coalesce(c."provisionedRequests", 0), coalesce(c."provisionedMbMs", 0),
              coalesce(s."provisionedTimeMbMs", 0), coalesce(s."reservedMbMs", 0)
         FROM (SELECT "account_id", "function_id", ${callSums('$4')} FROM "usage_records"
                WHERE "started_at" >= $1 AND "started_at" < $2 AND ${BILLED_CALL} GROUP BY "account_id", "function_id") c
         FULL JOIN (SELECT "account_id", "function_id", ${SAMPLE_SUMS} FROM "capacity_samples"
                     WHERE "minute" >= $1 AND "minute" < $2 GROUP BY "account_id", "function_id") s
           ON s."account_id" = c."account_id" AND s."function_id" = c."function_id"
       ON CONFLICT DO NOTHING`,
      [hour, new Date(hour.getTime() + HOUR_MS), book.id, bookPrices(book).minimumBilledMs],
    );
    // Each database sampled in the hour: its size for one hour, and its name then, which the statement shows.
    await this.dataSource.query(
      `INSERT INTO "resource_usage_hourly" ("account_id", "hour", "resource_id", "kind", "name", "price_book_id", "byte_hours", "hours", "tier1_requests", "tier2_requests")
       SELECT "account_id", $1, "database_id", 'database', "name", $2, "size_bytes", 1, 0, 0 FROM "database_samples" WHERE "hour" = $1
       ON CONFLICT DO NOTHING`,
      [hour, book.id],
    );
  }

  /** An account's charge for the hour: its month to the hour's end, rated and rounded once, less the month's earlier charges. */
  private async chargeHour(manager: EntityManager, accountId: string, hour: Date, shadow: boolean): Promise<void> {
    if (await manager.existsBy(UsageCharge, { accountId, hour })) return;
    const { from } = monthBounds(hour.toISOString().slice(0, 7));
    const end = new Date(hour.getTime() + HOUR_MS);
    const books = await this.pricing.booksFor(from, end);
    const currencies = new Set(books.map((book) => book.currency));
    if (currencies.size !== 1) throw new Error(`The price books of ${hour.toISOString().slice(0, 7)} are in ${currencies.size} currencies: ${[...currencies].join(', ')}`);
    const currency = books[0].currency;
    const [{ exponent }] = await manager.query<Array<{ exponent: number }>>(`SELECT "exponent" FROM "currencies" WHERE "code" = $1`, [currency]);

    const rows = await manager.query<HourlyRow[]>(
      `SELECT "function_id" AS "functionId", "price_book_id" AS "priceBookId",
              sum("on_demand_requests") AS "onDemandRequests", sum("on_demand_mb_ms") AS "onDemandMbMs",
              sum("provisioned_requests") AS "provisionedRequests", sum("provisioned_mb_ms") AS "provisionedMbMs",
              sum("provisioned_time_mb_ms") AS "provisionedTimeMbMs", sum("reserved_mb_ms") AS "reservedMbMs"
         FROM "usage_hourly" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3
        GROUP BY "function_id", "price_book_id"`,
      [accountId, from, end],
    );
    const usage = (row: HourlyRow): FunctionUsage => ({
      functionId: row.functionId,
      onDemand: { requests: BigInt(row.onDemandRequests), mbMs: BigInt(row.onDemandMbMs) },
      provisioned: { requests: BigInt(row.provisionedRequests), mbMs: BigInt(row.provisionedMbMs) },
      provisionedMbMs: BigInt(row.provisionedTimeMbMs),
      reservedMbMs: BigInt(row.reservedMbMs),
    });
    const resourceRows = await manager.query<ResourceRow[]>(
      `SELECT ${RESOURCE_SUMS} FROM "resource_usage_hourly" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3 GROUP BY "resource_id", "kind", "price_book_id"`,
      [accountId, from, end],
    );
    // Each book prices its own hours, in time order, as P-30's estimate does; the monthly fee is the first book's.
    const prices = books.map(bookPrices);
    const monthSoFar = rateMonth(
      prices.map((book) => ({
        book,
        functions: rows.filter((row) => row.priceBookId === book.id).map(usage),
        resources: resourceRows.filter((row) => row.priceBookId === book.id).map(resourceUsage),
      })),
      prices[0],
      hoursIn(hour.toISOString().slice(0, 7)),
    );
    const monthToDateMinor = toMinor(monthSoFar.total, exponent);
    const [{ before }] = await manager.query<Array<{ before: string }>>(
      `SELECT coalesce(sum("amount_minor"), 0)::text AS "before" FROM "usage_charges" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3`,
      [accountId, from, hour],
    );
    const amountMinor = monthToDateMinor - BigInt(before);

    let ledgerTransactionId: string | null = null;
    if (!shadow && amountMinor !== 0n) {
      const posted = await this.ledger.postIn(manager, {
        kind: LedgerTransactionKind.USAGE,
        idempotencyKey: usageKey(accountId, hour),
        currency,
        occurredAt: hour,
        metadata: { hour: hour.toISOString(), monthToDate: formatMinor(monthToDateMinor, exponent) },
        entries: [
          { account: { wallet: accountId }, amountMinor: -amountMinor },
          { account: { ff: LedgerAccountType.REVENUE }, amountMinor },
        ],
      });
      ledgerTransactionId = posted.transaction.id;
    }
    await manager.insert(UsageCharge, { accountId, hour, currency, amountMinor, monthToDateMinor, shadow, ledgerTransactionId });
  }
}
