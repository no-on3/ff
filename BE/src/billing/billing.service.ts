import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { BalanceView, BillingTransactionsPage, TRANSACTIONS_CURSOR } from './billing.dto';
import { LedgerTransactionKind } from './ledger/ledger-transaction.entity';
import { LedgerService } from './ledger/ledger.service';
import { formatMinor } from './money';
import { monthBounds } from './pricing.service';
import { HOUR_MS } from './rating-hours';

interface TransactionRow {
  id: string;
  kind: LedgerTransactionKind;
  occurred_at: Date;
  created_at: Date;
  amount: string;
  currency: string;
  exponent: number;
  cursor_at: string;
}

/**
 * What an account sees of its money (P-32): its balance with this month's
 * charges, and what moved the balance. Every member may read it, and an API
 * key with usage:read (D3).
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** The balance, in the currency of the prices: the book valid now, or the first to come. */
  async balance(accountId: string, now = new Date()): Promise<BalanceView> {
    const [prices] = await this.dataSource.query<Array<{ currency: string; exponent: number }>>(
      `SELECT b."currency", c."exponent" FROM "price_books" b JOIN "currencies" c ON c."code" = b."currency"
        ORDER BY b."valid_from" <= $1 DESC, CASE WHEN b."valid_from" <= $1 THEN b."valid_from" END DESC, b."valid_from" LIMIT 1`,
      [now],
    );
    if (!prices) throw new Error('No price book: the PriceBooks migration loads the first');
    const month = now.toISOString().slice(0, 7);
    const { from, to } = monthBounds(month);
    const [{ charged, latest }] = await this.dataSource.query<Array<{ charged: string; latest: Date | null }>>(
      `SELECT (SELECT coalesce(sum("amount_minor"), 0) FROM "usage_charges"
                WHERE "account_id" = $1 AND "currency" = $2 AND "hour" >= $3 AND "hour" < $4)::text AS "charged",
              (SELECT max("hour") FROM "rating_runs") AS "latest"`,
      [accountId, prices.currency, from, to],
    );
    return {
      currency: prices.currency,
      balance: formatMinor(await this.ledger.balance(accountId, prices.currency), prices.exponent),
      shadowMode: (await this.settings.get()).billingShadowMode,
      month,
      charged: formatMinor(BigInt(charged), prices.exponent),
      ratedUntil: latest ? new Date(latest.getTime() + HOUR_MS) : null,
    };
  }

  /** What moved the account's balance, newest first, a page at a time: each transaction with what it moved the wallet by. */
  async transactions(accountId: string, { limit, before }: { limit: number; before?: string }): Promise<BillingTransactionsPage> {
    const cursor = before ? TRANSACTIONS_CURSOR.exec(before) : null;
    const rows = await this.dataSource.query<TransactionRow[]>(
      `SELECT t."id", t."kind", t."occurred_at", t."created_at", e."amount_minor"::text AS "amount", a."currency", c."exponent",
              to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursor_at"
         FROM "ledger_entries" e
         JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
         JOIN "ledger_transactions" t ON t."id" = e."transaction_id"
         JOIN "currencies" c ON c."code" = a."currency"
        WHERE a."account_id" = $1 AND a."type" = 'wallet'
          AND ($3::text IS NULL OR (t."created_at", t."id") < (CAST($3 AS timestamp) AT TIME ZONE 'UTC', $4::uuid))
        ORDER BY t."created_at" DESC, t."id" DESC
        LIMIT $2`,
      [accountId, limit + 1, cursor?.[1] ?? null, cursor?.[2] ?? null],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      transactions: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        amount: formatMinor(BigInt(row.amount), row.exponent),
        currency: row.currency,
      })),
      next: rows.length > limit && last ? `${last.cursor_at}_${last.id}` : null,
    };
  }
}
