import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { Account } from '../accounts/entities/account.entity';
import { lowBalancePercentsSchema, settingProblems } from '../admin/platform-settings';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { AuditService } from '../audit/audit.service';
import { AlertsView, BalanceView, BillingTransactionsPage, TRANSACTIONS_CURSOR } from './billing.dto';
import { billingCurrency } from './billing-currency';
import { CreditService } from './credit.service';
import { LedgerTransactionKind } from './ledger/ledger-transaction.entity';
import { formatMinor } from './money';
import { monthBounds } from './pricing.service';
import { HOUR_MS } from './rating-hours';

const alertsSchema = z.strictObject({ lowBalancePercents: lowBalancePercentsSchema.nullable() });

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
    private readonly credit: CreditService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** The balance, in the currency of the prices (the book valid now, or the first to come), and whether invokes go on (P-33). */
  async balance(accountId: string, now = new Date()): Promise<BalanceView> {
    const prices = await billingCurrency(this.dataSource.manager, now);
    const month = now.toISOString().slice(0, 7);
    const { from, to } = monthBounds(month);
    const [{ charged, latest }] = await this.dataSource.query<Array<{ charged: string; latest: Date | null }>>(
      `SELECT (SELECT coalesce(sum("amount_minor"), 0) FROM "usage_charges"
                WHERE "account_id" = $1 AND "currency" = $2 AND "hour" >= $3 AND "hour" < $4)::text AS "charged",
              (SELECT max("hour") FROM "rating_runs") AS "latest"`,
      [accountId, prices.currency, from, to],
    );
    const { standing, policy, decision } = await this.credit.view(accountId, now);
    return {
      currency: prices.currency,
      balance: formatMinor(standing.balanceMinor, prices.exponent),
      shadowMode: policy.shadow,
      month,
      charged: formatMinor(BigInt(charged), prices.exponent),
      ratedUntil: latest ? new Date(latest.getTime() + HOUR_MS) : null,
      credit: {
        state: decision.state,
        buffer: formatMinor(policy.bufferMinor, prices.exponent),
        belowBufferSince: policy.shadow ? null : standing.belowBufferSince,
        invokesStopAt: decision.invokesStopAt,
      },
    };
  }

  /** When the owners get a low-balance e-mail: the account's shares, or FF's. */
  async alerts(accountId: string): Promise<AlertsView> {
    const account = await this.dataSource.getRepository(Account).findOneBy({ id: accountId });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    return { lowBalancePercents: account.lowBalancePercents, defaultPercents: (await this.settings.get()).lowBalancePercents };
  }

  /** An owner's shares for the low-balance e-mails, or null for FF's again: in the account's audit log, from → to. */
  async setAlerts(accountId: string, body: unknown): Promise<AlertsView> {
    const parsed = alertsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(settingProblems(parsed.error));
    const to = parsed.data.lowBalancePercents;
    await this.dataSource.transaction(async (manager) => {
      const account = await manager.findOne(Account, { where: { id: accountId }, lock: { mode: 'pessimistic_write' } });
      if (!account) throw new NotFoundException(`Account ${accountId} not found`);
      if (isDeepStrictEqual(account.lowBalancePercents, to)) return;
      await manager.update(Account, { id: accountId }, { lowBalancePercents: to });
      await this.audit.record(
        { accountId, action: 'billing.alerts', resource: `account:${accountId}`, details: { changes: { lowBalancePercents: { from: account.lowBalancePercents, to } } } },
        manager,
      );
    });
    return this.alerts(accountId);
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
