import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { billingCurrency } from './billing-currency';
import { CreditDecision, CreditPolicy, CreditStanding, InsufficientCreditException, creditDecision, creditPolicy } from './credit-policy';
import { LedgerEvents } from './ledger/ledger-events';

/** How long a cached standing lasts without a word from the ledger: what a lost notification can delay. */
const CACHE_MS = 60_000;

/** An account's standing, its rule, and what follows from them. */
export interface CreditView {
  standing: CreditStanding;
  policy: CreditPolicy;
  decision: CreditDecision;
}

/**
 * The balance check before each invoke (P-33, D9). The spendable balance is
 * cached per account and refreshed on every write to its wallet, which the
 * ledger's NOTIFY announces to every backend; the cache lasts a minute at
 * most. The rule is the platform settings', read at each call, so a change
 * applies at once.
 */
@Injectable()
export class CreditService implements OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, { standing: CreditStanding; bufferMinor: bigint; expires: number }>();
  private unsubscribe?: () => void;

  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: PlatformSettingsService,
    private readonly events: LedgerEvents,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((accountId) => this.cache.delete(accountId));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Refuses an invoke with 402 once the balance has been below the buffer for the grace period. Shadow mode refuses nothing. */
  async admit(accountId: string, now = new Date()): Promise<void> {
    const settings = await this.settings.get();
    if (settings.billingShadowMode) return;
    const view = await this.view(accountId, now);
    if (view.decision.state === 'stopped') throw new InsufficientCreditException(view.standing, view.policy, view.decision);
  }

  /** Where the account stands, under the rule as it is now. */
  async view(accountId: string, now = new Date()): Promise<CreditView> {
    const { currency, exponent } = await billingCurrency(this.dataSource.manager, now);
    const policy = creditPolicy(await this.settings.get(), exponent);
    const standing = await this.standing(accountId, currency, exponent, policy.bufferMinor, now.getTime());
    return { standing, policy, decision: creditDecision(standing, policy, now) };
  }

  /** The wallet's balance, and since when it is below the buffer: cached until its wallet changes, a minute at most. */
  private async standing(accountId: string, currency: string, exponent: number, bufferMinor: bigint, now: number): Promise<CreditStanding> {
    const cached = this.cache.get(accountId);
    if (cached && cached.expires > now && cached.bufferMinor === bufferMinor && cached.standing.currency === currency) return cached.standing;
    const [row] = await this.dataSource.query<Array<{ balance: string; below_since: Date | null }>>(
      `WITH running AS (
         SELECT t."created_at" AS "at", t."id", sum(e."amount_minor") OVER (ORDER BY t."created_at", t."id") AS "balance"
           FROM "ledger_entries" e
           JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
           JOIN "ledger_transactions" t ON t."id" = e."transaction_id"
          WHERE a."account_id" = $1 AND a."type" = 'wallet' AND a."currency" = $2
       ),
       last_ok AS (SELECT max("at") AS "at" FROM running WHERE "balance" >= -$3::bigint)
       SELECT coalesce((SELECT "balance" FROM running ORDER BY "at" DESC, "id" DESC LIMIT 1), 0)::text AS "balance",
              -- the first entry below the buffer after the last one above it: the current stretch below
              (SELECT min(r."at") FROM running r, last_ok WHERE r."balance" < -$3::bigint AND (last_ok."at" IS NULL OR r."at" > last_ok."at")) AS "below_since"`,
      [accountId, currency, bufferMinor.toString()],
    );
    const standing: CreditStanding = { currency, exponent, balanceMinor: BigInt(row.balance), belowBufferSince: row.below_since };
    this.cache.set(accountId, { standing, bufferMinor, expires: now + CACHE_MS });
    return standing;
  }
}
