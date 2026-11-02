import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InvoicesService } from '../billing/invoices/invoices.service';
import { formatMinor } from '../billing/money';
import { monthBounds } from '../billing/pricing.service';
import { tunisDay } from '../billing/tunisia';
import { FunctionStatus } from '../functions/entities/function.entity';
import { capacityReport, reportWindow } from '../usage/capacity-report';
import { OverviewView } from './admin-stats.dto';

/** How long an overview is served again before it is worked out anew: its queries read whole tables. */
export const OVERVIEW_TTL_MS = 60_000;
/** The days of capacity against billing the overview shows, today included. */
export const CAPACITY_DAYS = 7;

/** A call that failed, as the metrics API counts errors. */
const FAILED = "('error', 'timeout', 'platform_error', 'lost')";

/**
 * The admin dashboard's overview: the accounts, the functions and today's
 * calls, this month's money, the invoices to issue, and the capacity FF held
 * against what it billed. Worked out at most once a minute per backend: the
 * operator reloads it, and several operators may look at once.
 */
@Injectable()
export class AdminStatsService {
  private cached?: { at: number; view: Promise<OverviewView> };

  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
  ) {}

  /** GET /admin/stats/overview: the last one worked out, in the minute after it was; else a new one. */
  overview(now = new Date()): Promise<OverviewView> {
    const cached = this.cached;
    if (cached && now.getTime() >= cached.at && now.getTime() - cached.at < OVERVIEW_TTL_MS) return cached.view;
    const view = this.compute(now);
    this.cached = { at: now.getTime(), view };
    // A failure isn't kept: the next request tries again.
    view.catch(() => {
      if (this.cached?.view === view) this.cached = undefined;
    });
    return view;
  }

  private async compute(now: Date): Promise<OverviewView> {
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const [accounts, functions, today, money, invoices, capacity] = await Promise.all([
      this.accounts(),
      this.functions(),
      this.today(day),
      this.money(month),
      this.invoiceCounts(tunisDay(now).slice(0, 7), now),
      this.capacity(now),
    ]);
    return { computedAt: now.toISOString(), accounts, functions, today, month, money, invoices, capacity };
  }

  /** Every status, 0 included, and those waiting for approval. */
  private async accounts(): Promise<OverviewView['accounts']> {
    const rows = await this.dataSource.query<Array<{ status: string; count: number }>>(
      `SELECT "status", count(*)::int AS "count" FROM "accounts" GROUP BY "status"`,
    );
    const byStatus = Object.fromEntries(Object.values(AccountStatus).map((status) => [status, 0])) as Record<AccountStatus, number>;
    for (const row of rows) byStatus[row.status as AccountStatus] = row.count;
    return { byStatus, pendingApprovals: byStatus[AccountStatus.PENDING] };
  }

  /** The functions there are, by status; one being deleted counts no more. */
  private async functions(): Promise<OverviewView['functions']> {
    const rows = await this.dataSource.query<Array<{ status: string; count: number }>>(
      `SELECT "status", count(*)::int AS "count" FROM "functions" WHERE "status" <> $1 GROUP BY "status"`,
      [FunctionStatus.DELETED],
    );
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    return { total: rows.reduce((sum, row) => sum + row.count, 0), byStatus };
  }

  /**
   * Today's calls, by the UTC calendar, as the metrics API counts them: the
   * invocations that reached a function, those that failed, and the throttles,
   * the instance limit's and the rate limit's.
   */
  private async today(day: string): Promise<OverviewView['today']> {
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(from.getTime() + 24 * 3_600_000);
    const [row] = await this.dataSource.query<Array<{ invocations: number; errors: number; throttled: number; refused: number }>>(
      `SELECT count(*) FILTER (WHERE "status" <> 'throttled')::int AS "invocations",
              count(*) FILTER (WHERE "status" IN ${FAILED})::int AS "errors",
              count(*) FILTER (WHERE "status" = 'throttled')::int AS "throttled",
              (SELECT coalesce(sum("count"), 0)::int FROM "rate_limited_invocations" WHERE "minute" >= $1 AND "minute" < $2) AS "refused"
         FROM "usage_records" WHERE "started_at" >= $1 AND "started_at" < $2`,
      [from, to],
    );
    return { day, invocations: row.invocations, errors: row.errors, throttles: row.throttled + row.refused };
  }

  /**
   * This month's money, in each currency FF has: the usage charged (debited,
   * or only rated in shadow mode), the credit bought by transfers received,
   * and the wallets' balances: what FF owes its customers in unused credit,
   * and what those in debt owe it.
   */
  private async money(month: string): Promise<OverviewView['money']> {
    const { from, to } = monthBounds(month);
    const nextMonth = to.toISOString().slice(0, 10);
    const rows = await this.dataSource.query<
      Array<{
        code: string;
        exponent: number;
        charged: string;
        debited: string;
        shadow: string;
        paid: number;
        credit: string;
        owed_by_ff: string;
        owed_to_ff: string;
        in_debt: number;
      }>
    >(
      `WITH "charges" AS (
         SELECT "currency", sum("amount_minor") AS "charged",
                coalesce(sum("amount_minor") FILTER (WHERE "ledger_transaction_id" IS NOT NULL), 0) AS "debited",
                coalesce(sum("amount_minor") FILTER (WHERE "shadow"), 0) AS "shadow"
           FROM "usage_charges" WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "currency"),
       "paid" AS (
         SELECT "currency", count(*)::int AS "paid", sum("credit_minor") AS "credit"
           FROM "payments" WHERE "status" = 'paid' AND "received_on" >= $3::date AND "received_on" < $4::date GROUP BY "currency"),
       "wallets" AS (
         SELECT a."currency", coalesce(sum(e."amount_minor"), 0) AS "balance"
           FROM "ledger_accounts" a LEFT JOIN "ledger_entries" e ON e."ledger_account_id" = a."id"
          WHERE a."type" = 'wallet' GROUP BY a."id", a."currency"),
       "balances" AS (
         SELECT "currency", sum(greatest("balance", 0)) AS "owed_by_ff", sum(greatest(-"balance", 0)) AS "owed_to_ff",
                count(*) FILTER (WHERE "balance" < 0)::int AS "in_debt"
           FROM "wallets" GROUP BY "currency")
       SELECT c."code", c."exponent",
              coalesce(ch."charged", 0)::text AS "charged", coalesce(ch."debited", 0)::text AS "debited", coalesce(ch."shadow", 0)::text AS "shadow",
              coalesce(p."paid", 0) AS "paid", coalesce(p."credit", 0)::text AS "credit",
              coalesce(b."owed_by_ff", 0)::text AS "owed_by_ff", coalesce(b."owed_to_ff", 0)::text AS "owed_to_ff", coalesce(b."in_debt", 0) AS "in_debt"
         FROM "currencies" c
         LEFT JOIN "charges" ch ON ch."currency" = c."code"
         LEFT JOIN "paid" p ON p."currency" = c."code"
         LEFT JOIN "balances" b ON b."currency" = c."code"
        ORDER BY c."code"`,
      [from, to, `${month}-01`, nextMonth],
    );
    return rows.map((row) => {
      const money = (minor: string) => formatMinor(BigInt(minor), row.exponent);
      return {
        currency: row.code,
        consumption: { charged: money(row.charged), debited: money(row.debited), shadow: money(row.shadow) },
        topUps: { payments: row.paid, credit: money(row.credit) },
        balances: { owedByFF: money(row.owed_by_ff), owedToFF: money(row.owed_to_ff), walletsInDebt: row.in_debt },
      };
    });
  }

  /** The invoices and credit notes issued in `month`, this one in Tunisia, where they are dated; and last month's still to issue. */
  private async invoiceCounts(month: string, now: Date): Promise<OverviewView['invoices']> {
    const { to } = monthBounds(month);
    const [[issued], drafts] = await Promise.all([
      this.dataSource.query<Array<{ invoices: number; credit_notes: number }>>(
        `SELECT count(*) FILTER (WHERE "kind" = 'invoice')::int AS "invoices", count(*) FILTER (WHERE "kind" = 'credit_note')::int AS "credit_notes"
           FROM "invoices" WHERE "issued_on" >= $1::date AND "issued_on" < $2::date`,
        [`${month}-01`, to.toISOString().slice(0, 10)],
      ),
      this.invoices.drafts(InvoicesService.lastMonth(now), now),
    ]);
    return { month, issued: issued.invoices, creditNotes: issued.credit_notes, toIssue: { month: drafts.month, drafts: drafts.drafts.length, issuable: drafts.issuable } };
  }

  /** The last days' capacity FF held against what it billed, all accounts together: what FF pays for and nobody else does. */
  private async capacity(now: Date): Promise<OverviewView['capacity']> {
    const { from, to } = reportWindow(now, CAPACITY_DAYS);
    const days = new Map<string, OverviewView['capacity'][number]>();
    for (let at = from.getTime(); at < to.getTime(); at += 24 * 3_600_000) {
      const day = new Date(at).toISOString().slice(0, 10);
      days.set(day, { day, reservedGbS: 0, provisionedGbS: 0, billedGbS: 0, requests: 0 });
    }
    for (const row of await capacityReport(this.dataSource, from, to)) {
      const day = days.get(row.day);
      if (!day) continue;
      day.reservedGbS += row.reservedGbS;
      day.provisionedGbS += row.provisionedGbS;
      day.billedGbS += row.billedGbS;
      day.requests += row.requests;
    }
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return [...days.values()].map((day) => ({
      ...day,
      reservedGbS: round(day.reservedGbS),
      provisionedGbS: round(day.provisionedGbS),
      billedGbS: round(day.billedGbS),
    }));
  }
}
